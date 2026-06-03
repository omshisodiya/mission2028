# VOICE ASSISTANT (JARVIS) SPEC

Scale the existing 200-command assistant to **unlimited** natural commands in **English / Hindi / Hinglish**, activated by the wake word **"Jarvis"** (at the start or end of a sentence) or by **clapping**. It must *do* things (drive the app via the Core Engine) and *answer* things (UPSC tutor). Build as vanilla TS, mounted from `boot()`; no framework.

## Architecture (5 layers)

**1. Activation**
- **Wake word:** continuous `SpeechRecognition` (Web Speech API). Gate every transcript: act only if it starts or ends with "jarvis"/"जार्विस"; strip the wake word, pass the rest on. Between activations, ignore audio (privacy + battery).
- **Clap:** Web Audio `AnalyserNode` on the mic. Detect a sharp energy transient (fast attack, quick decay) above a threshold; count claps within a 600 ms window; **2 claps → start listening**. Debounce ~300 ms so speech isn't mistaken for claps.
- Provide a visible mic state (idle / listening / thinking / speaking) and a push-to-talk button as a fallback.

**2. Speech-to-text**
- `SpeechRecognition` with `lang` switchable between `en-IN` and `hi-IN`; default to the user's chosen language, auto-detect on failure. Raw browser STT will mangle Hinglish — that's fine, the LLM router (layer 3) normalizes it.

**3. Intent router (this is how you get >1000 commands with ~25 handlers)**
- Load `voice_intents.json` (the 25 core intents + router contract) **and `voice_commands_2000.csv`** (1,857-row command bank: every intent's phrasings in EN/HI/Hinglish). The bank powers the local fast-path lexicon and serves as few-shot examples for the Groq router. Ship both in `/src/data/`. Two-stage:
  - **Local fast-path:** match the ~25 intents' obvious keywords for instant, offline, zero-cost handling of the common cases.
  - **LLM fallback (Groq — already in the site):** if the local match is low-confidence, send the transcript + the intent list to **Groq** (e.g. `llama-3.1-8b-instant` for ultra-fast intent classification, `llama-3.3-70b-versatile` for tutor answers). It returns `{intent, params, language, confidence}` per `voice_intents.json.router_contract`, handling arbitrary phrasing, Hinglish, and routing knowledge questions to `qa.answer`. Groq's low latency is ideal for voice. Call it through a **Supabase Edge Function** so the Groq key stays server-side (don't expose it in the browser).
- The router never hardcodes 1000 strings — new capability = a new intent + handler, not new patterns.

**4. Action registry (the "does things" part)**
- A typed map `intentId -> handler(params)`. Every handler calls a **real app function wired to the Core Engine**: `core.addScore`, `focusTimer.start`, `routine.setDayType`, `lectures.markDone`, `core.queryRank`, `planner.generate`, `srs.due`, `constitution.show`, etc. (full list in `voice_intents.json`).
- `qa.answer` → Groq call in UPSC-tutor mode, answer spoken back.
- After any action that changes data, the Core Engine recomputes and the UI updates — voice is just another input into the same spine.

**5. Response (text-to-speech)**
- `SpeechSynthesis` speaks the result in the detected language (pick a `hi-IN` or `en-IN` voice). Keep replies short. Also show the reply text in the JARVIS panel. Confirm actions ("Focus shuru kar diya, 50 minute").

## Honest constraints (tell the user)
- Browser STT (Chrome) needs internet and is imperfect for Hinglish — the LLM router compensates, but it won't be perfect.
- Always-listening costs battery; keep wake-word gating + a sleep command, and prefer 2-clap activation over permanent open mic.
- The router/QA uses **Groq** — generous free tier and fast, so this stays ₹0/month. The local fast-path still handles common commands offline/instantly; only long-tail phrasing and tutor Q&A call Groq.
- Mic permission is required; handle denial gracefully with the push-to-talk button.

## Wiring to the existing 200 commands
Map the current commands onto the ~25 intents (most will collapse into a handful of intents with parameters). Keep the current handlers as the action layer; replace the matching layer with the intent router. Share the existing command-handling file with Claude Code so it can fold it in rather than rebuild.

## Acceptance test
1. Say *"Jarvis, mera optional average kya hai"* → router → `query.average` → speaks the value from CoreState in Hinglish.
2. Clap twice → mic starts; say *"start focus 50 minutes"* → timer starts at 50, confirmed by voice; CoreState hours begin tracking.
3. Say *"explain fundamental rights, Jarvis"* → `qa.answer` → spoken UPSC explanation.
4. Say *"switch to Hindi"* then *"आज छुट्टी है"* → day type flips to Holiday; schedule/targets update.
5. Say *"stop listening"* → mic sleeps until wake word or clap.
