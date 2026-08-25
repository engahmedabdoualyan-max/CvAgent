// ===========================================================================
// CvAgent v3.0 — popup controller (AI Career OS)
// ===========================================================================
const $ = (id) => document.getElementById(id);
let lastOutText = "";

const setStatus = (t) => { $("status").textContent = t; setTimeout(() => { $("status").textContent = ""; }, 8000); };
const showOut = (t) => { lastOutText = t; const o = $("out"); o.textContent = t; o.style.display = "block"; $("copyOut").style.display = "block"; };

function getActiveTab() { return chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t); }

async function getJD() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error("لا يوجد تاب مفتوح");
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_JD" });
    if (!resp || !resp.text || resp.text.length < 200) throw new Error("الصفحة مفيهاش وصف وظيفة واضح");
    return resp.text;
  } catch (e) {
    // inject content script then retry once
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_JD" });
    if (!resp || !resp.text || resp.text.length < 200) throw new Error("الصفحة مفيهاش وصف وظيفة واضح");
    return resp.text;
  }
}

const bg = (msg) => chrome.runtime.sendMessage(msg);

// ---------------------------------------------------------------- restore
document.addEventListener("DOMContentLoaded", async () => {
  const st = await chrome.storage.local.get(["agentOn", "apiKey", "profile", "profileName", "persona", "autoNext", "aliasMode", "tracker", "vaultEnabled"]);
  $("onOff").checked = !!st.agentOn;
  $("apiKey").value = st.apiKey || "";
  $("persona").value = st.persona || "Balanced";
  $("autoNext").checked = !!st.autoNext;
  $("aliasMode").checked = !!st.aliasMode;
  $("trackCount").textContent = (st.tracker || []).length;
  $("profileName").textContent = st.profileName ? "✔ " + st.profileName : "❌ ارفع profile.json";
  refreshVault();

  // ------------------------------------------------------------ ON / OFF
  $("onOff").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ agentOn: on });
    bg({ type: "SET_AGENT_ON", on }).catch(() => {});          // F13 telemetry rules
    const tab = await getActiveTab();
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "STATE" }).catch(() => {});
    setStatus(on ? "ON ✔ — تتبع المواقع متحظر + الزرار البرتقالي شغال" : "OFF");
  });

  // ------------------------------------------------------------- API key
  $("apiKey").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ apiKey: e.target.value.trim() });
    setStatus("مفتاح API اتخزن ✔");
  });

  // ------------------------------------------------------------- profile
  $("profileFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const profile = JSON.parse(reader.result);
        const { vaultEnabled } = await chrome.storage.local.get("vaultEnabled");
        if (vaultEnabled) return setStatus("🔒 الخزنة مفعلة — عطلها الأول عشان تغير البروفايل");
        await chrome.storage.local.set({ profile, profileName: file.name });
        $("profileName").textContent = "✔ " + file.name;
        setStatus("البروفايل اتخزن ✔");
      } catch (err) { setStatus("❌ ملف JSON غير صالح"); }
    };
    reader.readAsText(file);
  });

  // ---------------------------------------------------------------- vault
  $("vaultEnable").addEventListener("click", async () => {
    const pass = $("vaultPass").value;
    if (!pass || pass.length < 8) return setStatus("كلمة سر 8 أحرف على الأقل");
    const r = await bg({ type: "VAULT_ENABLE", password: pass });
    setStatus(r.ok ? "🔒 الخزنة فعالة — بياناتك مشفرة AES-256" : "❌ " + r.error);
    refreshVault();
  });
  $("vaultUnlock").addEventListener("click", async () => {
    const r = await bg({ type: "VAULT_UNLOCK", password: $("vaultPass").value });
    setStatus(r.ok ? "🔓 اتفتحت — شغالة لحد قفل المتصفح" : "❌ " + r.error);
    refreshVault();
  });
  $("vaultDisable").addEventListener("click", async () => {
    const r = await bg({ type: "VAULT_DISABLE", password: $("vaultPass").value });
    setStatus(r.ok ? "الخزنة اتلغت — البروفايل رجع نص عادي" : "❌ " + r.error);
    refreshVault();
  });

  // ------------------------------------------------------- persona/switches
  $("persona").addEventListener("change", async (e) => { await chrome.storage.local.set({ persona: e.target.value }); setStatus("Persona: " + e.target.value); });
  $("autoNext").addEventListener("change", async (e) => { await chrome.storage.local.set({ autoNext: e.target.checked }); setStatus(e.target.checked ? "Next تلقائي" : "Next يدوي"); });
  $("aliasMode").addEventListener("change", async (e) => { await chrome.storage.local.set({ aliasMode: e.target.checked }); setStatus(e.target.checked ? "Alias ON — إيميل مختلف لكل موقع" : "Alias OFF"); });

  // ------------------------------------------------------------- AI tools
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
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "CV_tailored_ATS.html"; a.click();
      setStatus("✔ CV مفصّل اتسجل — افتحه واطبعه PDF. كلمات: " + r.keywords.join(", "));
    } catch (e) { setStatus("❌ " + e.message); }
  });

  $("interviewPrep").addEventListener("click", async () => {
    try { setStatus("بجهز أسئلة المقابلة... ⏳"); let jd = ""; try { jd = await getJD(); } catch (e) {}
      const r = await bg({ type: "INTERVIEW_QA", jd });
      if (!r.ok) throw new Error(r.error);
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/interview.html") });
      setStatus("✔ " + r.count + " سؤال — التاب الجديد فيه التدريب الصوتي");
    } catch (e) { setStatus("❌ " + e.message); }
  });

  $("copyOut").addEventListener("click", async () => { await navigator.clipboard.writeText(lastOutText); setStatus("اتنسخ ✔"); });

  // ---------------------------------------------------------------- bulk
  $("bulkRun").addEventListener("click", async () => {
    const urls = $("bulkUrls").value.split("\n").map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return setStatus("حط لينكات الأول");
    setStatus(`فتحت ${urls.length} تاب... هتتملأ ورا بعض ⏳`);
    const r = await bg({ type: "BULK_OPEN", urls, delay: 9000 });
    setStatus(r.ok ? `✔ اتفتح ${r.opened} تقديم — راجعهم واضغط Submit بنفسك` : "❌ " + r.error);
  });

  // -------------------------------------------------------------- tracker
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
    setStatus("📅 مواعيد المتابعة (7+14 يوم) — افتح الملف في Google/Outlook");
  });

  // ------------------------------------------------------------ blueprints
  $("bpExport").addEventListener("click", async () => {
    const r = await bg({ type: "BLUEPRINT_EXPORT" });
    if (!r.ok) return;
    const blob = new Blob([r.data], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cvagent_blueprints.json"; a.click();
    setStatus("✔ خرائطك اتصدرت — شاركها مع السرب");
  });
  $("bpImport").addEventListener("click", () => $("bpFile").click());
  $("bpFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      const r = await bg({ type: "BLUEPRINT_IMPORT", json: rd.result });
      setStatus(r.ok ? "✔ خرائط السرب اندمجت" : "❌ " + r.error);
    };
    rd.readAsText(f);
  });

  // ----------------------------------------------------------------- wipe
  $("wipeAll").addEventListener("click", async () => {
    if (!confirm("مسح نهائي لكل البيانات المحلية؟ (مفتاح API + بروفايل + سجلات)")) return;
    await bg({ type: "WIPE_ALL" });
    location.reload();
  });

  // -------------------------------------------------------------- fill now
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

async function refreshVault() {
  const r = await bg({ type: "VAULT_STATUS" });
  $("vaultStatus").textContent = r.enabled ? (r.unlocked ? "🔒 مفعلة ومفتوحة" : "🔒 مفعلة — محتاجة فتح") : "غير مفعلة (تخزين عادي)";
}
