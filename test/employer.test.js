const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { open } = require("../db");
const { createApp } = require("../server");

let srv, base, db;
const listen = async (app) => { await new Promise(r => app.listen(0, "127.0.0.1", r)); return "http://127.0.0.1:" + app.address().port; };
test.before(async () => { db = open(":memory:"); srv = createApp(db, { adminKey: "k", loginMax: 1000, registerMax: 1000 }); base = await listen(srv); });
test.after(() => { srv.close(); db.close(); });

// tiny client that keeps its own cookie, like a browser
const client = (b = () => base) => {
  let cookie = "";
  const call = async (p, method = "GET", body, headers = {}) => {
    const r = await fetch(b() + p, { method, headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, headers: r.headers, cookie };
  };
  call.clear = () => { cookie = ""; };
  call.raw = () => cookie;
  return call;
};
const reg = (c, n) => c("/api/employer/register", "POST", { name: "Owner " + n, company: "Shop " + n, phone: n, password: "longpassword" + n });
const JOB = { title: "Cook", category: "restaurant", city: "Hadgaon", salaryMin: 10000, salaryMax: 15000, type: "Full Time", requiredSkills: ["Cooking"] };

test("register: validation, duplicate, cookie flags, password and token are not stored raw", async () => {
  const c = client();
  for (const bad of [{ name: "A", company: "Shop", phone: "9000000001", password: "longpassword" },
    { name: "Ab", company: "S", phone: "9000000001", password: "longpassword" },
    { name: "Ab", company: "Shop", phone: "123", password: "longpassword" },
    { name: "Ab", company: "Shop", phone: "9000000001", password: "short" },
    { name: "Ab", company: "Shop", phone: "9000000001", password: "x".repeat(101) },
    { name: "Ab", company: "Shop", phone: "9000000001", password: 12345678 }])
    assert.strictEqual((await c("/api/employer/register", "POST", bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  const r = await reg(c, "9000000001");
  assert.strictEqual(r.status, 201);
  const sc = r.headers.get("set-cookie");
  assert(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && /Max-Age=604800/.test(sc));
  assert.strictEqual((await reg(client(), "9000000001")).status, 409);
  const row = db.raw.prepare("SELECT password_hash FROM employers WHERE phone='9000000001'").get();
  assert(!row.password_hash.includes("longpassword9000000001") && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(row.password_hash));
  const rawToken = c.raw().split("=")[1];
  assert.strictEqual(db.raw.prepare("SELECT COUNT(*) n FROM sessions WHERE token_hash=?").get(rawToken).n, 0, "raw token must not be in DB");
  assert.strictEqual(db.raw.prepare("SELECT COUNT(*) n FROM sessions").get().n >= 1, true);
});

test("login: same error for wrong password and unknown number; logout kills the session", async () => {
  const c = client();
  const wrong = await c("/api/employer/login", "POST", { phone: "9000000001", password: "wrongpassword" });
  const none = await c("/api/employer/login", "POST", { phone: "9999999999", password: "wrongpassword" });
  assert.strictEqual(wrong.status, 401); assert.strictEqual(none.status, 401);
  assert.strictEqual(wrong.json.error, none.json.error, "must not reveal which numbers have accounts");
  assert.strictEqual((await c("/api/employer/login", "POST", { phone: "bad", password: 5 })).status, 401);
  assert.strictEqual((await c("/api/employer/me")).status, 401);
  assert.strictEqual((await c("/api/employer/login", "POST", { phone: "+91 90000-00001", password: "longpassword9000000001" })).status, 200);
  const me = await c("/api/employer/me"); assert.strictEqual(me.status, 200); assert(!("password_hash" in me.json));
  const old = c.raw();
  const out = await c("/api/employer/logout", "POST"); assert.strictEqual(out.status, 200);
  assert(/Max-Age=0/.test(out.headers.get("set-cookie")));
  c.clear(); const stale = client(); // replay the old cookie
  const replay = await fetch(base + "/api/employer/me", { headers: { Cookie: old } });
  assert.strictEqual(replay.status, 401, "logged-out cookie must stop working");
});

test("sessions expire, tampered cookies fail", async () => {
  const c = client(); await c("/api/employer/login", "POST", { phone: "9000000001", password: "longpassword9000000001" });
  assert.strictEqual((await c("/api/employer/me")).status, 200);
  db.raw.exec("UPDATE sessions SET expires_at = 1");
  assert.strictEqual((await c("/api/employer/me")).status, 401);
  for (const junk of ["jp_session=abc", "jp_session=", "jp_session=" + "0".repeat(64), "other=1", "jp_session=' OR 1=1 --"])
    assert.strictEqual((await fetch(base + "/api/employer/me", { headers: { Cookie: junk } })).status, 401, junk);
});

test("post job, it goes live, applicants + stages, close/reopen", async () => {
  const c = client(); await c("/api/employer/login", "POST", { phone: "9000000001", password: "longpassword9000000001" });
  assert.strictEqual((await c("/api/employer/jobs", "POST", { ...JOB, category: "nope" })).status, 400);
  const made = await c("/api/employer/jobs", "POST", { ...JOB, title: "Tandoor Cook" });
  assert.strictEqual(made.status, 201); const id = made.json.id;
  assert.strictEqual((await c("/api/employer/jobs", "POST", { ...JOB, title: "Tandoor Cook" })).status, 409, "own duplicate");
  const pub = await (await fetch(`${base}/api/jobs/${id}`)).json();
  assert.strictEqual(pub.company, "Shop 9000000001", "company defaults to the employer's business");
  const m = await (await fetch(base + "/api/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "restaurant", skills: ["Cooking"], city: "Hadgaon" }) })).json();
  assert(m.results.some(r => r.id === String(id)), "new job must be matchable");

  for (const [n, ph] of [["Ram", "9111111111"], ["Sita", "9222222222"]])
    assert.strictEqual((await fetch(`${base}/api/jobs/${id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n, phone: ph, message: "hi" }) })).status, 201);
  let jobs = (await c("/api/employer/jobs")).json.jobs.find(j => j.id === id);
  assert.strictEqual(jobs.applicants, 2); assert.strictEqual(jobs.newCount, 2); assert.strictEqual(jobs.isActive, true);

  const ap = await c(`/api/employer/jobs/${id}/applicants`);
  assert.deepStrictEqual(ap.json.job, { id, title: "Tandoor Cook", status: "open" });
  assert.strictEqual(ap.json.applicants.length, 2); assert.strictEqual(ap.json.applicants[0].status, "new");
  const appId = ap.json.applicants[0].id;
  assert.strictEqual((await c(`/api/employer/applicants/${appId}`, "PATCH", { status: "shortlisted" })).status, 200);
  assert.strictEqual((await c(`/api/employer/applicants/${appId}`, "PATCH", { status: "king" })).status, 400);
  jobs = (await c("/api/employer/jobs")).json.jobs.find(j => j.id === id);
  assert.strictEqual(jobs.newCount, 1, "shortlisted applicant is no longer new");

  assert.strictEqual((await c(`/api/employer/jobs/${id}`, "PATCH", { status: "closed" })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/jobs/${id}`)).status, 404, "closed job hidden from public");
  assert.strictEqual((await fetch(`${base}/api/jobs/${id}/apply`, { method: "POST", body: JSON.stringify({ name: "Late", phone: "9333333333" }) })).status, 404);
  assert.strictEqual((await c(`/api/employer/jobs/${id}/applicants`)).json.job.status, "closed", "owner still sees it");
  assert.strictEqual((await c(`/api/employer/jobs/${id}`, "PATCH", { status: "weird" })).status, 400);
  assert.strictEqual((await c(`/api/employer/jobs/${id}`, "PATCH", { status: "open" })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/jobs/${id}`)).status, 200);
});

test("employers cannot see or touch each other's jobs and applicants", async () => {
  const a = client(), b = client();
  await a("/api/employer/login", "POST", { phone: "9000000001", password: "longpassword9000000001" });
  assert.strictEqual((await reg(b, "9000000002")).status, 201);
  const aJob = (await a("/api/employer/jobs")).json.jobs[0];
  const aApp = (await a(`/api/employer/jobs/${aJob.id}/applicants`)).json.applicants[0];
  assert.strictEqual((await b("/api/employer/jobs")).json.jobs.length, 0);
  assert.strictEqual((await b(`/api/employer/jobs/${aJob.id}/applicants`)).status, 404);
  assert.strictEqual((await b(`/api/employer/jobs/${aJob.id}`, "PATCH", { status: "closed" })).status, 404);
  assert.strictEqual((await b(`/api/employer/applicants/${aApp.id}`, "PATCH", { status: "rejected" })).status, 404);
  const still = (await a(`/api/employer/jobs/${aJob.id}/applicants`)).json;
  assert.strictEqual(still.job.status, "open"); assert.notStrictEqual(still.applicants.find(x => x.id === aApp.id).status, "rejected");
  assert.strictEqual((await b("/api/employer/jobs", "POST", { ...JOB, title: "Tandoor Cook" })).status, 201, "same title is fine for a different employer");
});

test("company profile saves and updates job cards", async () => {
  const c = client(); await c("/api/employer/login", "POST", { phone: "9000000001", password: "longpassword9000000001" });
  assert.strictEqual((await c("/api/employer/company")).json.name, "Shop 9000000001");
  assert.strictEqual((await c("/api/employer/company", "PUT", { name: "X", city: "Hadgaon" })).status, 400);
  assert.strictEqual((await c("/api/employer/company", "PUT", { name: "Sharma Caterers", type: "Restaurant / Catering", city: "" })).status, 400);
  assert.strictEqual((await c("/api/employer/company", "PUT", { name: "Sharma Caterers", type: "Restaurant / Catering", city: "Hadgaon" })).status, 200);
  assert.deepStrictEqual((await c("/api/employer/company")).json, { name: "Sharma Caterers", type: "Restaurant / Catering", city: "Hadgaon" });
  const j = (await c("/api/employer/jobs")).json.jobs[0];
  assert.strictEqual((await (await fetch(`${base}/api/jobs/${j.id}`)).json()).company, "Sharma Caterers");
});

test("security: unauthenticated 401, CSRF origin check, XSS text stored as text", async () => {
  const anon = client();
  for (const [p, m] of [["/api/employer/jobs", "GET"], ["/api/employer/jobs", "POST"], ["/api/employer/company", "PUT"], ["/api/employer/jobs/1", "PATCH"], ["/api/employer/applicants/1", "PATCH"], ["/api/employer/logout", "POST"]])
    assert.strictEqual((await anon(p, m, m === "GET" ? undefined : {})).status, 401, m + " " + p);
  const c = client(); await c("/api/employer/login", "POST", { phone: "9000000001", password: "longpassword9000000001" });
  const evil = await c("/api/employer/jobs", "POST", { ...JOB, title: "Evil Job" }, { Origin: "https://evil.example" });
  assert.strictEqual(evil.status, 403, "cross-site request must be refused");
  assert.strictEqual((await c("/api/employer/jobs", "POST", { ...JOB, title: "Same Origin Job" }, { Origin: base })).status, 201);
  const x = await c("/api/employer/jobs", "POST", { ...JOB, title: "<script>alert(1)</script>" });
  assert.strictEqual(x.status, 201);
  const back = await (await fetch(`${base}/api/jobs/${x.json.id}`)).json();
  assert.strictEqual(back.title, "<script>alert(1)</script>", "stored verbatim; UI renders with textContent");
});

test("login brute-force is rate limited", async () => {
  const d = open(":memory:", { seed: false }), app = createApp(d, {}), url = await listen(app);
  const codes = []; for (let i = 0; i < 13; i++) codes.push((await fetch(url + "/api/employer/login", { method: "POST", body: JSON.stringify({ phone: "9000000009", password: "guessguess" }) })).status);
  assert.strictEqual(codes[0], 401); assert.strictEqual(codes.at(-1), 429);
  app.close(); d.close();
});

test("old databases migrate without losing jobs or applications", () => {
  const f = path.join(os.tmpdir(), "jp-old-" + process.pid + ".db"); for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
  const o = new DatabaseSync(f); // the first version's schema
  o.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,category TEXT NOT NULL,city TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT 'onsite' CHECK(work_mode IN ('onsite','remote','anywhere')),salary_min INTEGER NOT NULL CHECK(salary_min>=0),salary_max INTEGER NOT NULL,
      skills TEXT NOT NULL DEFAULT '[]',type TEXT NOT NULL DEFAULT 'Full Time',company TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,is_sample INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(salary_max>=salary_min),UNIQUE(title,category,city));
    CREATE TABLE applications(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,name TEXT NOT NULL,phone TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(job_id,phone));
    INSERT INTO jobs(title,category,city,salary_min,salary_max) VALUES('Old Job','retail','Hadgaon',9000,12000);
    INSERT INTO applications(job_id,name,phone) VALUES(1,'Old Applicant','9876543210');`);
  o.close();
  const n = open(f, { seed: false });
  assert.strictEqual(n.raw.prepare("SELECT COUNT(*) n FROM applications").get().n, 1, "applications must survive the table rebuild");
  assert.strictEqual(n.raw.prepare("SELECT status FROM applications").get().status, "new");
  assert.strictEqual(n.get(1).title, "Old Job");
  const job = { title: "Old Job", category: "retail", city: "Hadgaon", workMode: "onsite", salaryMin: 1, salaryMax: 2, type: "Full Time" };
  assert.throws(() => n.create(job, null), /UNIQUE/, "same unowned job is still a duplicate");
  const eid = n.createEmployer("Ab", "Shop", "9000000077", "x:y");
  assert(n.create(job, eid) > 0, "a different employer may post the same title");
  assert.throws(() => n.create(job, eid), /UNIQUE/, "but not twice");
  n.close(); const again = open(f, { seed: false }); assert.strictEqual(again.activeJobs().length >= 1, true); again.close(); // re-open is a no-op
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
});
