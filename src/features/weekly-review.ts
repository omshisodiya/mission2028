/**
 * weekly-review.ts — Weekly Reflection Ritual.
 * Aggregates the past 7 days: study hours, lectures done, scores, streak.
 * Prompts for reflection via 3 guided questions. Saved to app_state 'weeklyReviews'.
 */
import { todayIST } from '../services/core'
import { getCurrentState } from './core-engine'

interface WeeklyReview {
  weekEnd:   string
  hours:     number
  lectures:  number
  streak:    number
  avgScore:  number | null
  went_well: string
  improve:   string
  next_week: string
}

const REVIEW_KEY = 'jarvis_weekly_reviews_v1'

function loadReviews(): WeeklyReview[] {
  try { return JSON.parse(localStorage.getItem(REVIEW_KEY) ?? '[]') as WeeklyReview[] }
  catch { return [] }
}

function saveReview(r: WeeklyReview): void {
  const reviews = loadReviews().filter(x => x.weekEnd !== r.weekEnd)
  reviews.unshift(r)
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews.slice(0, 52))) // keep 1 year
  // Also sync to app_state
  try {
    const store = (window as { MISSION?: { store: { set(k: string, v: unknown): void } } }).MISSION?.store
    store?.set('weeklyReviews', reviews.slice(0, 52))
  } catch { /* ignore */ }
}

function getWeekStats(): { hours: number; lectures: number; streak: number; avgScore: number | null } {
  const cs      = getCurrentState()
  const today   = todayIST()
  const [y, m, d] = today.split('-').map(Number)
  const todayMs = Date.UTC(y, m - 1, d)

  let hours = 0
  try {
    const focusLog = JSON.parse(localStorage.getItem('focusLog') ?? '[]') as Array<{ date: string; mins: number }>
    for (let i = 0; i < 7; i++) {
      const date = new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10)
      hours += focusLog.filter(e => e.date === date).reduce((s, e) => s + (e.mins ?? 0), 0) / 60
    }
  } catch { /* ignore */ }

  return {
    hours:    Math.round(hours * 10) / 10,
    lectures: document.querySelectorAll('#plan .plan-row.done').length,
    streak:   cs?.streak ?? 0,
    avgScore: cs?.performance?.prelimsAvg ?? null,
  }
}

function toast(msg: string, type: 'success' | 'info' = 'success') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
}

// ── Weekly Review Panel ───────────────────────────────────────────────────────

export function showWeeklyReview(): void {
  if (document.getElementById('wr-overlay')) return

  const stats   = getWeekStats()
  const today   = todayIST()
  const reviews = loadReviews()
  const lastReview = reviews[0]

  const overlay = document.createElement('div')
  overlay.id = 'wr-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;overflow-y:auto;'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;
      display:flex;flex-direction:column;gap:20px;">

      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📋 WEEKLY REVIEW</span>
        <button id="wr-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>

      <!-- This week's stats -->
      <div style="background:var(--panel-2);border-radius:var(--r-sm);padding:16px;">
        <p style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.12em;margin:0 0 12px;">THIS WEEK AT A GLANCE</p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
          ${[
            ['Study Hours', stats.hours + 'h', stats.hours >= 30 ? '🔥' : stats.hours >= 20 ? '✓' : '→'],
            ['Streak', stats.streak + ' days', stats.streak >= 7 ? '🔥' : '→'],
            ['Lectures Done', String(stats.lectures), stats.lectures >= 5 ? '✓' : '→'],
            ['Prelims Avg', stats.avgScore != null ? stats.avgScore.toFixed(1) + '%' : '—', stats.avgScore != null && stats.avgScore >= 65 ? '✓' : '→'],
          ].map(([label, val, icon]) => `
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">${label}</span>
              <span style="font-size:18px;font-weight:700;color:var(--accent-ink);">${icon} ${val}</span>
            </div>`).join('')}
        </div>
      </div>

      <!-- Reflection Questions -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <p style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.12em;margin:0;">REFLECTION (3 questions — be honest, not self-critical)</p>

        <div style="display:flex;flex-direction:column;gap:5px;">
          <label class="card-label" for="wr-q1">1. What went well this week?</label>
          <textarea id="wr-q1" rows="2" placeholder="e.g. Completed Polity chapters 4-6, maintained streak…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;"></textarea>
        </div>

        <div style="display:flex;flex-direction:column;gap:5px;">
          <label class="card-label" for="wr-q2">2. What needs to improve?</label>
          <textarea id="wr-q2" rows="2" placeholder="e.g. Answer writing was skipped, economy notes incomplete…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;"></textarea>
        </div>

        <div style="display:flex;flex-direction:column;gap:5px;">
          <label class="card-label" for="wr-q3">3. One specific target for next week</label>
          <textarea id="wr-q3" rows="2" placeholder="e.g. Complete 3 Economy lectures + 1 mock test + 7 mains answers…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;"></textarea>
        </div>
      </div>

      ${lastReview ? `
        <details style="border-top:1px solid var(--line);padding-top:12px;">
          <summary style="cursor:pointer;font-family:var(--font-mono);font-size:11px;
            color:var(--muted);letter-spacing:.1em;user-select:none;">LAST WEEK (${lastReview.weekEnd})</summary>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
            ${[['Went well', lastReview.went_well], ['Improve', lastReview.improve], ['Target', lastReview.next_week]]
              .filter(([, v]) => v)
              .map(([k, v]) => `<p style="font-size:12px;color:var(--ink-soft);margin:0;"><b style="color:var(--muted);">${k}:</b> ${v}</p>`)
              .join('')}
          </div>
        </details>` : ''}

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn ghost" id="wr-close">Close</button>
        <button class="btn primary" id="wr-save">Save Review</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('wr-x')?.addEventListener('click', close)
  document.getElementById('wr-close')?.addEventListener('click', close)

  const esc_h = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) } }
  document.addEventListener('keydown', esc_h)

  document.getElementById('wr-save')?.addEventListener('click', () => {
    const q1 = (document.getElementById('wr-q1') as HTMLTextAreaElement).value.trim()
    const q2 = (document.getElementById('wr-q2') as HTMLTextAreaElement).value.trim()
    const q3 = (document.getElementById('wr-q3') as HTMLTextAreaElement).value.trim()

    if (!q1 && !q2 && !q3) {
      toast('Fill in at least one reflection question.', 'info'); return
    }

    const review: WeeklyReview = {
      weekEnd:   today,
      hours:     stats.hours,
      lectures:  stats.lectures,
      streak:    stats.streak,
      avgScore:  stats.avgScore,
      went_well: q1,
      improve:   q2,
      next_week: q3,
    }
    saveReview(review)
    toast('Weekly review saved. See you next week, Om 💪')
    close()
  })
}

// ── Command menu injection ────────────────────────────────────────────────────

export function injectWeeklyReviewToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-weekly-review')) return

  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-weekly-review'; card.href = '#'
  card.innerHTML = `<span class="cm-no">📋</span><span class="cm-t">Weekly Review</span><span class="cm-d">Reflect on this week's progress</span>`
  card.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showWeeklyReview()
  })
  grid.appendChild(card)
}
