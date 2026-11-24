# jobpay.in

Job portal MVP: browse and search jobs, apply, 4-step "Find my job" matching popup, employer posting API.
**Zero dependencies** - needs only Node 22.5+ (SQLite is built in). Works on Termux, VPS, Render, Railway.

    node server.js                      # http://localhost:3000  (creates jobpay.db and loads sample jobs)
    ADMIN_KEY=choose-a-long-secret node server.js   # also enables employer posting
    npm test                            # 27 automated tests incl. a UI flow against the real server

## Employers
Open `/employer.html` (link "Employer?" on the home page). Register with mobile number + password, then:
post jobs, see applicants per job, move them through stages (Naye, Shortlist, Interview, Select, Reject),
call or WhatsApp them, close/reopen a job, and edit the business profile.
Login is a session cookie (HttpOnly, SameSite=Strict, 7 days). Passwords are hashed with scrypt; only a hash of the session token is stored.
There is no OTP login: it needs a paid SMS gateway. Add one later if you want it. There is also no "forgot password" yet.
`ADMIN_KEY` still works for posting from curl: `POST /api/jobs` with header `x-admin-key`.

## Where things are
`server.js` HTTP + API + static files | `auth.js` password and session helpers | `db.js` SQLite schema, migrations, queries | `core/`, `services/matcher.js` matching logic
`public/` frontend (`app.js` list/detail/apply, `employer.js` dashboard, `match-popup.js` popup) | `data/jobs.js` ~65 sample jobs | `test/`

## Settings (env)
`PORT`, `DB_FILE` (default jobpay.db), `ADMIN_KEY` (empty = posting disabled), `TRUST_PROXY=1` (behind Nginx/Render so rate limits see real IPs).

## Before going live
- **Hosting disk:** SQLite is a file. Use a host with a persistent disk/volume (Render free tier wipes it on restart; use a paid disk or a VPS).
- **Backups:** copy `jobpay.db` regularly. It contains applicants' names and phone numbers, so keep it private and never commit it to GitHub (see .gitignore).
- **Sample jobs** are dummy (`is_sample=1`). Delete them (`DELETE FROM jobs WHERE is_sample=1`) and add real postings.
- **HTTPS:** put it behind Render/Cloudflare/Nginx. Applications should not travel over plain HTTP.
- `node:sqlite` is marked experimental in Node 22 and prints a warning. It is stable in practice, but pin your Node version.
- Set `COOKIE_SECURE=1` (or `TRUST_PROXY=1` behind an HTTPS proxy) so login cookies get the Secure flag.
- Back up `jobpay.db` before updating: the new version migrates old databases automatically, but a copy is cheap insurance.

## Scoring
Skills 40, field 25, location 15, salary 10, job type 10 - rule-based and explainable, not an LLM.
