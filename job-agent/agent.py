#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 Auto-Fill Job Applications Agent  —  Workday Portals Edition
============================================================================
 Smart form-filling agent that:
   1. Launches a VISIBLE Chromium browser with stealth configurations.
   2. Extracts every visible form field (<input>/<textarea>/<select>) from
      the page together with all of its metadata (id, name, placeholder,
      aria-label, closest <label> text, options ...).
   3. Sends the extracted metadata + your structured career profile to the
      Groq LLM (llama-3.3-70b-versatile, temperature=0, JSON mode) which
      returns a strict JSON array of actions.
   4. Executes those actions field-by-field (fill / select / check /
      uncheck / custom Workday dropdown click-and-pick), each action
      wrapped in try/except with retries so one broken element never
      blocks the rest of the page.
   5. Auto-clicks "Next / Continue" through multi-page Workday flows and
      STOPS at the final Submit page for your manual review (unless you
      explicitly pass --submit).

 USAGE:
     python agent.py "https://company.wd3.myworkdayjobs.com/en-US/careers/job/..." 
     python agent.py "<url>" --headed            # same (browser is visible by default)
     python agent.py "<url>" --submit            # allow clicking Submit at the end
     python agent.py "<url>" --max-pages 25      # safety cap for long applications
     python agent.py --selftest                  # test browser+extraction without LLM

 ENVIRONMENT:
     GROQ_API_KEY   -> your free key from https://console.groq.com/keys
============================================================================
"""

import asyncio
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

# ---------------------------------------------------------------------------
# 0. GLOBAL CONFIGURATION
# ---------------------------------------------------------------------------
# Real Groq OpenAI-compatible endpoint (note: NOT groq.com — that is the
# marketing site; the API lives at api.groq.com under the /openai/v1 path).
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.3-70b-versatile"
LLM_TIMEOUT  = 60          # seconds per LLM call
LLM_RETRIES  = 3           # network-level retries per call
ACTION_RETRIES = 2         # retries per single form action
FIELD_BATCH_SIZE = 35      # max fields sent to the LLM in one request

# ---------------------------------------------------------------------------
# 1. STEALTH CONFIGURATION
# ---------------------------------------------------------------------------
# Injected into every page BEFORE any site script runs. Removes the most
# common automation fingerprints (navigator.webdriver, empty plugin list,
# missing languages, absent chrome.runtime object).
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver',      {get: () => undefined});
Object.defineProperty(navigator, 'plugins',         {get: () => [1,2,3,4,5]});
Object.defineProperty(navigator, 'languages',       {get: () => ['en-US','en','ar']});
window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || {id: undefined};
Object.defineProperty(navigator, 'platform',        {get: () => 'Win32'});
Object.defineProperty(navigator, 'maxTouchPoints',  {get: () => 1});
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
        ? Promise.resolve({state: Notification.permission})
        : originalQuery(p);
"""

# ---------------------------------------------------------------------------
# 2. DOM EXTRACTION JAVASCRIPT
# ---------------------------------------------------------------------------
# Runs inside the page via page.evaluate(). It:
#   * queries ALL <input>, <textarea>, <select> elements,
#   * keeps only VISIBLE ones (offsetParent !== null),
#   * tags each survivor with a unique  data-agent-idx  attribute so Python
#     can always rebuild a rock-solid CSS selector for it,
#   * collects every attribute the LLM might need to understand the field.
EXTRACT_JS = r"""
() => {
    const nodes = document.querySelectorAll('input, textarea, select');
    const out = [];
    let idx = 0;
    for (const el of nodes) {
        // ---- visibility filter -------------------------------------------
        if (el.offsetParent === null && el.type !== 'hidden') continue;
        if (el.type === 'hidden') continue;

        // ---- stable selector ---------------------------------------------
        el.setAttribute('data-agent-idx', String(idx));

        // ---- human-readable label resolution ------------------------------
        let labelText = '';
        const closestLabel = el.closest('label');
        if (closestLabel) {
            labelText = closestLabel.innerText.trim();
        } else if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) labelText = lbl.innerText.trim();
        }

        // ---- QUESTION CONTEXT (for screening questionnaires) --------------
        // Radio groups / checkbox groups show "Yes"/"No" as their own labels,
        // so the actual QUESTION text lives above them. Resolution order:
        //   1. <fieldset><legend>       (classic HTML question groups)
        //   2. aria-labelledby target    (ARIA question groups)
        //   3. role=group/radiogroup aria-label
        //   4. nearest heading (h1-h6) inside the question container
        let questionContext = '';
        try {
            const fs = el.closest('fieldset');
            const legend = fs && fs.querySelector('legend');
            if (legend && legend.innerText.trim()) {
                questionContext = legend.innerText.trim();
            }
            if (!questionContext && el.getAttribute('aria-labelledby')) {
                questionContext = el.getAttribute('aria-labelledby')
                    .split(/\s+/).map(id => {
                        const t = document.getElementById(id);
                        return t ? t.innerText.trim() : '';
                    }).filter(Boolean).join(' ');
            }
            if (!questionContext) {
                const grp = el.closest('[role="radiogroup"],[role="group"],[role="listbox"]');
                if (grp) {
                    questionContext = grp.getAttribute('aria-label') ||
                                      grp.getAttribute('aria-description') || '';
                    if (!questionContext) {
                        const h = grp.querySelector('h1,h2,h3,h4,h5,h6,[data-automation-id="promptLabel"],[data-automation-id*="question"]');
                        if (h) questionContext = h.innerText.trim();
                    }
                }
            }
            if (!questionContext) {
                // walk up max 3 ancestors, look backwards for a heading/label text
                let node = el;
                for (let up = 0; up < 3 && node; up++) {
                    node = node.parentElement;
                    if (!node) break;
                    let prev = node.previousElementSibling;
                    for (let back = 0; back < 4 && prev; back++) {
                        const t = (prev.innerText || '').trim();
                        if (t && t.length > 8 && t.length < 400) { questionContext = t; break; }
                        prev = prev.previousElementSibling;
                    }
                    if (questionContext) break;
                }
            }
        } catch (e) { /* context is best-effort only */ }
        questionContext = questionContext.slice(0, 300);

        // ---- dropdown options (native <select> only) -----------------------
        let options = [];
        if (el.tagName === 'SELECT') {
            options = Array.from(el.options).slice(0, 60).map(o => o.text.trim());
        }

        // ---- Workday custom-combobox detection -----------------------------
        const isCombobox =
            el.getAttribute('role') === 'combobox' ||
            el.getAttribute('aria-haspopup') !== null ||
            (el.parentElement && el.parentElement.getAttribute('role') === 'combobox');

        out.push({
            index:         idx,
            tag:           el.tagName.toLowerCase(),
            type:          el.type || '',
            id:            el.id || '',
            name:          el.name || '',
            placeholder:   el.placeholder || '',
            ariaLabel:     el.getAttribute('aria-label') || '',
            automationId:  el.getAttribute('data-automation-id') || '',
            label:         labelText,
            question:      questionContext,
            value:         (el.value || '').slice(0, 80),
            readOnly:      el.readOnly || false,
            required:      el.required || el.getAttribute('aria-required') === 'true',
            isCombobox:    isCombobox,
            options:       options
        });
        idx++;
    }
    return out;
}
"""

# ---------------------------------------------------------------------------
# 3. SYSTEM PROMPT — the "brain" contract with the LLM
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are a precise form-filling engine. You receive:
  1) A JSON array of visible form fields extracted from a job-application page.
  2) A JSON profile of the candidate (Ahmed Alyan — Civil Engineer,
     20+ years Ready-Mix Concrete Plants & Crushers Management, M.Sc. +
     Ph.D. candidate, based in Dammam, Saudi Arabia).

Your task: return STRICT JSON (no markdown, no prose) of the form:

{"actions": [
    {"index": <field index>, "action": "<action>", "value": "<value>", "reason": "<short why>"}
]}

Allowed actions:
  "fill"     -> value is the exact final text for a text/textarea/email/tel/url field.
  "select"   -> value is the EXACT option text chosen from that field's "options" array.
  "pick"     -> value is the option text to click inside a CUSTOM combobox (isCombobox true).
  "check"    -> tick a checkbox (value ignored). Use profile booleans.
  "uncheck"  -> untick a checkbox (value ignored).
  "click"    -> for radio inputs: click THIS radio when its label matches the profile answer.
  "skip"     -> leave untouched (captcha, photo upload, signature, already filled, irrelevant).

SCREENING QUESTIONS & QUESTIONNAIRES:
  * Each field carries a "question" key = the text of the screening question
    it belongs to (e.g. "Are you legally authorized to work in Saudi Arabia?").
  * For Yes/No or multiple-choice screening questions, answer TRUTHFULLY
    according to profile.booleans and profile facts:
      - work authorization / residency          -> true (he holds a valid KSA iqama)
      - years of experience questions           -> he meets any threshold up to 20
      - willing to relocate / travel / shift    -> true
      - education questions                     -> Bachelor + Master's + PhD (in progress)
      - salary expectations                     -> prefer "negotiable" if offered as choice
  * NEVER lie on knockout questions. If a requirement is clearly NOT in the
    profile (e.g. "Are you a Saudi national?"), answer truthfully or skip.
  * For open essay/text questions ("Why do you want to work here?", "Describe
    your experience..."), use "fill" and write 2-4 professional sentences in
    the SAME LANGUAGE as the question, built from profile.summary and his
    concrete-plants leadership record.

Hard rules:
  * NEVER invent data that is not derivable from the profile. If unsure -> "skip".
  * Dates: use MM/DD/YYYY unless the placeholder clearly shows another format.
  * Phone numbers: +966500439617 for KSA contexts, +201001006627 for Egypt.
  * Address questions: Dammam, Eastern Province, Saudi Arabia, postal 31411.
  * Years-of-experience questions: use the number that matches the question.
  * Legal name fields: "Ahmed Mohamed Abdo Elsayed Alyan" split correctly.
  * Do NOT return actions for fields whose value is already correct.
  * Output ONLY the JSON object. No explanations outside JSON."""

# ---------------------------------------------------------------------------
# 4. GROQ LLM CLIENT (httpx, async, JSON-mode, retries)
# ---------------------------------------------------------------------------
class LLMClient:
    """Minimal async client for the Groq OpenAI-compatible chat API."""

    def __init__(self, api_key: str, model: str = GROQ_MODEL):
        self.api_key = api_key
        self.model = model
        self.url = GROQ_API_URL

    async def ask_llm(self, page_elements_json: list, user_profile_json: dict) -> dict:
        """
        Send the extracted page elements + candidate profile to Groq and
        return the parsed {"actions": [...]} mapping.
        """
        user_msg = (
            "PAGE FIELDS:\n" + json.dumps(page_elements_json, ensure_ascii=False)
            + "\n\nCANDIDATE PROFILE:\n" + json.dumps(user_profile_json, ensure_ascii=False)
            + "\n\nReturn the actions JSON now."
        )
        payload = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},   # force valid-JSON mode
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_msg},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        last_err = None
        for attempt in range(1, LLM_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
                    resp = await client.post(self.url, json=payload, headers=headers)
                if resp.status_code == 429:                    # rate limited
                    wait = int(resp.headers.get("retry-after", 5))
                    log(f"LLM rate-limited, waiting {wait}s ...", "WARN")
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
                # defensive: strip accidental markdown fences
                content = re.sub(r"^```(json)?|```$", "", content.strip(), flags=re.M).strip()
                return json.loads(content)
            except Exception as exc:                           # noqa: BLE001
                last_err = exc
                log(f"LLM attempt {attempt}/{LLM_RETRIES} failed: {exc}", "WARN")
                await asyncio.sleep(2 * attempt)
        raise RuntimeError(f"LLM call failed after {LLM_RETRIES} tries: {last_err}")

# ---------------------------------------------------------------------------
# 5. LOGGING HELPER
# ---------------------------------------------------------------------------
def log(msg: str, level: str = "INFO") -> None:
    """Timestamped console logger."""
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level:<5}] {msg}", flush=True)

# ---------------------------------------------------------------------------
# 6. THE AGENT
# ---------------------------------------------------------------------------
class WorkdayAgent:
    """Navigates a Workday application and fills every page via LLM mapping."""

    def __init__(self, profile: dict, llm: LLMClient | None,
                 submit: bool = False, max_pages: int = 15):
        self.profile   = profile
        self.llm       = llm
        self.submit    = submit
        self.max_pages = max_pages
        self.report: list[dict] = []      # full audit trail of everything done

    # ------------------------------------------------------------------ run
    async def run(self, url: str) -> None:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,                 # visible on purpose (user supervision)
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--start-maximized",
                ],
            )
            context = await browser.new_context(
                viewport=None,
                locale="en-US",
                timezone_id="Asia/Riyadh",
                user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/124.0.0.0 Safari/537.36"),
            )
            # stealth must be registered before any page exists
            await context.add_init_script(STEALTH_JS)
            page = await context.new_page()
            page.set_default_timeout(15000)

            log(f"Opening: {url}")
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            await self._human_pause(page)
            await self._dismiss_cookies(page)

            # ---------------- main multi-page loop -------------------------
            for page_no in range(1, self.max_pages + 1):
                log(f"===== PAGE {page_no} =====")
                fields = await self._extract_fields(page)

                if not fields:
                    log("No fillable fields found on this page.")
                elif self.llm is None:
                    log("--selftest mode: extraction only. Fields found:")
                    print(json.dumps(fields, indent=2, ensure_ascii=False))
                else:
                    actions = await self._get_actions_batched(fields)
                    await self._apply_actions(page, actions, page_no)

                nxt = await self._detect_flow_button(page)
                if nxt == "submit-page":
                    if self.submit:
                        log("Final page reached — clicking SUBMIT as requested.")
                        await self._click_button(
                            page, r"^(submit|apply|تقديم|تقديم الطلب|إرسال)$")
                        await page.wait_for_load_state("domcontentloaded")
                        log("✅ Application submitted. Check confirmation screen.")
                    else:
                        log("🏁 FINAL REVIEW PAGE reached — agent stopped for "
                            "your manual review (use --submit to auto-send).")
                    break

                if nxt == "next":
                    await self._click_button(page, r"^(next|continue|متابعة|التالي)$")
                    await self._human_pause(page)
                    continue

                log("No Next/Submit button detected — treating as done.")
                break

            # save the audit trail
            out = Path("agent_report.json")
            out.write_text(json.dumps(self.report, indent=2, ensure_ascii=False),
                           encoding="utf-8")
            log(f"Audit trail saved to {out.resolve()}")
            log("Browser stays open for 10 minutes — review or Ctrl+C to quit.")
            await asyncio.sleep(600)
            await browser.close()

    # -------------------------------------------------------- page helpers
    async def _human_pause(self, page) -> None:
        """Small settle-down pause so Workday's JS hydrates the DOM."""
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except PWTimeout:
            pass
        await page.wait_for_timeout(700)

    async def _dismiss_cookies(self, page) -> None:
        """Best-effort click on cookie-consent buttons."""
        for pattern in (r"accept all", r"accept", r"agree", r"موافق", r"قبول"):
            try:
                btn = page.locator(f"button:has-text('{pattern}')").first
                if await btn.is_visible(timeout=800):
                    await btn.click()
                    log(f"Cookie banner dismissed ('{pattern}').")
                    return
            except Exception:                              # noqa: BLE001
                continue

    async def _extract_fields(self, page) -> list[dict]:
        """Inject EXTRACT_JS and return the visible-fields metadata array."""
        try:
            fields = await page.evaluate(EXTRACT_JS)
        except Exception as exc:                            # noqa: BLE001
            log(f"Extraction failed on this page: {exc}", "ERROR")
            return []
        log(f"Extracted {len(fields)} visible field(s).")
        return fields

    # ------------------------------------------------------------ LLM layer
    async def _get_actions_batched(self, fields: list[dict]) -> list[dict]:
        """
        Split big pages into batches (Groq context safety), call the LLM for
        each batch and merge all returned actions.
        """
        all_actions: list[dict] = []
        for i in range(0, len(fields), FIELD_BATCH_SIZE):
            chunk = fields[i:i + FIELD_BATCH_SIZE]
            log(f" Asking LLM to map {len(chunk)} field(s) "
                f"[{i+1}-{i+len(chunk)}] ...")
            try:
                result = await self.llm.ask_llm(chunk, self.profile)
                acts = result.get("actions", [])
                log(f" LLM returned {len(acts)} action(s).")
                all_actions.extend(acts)
            except Exception as exc:                        # noqa: BLE001
                log(f"LLM mapping failed for this batch: {exc}", "ERROR")
        return all_actions

    # -------------------------------------------------------- action engine
    def _locator_for(self, page, index: int):
        """Rebuild a CSS selector from the data-agent-idx tag we injected."""
        return page.locator(f'[data-agent-idx="{index}"]').first

    async def _apply_actions(self, page, actions: list[dict], page_no: int) -> None:
        """Execute every action individually; failures never stop the loop."""
        done = 0
        for act in actions:
            try:
                idx    = int(act.get("index", -1))
                kind   = (act.get("action") or "").lower()
                value  = (act.get("value") or "").strip()
                reason = act.get("reason", "")

                if kind == "skip":
                    log(f"  #{idx} skip — {reason}")
                    self.report.append({"page": page_no, "index": idx,
                                        "action": "skip", "reason": reason})
                    continue

                loc = self._locator_for(page, idx)
                if not await loc.count():
                    log(f"  #{idx} element vanished — skipped.", "WARN")
                    continue

                ok = False
                for attempt in range(1, ACTION_RETRIES + 1):
                    try:
                        ok = await self._dispatch(page, loc, kind, value)
                        break
                    except Exception as exc:                # noqa: BLE001
                        log(f"  #{idx} attempt {attempt}/{ACTION_RETRIES} "
                            f"failed: {exc}", "WARN")
                        await page.wait_for_timeout(500)

                if ok:
                    done += 1
                    log(f"  #{idx} {kind}"
                        + (f" -> '{value[:48]}'" if value else ""))
                    self.report.append({"page": page_no, "index": idx,
                                        "action": kind, "value": value,
                                        "reason": reason, "status": "ok"})
                else:
                    self.report.append({"page": page_no, "index": idx,
                                        "action": kind, "value": value,
                                        "reason": reason, "status": "failed"})
            except Exception as exc:                            # noqa: BLE001
                log(f"  action crashed (kept going): {exc}", "ERROR")
        log(f"Page {page_no}: {done}/{len(actions)} action(s) succeeded.")

    async def _dispatch(self, page, loc, kind: str, value: str) -> bool:
        """Route one action to the right low-level Playwright operation."""

        # scroll into view + tiny human-like delay before every interaction
        await loc.scroll_into_view_if_needed(timeout=4000)
        await page.wait_for_timeout(150)

        if kind == "fill":
            tag = (await loc.evaluate("el => el.tagName")).lower()
            await loc.click(timeout=4000)
            await loc.fill("")
            await loc.type(value, delay=12)      # typing looks human, helps
            if tag == "input":                   # fire Workday change listeners
                await loc.press("Tab")
            return True

        if kind == "select":                     # native <select>
            try:
                await loc.select_option(label=value)
            except Exception:                    # noqa: BLE001
                await loc.select_option(value=value)
            return True

        if kind == "pick":                       # Workday custom combobox
            await self._custom_dropdown_pick(page, loc, value)
            return True

        if kind == "check":
            await loc.check()
            return True

        if kind == "uncheck":
            await loc.uncheck()
            return True

        if kind == "click":                      # radio buttons
            await loc.check()
            return True

        log(f"  unknown action '{kind}' — skipped.", "WARN")
        return False

    async def _custom_dropdown_pick(self, page, loc, value: str) -> None:
        """
        Workday renders fake dropdowns: a readonly input that opens a
        floating listbox of <li role="option">. Flow: click -> wait 500ms ->
        click the option whose text matches best.
        """
        await loc.click(timeout=5000)
        await page.wait_for_timeout(500)                    # let the listbox open

        option = page.locator('[role="option"]', has_text=value).first
        if not await option.count():
            option = page.locator('[role="listbox"] li', has_text=value).first
        if not await option.count():
            # last resort: visible <li> anywhere that starts with the value
            option = page.locator("li:visible", has_text=value).first

        if await option.count():
            await option.click(timeout=5000)
            await page.wait_for_timeout(300)
        else:
            await page.keyboard.press("Escape")             # close the popup
            raise RuntimeError(f"option '{value}' not found in listbox")

    # ------------------------------------------------------ flow navigation
    async def _detect_flow_button(self, page) -> str | None:
        """
        Returns 'next' | 'submit-page' | None depending on which flow button
        is visible at the bottom of the current Workday page.
        """
        js = """
        () => {
            const rxNext   = /^(next|continue|متابعة|التالي)$/;
            const rxSubmit = /^(submit|apply|تقديم|تقديم الطلب|إرسال)$/;
            const nodes = document.querySelectorAll('button, a[role="button"], input[type="submit"]');
            const out = {next: false, submit: false};
            for (const b of nodes) {
                if (b.offsetParent === null) continue;
                const t = (b.innerText || b.value || '').trim().toLowerCase();
                const aid = b.getAttribute('data-automation-id') || '';
                if (!out.next   && (rxNext.test(t)   || /nextbutton/i.test(aid)))   out.next = true;
                if (!out.submit && (rxSubmit.test(t) || /submitbutton/i.test(aid))) out.submit = true;
            }
            return out;
        }
        """
        try:
            flags = await page.evaluate(js)
        except Exception:                                   # noqa: BLE001
            return None
        if flags.get("submit"):
            return "submit-page"
        if flags.get("next"):
            return "next"
        return None

    async def _click_button(self, page, text_regex: str) -> None:
        """Click the visible flow button matching text/automation-id."""
        try:
            await page.locator(
                f'button:has-text("{text_regex}"), '
                f'[data-automation-id="nextButton"], '
                f'[data-automation-id="submitButton"]'
            ).first.click(timeout=6000)
            log(f"Clicked flow button ({text_regex}).")
            await page.wait_for_timeout(1500)
        except Exception as exc:                            # noqa: BLE001
            log(f"Could not click flow button: {exc}", "WARN")

# ---------------------------------------------------------------------------
# 7. ENTRY POINT
# ---------------------------------------------------------------------------
def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Auto-Fill Job Applications Agent (Workday portals).")
    p.add_argument("url", nargs="?", help="Job application URL")
    p.add_argument("--profile", default="profile.json",
                   help="Path to your profile JSON (default: profile.json)")
    p.add_argument("--submit", action="store_true",
                   help="Allow the agent to click the final Submit button")
    p.add_argument("--max-pages", type=int, default=15,
                   help="Safety cap on application pages (default 15)")
    p.add_argument("--selftest", action="store_true",
                   help="Test stealth+extraction on a local sample, no LLM")
    return p


async def selftest() -> None:
    """Verify stealth injection + field extraction without any API call."""
    sample = """
    <html><body>
      <label>First Name</label><input id="fn" type="text"/>
      <input id="em" type="email" placeholder="Email address"/>
      <select id="co"><option>Choose</option><option>Egypt</option><option>Saudi Arabia</option></select>
      <label for="cb">I agree</label><input id="cb" type="checkbox"/>
      <textarea id="ms" placeholder="Message"></textarea>
      <fieldset>
        <legend>Are you legally authorized to work in Saudi Arabia?</legend>
        <input type="radio" name="auth" id="a1"/><label for="a1">Yes</label>
        <input type="radio" name="auth" id="a2"/><label for="a2">No</label>
      </fieldset>
      <div role="radiogroup" aria-label="How many years of plant management experience do you have?">
        <input type="radio" name="yrs" id="y1"/><label for="y1">Less than 5</label>
        <input type="radio" name="yrs" id="y2"/><label for="y2">5 - 10</label>
        <input type="radio" name="yrs" id="y3"/><label for="y3">More than 10</label>
      </div>
      <button>Next</button>
    </body></html>"""
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False, args=["--no-sandbox"])
        ctx = await browser.new_context()
        await ctx.add_init_script(STEALTH_JS)
        page = await ctx.new_page()
        await page.set_content(sample)
        fields = await page.evaluate(EXTRACT_JS)
        print(json.dumps(fields, indent=2, ensure_ascii=False))
        wd = await page.evaluate("() => navigator.webdriver")
        log(f"navigator.webdriver after stealth = {wd}  (must be undefined/False)")
        # verify question-context extraction for screening radios
        q1 = next((f.get("question", "") for f in fields if f["id"] == "a1"), "")
        q2 = next((f.get("question", "") for f in fields if f["id"] == "y3"), "")
        assert "authorized" in q1.lower(), f"fieldset legend NOT captured: '{q1}'"
        assert "years" in q2.lower(), f"radiogroup label NOT captured: '{q2}'"
        log(f"Screening Q1 captured: '{q1[:60]}...'")
        log(f"Screening Q2 captured: '{q2[:60]}...'")
        log("QUESTION-CONTEXT EXTRACTION OK ✔")
        await asyncio.sleep(3)
        await browser.close()
    log("SELFTEST DONE ✔")


def main() -> None:
    args = build_arg_parser().parse_args()

    if args.selftest:
        asyncio.run(selftest())
        return

    if not args.url:
        print("Error: provide the application URL (or use --selftest).")
        sys.exit(1)

    api_key = os.getenv("GROQ_API_KEY") or os.getenv("LLM_API_KEY")
    if not api_key:
        log("GROQ_API_KEY env var is missing. Get a free key at "
            "https://console.groq.com/keys then run:\n"
            '  export GROQ_API_KEY="gsk_..."', "ERROR")
        sys.exit(2)

    profile_path = Path(args.profile)
    if not profile_path.exists():
        log(f"Profile file not found: {profile_path}", "ERROR")
        sys.exit(2)
    profile = json.loads(profile_path.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------
    # PRIVATE-DATA OVERLAY: if a local (git-ignored) profile.local.json
    # exists, deep-merge it on top. This is where you keep your real
    # iqama number and anything else you never want published.
    # ------------------------------------------------------------------
    local_path = profile_path.parent / "profile.local.json"
    if local_path.exists():
        def deep_merge(base: dict, overlay: dict) -> dict:
            for k, v in overlay.items():
                if isinstance(v, dict) and isinstance(base.get(k), dict):
                    deep_merge(base[k], v)
                else:
                    base[k] = v
            return base
        local = json.loads(local_path.read_text(encoding="utf-8"))
        profile = deep_merge(profile, local)
        log(f"Private overlay merged: {local_path.name}")

    log(f"Profile loaded: {profile.get('full_name', '?')} "
        f"({len(json.dumps(profile))} bytes)")

    llm = LLMClient(api_key)
    agent = WorkdayAgent(profile, llm,
                         submit=args.submit, max_pages=args.max_pages)
    try:
        asyncio.run(agent.run(args.url))
    except KeyboardInterrupt:
        log("Interrupted by user — bye.")


if __name__ == "__main__":
    main()
