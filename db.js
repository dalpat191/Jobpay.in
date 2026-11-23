// SQLite via Node's built-in node:sqlite (Node >= 22.5). No install, works on Termux.
const { DatabaseSync } = require("node:sqlite");
const seedJobs = require("./data/jobs");

function open(file = process.env.DB_FILE || "jobpay.db", { seed = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT 'onsite' CHECK(work_mode IN ('onsite','remote','anywhere')),
      salary_min INTEGER NOT NULL CHECK(salary_min>=0), salary_max INTEGER NOT NULL,
      skills TEXT NOT NULL DEFAULT '[]', type TEXT NOT NULL DEFAULT 'Full Time',
      company TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(salary_max>=salary_min), UNIQUE(title,category,city));
    CREATE INDEX IF NOT EXISTS jobs_cat ON jobs(category, is_active);
    CREATE TABLE IF NOT EXISTS applications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phone TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(job_id, phone));`);

  const ins = db.prepare(`INSERT OR IGNORE INTO jobs(title,category,city,work_mode,salary_min,salary_max,skills,type,company,description,is_sample)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const add = j => ins.run(j.title, j.category, j.city || "", j.workMode, j.salaryMin, j.salaryMax,
    JSON.stringify(j.requiredSkills || []), j.type, j.company || "", j.description || "", j.isSample ? 1 : 0);

  if (seed && db.prepare("SELECT COUNT(*) n FROM jobs").get().n === 0) {
    db.exec("BEGIN"); try { seedJobs.forEach(add); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  const toJob = r => ({ id: r.id, title: r.title, category: r.category, city: r.city, workMode: r.work_mode,
    salaryMin: r.salary_min, salaryMax: r.salary_max, requiredSkills: JSON.parse(r.skills), type: r.type,
    company: r.company, description: r.description, createdAt: r.created_at });
  const esc = s => s.replace(/[\\%_]/g, "\\$&");
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
    create(j) { // plain INSERT so duplicates throw UNIQUE instead of silently returning a stale id
      return Number(db.prepare(`INSERT INTO jobs(title,category,city,work_mode,salary_min,salary_max,skills,type,company,description)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(j.title, j.category, j.city || "", j.workMode, j.salaryMin, j.salaryMax,
        JSON.stringify(j.requiredSkills || []), j.type, j.company || "", j.description || "").lastInsertRowid);
    },
    apply(jobId, name, phone, message) {
      return Number(db.prepare("INSERT INTO applications(job_id,name,phone,message) VALUES(?,?,?,?)").run(jobId, name, phone, message).lastInsertRowid);
    }
  };
}
module.exports = { open };
