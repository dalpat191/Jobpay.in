/**
 * Framework-free core. Takes plain objects in, returns plain objects out.
 * Every adapter (Express, Next.js, serverless...) is a thin wrapper around this.
 */
const categories = require("../data/categories");
const { rankJobs } = require("../services/matcher");

const CATEGORY_KEYS = new Set(categories.map(c => c.key));
const JOB_TYPES = new Set(["Any", "Full Time", "Part Time", "Daily Wage", "Gig", "Freelance", "Commission"]);
const MAX_BODY_CHARS = 10000;

/** Clean and bound everything that comes from the browser. Never trust it. */
function sanitize(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const str = (v, max) => (typeof v === "string" ? v : "").trim().slice(0, max);
  const skills = Array.isArray(b.skills)
    ? b.skills.slice(0, 15).map(s => str(s, 40)).filter(Boolean) : [];
  const salary = Number.parseInt(b.minSalary, 10);
  return {
    category: typeof b.category === "string" && CATEGORY_KEYS.has(b.category) ? b.category : "",
    skills,
    city: str(b.city, 60),
    minSalary: Number.isFinite(salary) ? Math.min(Math.max(salary, 0), 1000000) : 0,
    jobType: typeof b.jobType === "string" && JOB_TYPES.has(b.jobType) ? b.jobType : "Any",
    openToRemote: b.openToRemote === true
  };
}

/** Popup options: categories, popular skills per category, cities that have jobs. */
function buildMeta(jobs) {
  const count = {}, cities = new Set();
  for (const j of jobs) {
    if (j.city) cities.add(j.city);
    for (const s of j.requiredSkills || []) {
      const m = (count[j.category] ||= {});
      m[s] = (m[s] || 0) + 1;
    }
  }
  const skillsByCategory = {};
  for (const c in count) skillsByCategory[c] = Object.keys(count[c]).sort((a, b) => count[c][b] - count[c][a] || a.localeCompare(b));
  return { categories, skillsByCategory, cities: [...cities].sort() };
}

/** Returns { status, json }. `jobs` = active jobs array (Mongo docs or plain objects). */
function match(body, jobs) {
  const candidate = sanitize(body);
  if (!candidate.category && !candidate.skills.length) {
    return { status: 400, json: { error: "Choose a field or at least one skill." } };
  }
  const results = rankJobs(candidate, jobs).map(r => ({
    id: String(r.job.id ?? r.job._id),
    title: r.job.title, category: r.job.category, city: r.job.city || "",
    workMode: r.job.workMode, salaryMin: r.job.salaryMin, salaryMax: r.job.salaryMax,
    type: r.job.type, score: r.score, reasons: r.reasons, missingSkills: r.missingSkills
  }));
  return { status: 200, json: { count: results.length, results } };
}

/** Tiny in-memory rate limiter (per process). Use a shared store if you run many servers. */
function createLimiter(max = 30, windowMs = 60000) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return key => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    return ++h.n <= max;
  };
}

module.exports = { sanitize, buildMeta, match, createLimiter, MAX_BODY_CHARS };
