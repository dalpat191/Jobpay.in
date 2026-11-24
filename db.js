// SQLite via Node's built-in node:sqlite (Node >= 22.5). No install, works on Termux.
const { DatabaseSync } = require("node:sqlite");
const seedJobs = require("./data/jobs");

const JOBS_DDL = name => `CREATE TABLE ${name}(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL DEFAULT '',
  work_mode TEXT NOT NULL DEFAULT 'onsite' CHECK(work_mode IN ('onsite','remote','anywhere')),
  salary_min INTEGER NOT NULL CHECK(salary_min>=0), salary_max INTEGER NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]', type TEXT NOT NULL DEFAULT 'Full Time',
  company TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  employer_id INTEGER REFERENCES employers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(salary_max>=salary_min))`;

function open(file = process.env.DB_FILE || "jobpay.db", { seed = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS employers(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, company TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, employer_id INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);`);
  db.exec(JOBS_DDL("IF NOT EXISTS jobs").replace("CREATE TABLE IF NOT EXISTS jobs(", "CREATE TABLE IF NOT EXISTS jobs("));
  db.exec(`CREATE TABLE IF NOT EXISTS applications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phone TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(job_id, phone));`);
  const addCol = (table, col, ddl) => { // tiny migrations for databases made by earlier versions
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addCol('applications', 'status', "TEXT NOT NULL DEFAULT 'new'");
  addCol('employers', 'type', "TEXT NOT NULL DEFAULT ''");
  addCol('employers', 'city', "TEXT NOT NULL DEFAULT ''");

  // Migrate databases made by the first version (no employer_id, UNIQUE(title,category,city) baked in).
  const old = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get().sql;
  if (!/employer_id/.test(old) || /UNIQUE\s*\(\s*title/i.test(old)) {
    const had = /employer_id/.test(old);
    db.exec("PRAGMA foreign_keys=OFF"); // else DROP TABLE would cascade-delete applications
    db.exec("BEGIN");
    try {
      db.exec(JOBS_DDL("jobs_new"));
      db.exec(`INSERT INTO jobs_new(id,title,category,city,work_mode,salary_min,salary_max,skills,type,company,description,is_active,is_sample,employer_id,created_at)
        SELECT id,title,category,city,work_mode,salary_min,salary_max,skills,type,company,description,is_active,is_sample,${had ? "employer_id" : "NULL"},created_at FROM jobs`);
      db.exec("DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs; COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    finally { db.exec("PRAGMA foreign_keys=ON"); }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_uniq ON jobs(title,category,city,COALESCE(employer_id,0));
           CREATE INDEX IF NOT EXISTS jobs_cat ON jobs(category, is_active);
           CREATE INDEX IF NOT EXISTS jobs_emp ON jobs(employer_id);`);

  const COLS = "title,category,city,work_mode,salary_min,salary_max,skills,type,company,description,is_sample,employer_id";
  const args = (j, sample, eid) => [j.title, j.category, j.city || "", j.workMode, j.salaryMin, j.salaryMax,
    JSON.stringify(j.requiredSkills || []), j.type, j.company || "", j.description || "", sample ? 1 : 0, eid ?? null];
  const ins = db.prepare(`INSERT OR IGNORE INTO jobs(${COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);

  if (seed && db.prepare("SELECT COUNT(*) n FROM jobs").get().n === 0) {
    db.exec("BEGIN"); try { seedJobs.forEach(j => ins.run(...args(j, j.isSample))); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  const toJob = r => ({ id: r.id, title: r.title, category: r.category, city: r.city, workMode: r.work_mode,
    salaryMin: r.salary_min, salaryMax: r.salary_max, requiredSkills: JSON.parse(r.skills), type: r.type,
    company: r.company, description: r.description, createdAt: r.created_at, isActive: !!r.is_active,
    ...(r.applicants !== undefined ? { applicants: r.applicants, newCount: r.new_count } : {}) });
  const esc = s => s.replace(/[\\%_]/g, "\\$&");
  const now = () => Math.floor(Date.now() / 1000);
  const PAGE = 12;

  return {
    raw: db,
    close: () => db.close(),
    activeJobs: () => db.prepare("SELECT * FROM jobs WHERE is_active=1").all().map(toJob),
    list({ q = "", category = "", city = "", type = "", minSalary = 0, page = 1 }) {
      const w = ["is_active=1"], p = [];
      if (q) { w.push("(title LIKE ? ESCAPE '\\' OR skills LIKE ? ESCAPE '\\')"); p.push(`%${esc(q)}%`, `%${esc(q)}%`); }
      if (category) { w.push("category=?"); p.push(category); }
      if (city) { w.push("city=?"); p.push(city); }
      if (type) { w.push("type=?"); p.push(type); }
      if (minSalary) { w.push("salary_max>=?"); p.push(minSalary); }
      const where = w.join(" AND ");
      const total = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE ${where}`).get(...p).n;
      const rows = db.prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, PAGE, (page - 1) * PAGE);
      return { total, page, pageSize: PAGE, jobs: rows.map(toJob) };
    },
    get(id) { const r = db.prepare("SELECT * FROM jobs WHERE id=? AND is_active=1").get(id); return r ? toJob(r) : null; },
    // Plain INSERT so duplicates throw UNIQUE instead of silently returning a stale id.
    create(j, employerId = null) {
      return Number(db.prepare(`INSERT INTO jobs(${COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(...args(j, false, employerId)).lastInsertRowid);
    },
    apply(jobId, name, phone, message) {
      return Number(db.prepare("INSERT INTO applications(job_id,name,phone,message) VALUES(?,?,?,?)").run(jobId, name, phone, message).lastInsertRowid);
    },

    // ---- employers ----
    createEmployer: (name, company, phone, hash) =>
      Number(db.prepare("INSERT INTO employers(name,company,phone,password_hash) VALUES(?,?,?,?)").run(name, company, phone, hash).lastInsertRowid),
    employerByPhone: phone => db.prepare("SELECT * FROM employers WHERE phone=?").get(phone),
    createSession: (tokenHash, eid, ttlSec) => db.prepare("INSERT INTO sessions(token_hash,employer_id,expires_at) VALUES(?,?,?)").run(tokenHash, eid, now() + ttlSec),
    employerBySession: tokenHash => db.prepare(`SELECT e.id,e.name,e.company,e.type,e.city,e.phone FROM sessions s JOIN employers e ON e.id=s.employer_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash, now()),
    deleteSession: tokenHash => db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash),
    purgeSessions: () => db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now()),
    employerJobs: eid => db.prepare(`SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id=j.id) AS applicants,
      (SELECT COUNT(*) FROM applications a WHERE a.job_id=j.id AND a.status='new') AS new_count
      FROM jobs j WHERE j.employer_id=? ORDER BY j.id DESC`).all(eid).map(toJob),
    employerJob: (eid, id) => { const r = db.prepare("SELECT * FROM jobs WHERE id=? AND employer_id=?").get(id, eid); return r ? toJob(r) : null; },
    setActive: (eid, id, on) => db.prepare("UPDATE jobs SET is_active=? WHERE id=? AND employer_id=?").run(on ? 1 : 0, id, eid).changes > 0,
    setApplicantStatus: (eid, appId, status) => db.prepare(`UPDATE applications SET status=? WHERE id=?
      AND job_id IN (SELECT id FROM jobs WHERE employer_id=?)`).run(status, appId, eid).changes > 0,
    updateCompany(eid, name, type, city) {
      db.prepare("UPDATE employers SET company=?, type=?, city=? WHERE id=?").run(name, type, city, eid);
      db.prepare("UPDATE jobs SET company=? WHERE employer_id=?").run(name, eid); // keep job cards in sync
    },
    applicants: (eid, id) => db.prepare(`SELECT a.id,a.name,a.phone,a.message,a.status,a.created_at AS createdAt FROM applications a
      JOIN jobs j ON j.id=a.job_id WHERE a.job_id=? AND j.employer_id=? ORDER BY a.id DESC`).all(id, eid)
  };
}
module.exports = { open };
