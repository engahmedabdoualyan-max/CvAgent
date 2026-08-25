// CvAgent — options page: stable full-tab profile upload (drag/drop + file
// dialog + paste). Shares the same vault-aware save path as the popup.
const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg);

function setMsg(text, ok) {
  $("msg").textContent = text;
  $("msg").className = ok ? "ok" : "err";
}

async function saveProfile(profile, name) {
  if (!profile || typeof profile !== "object") return setMsg("❌ ملف غير صالح", false);
  if (!profile.full_name && !profile.email) return setMsg("❌ الملف مفيهوش بيانات CV صحيحة (full_name / email)", false);

  const { vaultEnabled } = await chrome.storage.local.get("vaultEnabled");
  if (vaultEnabled) {
    const r = await bg({ type: "VAULT_REPLACE", profile, name });
    if (r.ok) return setMsg("✔ " + name + " — اتحدت ومشفرة AES-256 🔒", true);
    return setMsg("🔒 " + r.error + " — ارجع للبوب أب وافتح الخزنة", false);
  }
  await chrome.storage.local.set({ profile, profileName: name });
  setMsg("✔ " + name + " — اتخزنت بنجاح! ارجع للبوب أب وشغّل الوكيل ON", true);
}

function readProfileFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== "application/json")
    return setMsg("❌ المفروض ملف .json", false);
  const rd = new FileReader();
  rd.onload = () => {
    try { saveProfile(JSON.parse(rd.result), file.name); }
    catch (e) { setMsg("❌ الـ JSON فيه خطأ: " + e.message, false); }
  };
  rd.readAsText(file);
}

const dz = $("dropZone");
dz.addEventListener("click", () => $("realFile").click());
$("realFile").addEventListener("change", (e) => readProfileFile(e.target.files[0]));
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => {
  e.preventDefault(); e.stopPropagation();
  dz.classList.remove("drag");
  readProfileFile(e.dataTransfer.files[0]);
});

$("savePaste").addEventListener("click", () => {
  try { saveProfile(JSON.parse($("pasteJson").value), "pasted JSON"); }
  catch (e) { setMsg("❌ الـ JSON غير صالح: " + e.message, false); }
});
