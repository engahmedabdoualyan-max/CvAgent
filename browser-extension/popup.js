// ===========================================================================
// CvAgent — popup controller
// ON/OFF toggle, Groq API key storage, profile.json loader, run-now button.
// ===========================================================================
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- restore UI
document.addEventListener("DOMContentLoaded", async () => {
  const st = await chrome.storage.local.get(["agentOn", "apiKey", "profile", "profileName", "model", "persona", "autoNext", "tracker"]);
  $("onOff").checked = !!st.agentOn;
  $("apiKey").value = st.apiKey || "";
  $("persona").value = st.persona || "Balanced";
  $("autoNext").checked = !!st.autoNext;
  $("trackCount").textContent = (st.tracker || []).length;
  $("profileName").textContent = st.profileName
    ? "✔ محمّل: " + st.profileName
    : "❌ لسه مرفعش — ارفع profile.json";

  // ------------------------------------------------------- toggle ON / OFF
  $("onOff").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ agentOn: on });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "STATE" });
        if (on && /workdayjobs|myworkday| careers|greenhouse|lever|taleo/i.test(tab.url || ""))
          setStatus("ON ✔ — دوس الزرار البرتقالي في الصفحة أو زرار التشغيل تحت");
        else if (on)
          setStatus("ON ✔ — افتح صفحة التقديم ودوس الزرار البرتقالي");
      } catch (err) {
        setStatus("ON ✔ — افتح/حدث صفحة التقديم وهتلاقي الزرار");
      }
    }
  });

  // ------------------------------------------------------------- API key
  $("apiKey").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ apiKey: e.target.value.trim() });
    setStatus("مفتاح API اتخزن ✔");
  });

  // -------------------------------------------------------- profile file
  $("profileFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const profile = JSON.parse(reader.result);
        await chrome.storage.local.set({
          profile,
          profileName: file.name
        });
        $("profileName").textContent = "✔ محمّل: " + file.name;
        setStatus("البروفايل اتخزن ✔");
      } catch (err) {
        setStatus("❌ ملف JSON غير صالح");
      }
    };
    reader.readAsText(file);
  });

  // ------------------------------------------------------------- persona
  $("persona").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ persona: e.target.value });
    setStatus("الشخصية: " + e.target.value + " ✔");
  });

  // ------------------------------------------------------------- autoNext
  $("autoNext").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ autoNext: e.target.checked });
    setStatus(e.target.checked ? "Next تلقائي ON" : "Next يدوي (أأمن)");
  });

  // -------------------------------------------------------- tracker tools
  $("exportCsv").addEventListener("click", async () => {
    const { tracker = [] } = await chrome.storage.local.get("tracker");
    if (!tracker.length) return setStatus("السجل فاضي");
    const rows = [["Date", "Title", "URL", "Fields", "SensitiveFlags"],
      ...tracker.map((t) => [t.date, t.title, t.url, t.filled, t.sensitive])];
    const csv = rows.map((r) => r.map((c) => `"${String(c || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cvagent_applications.csv";
    a.click();
    setStatus("تم تصدير " + tracker.length + " تقديم ✔");
  });

  $("clearTracker").addEventListener("click", async () => {
    await chrome.storage.local.set({ tracker: [] });
    $("trackCount").textContent = "0";
    setStatus("السجل اتمسح");
  });

  // ------------------------------------------------------------ fill now
  $("fillNow").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return setStatus("❌ مفيش تاب مفتوح");
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" });
      setStatus("شغّال على الصفحة... ⏳");
    } catch (err) {
      // content script not there yet (fresh tab) — inject then run
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        await chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" });
        setStatus("شغّال على الصفحة... ⏳");
      } catch (err2) {
        setStatus("❌ متصفح النظام مش مسموح فيه (صفحة chrome://)؟");
      }
    }
  });
});

function setStatus(text) {
  $("status").textContent = text;
  setTimeout(() => { $("status").textContent = ""; }, 6000);
}
