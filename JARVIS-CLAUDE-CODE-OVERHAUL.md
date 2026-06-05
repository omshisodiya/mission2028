# JARVIS Overhaul — Claude Code Master Prompt & Run Guide

This document has two parts:

- **Part A — How to run it** (setup, phase rhythm, what *you* must test by hand).
- **Part B — The prompt** to paste into Claude Code. It's marked with clear `>>> START` / `<<< END` fences so you can select exactly the right block.

The prompt is written for **Claude Code** (agentic, has direct repo access), not a chat session. It tells Claude to read your real code before touching it, work in safe phases, verify each change compiles, and stop for your manual sign-off on anything it physically cannot test (audio/voice).

---

## PART A — HOW TO RUN THIS

### 0. One-time setup (do this yourself, before pasting anything)

```bash
cd "c:\Users\omshi\Downloads\UPSC PREPARATIONS (1)"

# Make sure your working tree is clean and pushed
git status
git add -A && git commit -m "checkpoint: pre-overhaul baseline" && git push

# Create a safety branch for the whole effort
git checkout -b jarvis-overhaul

# Confirm the build is green BEFORE any changes (baseline)
npm install
npx tsc --noEmit      # note any pre-existing errors so you don't blame Claude for them
npm run build
```

If `npx tsc --noEmit` already shows errors on a clean tree, **tell Claude Code that up front** so it doesn't waste time "fixing" pre-existing noise.

### 1. The phase rhythm

The prompt forces Claude Code to work in **5 phases**, lowest-risk first. After every phase it must:

1. Run `npx tsc --noEmit` and `npm run build` — both must pass.
2. Commit that phase on its own (`git commit`), so any phase can be reverted alone.
3. **Stop and hand you a test checklist** before starting the next phase.

Do **not** let it run all 5 phases unattended. The clap and wake-word fixes (Phase 1 & 2) can only be validated by a human with a microphone — that's you.

### 2. What only you can test (Claude Code cannot)

| Fix | How you verify |
|-----|----------------|
| Clap-to-wake no longer starts timer | Double-clap 20× in a quiet room + 10× with a fan/AC on. Timer must **never** start as a side effect. |
| Clap false positives | Talk, play music, type loudly for 2 min. Clap must not fire. |
| Clap in quiet room | Single sharp clap pairs must wake reliably. |
| Wake word in noise | Say "Jarvis" 10× with background noise. |
| Interrupt mid-speech | While JARVIS is talking, say "Jarvis" — it must stop and listen. |
| TTS/voice personality | Switch personalities, confirm voice changes. |

### 3. Deployment (after ALL phases pass and you've tested)

```bash
# bump the service worker cache version FIRST (Claude will tell you the new value)
# public/sw.js  ->  mission2028-v7  becomes  mission2028-v8

npm run build
git add -A && git commit -m "JARVIS overhaul: phases 1-5"
git checkout main
git merge jarvis-overhaul
git push          # Vercel auto-deploys from main
```

After deploy, hard-refresh `https://mission2028.vercel.app` (Ctrl+Shift+R) so the new service worker takes over.

---

## PART B — THE PROMPT FOR CLAUDE CODE

Select everything between the fences and paste it as your first message in Claude Code, opened inside the project root.

```
>>> START — PASTE INTO CLAUDE CODE <<<

You are working in the Mission 2028 repository — a Vite + TypeScript (vanilla, no React)
UPSC-prep web app with a voice AI assistant called JARVIS. Stack: Groq API
(llama-3.3-70b-versatile + llama-3.1-8b-instant), Web Speech API, Supabase. Deploys to
Vercel from `main`. The JARVIS code lives in `src/features/jarvis*.ts` (~17 modules,
~14,500 lines; `jarvis.ts` alone is ~7,000 lines).

I am the developer (Om). This is my real, deployed app, so reliability matters more than
cleverness. Work surgically. Do not rewrite systems that already work.

## GROUND RULES (read fully before doing anything)

1. EXPLORE BEFORE EDITING. Do not trust any line numbers, variable names, or code snippets
   I give you — they may be stale. Before changing a function, open the actual file and read
   the current implementation. Use grep/search to locate things. If what you find contradicts
   my description, trust the code and tell me.

2. WORK IN PHASES. There are 5 phases below, ordered lowest-risk first. Complete ONE phase,
   then STOP. At each phase boundary you must:
   a. Run `npx tsc --noEmit` — it must pass (or only show errors that pre-existed; ask me if
      unsure which are pre-existing).
   b. Run `npm run build` — it must succeed.
   c. Commit the phase alone: `git commit -m "phase N: <summary>"`.
   d. Print a SHORT manual-test checklist for me (exact voice phrases / typed commands /
      clicks) and WAIT for my go-ahead before starting the next phase.

3. NEVER let a fix break something already working. These currently work and must keep
   working — treat any regression here as a failure:
   - Wake word + double-clap wake + interrupt-while-speaking
   - Local date/time/math engine (jarvis-smart-answers.ts)
   - The 200+ local UPSC facts
   - Streaming Groq responses
   - Command palette (Ctrl+K)
   - DOM control (click/fill/read)
   - Multi-language (English/Hindi/Hinglish)
   - Session memory across sessions

4. TYPE SAFETY. New code must be strict-mode clean: no `any`, no `@ts-ignore`, no
   `@ts-expect-error`. If existing code forces an `any` at a boundary, narrow it with a proper
   interface instead of propagating it. (First check whether tsconfig actually has
   `"strict": true`; if not, tell me — I may want to enable it.)

5. ANYTHING I CAN'T TEST IN AUTOMATION, YOU FLAG. You cannot test audio, microphone, TTS, or
   voice. For clap/wake-word/STT changes, implement carefully, then give me a precise human
   test protocol and tell me explicitly: "I cannot verify this myself — needs your mic test."

6. SERVICE WORKER. After any JS/CSS change that ships, the SW cache version in `public/sw.js`
   must be bumped (currently `mission2028-v7` → `mission2028-v8`). Do this once, at the very
   end, and remind me.

7. NO SCOPE CREEP. Implement exactly what each phase lists. If you spot another bug, note it
   in a running `OVERHAUL-NOTES.md` file but do NOT fix it unless I approve.

## PHASE 0 — RECON (do this first, no code changes)

Produce a file `OVERHAUL-NOTES.md` containing, for each item I list in Phases 1–5:
- the exact file + current function name + approximate current line range you found
- a 1-2 line note on whether the code matches my description or differs
- any item you could NOT locate (so we resolve it before editing)

Specifically locate and report the current state of:
- `startClapWatch()` and every clap-related var (`_clapEnabled`, `_emaAmb`, `_clapThreshold`,
  the setInterval frame rate, the debounce/MIN_GAP, the warmup guard)
- `buildPersonalContext()`
- `executeIntent()` and where it calls `llmRoute()` vs `streamGroqResponse()`; confirm whether
  there is a `_streamingEnabled`-style flag
- the CMDS array — grep for every `scr('routine')`, `scr('constitution')`, and any other
  `scr('X')` whose target element id is actually `X-section`. List the real DOM ids.
- the evolution loop entry points (V5/V6) and how `studyState` / `loadSession()` is read
- `kbLookup()` and its similarity threshold constant
- `startWakeWord()` (maxAlternatives, confidence handling, variant list, continuous flag)
- `startProactiveEngine()` and its setInterval handles
- `handleQuizAnswer()` and the revisions repo API (find the real method signature in the
  Supabase repo layer — do not assume `revisionsRepo.create({...})` exists; verify it)

STOP after recon. Show me OVERHAUL-NOTES.md and wait for my go-ahead.

## PHASE 1 — CRITICAL, LOW-RISK FIXES

1.1 Section-id mismatches (safest, do first).
    In the CMDS array (and anywhere else), replace `scr('routine')` → `scr('routine-section')`
    and `scr('constitution')` → `scr('constitution-section')`, plus any other mismatch your
    recon found. Then harden `scr(id)`: if it cannot resolve any id variant to a real element
    in the DOM, it must NOT report success — make it speak a brief honest error
    (language-aware via the existing L() helper) and return false. Find every caller that
    assumes a truthy return.

1.2 Double Groq call in streaming mode.
    In `executeIntent()` qa-answer path, when streaming is active, skip the `llmRoute()` call
    entirely and go straight to `streamGroqResponse()`. Guard it on the real streaming flag you
    found in recon. Ensure non-streaming mode is unchanged.

1.3 buildPersonalContext() — conditional injection.
    Change the signature to accept a query category and only inject full UPSC context for UPSC
    queries; for general/app-control queries inject just name + language preference. Reuse any
    existing query-classification you find (e.g. `_isObviousKnowledge`, router intents) rather
    than inventing a new classifier. Pull real fields from `getCurrentState()` — verify the
    shape (streak, today.subject, performance.prelimsAvg, selectionProbabilityPct) actually
    exists before referencing it; guard every optional with `?.` and nullish defaults. The bug
    this fixes: a time query was injecting lecture counts and producing "724 lectures" noise —
    confirm a time/date query now gets ZERO UPSC context.

1.4 Pause evolution loops during focus sessions.
    In the V5 and V6 evolution loop bodies, early-return when the session study state is
    'in-session'. Use the real accessor from recon. Do not disable the loops entirely — they
    must resume when state leaves 'in-session'.

Build, typecheck, commit as "phase 1". Give me the test checklist (typed commands are fine
here: open routine, open constitution, ask the time, ask a UPSC strategy question, start a
focus session and confirm no background Groq calls in the network tab).

## PHASE 2 — CLAP + WAKE-WORD RELIABILITY (I MUST MIC-TEST THIS)

Decision: fix clap IN PLACE inside the existing `startClapWatch()`. Do NOT create a parallel
`jarvis-clap-v2.ts` — a second module risks both running at once. (If after reading the code
you believe an extracted module is genuinely safer, propose it and wait for my approval before
writing it.)

Rewrite `startClapWatch()` to this spec, adapting variable names to what actually exists:

- Frame loop ~50ms (20fps). High-frequency RMS over the upper FFT bins (clap is wideband).
- Ambient EMA with slow adaptation (~0.03 new / 0.97 old). PERSIST the EMA to localStorage on
  page hide and restore on load so it doesn't cold-start at a fixed value every reload. Extend
  warmup to ~80 frames (~4s) before any clap can fire.
- A clap fires only if ALL hold:
  G1 hfRms > max(EMA * 2.4, <absolute floor you tune>)   — loud vs ambient
  G2 hfRms - prevHfRms > <transient delta>               — SHARP rise
  G3 sustained-frame streak < 4                           — short, not sustained (rejects speech/music)
  G4 NOT _isSpeaking AND _state !== 'listening'           — JARVIS idle
  G5 now - lastFire > 120ms                               — debounce (raise from any 60ms value)
- Double-clap: first clap stores timestamp+amplitude; second within 80–800ms fires; the two
  amplitudes must be within ~45% of each other.
- ON FIRE: set `_clapEnabled = false` and re-enable after 2500ms. Then ONLY call the existing
  wake path (mark activated, open panel, wake greeting, start listening). It MUST NOT click,
  focus, or dispatch any event toward any DOM element — in particular never toward
  `[data-act="start"]` or any timer control. Audit the current fire path and remove/avoid any
  code that could let the audio transient reach a DOM button.
- Optional nicety: briefly pulse the JARVIS button amber on a confirmed clap (visual ack only).

Then improve `startWakeWord()`: raise maxAlternatives to 5, lower the secondary-alternative
confidence acceptance to ~0.30, expand the variant list (jarvis, jarviz, jarves, jarbs,
jar vis, harvey, charvis), and set continuous mode if the current Chrome path supports it
without breaking the existing restart logic. Keep interrupt-while-speaking working.

Build, typecheck, commit as "phase 2". Then STOP and give me the full mic-test protocol from
the run guide. Tell me clearly you cannot verify any of this yourself.

## PHASE 3 — RESPONSE QUALITY & SMALLER FIXES

3.1 KB similarity threshold. Lower the Jaccard threshold to ~0.40 and add bigram tokenization
    so "What is Article 21?" and "Explain Article 21 briefly" match a stored answer. Verify the
    lookup function and prove with a quick comment example which pairs now match.

3.2 Background-tab throttling. In `startProactiveEngine()`, add a single
    `visibilitychange` listener that pauses the proactive/reminder/guardian intervals when
    `document.hidden` and resumes them on return. Do not drop reminders that were due while
    hidden — re-check on resume.

3.3 Conversation memory to Groq. There is an existing `_history` buffer that is not being sent
    to Groq. In `buildGroqMessages()`, append the last up-to-6 turns as proper
    role:user/role:assistant messages BEFORE the current user turn. Cap total injected history
    tokens conservatively. Confirm streaming still works and that history is cleared/scoped
    sensibly (don't leak quiz state into general chat).

3.4 SRS auto-enroll on quiz fail. In `handleQuizAnswer()`, when the answer is wrong, create a
    revision via the REAL repo method you found in recon (do not assume the signature). It must
    handle: offline (queue or skip gracefully, never throw), missing lectureId (topic-only
    revision), and duplicate topic (don't create a second identical due row).

Build, typecheck, commit as "phase 3". Test checklist: repeat a question two ways (KB hit),
background the tab and confirm intervals pause, hold a 3-turn UPSC conversation (coherence),
get a quiz answer wrong and confirm a revision row appears.

## PHASE 4 — NEW VOICE FEATURES (additive, low blast-radius)

Implement these as new handlers wired into the existing processQuery routing. Each must be
language-aware (L()), must work offline where the data is local, and must degrade gracefully
when Groq/Supabase is unavailable.

4.1 Smart Reading Mode: "read my analytics", "read today's plan", "read my recent mistakes" —
    read existing local/Supabase data aloud as natural sentences.
4.2 Reminder management: "list my reminders", "cancel reminder for <topic>". (Recurring
    reminders only if the existing reminder store supports it cleanly — otherwise note it for
    later, don't force it.)
4.3 Voice note search: "what notes do I have on <topic>" / "search my notes for <topic>" —
    query the Supabase notes table and read results. Handle zero results.
4.4 Pre-exam countdown: compute days to Prelims/Mains from settings and include it in the
    morning brief when under 100 days. Verify where exam dates are stored first.

Build, typecheck, commit as "phase 4". Test checklist with the exact phrases above.

## PHASE 5 — ARCHITECTURE (OPTIONAL, HIGHEST RISK — ASK BEFORE STARTING)

Do NOT begin Phase 5 unless I explicitly say "do phase 5". When I do:

5.1 Split `jarvis.ts` ONLY by moving cohesive, well-bounded groups into new files behind
    re-exports, one extraction per commit, building between each. Suggested cuts: quiz/Socratic/
    debate/interview → `jarvis-quiz.ts`. Keep init/state/speak/listen in core. Never move
    something whose dependencies you haven't traced. If any single extraction can't be done
    without a tangle of circular imports, stop and report rather than forcing it.
5.2 Do NOT consolidate V1–V6 or migrate KB to Supabase in this pass unless I ask — those are
    separate projects with their own risk.

## DELIVERABLES AT THE END

- All phases committed separately on the current branch.
- `OVERHAUL-NOTES.md` updated with what changed per item and anything deferred.
- The bumped `public/sw.js` cache version.
- A final summary: what changed, what I still need to mic-test, and the deploy steps.

Begin with PHASE 0 (recon) now. Do not write any production code until I approve the recon.

>>> END — PASTE INTO CLAUDE CODE <<<
```

---

## PART C — NOTES & JUDGEMENT CALLS I MADE

A few things in your original spec I deliberately changed, and why — so you can override me if you disagree:

1. **One clap implementation, not two.** Your prompt asked for both an in-place `startClapWatch()` fix *and* a brand-new `jarvis-clap-v2.ts`. Running two clap detectors risks double-firing and is exactly the kind of thing that causes the timer-side-effect bug you're trying to kill. I told Claude to fix in place and only extract a module with your approval.

2. **The timer side-effect is treated as the #1 invariant.** Rather than only debouncing, the prompt makes Claude *audit the fire path* and guarantee the clap handler never dispatches anything toward a DOM button. Debounce timing alone won't fix a real event-propagation leak — if the clap is genuinely reaching `[data-act="start"]`, the gates won't matter. Have Claude confirm in recon whether the fire path actually touches the DOM or whether the timer start is coincidental (e.g. the panel-open animation focusing a button).

3. **Verify the Supabase repo API before wiring SRS.** Your prompt assumed `revisionsRepo.create({ lectureId, topic, dueDate, interval })`. That signature may not exist. The prompt forces Claude to find the real method first — assuming an API that doesn't compile would stall the whole run.

4. **`strict` mode may not be on.** You asked for "no `any`," but if `tsconfig` isn't strict, new code can still slip. The prompt has Claude check and flag it to you rather than silently assuming.

5. **Architecture split is gated and optional.** Splitting a 7,000-line file is the single most likely thing to introduce a silent regression. I moved it behind an explicit "do phase 5" gate so you don't get it bundled with the bug fixes you actually need shipped.

One thing worth deciding before you start: do you want the conversation-history feature (Phase 3.3) at all? It adds latency and tokens to every Groq call and pushes you closer to the 30 req/min free-tier limit your health report flagged. If your sessions are mostly one-shot UPSC lookups rather than back-and-forth dialogue, it may not be worth it — you could cap it at 2 turns or skip it.

---

## PART D — ADVANCED CAPABILITY TRACK (Phase 6, optional, do AFTER 1–5 ship)

These are the upgrades that turn JARVIS from a command app into a genuine assistant: take
any command, control the whole site, answer anything. They are bigger and higher-risk than the
bug fixes, so they only start once phases 1–5 are deployed and stable. Each is its own gated
sub-phase — do not bundle them.

### 6A — Command brain → Groq tool-calling (the biggest leap)
Replace the brittle 994-entry CMDS matching with structured tool/function calling, kept HYBRID:
- Keep the existing local fast-path for the ~50 most common commands (instant, offline, zero
  tokens). Only fall through to the model when the fast-path misses.
- Define a tool schema the model can call: `navigate(section)`, `click(description)`,
  `fill(field, value)`, `start_timer` / `pause_timer` / `reset_timer`, `set_timer(minutes)`,
  `add_score(...)`, `search_notes(query)`, `set_reminder(...)`, `open_command_bar`,
  `answer_knowledge(query)`, `web_search(query)`.
- Use the 8B model for routing/tool selection (fast/cheap) and 70B only for `answer_knowledge`.
- Each tool handler reuses your EXISTING functions (scr, cl, DOM control, repos) — the model
  just decides which to call with what arguments. The CMDS array shrinks to the fast-path only.
- Why it matters: "do any command" finally works from ANY phrasing, not just pre-written regex.
- Cost/risk: adds a Groq round-trip for uncommon commands → mind the 30 req/min free tier;
  the local fast-path is what keeps this affordable. Implement tool-call timeout + offline
  fallback to "I can't reach Groq, here's what I can do locally."

### 6B — Page-aware control (own the whole site)
- Build a `getPageSnapshot()` that returns visible sections + every actionable element with a
  human label (button text, input name/placeholder, aria-label). Pass a compact version of this
  to the model alongside tool calls so `click("add a new score")` resolves reliably.
- Tag actionable elements with stable `data-jarvis-action="..."` attributes so targeting never
  depends on guessing CSS ids.
- This is what makes universal click/fill trustworthy instead of silent failures.

### 6C — Real always-on wake word (Picovoice Porcupine, WASM)
- Replace the STT-based wake word with Porcupine running a custom "Jarvis" keyword on-device
  (WASM). Train the `.ppn` keyword file in the free Picovoice Console.
- Far fewer misses in noisy rooms, much lower CPU/battery than continuous STT, and it stops
  fighting the command recognizer for the mic.
- Keep Web Speech API only for the actual command transcription AFTER wake.
- Dependency: a free Picovoice access key (personal use). Note it in env vars.

### 6D — AudioWorklet + VAD for clap and speech timing
- Move all audio analysis (currently a `setInterval` poll) into an `AudioWorklet`. Audio-thread
  timing is far more reliable and removes main-thread jank — this directly improves clap
  robustness.
- Add Silero VAD (e.g. `@ricky0123/vad-web`) so JARVIS knows when speech actually starts and
  ends, replacing the fixed 900ms reopen delay and 1.8s silence timer with real detection.
- Do clap onset detection (spectral flux / sharp transient) inside the worklet using the gates
  from Phase 2. This supersedes the Phase 2 in-place fix — so only do 6D if Phase 2 still isn't
  reliable enough after mic testing. (If Phase 2 is good enough, skip 6D — don't rewrite working
  audio for its own sake.)

### 6E — Answer anything (web search + notes RAG)
- Add a `web_search(query)` tool backed by a search API with a free tier (Tavily or Brave
  Search). The model calls it for current affairs and anything past its training cutoff, then
  summarizes briefly and (for spoken answers) names the source in one short clause.
- Add lightweight RAG over the Supabase notes table: embed notes, retrieve top-k for personal
  questions ("what did I note on biodiversity?").
- This is what closes the "no current affairs by design" gap — critical for UPSC.
- Dependency: a search API key in env vars; keep results short to control tokens/latency.

### 6F — Consolidate, don't expand, the evolution engine
- Do NOT build a V7. Collapse V1–V6 into ONE loop with one setInterval, one localStorage
  namespace, and the focus-session pause from Phase 1. Move cap storage to IndexedDB. This is a
  reliability and battery win, not a new feature — treat it as cleanup.

---

## PART E — KICKOFF PROMPT FOR CLAUDE CODE (the "read the file" prompt)

### First, put this file where Claude Code can read it
Claude Code reads from your repo, not from a download folder. Copy this file into the project:

```bash
# from your project root
mkdir -p docs
copy "JARVIS-CLAUDE-CODE-OVERHAUL.md" docs\JARVIS-CLAUDE-CODE-OVERHAUL.md   # Windows
# (or just drag the file into a docs/ folder in the repo)
```

### Then paste this as your first message in Claude Code:

```
Read docs/JARVIS-CLAUDE-CODE-OVERHAUL.md in full. It is the authoritative plan for overhauling
the JARVIS voice assistant in this repo (src/features/jarvis*.ts).

Follow it exactly:
- Obey every GROUND RULE in Part B (explore before editing, never trust line numbers, work in
  phases, typecheck + build + commit + wait for my sign-off at each phase boundary, no scope
  creep, flag anything you can't mic-test).
- Start with PHASE 0 (recon) only. Produce OVERHAUL-NOTES.md and STOP for my approval before
  writing any production code.
- Do NOT start Phase 5 (architecture) or Part D (the advanced track) unless I explicitly tell
  you to — those are gated.

Before you begin, confirm: (1) the build is currently green by running `npx tsc --noEmit` and
`npm run build` and reporting any PRE-EXISTING errors so we don't confuse them with regressions,
(2) whether tsconfig has "strict": true. Then begin Phase 0 recon.
```

That's all you paste. Claude Code will read the whole plan from the file and drive the rest
itself, stopping at each phase for you.