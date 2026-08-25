# 🤖 Auto-Fill Job Applications Agent (Workday)

وكيل ذكي يفتح صفحة التقديم على Workday، يقرأ كل الخانات، يبعتها للـ LLM (Groq)،
ويرجع يملأ الفورم ببياناتك من `profile.json` — صفحة صفحة، لحد صفحة المراجعة النهائية.

---

## ⚙️ التثبيت (مرة واحدة فقط)

### 1) بيئة بايثون معزولة (موصى بها)
```bash
cd /home/dr-ahmed/Documents/cv/job-agent
python3 -m venv .venv
source .venv/bin/activate
```

### 2) المكتبات + متصفح Chromium الخاص بـ Playwright
```bash
pip install -r requirements.txt
playwright install chromium
```

### 3) مفتاح Groq (مجاني)
1. افتح https://console.groq.com/keys وسجل حساب مجاني
2. اعمل مفتاح جديد وانسخه
3. فعّله في التيرمينال:

```bash
export GROQ_API_KEY="gsk_ضع_مفتاحك_هنا"
```

> عشان تخليه دائم أضف السطر ده في آخر ملف `~/.bashrc`

---

## 🚀 التشغيل

```bash
# وضع آمن: يملأ كل حاجة ويقف عند صفحة المراجعة قبل التقديم (موصى به)
python agent.py "https://company.wd3.myworkdayjobs.com/en-US/site/..." 

# لو عاوز تشاهد وهو شغال (المتصفح مرئي افتراضياً)
python agent.py "<URL>" --headed --max-pages 25

# لو اتأكدت من كل حاجة وعاوزه يضغط Submit بنفسه
python agent.py "<URL>" --submit
```

### اختبار سريع إن كل حاجة شغالة (من غير LLM):
```bash
python agent.py --selftest
```

---

## 📁 الملفات

| الملف | الوظيفة |
|---|---|
| `agent.py` | الوكيل نفسه (stealth + استخراج + LLM + تنفيذ) |
| `profile.json` | بياناتك الكاملة — عدّل فيه أي وقت |
| `agent_report.json` | يتولد بعد كل تشغيل: سجل بكل حاجة اتعملت |
| `requirements.txt` | المكتبات المطلوبة |

---

## 🧠 إزاي بيشتغل؟

1. **Stealth**: بيحقن سكريبت يخفي آثار الأتمتة (`navigator.webdriver`, plugins, languages, chrome.runtime)
2. **الاستخراج**: جافاسكريبت بيعدّ كل `input/textarea/select` الظاهر ويجيب (id, name, placeholder, aria-label, أقرب label, الخيارات)
3. **الذكاء الاصطناعي**: كل الخانات + بروفايلك بيروحوا لـ `llama-3.3-70b-versatile` بحرارة `0` ووضع JSON إجباري — فيرجع خريطة: "الخانة 3 ← املاها بكذا"
4. **التنفيذ**: `fill` للنصوص، `select_option` للقوائم العادية، click → اختيار من listbox للقوائم المخصصة بتاعة Workday، وcheck/uncheck للاختيارات
5. **التنقل**: بيدوس Next/متابعة تلقائياً، وبيقف قدام Submit عشان تراجع بإيدك

## ⚠️ ملاحظات مهمة

- **راجع دايماً قبل التقديم** — الوكيل ذكي بس مش معصوم. صفحة المراجعة دي حمايتك
- لو موقع حدد Captcha هيتخطاها ويكمل الباقي — حلها بإيدك
- عدّل `profile.json` (خصوصاً `links.linkedin` لو عندك لينك حقيقي) قبل أول استخدام
- لو ظهر خطأ `429` يعني معدل الطلبات — الوكيل بيستنى ويكمل لوحده
