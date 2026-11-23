/*! Jobpay Job Match popup - drop-in, no dependencies.
 *  Add before </body>:  <script src="/match-popup.js" defer></script>
 *  Optional (set BEFORE the script loads):
 *    window.JOBPAY_JOB_URL   = id => "/jobs/" + id;   // where "View job" goes
 *    window.JOBPAY_MATCH_API = "https://api.example.com"; // backend on another domain
 *    window.JOBPAY_NO_FAB    = true;                  // hide floating button, use your own
 *  Open from your own button / React / Vue:  window.JobpayMatch.open()
 */
(function () {
  "use strict";
  var API = (window.JOBPAY_MATCH_API || "") + "/api/match"; // set JOBPAY_MATCH_API = "https://api.example.com" if backend is on another domain
  var jobUrl = window.JOBPAY_JOB_URL || function (id) { return "/jobs/" + id; };

  var css = [
    ".jm-fab{position:fixed;right:16px;bottom:16px;z-index:9998;background:#0e7c66;color:#fff;border:0;border-radius:28px;padding:14px 20px;font:600 15px/1 system-ui,sans-serif;box-shadow:0 6px 18px rgba(14,124,102,.35);cursor:pointer}",
    ".jm-fab:focus-visible,.jm-btn:focus-visible,.jm-x:focus-visible{outline:3px solid #ffb703;outline-offset:2px}",
    ".jm-ov{position:fixed;inset:0;z-index:9999;background:rgba(20,33,61,.55);display:flex;align-items:flex-end;justify-content:center}",
    ".jm-box{background:#fff;color:#14213d;width:100%;max-width:520px;max-height:92vh;overflow:auto;border-radius:20px 20px 0 0;padding:20px 18px 24px;font:16px/1.45 system-ui,sans-serif;animation:jm-up .22s ease-out}",
    "@keyframes jm-up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}",
    "@media(min-width:600px){.jm-ov{align-items:center}.jm-box{border-radius:20px}}",
    "@media(prefers-reduced-motion:reduce){.jm-box{animation:none}}",
    ".jm-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}",
    ".jm-step{font-size:13px;color:#5b6577}",
    ".jm-x{background:none;border:0;font-size:26px;line-height:1;cursor:pointer;color:#14213d;padding:4px 8px}",
    ".jm-bar{height:4px;background:#e6eaf0;border-radius:2px;margin:6px 0 14px}.jm-bar i{display:block;height:100%;background:#0e7c66;border-radius:2px;transition:width .2s}",
    ".jm-h{font-size:20px;font-weight:700;margin:0 0 4px}.jm-p{margin:0 0 14px;color:#5b6577;font-size:14px}",
    ".jm-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}",
    ".jm-btn{border:1.5px solid #c9d1de;background:#fff;color:#14213d;border-radius:22px;padding:10px 14px;font:500 15px/1.1 system-ui,sans-serif;cursor:pointer}",
    ".jm-btn[aria-pressed=true]{background:#0e7c66;border-color:#0e7c66;color:#fff}",
    ".jm-row{display:flex;gap:10px;justify-content:space-between}",
    ".jm-go{flex:1;background:#14213d;color:#fff;border:0;border-radius:12px;padding:13px;font:600 16px system-ui,sans-serif;cursor:pointer}",
    ".jm-go[disabled]{opacity:.4;cursor:not-allowed}.jm-back{background:#eef1f6;color:#14213d;flex:0 0 auto;padding:13px 18px}",
    ".jm-card{border:1px solid #dfe4ec;border-radius:14px;padding:14px;margin-bottom:10px}",
    ".jm-ct{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}",
    ".jm-ct b{font-size:16px}.jm-sc{flex:none;background:#ffb703;color:#14213d;font-weight:700;border-radius:10px;padding:3px 9px;font-size:14px}",
    ".jm-meta{font-size:13px;color:#5b6577;margin:4px 0 6px}",
    ".jm-why{font-size:13px;margin:0;padding-left:18px}.jm-miss{font-size:12px;color:#8a5a00;margin-top:6px}",
    ".jm-link{display:inline-block;margin-top:8px;font-weight:600;color:#0e7c66;text-decoration:none}",
    ".jm-err{background:#fdecea;color:#8a1c12;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:14px}"
  ].join("");

  var TYPES = ["Any", "Full Time", "Part Time", "Daily Wage", "Gig", "Freelance"];
  var SALARY = [["Any", 0], ["10,000+", 10000], ["20,000+", 20000], ["30,000+", 30000], ["50,000+", 50000]];
  var STEPS = ["category", "skills", "work", "where"];

  var meta = null, step = 0, lastFocus = null, keep = false;
  var s = { category: "", skills: [], jobType: "Any", minSalary: 0, city: "", openToRemote: false };
  var ov, box;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "onclick") n.addEventListener("click", attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function chip(label, pressed, onClick) {
    return el("button", { type: "button", class: "jm-btn", "aria-pressed": String(!!pressed), text: label,
      onclick: function () { keep = true; onClick(); } });
  }
  function inr(n) { return "₹" + Number(n).toLocaleString("en-IN"); }

  function open() {
    lastFocus = document.activeElement;
    ov = el("div", { class: "jm-ov", role: "presentation" });
    box = el("div", { class: "jm-box", role: "dialog", "aria-modal": "true", "aria-label": "Job match" });
    ov.appendChild(box);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    document.addEventListener("keydown", onKey);
    if (!meta) { render(loading("Loading options…")); load(); } else { go(0); }
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    if (ov) ov.remove();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    var f = box.querySelectorAll("button,a[href]");
    if (!f.length) return;
    var a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
  function loading(t) { return el("p", { class: "jm-p", role: "status", text: t }); }
  function render(content) {
    var idx = keep ? Array.prototype.indexOf.call(box.querySelectorAll("button,a[href]"), document.activeElement) : -1;
    keep = false; // chips keep focus position; moving between steps resets it
    box.textContent = "";
    box.appendChild(content);
    var all = box.querySelectorAll("button,a[href]");
    var target = idx > -1 && all[idx] ? all[idx] : all[0];
    if (target) target.focus();
  }
  function load() {
    fetch(API + "/meta").then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { meta = d; go(0); })
      .catch(function () {
        render(el("div", {}, [
          el("div", { class: "jm-err", role: "alert", text: "Options load nahi hue. Internet check karke dobara try karo." }),
          el("button", { class: "jm-go", type: "button", text: "Try again", onclick: function () { render(loading("Loading options…")); load(); } })
        ]));
      });
  }

  function header() {
    return el("div", {}, [
      el("div", { class: "jm-top" }, [
        el("span", { class: "jm-step", text: step < STEPS.length ? "Step " + (step + 1) + " of " + STEPS.length : "Your matches" }),
        el("button", { class: "jm-x", type: "button", "aria-label": "Close", text: "×", onclick: close })
      ]),
      el("div", { class: "jm-bar" }, [el("i", { style: "width:" + Math.min(100, (step + 1) / STEPS.length * 100) + "%" })])
    ]);
  }
  function nav(canNext, nextLabel) {
    var row = el("div", { class: "jm-row" });
    if (step > 0) row.appendChild(el("button", { class: "jm-go jm-back", type: "button", text: "Back", onclick: function () { go(step - 1); } }));
    var n = el("button", { class: "jm-go", type: "button", text: nextLabel || "Next", onclick: function () { step === STEPS.length - 1 ? submit() : go(step + 1); } });
    if (!canNext) n.disabled = true;
    row.appendChild(n);
    return row;
  }
  function go(i) {
    step = i;
    var wrap = el("div", {}, [header()]);
    var grid = el("div", { class: "jm-grid" });
    var name = STEPS[i];

    if (name === "category") {
      wrap.appendChild(el("h2", { class: "jm-h", text: "Kaunsa kaam chahiye?" }));
      wrap.appendChild(el("p", { class: "jm-p", text: "Ek field chuno." }));
      meta.categories.forEach(function (c) {
        grid.appendChild(chip(c.label, s.category === c.key, function () { s.category = c.key; s.skills = []; go(0); }));
      });
      wrap.appendChild(grid); wrap.appendChild(nav(!!s.category));
    }
    if (name === "skills") {
      wrap.appendChild(el("h2", { class: "jm-h", text: "Aapko kya aata hai?" }));
      wrap.appendChild(el("p", { class: "jm-p", text: "Jo skills aati hain wo chuno. Skip bhi kar sakte ho." }));
      (meta.skillsByCategory[s.category] || []).slice(0, 14).forEach(function (k) {
        var on = s.skills.indexOf(k) > -1;
        grid.appendChild(chip(k, on, function () {
          s.skills = on ? s.skills.filter(function (x) { return x !== k; }) : s.skills.concat(k);
          go(1);
        }));
      });
      wrap.appendChild(grid); wrap.appendChild(nav(true, s.skills.length ? "Next" : "Skip"));
    }
    if (name === "work") {
      wrap.appendChild(el("h2", { class: "jm-h", text: "Kaisa kaam aur kitni salary?" }));
      wrap.appendChild(el("p", { class: "jm-p", text: "Job type" }));
      TYPES.forEach(function (t) { grid.appendChild(chip(t, s.jobType === t, function () { s.jobType = t; go(2); })); });
      wrap.appendChild(grid);
      wrap.appendChild(el("p", { class: "jm-p", text: "Kam se kam salary (per month)" }));
      var g2 = el("div", { class: "jm-grid" });
      SALARY.forEach(function (x) { g2.appendChild(chip(x[0], s.minSalary === x[1], function () { s.minSalary = x[1]; go(2); })); });
      wrap.appendChild(g2); wrap.appendChild(nav(true));
    }
    if (name === "where") {
      wrap.appendChild(el("h2", { class: "jm-h", text: "Kahan kaam karna hai?" }));
      wrap.appendChild(el("p", { class: "jm-p", text: "Apna sheher chuno." }));
      meta.cities.forEach(function (c) { grid.appendChild(chip(c, s.city === c, function () { s.city = s.city === c ? "" : c; go(3); })); });
      grid.appendChild(chip("Work from home bhi chalega", s.openToRemote, function () { s.openToRemote = !s.openToRemote; go(3); }));
      wrap.appendChild(grid); wrap.appendChild(nav(true, "Show my matches"));
    }
    render(wrap);
  }

  function submit() {
    step = STEPS.length;
    render(loading("Best jobs dhoondh rahe hain…"));
    fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: s.category, skills: s.skills, jobType: s.jobType, minSalary: s.minSalary, city: s.city, openToRemote: s.openToRemote })
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Error"); return d; }); })
      .then(showResults)
      .catch(function (e) {
        step = STEPS.length - 1;
        var w = el("div", {}, [header(), el("div", { class: "jm-err", role: "alert", text: e.message || "Kuch gadbad hui. Dobara try karo." }), nav(true, "Try again")]);
        render(w);
      });
  }

  function showResults(d) {
    var w = el("div", {}, [header(), el("h2", { class: "jm-h", text: d.count ? d.count + " jobs aapke liye" : "Abhi koi match nahi mila" })]);
    if (!d.count) w.appendChild(el("p", { class: "jm-p", text: "Salary kam karke ya sheher badal kar dobara try karo." }));
    d.results.forEach(function (r) {
      var where = r.workMode === "remote" ? "Remote" : r.workMode === "anywhere" ? "All India" : r.city;
      var card = el("div", { class: "jm-card" }, [
        el("div", { class: "jm-ct" }, [el("b", { text: r.title }), el("span", { class: "jm-sc", "aria-label": r.score + " percent match", text: r.score + "%" })]),
        el("div", { class: "jm-meta", text: [where, r.type, inr(r.salaryMin) + "–" + inr(r.salaryMax)].filter(Boolean).join(" • ") })
      ]);
      if (r.reasons.length) {
        var ul = el("ul", { class: "jm-why" });
        r.reasons.forEach(function (t) { ul.appendChild(el("li", { text: t })); });
        card.appendChild(ul);
      }
      if (r.missingSkills.length) card.appendChild(el("div", { class: "jm-miss", text: "Seekhne layak: " + r.missingSkills.join(", ") }));
      card.appendChild(el("a", { class: "jm-link", href: jobUrl(r.id), text: "View job", onclick: close }));
      w.appendChild(card);
    });
    var row = el("div", { class: "jm-row" }, [
      el("button", { class: "jm-go jm-back", type: "button", text: "Change answers", onclick: function () { go(0); } }),
      el("button", { class: "jm-go", type: "button", text: "Done", onclick: close })
    ]);
    w.appendChild(row);
    render(w);
  }

  function init() {
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    if (!window.JOBPAY_NO_FAB) {
      document.body.appendChild(el("button", { class: "jm-fab", type: "button", "aria-haspopup": "dialog", text: "Find my job", onclick: open }));
    }
  }
  window.JobpayMatch = { open: open, close: close };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
