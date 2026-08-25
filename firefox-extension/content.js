// ===========================================================================
// CvAgent v3.0 — content script (AI Career OS core, in-page side)
//   F03 page-by-page validation · F04 captcha/OTP yield (+F14 vision hint)
//   F08 human typing · F09 tracker · F10 learned cross-page mappings
//   F11 passive API sniffer · F12 shadow-DOM piercing · F22 privacy alias
//   F24 compliance audit · F25 offline engine · F28 snapshot · F30 voice
// ===========================================================================

let RUNNING = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pill UI
function ensurePill() {
  if (document.getElementById("cvagent-pill")) return;
  const pill = document.createElement("div");
  pill.id = "cvagent-pill";
  pill.style.cssText = [
    "position:fixed", "bottom:18px", "right:18px", "z-index:2147483647",
    "background:#1F3A5F", "color:#fff", "padding:10px 16px", "border-radius:30px",
    "font:600 13px/1.2 'Segoe UI',Arial,sans-serif", "cursor:pointer",
    "box-shadow:0 4px 14px rgba(0,0,0,.35)", "border:2px solid #E87722",
    "user-select:none", "transition:opacity .2s"
  ].join(";");
  pill.title = "Click = fill page · Double-click = AI captcha hint";
  pill.textContent = "🤖 CvAgent — Fill this page";
  pill.addEventListener("click", () => runAgent());
  pill.addEventListener("dblclick", () => visionAssist());
  document.documentElement.appendChild(pill);
  injectSniffer();
}

function removePill() {
  const p = document.getElementById("cvagent-pill");
  if (p) p.remove();
}

function setStatus(text, busy) {
  const pill = document.getElementById("cvagent-pill");
  if (pill) pill.textContent = (busy ? "⏳ " : busy === false ? "🤖 " : "") + text;
  console.log("[CvAgent]", text);
}

// ===========================================================================
// FEATURE 11 — passive Shadow-API sniffer (injector in MAIN world)
// ===========================================================================
let sniffedEndpoints = [];
function injectSniffer() {
  if (window.__cvagentInjected) return;
  window.__cvagentInjected = true;
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injector.js");
    document.documentElement.appendChild(s);
    s.remove();
    window.addEventListener("message", (e) => {
      if (e.data && e.data.source === "cvagent-sniffer") {
        sniffedEndpoints = e.data.endpoints || [];
        console.log("[CvAgent] 🛰 API endpoints discovered:", sniffedEndpoints);
      }
    });
  } catch (e) { /* ignore */ }
}

// ===========================================================================
// FEATURE 12 — Deep Shadow DOM walker
// ===========================================================================
function deepQueryAll(selector, root = document) {
  const results = [];
  const walk = (scope) => {
    for (const el of scope.querySelectorAll(selector)) results.push(el);
    for (const el of scope.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  try { walk(root); } catch (e) { /* keep partial */ }
  return results;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

// ---------------------------------------------------------------- extraction
function extractFields() {
  const nodes = deepQueryAll("input, textarea, select");
  const out = [];
  let idx = 0;
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    if (el.type === "hidden") continue;
    el.setAttribute("data-cvagent-idx", String(idx));

    let labelText = "";
    const closestLabel = el.closest("label");
    if (closestLabel) labelText = closestLabel.innerText.trim();
    else if (el.id) {
      const lbl = deepQueryAll(`label[for="${el.id}"]`)[0];
      if (lbl) labelText = lbl.innerText.trim();
    }

    let questionContext = "";
    try {
      const fs = el.closest("fieldset");
      const legend = fs && fs.querySelector("legend");
      if (legend && legend.innerText.trim()) questionContext = legend.innerText.trim();
      if (!questionContext && el.getAttribute("aria-labelledby")) {
        questionContext = el.getAttribute("aria-labelledby").split(/\s+/)
          .map((id) => { const t = deepQueryAll(`#${CSS.escape(id)}`)[0]; return t ? t.innerText.trim() : ""; })
          .filter(Boolean).join(" ");
      }
      if (!questionContext) {
        const grp = el.closest('[role="radiogroup"],[role="group"],[role="listbox"]');
        if (grp) {
          questionContext = grp.getAttribute("aria-label") || grp.getAttribute("aria-description") || "";
          if (!questionContext) {
            const h = grp.querySelector('h1,h2,h3,h4,h5,h6,[data-automation-id="promptLabel"]');
            if (h) questionContext = h.innerText.trim();
          }
        }
      }
      if (!questionContext) {
        let node = el;
        for (let up = 0; up < 3 && node && !questionContext; up++) {
          node = node.parentElement;
          if (!node) break;
          let prev = node.previousElementSibling;
          for (let back = 0; back < 4 && prev; back++) {
            const t = (prev.innerText || "").trim();
            if (t && t.length > 8 && t.length < 400) { questionContext = t; break; }
            prev = prev.previousElementSibling;
          }
        }
      }
    } catch (e) { /* best effort */ }
    questionContext = (questionContext || "").slice(0, 300);

    let options = [];
    if (el.tagName === "SELECT") {
      options = Array.from(el.options).slice(0, 60).map((o) => o.text.trim());
    }

    out.push({
      index: idx, tag: el.tagName.toLowerCase(), type: el.type || "",
      id: el.id || "", name: el.name || "", placeholder: el.placeholder || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      label: labelText, question: questionContext,
      value: (el.value || "").slice(0, 80),
      readOnly: el.readOnly || false,
      required: el.required || el.getAttribute("aria-required") === "true",
      isCombobox: el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") !== null ||
        (el.parentElement && el.parentElement.getAttribute("role") === "combobox"),
      options
    });
    idx++;
  }
  return out;
}

const fieldByIndex = (i) => deepQueryAll(`[data-cvagent-idx="${i}"]`)[0];

// ===========================================================================
// CUSTOM DROPDOWN ENGINE — robust against:
//   * slow-rendering popups (polls up to ~2.5s instead of a fixed 500ms wait)
//   * type-to-filter comboboxes (types the value, then searches the list)
//   * slight text differences (exact -> startsWith -> contains matching)
//   * two full attempts before giving up
// ===========================================================================
function findOption(value) {
  const v = value.toLowerCase().trim();
  const vis = (list) => list.filter((o) => isVisible(o) && o.innerText.trim());
  const opts = vis(deepQueryAll('[role="option"]'));
  return opts.find((o) => o.innerText.trim().toLowerCase() === v)
      || opts.find((o) => o.innerText.trim().toLowerCase().startsWith(v))
      || vis(deepQueryAll('[role="listbox"] li')).find((o) => o.innerText.trim().toLowerCase().includes(v))
      || vis(deepQueryAll("ul li")).find((o) => o.innerText.trim().toLowerCase() === v)
      || null;
}

async function customPick(el, value) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { el.click(); } catch (e) { /* some need focus first */ }
    for (let i = 0; i < 10; i++) {                    // poll ~2.5s for popup
      await sleep(250);
      const opt = findOption(value);
      if (opt) { opt.click(); await sleep(250); return true; }
    }
    // type-to-search combobox: type the value then look again
    try {
      el.focus();
      setNativeValue(el, value);
    } catch (e) { /* ignore */ }
    await sleep(650);
    const opt = findOption(value);
    if (opt) { opt.click(); await sleep(250); return true; }
  }
  document.activeElement && document.activeElement.blur();
  await sleep(200);
  return false;
}

// ===========================================================================
// FEATURE 04 — captcha / OTP barrier detection
// ===========================================================================
function detectSecurityBarrier() {
  const txt = (document.body ? document.body.innerText : "").slice(0, 5000).toLowerCase();
  if (/captcha|verify you are human|are you a robot|recaptcha|hcaptcha|human verification/.test(txt)) return "captcha";
  if (document.querySelector('iframe[src*="recaptcha"], iframe[title*="captcha" i], iframe[src*="hcaptcha"], iframe[src*="turnstile"]')) return "captcha";
  if (/verification code|one[- ]time (code|password)|enter the otp|رمز التحقق/.test(txt)) return "otp";
  return null;
}

// ===========================================================================
// FEATURE 14 — Vision captcha assist (double-click the pill)
// ===========================================================================
async function visionAssist() {
  try {
    setStatus("asking AI vision for captcha hint...", true);
    const resp = await chrome.runtime.sendMessage({ type: "VISION_ASSIST" });
    setStatus(resp && resp.ok ? "👁 " + resp.hint : "❌ " + ((resp && resp.error) || "vision failed"), false);
    if (resp && resp.ok) alert("CvAgent Vision 🧠:\n" + resp.hint + "\n\n(حلها بإيدك — دي حماية الموقع)");
  } catch (e) { setStatus("vision assist failed", false); }
}

// ===========================================================================
// FEATURE 24 — compliance audit
// ===========================================================================
function complianceScan(fields) {
  const rx = /social security|ssn\b|passport (number|no)|national id|رقم الهوية|religion|الديانة|ethnic|disability|marital status|salary|expected pay|current compensation|bank account/i;
  return fields.filter((f) => rx.test([f.label, f.question, f.ariaLabel, f.name, f.placeholder, f.automationId].join(" ")));
}

// ===========================================================================
// FEATURE 08 — human-like typing
// ===========================================================================
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function humanType(el, value) {
  el.focus();
  setNativeValue(el, "");
  for (const ch of value) {
    let ok = false;
    try { ok = document.execCommand("insertText", false, ch); } catch (e) { ok = false; }
    if (!ok) setNativeValue(el, el.value + ch);
    await sleep(12 + Math.random() * 48);
    if (Math.random() < 0.06) await sleep(90 + Math.random() * 120);
  }
  // safety net: React/workday inputs sometimes swallow the last chars —
  // force the exact final value so the field is never left half-typed.
  if (el.value !== value) setNativeValue(el, value);
  el.blur();
}

// ===========================================================================
// FEATURE 22 — privacy alias (plus-addressing, zero external service)
// ===========================================================================
function aliasEmail(email, siteDomain) {
  if (!email || !email.includes("@")) return email;
  const [user, host] = email.split("@");
  const tag = siteDomain.replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9]/gi, "");
  return `${user}+${tag}@${host}`;
}

// ===========================================================================
// calendar picker
// ===========================================================================
async function tryCalendarPick(el, value) {
  const m = value.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return false;
  const [, mm, dd] = m;
  el.click();
  await sleep(450);
  const cal = deepQueryAll('[role="grid"]:not([hidden]), [class*="calendar" i]:not([hidden]), [class*="datepicker" i]:not([hidden]), .ui-datepicker').find(isVisible);
  if (!cal) return false;
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  for (let guard = 0; guard < 24; guard++) {
    const cells = deepQueryAll('button, [role="gridcell"], td', cal)
      .filter((c) => isVisible(c) && c.innerText.trim() === String(parseInt(dd, 10)));
    const header = cal.querySelector('[class*="month" i], [class*="title" i], [role="heading"]');
    const headerTxt = header ? header.innerText : "";
    const monthOk = headerTxt === "" || headerTxt.includes(monthNames[parseInt(mm, 10) - 1]);
    if (cells.length && monthOk) { cells[0].click(); await sleep(250); return true; }
    const nav = deepQueryAll('button, [class*="prev" i], [class*="next" i]', cal)
      .filter((b) => isVisible(b) && /prev|next|‹|›|<|>/i.test(b.className + " " + b.innerText));
    if (!nav.length) break;
    (guard % 2 === 0 ? nav[nav.length - 1] : nav[0]).click();
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------- dispatcher
async function dispatch(act, siteDomain, aliasMode) {
  const el = fieldByIndex(act.index);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  await sleep(120);
  const kind = (act.action || "").toLowerCase();
  let value = (act.value || "").trim();

  if (kind === "skip") return false;

  if (kind === "fill") {
    if (aliasMode && el.type === "email" && value.includes("@") && !value.includes("+"))
      value = aliasEmail(value, siteDomain);
    const isDate = el.type === "date" || /date/i.test(el.getAttribute("data-automation-id") || "");
    if (isDate && (await tryCalendarPick(el, value))) return true;
    await humanType(el, value);
    return el.value === value;
  }
  if (kind === "select") {                       // native <select>
    const want = value.toLowerCase();
    let done = false;
    for (const opt of el.options) {
      const t = opt.text.trim().toLowerCase();
      if (!t) continue;
      if (t === want || t.includes(want) || want.includes(t)) { el.value = opt.value; done = true; break; }
    }
    if (!done) { el.value = value; done = true; }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done;
  }
  if (kind === "pick") {                          // custom dropdown (Workday etc.)
    return await customPick(el, value);
  }
  if (kind === "check" || kind === "uncheck") {
    const want = kind === "check";
    if (el.checked !== want) el.click();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.checked === want;
  }
  if (kind === "click") {
    if (!el.checked) el.click();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

// ===========================================================================
// FEATURE 10 — learned cross-page mappings
// ===========================================================================
const normKey = (f) =>
  (f.label || f.question || f.ariaLabel || f.name || f.placeholder || f.id || "")
    .toLowerCase().replace(/\s+/g, " ").trim().slice(0, 90);

async function applyLearned(fields) {
  const domain = location.hostname;
  const { learned = {} } = await chrome.storage.local.get("learned");
  const map = learned[domain] || {};
  const pre = [];
  for (const f of fields) {
    const key = normKey(f);
    if (map[key] && !f.value) pre.push({ index: f.index, action: "fill", value: map[key] });
  }
  return pre;
}

// ===========================================================================
// FEATURE 25 — offline deterministic engine
// ===========================================================================
function offlineMap(fields) {
  return new Promise((resolve) => {
    chrome.storage.local.get("profile", async ({ profile }) => {
      const p = profile || (await chrome.runtime.sendMessage({ type: "GET_PLAIN_PROFILE" }).catch(() => ({}))) || {};
      // Arabic rules FIRST (more specific), then English
      const rules = [
        { rx: /الاسم الأول|الاسم الاول|الاسم الشخصي/i,            val: p.first_name },
        { rx: /الاسم الأخير|الاسم الاخير|اسم العائلة|اسم العائله/i, val: p.last_name },
        { rx: /الاسم بالعربية|الاسم بالعربي|الاسم رباعي|الاسم الكامل|^الاسم$/i, val: p.arabic_name },
        { rx: /الاسم بالإنجليزية|الاسم بالانجليزي|full name|legal name/i, val: p.full_name },
        { rx: /first name/i,                                       val: p.first_name },
        { rx: /(middle name)/i,                                    val: p.middle_name },
        { rx: /(last|family|sur)name/i,                            val: p.last_name },
        { rx: /البريد الإلكتروني|البريد الالكتروني|الايميل|الإيميل/i, val: p.email },
        { rx: /e-?mail/i,                                          val: p.email },
        { rx: /الجوال|الهاتف المحمول|الموبايل|رقم الجوال|رقم الهاتف|هاتفك/i, val: p.phone_ksa },
        { rx: /phone|mobile|cell|whatsapp/i,                       val: p.phone_ksa },
        { rx: /المدينة/i,                                          val: p.current_location?.city },
        { rx: /city/i,                                             val: p.current_location?.city },
        { rx: /الحي|المنطقة|المحافظة/i,                            val: p.current_location?.province_state },
        { rx: /province|state/i,                                   val: p.current_location?.province_state },
        { rx: /الدولة|البلد/i,                                     val: p.current_location?.country },
        { rx: /country/i,                                          val: p.current_location?.country },
        { rx: /الرمز البريدي/i,                                    val: p.current_location?.postal_code },
        { rx: /postal|zip/i,                                       val: p.current_location?.postal_code },
        { rx: /العنوان/i,                                          val: p.current_location?.full_address },
        { rx: /linkedin/i,                                         val: p.links?.linkedin },
        { rx: /سنوات.*(خبرة|الخبرة)|years.*(experience|work)/i,    val: "20" },
        { rx: /تاريخ الميلاد|تاريخ الميلاذ/i,                      val: p.date_of_birth },
        { rx: /date of birth|birth date|dob/i,                     val: p.date_of_birth },
        { rx: /الجنسية/i,                                          val: p.nationality },
        { rx: /nationality/i,                                      val: p.nationality },
        { rx: /رقم الهوية|رقم الاقامة|رقم الإقامة/i,               val: p.ids?.iqama_number },
        { rx: /(iqama|residency|residence) (number|no|id)/i,       val: p.ids?.iqama_number },
        { rx: /الهيئة السعودية|رقم العضوية/i,                      val: p.ids?.saudi_council_of_engineers },
        { rx: /saudi council|sce\b/i,                              val: p.ids?.saudi_council_of_engineers }
      ];
      const boolRules = [
        { rx: /legally authorized|authorized to work|مفوض بالعمل|المصرح لهم بالعمل|مصرح/i, val: p.booleans?.legally_authorized_to_work },
        { rx: /willing to relocate|relocat|الاستعداد للانتقال|الانتقال/i, val: p.booleans?.willing_to_relocate },
        { rx: /willing to travel|travel|السفر|التنقل/i,         val: p.booleans?.willing_to_travel },
        { rx: /currently employed|موظف حالياً|موظف حاليا/i,     val: p.booleans?.currently_employed },
        { rx: /over (the age of )?18|18 years|أكثر من 18|اكثر من 18/i, val: p.booleans?.over_18 },
        { rx: /terms|privacy policy|consent|agree|الموافقة|الموافقه|الشروط|سياسة الخصوصية|أوافق|اوافق/i, val: p.booleans?.agreed_to_terms }
      ];
      const YES = /^(y(es)?|نعم|موافق|اجل)$/i;
      const NO  = /^(n(o)?|لا|لا أوافق|لا اوافق)$/i;
      const actions = [];
      for (const f of fields) {
        const hay = [f.label, f.question, f.ariaLabel, f.name, f.placeholder, f.id, f.automationId].join(" ");
        if (!hay.trim() || f.value) continue;
        let matched = false;
        for (const r of rules) {
          if (r.rx.test(hay) && r.val) { actions.push({ index: f.index, action: "fill", value: String(r.val) }); matched = true; break; }
        }
        if (matched) continue;
        for (const b of boolRules) {
          if (b.rx.test(hay) && typeof b.val === "boolean") {
            if (f.type === "checkbox") actions.push({ index: f.index, action: b.val ? "check" : "uncheck" });
            else if (f.type === "radio") {
              const label = (f.label || "").trim();
              if ((b.val && YES.test(label)) || (!b.val && NO.test(label)))
                actions.push({ index: f.index, action: "click" });
            }
            break;
          }
        }
      }
      resolve(actions);
    });
  });
}

// ===========================================================================
// Deterministic YES/NO post-pass — guarantees نعم/لا radio groups get answered
// even if the LLM hesitates. Truthful answers only, from profile.booleans.
// ===========================================================================
async function yesNoPostPass(fields, attempted) {
  const resp = await chrome.runtime.sendMessage({ type: "GET_PLAIN_PROFILE" }).catch(() => null);
  const p = (resp && resp.profile) || {};
  if (!p.booleans) return 0;
  const boolRules = [
    { rx: /legally authorized|authorized to work|مفوض بالعمل|المصرح لهم بالعمل|مصرح/i, val: p.booleans.legally_authorized_to_work },
    { rx: /willing to relocate|relocat|الاستعداد للانتقال|الانتقال/i, val: p.booleans.willing_to_relocate },
    { rx: /willing to travel|travel|السفر|التنقل/i,         val: p.booleans.willing_to_travel },
    { rx: /currently employed|موظف حالياً|موظف حاليا/i,     val: p.booleans.currently_employed },
    { rx: /over (the age of )?18|18 years|أكثر من 18|اكثر من 18/i, val: p.booleans.over_18 },
    { rx: /terms|privacy policy|consent|agree|الموافقة|الموافقه|الشروط|سياسة الخصوصية|أوافق|اوافق/i, val: p.booleans.agreed_to_terms }
  ];
  const YES = /^(y(es)?|نعم|موافق|اجل)$/i;
  const NO  = /^(n(o)?|لا|لا أوافق|لا اوافق)$/i;
  let clicks = 0;
  for (const f of fields) {
    if (f.type !== "radio" || attempted.has(f.index)) continue;
    const label = (f.label || "").trim();
    if (!YES.test(label) && !NO.test(label)) continue;
    const q = f.question || f.label || "";
    if (!q) continue;
    for (const b of boolRules) {
      if (b.rx.test(q) && typeof b.val === "boolean") {
        const shouldClick = (b.val && YES.test(label)) || (!b.val && NO.test(label));
        if (shouldClick) {
          try {
            const el = fieldByIndex(f.index);
            if (el && !el.checked) el.click();
            el && el.dispatchEvent(new Event("change", { bubbles: true }));
            clicks++;
          } catch (e) { /* keep going */ }
        }
        break;
      }
    }
  }
  return clicks;
}

// ---------------------------------------------------------------- flow
function detectFlow() {
  const rxSubmit = /^(submit|apply|تقديم|تقديم الطلب|إرسال)$/i;
  for (const b of deepQueryAll('button, a[role="button"], input[type="submit"]')) {
    if (!isVisible(b)) continue;
    const t = (b.innerText || b.value || "").trim();
    if (rxSubmit.test(t) || /submitbutton/i.test(b.getAttribute("data-automation-id") || "")) return "submit";
  }
  return null;
}

function clickNext() {
  const rxNext = /^(next|continue|متابعة|التالي)$/i;
  for (const b of deepQueryAll('button, a[role="button"], input[type="submit"]')) {
    if (!isVisible(b)) continue;
    const t = (b.innerText || b.value || "").trim();
    if (rxNext.test(t) || /nextbutton/i.test(b.getAttribute("data-automation-id") || "")) { b.click(); return true; }
  }
  return false;
}

// ===========================================================================
// FEATURE 28 — snapshot archive (PNG of final state)
// ===========================================================================
async function snapshotPage() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SNAPSHOT" });
    if (resp && resp.ok) {
      const a = document.createElement("a");
      a.href = resp.dataUrl;
      a.download = `cvagent_snapshot_${Date.now()}.png`;
      a.click();
      setStatus("📸 snapshot saved", false);
    }
  } catch (e) { setStatus("snapshot failed", false); }
}

// ---------------------------------------------------------------- main flow
async function runAgent() {
  if (RUNNING) return;
  RUNNING = true;
  try {
    const barrier = detectSecurityBarrier();
    if (barrier) {
      setStatus(`🛡 ${barrier} — solve it (dbl-click me for AI hint), then press again`, false);
      return;
    }

    setStatus("extracting fields...", true);
    const fields = extractFields();
    if (!fields.length) { setStatus("no fields found on this page", false); return; }

    const flagged = complianceScan(fields);
    if (flagged.length)
      console.warn("[CvAgent] ⚠ sensitive fields — review before submitting:", flagged.map((f) => f.label || f.name || f.id));

    // ---- F10: learned mappings first (instant, zero tokens) --------------
    setStatus("applying learned mappings...", true);
    const pre = await applyLearned(fields);
    let ok = 0;
    const preFilled = new Set();
    for (const act of pre) {
      try { if (await dispatch(act, location.hostname, false)) { ok++; preFilled.add(act.index); } }
      catch (e) { console.warn(e); }
    }
    const remainingFields = fields.filter((f) => !preFilled.has(f.index) && !f.value);

    // ---- LLM (or offline) -------------------------------------------------
    let actions = [];
    if (remainingFields.length) {
      setStatus(`asking AI (${remainingFields.length} left)...`, true);
      let llmOk = false;
      try {
        const resp = await chrome.runtime.sendMessage({ type: "GET_ACTIONS", fields: remainingFields });
        if (resp && resp.ok) { actions = resp.actions; llmOk = true; }
        else console.warn("[CvAgent] LLM:", resp && resp.error);
      } catch (e) { console.warn(e); }
      if (!llmOk) { actions = await offlineMap(remainingFields); setStatus("offline engine...", true); }
    }

    const st = await chrome.storage.local.get(["aliasMode", "autoNext"]);
    const attempted = new Set(
      [...pre, ...actions].filter((a) => (a.action || "").toLowerCase() !== "skip").map((a) => a.index)
    );
    for (const act of actions) {
      try { if (await dispatch(act, location.hostname, !!st.aliasMode)) ok++; }
      catch (e) { console.warn("[CvAgent] action failed, continuing:", e); }
    }

    // ------------------------------------------------------------------
    // MANDATORY second pass: identity fields (name/email/phone/city/dob/IDs)
    // must NEVER stay empty. Re-ask the LLM in STRICT MODE for whatever the
    // first pass missed (Arabic labels included).
    // ------------------------------------------------------------------
    const identityRx = /first|middle|last|full|legal|name|اسم|بريد|e-?mail|phone|mobile|جوال|هاتف|موبايل|city|مدينة|country|دولة|الجنسية|nationality|postal|الرمز البريدي|date of birth|dob|تاريخ الميلاد|iqama|إقامة|الاقامة|الهيئة|sce/i;
    const stillEmpty = fields.filter((f) =>
      !attempted.has(f.index) && !f.value &&
      f.type !== "checkbox" && f.type !== "radio" && f.type !== "file" &&
      identityRx.test([f.label, f.question, f.name, f.id, f.placeholder, f.ariaLabel, f.automationId].join(" "))
    );
    if (stillEmpty.length) {
      setStatus(`retrying ${stillEmpty.length} mandatory field(s) in STRICT mode...`, true);
      try {
        const r2 = await chrome.runtime.sendMessage({ type: "GET_ACTIONS", fields: stillEmpty, strict: true });
        if (r2 && r2.ok) {
          for (const act of r2.actions) {
            try { if (await dispatch(act, location.hostname, !!st.aliasMode)) ok++; }
            catch (e) { console.warn(e); }
          }
        }
      } catch (e) { console.warn("[CvAgent] strict pass failed:", e); }
    }

    // ------------------------------------------------------------------
    // Deterministic نعم/لا post-pass — never leave yes/no groups unanswered
    // ------------------------------------------------------------------
    const yn = await yesNoPostPass(fields, attempted);
    if (yn) { ok += yn; console.log("[CvAgent] yes/no post-pass clicked", yn); }

    console.log("[CvAgent] report:", { pre: pre.length, llm: actions.length, ok, sniffed: sniffedEndpoints.length });

    if (ok >= 3 && actions.length)
      chrome.runtime.sendMessage({ type: "SAVE_BLUEPRINT", signature: location.hostname, fix: `auto-learned ${ok} fields` }).catch(() => {});

    if (detectFlow() === "submit") {
      chrome.runtime.sendMessage({
        type: "TRACK",
        data: {
          title: document.title.slice(0, 120), url: location.href.slice(0, 180),
          date: new Date().toISOString().slice(0, 16).replace("T", " "),
          filled: `${ok}/${pre.length + actions.length}`, sensitive: flagged.length
        }
      }).catch(() => {});
      addSnapshotButton();
      setStatus(`✅ DONE — ${ok} filled${flagged.length ? ` · ⚠ ${flagged.length} sensitive` : ""} — review & Submit yourself 🎉`, false);
      alert("CvAgent: الصفحة اتملى ✅\n"
        + `اتملأ ${ok} خانة\n`
        + (flagged.length ? `⚠ انتبه: ${flagged.length} خانة حساسة (${flagged.slice(0, 3).map((f) => f.label || f.name).join(", ")})\n` : "")
        + "راجع بياناتك واضغط Submit بنفسك.");
      return;
    }
    if (st.autoNext && clickNext()) setStatus("clicked Next — press me again 🤖", false);
    else setStatus(`filled ${ok} — click Next, then me again`, false);
  } finally {
    RUNNING = false;
  }
}

function addSnapshotButton() {
  if (document.getElementById("cvagent-snap")) return;
  const b = document.createElement("div");
  b.id = "cvagent-snap";
  b.textContent = "📸 Archive";
  b.style.cssText = "position:fixed;bottom:58px;right:18px;z-index:2147483647;background:#E87722;color:#fff;padding:7px 13px;border-radius:20px;font:600 12px 'Segoe UI';cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3)";
  b.addEventListener("click", snapshotPage);
  document.documentElement.appendChild(b);
}

// ===========================================================================
// FEATURE 30 — Ambient Voice-To-Form (Web Speech API, local + refinement)
// ===========================================================================
let micBtn = null, recognition = null;

function refineSpeech(text) {
  let t = text.trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!؟?]$/.test(t)) t += /[؟?]/.test(t) ? "" : ".";
  t = t.replace(/\s+/g, " ");
  return t;
}

function showMic() {
  const st = chrome.storage.local.get("agentOn").then(({ agentOn }) => {
    const active = document.activeElement;
    const isText = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /text|search|email|url|tel/i.test(active.type)));
    if (!agentOn || !isText) { hideMic(); return; }
    if (micBtn) return;
    micBtn = document.createElement("div");
    micBtn.textContent = "🎤";
    micBtn.title = "CvAgent voice-to-form — click & speak";
    micBtn.style.cssText = "position:fixed;bottom:100px;right:18px;z-index:2147483647;background:#27ae60;color:#fff;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)";
    micBtn.addEventListener("click", startDictation);
    document.documentElement.appendChild(micBtn);
  });
}

function hideMic() { if (micBtn) { micBtn.remove(); micBtn = null; } }

function startDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus("voice not supported in this browser", false); return; }
  if (recognition) { recognition.stop(); return; }
  const active = document.activeElement;
  const q = (active && (active.getAttribute("aria-label") || active.placeholder || "")) || document.body.innerText.slice(0, 200);
  const lang = /[\u0600-\u06FF]/.test(q) ? "ar-SA" : "en-US";

  recognition = new SR();
  recognition.lang = lang;
  recognition.interimResults = false;
  micBtn && (micBtn.style.background = "#c0392b");
  setStatus("🎙 listening...", true);
  recognition.onresult = async (e) => {
    const raw = e.results[0][0].transcript;
    const text = refineSpeech(raw);
    if (document.activeElement) await humanType(document.activeElement, text);
    setStatus("🎙 → \"" + text.slice(0, 40) + "\"", false);
  };
  recognition.onerror = (e) => setStatus("🎙 error: " + e.error, false);
  recognition.onend = () => { recognition = null; if (micBtn) micBtn.style.background = "#27ae60"; };
  recognition.start();
}

document.addEventListener("focusin", showMic);
document.addEventListener("focusout", () => setTimeout(hideMic, 300));

// ------------------------------------------------------------------ state
async function applyState() {
  const st = await chrome.storage.local.get("agentOn");
  if (st.agentOn) ensurePill(); else { removePill(); hideMic(); }
}

// ===========================================================================
// ZERO-EFFORT MODE — auto-fill the moment an application form is detected
// (only when ON + autoRun enabled; runs once per page; conservative checks
// so it never fires on random websites)
// ===========================================================================
async function maybeAutoRun() {
  try {
    const st = await chrome.storage.local.get(["agentOn", "autoRun"]);
    if (!st.agentOn || !st.autoRun) return;
    if (sessionStorage.getItem("cvagentAutoran")) return;
    if (RUNNING) return;

    const fields = extractFields();
    if (fields.length < 3) return;                       // too small to be an application

    const textish = fields.filter((f) =>
      f.tag === "textarea" || ["text", "email", "tel", "url", ""].includes(f.type)).length;
    if (textish < 2) return;                             // mostly checkboxes/radios only

    const identity = fields.some((f) =>
      /name|email|phone|mobile|first|last|city|country/i.test(
        [f.label, f.name, f.id, f.placeholder, f.ariaLabel].join(" ")));
    const jobUrl = /apply|job|career|candidate|application|workday|myworkday|greenhouse|lever|taleo|bamboohr|recruit|وظائف|توظيف|تقديم/i
      .test(location.href + " " + document.title);

    if (!identity && !jobUrl) return;                    // random site — hands off

    sessionStorage.setItem("cvagentAutoran", "1");
    setStatus("auto-detected application — filling...", true);
    setTimeout(() => runAgent(), 1200);
  } catch (e) { /* never break the page */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "STATE") applyState();
  if (msg.type === "RUN_NOW") runAgent();
  if (msg.type === "GET_JD") {
    // page text for scoring / tailoring / cover letters (trimmed)
    const text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").slice(0, 8000);
    sendResponse({ ok: true, text, title: document.title });
  }
});

applyState();
maybeAutoRun();
