/**
 * Job matcher - transparent weighted scoring (no black box).
 * Score 0-100 = skills 40 + category 25 + location 15 + salary 10 + job type 10.
 * Every result carries human-readable reasons so the popup can explain "why".
 */
const WEIGHTS = { skills: 40, category: 25, location: 15, salary: 10, type: 10 };

// Different words people use for the same skill.
const SYNONYMS = {
  "talking": "communication", "customer service": "communication", "english": "communication",
  "lifting": "loading", "heavy license": "driving", "license": "driving", "bike riding": "driving",
  "excel": "computer", "typing": "computer", "physical fitness": "fitness"
};

const norm = s => String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
const canon = s => { const n = norm(s); return SYNONYMS[n] || n; };

function skillScore(userSkills, jobSkills) {
  if (!jobSkills.length) return { pts: WEIGHTS.skills * 0.5, matched: [], missing: [] };
  const have = new Set(userSkills.map(canon));
  const matched = [], missing = [];
  for (const s of jobSkills) (have.has(canon(s)) ? matched : missing).push(s);
  return { pts: WEIGHTS.skills * (matched.length / jobSkills.length), matched, missing };
}

function locationScore(c, job) {
  if (job.workMode === "remote") {
    return c.openToRemote
      ? { pts: WEIGHTS.location * 0.9, why: "Work from anywhere" }
      : { pts: WEIGHTS.location * 0.3, why: "Remote job" };
  }
  if (job.workMode === "anywhere") return { pts: WEIGHTS.location * 0.7, why: "Hiring across India" };
  if (c.city && norm(c.city) === norm(job.city)) return { pts: WEIGHTS.location, why: `Job in ${job.city}` };
  return { pts: 0, why: null };
}

function salaryScore(c, job) {
  if (!c.minSalary) return { pts: WEIGHTS.salary * 0.5, why: null };
  if (job.salaryMax >= c.minSalary) {
    return { pts: WEIGHTS.salary, why: job.salaryMin >= c.minSalary ? "Pay meets your target" : "Pay can reach your target" };
  }
  const ratio = job.salaryMax / c.minSalary; // below target: partial credit only if close
  return { pts: ratio > 0.5 ? WEIGHTS.salary * (ratio - 0.5) : 0, why: null };
}

function scoreJob(c, job) {
  const reasons = [];
  const sk = skillScore(c.skills, job.requiredSkills || []);
  if (sk.matched.length) reasons.push(`Skills match: ${sk.matched.join(", ")}`);

  const catPts = c.category && c.category === job.category ? WEIGHTS.category : 0;
  if (catPts) reasons.push("Your chosen field");

  const loc = locationScore(c, job);
  if (loc.why) reasons.push(loc.why);

  const sal = salaryScore(c, job);
  if (sal.why) reasons.push(sal.why);

  const anyType = !c.jobType || c.jobType === "Any";
  const typePts = anyType ? WEIGHTS.type * 0.5 : (c.jobType === job.type ? WEIGHTS.type : 0);
  if (!anyType && c.jobType === job.type) reasons.push(`${job.type} job`);

  const total = sk.pts + catPts + loc.pts + sal.pts + typePts;
  return { score: Math.round(total), reasons, missingSkills: sk.missing };
}

/** Top `limit` jobs with score >= minScore, best first. */
function rankJobs(candidate, jobs, { limit = 8, minScore = 30 } = {}) {
  return jobs
    .map(j => ({ job: j, ...scoreJob(candidate, j) }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score || b.job.salaryMax - a.job.salaryMax)
    .slice(0, limit);
}

module.exports = { rankJobs, scoreJob, WEIGHTS };
