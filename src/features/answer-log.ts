import { insertAnswerEntry, weeklyAnswerCounts, listAnswerEntries } from '../data/repositories/answers'
import { todayIST } from '../services/core'

type OnDone = () => void

export function showAnswerLog(onDone: OnDone): void {
  if (document.getElementById('al-overlay')) return
  const today = todayIST()
  const overlay = document.createElement('div')
  overlay.id = 'al-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:600;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.88);backdrop-filter:blur(6px);padding:20px;'
  overlay.innerHTML = `
    <div class="panel panel-pad" style="width:100%;max-width:420px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <h3 style="margin:0;font-size:18px;">Log Answer</h3>
        <button id="al-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;flex-direction:column;gap:5px;">
          <span class="card-label">Question / Topic *</span>
          <textarea id="al-q" rows="2" placeholder="e.g. Discuss the role of civil society in India's democracy"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px 14px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-family:var(--font-body);font-size:14px;outline:none;"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div style="display:flex;flex-direction:column;gap:5px;">
            <span class="card-label">Words</span>
            <input id="al-wc" type="number" min="0" placeholder="200"
              style="padding:10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:14px;outline:none;width:100%;box-sizing:border-box;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <span class="card-label">Time (min)</span>
            <input id="al-time" type="number" min="0" placeholder="12"
              style="padding:10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:14px;outline:none;width:100%;box-sizing:border-box;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <span class="card-label">Score /10</span>
            <input id="al-score" type="number" min="0" max="10" step="0.5" placeholder="7"
              style="padding:10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:14px;outline:none;width:100%;box-sizing:border-box;" />
          </div>
        </div>
        <p id="al-err" style="font-size:12px;color:var(--bad);min-height:16px;font-family:var(--font-mono);margin:0;"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn ghost" id="al-cancel">Cancel</button>
          <button class="btn primary" id="al-save">Save answer</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('al-x')?.addEventListener('click', close)
  document.getElementById('al-cancel')?.addEventListener('click', close)

  const btn = document.getElementById('al-save') as HTMLButtonElement
  const err = document.getElementById('al-err')!
  btn.addEventListener('click', async () => {
    const q  = (document.getElementById('al-q') as HTMLTextAreaElement).value.trim()
    if (!q) { err.textContent = 'Question is required.'; return }
    btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = ''
    try {
      await insertAnswerEntry({
        question:   q,
        word_count: parseInt((document.getElementById('al-wc') as HTMLInputElement).value) || null,
        time_min:   parseInt((document.getElementById('al-time') as HTMLInputElement).value) || null,
        score:      parseFloat((document.getElementById('al-score') as HTMLInputElement).value) || null,
        written_on: today,
      })
      close(); onDone()
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : 'Save failed.'
      btn.disabled = false; btn.textContent = 'Save answer'
    }
  })
}

/** Re-render the answer-writing tracker bar chart in #plan with real data. */
export async function bindAnswerTracker(): Promise<void> {
  const rawCounts = await weeklyAnswerCounts(6).catch(() => [] as number[])
  // Pad to exactly 6 weeks so bar indices are always valid
  const counts = Array.from({ length: 6 }, (_, i) => rawCounts[i] ?? 0)
  const total  = counts.reduce((s, v) => s + v, 0)

  // Find the Answer-writing tracker panel by its card-label text
  let trackerPanel: HTMLElement | null = null
  document.querySelectorAll<HTMLElement>('#plan .card-label').forEach(lbl => {
    if (lbl.textContent?.toLowerCase().includes('answer')) {
      trackerPanel = lbl.closest('.panel') as HTMLElement
    }
  })
  if (!trackerPanel) return
  const panel = trackerPanel as HTMLElement

  // Update total count
  const totalEl = panel.querySelector('.mono[style]')
  if (totalEl) totalEl.textContent = `${total} answers`

  // Update bar heights
  const maxCount = Math.max(...counts, 1)  // guard: never 0 via spread
  const bars = panel.querySelectorAll<HTMLElement>('.col')
  counts.forEach((v, i) => {
    if (i < bars.length) {
      const pct = Math.round((v / maxCount) * 100)
      bars[i].setAttribute('data-v', String(pct))
      bars[i].style.height = pct + '%'
    }
  })

  // Add "Log Answer" button if not already present — use card-label as anchor, not CSS
  const head = panel.querySelector<HTMLElement>('.card-label') ?? panel.querySelector<HTMLElement>('h3,h4,[class*="head"]')
  if (head && !panel.querySelector('#al-add-btn')) {
    const btn = document.createElement('button')
    btn.id = 'al-add-btn'
    btn.className = 'btn ghost'
    btn.style.cssText = 'font-size:11px;padding:4px 10px;'
    btn.textContent = '+ Log'
    btn.addEventListener('click', () => showAnswerLog(() => { void bindAnswerTracker() }))
    head.appendChild(btn)
  }
}
