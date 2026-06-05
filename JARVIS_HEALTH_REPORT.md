# JARVIS Health Report — Mission 2028 UPSC App
**Generated:** June 2026  
**Version:** vULTIMATE (V1→V6 Evolution Chain)  
**Codebase:** `src/features/jarvis*.ts` — 17 modules, ~14,500 lines of TypeScript  
**Deployment:** Vercel → https://mission2028.vercel.app  
**User:** Om Shisodiya, UPSC CSE 2028, PW IAS Prarambh 2027

---

## 1. ARCHITECTURE OVERVIEW

### Module Map

| File | Role | Size |
|------|------|------|
| `jarvis.ts` | Core: processQuery, speak, listen, wake word, clap, UI panel, 994 CMDS | ~7,000 lines |
| `jarvis-smart-answers.ts` | Dynamic local answers: any date/time/timezone/math | 407 lines |
| `jarvis-system-brain.ts` | System prompt builder, 200+ UPSC local facts, section registry | 442 lines |
| `jarvis-dom-control.ts` | Full DOM control: click/fill/read/scroll any element | 546 lines |
| `jarvis-command-bar.ts` | Spotlight-style command palette (Ctrl+K) | 290 lines |
| `jarvis-evolution.ts` | V1: gap logging, capability generation via Groq | ~800 lines |
| `jarvis-evolution-v2.ts` | V2: gap clustering, validated caps, cap versioning | ~700 lines |
| `jarvis-evolution-v3.ts` | V3: genetic selection, pipeline composition, auto-repair | ~750 lines |
| `jarvis-evolution-v4.ts` | V4: neural weights, TF-IDF cosine similarity lookup | ~400 lines |
| `jarvis-evolution-v5.ts` | V5: atomic caps, adversarial testing, Pareto front, KG | 771 lines |
| `jarvis-evolution-v6.ts` | V6: parallel agents, semantic index, workflow engine, form autocomplete | ~900 lines |
| `jarvis-intelligence.ts` | Socratic mode, debate, memory palace, PYQ patterns, UPSC radar | ~600 lines |
| `jarvis-router.ts` | 2-tier intent router: local fast-path + Groq 8B classifier | ~400 lines |
| `jarvis-session.ts` | Study session recording, session stats | ~200 lines |
| `jarvis-proactive.ts` | Proactive nudge engine: fatigue, timing, context | ~300 lines |
| `jarvis-curriculum.ts` | Adaptive day-by-day curriculum generator | ~250 lines |
| `jarvis-vision.ts` | Screenshot/image analysis via Groq vision | ~200 lines |

### Data Flow (Query Processing)

```
User Input (voice/text)
        ↓
tryInstantAnswer()         ← jarvis-smart-answers.ts (date/time/math — no network)
        ↓ (if no match)
trySmartAnswer() in TIER 0 of processQuery
        ↓ (if no match)
Local KB (200+ UPSC facts from jarvis-system-brain.ts)
        ↓ (if no match)
NAV_MAP (navigation commands)
Command bar check
QUICK shortcuts (single keywords)
        ↓ (if no match)
~50 specific intent handlers (time, date, streak, backlog, quiz, etc.)
        ↓ (if no match)
994 CMDS regex patterns
        ↓ (if no match)
V6 Evolution pipeline (workflow, atom, semantic, V5 neural)
        ↓ (if no match)
_isObviousKnowledge bypass → direct Groq 70B (for "what/who/why/how" questions)
        ↓ (if no match)
executeIntentWithEvolution → router → Groq 70B
```

### AI Models Used
- **Groq llama-3.3-70b-versatile** — UPSC knowledge, deep questions, analysis
- **Groq llama-3.1-8b-instant** — Fast intent classification, action routing
- **Web Speech API** — Voice input (STT) — Chrome only
- **Speech Synthesis API** — Voice output (TTS) — all browsers

---

## 2. FEATURES INVENTORY

### A. Voice & Wake System
- ✅ Wake word: "Jarvis" (+ variants: jarviz, jarves, jar vis)
- ✅ Double-clap to wake (adaptive noise floor, transient classifier)
- ✅ Interrupt while speaking: say "Jarvis" mid-speech → stops and listens
- ✅ 5 voice personalities: Coach, Teacher, Friend, Commander, Zen
- ✅ Language switching: English / Hindi / Hinglish (auto-detect or manual)
- ✅ Continuous conversation mode
- ✅ TTS speed control (slow/normal/fast) + volume control
- ✅ Ambient mode (whispers every 25 min, panel closes)
- ✅ Focus Guardian (nudge when timer runs but no activity for 10 min)
- ⚠️ **ISSUE:** Wake word uses `maxAlternatives: 3` — sometimes misses "Jarvis" in noisy environments
- ⚠️ **ISSUE:** Two STT instances can occasionally conflict (command mic + wake mic)

### B. Smart Answers (Local, Zero Network)
- ✅ Current time (IST) — catches ALL phrasings
- ✅ Today's date
- ✅ Tomorrow's / yesterday's date
- ✅ Day after tomorrow / day before yesterday
- ✅ Next/last any weekday (Monday through Sunday, Hindi names)
- ✅ Specific date in month ("what date is Christmas?")
- ✅ Holiday dates: Republic Day, Independence Day, Gandhi Jayanti, Christmas, etc.
- ✅ Days countdown: "how many days until Independence Day?"
- ✅ Time in any timezone: London, New York, Dubai, Tokyo, Singapore, etc.
- ✅ Historical day-of-week: "what day was 15 August 1947?"
- ✅ Basic math: 350 + 225, 15% of 200
- ✅ Week number, current month
- ⚠️ **GAP:** Doesn't handle: "What time will it be in 3 hours?" (future time)
- ⚠️ **GAP:** Doesn't handle: "How many days since Independence Day 2024?"
- ⚠️ **GAP:** Lunar calendar / Hindu calendar dates (Diwali, Holi exact dates)

### C. UPSC Knowledge Base (Local, 200+ facts)
- ✅ All major Constitution articles (12-21A, 32, 44, 51A, 356, 368)
- ✅ Parliament (Lok Sabha, Rajya Sabha composition)
- ✅ President, PM, Supreme Court
- ✅ Basic Structure Doctrine, Federalism
- ✅ DPSPs, Fundamental Duties
- ✅ Key historical events (1857, NCM, Quit India)
- ✅ Economy (GST, RBI/MPC, Paris Agreement, CBD)
- ✅ UPSC exam pattern (Prelims, Mains)
- ✅ Constitutional writs (Habeas Corpus, Mandamus, etc.)
- ⚠️ **GAP:** Only ~200 facts — most UPSC queries still need Groq
- ⚠️ **GAP:** No GS3 Science/Technology local facts
- ⚠️ **GAP:** No current affairs (by design — changes constantly)

### D. Groq AI Integration
- ✅ System + user message format (correct Groq API usage)
- ✅ Streaming responses (tokens appear in real-time)
- ✅ Brevity control: 2-3 sentences default, 4-6 when user asks for detail
- ✅ Clean answer filter: strips "Great question!", "Certainly!", markdown filler
- ✅ Knowledge bypass: "what/who/why/how" questions → direct 70B (skips 8B classifier)
- ✅ Honest offline response: "I'm offline — can't reach Groq AI"
- ✅ Response caching (5-minute TTL per query)
- ✅ KB learning: stores Groq answers, serves from KB on repeat queries
- ⚠️ **ISSUE:** buildPersonalContext() is now VERY minimal (intentionally stripped backlog/lectures to fix "time" bug). This means Groq lacks UPSC prep context for personalized answers.
- ⚠️ **ISSUE:** Streaming path calls llmRoute() first, then streams separately — 2 Groq calls per streaming response (wasteful)
- ⚠️ **GAP:** No conversation history sent to Groq (each call is stateless)
- ⚠️ **GAP:** No Groq error handling UI — user sees "offline" even on rate-limit errors

### E. Website Navigation & Control
- ✅ Navigate to any section by voice: "open plan", "open intelligence", "open timer", "open routine", "open constitution"
- ✅ Smart scr() function: tries multiple ID variants, flashes gold border on success
- ✅ Universal click by description (findByDescription)
- ✅ Universal fill by description  
- ✅ Form auto-fill from voice context (score forms)
- ✅ Page snapshot: reads all visible sections, buttons, stats
- ✅ DOM monitor: watches for timer start/stop, lecture checkoffs
- ⚠️ **ISSUE:** Navigation says "opened" even when scroll silently fails (element not in DOM)
- ⚠️ **ISSUE:** "open intelligence" / "open analytics" — section ID is `intel` but JARVIS tries `intelligence-section` first (mismatch)
- ⚠️ **ISSUE:** `scr('routine')` — section ID is `routine-section`, not `routine` (fixed in QUICK but may still fail from CMDS)

### F. Timer Control
- ✅ Start / pause / reset / skip
- ✅ Set custom duration: "set timer to 45 minutes"
- ✅ Timer config: focus/break/long-break/sessions (persisted in app_state)
- ✅ Quick presets: 25/5 (Pomodoro), 50/10, 90/20 (deep work)
- ✅ Session done → celebrate + suggest break
- ⚠️ **GAP:** JARVIS can't read the CURRENT timer config values (only set them)

### G. Study Planner
- ✅ Generate plan: "generate plan"
- ✅ View today's lectures: "what's today's plan"
- ✅ Mark lecture done: "lecture done"
- ✅ Backlog count: "how many lectures left"
- ✅ Filter planner: backlog, today, done
- ⚠️ **GAP:** Can't add a specific lecture by name via voice
- ⚠️ **GAP:** Can't skip a specific lecture by voice

### H. Scores & Analytics
- ✅ Add score: "add score" / "I scored 145 out of 200"
- ✅ Score form auto-fill from voice context
- ✅ View analytics: "open analytics"
- ✅ Selection probability: "what's my SP"
- ✅ Rank band: "my rank estimate"
- ✅ Subject-wise accuracy query
- ⚠️ **GAP:** Can't delete or edit a score entry by voice

### I. Study Intelligence
- ✅ Quiz mode: MCQ on any topic
- ✅ Socratic mode: guided questioning
- ✅ Debate mode: argue both sides
- ✅ Memory palace builder
- ✅ Concept web generator
- ✅ UPSC Radar (subject-wise readiness)
- ✅ Answer evaluation (Mains practice)
- ✅ Essay outline generator
- ✅ Interview practice (board-style questions)
- ✅ Emergency cram mode
- ✅ PYQ pattern mining
- ⚠️ **GAP:** Quiz answers aren't stored in SRS queue automatically
- ⚠️ **GAP:** Socratic/Debate mode can't be resumed after session closes

### J. Notes & Capture
- ✅ Quick note to inbox
- ✅ Dictation: "note: [content]", "ca: [content]", "doubt: [content]"  
- ✅ Mistake notebook entry
- ✅ Current affairs logging
- ✅ Answer writing log
- ⚠️ **GAP:** Can't search notes by voice
- ⚠️ **GAP:** Can't read back recent notes

### K. Reminders
- ✅ Set single reminder: "remind me in 30 minutes"
- ✅ Multi-reminder: "remind me at 3pm, 5pm, and 8pm"
- ✅ Browser notification (even in background tab)
- ✅ Cancel all reminders
- ⚠️ **GAP:** Can't list active reminders
- ⚠️ **GAP:** Can't cancel a specific reminder by ID

### L. Command Bar (Ctrl+K)
- ✅ Spotlight-style overlay (z-index: 99999)
- ✅ Fuzzy search across all registered commands
- ✅ Keyboard navigation (↑↓ arrows, Enter, Escape)
- ✅ Recent commands history
- ✅ All app actions registered as commands
- ✅ Voice trigger: "open command menu"
- ⚠️ **ISSUE:** Was auto-executing first recent command immediately on open (fixed with 400ms delay)
- ⚠️ **ISSUE:** Stale recent commands from natural language ("TELL TODAY'S DATE") were stored — now cleaned on init

### M. Self-Evolution Engine (V1–V6)
- ✅ V1: Gap logging, capability generation from gaps
- ✅ V2: Gap clustering, proactive generation, validation
- ✅ V3: Genetic selection, pipeline composition, auto-repair
- ✅ V4: Neural weights, TF-IDF cosine lookup
- ✅ V5: Atomic synthesis (pre-built caps), adversarial testing, Pareto front, Knowledge Graph, self-benchmark
- ✅ V6: Parallel multi-agent (action + knowledge simultaneously), semantic cosine index, workflow automation, form autocomplete, session intelligence
- ⚠️ **ISSUE:** Evolution loops run every 10-15 minutes — unnecessary background Groq calls when user is just studying
- ⚠️ **ISSUE:** Generated capabilities (caps) are stored in localStorage — can accumulate bad caps over time
- ⚠️ **ISSUE:** V6 semantic index only built from first 300 caps — stale if caps exceed that

### N. Proactive Engine
- ✅ Morning brief (5am-11am, once per day)
- ✅ Evening streak alert (>8pm, if <25min studied)
- ✅ Backlog warning (randomly during day)
- ✅ Focus Guardian (nudge if timer running + no keyboard activity for 10min)
- ✅ Milestone celebrations (7-day streak, 50% coverage, 100 sessions, etc.)
- ✅ 90-second cooldown after any user interaction (prevents nudge spam)
- ⚠️ **ISSUE:** Proactive nudges fire from a setInterval that runs even when app is in background — drains battery on mobile
- ⚠️ **GAP:** No "quiet hours" setting (e.g., don't nudge after 11pm)

### O. Memory & Learning
- ✅ Cross-session memory (weak/strong topics, quiz scores, milestones)
- ✅ KB self-learning: stores Groq answers with Jaccard similarity lookup
- ✅ Knowledge graph edges (concept co-occurrence)
- ✅ Voice journal (daily reflection: mood, learned, improve)
- ✅ "Remember that [fact]" direct teaching command
- ✅ 👍/👎 feedback on responses (updates KB confidence)
- ⚠️ **ISSUE:** KB max 500 entries — old entries evicted, losing learned answers
- ⚠️ **ISSUE:** Jaccard similarity threshold 0.55 may be too high — queries with synonyms miss KB hits

---

## 3. KNOWN BUGS (Active)

### Critical
1. **Time/date handler sometimes bypassed by wake-word path** — Fixed in latest deploy. Wake-word inline commands now go through processQuery. Monitor if still occurring.

2. **Service worker caching stale JS** — Fixed with SW v7. JS/CSS now always network-first. Monitor.

### High Priority
3. **Navigation fake-success** — `scr()` returns `true` if element found and scroll called, but doesn't confirm element is actually visible in viewport. If the section is hidden by CSS or conditionally rendered, JARVIS says "Opened" but user doesn't see it.

4. **buildPersonalContext() stripped too aggressively** — To fix the "724 lectures" lecture spam, we removed ALL UPSC context from Groq prompts. Now Groq gives generic answers without knowing the user's preparation status, streak, or subject. The context should be re-added but in a smarter, query-conditional way.

5. **Double Groq call on streaming path** — executeIntent calls `llmRoute()` (first Groq call to get intent) AND then `streamGroqResponse()` (second call to get answer). The first call's answer is unused in streaming mode.

6. **CMDS section ID mismatches** — Some CMDS entries call `scr('routine')` but section ID is `routine-section`. Same for `constitution` vs `constitution-section`. This causes silent navigation failures.

### Medium Priority  
7. **Evolution background loops waste resources** — V1-V6 loops run via setInterval even when user is studying. They fire Groq calls periodically. Should pause when user is in focus session.

8. **KB Jaccard similarity too strict** — "What is Article 21?" and "Explain Article 21" have <55% Jaccard similarity, so the stored answer isn't reused. Should use stemming or lower threshold to 0.40.

9. **Quiz answers not auto-enrolled in SRS** — When user gets a quiz question wrong, it should automatically create an SRS revision. Currently it only tracks quizScores[] in memory but doesn't create a DB revision row.

10. **Continuous mode mic conflict** — When continuous mode is on, after JARVIS finishes speaking it opens mic after 900ms. If user speaks during that 900ms window, the speech is missed. The delay should be adaptive (based on TTS speed).

### Low Priority
11. **Clap calibration resets on reload** — `_clapThreshold` is loaded from localStorage but `_emaAmb` (ambient noise floor EMA) starts at 40 every time, causing false positives for first 3-5 seconds until EMA warms up.

12. **Knowledge Graph edges unbounded** — `kgAddEdge` saves up to 2000 edges. No TTL or decay, so stale concept pairs from months ago affect context injected into Groq.

13. **`_barOpen` race condition** — If `openCommandBar` is called twice within ~50ms (double-click, voice + keyboard), the second call finds `_barOpen = true` but the overlay may not be in DOM yet. The reset check `!document.getElementById('jcb-overlay')` prevents this but adds a delay.

---

## 4. PERFORMANCE PROFILE

| Operation | Latency | Network |
|-----------|---------|---------|
| Time/date/math query | <1ms | None |
| Local UPSC fact lookup | <2ms | None |
| Nav/timer/app commands | <50ms | None |
| Groq 70B knowledge answer | 1.5–3s | Groq API |
| Groq 8B intent routing | 300–800ms | Groq API |
| Streaming first token | ~500ms | Groq API |
| TTS per sentence | 300–800ms | Browser |
| Wake word detection | Always on | None |
| Evolution loop (V5/V6) | Every 10-15min | Groq API |

---

## 5. DATA STORAGE (localStorage keys)

| Key | Contents | Size concern |
|-----|----------|-------------|
| `jarvis_kb_v2` | Self-learned Q&A (max 500) | Medium |
| `jarvis_fail_v1` | Failed queries (max 200) | Low |
| `jarvis_mem_v1` | Cross-session memory | Low |
| `jarvis_gen_caps_v2` | Generated capabilities (max 200) | Medium |
| `jarvis_kg_v5` | Knowledge graph edges (max 2000) | Medium |
| `jarvis_energy_v5` | Capability energy scores (max 500) | Low |
| `jarvis_bench_v5` | Benchmark history (max 30) | Low |
| `jarvis_temporal_v5` | Hourly cap usage (max 1000) | Medium |
| `jarvis_pareto_v5` | Pareto front points (max 300) | Low |
| `jarvis_v6_session` | Current session state | Low |
| `jarvis_v6_workflows` | Custom workflow definitions | Low |
| `jarvis_cmdbar_recent_v1` | Recent command bar entries | Low |
| `jarvis_curriculum_v1` | Generated curriculum plan | Medium |
| `jarvis_personality` | Selected voice personality | Tiny |
| `jarvis_reply_lang` | Preferred response language | Tiny |
| `jarvis_clap_thresh` | Calibrated clap threshold | Tiny |

**Total localStorage usage:** Estimated 500KB–2MB depending on KB size and cap count.

---

## 6. GROQ API USAGE PATTERN

```
Per user session (typical 2-hour study block):
- Morning brief: 0 (local)
- ~20 knowledge questions × 1 Groq call each = 20 calls
- Evolution loops: 2–3 background calls (V5/V6 every 10-15min)
- Cap generation (when gaps accumulate): 0–5 calls
Total: ~25 Groq calls per session

Token usage per call:
- System prompt: ~200 tokens
- Personal context: ~50 tokens  
- Question: ~20-50 tokens
- Answer (max): 220-400 tokens
Total per call: ~500-700 tokens

Rate limits: Groq free tier = 30 req/min, 6000 tokens/min
Risk: Heavy quiz sessions could approach rate limits
```

---

## 7. WHAT WORKS WELL ✅

1. **Voice pipeline** — Wake word, clap, STT commit all robust. Interrupt-while-speaking works.
2. **Smart date/time engine** — Handles 40+ date/time variations locally with 100% accuracy.
3. **Command palette** — Full spotlight-style UI with fuzzy search and keyboard nav.
4. **Streaming responses** — Tokens appear in real-time, chat updates live.
5. **200+ UPSC facts** — Constitution articles, history, economy answered instantly offline.
6. **Evolution V1-V6** — Impressive capability generation system (though complex).
7. **DOM control** — Can click/fill/read any element on page.
8. **Proactive engine** — Morning brief, streak alerts, Focus Guardian all functional.
9. **Multi-language** — English/Hindi/Hinglish auto-detection and switching works.
10. **Session memory** — Remembers weak/strong topics, milestones, last subject across sessions.

---

## 8. WHAT NEEDS THE MOST WORK ⚠️

### Priority 1 — Accuracy & Reliability
- **Re-add UPSC context to Groq prompts** — but conditionally (only for UPSC questions, not general queries)
- **Fix section ID mismatches** — `routine` → `routine-section`, `constitution` → `constitution-section`
- **Add navigator.onLine check before Groq** — to fail fast and show offline message immediately

### Priority 2 — Response Quality
- **Conversation history** — Send last 3 turns to Groq for multi-turn coherence
- **De-duplicate Groq calls** — Remove the double-call in streaming path
- **KB threshold tuning** — Lower to 0.40, add stemming for better hit rate

### Priority 3 — Features
- **SRS auto-enroll on quiz fail** — Creates revision row when quiz answer is wrong
- **Read back notes** — "what are my recent notes?" should list them
- **List reminders** — "what reminders do I have?"
- **Quiet hours** — "don't disturb between 11pm and 6am"
- **Future time** — "what time will it be in 3 hours?"
- **Pause evolution loops** — When user is in focus session, pause background Groq calls

### Priority 4 — Architecture
- **Consolidate evolution engine** — V1–V6 runs 6 setIntervals simultaneously. Should be one unified loop.
- **Move KB to Supabase** — localStorage KB is per-device. Syncing to Supabase would make it cross-device.
- **Capability cleanup** — Prune generated caps older than 30 days with <2 uses

---

## 9. ENHANCEMENT PROPOSALS

### A. Smart Context Injection
Instead of always/never injecting UPSC context into Groq:
- Detect if query is UPSC-related → inject full context
- Detect if query is general (health, science, math) → minimal context only
- Saves tokens, improves accuracy for both types

### B. Conversation Memory in Groq Calls
Send last 3 turns as `messages` array:
```json
[
  {"role": "system", "content": "..."},
  {"role": "user", "content": "what is Article 21?"},
  {"role": "assistant", "content": "Article 21 protects..."},
  {"role": "user", "content": "how is it related to Article 32?"}
]
```
Enables multi-turn coherent conversations.

### C. Voice-Controlled Note Search
Add: `"show my notes on [topic]"` → queries Supabase notes table → reads them aloud

### D. SRS Integration with Quiz
When quiz answer is wrong → auto-create `revisions` row for that question → appears in next day's plan

### E. Reduce Background Groq Usage
Pause V1-V6 evolution loops when:
- User is in focus session (`studyState === 'in-session'`)
- Resume when break starts
- Save ~3-5 unnecessary Groq calls per session

### F. Smarter Offline Mode
Instead of generic "I'm offline" message:
- Check if answer exists in KB → serve from KB even if old
- Summarize what CAN be answered locally
- Queue the question for when user comes back online

### G. Better Error Distinction
Currently Groq failures show same "offline" message whether:
- User is actually offline
- Groq API key is wrong
- Rate limit hit
- Network timeout
Each should have a distinct, actionable message.

---

## 10. TECHNICAL DEBT

1. **jarvis.ts is 7,000 lines** — Should be split: `jarvis-core.ts`, `jarvis-handlers.ts`, `jarvis-quiz.ts`, `jarvis-interview.ts`
2. **CMDS array has 994 entries** — Many overlap with specific handlers above them. Should be pruned.
3. **`executeIntent` double-calls Groq in streaming mode** — The `await llmRoute(...)` result is unused in streaming path. Remove it.
4. **`any` types throughout** — STT result, Groq response types use `any`. Should be typed.
5. **Evolution caps in localStorage** — ~200 caps stored as JSON. Should move to IndexedDB for performance.
6. **No error boundaries** — One uncaught exception in the evolution loop could break JARVIS entirely.
7. **setInterval leaks** — If `initJarvis()` is called twice, all intervals double. No guard exists.

---

## 11. DEPLOYMENT

- **Host:** Vercel (auto-deploy on git push to main)
- **Service Worker:** v7 — JS/CSS always network-first (never cached)
- **Build:** Vite + TypeScript → `dist/` folder
- **Bundle:** ~1.08MB JS (minified, gzipped: ~311KB)
- **GitHub:** https://github.com/omshisodiya/mission2028

### Environment Variables Required
```
VITE_SUPABASE_URL=         (Supabase project URL)
VITE_SUPABASE_ANON_KEY=    (Supabase anon key)
VITE_GROQ_API_KEY=         (Groq API key for llama models)
```

---

## 12. SUMMARY SCORECARD

| Area | Score | Notes |
|------|-------|-------|
| Voice input accuracy | 7/10 | Good, occasionally misses wake word |
| Response accuracy | 7/10 | Local facts 10/10, Groq 7/10 |
| Response speed | 8/10 | Local instant, Groq 1-3s |
| Navigation/control | 6/10 | Works but some ID mismatches |
| Date/time handling | 9/10 | Very comprehensive now |
| Quiz & learning | 7/10 | Works, needs SRS integration |
| Proactive intelligence | 8/10 | Good alerts, needs quiet hours |
| Command bar | 7/10 | Works, auto-execute bug fixed |
| Offline reliability | 8/10 | Good local fallback |
| Code maintainability | 5/10 | 7000-line monolith needs splitting |
| **Overall** | **7.2/10** | Powerful system, some reliability gaps |

---

*Report generated for Claude AI review session. All file paths relative to project root `c:\Users\omshi\Downloads\UPSC PREPARATIONS (1)\`*
