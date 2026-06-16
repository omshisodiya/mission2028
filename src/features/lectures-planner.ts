import { listLectures, markDone, type LectureWithSubject } from '../data/repositories/lectures'
import { createRevisionSchedule } from '../data/repositories/revisions'
import { todayIST } from '../services/core'
import { advanceRoutineToDate, resetRoutineToToday } from './routine-ui'
import { supabase } from '../data/supabase'
import './lectures-planner.css'

type Filter = 'all' | 'today' | 'backlog' | 'done'

const PAGE_SIZE = 25

let _cache: LectureWithSubject[] = []
let _filter: Filter = 'all'
let _page = 1                        // how many pages of PAGE_SIZE to show
// Set by core-engine after CoreState is computed — no import needed
let _subjectKws: string[]  = []
let _todaySubject           = ''
let _autoAdvanced           = false   // true when we show a future day (no study today)
let _advancedDate           = ''      // the date we're showing instead of today

/** Called by core-engine.ts after CoreState is computed.
 *  autoAdvanced=true means today had 0 hours — show the next day's schedule. */
export function setPlannerSubjectContext(
  subject: string,
  keywords: string[],
  autoAdvanced = false,
  advancedDate = '',
): void {
  _todaySubject  = subject
  _subjectKws    = keywords
  _autoAdvanced  = autoAdvanced
  _advancedDate  = advancedDate
  render()   // re-render immediately with new priority
}
let _mounted = false
let _authed = false

/**
 * Step 1 — call immediately after engine boots (synchronous, no auth needed).
 * Injects the filter toolbar + Import/Add buttons into the planner panel.
 */
export function mountPlannerUI(): void {
  if (_mounted) return
  _mounted = true

  // Wait for DOM to be ready (engine uses DOMContentLoaded too)
  const run = () => {
    const container = document.getElementById('planner')
    if (!container) return

    // Inject toolbar just before #planner (inside the same panel)
    if (!document.getElementById('lp-toolbar')) {
      const toolbar = document.createElement('div')
      toolbar.id = 'lp-toolbar'
      toolbar.innerHTML = `
        <div class="lp-filters">
          <button class="lp-filter active" data-f="all">All</button>
          <button class="lp-filter" data-f="today">Today</button>
          <button class="lp-filter" data-f="backlog">Backlog</button>
          <button class="lp-filter" data-f="done">Done</button>
        </div>
        <div class="lp-actions">
          <button class="btn ghost" id="lp-skip-day" title="Manually show tomorrow's schedule" style="font-size:11px;padding:6px 10px;">Skip today →</button>
          <button class="btn ghost lp-btn-add" id="lp-add">+ Add</button>
          <button class="btn primary lp-btn-import" id="lp-import">Import Excel</button>
        </div>`

      container.parentNode?.insertBefore(toolbar, container)

      toolbar.querySelectorAll<HTMLButtonElement>('.lp-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          toolbar.querySelectorAll('.lp-filter').forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
          _filter = btn.dataset.f as Filter
          _page = 1   // reset to first page when filter changes
          render()
        })
      })

      document.getElementById('lp-import')?.addEventListener('click', openImportWizard)
      document.getElementById('lp-add')?.addEventListener('click', openManualAdd)
      const skipBtn = document.getElementById('lp-skip-day')
      if (skipBtn) {
        let _skipped = false
        skipBtn.addEventListener('click', () => {
          const today = todayIST()
          const [y, m, d] = today.split('-').map(Number)
          const nextDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)

          if (_skipped) {
            // Second click: restore to today
            _skipped = false
            skipBtn.textContent = 'Skip today →'
            _autoAdvanced = false; _advancedDate = ''; _subjectKws = []; _todaySubject = ''
            _page = 1; render()
            resetRoutineToToday()
          } else {
            // First click: advance to tomorrow
            _skipped = true
            skipBtn.textContent = '← Back to today'
            const nextDow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.UTC(y, m-1, d+1)).getUTCDay()]
            const SUBJ_MAP: Record<string, string[]> = {
              Mon:['SJS','Polity'], Tue:['Geography'], Wed:['Environment'],
              Thu:['Medieval','History'], Fri:['Economy'], Sat:['Mathematics'], Sun:[],
            }
            const kws = SUBJ_MAP[nextDow] ?? []
            const label = new Date(Date.UTC(y,m-1,d+1))
              .toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',timeZone:'UTC'})
            _autoAdvanced = true; _advancedDate = label
            _subjectKws = kws
            _todaySubject = kws.length ? kws[0] + ' (tomorrow)' : 'Tomorrow\'s plan'
            _page = 1; render()
            advanceRoutineToDate(nextDate)
          }
        })
      }
    }

    // Show empty state until auth + data arrive
    if (!_authed) {
      container.innerHTML = `
        <p class="lp-empty mono muted" style="margin-bottom:12px;">Sign in to load your lectures.</p>
        <button class="btn primary" id="lp-signin-btn" style="font-size:13px;padding:8px 18px;">Sign In</button>`
      document.getElementById('lp-signin-btn')?.addEventListener('click', async () => {
        const { showAuthGate } = await import('./auth')
        showAuthGate()
      })
    } else {
      container.innerHTML = '<p class="lp-empty mono muted">Loading lectures…</p>'
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
}

let _syncSetup = false

/**
 * Step 2 — call after auth completes. Fetches real lectures and renders them.
 * Also sets up cross-device sync: tab-visibility refresh + Supabase Realtime.
 */
export async function loadLectures(): Promise<void> {
  _authed = true
  const container = document.getElementById('planner')
  if (container) container.innerHTML = '<p class="lp-empty mono muted">Loading lectures…</p>'
  await refresh()

  if (_syncSetup) return
  _syncSetup = true

  // Re-fetch when user switches back to this tab (handles cross-device tick sync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _authed) {
      void refresh()
    }
  })

  // Supabase Realtime: push updates to this device instantly when any lecture
  // changes on another device. Requires "lectures" table to have Realtime
  // enabled in Supabase Dashboard → Database → Replication → lectures.
  supabase
    .channel('lectures-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lectures' },
      () => { void refresh() },
    )
    .subscribe()
}

/** Re-fetch and re-render — called by import wizard and manual-add after writes. */
export async function refresh(): Promise<void> {
  try {
    _cache = await listLectures()
  } catch (err) {
    const el = document.getElementById('planner')
    if (el) el.innerHTML = `<p class="lp-empty mono muted" style="color:var(--bad)">Could not load lectures — check your connection.</p>`
    console.error('[planner] listLectures failed:', err)
    return
  }
  render()
}

async function openImportWizard() {
  const { showImportWizard } = await import('./import-wizard')
  showImportWizard(refresh)
}

async function openManualAdd() {
  const { showManualAdd } = await import('./manual-add')
  showManualAdd(refresh)
}

function render(): void {
  const container = document.getElementById('planner')
  if (!container) return

  const total = _cache.length
  const doneCount = _cache.filter(l => l.done).length
  const pct = total > 0 ? Math.round(doneCount / total * 100) : 0

  const barFill = document.querySelector<HTMLElement>('#plan-bar > i')
  if (barFill) barFill.style.width = pct + '%'
  const pctEl = document.getElementById('plan-pct')
  if (pctEl) pctEl.textContent = pct + '%'
  const cntEl = document.getElementById('plan-count')
  if (cntEl) cntEl.textContent = `${doneCount} / ${total}`

  // Today's subject keywords — pushed in from core-engine via setPlannerSubjectContext()
  const subjectKws   = _subjectKws
  const todaySubject = _todaySubject

  const STATUS_ORDER: Record<string, number> = { today: 0, backlog: 1, upcoming: 2, done: 3 }

  function subjectPriority(l: LectureWithSubject): number {
    if (!subjectKws.length) return 0
    const name = (l.subjects?.name ?? '').toLowerCase()
    const title = l.title.toLowerCase()
    for (const kw of subjectKws) {
      if (name.includes(kw.toLowerCase()) || title.includes(kw.toLowerCase())) return 1
    }
    return 0
  }

  const today = todayIST()

  // For "today" filter: pick lectures assigned to today (by planned_date or status)
  // plus the first undone lecture from each subject keyword
  const todayPickIds = new Set<string>()
  if (_filter === 'today') {
    // Explicitly assigned to today via planned_date
    _cache.filter(l => !l.done && l.planned_date === today).forEach(l => todayPickIds.add(l.id))
    // Legacy: status='today' with no planned_date
    _cache.filter(l => !l.done && l.status === 'today' && !l.planned_date).forEach(l => todayPickIds.add(l.id))
    // Subject-keyword picks (first undone lecture per keyword, sorted by sequence)
    if (subjectKws.length) {
      const bySeq = [..._cache].sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999))
      for (const kw of subjectKws) {
        const kwL = kw.toLowerCase()
        const pick = bySeq.find(l => {
          if (l.done) return false
          const name  = (l.subjects?.name ?? '').toLowerCase()
          const title = l.title.toLowerCase()
          return name.includes(kwL) || title.includes(kwL)
        })
        if (pick) todayPickIds.add(pick.id)
      }
    }
  }

  const visible = _cache
    .filter(l => {
      if (_filter === 'today')   return todayPickIds.size ? todayPickIds.has(l.id) : (l.status === 'today' && !l.done)
      if (_filter === 'backlog') return l.status === 'backlog' && !l.done
      if (_filter === 'done')    return l.done
      return true
    })
    .sort((a, b) => {
      // Today's subject lectures surface first
      const pa = subjectPriority(a), pb = subjectPriority(b)
      if (pa !== pb) return pb - pa
      const ao = STATUS_ORDER[a.done ? 'done' : a.status] ?? 99
      const bo = STATUS_ORDER[b.done ? 'done' : b.status] ?? 99
      if (ao !== bo) return ao - bo
      return (a.sequence ?? 9999) - (b.sequence ?? 9999)
    })

  if (visible.length === 0) {
    const emptyMsg = _filter === 'today' && subjectKws.length === 0
      ? '<p class="lp-empty mono muted">Log today\'s routine to see recommended lectures here.</p>'
      : total === 0
        ? '<p class="lp-empty mono muted">No lectures yet — click <b>Import Excel</b> or <b>+ Add</b> above.</p>'
        : '<p class="lp-empty mono muted">No lectures in this filter.</p>'
    container.innerHTML = emptyMsg
    return
  }

  // Paginate — only render PAGE_SIZE * _page rows at a time
  const showing   = Math.min(_page * PAGE_SIZE, visible.length)
  const pageSlice = visible.slice(0, showing)

  // Count lectures carried forward from past dates (undone, planned_date < today)
  const carriedCount = _cache.filter(l => !l.done && l.planned_date && l.planned_date < today).length

  // Banner — shows today's subject, or a carry-forward notice for missed days
  // isCatchup: _advancedDate is a past date (YYYY-MM-DD from core-engine effective date)
  const isCatchup = _autoAdvanced && /^\d{4}-\d{2}-\d{2}$/.test(_advancedDate) && _advancedDate < today
  const advancedDateDisplay = formatDateShort(_advancedDate)
  const carriedNote = carriedCount > 0
    ? ` · <span style="color:var(--warn);">${carriedCount} lecture${carriedCount > 1 ? 's' : ''} carried forward</span>`
    : ''
  const banner = todaySubject && subjectKws.length
    ? _autoAdvanced
      ? isCatchup
        ? `<div class="lp-subject-banner" style="border-left-color:var(--warn);">
            <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">⚠ CATCHING UP FROM ${advancedDateDisplay}${carriedNote}</span>
            <span style="color:var(--warn);font-size:12px;">Missed day detected — complete a lecture or log study hours to advance</span>
            <span style="color:var(--accent-ink);font-size:13px;font-weight:600;">${esc(todaySubject)}</span>
           </div>`
        : `<div class="lp-subject-banner" style="border-left-color:var(--warn);">
            <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">NO STUDY TODAY · AUTO-ADVANCED${carriedNote}</span>
            <span style="color:var(--warn);font-size:12px;">Showing ${advancedDateDisplay} schedule — complete a lecture or log hours to reset</span>
            <span style="color:var(--accent-ink);font-size:13px;font-weight:600;">${esc(todaySubject)}</span>
           </div>`
      : carriedCount > 0
        ? `<div class="lp-subject-banner" style="border-left-color:var(--warn);">
            <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">TODAY'S SUBJECT${carriedNote}</span>
            <span style="color:var(--accent-ink);font-size:13px;font-weight:600;">${esc(todaySubject)}</span>
           </div>`
        : `<div class="lp-subject-banner">
            <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">TODAY'S SUBJECT</span>
            <span style="color:var(--accent-ink);font-size:13px;font-weight:600;">${esc(todaySubject)}</span>
           </div>`
    : carriedCount > 0
      ? `<div class="lp-subject-banner" style="border-left-color:var(--warn);">
          <span class="mono muted" style="font-size:10px;letter-spacing:.12em;">⏩ ${carriedCount} LECTURE${carriedCount > 1 ? 'S' : ''} CARRIED FROM PREVIOUS DAY${carriedCount > 1 ? 'S' : ''}</span>
         </div>`
      : ''

  const rows = pageSlice.map(l => {
    const subjectName = l.subjects?.name ?? ''
    const isToday     = subjectPriority(l) === 1 && !l.done
    const isCarried   = !l.done && !!l.planned_date && l.planned_date < today
    const status      = l.done ? 'done' : l.status
    const tagClass    = isToday ? 'lp-today' : isCarried ? 'backlog' : status === 'backlog' ? 'backlog' : ''
    const tagLabel    = isToday ? 'today' : isCarried ? '⏩ carried' : status
    const plannedBadge = isCarried
      ? `<span title="Originally planned for ${l.planned_date}" style="color:var(--warn);font-size:10px;font-family:var(--font-mono);">from ${l.planned_date?.slice(5)}</span>`
      : ''
    return `
      <div class="plan-row${l.done ? ' done' : isToday ? ' lp-subject-match' : isCarried ? ' lp-carried' : ''}" data-id="${l.id}">
        <button class="check" aria-label="toggle complete">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
        </button>
        <div class="pl-body">
          <div class="pl-title">${esc(l.title)}</div>
          <div class="pl-meta">
            ${subjectName ? `<span>${esc(subjectName)}</span>` : ''}
            <span>${esc(l.source || 'PW · Prarambh')}</span>
            <span>${l.duration_min} min</span>
            ${l.week != null ? `<span>Week ${l.week}</span>` : ''}
            ${plannedBadge}
          </div>
        </div>
        <span class="pl-tag ${tagClass}">${tagLabel}</span>
      </div>`
  }).join('')

  const moreCount = visible.length - showing
  const pagination = moreCount > 0
    ? `<div class="lp-pagination">
         Showing ${showing} of ${visible.length}
         <br><button class="lp-more-btn" id="lp-more">
           Show ${Math.min(moreCount, PAGE_SIZE)} more
         </button>
       </div>`
    : showing > PAGE_SIZE
      ? `<div class="lp-pagination">All ${visible.length} shown</div>`
      : ''

  container.innerHTML = banner + rows + pagination

  // "Show more" handler
  document.getElementById('lp-more')?.addEventListener('click', () => {
    _page++
    render()
  })

  container.querySelectorAll<HTMLElement>('.plan-row').forEach(row => {
    row.querySelector('.check')?.addEventListener('click', async () => {
      const id = row.dataset.id!
      const lec = _cache.find(l => l.id === id)
      if (!lec) return

      // Snapshot before mutating — needed for precise rollback
      const prevDone   = lec.done
      const prevStatus = lec.status

      const newDone = !lec.done
      // Optimistic update — mirror exactly what the DB will do
      lec.done = newDone
      if (newDone) {
        lec.status = 'done'
      } else {
        // Un-tick: restore to 'today' if it had a planned_date (so tomorrow's rollover picks
        // it up), otherwise 'backlog' for lectures that were never explicitly date-assigned.
        lec.status = lec.planned_date ? 'today' : 'backlog'
      }
      render()

      try {
        await markDone(id, newDone, lec.planned_date)
        if (newDone) {
          createRevisionSchedule(id, todayIST()).catch(e =>
            console.error('[srs] createRevisionSchedule failed:', e)
          )
        }
      } catch {
        // Precise rollback to the pre-click state
        lec.done   = prevDone
        lec.status = prevStatus
        render()
      }
    })
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Format a YYYY-MM-DD string to "Wed, 15 Jun"; pass-through non-ISO strings unchanged. */
function formatDateShort(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC',
  })
}
