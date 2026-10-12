# Berto: AI Builder Cup 2026 edition

Berto is a **voice-first, multilingual companion for people living with type 2 diabetes and their families** in Japan and Asia-Pacific (JAPAC). It is built by **CareGenicsAI** for the **Google Cloud AI Builder Cup 2026** (track: *Sustainability and social impact*).

> ⚠️ **Not a medical device. Not for real patients.** This public edition uses a deliberately minimal *placeholder* safety layer. CareGenicsAI's clinical safety rules, dose-blocking logic, clinical prompts and nudge logic are proprietary and are **not** in this repository.

## What it does
- Speak or type in **12 languages**: Filipino (Taglish), English, Japanese, Korean, Mandarin, Hindi, Bahasa Indonesia, Malay, Thai, Vietnamese, Bengali and Tamil. The language is picked from a menu or detected from what you type.
- Berto answers by voice. Generative replies come from **Gemini 2.5 Flash**, speech-to-text uses Gemini audio input, and text-to-speech uses **Google Cloud Text-to-Speech**.
- You can log medicines and glucose readings, and the app works offline as an installable PWA.

## Stack
Vite + TypeScript PWA · Express (Node 22) · Gemini API · Cloud Text-to-Speech · Cloud Run (asia-southeast1) · Secret Manager.

## Run locally
```bash
npm ci
npm run build
LLM_PROVIDER=gemini GEMINI_API_KEY=<your key> npm start   # http://localhost:8787
npm test
```
Never commit API keys. On Cloud Run the key comes from Secret Manager.

## Deploy to Cloud Run
See [`ops/CLOUDRUN.md`](ops/CLOUDRUN.md), then run:
```bash
PROJECT_ID=<your-project> ops/deploy-cloudrun.sh
```

## Public stubs
| File | Public edition |
|---|---|
| `shared/safety.js` | Same interface with a placeholder. A few English emergency keywords produce "call local emergency services", and any mention of a dose gets a fixed reply. |
| `server/llm.js` | A generic system prompt. The clinical prompts and few-shot examples are removed. |
| `src/nudge.ts` | Health nudges are disabled. |

## License / IP
© 2026 CareGenicsAI. All rights reserved. The code is published for AI Builder Cup 2026 judging.
