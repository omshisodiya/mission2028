import {
  listRoutineDays, upsertRoutineDay, type RoutineDay,
} from '../data/repositories/routine'
import {
  todayIST, formatDateDisplay, fullDayName,
  getSubject, getTopicLabel, getSchedule,
  getTargetQuestions, getMainsTarget, getComponentText,
  computeAccuracy, computeTestScore, computeConsistency,
  computeAggregates, computeSelectionProbability,
  getRankProjection, getApproxRank,
  buildHeatSeed, subjectAccuracy, lastNTestAccuracies,
  disclaimer,
} from '../services/routine'
import './routine-ui.css'

// ── module state ──────────────────────────────────────────────────────────────

let _allDays: RoutineDay[] = []
let _today = ''
let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _todayRow: RoutineDay = makeDefault('')

function makeDefault(day: string): RoutineDay {
  return { day, day_type: 'College', study_hours: null, mains_written: null,
           attempted: null, correct: null, wrong: null, notes: null }
}

/**
 * Step 1 — call synchronously at page load (no auth needed).
 * Injects the section skeleton so it always appears in the page.
 */
export function mountRoutineSection(): void {
  // Wait for DOM ready (module scripts are already deferred, but be safe)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSection)
  } else {
    injectSection()
  }
}

/**
 * Step 2 — call after auth completes. Loads real data and renders everything.
 */
export async function initRoutine(): Promise<void> {
  _today = todayIST()
  injectSection() // idempotent — does nothing if already injected

  try {
    _allDays = await listRoutineDays()
  } catch (err) {
    console.error('[routine] listRoutineDays failed — schema may need updating:', err)
    elText('rtn-save-status', 'Run the Routine block from schema.sql in Supabase SQL Editor first.')
    return
  }

  // Auto-create today's row if not yet stored
  const existing = _allDays.find(d => d.day === _today)
  if (!existing) {
    _todayRow = makeDefault(_today)
    _allDays.push(_todayRow)
    await upsertRoutineDay(_todayRow).catch(() => {})
  } else {
    _todayRow = { ...existing }
  }

  renderAll()
  bindEvents()
}

// ── DOM injection ─────────────────────────────────────────────────────────────

function injectSection(): void {
  if (document.getElementById('routine')) return

  const intel = document.getElementById('intel')
  if (!intel) return

  const section = document.createElement('section')
  section.className = 'scene'
  section.id = 'routine'
  section.innerHTML = `
    <div class="wrap">
      <div class="scene-head reveal">
        <span class="eyebrow"><span class="tricolor-rule"></span>&nbsp; Daily Routine · Performance Tracker</span>
        <h2>Today's engine.<br />Real numbers, real rank.</h2>
        <p>Log your daily inputs — study hours, answers written, MCQs. Everything else is computed live: accuracy, test score, consistency, selection probability, rank band.</p>
      </div>

      <!-- Headline metrics strip -->
      <div class="rtn-strip reveal">
        <div class="rtn-strip-metrics">
          <div class="rtn-strip-cell">
            <span class="card-label">Selection Probability</span>
            <span class="rtn-strip-val" id="rtn-sel-prob">—</span>
            <span class="rtn-strip-unit">% (self-estimate)</span>
          </div>
          <div class="rtn-strip-cell">
            <span class="card-label">Rank Projection</span>
            <span class="rtn-strip-val rtn-small" id="rtn-rank-proj">—</span>
          </div>
          <div class="rtn-strip-cell">
            <span class="card-label">Approx Rank Band</span>
            <span class="rtn-strip-val rtn-small" id="rtn-approx-rank">—</span>
          </div>
          <div class="rtn-strip-cell">
            <span class="card-label">Prelims Avg</span>
            <span class="rtn-strip-val" id="rtn-pre-avg">—</span>
            <span class="rtn-strip-unit">% accuracy</span>
          </div>
          <div class="rtn-strip-cell">
            <span class="card-label">Optional Avg</span>
            <span class="rtn-strip-val" id="rtn-opt-avg">—</span>
            <span class="rtn-strip-unit">% accuracy</span>
          </div>
          <div class="rtn-strip-cell">
            <span class="card-label">Mains Avg</span>
            <span class="rtn-strip-val" id="rtn-mains-avg">—</span>
            <span class="rtn-strip-unit">answers/day</span>
          </div>
        </div>
        <p class="rtn-disclaimer mono">${disclaimer}</p>
      </div>

      <!-- Two-col: today card + table -->
      <div class="rtn-cols">

        <!-- Today card -->
        <div class="panel panel-pad reveal" id="rtn-today-card">
          <div class="rtn-today-header">
            <div>
              <div class="card-label" id="rtn-today-label">Loading…</div>
              <div class="rtn-date-label" id="rtn-today-date"></div>
            </div>
            <select class="rtn-select" id="rtn-day-type">
              <option value="College">College</option>
              <option value="Holiday">Holiday</option>
              <option value="Leave">Leave</option>
              <option value="Test Day">Test Day</option>
            </select>
          </div>

          <div class="rtn-schedule" id="rtn-schedule"></div>

          <div class="rtn-plan">
            <div class="rtn-plan-item">
              <span class="card-label">Subject</span>
              <span class="rtn-plan-value" id="rtn-subject">—</span>
            </div>
            <div class="rtn-plan-item">
              <span class="card-label">Topic</span>
              <span class="rtn-plan-value" id="rtn-topic">—</span>
            </div>
            <div class="rtn-plan-item">
              <span class="card-label">Target MCQs</span>
              <span class="rtn-plan-value" id="rtn-target">—</span>
            </div>
            <div class="rtn-plan-item">
              <span class="card-label">Mains Target</span>
              <span class="rtn-plan-value" id="rtn-mains-target">—</span>
            </div>
            <div class="rtn-plan-item rtn-span-2">
              <span class="card-label">Component</span>
              <span class="rtn-plan-value" id="rtn-component">—</span>
            </div>
          </div>

          <div class="rtn-inputs">
            <label class="rtn-field">
              <span class="card-label">Study Hours</span>
              <input class="rtn-input" type="number" id="rtn-study-hours" min="0" max="24" step="0.5" placeholder="0" />
            </label>
            <label class="rtn-field">
              <span class="card-label">Mains Written</span>
              <input class="rtn-input" type="number" id="rtn-mains" min="0" max="10" step="1" placeholder="0" />
            </label>
            <label class="rtn-field">
              <span class="card-label">Attempted</span>
              <input class="rtn-input" type="number" id="rtn-attempted" min="0" max="200" step="1" placeholder="0" />
            </label>
            <label class="rtn-field">
              <span class="card-label">Correct</span>
              <input class="rtn-input" type="number" id="rtn-correct" min="0" max="200" step="1" placeholder="0" />
            </label>
            <label class="rtn-field">
              <span class="card-label">Wrong</span>
              <input class="rtn-input" type="number" id="rtn-wrong" min="0" max="200" step="1" placeholder="0" />
            </label>
          </div>

          <div class="rtn-live">
            <div class="rtn-live-cell">
              <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">ACCURACY</span>
              <span class="rtn-live-val" id="rtn-accuracy">—</span>
            </div>
            <div class="rtn-live-cell">
              <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">TEST SCORE</span>
              <span class="rtn-live-val" id="rtn-test-score">—</span>
            </div>
            <div class="rtn-live-cell">
              <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">CONSISTENCY</span>
              <span class="rtn-live-val" id="rtn-consistency">—</span>
            </div>
          </div>

          <textarea class="rtn-notes" id="rtn-notes" placeholder="Notes for today…" rows="3"></textarea>
          <div class="rtn-save-status" id="rtn-save-status"></div>
        </div>

        <!-- Routine table -->
        <div class="panel panel-pad reveal" style="--d:90ms;">
          <span class="card-label">Routine Log</span>
          <div class="rtn-table-wrap">
            <table class="rtn-table">
              <thead>
                <tr>
                  <th>Date</th><th>Day</th><th>Type</th>
                  <th>Subject</th><th>Hrs</th><th>Mains</th>
                  <th>Att</th><th>Cor</th><th>Acc%</th>
                  <th>Score</th><th>Con%</th>
                </tr>
              </thead>
              <tbody id="rtn-tbody"></tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  `
  intel.insertAdjacentElement('beforebegin', section)

  // The engine's IntersectionObserver only observed elements present at boot.
  // Force-show all reveal elements in this dynamically-injected section.
  section.querySelectorAll('.reveal').forEach(el => el.classList.add('in'))
}

// ── render ────────────────────────────────────────────────────────────────────

function renderAll(): void {
  renderTodayCard()
  renderAggregates()
  renderTable()
  updateEngineWidgets()
}

function renderTodayCard(): void {
  const row = _todayRow
  const subject = getSubject(row.day)
  const sched   = getSchedule(row.day_type)

  elText('rtn-today-label', fullDayName(row.day))
  elText('rtn-today-date',  formatDateDisplay(row.day))

  // Day-type select
  const sel = document.getElementById('rtn-day-type') as HTMLSelectElement | null
  if (sel) sel.value = row.day_type

  // Schedule blocks
  const schedEl = document.getElementById('rtn-schedule')
  if (schedEl) {
    schedEl.innerHTML = [
      `<div class="rtn-schedule-block mono muted" style="font-size:11px;">${sched.start_time} → ${sched.end_time}</div>`,
      ...sched.blocks.map(b => `<div class="rtn-schedule-block">${b}</div>`),
    ].join('')
  }

  // Plan summary
  elText('rtn-subject',      subject)
  elText('rtn-topic',        getTopicLabel(row.day, subject, _allDays.filter(d => d.day < row.day)))
  elText('rtn-target',       `${getTargetQuestions(subject, row.day_type)} questions`)
  elText('rtn-mains-target', `${getMainsTarget(row.day_type)} answer${getMainsTarget(row.day_type) > 1 ? 's' : ''}`)
  elText('rtn-component',    getComponentText(subject, row.day_type))

  // Inputs
  setVal('rtn-study-hours', row.study_hours)
  setVal('rtn-mains',       row.mains_written)
  setVal('rtn-attempted',   row.attempted)
  setVal('rtn-correct',     row.correct)
  setVal('rtn-wrong',       row.wrong)

  const notesEl = document.getElementById('rtn-notes') as HTMLTextAreaElement | null
  if (notesEl) notesEl.value = row.notes ?? ''

  renderLiveMetrics()
}

function renderLiveMetrics(): void {
  const row = _todayRow
  const acc   = computeAccuracy(row.correct, row.attempted)
  const score = computeTestScore(row.correct, row.wrong)
  const cons  = computeConsistency(row)

  elText('rtn-accuracy',   acc   != null ? acc.toFixed(1)   + '%' : '—')
  elText('rtn-test-score', score != null ? score.toFixed(1)        : '—')
  elText('rtn-consistency', cons != null ? cons + '%'              : '—')
}

function renderAggregates(): void {
  const agg = computeAggregates(_allDays)
  const sp  = computeSelectionProbability(agg)

  elText('rtn-sel-prob',    sp  != null ? sp.toFixed(1)              : '—')
  elText('rtn-rank-proj',   getRankProjection(sp))
  elText('rtn-approx-rank', getApproxRank(sp))
  elText('rtn-pre-avg',     agg.prelimsAvg  != null ? agg.prelimsAvg.toFixed(1)  : '—')
  elText('rtn-opt-avg',     agg.optionalAvg != null ? agg.optionalAvg.toFixed(1) : '—')
  elText('rtn-mains-avg',   agg.mainsAvg    != null ? agg.mainsAvg.toFixed(1)    : '—')
}

const FUTURE_DAYS = 7

function renderTable(): void {
  const tbody = document.getElementById('rtn-tbody')
  if (!tbody) return

  const today   = _today
  const todayMs = parseDate(today)
  const futureDays: string[] = []
  for (let i = 1; i <= FUTURE_DAYS; i++) {
    const d = new Date(todayMs + i * 86_400_000)
    futureDays.push(d.toLocaleDateString('en-CA', { timeZone: 'UTC' }))
  }

  const rows = [
    ..._allDays,
    ...futureDays
      .filter(d => !_allDays.find(r => r.day === d))
      .map(d => makeDefault(d)),
  ].sort((a, b) => a.day < b.day ? -1 : 1)

  tbody.innerHTML = rows.map(r => {
    const isTodayRow   = r.day === today
    const isFutureRow  = r.day > today
    const subject      = getSubject(r.day)
    const acc          = computeAccuracy(r.correct, r.attempted)
    const score        = computeTestScore(r.correct, r.wrong)
    const cons         = computeConsistency(r)
    const rowClass     = isTodayRow ? 'rtn-today-row' : isFutureRow ? 'rtn-future-row' : ''
    const fmt = (v: number | null, decimals = 1) => v != null ? v.toFixed(decimals) : '—'

    return `<tr class="${rowClass}">
      <td>${r.day.slice(5)}</td>
      <td>${fullDayName(r.day).slice(0, 3)}</td>
      <td>${r.day_type}</td>
      <td title="${subject}">${subject.split(' ')[0]}</td>
      <td>${r.study_hours ?? '—'}</td>
      <td>${r.mains_written ?? '—'}</td>
      <td>${r.attempted ?? '—'}</td>
      <td>${r.correct ?? '—'}</td>
      <td class="${acc != null && acc >= 60 ? 'rtn-ok' : acc != null ? 'rtn-bad' : ''}">${fmt(acc)}</td>
      <td>${fmt(score)}</td>
      <td>${fmt(cons, 0)}</td>
    </tr>`
  }).join('')
}

// ── engine widget feeds ───────────────────────────────────────────────────────

function updateEngineWidgets(): void {
  updateHeatmap()
  updateRankSim()
  updateBarCharts()
  updateDonuts()
}

function updateHeatmap(): void {
  const seed = buildHeatSeed(_allDays, _today)
  // Patch engine store in-memory + localStorage
  const mission = (window as { MISSION?: { store: { data: Record<string, unknown>; set(k:string,v:unknown):void } } }).MISSION
  if (mission?.store) mission.store.set('heatSeed', seed)

  // Re-render #heat directly (mirrors engine's heatmap() rendering)
  const root = document.getElementById('heat')
  if (!root) return
  root.innerHTML = ''
  seed.forEach(l => {
    const c = document.createElement('div')
    c.className = 'c' + (l ? ' h' + l : '')
    root.appendChild(c)
  })
  const active = seed.filter(v => v > 0).length
  const activeEl = document.getElementById('heat-active')
  if (activeEl) activeEl.textContent = String(active)
}

function updateRankSim(): void {
  const agg = computeAggregates(_allDays)
  if (agg.prelimsAvg === null) return

  // Map accuracy % → slider ranges  (pre: 60–200, mains: 30–100)
  const pre   = Math.round(60  + (Math.min(agg.prelimsAvg,  100) / 100) * 140)
  const mains = Math.round(30  + (Math.min(agg.optionalAvg ?? 0, 100) / 100) * 70)

  const mission = (window as { MISSION?: { store: { set(k:string,v:unknown):void } } }).MISSION
  if (mission?.store) mission.store.set('rankInputs', { pre, mains, inter: 165 })

  // Update sliders + trigger engine's input handler to recompute display
  const preSlider   = document.getElementById('s-pre')   as HTMLInputElement | null
  const mainsSlider = document.getElementById('s-mains') as HTMLInputElement | null
  if (preSlider) {
    preSlider.value = String(pre)
    preSlider.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (mainsSlider) {
    mainsSlider.value = String(mains)
    mainsSlider.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function updateBarCharts(): void {
  const accs = lastNTestAccuracies(_allDays, 8)
  if (!accs.length) return

  const cols = document.querySelectorAll<HTMLElement>('#mock-bars .col')
  accs.forEach((v, i) => {
    if (i >= cols.length) return
    const rounded = Math.round(v)
    cols[i].setAttribute('data-v', String(rounded))
    cols[i].style.height = rounded + '%'
    const pv = cols[i].querySelector('.pv')
    if (pv) pv.textContent = String(rounded)
  })
}

// Donut subject map: routine keyword → HTML donut index (0-based in DOM order)
const DONUT_MAP: { keyword: string; index: number }[] = [
  { keyword: 'SJS',        index: 0 }, // Polity
  { keyword: 'Medieval',   index: 1 }, // History
  { keyword: 'Geography',  index: 2 }, // Geo
  { keyword: 'Economy',    index: 3 }, // Economy
  { keyword: 'Environment',index: 4 }, // Env
  // index 5 (CSAT) ← leave seeded until Phase 5 analytics
]

function updateDonuts(): void {
  const donuts = document.querySelectorAll<HTMLElement>('.donut')
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()

  DONUT_MAP.forEach(({ keyword, index }) => {
    const acc = subjectAccuracy(_allDays, keyword)
    if (!acc || index >= donuts.length) return

    const d    = donuts[index]
    const v    = Math.round(acc)
    d.setAttribute('data-v', String(v))
    const b = d.querySelector('.mid b')
    if (b) b.textContent = v + '%'
    // Directly set the ring if currently in viewport
    const ring = d.querySelector<HTMLElement>('.ring')
    if (ring) {
      const rect = d.getBoundingClientRect()
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        ring.style.background = `conic-gradient(${accent} ${v}%, rgba(120,168,255,0.13) 0)`
      }
    }
  })
}

// ── event binding ─────────────────────────────────────────────────────────────

function bindEvents(): void {
  const sel = document.getElementById('rtn-day-type') as HTMLSelectElement | null
  sel?.addEventListener('change', () => {
    _todayRow.day_type = sel.value
    renderTodayCard()
    renderAggregates()
    renderTable()
    scheduleSave()
  })

  ;(['rtn-study-hours', 'rtn-mains', 'rtn-attempted', 'rtn-correct', 'rtn-wrong'] as const)
    .forEach(id => {
      document.getElementById(id)?.addEventListener('input', (e) => {
        const v = (e.target as HTMLInputElement).value
        const n = v === '' ? null : parseFloat(v)
        if      (id === 'rtn-study-hours') _todayRow.study_hours   = n
        else if (id === 'rtn-mains')       _todayRow.mains_written  = n == null ? null : Math.round(n)
        else if (id === 'rtn-attempted')   _todayRow.attempted       = n == null ? null : Math.round(n)
        else if (id === 'rtn-correct')     _todayRow.correct         = n == null ? null : Math.round(n)
        else if (id === 'rtn-wrong')       _todayRow.wrong           = n == null ? null : Math.round(n)

        // Sync _allDays in-memory so aggregates update live
        const idx = _allDays.findIndex(d => d.day === _today)
        if (idx >= 0) _allDays[idx] = { ..._todayRow }

        renderLiveMetrics()
        renderAggregates()
        renderTable()
        updateEngineWidgets()
        scheduleSave()
      })
    })

  document.getElementById('rtn-notes')?.addEventListener('input', (e) => {
    _todayRow.notes = (e.target as HTMLTextAreaElement).value || null
    scheduleSave()
  })
}

function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer)
  elText('rtn-save-status', 'Saving…')
  _saveTimer = setTimeout(async () => {
    try {
      await upsertRoutineDay(_todayRow)
      elText('rtn-save-status', 'Saved ✓')
      setTimeout(() => elText('rtn-save-status', ''), 2000)
    } catch (err) {
      console.error('[routine] save failed:', err)
      elText('rtn-save-status', 'Save failed')
    }
  }, 800)
}

// ── tiny DOM helpers ──────────────────────────────────────────────────────────

function elText(id: string, text: string): void {
  const e = document.getElementById(id)
  if (e) e.textContent = text
}

function setVal(id: string, v: number | null): void {
  const e = document.getElementById(id) as HTMLInputElement | null
  if (e) e.value = v != null ? String(v) : ''
}

function parseDate(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
