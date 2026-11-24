(function () {
  "use strict";
  var app = document.getElementById("app");
  var f = { q: "", category: "", city: "", type: "", minSalary: "" }, page = 1, meta = null, timer;
  var TYPES = ["Full Time", "Part Time", "Daily Wage", "Gig", "Freelance", "Commission"];
  var SAL = [["Salary (any)", ""], ["10,000+", "10000"], ["20,000+", "20000"], ["30,000+", "30000"], ["50,000+", "50000"]];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function inr(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
  function where(j) { return j.workMode === "remote" ? "Work from home" : j.workMode === "anywhere" ? "All India" : j.city; }
  function api(path, opt) {
    return fetch(path, opt).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Error"); return d; }); });
  }
  function show(node) { app.textContent = ""; app.appendChild(node); }
  function select(label, opts, key, onChange) {
    var s = el("select", { "aria-label": label }, opts.map(function (o) {
      var op = el("option", { value: o[1], text: o[0] }); if (f[key] === o[1]) op.selected = true; return op;
    }));
    s.addEventListener("change", function () { f[key] = s.value; onChange(); });
    return s;
  }
  function card(j) {
    return el("a", { class: "card", href: "#/job/" + j.id }, [
      el("h3", { text: j.title }),
      el("div", { class: "meta", text: [j.company, where(j), j.type].filter(Boolean).join(" • ") }),
      el("div", { class: "pay", text: inr(j.salaryMin) + " – " + inr(j.salaryMax) + " / month" }),
      el("div", { class: "skills" }, j.requiredSkills.slice(0, 4).map(function (s) { return el("span", { text: s }); }))
    ]);
  }

  function list() {
    var box = el("div"), results = el("div");
    var inp = el("input", { type: "search", placeholder: "Job ya skill dhoondo (jaise driver, cook)", "aria-label": "Search jobs", value: f.q });
    inp.addEventListener("input", function () { f.q = inp.value; clearTimeout(timer); timer = setTimeout(function () { page = 1; load(); }, 300); });
    var reload = function () { page = 1; load(); };
    box.appendChild(el("div", { class: "filters" }, [inp,
      select("Field", [["Sab fields", ""]].concat(meta.categories.map(function (c) { return [c.label, c.key]; })), "category", reload),
      select("City", [["Sab cities", ""]].concat(meta.cities.map(function (c) { return [c, c]; })), "city", reload),
      select("Job type", [["Job type (any)", ""]].concat(TYPES.map(function (t) { return [t, t]; })), "type", reload),
      select("Minimum salary", SAL, "minSalary", reload)]));
    box.appendChild(results);
    show(box);
    var token = 0;
    function load() {
      var my = ++token, qs = new URLSearchParams(Object.assign({ page: page }, f));
      Object.keys(f).forEach(function (k) { if (!f[k]) qs.delete(k); });
      api("/api/jobs?" + qs).then(function (d) {
        if (my !== token) return; // ignore out-of-date responses
        if (page === 1) results.textContent = "";
        if (!d.total) results.appendChild(el("p", { class: "empty", text: "Koi job nahi mili. Filter badal ke dekho ya 'Find my job' dabao." }));
        d.jobs.forEach(function (j) { results.appendChild(card(j)); });
        var more = results.querySelector(".more"); if (more) more.remove();
        if (page * d.pageSize < d.total) results.appendChild(el("button", { class: "btn alt more", type: "button", text: "Aur jobs dikhao", onclick: function () { page++; load(); } }));
      }).catch(function () {
        if (my === token) results.appendChild(el("div", { class: "msg err", role: "alert", text: "Jobs load nahi hui. Internet check karo." }));
      });
    }
    load();
  }

  function detail(id) {
    show(el("p", { class: "empty", text: "Loading…" }));
    api("/api/jobs/" + id).then(function (j) {
      var msg = el("div", { "aria-live": "polite" });
      var name = el("input", { id: "n", autocomplete: "name", maxlength: "60", required: "" });
      var phone = el("input", { id: "p", type: "tel", inputmode: "numeric", autocomplete: "tel", placeholder: "10 digit mobile", maxlength: "14", required: "" });
      var note = el("textarea", { id: "m", rows: "2", maxlength: "300", placeholder: "Optional" });
      var go = el("button", { class: "btn", type: "submit", text: "Apply karo" });
      var form = el("form", { class: "form" }, [
        el("label", { for: "n", text: "Aapka naam" }, [name]), el("label", { for: "p", text: "Mobile number" }, [phone]),
        el("label", { for: "m", text: "Kuch batana hai?" }, [note]), go, msg]);
      form.addEventListener("submit", function (e) {
        e.preventDefault(); go.disabled = true; msg.textContent = "";
        api("/api/jobs/" + id + "/apply", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.value, phone: phone.value, message: note.value }) })
          .then(function () { msg.appendChild(el("div", { class: "msg ok", text: "Application bhej di gayi. Employer aapse contact karega." })); })
          .catch(function (er) { go.disabled = false; msg.appendChild(el("div", { class: "msg err", role: "alert", text: er.message })); });
      });
      document.title = j.title + " - jobpay.in";
      show(el("div", {}, [el("a", { class: "back", href: "#/", text: "← Sab jobs" }),
        el("h2", { text: j.title }),
        el("div", { class: "meta", text: [j.company, where(j), j.type].filter(Boolean).join(" • ") }),
        el("div", { class: "pay", text: inr(j.salaryMin) + " – " + inr(j.salaryMax) + " / month" }),
        j.description ? el("p", { text: j.description }) : null,
        el("div", { class: "skills" }, j.requiredSkills.map(function (s) { return el("span", { text: s }); })),
        form]));
    }).catch(function () {
      show(el("div", {}, [el("div", { class: "msg err", role: "alert", text: "Yeh job nahi mili ya hat chuki hai." }), el("a", { class: "back", href: "#/", text: "← Sab jobs" })]));
    });
  }

  function route() {
    var m = location.hash.match(/^#\/job\/(\d+)$/);
    window.scrollTo(0, 0);
    if (m) return detail(m[1]);
    document.title = "jobpay.in - Nearby jobs"; list();
  }
  api("/api/match/meta").then(function (d) { meta = d; window.addEventListener("hashchange", route); route(); })
    .catch(function () { show(el("div", { class: "msg err", role: "alert", text: "Server se connect nahi ho paya. Page refresh karo." })); });
})();
