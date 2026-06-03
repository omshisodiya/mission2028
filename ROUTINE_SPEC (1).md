# ROUTINE FEATURE SPEC — from Om's UPSC_.xlsx tracker

Build this as a new feature **before Phase 3**. It replaces the prototype's seeded `rankSim`/streak guesses with Om's real tracking engine. All rule values live in **`routine_config.json`** (ship it in `/src/data/`) so they're editable without code.

## What it is
A daily routine + performance tracker. The app auto-creates "today's" row in **IST (Asia/Kolkata)**; the user picks a **day type** and enters a few numbers; everything else is computed live — exactly like the spreadsheet, but interactive and synced.

## Data model (only the manual inputs are stored)
```sql
create table public.routine_days (
  user_id       uuid not null references auth.users(id) on delete cascade,
  day           date not null,
  day_type      text not null default 'College',  -- College | Holiday | Leave | Test Day
  study_hours   numeric,
  mains_written int,
  attempted     int,
  correct       int,
  wrong         int,
  notes         text,
  updated_at    timestamptz default now(),
  primary key (user_id, day)
);
alter table public.routine_days enable row level security;
create policy owner_all on public.routine_days using (user_id=auth.uid()) with check (user_id=auth.uid());
```
Everything else (schedule, subject, component, topic, target, accuracy, test score, running averages, consistency, selection probability, rank) is **computed in `services/routine.ts`** from these inputs + `routine_config.json`. Do **not** store computed values.

## Computation (`services/routine.ts`, pure functions — mirror routine_config.json exactly)
- **day name** ← date. **schedule blocks / start / end** ← `schedules[day_type]` (Leave/Test Day map to Holiday-style or a minimal block; keep it simple).
- **subject** ← `subject_rotation`: Sunday → "PW Full Test"; else if `(date − anchor) mod 14 == 0` → "PW Optional Sectional"; else weekday map.
- **topic** ← running per-subject counter (count prior days whose subject contains the same keyword) → "GEO Lecture 4", etc.; test/Maths labels from config.
- **target_questions**, **mains_written_target**, **component_text** ← config by subject/day_type.
- **accuracy** = correct/attempted×100. **test_score** = correct×2 − wrong×0.66.
- **prelims_avg / optional_avg / mains_avg** ← running averages per config (Maths vs non-Maths).
- **consistency %** ← config thresholds for the day_type.
- **selection_probability %** ← weighted blend (needs attempted ≥ 15).
- **rank_projection / approx_rank** ← band lookup on selection_probability.
- These feed the existing `rankSim`, `donuts`, `barCharts`, `heatmap` — real values now.

## UI (mounted from `boot()`, vanilla, existing tokens)
1. **Today card** (auto IST date, never hand-typed): shows day name + a **day-type dropdown** (College / Holiday / Leave / Test Day). Changing it instantly re-renders the schedule, times, subject, component, target. Below: number inputs for **study hours, mains written, attempted, correct, wrong** + a notes box. As you type, **accuracy, test score, consistency, selection probability, rank** update live and save (through the `store`/repo, synced).
2. **Routine table** (like the sheet): scrollable list of days with the computed columns; today highlighted; past days editable; future days show the auto-generated plan (schedule/subject/target) with empty inputs.
3. **Headline metrics strip**: current Selection Probability %, Rank Projection, and the three running averages — each with the caption from `routine_config.json.disclaimer` ("personal estimate, not an official prediction").

## Auto-date rule
"Today" = current date in **Asia/Kolkata**, computed at load (don't rely on the device locale). The routine generates rows from a configurable start date forward; the user never types the date. Rolling over midnight IST creates the next day's row automatically.

## Acceptance test
- Open the app in the evening IST → today's row exists with the correct weekday, schedule, and rotation subject, no manual date entry.
- Flip the dropdown College→Holiday → schedule blocks, times, target (20→30), and mains target (1→2) all change instantly.
- Enter attempted=40, correct=30, wrong=10 → accuracy 75%, test score = 30×2 − 10×0.66 = 53.4 appear live; running averages and selection probability update; rank band shows; all persist and sync to phone.
