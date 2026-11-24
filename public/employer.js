'use strict';
/* Employer dashboard. Login = mobile number + password; session = HttpOnly cookie (no token in JS). */
const API = {
  register: ['POST', '/api/employer/register'],
  login: ['POST', '/api/employer/login'],
  logout: ['POST', '/api/employer/logout'],
  me: ['GET', '/api/employer/me'],
  meta: ['GET', '/api/match/meta'],
  jobs: ['GET', '/api/employer/jobs'],
  addJob: ['POST', '/api/employer/jobs'],
  applicants: (id) => ['GET', `/api/employer/jobs/${encodeURIComponent(id)}/applicants`],
  company: ['GET', '/api/employer/company'],
  saveCompany: ['PUT', '/api/employer/company'],
  setJobStatus: (id) => ['PATCH', `/api/employer/jobs/${encodeURIComponent(id)}`],
  setApplicantStatus: (id) => ['PATCH', `/api/employer/applicants/${encodeURIComponent(id)}`],
};
const STAGES = [['new', 'Naye'], ['shortlisted', 'Shortlist'], ['interview', 'Interview'], ['hired', 'Select hue'], ['rejected', 'Reject']];
const stageName = (s) => (STAGES.find((x) => x[0] === s) || STAGES[0])[1];
const PHONE_RE = /^[6-9]\d{9}$/;
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
let authed = null; // null = not checked yet

/* ===== Helpers ===== */
// Safe DOM builder: strings are always text nodes, so user data can never inject HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

let toastTimer;
function toast(msg, bad = false) {
  clearTimeout(toastTimer);
  $toast.textContent = msg;
  $toast.className = 'e-toast show' + (bad ? ' bad' : '');
  toastTimer = setTimeout(() => { $toast.className = 'e-toast'; }, 3200);
}

async function api([method, url], body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Internet check karke dobara try karein.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && authed) {
    authed = false;
    route();
    throw new Error('Session khatam ho gaya. Dobara login karein.');
  }
  if (!res.ok) throw new Error(data.error || 'Kuch galat hua. Dobara try karein.');
  return data;
}

let metaCache;
async function categories() {
  if (!metaCache) metaCache = (await api(API.meta)).categories;
  return metaCache;
}

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
// Server job -> card shape used by the views below.
const normJob = (j) => ({
  id: j.id, title: j.title, location: j.city || (j.workMode === 'remote' ? 'Work from home' : 'All India'),
  salary: `${inr(j.salaryMin)} – ${inr(j.salaryMax)}`, status: j.isActive ? 'open' : 'closed',
  applicants_count: j.applicants || 0, new_count: j.newCount || 0,
});
const intl = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
const fmtDate = (s) => { const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleDateString('hi-IN', { day: 'numeric', month: 'short' }); };

let rid = 0; // stops a slow old response from overwriting a newer page
function show(...nodes) {
  $app.replaceChildren(...nodes);
  const h1 = $app.querySelector('h1');
  if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
}

/* ===== Popup (modal / bottom sheet) ===== */
function modal(title, build) {
  const prev = document.activeElement;
  const titleId = 'm' + Date.now();
  const close = () => {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('e-lock');
    wrap.remove();
    if (prev && prev.focus) prev.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button,a[href],input,textarea,select')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const box = h('div', { class: 'e-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('h2', { id: titleId }, title), ...build(close));
  const wrap = h('div', { class: 'e-backdrop', onclick: (e) => { if (e.target === wrap) close(); } }, box);
  document.body.append(wrap);
  document.body.classList.add('e-lock');
  document.addEventListener('keydown', onKey);
  (box.querySelector('input,textarea,select,a[href],button') || box).focus();
  return close;
}

const cancelBtn = (close, label = 'Band karein') =>
  h('button', { class: 'e-btn', type: 'button', onclick: close }, label);

/* ===== Views ===== */
function topbar() {
  const cur = (p) => (location.hash === p || (p === '#/home' && !location.hash) ? 'page' : null);
  return h('nav', { class: 'e-bar', 'aria-label': 'Employer menu' },
    h('a', { href: '#/home', 'aria-current': cur('#/home') }, 'Dashboard'),
    h('a', { href: '#/jobs', 'aria-current': cur('#/jobs') }, 'Jobs'),
    h('a', { href: '#/company', 'aria-current': cur('#/company') }, 'Business'),
    h('button', { class: 'e-link', type: 'button', onclick: confirmLogout }, 'Logout'));
}

function confirmLogout() {
  modal('Logout karein?', (close) => [
    h('p', { class: 'e-sub' }, 'Dobara login ke liye number aur password lagega.'),
    h('div', { class: 'e-actions' }, cancelBtn(close, 'Rukein'),
      h('button', { class: 'e-btn e-danger', type: 'button', onclick: async () => {
        try { await api(API.logout); } catch { /* cookie is cleared by the server; ignore network errors */ }
        close(); authed = false; location.hash = ''; route();
      } }, 'Logout')),
  ]);
}

function loginView(mode = 'login') {
  rid++;
  const reg = mode === 'register';
  const err = h('p', { class: 'e-err', role: 'alert' });
  const fld = (id, label, attrs) => [h('label', { for: id }, label), h('input', { id, ...attrs })];
  const btn = h('button', { class: 'e-btn e-primary', type: 'submit' }, reg ? 'Account banao' : 'Login karein');
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const g = (id) => form.querySelector('#' + id)?.value.trim() ?? '';
      const phone = g('phone').replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
      const password = form.querySelector('#pw').value;
      if (reg && g('nm').length < 2) { err.textContent = 'Apna naam likhein.'; return form.querySelector('#nm').focus(); }
      if (reg && g('co').length < 2) { err.textContent = 'Dukaan / company ka naam likhein.'; return form.querySelector('#co').focus(); }
      if (!PHONE_RE.test(phone)) { err.textContent = 'Sahi 10 digit mobile number daalein (6 se 9 se shuru).'; return form.querySelector('#phone').focus(); }
      if (reg && password.length < 8) { err.textContent = 'Password kam se kam 8 akshar ka rakhein.'; return form.querySelector('#pw').focus(); }
      btn.disabled = true;
      try {
        await api(reg ? API.register : API.login, reg ? { name: g('nm'), company: g('co'), phone, password } : { phone, password });
        authed = true;
        if (location.hash !== '#/home') location.hash = '#/home'; else route();
      } catch (x) { err.textContent = x.message; btn.disabled = false; }
    },
  }, ...(reg ? [...fld('nm', 'Aapka naam', { autocomplete: 'name', maxlength: '60' }), ...fld('co', 'Dukaan / company ka naam', { maxlength: '80' })] : []),
    h('label', { for: 'phone' }, 'Mobile number'),
    h('div', { class: 'e-phone' }, h('span', {}, '+91'), h('input', { id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', maxlength: '14', placeholder: '10 digit mobile number' })),
    ...fld('pw', reg ? 'Password (8+ akshar)' : 'Password', { type: 'password', maxlength: '100', autocomplete: reg ? 'new-password' : 'current-password' }),
    btn);
  show(h('section', { class: 'e-card e-narrow' },
    h('h1', {}, reg ? 'Naya employer account' : 'Employer login'),
    h('p', { class: 'e-sub' }, 'Jobs post karein aur applicants ko seedha call ya WhatsApp karein.'),
    form, err,
    h('button', { class: 'e-link', type: 'button', onclick: () => loginView(reg ? 'login' : 'register') }, reg ? 'Account hai? Login karein' : 'Naya account banayein')));
  $app.querySelector('input').focus();
}

async function openJobForm(onDone) {
  let cats;
  try { cats = await categories(); } catch (x) { return toast(x.message, true); }
  modal('Nayi job post karein', (close) => {
    const err = h('p', { class: 'e-err', role: 'alert' });
    const f = (id, label, attrs = {}) => [h('label', { for: id }, label), h(attrs.rows ? 'textarea' : 'input', { id, ...attrs })];
    const btn = h('button', { class: 'e-btn e-primary', type: 'submit' }, 'Job post karein');
    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        const g = (id) => form.querySelector('#' + id).value.trim();
        const min = Number(g('jmin')), max = Number(g('jmax'));
        if (!g('jt') || !g('jl')) { err.textContent = 'Job ka title aur sheher zaroori hai.'; return; }
        if (!Number.isFinite(min) || !Number.isFinite(max) || !g('jmin') || !g('jmax') || min < 0 || max < min) { err.textContent = 'Salary sahi likhein (kam se kam, zyada se zyada).'; return; }
        btn.disabled = true;
        try {
          await api(API.addJob, { title: g('jt'), category: g('jc'), city: g('jl'), workMode: 'onsite', salaryMin: min, salaryMax: max,
            requiredSkills: g('jsk').split(',').map((s) => s.trim()).filter(Boolean), description: g('jd') });
          close(); toast('Job post ho gayi'); onDone();
        } catch (x) { err.textContent = x.message; btn.disabled = false; }
      },
    }, ...f('jt', 'Job title', { maxlength: '80', placeholder: 'jaise: Delivery partner' }),
      h('label', { for: 'jc' }, 'Field'), h('select', { id: 'jc' }, ...cats.map((c) => h('option', { value: c.key }, c.label))),
      ...f('jl', 'Sheher', { maxlength: '60', placeholder: 'jaise: Hadgaon' }),
      ...f('jmin', 'Salary kam se kam (₹ / mahina)', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '10000' }),
      ...f('jmax', 'Salary zyada se zyada (₹ / mahina)', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '15000' }),
      ...f('jsk', 'Zaroori skills (comma se alag, optional)', { maxlength: '200', placeholder: 'Cooking, Billing' }),
      ...f('jd', 'Details (optional)', { rows: '3', maxlength: '500', placeholder: 'Kaam, timing' }),
      err, h('div', { class: 'e-actions' }, cancelBtn(close, 'Cancel'), btn));
    return [form];
  });
}

async function jobsView() {
  const stamp = ++rid;
  const list = h('div', { class: 'e-list' }, h('p', { class: 'e-sub' }, 'Jobs load ho rahi hain…'));
  const load = async () => {
    try {
      const jobs = (await api(API.jobs)).jobs.map(normJob);
      if (stamp !== rid) return;
      if (!jobs.length) {
        list.replaceChildren(h('div', { class: 'e-empty' }, h('p', {}, 'Abhi koi job post nahi hui. Pehli job post karke applicants paayein.'),
          h('button', { class: 'e-btn e-primary', onclick: () => openJobForm(load) }, 'Nayi job post karein')));
        return;
      }
      list.replaceChildren(...jobs.map((j) => h('a', { class: 'e-job', href: `#/job/${encodeURIComponent(j.id)}` },
        h('strong', {}, j.title),
        h('span', {}, [j.location, j.salary].filter(Boolean).join(' | ')),
        h('span', { class: 'e-count' }, `${j.applicants_count} applicants` + (j.new_count ? ` | ${j.new_count} naye` : '') + (j.status === 'closed' ? ' | Band' : '')))));
    } catch (x) {
      if (stamp !== rid) return;
      list.replaceChildren(h('p', { class: 'e-err' }, x.message), h('button', { class: 'e-btn', onclick: load }, 'Dobara try karein'));
    }
  };
  show(topbar(), h('div', { class: 'e-head' }, h('h1', {}, 'Meri jobs'),
    h('button', { class: 'e-btn e-primary', onclick: () => openJobForm(load) }, 'Nayi job post karein')), list);
  load();
}

function contactSheet(a, jobTitle) {
  const num = intl(a.phone);
  const text = `Namaste ${a.name || ''}, aapne jobpay.in par "${jobTitle}" ke liye apply kiya tha. Kya hum baat kar sakte hain?`;
  modal(a.name || 'Applicant', (close) => [
    h('p', { class: 'e-sub' }, `+${num.slice(0, 2)} ${num.slice(2)}`),
    h('div', { class: 'e-stack' },
      h('a', { class: 'e-btn e-primary', href: `tel:+${num}` }, 'Call karein'),
      h('a', { class: 'e-btn e-wa', href: `https://wa.me/${num}?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp par message karein'),
      h('button', { class: 'e-btn', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText('+' + num); toast('Number copy ho gaya'); close(); }
        catch { toast('Copy nahi ho paya. Number dekh kar likh lein.', true); }
      } }, 'Number copy karein'),
      cancelBtn(close)),
  ]);
}

function toggleJob(id, job, done) {
  const closing = job.status !== 'closed';
  modal(closing ? 'Job band karein?' : 'Job dobara kholein?', (close) => [
    h('p', { class: 'e-sub' }, closing ? 'Naye applicants nahi aayenge. Purane applicants dikhte rahenge.' : 'Job phir se logon ko dikhne lagegi.'),
    h('div', { class: 'e-actions' }, cancelBtn(close, 'Rukein'),
      h('button', { class: 'e-btn e-primary', type: 'button', onclick: async () => {
        try { await api(API.setJobStatus(id), { status: closing ? 'closed' : 'open' }); close(); toast(closing ? 'Job band ho gayi' : 'Job phir se khul gayi'); done(); }
        catch (x) { toast(x.message, true); }
      } }, closing ? 'Band karein' : 'Dobara kholein')),
  ]);
}

function statusSheet(a, repaint) {
  modal(a.name || 'Applicant', (close) => [
    h('p', { class: 'e-sub' }, 'Is applicant ko kis stage par rakhein?'),
    h('div', { class: 'e-stack' }, ...STAGES.map(([k, label]) =>
      h('button', { class: 'e-btn' + ((a.status || 'new') === k ? ' e-primary' : ''), type: 'button', onclick: async () => {
        try { await api(API.setApplicantStatus(a.id), { status: k }); a.status = k; close(); repaint(); toast('Status: ' + label); }
        catch (x) { toast(x.message, true); }
      } }, label)), cancelBtn(close)),
  ]);
}

async function applicantsView(id) {
  const stamp = ++rid;
  let filter = 'all', apps = [], job = {};
  const title = h('h1', {}, 'Applicants');
  const head = h('div', { class: 'e-head' }, title);
  const chips = h('div', { class: 'e-chips', role: 'group', 'aria-label': 'Status filter' });
  const list = h('div', { class: 'e-list' }, h('p', { class: 'e-sub' }, 'Applicants load ho rahe hain…'));
  const paint = () => {
    const count = (k) => (k === 'all' ? apps.length : apps.filter((a) => (a.status || 'new') === k).length);
    chips.replaceChildren(...[['all', 'Sab'], ...STAGES].map(([k, label]) =>
      h('button', { class: 'e-chip', type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; paint(); } }, `${label} (${count(k)})`)));
    const rows = apps.filter((a) => filter === 'all' || (a.status || 'new') === filter);
    if (!rows.length) return list.replaceChildren(h('div', { class: 'e-empty' }, h('p', {}, apps.length ? 'Is stage mein abhi koi applicant nahi.' : 'Abhi koi applicant nahi aaya. Job share karein, applicants yahin dikhenge.')));
    list.replaceChildren(...rows.map((a) => h('div', { class: 'e-job' },
      h('strong', {}, a.name || 'Naam nahi diya'),
      h('span', {}, [a.message, fmtDate(a.createdAt)].filter(Boolean).join(' | ')),
      h('span', { class: 'e-badge' }, stageName(a.status)),
      h('div', { class: 'e-actions' },
        h('button', { class: 'e-btn e-primary', type: 'button', onclick: () => contactSheet(a, job.title || 'job') }, 'Sampark karein'),
        h('button', { class: 'e-btn', type: 'button', onclick: () => statusSheet(a, paint) }, 'Status badlein')))));
  };
  show(topbar(), head, chips, list);
  try {
    const r = await api(API.applicants(id));
    if (stamp !== rid) return;
    apps = r.applicants || [];
    job = r.job || {};
    if (job.title) {
      title.textContent = job.title;
      head.append(h('button', { class: 'e-btn', type: 'button', onclick: () => toggleJob(id, job, () => applicantsView(id)) }, job.status === 'closed' ? 'Job dobara kholein' : 'Job band karein'));
    }
    paint();
  } catch (x) {
    if (stamp !== rid) return;
    list.replaceChildren(h('p', { class: 'e-err' }, x.message), h('button', { class: 'e-btn', onclick: () => applicantsView(id) }, 'Dobara try karein'));
  }
}

async function homeView() {
  const stamp = ++rid;
  const body = h('div', { class: 'e-list' }, h('p', { class: 'e-sub' }, 'Dashboard load ho raha hai…'));
  show(topbar(), h('h1', {}, 'Dashboard'), body);
  try {
    const [co, res] = await Promise.all([api(API.company), api(API.jobs)]);
    if (stamp !== rid) return;
    const jobs = res.jobs.map(normJob);
    const sum = (k) => jobs.reduce((t, j) => t + (Number(j[k]) || 0), 0);
    const stat = (n, label) => h('div', { class: 'e-stat' }, h('strong', {}, String(n)), h('span', {}, label));
    const top = [...jobs].sort((a, b) => b.new_count - a.new_count).slice(0, 3);
    $app.querySelector('h1').textContent = 'Namaste, ' + co.name;
    body.replaceChildren(
      ...(!co.city ? [h('a', { class: 'e-job', href: '#/company' }, h('strong', {}, 'Business profile poora karein'), h('span', {}, 'City aur type bharein taaki log aapko pehchanein.'))] : []),
      h('div', { class: 'e-stats' }, stat(jobs.filter((j) => j.status !== 'closed').length, 'Khuli jobs'), stat(sum('applicants_count'), 'Total applicants'), stat(sum('new_count'), 'Naye applicants')),
      h('h2', {}, 'Dhyan dene wali jobs'),
      ...(top.length ? top.map((j) => h('a', { class: 'e-job', href: `#/job/${encodeURIComponent(j.id)}` }, h('strong', {}, j.title), h('span', { class: 'e-count' }, `${j.new_count} naye | ${j.applicants_count} total`)))
        : [h('div', { class: 'e-empty' }, h('p', {}, 'Abhi koi job nahi. Pehli job post karke hiring shuru karein.'))]),
      h('button', { class: 'e-btn e-primary', type: 'button', onclick: () => openJobForm(homeView) }, 'Nayi job post karein'));
  } catch (x) {
    if (stamp !== rid) return;
    body.replaceChildren(h('p', { class: 'e-err' }, x.message), h('button', { class: 'e-btn', onclick: homeView }, 'Dobara try karein'));
  }
}

async function companyView() {
  const stamp = ++rid;
  const err = h('p', { class: 'e-err', role: 'alert' });
  const card = h('section', { class: 'e-card e-narrow' }, h('h1', {}, 'Business profile'),
    h('p', { class: 'e-sub' }, 'Applicants ko aapka business pehchaan mein aaye, isliye yeh jaankari bharein.'));
  show(topbar(), card);
  let co = {};
  try { co = (await api(API.company)) || {}; } catch (x) { err.textContent = x.message; }
  if (stamp !== rid) return;
  const fld = (id, label, val, attrs = {}) => [h('label', { for: id }, label), h('input', { id, value: val || '', ...attrs })];
  const types = ['Restaurant / Catering', 'Dukaan / Retail', 'Factory / Manufacturing', 'Hospital / Clinic', 'School / Coaching', 'Construction', 'Transport / Delivery', 'Office / IT', 'Anya'];
  const btn = h('button', { class: 'e-btn e-primary', type: 'submit' }, 'Profile save karein');
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const g = (id) => form.querySelector('#' + id).value.trim();
      const body = { name: g('cn'), type: g('ct'), city: g('cc') };
      if (!body.name || !body.city) { err.textContent = 'Business ka naam aur city zaroori hai.'; return; }
      btn.disabled = true;
      try { await api(API.saveCompany, body); toast('Profile save ho gayi'); location.hash = '#/home'; }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    },
  }, ...fld('cn', 'Business ka naam', co.name, { maxlength: '80', placeholder: 'jaise: Sharma Caterers' }),
    ...fld('ct', 'Business ka type', co.type, { maxlength: '40', list: 'ctypes', placeholder: 'jaise: Restaurant / Catering' }),
    ...fld('cc', 'City', co.city, { maxlength: '40', placeholder: 'jaise: Hadgaon' }),
    h('datalist', { id: 'ctypes' }, ...types.map((t) => h('option', { value: t }))), btn, err);
  card.append(form);
}

/* ===== Router ===== */
async function route() {
  if (authed === null) { try { await api(API.me); authed = true; } catch { authed = false; } }
  if (!authed) return loginView();
  const m = location.hash.match(/^#\/job\/([^/]+)$/);
  if (m) applicantsView(decodeURIComponent(m[1]));
  else if (location.hash === '#/jobs') jobsView();
  else if (location.hash === '#/company') companyView();
  else homeView();
}
addEventListener('hashchange', route);
route();

/* Password dikhao / chhupao */
(function () {
  function addToggle() {
    document.querySelectorAll('#pw').forEach(function (pw) {
      if (pw.dataset.tg) return;
      pw.dataset.tg = '1';
      var wrap = document.createElement('div');
      wrap.className = 'pw-wrap';
      pw.parentNode.insertBefore(wrap, pw);
      wrap.appendChild(pw);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pw-toggle';
      b.textContent = 'Dikhao';
      b.addEventListener('click', function () {
        var show = pw.type === 'password';
        pw.type = show ? 'text' : 'password';
        b.textContent = show ? 'Chhupao' : 'Dikhao';
      });
      wrap.appendChild(b);
    });
  }
  try {
    if (typeof MutationObserver !== 'undefined') new MutationObserver(addToggle).observe(document.documentElement, { childList: true, subtree: true });
    addToggle();
  } catch (e) {}
})();
