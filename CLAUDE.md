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
