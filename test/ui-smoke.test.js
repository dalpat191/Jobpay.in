// Runs public/employer.js against a minimal fake DOM and the REAL server. Catches runtime errors, not visual bugs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { open } = require("../db");
const { createApp } = require("../server");

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.l = {}; this.className = ""; this.value = ""; this.parent = null; this.disabled = false; this.text = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  append(...k) { for (const c of k) { const n = typeof c === "string" || typeof c === "number" ? Object.assign(new El("#text"), { text: String(c) }) : c; n.parent = this; this.children.push(n); } }
  appendChild(c) { this.append(c); return c; }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  focus() {} get classList() { const s = this; return { add(c) { s.className += " " + c; }, remove(c) { s.className = s.className.split(" ").filter(x => x !== c).join(" "); } }; }
  set textContent(v) { this.children = []; this.text = String(v); } get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  matches(sel) { return sel.split(",").some(s => { s = s.trim(); return s[0] === "#" ? this.id === s.slice(1) : s[0] === "." ? this.className.split(" ").includes(s.slice(1)) : this.tag === s; }); }
  querySelectorAll(sel) { return this.all().filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  fire(t, ev = {}) { return Promise.all((this.l[t] || []).map(f => f({ preventDefault() {}, target: this, key: "", ...ev }))); }
}
const byText = (root, tag, txt) => root.all().find(e => e.tag === tag && e.textContent.includes(txt));
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

test("employer UI: register, post job, see applicant, change stage — no runtime errors", async () => {
  const db = open(":memory:", { seed: false }), srv = createApp(db, {});
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  let cookie = "";
  const fetchJar = async (u, o = {}) => {
    const r = await fetch(base + u, { ...o, headers: { ...(o.headers || {}), ...(cookie && { Cookie: cookie }) } });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0]; return r;
  };
  try {
  const app = new El("main"), toast = new El("div"), body = new El("body");
  const doc = { getElementById: id => (id === "app" ? app : toast), createElement: t => new El(t), body, activeElement: null, addEventListener() {}, removeEventListener() {} };
  body.classList = new El("x").classList; body.className = "";
  const errors = [], handlers = {};
  let hashValue = ""; // like a browser: assigning a new hash fires hashchange
  const loc = { get hash() { return hashValue; }, set hash(v) { if (v !== hashValue) { hashValue = v; Promise.resolve().then(() => handlers.hashchange && handlers.hashchange()); } } };
  const ctx = vm.createContext({ document: doc, location: loc, fetch: fetchJar, console, setTimeout, clearTimeout, URLSearchParams, Promise, Number, String, Date,
    encodeURIComponent, decodeURIComponent, navigator: {}, addEventListener: (t, f) => { handlers[t] = f; }, Object, Array, Math, JSON, isNaN });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/employer.js"), "utf8").replace("route();\n", "route().catch(e => errors.push(e));\n").replace(/$/, ""), Object.assign(ctx, { errors }));
  await tick(300);

  assert(app.textContent.includes("Employer login"), "shows login first");
  byText(app, "button", "Naya account").fire && await byText(app, "button", "Naya account").fire("click"); await tick();
  assert(app.textContent.includes("Naya employer account"));
  const form = app.querySelector("form"), set = (id, v) => { form.querySelector("#" + id).value = v; };
  set("nm", "Ramesh"); set("co", "Sharma Caterers"); set("phone", "98765 43210"); set("pw", "short");
  await form.fire("submit"); await tick();
  assert(app.textContent.includes("8 akshar"), "client-side password check");
  set("pw", "longpassword1"); await form.fire("submit"); await tick(400);
  assert(app.textContent.includes("Namaste, Sharma Caterers"), "dashboard after register: " + app.textContent.slice(0, 120));

  // post a job through the popup
  await byText(app, "button", "Nayi job post").fire("click"); await tick(200);
  const dlg = body.querySelector("form"); assert(dlg, "job popup opened");
  const f2 = (id, v) => { dlg.querySelector("#" + id).value = v; };
  f2("jt", "Tandoor Cook"); f2("jc", "restaurant"); f2("jl", "Hadgaon"); f2("jmin", "9000"); f2("jmax", "5000");
  await dlg.fire("submit"); await tick();
  assert(body.textContent.includes("Salary sahi"), "rejects max < min");
  f2("jmax", "14000"); f2("jsk", "Cooking, Tandoor"); await dlg.fire("submit"); await tick(400);
  assert(toast.textContent.includes("Job post ho gayi"), "toast after posting");
  assert(db.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE title='Tandoor Cook' AND company='Sharma Caterers'").get().n === 1);

  // a candidate applies publicly, employer sees them
  const jobId = db.raw.prepare("SELECT id FROM jobs").get().id;
  assert.strictEqual((await fetch(`${base}/api/jobs/${jobId}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "<b>Sita</b>", phone: "9123456780", message: "2 saal ka anubhav" }) })).status, 201);
  loc.hash = "#/jobs"; await tick(300);
  assert(app.textContent.includes("Tandoor Cook") && app.textContent.includes("1 applicants"), app.textContent.slice(0, 200));
  loc.hash = "#/job/" + jobId; await tick(300);
  assert(app.textContent.includes("<b>Sita</b>"), "applicant name shown as plain text, not HTML");
  assert(!app.all().some(e => e.tag === "b"), "no element injected from applicant data");
  await byText(app, "button", "Status badlein").fire("click"); await tick();
  await byText(body, "button", "Shortlist").fire("click"); await tick(300);
  assert.strictEqual(db.raw.prepare("SELECT status FROM applications").get().status, "shortlisted");
  assert(app.textContent.includes("Shortlist"));

  await byText(app, "button", "Job band karein").fire("click"); await tick();
  await byText(body, "button", "Band karein").fire("click"); await tick(300);
  assert.strictEqual(db.raw.prepare("SELECT is_active FROM jobs").get().is_active, 0);

  // logout returns to login; a second session cannot reuse the cleared cookie
  await byText(app, "button", "Logout").fire("click"); await tick();
  await byText(body, "button", "Logout").fire("click"); await tick(300);
  assert(app.textContent.includes("Employer login"), "back to login after logout");
  assert.strictEqual(errors.length, 0, "no uncaught errors: " + errors.map(String));
  } finally { srv.close(); db.close(); }
});
