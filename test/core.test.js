const test = require("node:test");
const assert = require("node:assert");
const { sanitize, buildMeta, match, createLimiter } = require("../core");
const jobs = require("../data/jobs");
const categories = require("../data/categories");

test("seed data integrity", () => {
  const keys = new Set(categories.map(c => c.key));
  const seen = new Set(), covered = new Set();
  for (const j of jobs) {
    assert(keys.has(j.category), "unknown category " + j.category);
    assert(j.salaryMin > 0 && j.salaryMax >= j.salaryMin, "bad salary " + j.title);
    assert(["onsite", "remote", "anywhere"].includes(j.workMode), "bad mode " + j.title);
    if (j.workMode === "onsite") assert(j.city, "onsite job needs city: " + j.title);
    assert(j.requiredSkills.length > 0, "no skills " + j.title);
    const k = [j.title, j.category, j.city].join("|");
    assert(!seen.has(k), "duplicate " + k); seen.add(k);
    covered.add(j.category);
  }
  for (const k of keys) if (k !== "other") assert(covered.has(k), "segment with no jobs: " + k);
});

test("sanitize survives hostile input", () => {
  for (const bad of [null, undefined, 5, "x", [], { skills: "no" }, { skills: [1, null, {}, "ok"], minSalary: "abc" },
    { category: { $ne: "" }, city: { $gt: "" } }, { __proto__: { admin: true } }]) {
    const c = sanitize(bad);
    assert.deepStrictEqual(Object.keys(c).sort(), ["category", "city", "jobType", "minSalary", "openToRemote", "skills"]);
    assert.strictEqual(typeof c.category, "string");
    assert.strictEqual(typeof c.city, "string");
    assert(Number.isInteger(c.minSalary) && c.minSalary >= 0);
  }
  assert.deepStrictEqual(sanitize({ skills: [1, null, "ok"] }).skills, ["ok"]);
  assert.strictEqual(sanitize({ minSalary: 99999999 }).minSalary, 1000000);
  assert.strictEqual(sanitize({ minSalary: -5 }).minSalary, 0);
  assert.strictEqual(sanitize({ category: "nope" }).category, "");
  assert.strictEqual(sanitize({ skills: Array(100).fill("a") }).skills.length, 15);
  assert.strictEqual(sanitize({ city: "x".repeat(500) }).city.length, 60);
  assert.strictEqual(sanitize({ openToRemote: "true" }).openToRemote, false);
});

test("match: validation", () => {
  assert.strictEqual(match({}, jobs).status, 400);
  assert.strictEqual(match({ category: "bogus" }, jobs).status, 400);
  assert.strictEqual(match({ skills: ["Driving"] }, jobs).status, 200);
});

test("match: own field ranks first, sorted, scores bounded, ids are strings", () => {
  const me = { category: "healthcare", skills: ["Nursing"], city: "Hadgaon", minSalary: 15000, jobType: "Full Time" };
  const { json } = match(me, jobs.map((j, i) => ({ ...j, _id: { toString: () => "id" + i } })));
  assert.strictEqual(json.results[0].title, "Staff Nurse");
  json.results.forEach((r, i) => {
    assert(r.score >= 0 && r.score <= 100); assert.strictEqual(typeof r.id, "string");
    if (i) assert(json.results[i - 1].score >= r.score);
  });
  assert(json.results.length <= 8);
});

test("match: skills alone work; city mismatch lowers score; remote pref helps remote jobs", () => {
  const a = match({ skills: ["Excel", "Documentation", "GST"] }, jobs).json.results;
  assert(a.length && a[0].category === "exim");
  const here = match({ category: "retail", city: "Hadgaon" }, jobs).json.results.find(r => r.title === "Salesman").score;
  const away = match({ category: "retail", city: "Mumbai" }, jobs).json.results.find(r => r.title === "Salesman").score;
  assert(here > away);
  const base = { category: "it", skills: ["JavaScript"] };
  const no = match(base, jobs).json.results.find(r => r.title === "Web Developer").score;
  const yes = match({ ...base, openToRemote: true }, jobs).json.results.find(r => r.title === "Web Developer").score;
  assert(yes > no);
});

test("match: salary target and empty job list", () => {
  const hi = match({ category: "aviation", minSalary: 100000 }, jobs).json.results[0];
  assert.strictEqual(hi.title, "Pilot");
  assert.deepStrictEqual(match({ category: "it" }, []).json, { count: 0, results: [] });
});

test("buildMeta", () => {
  const m = buildMeta(jobs);
  assert.strictEqual(m.categories.length, categories.length);
  assert(m.cities.includes("Hadgaon") && !m.cities.includes(""));
  assert(m.skillsByCategory.logistics.includes("Driving"));
});

test("limiter blocks after max", () => {
  const allow = createLimiter(3, 60000);
  assert([1, 2, 3].every(() => allow("ip")));
  assert.strictEqual(allow("ip"), false);
  assert.strictEqual(allow("other"), true);
});
