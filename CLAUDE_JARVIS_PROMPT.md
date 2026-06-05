# MASTER PROMPT FOR CLAUDE AI — JARVIS COMPLETE OVERHAUL
## Copy this ENTIRE prompt and paste it into a new Claude AI session

---

## YOUR ROLE

You are the world's best software architect, TypeScript engineer, AI systems designer, and voice UX expert. You have been given full access to the JARVIS AI assistant codebase — a personal voice AI for a UPSC exam aspirant built on Vite + TypeScript + Groq API + Web Speech API. Your job is to:

1. **Analyse every bug and fix it with specific code**
2. **Propose and implement super-advanced improvements**
3. **Fix the clap calibration and auto-timer bug specifically**
4. **Make JARVIS the most advanced AI assistant possible**
5. **Leave no stone unturned — every suggestion must come with exact file paths, line changes, and working TypeScript code**

---

## PROJECT CONTEXT

**App:** Mission 2028 — UPSC CSE preparation app for Om Shisodiya (target: CSE 2028, PW IAS Prarambh 2027)  
**Stack:** Vite + TypeScript (vanilla, no React), Groq API (llama-3.3-70b + llama-3.1-8b), Web Speech API, Supabase  
**Deployment:** Vercel → https://mission2028.vercel.app  
**GitHub:** https://github.com/omshisodiya/mission2028  
**JARVIS Codebase:** 17 TypeScript modules, ~14,500 lines total

### Module Architecture
```
src/features/
├── jarvis.ts                 (~7,000 lines) — CORE: processQuery, speak, wake word, clap, 994 CMDS, UI panel
├── jarvis-smart-answers.ts   (407 lines) — LOCAL engine: any date/time/timezone/math
├── jarvis-system-brain.ts    (442 lines) — System prompt, 200+ UPSC facts, section registry
├── jarvis-dom-control.ts     (546 lines) — Full DOM control: click/fill/scroll any element
├── jarvis-command-bar.ts     (290 lines) — Spotlight command palette (Ctrl+K)
├── jarvis-evolution.ts       (~800 lines) — V1: gap logging, cap generation
├── jarvis-evolution-v2.ts    (~700 lines) — V2: clustering, validation
├── jarvis-evolution-v3.ts    (~750 lines) — V3: genetic selection, pipeline
├── jarvis-evolution-v4.ts    (~400 lines) — V4: neural weights, TF-IDF
├── jarvis-evolution-v5.ts    (771 lines) — V5: atoms, adversarial, Pareto, KG
├── jarvis-evolution-v6.ts    (~900 lines) — V6: parallel agents, workflows, forms
├── jarvis-intelligence.ts    (~600 lines) — Socratic, debate, memory palace, radar
├── jarvis-router.ts          (~400 lines) — 2-tier: local + Groq 8B classifier
├── jarvis-session.ts         (~200 lines) — Session recording
├── jarvis-proactive.ts       (~300 lines) — Proactive nudges (morning/evening/backlog)
├── jarvis-curriculum.ts      (~250 lines) — Adaptive curriculum generator
└── jarvis-vision.ts          (~200 lines) — Image/screenshot analysis
```

### Query Processing Pipeline (current)
```
Voice/Text Input
  → tryInstantAnswer() [jarvis-smart-answers.ts — local, zero network]
  → trySmartAnswer() TIER 0 in processQuery [date/time/math]
  → Local KB lookup [jarvis-system-brain.ts — 200+ UPSC facts]
  → NAV_MAP [section navigation]
  → Command bar check
  → QUICK shortcuts [single keywords]
  → ~50 specific intent handlers
  → 994 CMDS regex patterns
  → V6 Evolution pipeline [workflow/atom/semantic/V5]
  → _isObviousKnowledge bypass → direct Groq 70B
  → executeIntentWithEvolution → router → Groq 70B
```

### AI Models
- **llama-3.3-70b-versatile** — Knowledge, deep UPSC questions
- **llama-3.1-8b-instant** — Fast intent classification
- **Web Speech API** — Voice input (Chrome only)
- **Speech Synthesis** — Voice output

### Key Functions (jarvis.ts)
```typescript
processQuery(text)        // Main entry: routes ALL queries
tryInstantAnswer(text)    // Pre-processQuery: date/time/math intercept
sendText(inp)             // Typed input → tryInstantAnswer → processQuery
commit(text)              // STT voice → tryInstantAnswer → processQuery
greetFull()               // Panel open greeting
executeIntent(transcript) // Groq 3-tier pipeline
streamGroqResponse(msgs)  // Streaming Groq (tokens appear live)
buildGroqMessages(t,lang) // Constructs system+user Groq messages
buildPersonalContext()    // Minimal context: name + streak + subject
speak(text)               // TTS output
startWakeWord()           // Continuous wake word detector
startClapWatch()          // Clap-to-wake detector (setInterval, 45ms)
scr(id)                   // Smart scroll to section
```

---

## HEALTH REPORT (READ THIS CAREFULLY)

### KNOWN BUGS — ALL MUST BE FIXED

#### CRITICAL BUG 1: Clap detector triggers timer start
**Location:** `jarvis.ts` → `startClapWatch()` function  
**Symptom:** Double clap to wake JARVIS sometimes also triggers the timer START button because the clap sound event propagates and the system is in a state where it interprets the clap as a UI interaction. The clap → wake → panel opens, but SIMULTANEOUSLY the clap audio transient triggers some DOM event that clicks `[data-act="start"]` (the timer button).  
**Root cause:** After clap is detected and JARVIS opens, the audio processing continues and the decay of the clap waveform can register as a SECOND event if the timer button is the focused element. Also, `startClapWatch` runs on a 45ms setInterval and the clap window is 900ms — a single real clap can trigger 2-3 consecutive "clap detected" events if the suppress timer isn't long enough.  
**Fix needed:** 
- Increase `MIN_GAP` (debounce) from 60ms to 120ms
- After first clap detection, add a 500ms absolute suppress window
- Add `_state === 'listening'` guard in clap handler (don't process claps while mic is open)
- After double-clap fires, set a 2-second global suppress: `_clapEnabled = false; setTimeout(() => _clapEnabled = true, 2000)`
- The `_clapEnabled` flag is already there but needs to be set to false for LONGER after wake

#### CRITICAL BUG 2: buildPersonalContext() too minimal
**Location:** `jarvis.ts` → `buildPersonalContext()` function  
**Current code:**
```typescript
function buildPersonalContext(): string {
  const cs = getCurrentState()
  const streak = cs?.streak ?? 0
  return [
    `User: Om Shisodiya.`,
    streak > 0 ? `Study streak: ${streak} days.` : '',
    _sessionSubject ? `Currently studying: ${_sessionSubject}.` : '',
  ].filter(Boolean).join(' ')
}
```
**Problem:** This was stripped to fix a "time query shows 724 lectures" bug, but now Groq gets NO UPSC context. Questions like "what should I focus on?" get generic answers. The real fix was to detect query type and inject context conditionally — not strip it globally.  
**Fix needed:** Restore full context but inject it conditionally:
```typescript
function buildPersonalContext(isUpscQuery = false): string {
  const cs = getCurrentState()
  const streak = cs?.streak ?? 0
  const base = `User: Om Shisodiya, UPSC CSE 2028 aspirant.`
  if (!isUpscQuery) return base
  // Full context only for UPSC-related queries
  const parts = [base]
  if (streak > 0) parts.push(`Streak: ${streak} days.`)
  if (cs?.today?.subject) parts.push(`Today's subject: ${cs.today.subject}.`)
  if (cs?.performance?.prelimsAvg != null) parts.push(`Prelims avg: ${cs.performance.prelimsAvg.toFixed(1)}%.`)
  if (cs?.selectionProbabilityPct != null) parts.push(`Selection probability: ${cs.selectionProbabilityPct.toFixed(1)}%.`)
  if (_sessionSubject) parts.push(`Current session: ${_sessionSubject}.`)
  return parts.join(' ')
}
```

#### HIGH BUG 3: Section ID mismatches causing silent navigation failure
**Location:** `jarvis.ts` → CMDS array (lines ~3900-5400)  
**Problem:** Multiple CMDS entries call `scr('routine')` and `scr('constitution')` but actual DOM IDs are `routine-section` and `constitution-section`. The `scr()` function tries multiple variants but still sometimes fails silently — JARVIS says "Opened" but nothing scrolls.  
**Fix:** Search entire CMDS array and replace:
- `scr('routine')` → `scr('routine-section')`
- `scr('constitution')` → `scr('constitution-section')`
Also fix `scr()` to speak an error if it truly can't find the section.

#### HIGH BUG 4: Double Groq call in streaming mode
**Location:** `jarvis.ts` → `executeIntent()` function, `if (result.intent === 'qa.answer')` block  
**Problem:** When streaming is enabled:
1. `await llmRoute(buildQATranscript(...), 'qa')` — calls Groq (first call, result UNUSED)
2. `await streamGroqResponse(buildGroqMessages(...))` — calls Groq again (second call, this one used)
**Fix:** In streaming mode, skip the `llmRoute` call entirely and go straight to `streamGroqResponse`. Check `_streamingEnabled` before calling `llmRoute`.

#### HIGH BUG 5: Evolution loops always run (waste resources + Groq credits)
**Location:** `jarvis-evolution-v5.ts` → `startEvolutionLoopV5()`, `jarvis-evolution-v6.ts` → `startEvolutionLoopV6()`  
**Problem:** V1-V6 evolution loops run every 10-15 minutes via `setInterval` regardless of what the user is doing. During a focus session, these loops fire Groq calls in the background, wasting API credits and potentially causing rate limits.  
**Fix:** Check `studyState` before running evolution:
```typescript
// In each evolution loop:
if (loadSession().studyState === 'in-session') return  // Pause during focus
```

#### HIGH BUG 6: Wake word misses "Jarvis" in noisy environments
**Location:** `jarvis.ts` → `startWakeWord()` → `r.maxAlternatives = 3`  
**Problem:** With `maxAlternatives: 3`, Chrome STT gives 3 alternatives. Secondary alternatives only accepted if confidence ≥ 0.40. In noisy rooms, "Jarvis" can be transcribed as "Jarvis" in alt 2 or 3 with confidence 0.35-0.39, missing the threshold.  
**Fix:**
- Raise `maxAlternatives` to 5
- Lower secondary confidence threshold to 0.30
- Add more STT variants: `jarvis, jarviz, jarves, jarbs, jar vis, harvey, charvis`
- Use `r.continuous = true` for wake word (Chrome supports this now)

#### MEDIUM BUG 7: KB Jaccard threshold too strict
**Location:** `jarvis.ts` → `kbLookup()` function, `const SIM_THRESH = 0.55`  
**Problem:** "What is Article 21?" and "Explain Article 21 briefly" have <55% Jaccard similarity. Stored answers aren't reused. Users get Groq calls for identical questions phrased slightly differently.  
**Fix:** Lower to 0.40 and add bigram tokenization for better similarity detection.

#### MEDIUM BUG 8: Proactive engine runs in background tab
**Location:** `jarvis.ts` → `startProactiveEngine()` → multiple `setInterval` calls  
**Problem:** Reminder check (10s), intelligence nudges (3min), Focus Guardian (1min) all fire via setInterval even when browser tab is hidden. This drains battery on mobile.  
**Fix:** Use `document.addEventListener('visibilitychange')` to pause/resume intervals.

#### MEDIUM BUG 9: Quiz wrong answers not enrolled in SRS
**Location:** `jarvis.ts` → `handleQuizAnswer()` function  
**Problem:** When user gets quiz wrong, `_mem.weakTopics` is updated but NO Supabase `revisions` row is created. The wrong topic never appears in the spaced repetition queue.  
**Fix:** After wrong answer, call `revisionsRepo.create({ lectureId: null, topic: _quizTopic, dueDate: tomorrow, interval: 1 })`

#### LOW BUG 10: Clap threshold resets EMA on every page load
**Location:** `jarvis.ts` → `startClapWatch()` → `let _emaAmb = 40`  
**Problem:** The ambient noise EMA starts at 40 every page load and takes 3-5 seconds to converge. During this warmup, any loud sound can trigger a false clap. The `warmup < 32` guard exists but 32 frames × 45ms = only 1.44 seconds — not enough.  
**Fix:** Save EMA to localStorage and restore on load. Extend warmup to 60 frames (2.7 seconds).

---

## SPECIFIC IMPROVEMENTS REQUESTED

### 1. CLAP CALIBRATION — COMPLETE OVERHAUL
The clap system needs to be redesigned from scratch. Current issues:
- False positives from: AC noise, music, speech
- False negatives in quiet rooms (threshold too high)
- Auto-starts timer sometimes (clap event propagates to DOM)
- No visual feedback during calibration

**Required implementation:**
```typescript
// New clap system design:
// 1. ML-inspired: track rolling stats (mean, std dev) of last 100 frames
// 2. A real clap must be: mean + 3*stddev above baseline
// 3. Clap SHAPE verification: amplitude must rise in <2 frames AND drop in <4 frames
// 4. Gap between clap 1 and 2: strictly 80ms-800ms
// 5. After double-clap fires: set global suppress for 2.5 seconds
// 6. NEVER process claps when: _state==='listening', _isSpeaking, timer just started
// 7. Add visual clap indicator: button pulses amber briefly to confirm clap detected
// 8. Calibration: run 3-second ambient measurement, set threshold = mean + 2.5*stddev
```

### 2. SMART CONTEXT INJECTION
Replace the stripped `buildPersonalContext()` with an intelligent, query-aware system:
- Detect query category: UPSC/general/app-control
- For UPSC queries: inject full preparation context
- For general queries: inject only name and language preference
- For app-control: inject current section and timer state

### 3. CONVERSATION MEMORY (Multi-turn Groq)
Currently each Groq call is stateless. Add conversation history:
```typescript
// Keep last 6 turns in _history (already exists but not sent to Groq)
// Send them as messages array to Groq for coherent multi-turn dialogue
// This makes JARVIS feel like a real conversational AI, not a search engine
```

### 4. VOICE ACTIVITY DETECTION (VAD) IMPROVEMENT
Current STT reliability issues:
- `commit()` triggers on every `onend` even if no speech
- `silenceTimer` at 1.8s misses some slow speakers
- No interim confidence gating

**Fix:** Add energy-based VAD before committing STT result.

### 5. ADVANCED FEATURES TO ADD

#### A. Pomodoro Intelligence
- Track which topics are studied in each Pomodoro
- After 4 Pomodoros: smart break suggestion based on fatigue model
- "Pomodoro analysis" command: shows which sessions were most productive

#### B. Smart Reading Mode
- "Read my analytics" → JARVIS reads out all stats in a natural sentence
- "Read today's plan" → reads all pending lectures for today
- "Read my recent mistakes" → reads last 5 mistake entries

#### C. Intelligent Reminder System
- "List my reminders" → reads active reminders
- "Cancel reminder for [topic]" → cancels specific reminder
- "Remind me every day at 9pm to revise Polity" → recurring reminders

#### D. Voice-Controlled Note Search
- "What notes do I have on Article 21?" → queries Supabase notes → reads aloud
- "Search my notes for biodiversity" → full-text search

#### E. Study Analytics Voice Reports
- "How much have I studied this week?" → weekly breakdown by day
- "Which subject has my lowest score?" → subject-wise analysis
- "What's my Pomodoro average this month?" → session statistics

#### F. Adaptive Quiz Difficulty
- Track per-topic accuracy across sessions
- If accuracy > 80%: increase difficulty
- If accuracy < 50%: simplify questions, add more hints
- "Adjust my quiz level automatically" command

#### G. Pre-Exam Countdown Intelligence
- Auto-calculate days until Prelims/Mains from settings
- Morning brief includes countdown when < 100 days
- Suggest revision priority based on days remaining

#### H. Screenshot Analysis (Vision)
- "Analyze this question" + screenshot → JARVIS reads and answers
- "What's wrong with my answer?" + photo of handwritten answer → evaluation

#### I. Multi-Device Sync Status
- "Are my notes synced?" → checks Supabase sync queue
- Real-time sync indicator in JARVIS panel
- "Sync now" command → forces immediate Supabase sync

#### J. Focus Session Intelligence
- Detect context switches (keyboard/mouse idle → active)
- Track "real focus time" vs "time with timer running but distracted"
- End-of-session report: "You were focused for 38 of 50 minutes"

---

## PRIORITY IMPLEMENTATION ORDER

**Claude Code should implement these in this exact order:**

### STEP 1 — Critical Bug Fixes (do first, nothing else works right otherwise)
1. Fix `startClapWatch()` — stop auto-triggering timer, reduce false positives
2. Fix `buildPersonalContext()` — conditional context injection
3. Fix all CMDS section ID mismatches (`routine` → `routine-section` etc.)
4. Remove double Groq call in streaming mode
5. Add `studyState` check to evolution loops (pause during focus session)

### STEP 2 — Reliability Improvements
6. Lower KB Jaccard threshold to 0.40
7. Add `visibilitychange` event to pause proactive intervals in background
8. Extend clap warmup to 60 frames, save EMA to localStorage
9. Lower wake word secondary confidence to 0.30, add more STT variants
10. Fix `scr()` to log and speak error when section not found

### STEP 3 — Response Quality
11. Add conversation history to Groq messages (last 6 turns)
12. Add Smart Reading Mode ("read my analytics", "read today's plan")
13. Add "list reminders" and "cancel specific reminder" commands
14. Wire quiz wrong answers to SRS queue (create Supabase revision row)

### STEP 4 — New Features
15. Pomodoro Intelligence (topic tracking per session)
16. Adaptive Quiz Difficulty (per-topic accuracy tracking)
17. Voice note search ("what notes on Article 21?")
18. Pre-exam countdown in morning brief
19. Intelligent multi-reminder system
20. Focus session real-time analysis

### STEP 5 — Architecture
21. Split `jarvis.ts` (7000 lines) into:
    - `jarvis-core.ts` — init, state, speak, listen
    - `jarvis-handlers.ts` — processQuery handlers
    - `jarvis-quiz.ts` — quiz, Socratic, debate, interview
    - `jarvis-proactive.ts` — already separate, just expand
22. Consolidate V1-V6 evolution into single `jarvis-evolution-unified.ts`
23. Move KB from localStorage to Supabase for cross-device sync

---

## CLAP CALIBRATION — COMPLETE SPECIFICATION

This is the most important single fix. Write the complete new `startClapWatch()` function with these exact characteristics:

```typescript
// TARGET BEHAVIOR:
// ✅ Responds to: sharp hand clap (natural indoor clap, ~60-80dB SPL)
// ✅ Responds to: desk knock (sharp impact on hard surface)  
// ❌ Ignores: speech (sustained, low-freq, slow-changing)
// ❌ Ignores: music/TV (periodic, sustained)
// ❌ Ignores: AC/fan noise (continuous, high-freq but low-amplitude)
// ❌ Ignores: footsteps (low-freq, no high-freq content)
// ❌ NEVER starts timer or clicks any DOM element as a side effect
// ❌ Does not fire when JARVIS panel is in listening state
// ❌ Does not fire when _isSpeaking is true

// ALGORITHM:
// Frame rate: 50ms setInterval (20fps)
// FFT size: 256 bins
// High-freq RMS = sqrt(sum(bins[128:256]^2) / 128)  — upper half only (clap is wideband)
// EMA ambient = 0.03 * hfRms + 0.97 * EMA          — very slow adaptation (~5s convergence)
// Full EMA warmup: 80 frames = 4 seconds (save to localStorage on close, restore on load)
// 
// CLAP GATE (all must be true):
// Gate 1: hfRms > max(EMA * 2.4, 22)                — loud relative to ambient
// Gate 2: hfRms - prevHfRms > 12                    — SHARP rise (transient)
// Gate 3: streak < 4                                 — SHORT duration (not sustained)
// Gate 4: !_isSpeaking && _state !== 'listening'     — JARVIS is idle
// Gate 5: now - suppress > 80ms                      — debounce
//
// DOUBLE-CLAP DETECTION:
// First clap: store timestamp + amplitude
// Second clap within 80-800ms of first: FIRE
// Amplitude ratio between clap 1 and clap 2: must be within 45% of each other
// 
// ON FIRE:
// _clapEnabled = false
// setTimeout(() => _clapEnabled = true, 2500)  — 2.5s suppress after wake
// DO NOT click any DOM element
// Only call: _everActivated = true; openPanel(false); greetWake(); wakeAndListen()
```

---

## WHAT TO DELIVER

For EACH item above, provide:

1. **Exact file path** (e.g., `src/features/jarvis.ts`)
2. **The specific function/line to change** (describe it precisely)
3. **The complete new code** (not pseudocode — actual working TypeScript)
4. **Why the change fixes the issue**
5. **How to test it** (exact steps to verify)

After all individual fixes, provide:
6. **A complete `jarvis-clap-v2.ts`** — entirely new clap module
7. **Updated `buildPersonalContext()` with conditional injection**
8. **Updated `startWakeWord()` with better sensitivity**
9. **A `jarvis-conversation.ts`** module for multi-turn memory
10. **Step-by-step deployment instructions** (npm run build, git commit, vercel deploy)

---

## RULES FOR YOUR RESPONSE

1. **No pseudocode** — Every code snippet must be copy-paste ready TypeScript that compiles without errors
2. **No "you could consider"** — Be definitive: "Do this exactly"
3. **No skipping edge cases** — Every fix must handle: offline state, no Groq key, empty results, timer running, panel closed
4. **Test each fix** — Provide the exact voice phrase or typed command to test each change
5. **Respect existing architecture** — Don't replace the whole system. Surgical, targeted changes only
6. **TypeScript strict mode** — No `any` types in new code. No `@ts-ignore`
7. **Always import** — If you add a new function that imports from another module, show the import line
8. **Service worker** — After any JS change, remind to bump `public/sw.js` CACHE version (currently `mission2028-v7`)

---

## ADDITIONAL CONTEXT: KEY EXISTING CODE PATTERNS

```typescript
// How JARVIS responds:
respond(text: string)   // adds to chat + speaks aloud + sets lastReply

// How JARVIS speaks without adding to chat:
speak(text: string)     // TTS only

// How to scroll to a section:
scr('plan')             // scrolls to #plan
scr('intel')            // scrolls to #intel  
scr('engine')           // scrolls to #engine
scr('routine-section')  // scrolls to #routine-section
scr('constitution-section') // scrolls to #constitution-section

// How to click a button by ID:
cl('cm-add-score')      // clicks #cm-add-score
cl('cm-settings')       // clicks #cm-settings

// How to check Groq availability:
const GROQ_AVAILABLE = !!(import.meta.env.VITE_GROQ_API_KEY)
isGroqOnline()          // checks both key AND navigator.onLine

// How to get app state:
getCurrentState()       // returns CoreState with streak, backlog, today, performance

// How to detect language:
detectResponseLang(text)  // returns 'en' | 'hi' | 'hinglish'

// How to do language-aware responses:
L(lang, englishText, hindiText, hinglishText)

// How to show a nudge (outside panel):
showNudge(message)     // flashes JARVIS button + speaks

// Study state:
updateStudyState('in-session' | 'break' | 'idle' | 'quiz')
loadSession().studyState  // read current state

// Timer:
_isSpeaking              // true if TTS is playing
_state                   // 'idle' | 'listening' | 'thinking' | 'speaking'
_jarvisEnabled           // true if JARVIS is ON

// Clap specific:
_clapEnabled             // set false to temporarily disable clap
_emaAmb                  // current ambient EMA value
_clapThreshold           // calibrated threshold (0 = use dynamic EMA-based)
```

---

## FINAL GOAL

When you finish implementing everything above, JARVIS should:

- **Never** give wrong time/date answers
- **Never** accidentally start the timer via clap side effect  
- **Always** open the command bar when asked
- **Always** navigate to the correct section
- **Respond to any question in the world** with appropriate context
- **Remember the last 6 turns** of conversation for coherent dialogue
- **Know Om's UPSC preparation status** for UPSC questions
- **Be a silent, respectful assistant** during focus sessions (no background Groq calls)
- **Work flawlessly offline** for all local queries
- **Speak with the right voice personality** and never give long unnecessary answers
- **Learn from mistakes** — KB improves as user interacts
- **Clap twice** to wake from anywhere, reliably, without false positives
- **Be interrupted mid-speech** by saying "Jarvis"

This is the most important personal AI assistant in Om's UPSC journey. Every interaction must be reliable, accurate, and respectful of his study time. Make it perfect.

---

*End of prompt. Now begin your analysis and implementation.*
