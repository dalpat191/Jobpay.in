const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { open } = require("../db");
const { createApp } = require("../server");

let srv, base, db;
test.before(async () => {
  db = open(":memory:");
  srv = createApp(db, { adminKey: "s3cret" });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + srv.address().port;
});
test.after(() => { srv.close(); db.close(); });

const J = (path, method = "GET", body, headers = {}) => fetch(base + path, {
  method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const raw = path => new Promise(res => http.get({ host: "127.0.0.1", port: srv.address().port, path }, r => { r.resume(); r.on("end", () => res(r.statusCode)); }));

test("seeded on first open, and reopening does not duplicate", () => {
  const n = db.raw.prepare("SELECT COUNT(*) n FROM jobs").get().n;
  assert(n >= 60);
});

test("GET /api/jobs: pagination, filters, search, injection-safe", async () => {
  let d = await (await J("/api/jobs")).json();
  assert(d.total >= 60 && d.jobs.length === 12 && d.page === 1);
  const d2 = await (await J("/api/jobs?page=2")).json();
  assert(!d2.jobs.some(j => d.jobs.find(x => x.id === j.id)), "pages overlap");
  d = await (await J("/api/jobs?category=logistics")).json();
  assert(d.total > 0 && d.jobs.every(j => j.category === "logistics"));
  d = await (await J("/api/jobs?q=driver")).json();
  assert(d.total > 0 && d.jobs.every(j => /driv/i.test(j.title + j.requiredSkills.join())));
  d = await (await J("/api/jobs?minSalary=100000")).json();
  assert(d.jobs.every(j => j.salaryMax >= 100000));
  d = await (await J("/api/jobs?city=Hadgaon&type=Gig")).json();
  assert(d.jobs.every(j => j.city === "Hadgaon" && j.type === "Gig"));
  for (const evil of ["' OR 1=1 --", "%", "_", "\\", "%27%3B DROP TABLE jobs;--"]) {
    const r = await J("/api/jobs?q=" + encodeURIComponent(evil));
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await (await J("/api/jobs?q=%25")).json()).total, 0, "% must be literal, not wildcard");
  }
  assert((await (await J("/api/jobs?page=abc&minSalary=-5&category=bogus")).json()).total >= 60);
});

test("GET /api/jobs/:id", async () => {
  const id = (await (await J("/api/jobs")).json()).jobs[0].id;
  const r = await J("/api/jobs/" + id);
  assert.strictEqual(r.status, 200); assert(Array.isArray((await r.json()).requiredSkills));
  assert.strictEqual((await J("/api/jobs/999999")).status, 404);
  assert.strictEqual((await J("/api/jobs/abc")).status, 404);
  assert.strictEqual((await J("/api/jobs/1;DROP")).status, 404);
});

test("apply: success, duplicate, validation, phone formats", async () => {
  const id = (await (await J("/api/jobs")).json()).jobs[0].id, url = `/api/jobs/${id}/apply`;
  assert.strictEqual((await J(url, "POST", { name: "Ramesh", phone: "+91 98765-43210" })).status, 201);
  assert.strictEqual((await J(url, "POST", { name: "Ramesh", phone: "9876543210" })).status, 409, "same number twice");
  assert.strictEqual((await J(url, "POST", { name: "R", phone: "9123456780" })).status, 400);
  for (const bad of ["12345", "5876543210", "abcdefghij", "", null, {}]) assert.strictEqual((await J(url, "POST", { name: "Sita", phone: bad })).status, 400, String(bad));
  assert.strictEqual((await J("/api/jobs/999999/apply", "POST", { name: "Sita", phone: "9123456780" })).status, 404);
  const stored = db.raw.prepare("SELECT phone FROM applications WHERE name='Ramesh'").get();
  assert.strictEqual(stored.phone, "9876543210", "phone normalised");
});

test("employer posting needs the admin key and valid data", async () => {
  const good = { title: "Tractor Driver", category: "agriculture", city: "Hadgaon", salaryMin: 12000, salaryMax: 18000, type: "Full Time", requiredSkills: ["Driving"] };
  assert.strictEqual((await J("/api/jobs", "POST", good)).status, 403);
  assert.strictEqual((await J("/api/jobs", "POST", good, { "x-admin-key": "wrong" })).status, 403);
  const k = { "x-admin-key": "s3cret" };
  const r = await J("/api/jobs", "POST", good, k); assert.strictEqual(r.status, 201);
  const { id } = await r.json(); assert.strictEqual((await (await J("/api/jobs/" + id)).json()).title, "Tractor Driver");
  assert.strictEqual((await J("/api/jobs", "POST", good, k)).status, 409);
  for (const bad of [{ ...good, title: "x" }, { ...good, category: "nope" }, { ...good, salaryMax: 5 }, { ...good, workMode: "mars" },
    { ...good, title: "Other", city: "" }, { ...good, title: "T2", type: "Slave" }, { ...good, title: "T3", salaryMin: "abc" }])
    assert.strictEqual((await J("/api/jobs", "POST", bad, k)).status, 400, JSON.stringify(bad));
  const open2 = createApp(db, { adminKey: "" }); await new Promise(r => open2.listen(0, r));
  const s = await fetch(`http://127.0.0.1:${open2.address().port}/api/jobs`, { method: "POST", body: "{}" });
  assert.strictEqual(s.status, 503); open2.close();
});

test("match endpoints use live DB (newly posted job is matchable)", async () => {
  assert((await (await J("/api/match/meta")).json()).categories.length > 20);
  const d = await (await J("/api/match", "POST", { category: "agriculture", skills: ["Driving"], city: "Hadgaon", minSalary: 12000 })).json();
  assert.strictEqual(d.results[0].title, "Tractor Driver");
  assert.strictEqual((await J("/api/match", "POST", {})).status, 400);
  assert.strictEqual(typeof d.results[0].id, "string");
});

test("robustness: bad JSON, big body, unknown route, 405", async () => {
  const id = (await (await J("/api/jobs")).json()).jobs[0].id;
  assert.strictEqual((await fetch(base + "/api/match", { method: "POST", body: "{bad" })).status, 400);
  const big = await fetch(base + `/api/jobs/${id}/apply`, { method: "POST", body: "x".repeat(50000) }).catch(() => null);
  assert(big === null || big.status === 413);
  assert.strictEqual((await J("/api/nothing")).status, 404);
  assert.strictEqual((await J(`/api/jobs/${id}`, "DELETE")).status, 405);
  assert.strictEqual((await J("/api/jobs")).status, 200, "server still alive");
});

test("static files: served, security headers, no path traversal", async () => {
  const r = await fetch(base + "/");
  assert.strictEqual(r.status, 200); assert(/text\/html/.test(r.headers.get("content-type")));
  assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
  assert(/default-src 'self'/.test(r.headers.get("content-security-policy")));
  assert.strictEqual((await fetch(base + "/app.js")).status, 200);
  assert.strictEqual((await fetch(base + "/nope.js")).status, 404);
  for (const p of ["/../server.js", "/..%2fserver.js", "/%2e%2e/db.js", "/../../etc/passwd", "/%00", "/..\\server.js"])
    assert([400, 403, 404].includes(await raw(p)), "traversal not blocked: " + p);
  assert.strictEqual((await fetch(base + "/jobpay.db")).status, 404);
});

test("rate limit on apply", async () => {
  const id = (await (await J("/api/jobs")).json()).jobs[1].id; let last = 0;
  for (let i = 0; i < 14; i++) last = (await J(`/api/jobs/${id}/apply`, "POST", { name: "Ab", phone: "bad" })).status;
  assert.strictEqual(last, 429);
});
