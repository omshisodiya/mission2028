import { listLectures, markDone, type LectureWithSubject } from '../data/repositories/lectures'
import './lectures-planner.css'

type Filter = 'all' | 'today' | 'backlog' | 'done'

let _cache: LectureWithSubject[] = []
let _filter: Filter = 'all'
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
          <button class="btn ghost lp-btn-add" id="lp-add">+ Add</button>
          <button class="btn primary lp-btn-import" id="lp-import">Import Excel</button>
        </div>`

      container.parentNode?.insertBefore(toolbar, container)

      toolbar.querySelectorAll<HTMLButtonElement>('.lp-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          toolbar.querySelectorAll('.lp-filter').forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
          _filter = btn.dataset.f as Filter
          render()
        })
      })

      document.getElementById('lp-import')?.addEventListener('click', openImportWizard)
      document.getElementById('lp-add')?.addEventListener('click', openManualAdd)
    }

    // Show empty state until auth + data arrive
    container.innerHTML = _authed
      ? '<p class="lp-empty mono muted">Loading lectures…</p>'
      : '<p class="lp-empty mono muted">Sign in to load your lectures.</p>'
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
}

/**
 * Step 2 — call after auth completes. Fetches real lectures and renders them.
 */
export async function loadLectures(): Promise<void> {
  _authed = true
  const container = document.getElementById('planner')
  if (container) container.innerHTML = '<p class="lp-empty mono muted">Loading lectures…</p>'
  await refresh()
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

  const STATUS_ORDER: Record<string, number> = { today: 0, backlog: 1, upcoming: 2, done: 3 }
  const visible = _cache
    .filter(l => {
      if (_filter === 'today')   return l.status === 'today' && !l.done
      if (_filter === 'backlog') return l.status === 'backlog' && !l.done
      if (_filter === 'done')    return l.done
      return true
    })
    .sort((a, b) => {
      const ao = STATUS_ORDER[a.done ? 'done' : a.status] ?? 99
      const bo = STATUS_ORDER[b.done ? 'done' : b.status] ?? 99
      if (ao !== bo) return ao - bo
      return (a.sequence ?? 9999) - (b.sequence ?? 9999)
    })

  if (visible.length === 0) {
    container.innerHTML = total === 0
      ? '<p class="lp-empty mono muted">No lectures yet — click <b>Import Excel</b> or <b>+ Add</b> above.</p>'
      : '<p class="lp-empty mono muted">No lectures in this filter.</p>'
    return
  }

  container.innerHTML = visible.map(l => {
    const subjectName = l.subjects?.name ?? ''
    const status = l.done ? 'done' : l.status
    const tagClass = status === 'backlog' ? 'backlog' : status === 'today' ? 'lp-today' : ''
    return `
      <div class="plan-row${l.done ? ' done' : ''}" data-id="${l.id}">
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
          </div>
        </div>
        <span class="pl-tag ${tagClass}">${status}</span>
      </div>`
  }).join('')

  container.querySelectorAll<HTMLElement>('.plan-row').forEach(row => {
    row.querySelector('.check')?.addEventListener('click', async () => {
      const id = row.dataset.id!
      const lec = _cache.find(l => l.id === id)
      if (!lec) return
      const newDone = !lec.done
      lec.done = newDone
      if (newDone) lec.status = 'done'
      else if (lec.status === 'done') lec.status = 'backlog'
      render()
      try { await markDone(id, newDone) } catch { lec.done = !newDone; render() }
    })
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
