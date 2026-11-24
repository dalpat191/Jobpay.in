const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { open } = require("./db");
const { hashPassword, verifyPassword, newToken, hashToken } = require("./auth");
const { buildMeta, match, createLimiter, MAX_BODY_CHARS } = require("./core");
function metaWithStates(db) { const jobs = db.activeJobs(); const m = buildMeta(jobs); const by = {}; jobs.forEach(function (j) { if (!j.state || !j.city) return; (by[j.state] = by[j.state] || new Set()).add(j.city); }); m.states = Object.keys(by).sort(); m.citiesByState = {}; Object.keys(by).forEach(function (k) { m.citiesByState[k] = Array.from(by[k]).sort(); }); return m; }
const categories = require("./data/categories");

const CATS = new Set(categories.map(c => c.key));
const TYPES = ["Full Time", "Part Time", "Daily Wage", "Gig", "Freelance", "Commission"];
const MODES = ["onsite", "remote", "anywhere"];
const STAGES = ["new", "shortlisted", "interview", "hired", "rejected"];
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const SEC = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function createApp(db, { adminKey = process.env.ADMIN_KEY || "", trustProxy = process.env.TRUST_PROXY === "1", loginMax = 10, registerMax = 5 } = {}) {
  const apiLimit = createLimiter(120), applyLimit = createLimiter(10), matchLimit = createLimiter(30);
  const loginLimit = createLimiter(loginMax), registerLimit = createLimiter(registerMax);
  const SESSION_DAYS = 7, COOKIE = "jp_session";
  const same = (a, b) => { const h = x => crypto.createHash("sha256").update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };

  const send = (res, status, obj, extra = {}) => {
    res.writeHead(status, { ...SEC, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(obj));
  };
  const readJson = req => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY_CHARS) { reject({ status: 413, error: "Request too large." }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject({ status: 400, error: "Invalid JSON." }); } });
    req.on("error", () => reject({ status: 400, error: "Bad request." }));
  });

  const int = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const txt = (v, max) => (typeof v === "string" ? v : "").trim().replace(/\s+/g, " ").slice(0, max);

  function cleanJob(b) {
    const j = { title: txt(b.title, 80), category: b.category, city: txt(b.city, 60), state: txt(b.state, 40), workMode: b.workMode || "onsite",
      salaryMin: int(b.salaryMin, -1), salaryMax: int(b.salaryMax, -1), type: b.type || "Full Time",
      company: txt(b.company, 80), description: txt(b.description, 1500),
      requiredSkills: Array.isArray(b.requiredSkills) ? b.requiredSkills.slice(0, 15).map(s => txt(s, 40)).filter(Boolean) : [] };
    if (j.title.length < 3) return { error: "Title is required (3+ letters)." };
    if (!CATS.has(j.category)) return { error: "Invalid category." };
    if (!MODES.includes(j.workMode)) return { error: "Invalid workMode." };
    if (!TYPES.includes(j.type)) return { error: "Invalid type." };
    if (j.salaryMin < 0 || j.salaryMax < j.salaryMin || j.salaryMax > 10000000) return { error: "Invalid salary range." };
    if (j.workMode === "onsite" && !j.city) return { error: "City is required for onsite jobs." };
    return { job: j };
  }
  function cleanPhone(p) {
    const d = String(p ?? "").replace(/[\s-]/g, "").replace(/^(\+91|91|0)(?=\d{10}$)/, "");
    return /^[6-9]\d{9}$/.test(d) ? d : "";
  }


  // ---------- employer accounts ----------
  const cookieOf = req => {
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return "";
  };
  const isSecure = req => !!req.socket.encrypted || process.env.COOKIE_SECURE === "1" || (trustProxy && req.headers["x-forwarded-proto"] === "https");
  const cookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
  const employerOf = req => { const t = cookieOf(req); return t ? db.employerBySession(hashToken(t)) : null; };
  function startSession(req, res, employerId, status, body) {
    const token = newToken();
    db.createSession(hashToken(token), employerId, SESSION_DAYS * 86400);
    db.purgeSessions();
    return send(res, status, body, { "Set-Cookie": cookieHeader(req, token, SESSION_DAYS * 86400) });
  }

  async function employerApi(req, res, p, m, ip) {
    if (p === "/api/employer/register" && m === "POST") {
      if (!registerLimit(ip)) return send(res, 429, { error: "Bahut zyada koshish. Thodi der baad try karo." }, { "Retry-After": "60" });
      const b = await readJson(req), name = txt(b.name, 60), company = txt(b.company, 80), phone = cleanPhone(b.phone);
      const pw = typeof b.password === "string" ? b.password : "";
      if (name.length < 2) return send(res, 400, { error: "Apna naam likho." });
      if (company.length < 2) return send(res, 400, { error: "Dukaan / company ka naam likho." });
      if (!phone) return send(res, 400, { error: "Sahi 10 digit mobile number likho." });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: "Password 8 se 100 akshar ka rakho." });
      if (db.employerByPhone(phone)) return send(res, 409, { error: "Is number se account pehle se hai. Login karo." });
      let id;
      try { id = db.createEmployer(name, company, phone, await hashPassword(pw)); }
      catch (e) { if (/UNIQUE/.test(e.message)) return send(res, 409, { error: "Is number se account pehle se hai. Login karo." }); throw e; }
      return startSession(req, res, id, 201, { ok: true });
    }
    if (p === "/api/employer/login" && m === "POST") {
      if (!loginLimit(ip)) return send(res, 429, { error: "Bahut zyada koshish. Thodi der baad try karo." }, { "Retry-After": "60" });
      const b = await readJson(req), phone = cleanPhone(b.phone), pw = typeof b.password === "string" ? b.password.slice(0, 100) : "";
      const e = phone ? db.employerByPhone(phone) : null;
      const ok = await verifyPassword(pw, e && e.password_hash); // same work whether or not the account exists
      if (!e || !ok) return send(res, 401, { error: "Number ya password galat hai." });
      return startSession(req, res, e.id, 200, { ok: true });
    }
    const me = employerOf(req);
    if (!me) return send(res, 401, { error: "Pehle login karo." });

    if (p === "/api/employer/me" && m === "GET") return send(res, 200, me);
    if (p === "/api/employer/logout" && m === "POST") {
      db.deleteSession(hashToken(cookieOf(req)));
      return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
    }
    if (p === "/api/employer/jobs" && m === "GET") return send(res, 200, { jobs: db.employerJobs(me.id) });
    if (p === "/api/employer/jobs" && m === "POST") {
      if (db.employerJobs(me.id).length >= 100) return send(res, 400, { error: "Ek account se 100 se zyada jobs nahi." });
      const b = await readJson(req); if (!txt(b.company, 80)) b.company = me.company;
      const { job, error } = cleanJob(b); if (error) return send(res, 400, { error });
      try { return send(res, 201, { id: db.create(job, me.id) }); }
      catch (e) { if (/UNIQUE/.test(e.message)) return send(res, 409, { error: "Aapki yeh job isi sheher mein pehle se hai." }); throw e; }
    }
    if (p === "/api/employer/company" && m === "GET") return send(res, 200, { name: me.company, type: me.type, city: me.city });
    if (p === "/api/employer/company" && m === "PUT") {
      const b = await readJson(req), name = txt(b.name, 80), type = txt(b.type, 40), city = txt(b.city, 40);
      if (name.length < 2) return send(res, 400, { error: "Business ka naam likho." });
      if (!city) return send(res, 400, { error: "City likho." });
      db.updateCompany(me.id, name, type, city); return send(res, 200, { ok: true });
    }
    let mm = p.match(/^\/api\/employer\/jobs\/(\d{1,9})(\/applicants)?$/);
    if (mm) {
      const id = Number(mm[1]), job = db.employerJob(me.id, id);
      if (!job) return send(res, 404, { error: "Job nahi mili." }); // other employers' jobs look nonexistent
      if (mm[2] && m === "GET") return send(res, 200, { job: { id, title: job.title, status: job.isActive ? "open" : "closed" }, applicants: db.applicants(me.id, id) });
      if (!mm[2] && m === "PATCH") {
        const b = await readJson(req);
        if (b.status !== "open" && b.status !== "closed") return send(res, 400, { error: "Status open ya closed hona chahiye." });
        db.setActive(me.id, id, b.status === "open"); return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: "Method not allowed" });
    }
    mm = p.match(/^\/api\/employer\/applicants\/(\d{1,9})$/);
    if (mm && m === "PATCH") {
      const b = await readJson(req);
      if (!STAGES.includes(b.status)) return send(res, 400, { error: "Galat status." });
      return db.setApplicantStatus(me.id, Number(mm[1]), b.status) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Applicant nahi mila." });
    }
    return send(res, 404, { error: "Not found" });
  }

  async function api(req, res, url) {
    const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "anon";
    if (!apiLimit(ip)) return send(res, 429, { error: "Too many requests. Wait a minute." }, { "Retry-After": "60" });
    const p = url.pathname.replace(/\/+$/, ""), m = req.method;
    if (m !== "GET" && m !== "HEAD") { // CSRF defence on top of SameSite=Strict cookies
      const o = req.headers.origin; let ok = true;
      if (o) { try { ok = new URL(o).host === req.headers.host; } catch { ok = false; } }
      if (!ok) return send(res, 403, { error: "Bad origin." });
    }
    if (p.startsWith("/api/employer/")) return employerApi(req, res, p, m, ip);

    if (p === "/api/match/meta" && m === "GET") return send(res, 200, metaWithStates(db));
    if (p === "/api/match" && m === "POST") {
      if (!matchLimit(ip)) return send(res, 429, { error: "Too many requests. Wait a minute." }, { "Retry-After": "60" });
      const out = match(await readJson(req), db.activeJobs()); return send(res, out.status, out.json);
    }
    if (p === "/api/jobs" && m === "GET") {
      const q = url.searchParams, cat = q.get("category") || "", type = q.get("type") || "";
      return send(res, 200, db.list({ q: txt(q.get("q"), 60), category: CATS.has(cat) ? cat : "", city: txt(q.get("city"), 60), state: txt(q.get("state"), 40),
        type: TYPES.includes(type) ? type : "", minSalary: Math.min(Math.max(int(q.get("minSalary")), 0), 10000000), page: Math.min(Math.max(int(q.get("page"), 1), 1), 1000) }));
    }
    if (p === "/api/jobs" && m === "POST") { // employer posting, protected by ADMIN_KEY
      if (!adminKey) return send(res, 503, { error: "Posting is disabled (ADMIN_KEY not set)." });
      if (!same(req.headers["x-admin-key"] || "", adminKey)) return send(res, 403, { error: "Wrong admin key." });
      const { job, error } = cleanJob(await readJson(req)); if (error) return send(res, 400, { error });
      try { return send(res, 201, { id: db.create(job) }); }
      catch (e) { if (/UNIQUE/.test(e.message)) return send(res, 409, { error: "Same job already exists." }); throw e; }
    }
    let mm = p.match(/^\/api\/jobs\/(\d{1,9})(\/apply)?$/);
    if (mm) {
      const id = Number(mm[1]), job = db.get(id);
      if (!job) return send(res, 404, { error: "Job not found." });
      if (!mm[2] && m === "GET") return send(res, 200, job);
      if (mm[2] && m === "POST") {
        if (!applyLimit(ip)) return send(res, 429, { error: "Bahut zyada applications. Thodi der baad try karo." }, { "Retry-After": "60" });
        const b = await readJson(req), name = txt(b.name, 60), phone = cleanPhone(b.phone);
        if (name.length < 2) return send(res, 400, { error: "Apna naam likho." });
        if (!phone) return send(res, 400, { error: "Sahi 10 digit mobile number likho." });
        try { db.apply(id, name, phone, txt(b.message, 300)); return send(res, 201, { ok: true }); }
        catch (e) { if (/UNIQUE/.test(e.message)) return send(res, 409, { error: "Aap is job par pehle hi apply kar chuke ho." }); throw e; }
      }
      return send(res, 405, { error: "Method not allowed" });
    }
    return send(res, 404, { error: "Not found" });
  }

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SEC); return res.end(); }
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400, SEC); return res.end(); }
    if (rel.includes("\0")) { res.writeHead(400, SEC); return res.end(); }
    const file = path.join(PUBLIC, rel === "/" ? "index.html" : rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, SEC); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { ...SEC, "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { ...SEC, "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) await api(req, res, url); else serveStatic(req, res, url);
    } catch (e) {
      if (e && e.status) return send(res, e.status, { error: e.error });
      console.error("[jobpay]", e); if (!res.headersSent) send(res, 500, { error: "Something went wrong. Please try again." });
    }
  });
}

module.exports = { createApp };

if (require.main === module) {
  const db = open();
  const port = process.env.PORT || 3000;
  createApp(db).listen(port, () => console.log(`jobpay on http://localhost:${port}` + (process.env.ADMIN_KEY ? "" : "  (posting disabled: set ADMIN_KEY)")));
}
