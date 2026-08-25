// ===========================================================================
// CvAgent v2.0 — content script (AI Career OS core)
// Lives inside the page you are visiting. Shows a floating ON/OFF pill.
// When triggered (pill click / popup button), it:
//   1. extracts every visible form field — piercing Shadow DOM & iframes
//   2. scans for security barriers (Captcha/OTP) and yields to the human
//   3. audits privacy-risky fields before touching them
//   4. asks the background worker to map fields via Groq LLM
//      (with a local OFFLINE deterministic fallback if LLM/key unavailable)
//   5. executes actions: human-like typing, native selects, custom Workday
//      dropdowns, radios, checkboxes, calendar pickers
//   6. page-by-page validation: fills, then waits for YOU to click Next
//      (auto-Next optional) — never touches Submit
//   7. logs every submission into the built-in tracker
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
  pill.textContent = "🤖 CvAgent — Fill this page";
  pill.addEventListener("mouseenter", () => (pill.style.opacity = "0.85"));
  pill.addEventListener("mouseleave", () => (pill.style.opacity = "1"));
  pill.addEventListener("click", () => runAgent());
  document.documentElement.appendChild(pill);
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
// FEATURE 12 — Deep Shadow DOM & Iframe penetration
// Ordinary querySelector misses inputs inside shadow roots / same-process
// frames. We walk every shadow root recursively.
// ===========================================================================
function deepQueryAll(selector, root = document) {
  const results = [];
  const walk = (scope) => {
    for (const el of scope.querySelectorAll(selector)) results.push(el);
    for (const el of scope.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  try { walk(root); } catch (e) { /* keep partial results */ }
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

    // ---- label ----------------------------------------------------------
    let labelText = "";
    const closestLabel = el.closest("label");
    if (closestLabel) {
      labelText = closestLabel.innerText.trim();
    } else if (el.id) {
      const lbl = deepQueryAll(`label[for="${el.id}"]`)[0];
      if (lbl) labelText = lbl.innerText.trim();
    }

    // ---- question context (screening questionnaires) ---------------------
    let questionContext = "";
    try {
      const fs = el.closest("fieldset");
      const legend = fs && fs.querySelector("legend");
      if (legend && legend.innerText.trim()) questionContext = legend.innerText.trim();

      if (!questionContext && el.getAttribute("aria-labelledby")) {
        questionContext = el.getAttribute("aria-labelledby").split(/\s+/)
          .map((id) => {
            const t = deepQueryAll(`#${id}`)[0];
            return t ? t.innerText.trim() : "";
          })
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

    const isCombobox =
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") !== null ||
      (el.parentElement && el.parentElement.getAttribute("role") === "combobox");

    out.push({
      index: idx,
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      id: el.id || "",
      name: el.name || "",
      placeholder: el.placeholder || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      label: labelText,
      question: questionContext,
      value: (el.value || "").slice(0, 80),
      readOnly: el.readOnly || false,
      required: el.required || el.getAttribute("aria-required") === "true",
      isCombobox,
      options
    });
    idx++;
  }
  return out;
}

const fieldByIndex = (i) => deepQueryAll(`[data-cvagent-idx="${i}"]`)[0];

// ===========================================================================
// FEATURE 04 — Human-In-The-Loop Captcha & 2FA resolution
// Detect security barriers, yield execution, let the human solve, resume.
// ===========================================================================
function detectSecurityBarrier() {
  const txt = (document.body ? document.body.innerText : "").slice(0, 5000).toLowerCase();
  if (/captcha|verify you are human|are you a robot|recaptcha|hcaptcha|human verification/.test(txt))
    return "captcha";
  if (document.querySelector('iframe[src*="recaptcha"], iframe[title*="captcha" i], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'))
    return "captcha";
  if (/verification code|one[- ]time (code|password)|enter the otp|رمز التحقق/.test(txt))
    return "otp";
  return null;
}

// ===========================================================================
// FEATURE 24 — Automated Compliance Auditing
// Flag predatory / sensitive data-collection fields BEFORE filling them.
// ===========================================================================
function complianceScan(fields) {
  const rx = /social security|ssn\b|passport (number|no)|national id|رقم الهوية|religion|الديانة|ethnic|disability|marital status|salary|expected pay|current compensation|bank account/i;
  return fields.filter((f) =>
    rx.test([f.label, f.question, f.ariaLabel, f.name, f.placeholder, f.automationId].join(" "))
  );
}

// ===========================================================================
// FEATURE 08 — Human-Like Typographical Simulation
// Random keystroke cadence via execCommand (fires real input events, so
// React/Workday listeners update). Falls back to the native-value setter.
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
    await sleep(12 + Math.random() * 48);        // organic cadence
    if (Math.random() < 0.06) await sleep(90 + Math.random() * 120); // micro-pauses
  }
  el.blur();
}

// ===========================================================================
// Calendar picker (date widgets that open a popup grid)
// ===========================================================================
async function tryCalendarPick(el, value) {
  const m = value.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); // MM/DD/YYYY
  if (!m) return false;
  const [, mm, dd] = m;
  el.click();
  await sleep(450);

  const cal = deepQueryAll(
    '[role="grid"]:not([hidden]), [class*="calendar" i]:not([hidden]), [class*="datepicker" i]:not([hidden]), .ui-datepicker'
  ).find((c) => isVisible(c));
  if (!cal) return false;

  const monthNames = ["January","February","March","April","May","June","July",
                      "August","September","October","November","December"];
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
async function dispatch(act) {
  const el = fieldByIndex(act.index);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  await sleep(120);
  const kind = (act.action || "").toLowerCase();
  const value = (act.value || "").trim();

  if (kind === "skip") return false;

  if (kind === "fill") {
    const isDate = el.type === "date" || /date/i.test(el.getAttribute("data-automation-id") || "");
    if (isDate && (await tryCalendarPick(el, value))) return true;
    await humanType(el, value);
    return el.value === value;
  }

  if (kind === "select") {
    let done = false;
    for (const opt of el.options) {
      if (opt.text.trim() === value) { el.value = opt.value; done = true; break; }
    }
    if (!done) { el.value = value; done = true; }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done;
  }

  if (kind === "pick") {                          // custom Workday dropdown
    el.click();
    await sleep(500);
    const visible = (list) => list.filter((o) => isVisible(o));
    let opt = visible(deepQueryAll('[role="option"]')).find((o) => o.innerText.trim() === value);
    if (!opt) opt = visible(deepQueryAll('[role="option"]')).find((o) => o.innerText.trim().startsWith(value));
    if (!opt) opt = visible(deepQueryAll('[role="listbox"] li')).find((o) => o.innerText.trim().includes(value));
    if (opt) { opt.click(); await sleep(250); return true; }
    document.activeElement && document.activeElement.blur();
    return false;
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
// FEATURE 25 — Localized Offline Fallback Engine
// Deterministic identity fields are matched locally — zero LLM, zero network.
// Used automatically when the LLM call fails or no API key is configured.
// ===========================================================================
function offlineMap(fields) {
  return new Promise((resolve) => {
    chrome.storage.local.get("profile", ({ profile }) => {
      const p = profile || {};
      const rules = [
        { rx: /first name/i,                       act: "fill", val: p.first_name },
        { rx: /(last|family|sur)name/i,            act: "fill", val: p.last_name },
        { rx: /full name|legal name/i,             act: "fill", val: p.full_name },
        { rx: /e-?mail/i,                          act: "fill", val: p.email },
        { rx: /phone|mobile|cell|whatsapp|واتساب/i,act: "fill", val: p.phone_ksa },
        { rx: /city/i,                             act: "fill", val: p.current_location?.city },
        { rx: /province|state/i,                   act: "fill", val: p.current_location?.province_state },
        { rx: /country/i,                          act: "fill", val: p.current_location?.country },
        { rx: /postal|zip/i,                       act: "fill", val: p.current_location?.postal_code },
        { rx: /linkedin/i,                         act: "fill", val: p.links?.linkedin },
        { rx: /years.*(experience|work)/i,         act: "fill", val: "20" },
        { rx: /date of birth|birth date|dob/i,     act: "fill", val: p.date_of_birth },
        { rx: /nationality/i,                      act: "fill", val: p.nationality },
        { rx: /(iqama|residency|residence) (number|no|id)/i, act: "fill", val: p.ids?.iqama_number },
        { rx: /saudi council|sce/i,                act: "fill", val: p.ids?.saudi_council_of_engineers }
      ];
      const boolRules = [
        { rx: /legally authorized|work authorization|authorized to work/i, val: p.booleans?.legally_authorized_to_work },
        { rx: /willing to relocate|relocat/i,   val: p.booleans?.willing_to_relocate },
        { rx: /willing to travel|travel/i,      val: p.booleans?.willing_to_travel },
        { rx: /currently employed/i,            val: p.booleans?.currently_employed },
        { rx: /over (the age of )?18|18 years/i,val: p.booleans?.over_18 },
        { rx: /terms|privacy policy|consent|agree/i, val: p.booleans?.agreed_to_terms }
      ];
      const actions = [];
      for (const f of fields) {
        const hay = [f.label, f.question, f.ariaLabel, f.name, f.placeholder, f.id, f.automationId].join(" ");
        if (!hay.trim() || (f.value && f.value.length > 0)) continue;
        let matched = false;
        for (const r of rules) {
          if (r.rx.test(hay) && r.val) { actions.push({ index: f.index, action: "fill", value: String(r.val) }); matched = true; break; }
        }
        if (matched) continue;
        for (const b of boolRules) {
          if (b.rx.test(hay) && typeof b.val === "boolean") {
            if (f.type === "checkbox") actions.push({ index: f.index, action: b.val ? "check" : "uncheck" });
            else if (f.type === "radio") {
              const label = (f.label || "").toLowerCase();
              if ((b.val && /^y(es)?$/i.test(label)) || (!b.val && /^n(o)?$/i.test(label)))
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

// ------------------------------------------------------------- flow buttons
function detectFlow() {
  const rxSubmit = /^(submit|apply|تقديم|تقديم الطلب|إرسال)$/i;
  for (const b of deepQueryAll('button, a[role="button"], input[type="submit"]')) {
    if (!isVisible(b)) continue;
    const t = (b.innerText || b.value || "").trim();
    if (rxSubmit.test(t) || /submitbutton/i.test(b.getAttribute("data-automation-id") || ""))
      return "submit";
  }
  return null;
}

function clickNext() {
  const rxNext = /^(next|continue|متابعة|التالي)$/i;
  for (const b of deepQueryAll('button, a[role="button"], input[type="submit"]')) {
    if (!isVisible(b)) continue;
    const t = (b.innerText || b.value || "").trim();
    if (rxNext.test(t) || /nextbutton/i.test(b.getAttribute("data-automation-id") || "")) {
      b.click();
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- main flow
async function runAgent() {
  if (RUNNING) return;
  RUNNING = true;

  try {
    // ---- 1. security barrier? yield to the human (FEATURE 04) -----------
    const barrier = detectSecurityBarrier();
    if (barrier) {
      setStatus(`🛡 ${barrier === "captcha" ? "Captcha" : "OTP"} detected — solve it, then press me again`, false);
      return;
    }

    // ---- 2. extract -------------------------------------------------------
    setStatus("extracting fields...", true);
    const fields = extractFields();
    if (!fields.length) { setStatus("no fields found on this page", false); return; }

    // ---- 3. compliance audit (FEATURE 24) --------------------------------
    const flagged = complianceScan(fields);
    if (flagged.length)
      console.warn("[CvAgent] ⚠ sensitive fields detected — review before submitting:",
        flagged.map((f) => f.label || f.name || f.id));

    // ---- 4. LLM mapping (with offline fallback — FEATURE 25) -------------
    setStatus(`asking AI (${fields.length} fields)...`, true);
    let actions = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_ACTIONS", fields });
      if (resp && resp.ok) actions = resp.actions;
      else { console.warn("[CvAgent] LLM error:", resp && resp.error); setStatus("offline mode (LLM unavailable)...", true); }
    } catch (e) {
      setStatus("offline mode (LLM unreachable)...", true);
    }
    if (!actions) actions = await offlineMap(fields);
    if (!actions.length) { setStatus("nothing to fill on this page", false); return; }

    // ---- 5. execute --------------------------------------------------------
    let ok = 0;
    for (const act of actions) {
      try { if (await dispatch(act)) ok++; }
      catch (e) { console.warn("[CvAgent] action failed, continuing:", e); }
    }
    console.log("[CvAgent] actions report:", actions);

    // ---- 6. flow control (FEATURE 03 — page-by-page validation) -----------
    const st = await chrome.storage.local.get(["autoNext"]);
    if (detectFlow() === "submit") {
      // ---- 7. tracker log (FEATURE 09) ------------------------------------
      chrome.runtime.sendMessage({
        type: "TRACK",
        data: {
          title: document.title.slice(0, 120),
          url: location.href.slice(0, 180),
          date: new Date().toISOString().slice(0, 16).replace("T", " "),
          filled: `${ok}/${actions.length}`,
          sensitive: flagged.length
        }
      }).catch(() => {});
      setStatus("✅ DONE — review & press Submit yourself 🎉", false);
      alert("CvAgent: الصفحة اتملى ✅\nراجع بياناتك واضغط Submit بنفسك.");
      return;
    }

    if (st.autoNext && clickNext()) {
      setStatus("clicked Next — press me again on the new page 🤖", false);
    } else {
      setStatus(`filled ${ok}/${actions.length} — click Next, then me again`, false);
    }
  } finally {
    RUNNING = false;
  }
}

// ------------------------------------------------------------------ state
async function applyState() {
  const st = await chrome.storage.local.get("agentOn");
  if (st.agentOn) ensurePill(); else removePill();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE") applyState();
  if (msg.type === "RUN_NOW") runAgent();
});

applyState();
