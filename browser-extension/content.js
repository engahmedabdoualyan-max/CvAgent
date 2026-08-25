// ===========================================================================
// CvAgent — content script
// Lives inside the page you are visiting. Shows a floating ON/OFF pill.
// When triggered (pill click / popup button), it:
//   1. extracts every visible form field (+ question context for quizzes)
//   2. asks the background service worker to map them via Groq LLM
//   3. executes the actions: fill (framework-safe), native select,
//      custom Workday dropdowns, radios, checkboxes, calendar pickers
//   4. detects Next/Submit — auto-clicks Next, STOPS at Submit for review
// ===========================================================================

let RUNNING = false;

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
  pill.addEventListener("mouseenter", () => pill.style.opacity = "0.85");
  pill.addEventListener("mouseleave", () => pill.style.opacity = "1");
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

// ---------------------------------------------------------------- extraction
function extractFields() {
  const nodes = document.querySelectorAll("input, textarea, select");
  const out = [];
  let idx = 0;

  for (const el of nodes) {
    if (el.offsetParent === null && el.type !== "hidden") continue;
    if (el.type === "hidden") continue;

    el.setAttribute("data-cvagent-idx", String(idx));

    // ---- label ----------------------------------------------------------
    let labelText = "";
    const closestLabel = el.closest("label");
    if (closestLabel) {
      labelText = closestLabel.innerText.trim();
    } else if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) labelText = lbl.innerText.trim();
    }

    // ---- question context (fieldset legend / ARIA groups / headings) ----
    let questionContext = "";
    try {
      const fs = el.closest("fieldset");
      const legend = fs && fs.querySelector("legend");
      if (legend && legend.innerText.trim()) questionContext = legend.innerText.trim();

      if (!questionContext && el.getAttribute("aria-labelledby")) {
        questionContext = el.getAttribute("aria-labelledby").split(/\s+/)
          .map(id => { const t = document.getElementById(id); return t ? t.innerText.trim() : ""; })
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

    // ---- options (native select) ----------------------------------------
    let options = [];
    if (el.tagName === "SELECT") {
      options = Array.from(el.options).slice(0, 60).map(o => o.text.trim());
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

const fieldByIndex = (i) => document.querySelector(`[data-cvagent-idx="${i}"]`);

// ------------------------------------------------- framework-safe utilities
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------- calendar picker
// For date fields whose click opens a calendar popup: navigate to the right
// month and click the matching day cell. Falls back silently to typing.
async function tryCalendarPick(el, value) {
  const m = value.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); // MM/DD/YYYY
  if (!m) return false;
  const [, mm, dd] = m;
  el.click();
  await sleep(450);

  // generic calendar detection
  const cal = document.querySelector(
    '[role="grid"]:not([hidden]), [class*="calendar" i]:not([hidden]), [class*="datepicker" i]:not([hidden]), .ui-datepicker');
  if (!cal || cal.offsetParent === null) return false;

  for (let guard = 0; guard < 24; guard++) {
    // is the target day visible AND inside the correct month?
    const cells = Array.from(cal.querySelectorAll('button, [role="gridcell"], td'))
      .filter(c => c.offsetParent !== null && c.innerText.trim() === String(parseInt(dd, 10)));
    const header = cal.querySelector('[class*="month" i], [class*="title" i], [role="heading"]');
    const headerTxt = header ? header.innerText : "";
    const monthOk = headerTxt === "" || headerTxt.includes(["January","February","March","April","May","June","July","August","September","October","November","December"][parseInt(mm,10)-1]);

    if (cells.length && monthOk) { cells[0].click(); await sleep(250); return true; }

    // navigate months: compare first day-of-week cell number as heuristic
    const nav = monthOk ? null :
      Array.from(cal.querySelectorAll('button, [class*="prev" i], [class*="next" i], [class*="arrow" i]'))
        .filter(b => b.offsetParent !== null && /prev|next|‹|›|<|>/i.test((b.className + " " + b.innerText)));
    if (!nav || !nav.length) break;
    // choose direction by trying "next" then "prev" alternately (best effort)
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
    el.focus();
    const isDate = el.type === "date" || /date/i.test(el.getAttribute("data-automation-id") || "");
    if (isDate && await tryCalendarPick(el, value)) return true;
    setNativeValue(el, value);
    el.blur();
    return el.value === value;
  }

  if (kind === "select") {                       // native <select>
    let done = false;
    for (const opt of el.options) {
      if (opt.text.trim() === value) { el.value = opt.value; done = true; break; }
    }
    if (!done) { el.value = value; done = true; } // fallback: option value
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done;
  }

  if (kind === "pick") {                         // custom Workday dropdown
    el.click();
    await sleep(500);
    let opt = Array.from(document.querySelectorAll('[role="option"]'))
      .find(o => o.offsetParent !== null && o.innerText.trim() === value);
    if (!opt) opt = Array.from(document.querySelectorAll('[role="option"]'))
      .find(o => o.offsetParent !== null && o.innerText.trim().startsWith(value));
    if (!opt) opt = Array.from(document.querySelectorAll('[role="listbox"] li'))
      .find(o => o.offsetParent !== null && o.innerText.trim().includes(value));
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

  if (kind === "click") {                        // radio
    if (!el.checked) el.click();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

// ------------------------------------------------------------- flow buttons
function detectFlow() {
  const rxSubmit = /^(submit|apply|تقديم|تقديم الطلب|إرسال)$/i;
  const nodes = document.querySelectorAll('button, a[role="button"], input[type="submit"]');
  for (const b of nodes) {
    if (b.offsetParent === null) continue;
    const t = (b.innerText || b.value || "").trim();
    if (rxSubmit.test(t) || /submitbutton/i.test(b.getAttribute("data-automation-id") || ""))
      return "submit";
  }
  return null;
}

function clickNext() {
  const rxNext = /^(next|continue|متابعة|التالي)$/i;
  const nodes = document.querySelectorAll('button, a[role="button"], input[type="submit"]');
  for (const b of nodes) {
    if (b.offsetParent === null) continue;
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
    setStatus("extracting fields...", true);
    const fields = extractFields();
    if (!fields.length) { setStatus("no fields found on this page", false); return; }

    setStatus(`asking AI (${fields.length} fields)...`, true);
    const resp = await chrome.runtime.sendMessage({ type: "GET_ACTIONS", fields });
    if (!resp || !resp.ok) {
      setStatus("❌ " + ((resp && resp.error) || "LLM failed"), false);
      return;
    }

    let ok = 0;
    for (const act of resp.actions) {
      try { if (await dispatch(act)) ok++; }
      catch (e) { console.warn("[CvAgent] action failed, continuing:", e); }
    }
    console.log("[CvAgent] actions report:", resp.actions);

    if (detectFlow() === "submit") {
      setStatus("✅ DONE — review & press Submit yourself 🎉", false);
      alert("CvAgent: الصفحة اتملى ✅\nراجع بياناتك واضغط Submit بنفسك.");
      return;
    }

    setStatus(`filled ${ok}/${resp.actions.length} — Next?`, false);
    // auto-click Next if present (multi-page flows), then stop for the user
    if (clickNext()) setStatus("clicked Next — run again on the new page 🤖", false);
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
