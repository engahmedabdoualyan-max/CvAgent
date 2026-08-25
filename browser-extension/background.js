// ===========================================================================
// CvAgent — background service worker
// Receives extracted form fields from the content script, sends them to the
// Groq LLM together with the stored candidate profile, and returns a strict
// JSON actions mapping for the content script to execute on the page.
// ===========================================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ---------------------------------------------------------------------------
// System prompt — identical contract to the CLI agent (agent.py)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a precise form-filling engine. You receive:
  1) A JSON array of visible form fields extracted from a job-application page.
  2) A JSON profile of the candidate (Ahmed Alyan — Civil Engineer,
     20+ years Ready-Mix Concrete Plants & Crushers Management, M.Sc. +
     Ph.D. candidate, based in Dammam, Saudi Arabia).

Your task: return STRICT JSON (no markdown, no prose) of the form:

{"actions": [
    {"index": <field index>, "action": "<action>", "value": "<value>", "reason": "<short why>"}
]}

Allowed actions:
  "fill"     -> value is the exact final text for a text/textarea/email/tel/url/date field.
  "select"   -> value is the EXACT option text chosen from that field's "options" array.
  "pick"     -> value is the option text to click inside a CUSTOM combobox (isCombobox true).
  "check"    -> tick a checkbox (value ignored). Use profile booleans.
  "uncheck"  -> untick a checkbox (value ignored).
  "click"    -> for radio inputs: click THIS radio when its label matches the profile answer.
  "skip"     -> leave untouched (captcha, photo upload, signature, already filled, irrelevant).

SCREENING QUESTIONS & QUESTIONNAIRES:
  * Each field carries a "question" key = the text of the screening question it belongs to.
  * Answer screening questions TRUTHFULLY according to profile.booleans and profile facts:
      - work authorization / residency        -> true (valid KSA iqama)
      - years of experience thresholds        -> he meets any threshold up to 20
      - willing to relocate / travel / shift  -> true
      - education questions                   -> Bachelor + Master's + PhD (in progress)
  * NEVER lie on knockout questions.
  * For open essay/text questions, use "fill" with 2-4 professional sentences
    in the SAME LANGUAGE as the question, built from profile.summary.

HARD RULES:
  * NEVER invent data not derivable from the profile. If unsure -> "skip".
  * Dates: MM/DD/YYYY unless the placeholder shows another format.
  * Phone: +966500439617 for KSA contexts, +201001006627 for Egypt.
  * Address: Dammam, Eastern Province, Saudi Arabia, postal 31411.
  * Do NOT return actions for fields whose current value is already correct.
  * Output ONLY the JSON object.`;

// ---------------------------------------------------------------------------
// Groq call
// ---------------------------------------------------------------------------
async function askGroq(apiKey, model, fields, profile) {
  const body = {
    model: model || DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "PAGE FIELDS:\n" + JSON.stringify(fields) +
          "\n\nCANDIDATE PROFILE:\n" + JSON.stringify(profile) +
          "\n\nReturn the actions JSON now."
      }
    ]
  };

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 401) throw new Error("Invalid API key (401)");
  if (resp.status === 429) throw new Error("Rate limited (429) — wait a moment");
  if (!resp.ok) throw new Error("Groq HTTP " + resp.status);

  const data = await resp.json();
  let content = data.choices[0].message.content.trim();
  // defensive: strip accidental markdown fences
  content = content.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.actions)) throw new Error("LLM returned no actions[]");
  return parsed.actions;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "GET_ACTIONS") return false;

  (async () => {
    try {
      const st = await chrome.storage.local.get(["apiKey", "profile", "model"]);
      if (!st.apiKey) return sendResponse({ ok: false, error: "No API key set — open the CvAgent popup and add your Groq key." });
      if (!st.profile) return sendResponse({ ok: false, error: "No profile loaded — open the popup and load profile.json." });

      const actions = await askGroq(st.apiKey, st.model, msg.fields, st.profile);
      sendResponse({ ok: true, actions });
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
