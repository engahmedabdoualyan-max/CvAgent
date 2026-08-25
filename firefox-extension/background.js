// ===========================================================================
// CvAgent v3.0 — AI Career OS — background service worker (all-in-one)
// Features implemented here:
//   06 Vector experience memory (local TF-IDF, zero deps)
//   07 Tailored CV generation (JD keywords -> printable HTML CV)
//   09 Application tracker (+27 ICS follow-ups)
//   10 Cross-page learned mappings (a-priori form anticipation)
//   13 Telemetry blocking (declarativeNetRequest toggle)
//   14 Vision captcha assist (Groq vision model, assistive only)
//   15 Swarm blueprints (export/import share files)
//   16 Predictive recruitment scoring
//   18 Employment-gap rebranding (prompt rules + profile.gaps)
//   19 Cover letter synthesizer
//   20 Persona controller (passed through to prompt)
//   21 Zero-knowledge vault (WebCrypto AES-GCM + PBKDF2)
//   23 Volatile jars (secrets in session storage + full wipe)
//   26 Bulk parallel applications
//   28 Final-state snapshot archiving (PNG)
//   29 Interview audio training (Q&A generation -> speechSynthesis page)
// ===========================================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a precise form-filling engine. You receive:
  1) A JSON array of visible form fields extracted from a job-application page.
  2) A JSON profile of the candidate (Ahmed Alyan — Civil Engineer,
     20+ years Ready-Mix Concrete Plants & Crushers Management, M.Sc. +
     Ph.D. candidate, based in Dammam, Saudi Arabia).
  3) Optional "CAREER MEMORY HITS": the most relevant past experiences for
     this page — use them to draft hyper-specific narrative answers.

Return STRICT JSON (no markdown, no prose):
{"actions": [{"index": <n>, "action": "<action>", "value": "<v>", "reason": "<why>"}]}

Allowed actions:
  "fill" | "select" | "pick" | "check" | "uncheck" | "click" | "skip"

Rules:
  * fill -> exact text for text/textarea/email/tel/url/date fields.
  * select -> EXACT option text from that field's "options" array.
  * pick -> option text inside a CUSTOM combobox (isCombobox true).
  * NEVER invent data not derivable from the profile. If unsure -> "skip".
  * Dates: MM/DD/YYYY unless the placeholder shows another format.
  * Phone: +966500439617 (KSA), +201001006627 (Egypt).
  * Address: Dammam, Eastern Province, Saudi Arabia, postal 31411.
  * Screening questions: answer TRUTHFULLY from profile.booleans.
    Work authorization/residency -> true; experience thresholds up to 20 -> true;
    willing to relocate/travel/shift -> true. NEVER lie on knockout questions.
  * Essays: 2-4 professional sentences, SAME LANGUAGE as the question, built
    from profile.summary + CAREER MEMORY HITS. Append real proof URLs from
    profile.links when mentioning his systems (verifiable proof beats adjectives).
  * EMPLOYMENT GAPS: if profile.gaps exists, reframe those periods positively
    (R&D, product building, independent consulting) — never as unemployment.
  * Do NOT return actions for fields whose value is already correct.
  * Output ONLY the JSON object.

PERSONA MODE: user message may include "ACTIVE PERSONA: <name>":
  Manager -> operations leadership & KPIs | Technical -> mix-design/QA/ERP depth
  Executive -> P&L ownership & multi-site strategy | Balanced -> default blend.`;

// ---------------------------------------------------------------------------
// Groq chat (text or vision)
// ---------------------------------------------------------------------------
async function groqChat(apiKey, model, messages, jsonMode = true) {
  const body = { model, temperature: 0, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (resp.status === 401) throw new Error("Invalid API key (401)");
  if (resp.status === 429) throw new Error("Rate limited (429)");
  if (!resp.ok) throw new Error("Groq HTTP " + resp.status);
  let content = (await resp.json()).choices[0].message.content.trim();
  content = content.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  return jsonMode ? JSON.parse(content) : content;
}

const parseJSONsafe = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };

// ===========================================================================
// FEATURE 06 — Vector-Driven Dynamic Experience Memory (local TF-IDF)
// ===========================================================================
const STOP = new Set("the a an and or of to in for with on at by from as is are was were be been i my our we you your their his her its this that these those it".split(" "));

function tokenize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF ]+/g, " ")
    .split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}

function buildCorpus(profile) {
  const docs = [];
  (profile.experience || []).forEach((x, i) =>
    docs.push({ id: "exp" + i, text: [x.title, x.company, x.description].join(" "), ref: x }));
  (profile.skills || []).forEach((s, i) =>
    docs.push({ id: "skill" + i, text: s, ref: { title: "Skill", description: s } }));
  (profile.projects || []).forEach((x, i) =>
    docs.push({ id: "proj" + i, text: [x.name, x.description].join(" "), ref: x }));
  return docs;
}

function retrieveRelevant(query, profile, k = 2) {
  const docs = buildCorpus(profile);
  if (!docs.length) return [];
  const qTokens = tokenize(query);
  const docTokens = docs.map((d) => tokenize(d.text));
  const N = docs.length;
  const df = {};
  docTokens.forEach((toks) => new Set(toks).forEach((t) => (df[t] = (df[t] || 0) + 1)));
  const tf = (toks) => { const m = {}; toks.forEach((t) => (m[t] = (m[t] || 0) + 1)); return m; };
  const qVec = tf(qTokens);
  const scored = docs.map((d, i) => {
    const v = tf(docTokens[i]);
    let dot = 0, nq = 0, nd = 0;
    for (const t in qVec) {
      const w = qVec[t] * Math.log(N / (1 + (df[t] || 0))) + 0.01;
      nq += w * w;
      if (v[t]) dot += w * v[t] * Math.log(N / (1 + (df[t] || 0))) + 0.01 * v[t];
    }
    for (const t in v) { const w = v[t] * Math.log(N / (1 + (df[t] || 0))) + 0.01; nd += w * w; }
    return { doc: d, score: nq && nd ? dot / (Math.sqrt(nq) * Math.sqrt(nd)) : 0 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k)
    .filter((s) => s.score > 0.01).map((s) => s.doc.ref);
}

// ===========================================================================
// FEATURE 10 — Cross-page learned mappings (a-priori cognition)
// ===========================================================================
const normKey = (f) =>
  (f.label || f.question || f.ariaLabel || f.name || f.placeholder || f.id || "")
    .toLowerCase().replace(/\s+/g, " ").trim().slice(0, 90);

async function getLearned(domain) {
  const { learned = {} } = await chrome.storage.local.get("learned");
  return learned[domain] || {};
}
async function saveLearned(domain, pairs) {
  const { learned = {} } = await chrome.storage.local.get("learned");
  learned[domain] = { ...(learned[domain] || {}), ...pairs };
  await chrome.storage.local.set({ learned });
}

// ===========================================================================
// FEATURE 21 — Zero-Knowledge Vault (WebCrypto AES-GCM + PBKDF2)
// ===========================================================================
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function vaultEncrypt(profile, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(profile)));
  return { salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

async function vaultDecrypt(vault, password) {
  const key = await deriveKey(password, unb64(vault.salt));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(vault.iv) }, key, unb64(vault.data));
  return JSON.parse(td.decode(pt));
}

// Resolve the ACTIVE profile: vault-decrypted (session password) or plain.
async function resolveProfile() {
  const st = await chrome.storage.local.get(["profile", "vault", "vaultEnabled"]);
  if (st.vaultEnabled && st.vault) {
    const { vaultPass } = await chrome.storage.session.get("vaultPass");
    if (!vaultPass) return { profile: null, locked: true };
    try {
      return { profile: await vaultDecrypt(st.vault, vaultPass), locked: false };
    } catch (e) {
      await chrome.storage.session.remove("vaultPass");
      return { profile: null, locked: true, wrongPass: true };
    }
  }
  return { profile: st.profile || null, locked: false };
}

// ===========================================================================
// FEATURE 27 — ICS follow-up reminders (no OAuth needed)
// ===========================================================================
function buildICS(entries) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const now = new Date();
  let out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CvAgent//Career OS//EN"];
  entries.forEach((e, i) => {
    const d = new Date(now.getTime() + (i === 0 ? 7 : 14) * 86400000);
    d.setHours(10, 0, 0, 0);
    out.push(
      "BEGIN:VEVENT", `UID:cvagent-${Date.now()}-${i}@cvagent`, `DTSTAMP:${fmt(now)}`,
      `DTSTART:${fmt(d)}`, `DTEND:${fmt(new Date(d.getTime() + 1800000))}`,
      `SUMMARY:CvAgent follow-up ${i === 0 ? "(7d)" : "(14d)"} — ${e.title || "Application"}`,
      `DESCRIPTION:Follow up on application: ${e.url || ""}`,
      "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY",
      `DESCRIPTION:CvAgent follow-up`, "END:VALARM", "END:VEVENT");
  });
  out.push("END:VCALENDAR");
  return out.join("\r\n");
}

// ===========================================================================
// FEATURE 07 — Tailored CV (printable HTML, ATS keyword injection)
// ===========================================================================
function tailoredCVHtml(profile, tailor) {
  const esc = (s) => String(s || "").replace(/</g, "&lt;");
  const exp = (profile.experience || []).map((x) => `
    <div class="job"><div class="jt"><b>${esc(x.title)}</b> — ${esc(x.company)}, ${esc(x.location)}
      <span class="date">| ${esc(x.dates)}</span></div><p>${esc(x.description)}</p></div>`).join("");
  const edu = (profile.education || []).map((x) =>
    `<div class="edu"><b>${esc(x.degree)}</b><br><span>${esc(x.school)} | ${esc(x.dates)} ${esc(x.grade || "")}</span></div>`).join("");
  const certs = (profile.certifications || []).map((c) => `<li>${esc(c)}</li>`).join("");
  const skills = (profile.skills || []).map((s) => {
    const hit = tailor.keywords.some((k) => s.toLowerCase().includes(k.toLowerCase()));
    return `<span class="chip${hit ? " hot" : ""}">${esc(s)}</span>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(profile.full_name)} — CV</title>
  <style>@page{size:A4;margin:0}body{font:10.5pt/1.5 'Segoe UI',Calibri,sans-serif;color:#2E3440;max-width:19cm;margin:0 auto;padding:9mm 11mm}
  h1{color:#1F3A5F;margin:0;font-size:20pt}h2{background:#1F3A5F;color:#fff;padding:2mm 3mm;font-size:11pt;margin:5mm 0 2mm;border-radius:1mm}
  .role{color:#E87722;font-weight:800;font-size:12.5pt}.meta{font-size:9.3pt;margin-top:1.5mm}
  .jt b{color:#1F3A5F}.date{color:#E87722;font-weight:700;font-size:9pt}.job{margin-bottom:2.5mm}.job p{margin:.6mm 0}
  .edu{margin-bottom:1.8mm}.edu b{color:#1F3A5F}.edu span{font-size:9.3pt}
  .chip{display:inline-block;background:#EEF2F7;border-radius:2mm;padding:.8mm 2.5mm;margin:.6mm .8mm .6mm 0;font-size:9pt}
  .chip.hot{background:#E87722;color:#fff;font-weight:700}.sum{text-align:justify}.kw{font-size:9pt;color:#7a8494;margin-top:1mm}</style></head><body>
  <h1>${esc(profile.full_name)}</h1><div class="role">${esc(tailor.title || profile.title)}</div>
  <div class="meta">${esc(profile.email)} | ${esc(profile.phone_ksa)} | ${esc(profile.current_location?.full_address || "")} | ${esc(profile.nationality)}</div>
  <h2>PROFESSIONAL SUMMARY — TAILORED</h2><p class="sum">${esc(tailor.summary)}</p>
  <h2>EXPERIENCE</h2>${exp}<h2>EDUCATION</h2>${edu}
  <h2>CERTIFICATIONS</h2><ul>${certs}</ul>
  <h2>SKILLS <span class="kw">(orange = matched to this job's keywords: ${esc(tailor.keywords.join(", "))})</span></h2><div>${skills}</div>
  </body></html>`;
}

// ===========================================================================
// Message router
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        // ------------------------------------------------ form filling core
        case "GET_ACTIONS": {
          const st = await chrome.storage.local.get(["apiKey", "model", "persona"]);
          const { profile, locked } = await resolveProfile();
          if (locked) return sendResponse({ ok: false, error: "🔒 Vault is locked — open the popup and unlock with your master password." });
          if (!st.apiKey) return sendResponse({ ok: false, offline: true, error: "No API key." });
          if (!profile) return sendResponse({ ok: false, offline: true, error: "No profile loaded." });

          const domain = new URL(sender.tab?.url || "https://x").hostname;
          const learned = await getLearned(domain);                       // F10
          const memory = retrieveRelevant(
            msg.fields.map((f) => f.question || f.label).join(" "), profile, 2); // F06

          const userMsg =
            (st.persona && st.persona !== "Balanced" ? `ACTIVE PERSONA: ${st.persona}\n\n` : "") +
            (memory.length ? `CAREER MEMORY HITS:\n${JSON.stringify(memory)}\n\n` : "") +
            "PAGE FIELDS:\n" + JSON.stringify(msg.fields) +
            "\n\nCANDIDATE PROFILE:\n" + JSON.stringify(profile) +
            "\n\nReturn the actions JSON now.";

          const result = await groqChat(st.apiKey, st.model || DEFAULT_MODEL, [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg }
          ]);
          // learn label->value for future pages (F10)
          const pairs = {};
          result.actions.forEach((a) => {
            const f = msg.fields.find((x) => x.index === a.index);
            if (a.action === "fill" && f && a.value) pairs[normKey(f)] = a.value;
          });
          await saveLearned(domain, pairs);
          return sendResponse({ ok: true, actions: result.actions, memoryUsed: memory.length });
        }

        // ------------------------------------------------ F09 tracker + F27
        case "TRACK": {
          const { tracker = [] } = await chrome.storage.local.get("tracker");
          tracker.unshift({ ...msg.data, id: Date.now() });
          await chrome.storage.local.set({ tracker: tracker.slice(0, 500) });
          return sendResponse({ ok: true, count: tracker.length });
        }
        case "GET_TRACKER":
          return sendResponse({ ok: true, tracker: (await chrome.storage.local.get("tracker")).tracker || [] });
        case "CLEAR_TRACKER":
          await chrome.storage.local.set({ tracker: [] });
          return sendResponse({ ok: true });
        case "FOLLOW_UP_ICS": {
          const { tracker = [] } = await chrome.storage.local.get("tracker");
          const last = tracker[0];
          return sendResponse({ ok: true, ics: buildICS(last ? [last, last] : [{}]), name: "cvagent_followups.ics" });
        }

        // ------------------------------------------------ F07 tailored CV
        case "TAILOR_CV": {
          const st = await chrome.storage.local.get(["apiKey", "model", "persona"]);
          const { profile } = await resolveProfile();
          if (!st.apiKey || !profile) return sendResponse({ ok: false, error: "API key / profile missing." });
          const r = await groqChat(st.apiKey, st.model || DEFAULT_MODEL, [
            { role: "system", content: `You tailor CVs for ATS systems. Return JSON: {"keywords": ["...up to 10 exact JD keywords..."], "title": "best matching job title", "summary": "4-line professional summary weaving those keywords naturally into the candidate's real background. Never invent facts."}` },
            { role: "user", content: `JOB DESCRIPTION:\n${msg.jd.slice(0, 6000)}\n\nPROFILE:\n${JSON.stringify({ title: profile.title, summary: profile.summary, skills: profile.skills, experience: profile.experience.map((e) => e.title + " @ " + e.company) })}` }
          ]);
          return sendResponse({ ok: true, html: tailoredCVHtml(profile, r), keywords: r.keywords });
        }

        // ------------------------------------------------ F16 JD scoring
        case "SCORE_JD": {
          const st = await chrome.storage.local.get(["apiKey", "model"]);
          const { profile } = await resolveProfile();
          if (!st.apiKey || !profile) return sendResponse({ ok: false, error: "API key / profile missing." });
          const r = await groqChat(st.apiKey, st.model || DEFAULT_MODEL, [
            { role: "system", content: `You are a recruitment alignment auditor. Return STRICT JSON {"score": 0-100, "matches": ["..."], "gaps": ["..."], "suggestions": ["...resume modifications..."]}. Be honest and specific.` },
            { role: "user", content: `JOB DESCRIPTION:\n${msg.jd.slice(0, 6000)}\n\nCANDIDATE PROFILE:\n${JSON.stringify(profile)}` }
          ]);
          return sendResponse({ ok: true, ...r });
        }

        // ------------------------------------------------ F19 cover letter
        case "COVER_LETTER": {
          const st = await chrome.storage.local.get(["apiKey", "model", "persona"]);
          const { profile } = await resolveProfile();
          if (!st.apiKey || !profile) return sendResponse({ ok: false, error: "API key / profile missing." });
          const letter = await groqChat(st.apiKey, st.model || DEFAULT_MODEL, [
            { role: "system", content: `You write high-impact cover letters. Map the company's goals to the candidate's verified achievements. 3 short paragraphs. No generic fluff. ${st.persona && st.persona !== "Balanced" ? "Tone persona: " + st.persona + "." : ""} Output the letter text only.` },
            { role: "user", content: `JOB DESCRIPTION:\n${msg.jd.slice(0, 5000)}\n\nPROFILE:\n${JSON.stringify({ name: profile.full_name, title: profile.title, summary: profile.summary, experience: profile.experience, links: profile.links })}` }
          ], false);
          return sendResponse({ ok: true, letter });
        }

        // ------------------------------------------------ F29 interview QA
        case "INTERVIEW_QA": {
          const st = await chrome.storage.local.get(["apiKey", "model", "persona"]);
          const { profile } = await resolveProfile();
          if (!st.apiKey || !profile) return sendResponse({ ok: false, error: "API key / profile missing." });
          const r = await groqChat(st.apiKey, st.model || DEFAULT_MODEL, [
            { role: "system", content: `Generate a mock interview prep set for this candidate. Return STRICT JSON {"qa":[{"q":"interviewer question","a":"strong first-person STAR answer using ONLY real profile facts"}]} with 8 questions: 2 intro, 3 role-specific (ready-mix concrete plants management), 2 behavioral, 1 closing.` },
            { role: "user", content: `PROFILE:\n${JSON.stringify(profile)}\n${msg.jd ? "TARGET JOB:\n" + msg.jd.slice(0, 3000) : ""}` }
          ]);
          await chrome.storage.local.set({ lastQA: r.qa });
          return sendResponse({ ok: true, count: r.qa.length });
        }

        // ------------------------------------------------ F14 vision assist
        case "VISION_ASSIST": {
          const st = await chrome.storage.local.get(["apiKey"]);
          if (!st.apiKey) return sendResponse({ ok: false, error: "No API key." });
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
          const hint = await groqChat(st.apiKey, VISION_MODEL, [
            { role: "user", content: [
              { type: "text", text: "This screenshot contains a CAPTCHA or human-verification challenge. In 1-2 short sentences, tell the user EXACTLY what to do to solve it (which images/letters to pick, what to type). If unreadable, say so." },
              { type: "image_url", image_url: { url: dataUrl } }
            ]}
          ], false);
          return sendResponse({ ok: true, hint });
        }

        // ------------------------------------------------ F26 bulk apply
        case "BULK_OPEN": {
          const urls = (msg.urls || []).map((u) => u.trim()).filter(Boolean).slice(0, 20);
          for (const url of urls) {
            const tab = await chrome.tabs.create({ url, active: false });
            await new Promise((r) => {
              chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                if (tabId === tab.id && info.status === "complete") {
                  chrome.tabs.onUpdated.removeListener(listener);
                  r();
                }
              });
            });
            await new Promise((r) => setTimeout(r, 2500));
            try {
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
              await chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" });
            } catch (e) { /* skip pages that reject injection */ }
            await new Promise((r) => setTimeout(r, msg.delay || 9000));
          }
          return sendResponse({ ok: true, opened: urls.length });
        }

        // ------------------------------------------------ F28 snapshot
        case "SNAPSHOT": {
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
          return sendResponse({ ok: true, dataUrl });
        }

        // ------------------------------------------------ F15 blueprints
        case "BLUEPRINT_EXPORT": {
          const { learned = {}, blueprints = [] } = await chrome.storage.local.get(["learned", "blueprints"]);
          return sendResponse({ ok: true, data: JSON.stringify({ version: 3, learned, blueprints }, null, 2) });
        }
        case "BLUEPRINT_IMPORT": {
          const data = parseJSONsafe(msg.json, null);
          if (!data || !data.learned) return sendResponse({ ok: false, error: "Invalid blueprint file." });
          const { learned = {}, blueprints = [] } = await chrome.storage.local.get(["learned", "blueprints"]);
          const merged = { ...learned };
          for (const [dom, pairs] of Object.entries(data.learned || {}))
            merged[dom] = { ...(merged[dom] || {}), ...pairs };
          const seen = new Set(blueprints.map((b) => b.signature));
          (data.blueprints || []).forEach((b) => { if (!seen.has(b.signature)) blueprints.push(b); });
          await chrome.storage.local.set({ learned: merged, blueprints });
          return sendResponse({ ok: true });
        }
        case "SAVE_BLUEPRINT": {
          const { blueprints = [] } = await chrome.storage.local.get("blueprints");
          blueprints.push({ signature: msg.signature, fix: msg.fix, date: new Date().toISOString().slice(0, 10) });
          await chrome.storage.local.set({ blueprints: blueprints.slice(0, 300) });
          return sendResponse({ ok: true });
        }

        // ------------------------------------------------ plain profile (F25)
        case "GET_PLAIN_PROFILE": {
          const { profile, locked } = await resolveProfile();
          return sendResponse({ ok: true, profile, locked });
        }

        // ------------------------------------------------ F21 vault
        case "VAULT_ENABLE": {
          const { profile } = await chrome.storage.local.get("profile");
          if (!profile) return sendResponse({ ok: false, error: "Load a profile first." });
          const vault = await vaultEncrypt(profile, msg.password);
          await chrome.storage.local.set({ vault, vaultEnabled: true });
          await chrome.storage.local.remove("profile");
          await chrome.storage.session.set({ vaultPass: msg.password });
          return sendResponse({ ok: true });
        }
        case "VAULT_DISABLE": {
          const { vault } = await chrome.storage.local.get("vault");
          const { vaultPass } = await chrome.storage.session.get("vaultPass");
          if (!vault || !vaultPass) return sendResponse({ ok: false, error: "Vault locked — unlock first." });
          const profile = await vaultDecrypt(vault, vaultPass);
          await chrome.storage.local.set({ profile, vaultEnabled: false });
          await chrome.storage.local.remove("vault");
          return sendResponse({ ok: true });
        }
        case "VAULT_UNLOCK": {
          const { vault, vaultEnabled } = await chrome.storage.local.get(["vault", "vaultEnabled"]);
          if (!vaultEnabled || !vault) return sendResponse({ ok: false, error: "Vault not enabled." });
          try {
            await vaultDecrypt(vault, msg.password); // verify only
            await chrome.storage.session.set({ vaultPass: msg.password });
            return sendResponse({ ok: true });
          } catch (e) {
            return sendResponse({ ok: false, error: "Wrong password." });
          }
        }
        // Replace the encrypted profile with a newly uploaded one (popup/options
        // upload paths). Requires an unlocked vault — never touches plaintext.
        case "VAULT_REPLACE": {
          const { vaultEnabled } = await chrome.storage.local.get("vaultEnabled");
          if (!vaultEnabled) return sendResponse({ ok: false, error: "Vault not enabled." });
          const { vaultPass } = await chrome.storage.session.get("vaultPass");
          if (!vaultPass) return sendResponse({ ok: false, error: "Vault locked — unlock first (advanced settings)." });
          const vault = await vaultEncrypt(msg.profile, vaultPass);
          await chrome.storage.local.set({ vault });
          await chrome.storage.local.set({ profileName: msg.name || "profile.json" });
          return sendResponse({ ok: true });
        }
        case "VAULT_STATUS": {
          const { vaultEnabled } = await chrome.storage.local.get("vaultEnabled");
          const { vaultPass } = await chrome.storage.session.get("vaultPass");
          return sendResponse({ ok: true, enabled: !!vaultEnabled, unlocked: !!vaultPass });
        }

        // ------------------------------------------------ F13 telemetry toggle
        case "SET_AGENT_ON": {
          await chrome.declarativeNetRequest.updateEnabledRulesets({
            [msg.on ? "enableRulesetIds" : "disableRulesetIds"]: ["trackers"]
          });
          return sendResponse({ ok: true });
        }

        // ------------------------------------------------ F23 wipe all
        case "WIPE_ALL": {
          await chrome.storage.local.clear();
          await chrome.storage.session.clear();
          return sendResponse({ ok: true });
        }

        default:
          return sendResponse({ ok: false, error: "Unknown message " + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true; // async channel
});

// F23 — volatile jar: session secrets die with the browser automatically.
// Extra hardening: when a CvAgent-filled tab closes, drop nothing persistent
// (tracker/learned are user value; session cache is already ephemeral).
