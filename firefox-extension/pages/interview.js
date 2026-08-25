// CvAgent — interview training page: renders Q&A + speechSynthesis playback
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { lastQA = [] } = await chrome.storage.local.get("lastQA");
  const list = $("list");
  if (!lastQA.length) return;

  list.innerHTML = "";
  lastQA.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "qa";
    div.innerHTML = `
      <div class="q"><span>Q${i + 1}. ${item.q}</span><button class="play" data-i="${i}">▶</button></div>
      <div class="a">${item.a}</div>`;
    list.appendChild(div);
  });

  list.querySelectorAll(".play").forEach((b) =>
    b.addEventListener("click", () => speak(lastQA[+b.dataset.i])));

  $("playAll").addEventListener("click", async () => {
    for (const item of lastQA) {
      await speak(item.q);
      await new Promise((r) => { const u = speak(item.a); });
      await new Promise((r) => setTimeout(r, 900));
    }
  });
  $("stopAll").addEventListener("click", () => speechSynthesis.cancel());
  $("dl").addEventListener("click", () => {
    const txt = lastQA.map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}\n`).join("\n");
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cvagent_interview_prep.txt";
    a.click();
  });
});

// speak() returns when utterance finishes (used by playAll sequencing)
function speak(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // pick a voice matching the question language
    const isAr = /[\u0600-\u06FF]/.test(text);
    u.lang = isAr ? "ar-SA" : "en-US";
    const voices = speechSynthesis.getVoices();
    const v = voices.find((v) => v.lang.startsWith(isAr ? "ar" : "en"));
    if (v) u.voice = v;
    u.rate = 0.98;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}
