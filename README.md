# JobPay.in Backend (Step 1-4)

## Run
1. `npm install`
2. `cp .env.example .env` (aur JWT_SECRET badlo)
3. MongoDB chalu rakho, phir `npm run dev`

## APIs
- POST /api/auth/register  {name,email,password,role: jobseeker|recruiter}
- POST /api/auth/login
- GET  /api/auth/me   (Bearer token)
- PUT  /api/auth/profile
- GET  /api/jobs?q=&location=&minSalary=&jobType=&skills=a,b&page=&limit=
- POST /api/jobs (recruiter; pehli baar companyName bhi bhejo)
- PUT/DELETE /api/jobs/:id

## Next: Apply + Resume upload (Application model ready hai)
