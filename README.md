# jobpay.in

Job portal MVP: browse and search jobs, apply, 4-step "Find my job" matching popup, employer posting API.
**Zero dependencies** - needs only Node 22.5+ (SQLite is built in). Works on Termux, VPS, Render, Railway.

    node server.js                      # http://localhost:3000  (creates jobpay.db and loads sample jobs)
    ADMIN_KEY=choose-a-long-secret node server.js   # also enables employer posting
    npm test                            # 17 automated tests

## Post a job (employer / you)
    curl -X POST http://localhost:3000/api/jobs -H "Content-Type: application/json" -H "x-admin-key: YOUR_KEY" \
      -d '{"title":"Tractor Driver","category":"agriculture","city":"Hadgaon","salaryMin":12000,"salaryMax":18000,
           "type":"Full Time","requiredSkills":["Driving"],"company":"Patil Farms","description":"..."}'
Categories are in `data/categories.js`. There is no employer login UI yet (next module).

## Where things are
`server.js` HTTP + API + static files | `db.js` SQLite schema and queries | `core/`, `services/matcher.js` matching logic
`public/` frontend (`app.js` list/detail/apply, `match-popup.js` popup) | `data/jobs.js` ~65 sample jobs | `test/`

## Settings (env)
`PORT`, `DB_FILE` (default jobpay.db), `ADMIN_KEY` (empty = posting disabled), `TRUST_PROXY=1` (behind Nginx/Render so rate limits see real IPs).

## Before going live
- **Hosting disk:** SQLite is a file. Use a host with a persistent disk/volume (Render free tier wipes it on restart; use a paid disk or a VPS).
- **Backups:** copy `jobpay.db` regularly. It contains applicants' names and phone numbers, so keep it private and never commit it to GitHub (see .gitignore).
- **Sample jobs** are dummy (`is_sample=1`). Delete them (`DELETE FROM jobs WHERE is_sample=1`) and add real postings.
- **HTTPS:** put it behind Render/Cloudflare/Nginx. Applications should not travel over plain HTTP.
- `node:sqlite` is marked experimental in Node 22 and prints a warning. It is stable in practice, but pin your Node version.
- Applications are stored but employers cannot view them in the UI yet (query the `applications` table for now).

## Scoring
Skills 40, field 25, location 15, salary 10, job type 10 - rule-based and explainable, not an LLM.
