// ===========================================================================
// CvAgent v3.1 — popup controller (simplified onboarding)
// Design: 3 numbered steps (API key → data → ON). Data upload has three
// seamless paths (drag&drop / paste / options page) so the native file
// picker never has to run inside the popup — fixing the popup-closure bug.
// ===========================================================================
const $ = (id) => document.getElementById(id);
let lastOutText = "";

const setStatus = (t) => { $("status").textContent = t; setTimeout(() => { $("status").textContent = ""; }, 8000); };
const showOut = (t) => { lastOutText = t; const o = $("out"); o.textContent = t; o.style.display = "block"; $("copyOut").style.display = "block"; };
const getActiveTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);
const bg = (msg) => chrome.runtime.sendMessage(msg);

// ===========================================================================
// PROFILE SAVE — single vault-aware entry point for all 3 upload paths
// ===========================================================================
async function saveProfile(profile, name) {
  if (!profile || typeof profile !== "object") return setStatus("❌ ملف غير صالح");
  if (!profile.full_name && !profile.email) return setStatus("❌ الملف مفيهوش بيانات CV صحيحة");

  const { vaultEnabled } = await chrome.storage.local.get("vaultEnabled");
  if (vaultEnabled) {
    // vault ON: replace seamlessly if unlocked, otherwise ask to unlock first
    const r = await bg({ type: "VAULT_REPLACE", profile });
    if (r.ok) { $("profileName").textContent = "✔ " + name + " (مشفرة 🔒)"; return setStatus("✔ البيانات اتحدت ومشفرة AES-256"); }
    return setStatus("🔒 " + r.error);
  }
  await chrome.storage.local.set({ profile, profileName: name });
  $("profileName").textContent = "✔ " + name;
  setStatus("✔ البيانات اتخزنت — تقدر تشغل الوكيل دلوقتي");
  refreshSteps();
}

function readProfileFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== "application/json")
    return setStatus("❌ المفروض ملف .json");
  const rd = new FileReader();
  rd.onload = () => {
    try { saveProfile(JSON.parse(rd.result), file.name); }
    catch (e) { setStatus("❌ الـ JSON فيه خطأ — راجعه أو الصقه في الخانة النصية"); }
  };
  rd.readAsText(file);
}

// ===========================================================================
// PATH 1 — Drag & Drop zone (no native dialog, popup never closes)
// ===========================================================================
function wireDropZone() {
  const dz = $("dropZone");
  dz.addEventListener("click", () => {
    // click fallback: open the stable full-tab options page (path 3)
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    window.close();
  });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    dz.classList.remove("drag");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readProfileFile(f);
  });
}

// ===========================================================================
// PATH 2 — paste raw JSON
// ===========================================================================
function wirePaste() {
  $("togglePaste").addEventListener("click", () => {
    const p = $("pasteJson"), s = $("savePaste");
    const show = p.style.display === "none";
    p.style.display = show ? "block" : "none";
    s.style.display = show ? "block" : "none";
    $("togglePaste").textContent = show ? "✖ إخفاء" : "📋 الصق JSON بدلاً من الملف";
    if (show) p.focus();
  });
  $("savePaste").addEventListener("click", () => {
    try { saveProfile(JSON.parse($("pasteJson").value), "pasted JSON"); }
    catch (e) { setStatus("❌ الـ JSON غير صالح — راجع الأقواس والعلامات"); }
  });
}

// ===========================================================================
// PATH 3 — full-tab options page (stable environment for the OS dialog)
// ===========================================================================
function wireOptionsLink() {
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    window.close();
  });
  $("downloadTemplate").addEventListener("click", () => {
    const tpl = { full_name: "", first_name: "", last_name: "", email: "", phone_ksa: "",
      nationality: "", date_of_birth: "", current_location: { city: "", province_state: "", country: "", postal_code: "" },
      ids: { iqama_number: "", saudi_council_of_engineers: "" },
      summary: "", total_years_experience: 0, education: [], experience: [], skills: [], certifications: [],
      booleans: { legally_authorized_to_work: true, willing_to_relocate: true, agreed_to_terms: true } };
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "profile.json"; a.click();
  });
}

// ===========================================================================
// Onboarding steps visual state
// ===========================================================================
async function refreshSteps() {
  const st = await chrome.storage.local.get(["apiKey", "profile", "profileName", "vaultEnabled"]);
  const hasKey = !!st.apiKey;
  const hasProfile = !!st.profile || (st.vaultEnabled && !!st.profileName);
  $("step1num").textContent = hasKey ? "✓" : "1";
  $("step1num").classList.toggle("done", hasKey);
  $("step1ok").textContent = hasKey ? "✔" : "";
  $("step2num").textContent = hasProfile ? "✓" : "2";
  $("step2num").classList.toggle("done", hasProfile);
  $("step2ok").textContent = hasProfile ? "✔ " + (st.profileName || "محمّلة") : "";
  $("profileName").textContent = hasProfile
    ? "✔ " + (st.profileName || "profile.json") + (st.vaultEnabled ? " (مشفرة 🔒)" : "")
    : "";
  // placeholder warning: iqama still the template value?
  if (st.profile && st.profile.ids && /^YOUR_/.test(st.profile.ids.iqama_number || ""))
    $("profileName").textContent += " — ⚠ رقم الإقامة لسه فاضي: عدّله في الملف قبل التقديم";
  $("step3num").textContent = $("onOff").checked ? "✓" : "3";
  $("step3num").classList.toggle("done", $("onOff").checked);
  $("step3ok").textContent = $("onOff").checked ? "✔" : "";
}

// ===========================================================================
// restore + wire everything
// ===========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const st = await chrome.storage.local.get(["agentOn", "apiKey", "profileName", "persona", "autoNext", "autoRun", "aliasMode", "tracker"]);
  $("onOff").checked = !!st.agentOn;
  $("apiKey").value = st.apiKey || "";
  $("persona").value = st.persona || "Balanced";
  $("autoNext").checked = !!st.autoNext;
  $("autoRun").checked = !!st.autoRun;
  $("aliasMode").checked = !!st.aliasMode;
  $("trackCount").textContent = (st.tracker || []).length;
  refreshSteps();
  refreshVault();

  // step 1
  $("apiKey").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ apiKey: e.target.value.trim() });
    setStatus("مفتاح API اتخزن ✔");
    refreshSteps();
  });

  // step 2 — three seamless paths
  wireDropZone();
  wirePaste();
  wireOptionsLink();

  // step 3
  $("onOff").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ agentOn: on });
    bg({ type: "SET_AGENT_ON", on }).catch(() => {});
    const tab = await getActiveTab();
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "STATE" }).catch(() => {});
    setStatus(on ? "ON ✔ — افتح صفحة التقديم ودوس الزرار البرتقالي" : "OFF");
    refreshSteps();
  });

  // AI tools
  $("scoreJD").addEventListener("click", async () => {
    try { setStatus("بحلل الوصف الوظيفي... ⏳"); const jd = await getJD(); const r = await bg({ type: "SCORE_JD", jd });
      if (!r.ok) throw new Error(r.error);
      showOut(`SCORE: ${r.score}/100\n\n✅ MATCHES:\n- ${r.matches.join("\n- ")}\n\n⚠ GAPS:\n- ${r.gaps.join("\n- ")}\n\n💡 SUGGESTIONS:\n- ${r.suggestions.join("\n- ")}`);
      setStatus("التحليل جاهز ✔");
    } catch (e) { setStatus("❌ " + e.message); }
  });
  $("coverLetter").addEventListener("click", async () => {
    try { setStatus("بكتب الخطاب... ⏳"); const jd = await getJD(); const r = await bg({ type: "COVER_LETTER", jd });
      if (!r.ok) throw new Error(r.error);
      showOut(r.letter); setStatus("الخطاب جاهز ✔");
    } catch (e) { setStatus("❌ " + e.message); }
  });
  $("tailorCV").addEventListener("click", async () => {
    try { setStatus("بفصّل الـ CV... ⏳"); const jd = await getJD(); const r = await bg({ type: "TAILOR_CV", jd });
      if (!r.ok) throw new Error(r.error);
      const blob = new Blob([r.html], { type: "text/html;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "CV_tailored_ATS.html"; a.click();
      setStatus("✔ CV مفصّل جاهز — افتحه واطبعه PDF");
    } catch (e) { setStatus("❌ " + e.message); }
  });
  $("interviewPrep").addEventListener("click", async () => {
    try { setStatus("بجهز الأسئلة... ⏳"); let jd = ""; try { jd = await getJD(); } catch (e) {}
      const r = await bg({ type: "INTERVIEW_QA", jd });
      if (!r.ok) throw new Error(r.error);
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/interview.html") });
      setStatus("✔ " + r.count + " سؤال في تاب جديد");
    } catch (e) { setStatus("❌ " + e.message); }
  });
  $("copyOut").addEventListener("click", async () => { await navigator.clipboard.writeText(lastOutText); setStatus("اتنسخ ✔"); });
  $("persona").addEventListener("change", async (e) => { await chrome.storage.local.set({ persona: e.target.value }); setStatus("Persona: " + e.target.value); });

  // zero-effort switches
  $("autoRun").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ autoRun: e.target.checked });
    setStatus(e.target.checked
      ? "⚡ Zero-Click ON — افتح صفحة التقديم وهي تتملأ لوحدها"
      : "Zero-Click OFF — دوس الزرار البرتقالي بنفسك");
  });
  $("autoNext").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ autoNext: e.target.checked });
    setStatus(e.target.checked ? "Next تلقائي ON" : "Next يدوي (أأمن)");
  });

  // bulk
  $("bulkRun").addEventListener("click", async () => {
    const urls = $("bulkUrls").value.split("\n").map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return setStatus("حط لينكات الأول");
    setStatus(`فتحت ${urls.length} تاب... ⏳`);
    const r = await bg({ type: "BULK_OPEN", urls, delay: 9000 });
    setStatus(r.ok ? `✔ ${r.opened} تقديم — راجعهم واضغط Submit بنفسك` : "❌ " + r.error);
  });

  // tracker
  $("exportCsv").addEventListener("click", async () => {
    const { tracker = [] } = await chrome.storage.local.get("tracker");
    if (!tracker.length) return setStatus("السجل فاضي");
    const rows = [["Date", "Title", "URL", "Fields", "SensitiveFlags"], ...tracker.map((t) => [t.date, t.title, t.url, t.filled, t.sensitive])];
    const csv = rows.map((r) => r.map((c) => `"${String(c || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cvagent_applications.csv"; a.click();
  });
  $("followIcs").addEventListener("click", async () => {
    const r = await bg({ type: "FOLLOW_UP_ICS" });
    if (!r.ok) return setStatus("مفيش تقديمات");
    const blob = new Blob([r.ics], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = r.name; a.click();
    setStatus("📅 مواعيد المتابعة جاهزة (7+14 يوم)");
  });

  // vault
  $("vaultEnable").addEventListener("click", async () => {
    const pass = $("vaultPass").value;
    if (!pass || pass.length < 8) return setStatus("كلمة سر 8 أحرف على الأقل");
    const r = await bg({ type: "VAULT_ENABLE", password: pass });
    setStatus(r.ok ? "🔒 الخزنة فعالة — بياناتك مشفرة" : "❌ " + r.error);
    refreshVault(); refreshSteps();
  });
  $("vaultUnlock").addEventListener("click", async () => {
    const r = await bg({ type: "VAULT_UNLOCK", password: $("vaultPass").value });
    setStatus(r.ok ? "🔓 اتفتحت" : "❌ " + r.error);
    refreshVault();
  });
  $("vaultDisable").addEventListener("click", async () => {
    const r = await bg({ type: "VAULT_DISABLE", password: $("vaultPass").value });
    setStatus(r.ok ? "الخزنة اتلغت" : "❌ " + r.error);
    refreshVault(); refreshSteps();
  });

  // blueprints
  $("bpExport").addEventListener("click", async () => {
    const r = await bg({ type: "BLUEPRINT_EXPORT" });
    if (!r.ok) return;
    const blob = new Blob([r.data], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cvagent_blueprints.json"; a.click();
    setStatus("✔ اتصدرت");
  });
  $("bpImport").addEventListener("click", () => $("bpFile").click());
  $("bpFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      const r = await bg({ type: "BLUEPRINT_IMPORT", json: rd.result });
      setStatus(r.ok ? "✔ اندمجت" : "❌ " + r.error);
    };
    rd.readAsText(f);
  });

  // wipe
  $("wipeAll").addEventListener("click", async () => {
    if (!confirm("مسح نهائي لكل البيانات المحلية؟")) return;
    await bg({ type: "WIPE_ALL" });
    location.reload();
  });

  // fill now
  $("fillNow").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    try { await chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" }); setStatus("شغال ⏳"); }
    catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" });
        setStatus("شغال ⏳");
      } catch (e2) { setStatus("❌ الصفحة دي مش مسموح فيها"); }
    }
  });
});

async function getJD() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error("لا يوجد تاب مفتوح");
  const call = () => chrome.tabs.sendMessage(tab.id, { type: "GET_JD" });
  let resp;
  try { resp = await call(); }
  catch (e) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    resp = await call();
  }
  if (!resp || !resp.text || resp.text.length < 200) throw new Error("الصفحة مفيهاش وصف وظيفة واضح");
  return resp.text;
}

async function refreshVault() {
  const r = await bg({ type: "VAULT_STATUS" });
  $("vaultStatus").textContent = r.enabled ? (r.unlocked ? "🔒 مفعلة ومفتوحة" : "🔒 مفعلة — محتاجة فتح") : "غير مفعلة";
}
