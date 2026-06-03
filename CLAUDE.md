# CLAUDE.md — Mission 2028 UPSC Command Center

> **Authority:** This file is the source of truth for Claude Code. Where it conflicts with `BLUEPRINT.md`, **this file wins**. Read `BLUEPRINT.md` for the *why* and the full feature detail; read this for the *rules* and *order*.

## What this project is
A personal, single-user UPSC preparation command center for Om Shisodiya (CSE 2028, PW Prarambh 2027). A finished cinematic single-page front-end already exists (`engine.js`, `styles.css`, `UPSC_Mission_2028.html`, `image-slot.js`). Your job: wire a real Supabase backend and a real preparation engine *behind* that front-end **without rewriting the visuals**.

---

## HARD RULES (do not violate)

1. **Do not rewrite or restyle `engine.js`, `styles.css`, or the HTML structure.** They are high-fidelity and final. You only touch `engine.js` at **one** place: the `store` object (make it async / write-through). Add new behavior as *new modules* called from `boot()`, exactly as the README prescribes ("write a function, call it in `boot()`").
2. **Pure vanilla TypeScript. No React, no Next, no Tailwind, no UI framework in the shipped app.** Build forms and panels in vanilla TS matching the existing patterns. `tweaks-panel.jsx` is a dev-only authoring aid — do not ship it.
3. **Never scrape, call, or reverse-engineer Physics Wallah.** Lecture data comes only from Excel/CSV import, manual entry, or the syllabus template. No exceptions.
4. **The Master Planner is deterministic, not AI.** No LLM calls. It's a transparent scheduler (spec in `BLUEPRINT.md` §4). Keep the chakra-spinner + typewriter as presentation only.
5. **All state flows through `store` (KV) or a repository (relational).** No scattered `localStorage` or `fetch` calls in feature code.
6. **RLS is already on every table.** Never use the service-role key in client code. Browser uses the anon key only.
7. **Respect `prefers-reduced-motion` and ship a Focus Mode toggle** that disables heavy VFX. The daily-use surface must stay fast.
8. **Build phase by phase. Do not start a phase until the previous phase passes its acceptance test (below).** Commit at each gate.

---

## Stack (pinned — do not substitute)
- **Vite + TypeScript** (vanilla template, no framework).
- **Supabase** (`@supabase/supabase-js`) — Postgres + Auth (magic link) + Storage + Edge Functions.
- **SheetJS (`xlsx`)** — client-side Excel/CSV parsing for import.
- **Hosting:** Vercel (or Cloudflare Pages). PWA via a hand-written `sw.js` + `manifest.json`.
- **Keep-alive:** GitHub Actions scheduled workflow pinging Supabase daily.

### Commands
```
npm install
npm run dev        # local dev
npm run build      # production build
npm run preview    # verify the production build locally
```

### Env (`.env`, never commit; provide `.env.example`)
```
VITE_SUPABASE_URL=__from Om__
VITE_SUPABASE_ANON_KEY=__from Om__
```

---

## File map (target)
```
index.html                  ← UPSC_Mission_2028.html, unchanged structure
public/
  manifest.json  sw.js  icons/  fonts/        (self-hosted fonts in Phase 6)
src/
  engine/        engine.js (kept), image-slot.js, styles.css
  data/
    supabase.ts                                (createClient, anon key)
    repositories/ lectures.ts topics.ts mocks.ts answers.ts ca.ts plan.ts
  services/
    planner.ts                                 (Master Planner — BLUEPRINT §4)
    srs.ts                                      (SM-2 lite)
    analytics.ts                               (heatmap/donut/rank/streak math)
    briefing.ts                                (daily assistant line)
  sync/
    store-sync.ts                              (the async store seam + offline queue)
  features/                                    (vanilla UI modules called from boot())
    import-wizard.ts mock-entry.ts settings.ts review.ts
  main.ts                                       (auth gate → hydrate store → boot engine)
supabase/ schema.sql  functions/ (edge: nudges, export)
.github/workflows/keepalive.yml
.env.example
```

---

## The `store` seam (the only edit to engine.js)
Replace the synchronous `localStorage` store with a write-through cache:
- On boot, after auth, `await storeSync.pull(userId)` loads `app_state` rows into `store.data`, then mirror to `localStorage` for offline.
- `store.get(k, def)` stays synchronous (reads the in-memory cache) so **no existing feature code changes**.
- `store.set(k, v)` writes `localStorage` immediately + debounced upsert into `app_state` (offline → queue → flush on reconnect).
- Relational entities (lectures, tests, CA, plan) use repositories, **not** `store`. Rewrite `planner()` to read `await lecturesRepo.list()` instead of the `PLAN[]` constant.

KV keys to preserve exactly: `focusLog`, `sessTotal`, `focusMins`, `todos`, `rankInputs`, `heatSeed`→(replace with real sessions), `lectures`→(migrate to `lectures.done`), `settings` (new).

---

## HUMAN SETUP CHECKLIST (Om does these — they are not code)
Claude Code: surface these to the user at the right phase; do not attempt to do them yourself.
1. Create a Supabase project (free tier) → copy `Project URL` + `anon public key` into `.env`.
2. Supabase Studio → SQL Editor → paste & run `supabase/schema.sql`.
3. Authentication → Providers → enable **Email (magic link)**; add the deployed URL to redirect allow-list.
4. Storage → create a private bucket named `resources` (Phase 6).
5. Push repo to GitHub; import into Vercel; add the two env vars in Vercel; deploy.
6. Add the daily keep-alive workflow secret (Supabase URL) so the project never auto-pauses.
7. Prepare the PW lecture list as `.xlsx` (template provided by the import wizard) for Phase 2.

---

## BUILD ORDER + ACCEPTANCE TESTS (gate each one)

**Phase 0 — Scaffold.** Vite+TS; move the 4 design files in unchanged; `supabase.ts`; deploy blank build.
✅ *Pass:* the cinematic page loads, pixel-identical to the prototype, from a live Vercel URL.

**Phase 1 — Backend + store seam + auth.** Magic-link gate; `store-sync.ts`; migrate KV keys; keep-alive cron.
✅ *Pass:* log in on laptop, record a focus session; open on phone, same session shows. Works offline then syncs.

**Phase 2 — Lectures + ingestion.** `lectures` repo; `planner()` reads DB; Excel import wizard + downloadable template + manual add + syllabus template.
✅ *Pass:* import a real `.xlsx` of Prarambh lectures; they appear in the planner; check-offs persist across reload and devices.

**Phase 3 — Master Planner.** `planner.ts` per BLUEPRINT §4; settings (capacity per weekday, exam dates, weightage); feed output into `#plan`, replacing `aiPlan()` fake text.
✅ *Pass:* "Generate plan" returns a real day-by-day schedule; an infeasible backlog shows the deficit + 3 numbered remedies; missing a block and re-running redistributes only future days.

**Phase 4 — Spaced repetition.** `srs.ts`; revision queue on `#plan`; due revisions injected into the planner as fixed appointments.
✅ *Pass:* completing a lecture creates revision rows at [1,3,7,16,35]-day intervals; due ones appear in today's plan.

**Phase 5 — Tests / analytics / answer writing / CA / briefing.** Mock entry + negative-marking analyzer; real `barCharts`/`donuts`/`heatmap`/`rankSim`; answer-writing log; current-affairs; daily briefing line.
✅ *Pass:* every chart reflects real entered data; the briefing panel prints an accurate one-liner from live planner + SRS + test data.

**Phase 6 — Polish.** PWA install + offline; web-push + email nudge Edge Function; JSON/CSV export + weekly auto-export; Focus Mode toggle; weekly review ritual; self-host fonts; a11y + reduced-motion pass.
✅ *Pass:* installs to phone home screen; Focus Mode disables heavy VFX and measurably drops CPU; one-click export downloads all data.

---

## Conventions
- TypeScript strict mode on. No `any` in services. Repositories return typed rows.
- Pure functions in `services/*` (planner, srs, analytics) — unit-testable, no DOM, no network. Network lives in repositories.
- Keep the IIFE/`boot()` pattern in engine code; new features are functions registered in `boot()`.
- Optimistic UI: write local first, sync in background; never block the UI on the network.
- Reuse engine helpers (`$`, `$$`, `clamp`, `lerp`, `onView`, `reduced`) — don't reinvent them.

---

# ADDITIONAL FEATURES (v2) — required, not optional

These two were under-specified in the first draft. Build them; they are core, not nice-to-haves.

## A. Universal Scoring & Ranking
**Goal:** anywhere the user finishes a test/mock/DPP/quiz/sectional, they enter a **score + max score**; the app **accumulates** all of it and computes performance + a **rank estimate** alongside ongoing details. One entry point, used everywhere.

**Data:** add a general table (extends the schema):
```sql
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,                 -- "PW Prelims Mock 7", "Polity DPP 3"
  category text default 'mock', -- prelims | csat | mains | optional | dpp | sectional | quiz
  subject text,               -- optional, for subject-wise rollups
  score numeric not null,
  max_score numeric not null,
  taken_on date default current_date,
  created_at timestamptz default now()
);
alter table public.scores enable row level security;
create policy owner_all on public.scores using (user_id=auth.uid()) with check (user_id=auth.uid());
```

**Compute (`services/analytics.ts`, pure functions):**
- `percentage = score/max*100`; rolling average; per-subject accuracy; trend over time (by `taken_on`).
- **Cumulative:** total marks scored vs attempted across all entries; total tests taken; consistency.
- **Rank estimate (self-benchmark, clearly labelled):** there is no live cohort, so estimate a percentile/AIR **band** against a configurable target (e.g. expected Prelims cutoff in marks, editable in settings) and against the user's own historical distribution. If the user supplies a known cohort size + topper score for a specific mock, scale that mock's rank accordingly. Always render with the caption "self-benchmark, not an official prediction."
- These outputs **feed the existing prototype functions** — `rankSim()`, `donuts()`, `barCharts()`, `heatmap()` — replacing their seeded values with real ones.

**UI:** an **"Add Score"** action reachable from the command menu and from any test/mock card: fields `label, category, subject?, score, max, date` → save → all dashboards recompute live.

**Acceptance:** enter several scores across different categories/subjects; the cumulative total, average %, subject-wise readiness donuts, score trend, and the AIR band all update and persist across devices.

## B. Full Constitution module (data-driven)
**Goal:** the prototype's `constitution()` cross-fades only a handful of hardcoded `ARTICLES[]`. Replace that with the **entire Constitution** so the user can browse/search/hover **everything**.

**Data:** ship **`constitution.json`** (provided — 527 KB) as a static asset (`/src/data/constitution.json`). Shape:
```
{ source, preamble,
  parts:    [ { part:"PART III", title:"FUNDAMENTAL RIGHTS",
               articles:[ { num:"21A", heading:"Right to education.", omitted:false, text:"..." } ] } ],
  schedules:[ { name:"SEVENTH SCHEDULE", about:"..." } ] }
```
Coverage: **21 Parts · 481 Articles (478 with full text) · 12 Schedules · full Preamble.**

**UI (keep the cinematic shell):**
- Keep the constellation canvas + slow cross-fade as the **ambient highlight reel**, but source its rotation from a **curated subset** read out of the JSON (Preamble + iconic articles: 14, 19, 21, 21A, 32, 44, 51A, 368) instead of a hardcoded array.
- Add a **browsable index**: Part → article list (number + heading). Hovering or clicking an article opens a panel with its **full text**; schedules and the Preamble are reachable too.
- Add a **search box** filtering by article number or keyword across headings + text (e.g. "education" → 15, 21A, 45, 46, 51A …).
- Use existing tokens; Devanagari serif for the सत्यमेव जयते motto, body font for article text.

**Acceptance:** all 21 Parts and 481 articles are listed; search "education" returns Art 21A/45/46/51A; clicking any article shows its complete text; the ambient cross-fade still runs.

**Phase placement:** Scoring & Ranking → Phase 5 (with tests/analytics). Full Constitution → Phase 5/6 (content + polish). Add the `scores` table whenever you next touch the schema.

---

# ADDITIONAL FEATURES (v3)

## C. Configurable Focus Timer (user-adjustable)
The prototype timer is a fixed 25-min Pomodoro. Make it **fully user-adjustable**:
- Editable **focus length, short break, long break, and sessions-per-long-break**.
- Quick **+/- steppers** on the timer card to nudge the focus length up or down on the fly, plus **presets**: 25/5, 50/10, 90/20 (deep work), and Custom.
- Persist the config in `app_state` under key `timerConfig`. The running timer always reads the current config; a change applies to the next session. Logged minutes still credit `study_sessions` / `focusLog` for today using the **actual** elapsed length.
- Sustainable-study nudge: after several focus blocks with no long break, gently suggest a longer rest. Never hard-block — it's a suggestion, not a lock.

**Acceptance:** change focus from 25→50 min and the break lengths; the setting persists across reload and devices; a completed session logs the real configured minutes.

## D. More features (build in Phase 5/6 unless noted)
1. **Daily & weekly goals.** User sets a personal target (study hours or lectures/day, sessions/week). Show a progress ring. Supportive and user-set — never punitive, and never imply failure for missing it. Store in `app_state` `goals`. *(Keep it encouraging; the point is consistency, not pressure.)*
2. **Mistake Notebook.** Log questions you got wrong/shaky on: question, your answer, correct concept, subject, source. Each entry **auto-enrols into the SRS queue** so you revisit it. This is one of the highest-leverage UPSC tools. New table:
   ```sql
   create table public.mistakes (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references auth.users(id) on delete cascade,
     subject text, question text, my_answer text, correct_note text,
     source text, created_at timestamptz default now());
   alter table public.mistakes enable row level security;
   create policy owner_all on public.mistakes using (user_id=auth.uid()) with check (user_id=auth.uid());
   ```
3. **Quick Notes.** Attach a short markdown note to any lecture or topic; searchable. New table `notes (id, user_id, lecture_id?, topic_id?, body, created_at)` with the same RLS pattern.
4. **"Revise this" flag.** One tap on any lecture/topic pushes it straight into the SRS queue (`revisions`) with a due date of today — for when something didn't stick.
5. **Calendar / Agenda view.** A month/week view overlaying planner blocks + scheduled mocks + SRS-due revisions + the holidays already in your data (uses `planned_date` and `plan_days`). Gives a single "what's my week" picture.
6. **Quick Capture inbox.** One always-available box to dump a thought, doubt, or task; triage later into a to-do, note, or lecture. Store in `app_state` `inbox`.
7. **Sync status indicator.** A small dot showing online/offline + "last synced" time, reading the `store-sync` queue state. Important reassurance for an offline-first app you use on mobile.

All of these follow the existing patterns: `app_state` for simple state, a new RLS-protected table for structured entities, pure logic in `services/`, and UI mounted from `boot()` in the vanilla engine. None of them touch the cinematic code except to add a new card/section.