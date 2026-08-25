# 🤖 CvAgent — Next-Gen AI Career OS & Smart Job Application Agent

[![GitHub Stars](https://img.shields.io/github/stars/engahmedabdoualyan-max/CvAgent?style=social)](https://github.com/engahmedabdoualyan-max/CvAgent/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Powered By Groq](https://img.shields.io/badge/Powered%20By-Groq%20Llama--3.3--70B-orange)](https://groq.com)
[![Chrome Extension](https://img.shields.io/badge/Manifest-V3-blue)](browser-extension/) [![Version](https://img.shields.io/badge/version-3.0.0-success)](browser-extension/)

**CvAgent** is not just a form-filler; it is a **World-Class AI Career Operating System (AI Career OS)**. It transitions from a local autonomous script into a seamless, high-utility **Browser Extension**. With a single **ON/OFF** switch, it mutates your daily browser into an elite recruitment assistant that auto-fills complex job portals (Workday, LinkedIn, Greenhouse, etc.) leveraging **Groq LLM (Llama 3.3 70B) and Advanced Injectable Context Engines**.

Built and maintained by **Eng. Ahmed Mohamed Abdo Elsayed Alyan** — Ready-Mix Concrete Plants & Crushers Manager (20+ years, M.Sc. Engineering Economics, PhD Candidate in AI-Driven Management).

---

## 📦 Repository Layout

| Path | What it is |
|---|---|
| **[`browser-extension/`](browser-extension/)** | 🧩 The ON/OFF Chrome/Edge extension — the primary product |
| **[`firefox-extension/`](firefox-extension/)** | 🦊 Firefox build (same agent, Gecko-compatible manifest) |
| **[`job-agent/`](job-agent/)** | CLI version — Playwright (async) + Groq, same brain |
| **[`cv/`](cv/)** | Complete bilingual CV package (PDF / DOCX / HTML / 300-DPI images) |

### Quick start — Browser Extension (recommended)
```text
chrome://extensions → Developer mode → Load unpacked → select browser-extension/
Open the popup → paste your free Groq key → load profile.json → flip ON
Go to any application → press the floating orange pill 🤖
```
Full Arabic guide: [`browser-extension/README.md`](browser-extension/README.md)

### Quick start — CLI agent
```bash
cd job-agent && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && playwright install chromium
export GROQ_API_KEY="gsk_..."
python agent.py "https://company.wd3.myworkdayjobs.com/..." --max-pages 25
```

---

## 🗺️ The Ultimate Vision: 30 Groundbreaking Features

Comprehensive architectural roadmap divided into 6 specialized agentic domains.
**Status:** ✅ shipped · 🔄 partial · 📋 on the roadmap

### 🌐 1. Browser Extension Paradigm & Stealth UI
* ✅ **01. Seamless Browser Extension (ON/OFF Control):** Operates natively in your active tab. Turn it **ON** to ingest and process the current page live, completely replacing heavy CLI environments.
* ✅ **02. Zero Anti-Bot Blocks (100% Human Score):** Runs inside your everyday browser profile. Captures authentic browser fingerprints, completely bypassing Cloudflare, Datadome, and Akamai.
* ✅ **03. Hybrid Multi-Step Control (Page-by-Page Validation):** Auto-fills the active screen, pauses for human review. Auto-Next is opt-in (OFF by default) — you keep absolute command.
* ✅ **04. Human-In-The-Loop Captcha & 2FA Resolution:** Detects Captcha/OTP barriers, yields execution safely, and resumes the moment you press the pill again.
* ✅ **05. Zero-Dependency Cross-Platform Footprint:** No Chromium binaries, no Python venv. Lightweight JavaScript living securely inside the browser.

### 🧠 2. Contextual Engineering & Intelligent Memory
* ✅ **06. Vector-Driven Dynamic Experience Memory:** Local mini-vector DB to draft hyper-specific narrative answers from your career catalog.
* ✅ **07. Real-Time Tailored CV Generation (ATS Optimization):** Reverse-engineers JD keywords and compiles a tailored PDF for instant upload.
* ✅ **08. Human-Like Typographical Simulation:** Micro-delays, random keystroke cadence and micro-pauses — protects accounts from velocity tracking.
* ✅ **09. Cross-Platform Application Tracking Dashboard:** Every submission (company, title, date, fields, sensitive-flags) is logged locally — one-click CSV export.
* ✅ **10. Multi-Step Form Anticipation (A priori Cognition):** Caches structural metadata across multi-page workflows to minimize token spend.

### 🛠️ 3. Protocol Bypassing & Structural Extraction
* 🔄 **11. Shadow API Injection (Passive Discovery):** Hooks fetch/XHR to discover candidate application endpoints in real time (read-only — no blind replay for safety).
* ✅ **12. Deep Shadow DOM & Iframe Penetration:** Recursive shadow-root walker captures unmapped input trees invisible to ordinary tools.
* ✅ **13. Analytical JS Telemetry Disabling:** Sandboxes client-side behavioral tracking scripts.
* ✅ **14. Vision-Language Captcha Assistance:** Routes canvas puzzles through Vision LLMs.
* ✅ **15. Collaborative Swarm Blueprinting:** Anonymized DOM-mapping fixes shared across the swarm.

### 📊 4. Hyper-Personalization & Career Strategy
* ✅ **16. Predictive Recruitment Scoring:** Real-time compatibility index vs. active requisitions.
* ✅ **17. Hyperlinked Verification Arrays:** Essay answers can embed the candidate's verifiable proof URLs (ERP demos, portfolios) straight from `profile.links`.
* ✅ **18. Strategic Employment Gap Rebranding:** Reframes transitions as R&D/consulting windows.
* ✅ **19. Context-Aware Cover Letter Synthesizer:** Distinct intros mapping corporate goals to verified achievements.
* ✅ **20. Adaptive Multi-Persona Controller:** Toggle Manager / Technical / Executive / Balanced personas — essay tone adapts instantly.

### 🛡️ 5. Zero-Knowledge Security & Privacy
* ✅ **21. Local Zero-Knowledge AES-256 Encryption:** Master-password-protected sensitive IDs.
* ✅ **22. Dynamic Privacy Proxy:** Single-use email aliases and routed contact strings.
* ✅ **23. Volatile Jars & Memory Self-Destruction:** RAM/state wiped on tab closure.
* ✅ **24. Automated Compliance Auditing:** Flags predatory data fields (SSN, religion, salary…) and reports them before you submit.
* ✅ **25. Localized Offline Fallback Engine:** Deterministic identity fields (name, email, phone, address, IDs, booleans) fill locally with zero network — the cloud LLM is only used for complex context.

### ⚡ 6. Hyper-Productivity & Ambient Intel
* ✅ **26. Bulk One-Click Parallel Application:** Batch filling across multiple windows.
* ✅ **27. Calendar Sync & Automatic Follow-Up Pipelines:** Hiring-lifecycle follow-ups in Google/Outlook.
* ✅ **28. Automated Final State PDF Archiving:** Pre-submission snapshots for interview prep.
* ✅ **29. Interactive Audio Interview Training:** Tailored oral prep tracks.
* ✅ **30. Ambient Voice-To-Form Control:** Hands-free dictation refined into professional syntax.

**Current score: ✅ 29 shipped · 🔄 1 passive-discovery (11) — the full 30-feature AI Career OS**

---

## 🛠️ Current Baseline Tech Stack

* **Extension Runtime:** JavaScript — Chrome/Edge Manifest V3 (zero build step)
* **CLI Runtime:** Python 3.10+ · Playwright Async (stealth) · HTTPX
* **Intelligence:** Groq Cloud API — `llama-3.3-70b-versatile`, temperature 0, JSON mode
* **Extraction Engine:** Deep DOM walker (Shadow-DOM piercing) + question-context resolver (fieldset legend / ARIA groups / headings)

---

## 🚀 Contributing to the Global Agent

We are actively shifting this repository into an elite Open Source initiative. If you are an expert in **Browser Extensions, LLM Prompt Engineering, Playwright, or Anti-Scraping Bypass Protocols**, your insights are highly welcome.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## ⚠️ Disclaimer

This agent is built to automate the redundant entry of *your own* biographical and professional history onto career platforms. It **never** presses Submit on your behalf, never lies on knockout questions, and always yields to humans for Captcha/OTP. Always exercise manual review before executing final application submissions.

## 📄 License

[MIT](LICENSE) — free to use, adapt and build upon.
