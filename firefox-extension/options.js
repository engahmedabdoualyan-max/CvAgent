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

// local template generator — no external links needed
$("dlTemplate").addEventListener("click", () => {
  const tpl = {
    full_name: "", first_name: "", middle_name: "", last_name: "", arabic_name: "",
    title: "", email: "", phone_ksa: "", phone_egypt: "", nationality: "", date_of_birth: "",
    current_location: { city: "", province_state: "", country: "", postal_code: "", full_address: "" },
    ids: { iqama_number: "", saudi_council_of_engineers: "" },
    languages: [], summary: "", total_years_experience: 0,
    education: [], experience: [], skills: [], certifications: [],
    booleans: {
      legally_authorized_to_work: true, willing_to_relocate: true, willing_to_travel: true,
      currently_employed: true, over_18: true, agreed_to_terms: true
    },
    links: { linkedin: "" }
  };
  const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "profile.json";
  a.click();
  setMsg("✔ القالب اتحمل — املاه وارفعه تاني", true);
});
