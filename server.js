const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { open } = require("./db");
const { buildMeta, match, createLimiter, MAX_BODY_CHARS } = require("./core");
const categories = require("./data/categories");

const CATS = new Set(categories.map(c => c.key));
const TYPES = ["Full Time", "Part Time", "Daily Wage", "Gig", "Freelance", "Commission"];
const MODES = ["onsite", "remote", "anywhere"];
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const SEC = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function createApp(db, { adminKey = process.env.ADMIN_KEY || "", trustProxy = process.env.TRUST_PROXY === "1" } = {}) {
  const apiLimit = createLimiter(120), applyLimit = createLimiter(10), matchLimit = createLimiter(30);
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
    const j = { title: txt(b.title, 80), category: b.category, city: txt(b.city, 60), workMode: b.workMode || "onsite",
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

  async function api(req, res, url) {
    const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "anon";
    if (!apiLimit(ip)) return send(res, 429, { error: "Too many requests. Wait a minute." }, { "Retry-After": "60" });
    const p = url.pathname.replace(/\/+$/, ""), m = req.method;

    if (p === "/api/match/meta" && m === "GET") return send(res, 200, buildMeta(db.activeJobs()));
    if (p === "/api/match" && m === "POST") {
      if (!matchLimit(ip)) return send(res, 429, { error: "Too many requests. Wait a minute." }, { "Retry-After": "60" });
      const out = match(await readJson(req), db.activeJobs()); return send(res, out.status, out.json);
    }
    if (p === "/api/jobs" && m === "GET") {
      const q = url.searchParams, cat = q.get("category") || "", type = q.get("type") || "";
      return send(res, 200, db.list({ q: txt(q.get("q"), 60), category: CATS.has(cat) ? cat : "", city: txt(q.get("city"), 60),
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
