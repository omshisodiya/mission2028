# CORE ENGINE SPEC — the tracker is the spine of the app

**Read this together with `ROUTINE_SPEC.md` and `routine_config.json`.** Build before Phase 3.
This is not a feature in a tab. It is the **central state** of the whole website: one performance state, fed by every input, read by every widget, synced across devices. The Excel's logic *is* the app's core.

## The one principle
There is exactly **one computed object — `CoreState`**. Everything the user does writes an *input*; `CoreState` is recomputed from all inputs; every dashboard, chart, rank, and briefing **reads only `CoreState`**. No widget computes its own numbers. This is what "deeply implemented, not just a feature" means.

## Inputs (all persisted in Supabase, all sync via store-sync)
| Input | Source action | Table |
|---|---|---|
| Daily routine (day_type, study_hours?, mains_written, attempted, correct, wrong) | Routine Today card | `routine_days` |
| Any graded test/mock/DPP/sectional (category, subject, attempted, correct, wrong, score, max, date) | **"Add Score" from anywhere** | `scores` |
| Study minutes | Focus timer stop | `study_sessions` |
| Mains answers | Answer log | `answer_practice` |
| Lecture done/not | Lecture check-off | `lecture_progress` |
| Errors | Mistake log | `mistakes` |

## The "hours sync"
`daily_hours[date] = manual study_hours (if entered) ELSE sum(focus-session minutes that date)/60`.
The **focus timer auto-fills hours** into the routine; manual entry overrides. `cumulative_hours = Σ daily_hours`. Changing the focus timer length (the configurable timer) still just logs real elapsed minutes here.

## The "score addition" (accumulation)
Merge **`routine_days` daily practice rows + every `scores` row** into one pool of graded events, each `{date, category: prelims|optional|mains, attempted, correct, wrong}`. The engine accumulates over the entire pool — every score you add anywhere lands here and moves the totals. From the pool it computes (formulas from `routine_config.json`):
- `accuracy = correct/attempted×100`, `test_score = correct×2 − wrong×0.66`
- `prelims_avg` (non-Maths), `optional_avg` (Maths), `mains_avg`
- `cumulative_attempted`, `cumulative_correct`, `cumulative_marks`, `tests_taken`
- `consistency_pct` (day_type thresholds), `selection_probability_pct` (weighted blend), `rank_projection` + `approx_rank` (band lookup)

## `services/core.ts` — single source of truth
```
computeCoreState(inputs, routineConfig) -> CoreState {
  today:       { date(IST), day_type, schedule, subject, target_qns, component, topic },
  hours:       { today, cumulative, byDay[] },
  performance: { prelims_avg, optional_avg, mains_avg, accuracy_today, test_score_avg },
  cumulative:  { attempted, correct, marks, tests_taken },
  consistency_pct, selection_probability_pct, rank_projection, approx_rank,
  streak, backlog_remaining
}
```
Pure and deterministic. Recompute on **every** input write and on load. Cache the result in `store` so widgets read instantly; invalidate + recompute on any change.

## Wiring (each action → input → recompute)
- Focus timer stop → `study_sessions` → daily_hours → recompute.
- **Add Score (command menu, any mock/test card, DPP)** → `scores` → graded pool → recompute.
- Routine Today inputs → `routine_days` upsert → recompute.
- Lecture check-off → `lecture_progress` → `backlog_remaining` → recompute.
- Mistake log → `mistakes` (+ SRS) → weak-areas in CoreState.

## Bindings (every widget reads CoreState — no exceptions)
- `rankSim` → `selection_probability_pct` + `rank_projection`/`approx_rank` (real, not sliders).
- `donuts` → subject readiness from accuracy by subject.
- `barCharts` → `test_score` trend over time.
- `heatmap` → `hours.byDay`.
- streak / count-ups → `cumulative` (hours, attempted, marks) + `streak`.
- daily briefing line → one-sentence summary of CoreState.

## Sync + IST + accumulation
All inputs persist to Supabase through `store-sync`; `CoreState` recomputes on load and on every write. "Today" is computed in **Asia/Kolkata**. Change anything on the laptop → it syncs → the phone recomputes the **identical** CoreState. Data **accumulates forever** across days — averages and cumulatives never reset unless the user clears them.

## Honest labelling
`selection_probability_pct`, `rank_projection`, `approx_rank` are the user's own motivational heuristic. Always show the caption from `routine_config.json.disclaimer`: a personal estimate, not an official prediction.

## Acceptance test (this proves it's the core, not a feature)
1. Do a 50-min focus session → `hours.today` auto-fills +0.83, `cumulative_hours` rises, `consistency_pct` updates — **without** typing hours manually.
2. Add a mock score (80/100, prelims) from the command menu → `prelims_avg`, `cumulative.marks`, `selection_probability_pct`, and the rank band **all move at once, everywhere on the page**, and persist to the phone.
3. Flip today College→Holiday → schedule, targets (20→30), mains target (1→2), and the consistency thresholds change live.
4. Open every widget: rankSim, donuts, heatmap, streak, briefing — all show numbers consistent with the one CoreState. No widget disagrees with another.
