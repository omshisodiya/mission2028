# Mission 2028 — UPSC Command Center · Build Blueprint

**For:** Om Shisodiya · CSE 2028 · PW IAS Prarambh 2027
**Role of this doc:** the single source of truth handed to Claude Code. Read top to bottom once, then build phase by phase.
**Cost target:** ₹0/month (Supabase free + Vercel/Cloudflare free).
**Golden rule:** the cinematic shell (`engine.js`, `styles.css`, the HTML, the VFX, the scroll choreography) is *finished and high-fidelity*. We do **not** rewrite it. We pour a real preparation engine and a real backend *behind* it.

---

## 0. The one architectural truth

Everything in the prototype reads and writes through a single object in `engine.js`:

```js
const store = {
  data: JSON.parse(localStorage.getItem('mission2028') || '{}'),
  get(k, def) { ... },
  set(k, v) { ... },
};
```

This is the **only** integration point we touch in the existing engine. We make it async, hydrate it from Supabase on boot, and write through to Supabase on every `set`. Every existing feature (`focusTimer`, `buildStreak`, `planner`, `rankSim`, `heatmap`, `donuts`, `commandTodo`, `aiPlan`) keeps working unchanged, because they all already speak `store`.

Two data layers sit behind it:

1. **KV layer** (`app_state` table): simple blob state — `focusLog`, `sessTotal`, `focusMins`, `todos`, `rankInputs`, `settings`. Maps 1:1 to today's `store` keys. Zero refactor.
2. **Relational layer** (real tables): structured entities the planner and analytics need — `lectures`, `topics`, `mock_tests`, `answer_practice`, `current_affairs`, `revisions`, `plan_days`. The hardcoded `PLAN[]` becomes a query against `lectures`.

That's the whole strategy. Keep the art, swap the data.

---

## 1. Stack (chosen, not optional)

| Concern | Choice | Why |
|---|---|---|
| Build tool | **Vite + TypeScript** | Env vars for Supabase keys, code-split, fast HMR, keeps existing vanilla code intact |
| App code | **Vanilla TS, keep `engine.js`'s IIFE patterns** | The motion is hand-tuned; porting to React risks ruining it. Add features as modules, exactly as the README says ("write a function, call it in `boot()`") |
| React | **NOT used in production.** Pure vanilla TS only. | Fewer moving parts = reliable first build. Forms (import wizard, mock entry, settings) are built in vanilla TS to match the existing codebase. `tweaks-panel.jsx` stays a dev-only authoring aid, not shipped |
| Backend | **Supabase** (Postgres + Auth + Storage + Edge Functions) | Free tier: 500 MB DB, 1 GB files, 50k users — ~100× what one aspirant needs |
| Hosting | **Vercel** or **Cloudflare Pages** | Free, instant deploy from GitHub, PWA-friendly |
| Auth | **Supabase magic-link**, single user, RLS locked to your `auth.uid()` | It's on the public internet; one row of auth keeps your data yours |
| Excel import | **SheetJS (`xlsx`)**, client-side | Parse your PW lecture list in the browser, insert to Supabase |
| Keep-alive | **GitHub Actions cron** (daily ping) | Free-tier projects pause after 7 days idle; a daily query prevents it |
| Notifications | Web Push + **Supabase Edge Function + cron** for email digests | Revision-due and streak-risk nudges |

**Folder shape (target):**
```
/public            → fonts (self-hosted), manifest.json, icons, sw.js
/src
  /engine          → engine.js (kept), image-slot.js, styles.css
  /data            → supabase.ts (client), repositories/ (lectures, tests, ca, ...)
  /services        → planner.ts (Master Planner), srs.ts (spaced repetition), analytics.ts
  /islands         → React components (import-wizard, mock-entry, settings) — optional
  /sync            → store-sync.ts (the async store seam + offline queue)
  main.ts          → boots engine + hydrates store
index.html         → from UPSC_Mission_2028.html
.github/workflows  → keepalive.yml
supabase/          → schema.sql, migrations, edge functions
```

---

## 2. The `store` → Supabase migration (do this first, it unblocks everything)

Convert `store` into a write-through cache with an offline queue. Behaviour:

- **Boot:** `await sync.pull()` → one read of `app_state` for this user → seed `store.data`. Render instantly from local cache (works offline).
- **`store.set(k, v)`:** write `localStorage` immediately (optimistic) **and** enqueue a debounced push to Supabase.
- **Offline:** writes stay queued in `localStorage`; flush on reconnect.
- **Conflict policy:** last-write-wins per key (correct for one user across phone + laptop).

```ts
// sync/store-sync.ts  (sketch)
export const store = {
  data: {} as Record<string, any>,
  async pull(userId: string) {
    const rows = await sb.from('app_state').select('key,value').eq('user_id', userId);
    this.data = Object.fromEntries(rows.data!.map(r => [r.key, r.value]));
    localStorage.setItem('mission2028', JSON.stringify(this.data));
  },
  get(k, def) { return k in this.data ? this.data[k] : def; },
  set(k, v) {
    this.data[k] = v;
    localStorage.setItem('mission2028', JSON.stringify(this.data));
    queuePush(k, v);            // debounced upsert into app_state
  },
};
```

Relational entities (lectures, tests, etc.) get their own repositories in `/data/repositories` and do **not** go through KV. The `planner()` function changes from reading `PLAN[]` to `await lectureRepo.list()`.

---

## 3. Feature set

### 3A. Existing prototype features → make real

| Feature (function) | Today | Becomes |
|---|---|---|
| Countdown (`countdown`) | hardcoded `2028-05-28` | configurable in settings; **three** anchors: Prelims, Mains, Interview |
| Focus timer (`focusTimer`) | logs to `focusLog` | unchanged logging, but minutes auto-credit to the active study block |
| Streak (`buildStreak`) | reads `focusLog` | real daily-activity streak + **consistency score** |
| Lecture planner (`planner` + `PLAN[]`) | 6 fake rows | data-driven from `lectures`; backlog/today/upcoming; filter by subject/week |
| Mock bar chart (`barCharts`) | hardcoded heights | real `mock_results` |
| Rank simulator (`rankSim`) | 3 sliders → fake AIR | seeded from real mock percentiles; outputs a **projected AIR band** with a clear "this is a self-benchmark, not a prediction" label |
| Heatmap (`heatmap`) | random `heatSeed` | real study-minutes-per-day, 26 weeks |
| Donuts (`donuts`) | static % | real **subject readiness** = f(coverage %, mock accuracy) |
| AI plan (`aiPlan`) | deterministic typewriter of fake text | **real Master Planner output** (§4); keep the typewriter purely as the reveal animation |
| Daily to-do (`commandTodo`) | persists `todos` | unchanged + surface "tasks remaining today" near the focus timer |
| Constitution (`constitution`) | static `ARTICLES[]` | optional: becomes a daily-article micro-revision card |

### 3B. New features to build (the actual preparation engine)

1. **Data ingestion (3 ways).** This replaces any idea of scraping PW.
   - **Bulk Excel/CSV import** — drop your PW Prarambh lecture list (columns: `subject, sequence, title, duration_min, status, week`). SheetJS parses → preview table → confirm → insert into `lectures`. This is the primary path: paste your whole course once.
   - **Single manual entry** — quick-add a lecture/topic/task.
   - **UPSC syllabus template** — a pre-loaded GS Pre + Mains + CSAT + Essay + Ethics tree (`subjects` → `topics` → `subtopics`) you load once; PW lectures map onto it.
   - *(If PW ever gives you a syllabus PDF/sheet, the importer ingests it. No scraping — it breaks, it's against their ToS, and it risks your account.)*

2. **Master Planner** — deterministic scheduler. Full spec in §4. The crown jewel.

3. **Spaced-repetition engine (SRS)** — SM-2-lite at lecture/topic level. After you finish an item, schedule revisions at expanding intervals; due revisions become fixed appointments the planner must place. Self-rated recall (Again/Hard/Good/Easy) adjusts the next interval.

4. **Backlog debt meter** — total backlog hours, projected clear-date (from the planner), and an "are you gaining or losing ground" trend. Fits the hero's "The comeback starts now" motif.

5. **Mock test analyzer** — log full-length Prelims (GS + CSAT) and Mains tests. Capture per-section: attempted, correct, wrong, score (with **negative-marking math**), time. Show accuracy by subject, time/question, attempt-vs-accuracy, and trend across attempts.

6. **PYQ + weightage tracker** — each topic carries a PYQ-frequency / weightage value. The planner front-loads high-yield topics. Ships with sensible default weights (editable).

7. **Answer-writing log (Mains)** — log question, word count, time taken, and self/mentor score against a rubric (intro, structure, content, examples/data, diagram, conclusion). Trend over time.

8. **Current-affairs module** — daily CA log linked to a syllabus topic; monthly compilation view; CA items can enter the SRS for revision.

9. **Daily briefing / assistant panel** — the "personal assistant" layer. One generated line per morning: *"Today: 4 blocks · 3h20m · 2 revisions due · 1 weekly mock pending. You're 6 lectures behind; this plan closes the gap by Aug 14."* Pure computation from planner + SRS + tests. No AI required.

10. **Reminders / nudges** — web push + optional email digest (Edge Function on cron): revisions due, block missed, streak at risk.

11. **Weekly/monthly review ritual** — short reflection log ("what slipped, why"), then a one-tap re-plan.

12. **Resource library** — attach PDFs/notes/links per topic (Supabase Storage, 1 GB free).

13. **PWA / offline-first** — installable on your phone, works on the metro with no signal, syncs when back online. (You'll use this daily on mobile — make it feel native.)

14. **Export / backup** — one-click JSON+CSV export, plus a weekly auto-export (free tier has no automated DB backups — this is your safety net).

15. **Focus Mode toggle** — strips heavy VFX (starfield, warp, constellation, cursor aura, tilt) for the daily grind: faster, calmer, battery-friendly. Cinematic Mode stays for motivation. *This is a tutor decision, not a tech one: the tool you open 6 hours a day must be calm; the spectacle is for the hero and the comeback narrative.*

---

## 4. The Master Planner (deterministic — "not an AI")

A transparent, re-runnable scheduler. Given your backlog, your daily hours, and your exam date, it produces a day-by-day plan and tells you honestly whether it's even possible.

### Inputs
- **Items**: each lecture/topic/test/revision with `{ subject, est_minutes, priority_weight, sequence, type, earliest_start, hard_deadline? }`.
- **Capacity**: study minutes per weekday (Mon–Sun) + date-specific overrides (leave = 0, exam days, low-energy days).
- **Anchors**: Prelims `2028-05-28` (editable), Mains, Interview.
- **Policy knobs**: SRS intervals, interleave on/off, final-buffer length (e.g. last 60 days = revision + mocks only), max minutes/subject/day, max consecutive same-subject.
- **Weightage**: per-subject and per-topic PYQ weights (defaults editable).

### Algorithm (explainable, idempotent)
```
1. Build a day calendar: today → furthest exam. Set each day's capacity from the
   weekday template, then apply date overrides.
2. Reserve the BUFFER phase: last N days carry only revisions + mock tests.
3. Place FIXED appointments first:
   - SRS revisions due on their date (immovable)
   - scheduled mock tests
   These consume capacity before anything else.
4. Score every learning item:
   score = w_subject × w_pyq × urgency(days_to_exam)
         × dependency_ready × backlog_penalty
   Higher weightage + more PYQs + more overdue ⇒ higher priority.
   Respect sequence within a subject (no Lecture 13 before 12 if marked sequential).
5. Greedy fill, day by day, up to remaining capacity:
   - interleave subjects (round-robin among top-eligible) to fight monotony
     and exploit interleaving's retention benefit
   - front-load high-yield within that constraint
6. After placing a learning item, auto-enqueue its SRS revisions
   at intervals [1, 3, 7, 16, 35, ...] days (clamped to the timeline).
7. FEASIBILITY CHECK:
   if Σ required_effort > Σ capacity_before_buffer  ⇒  DEFICIT.
   Never fail silently. Offer three remedies, with numbers:
     (a) "+38 min/day clears it"
     (b) auto-drop lowest-yield optional topics — show the exact cut list
     (c) extend the timeline to <date>
8. Output:
   - plan_days: date → ordered blocks (subject, item, minutes)
   - metrics: coverage %, projected completion date, avg daily load, deficit/surplus
9. RE-PLAN (the magic): on divergence (missed a block / finished early),
   recompute from TODAY forward only. Past stays logged; future redistributes.
   Fast and idempotent — safe to run on every app open.
```

This replaces `aiPlan()`'s fake builder. Keep the chakra spinner + typewriter as the *presentation* of the real result.

### Default GS weightage (editable in settings)
Polity, Modern History, Geography, Economy, Environment & Ecology, Science & Tech, Art & Culture, Current Affairs, CSAT. Seed with PYQ-frequency-based defaults; let the user tune. Store in `settings.weightage`.

---

## 5. Data ingestion: the PW import flow (concrete)

1. You export / type your Prarambh schedule into a spreadsheet with columns:
   `subject | sequence | title | duration_min | week | status (backlog|today|upcoming|done)`.
2. Import wizard (`/islands/import-wizard`): file drop → SheetJS parse → editable preview grid → "Import N lectures".
3. Rows insert into `lectures`; existing `lecture_progress` is preserved by `(user, lecture)` key.
4. Provide a **downloadable template .xlsx** so the columns are always right.
5. Manual single-add for stragglers. Syllabus-template loader for the GS topic tree.

No network calls to PW. Ever. (Honest CTO note repeated because it matters: scraping their authenticated, DRM'd app is brittle, against ToS, and risks your account — and would need rebuilding every time they ship an update. A one-time paste is permanent.)

---

## 6. Build phases (the order Claude Code should work in)

**Phase 0 — Scaffold & deploy skeleton.** Vite+TS project; move the 5 design files in unchanged; create the Supabase project; wire env vars; deploy a blank build to Vercel; add the keep-alive cron. *Done when the cinematic page loads from a real URL.*

**Phase 1 — Backend + the `store` seam.** Run `schema.sql`; magic-link auth; build `store-sync.ts` (async hydrate + write-through + offline queue). Migrate the KV keys. *Done when refreshing the page on your phone shows the same focus/streak data as your laptop.*

**Phase 2 — Real lectures + ingestion.** `lectures` repo; rewrite `planner()` to read from DB; build the Excel import wizard + template + manual add + syllabus template. *Done when your real Prarambh backlog shows in the lecture planner and check-offs sync.*

**Phase 3 — Master Planner.** `planner.ts` per §4; settings UI for capacity/exam dates/weightage; wire its output into the `#plan` section, replacing `aiPlan()`'s fake text. *Done when "Generate plan" produces a real, feasible, re-runnable schedule.*

**Phase 4 — Spaced repetition.** `srs.ts`; revision queue surfaced on `#plan`; SRS revisions feed the planner as fixed appointments. *Done when finishing a lecture schedules its future revisions automatically.*

**Phase 5 — Tests, analytics, answer writing, CA.** Mock entry + analyzer (real `barCharts`/`donuts`/`heatmap`/`rankSim`); answer-writing log; current-affairs module; daily briefing panel. *Done when every chart shows real numbers.*

**Phase 6 — Polish.** PWA + offline; web-push + email nudges; export/backup; Focus Mode toggle; weekly review ritual; self-host fonts; accessibility + reduced-motion pass. *Done when it's installable, calm in Focus Mode, and backs itself up.*

---

## 7. Honest risk register (CTO notes)

- **Supabase 7-day pause** → solved by the daily cron ping. Don't skip it.
- **Free-tier egress (5 GB/mo)** → fine for one user; serve images via Storage CDN, don't refetch large payloads.
- **No auto-backups on free tier** → the weekly export in Phase 6 is mandatory, not optional.
- **VFX vs. usability** → Focus Mode is the answer. Never make the daily-use surface fight the GPU.
- **Single-user but public URL** → RLS on every table (`auth.uid() = user_id`). The schema does this.
- **Scope creep** → ship Phase 1–3 first. A working planner with real data beats half of everything.

---

## 8. What I added that you didn't ask for (and why)

Spaced repetition (UPSC is a retention game, not a coverage game), PYQ-weighted prioritisation (study high-yield first), the daily briefing (your "assistant" line), negative-marking-aware mock analysis (Prelims is won on attempt strategy), Focus Mode (you'll thank me at hour 4), offline PWA (metro / patchy data), and the weekly export (because free tiers don't back up). These are the difference between a beautiful dashboard and a tool that actually moves your rank.
