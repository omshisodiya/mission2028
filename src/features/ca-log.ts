import { insertCAEntry, listCurrentAffairs, type CAEntry } from '../data/repositories/ca'
import { todayIST } from '../services/core'

type OnDone = () => void

export function showCALog(onDone: OnDone): void {
  if (document.getElementById('ca-overlay')) return
  const today = todayIST()
  const overlay = document.createElement('div')
  overlay.id = 'ca-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:600;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.88);backdrop-filter:blur(6px);padding:20px;'
  overlay.innerHTML = `
    <div class="panel panel-pad" style="width:100%;max-width:440px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <h3 style="margin:0;font-size:18px;">Log Current Affairs</h3>
        <button id="ca-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;flex-direction:column;gap:5px;">
          <span class="card-label">Headline *</span>
          <input id="ca-headline" type="text" placeholder="e.g. RBI monetary policy — repo rate unchanged"
            style="width:100%;box-sizing:border-box;padding:10px 14px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:14px;outline:none;" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="display:flex;flex-direction:column;gap:5px;">
            <span class="card-label">GS Paper</span>
            <select id="ca-gs" style="padding:10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:14px;outline:none;cursor:pointer;">
              <option value="GS1">GS1</option>
              <option value="GS2" selected>GS2</option>
              <option value="GS3">GS3</option>
              <option value="GS4">GS4</option>
              <option value="CSAT">CSAT</option>
              <option value="General">General</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <span class="card-label">Source</span>
            <input id="ca-source" type="text" placeholder="The Hindu, PIB…"
              style="padding:10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:14px;outline:none;width:100%;box-sizing:border-box;" />
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;">
          <span class="card-label">Note (optional)</span>
          <textarea id="ca-note" rows="2" placeholder="Relevance to syllabus, key points…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px 14px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-family:var(--font-body);font-size:13px;outline:none;"></textarea>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-soft);cursor:pointer;">
          <input type="checkbox" id="ca-revise" />
          Add to SRS revision queue
        </label>
        <p id="ca-err" style="font-size:12px;color:var(--bad);min-height:16px;font-family:var(--font-mono);margin:0;"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn ghost" id="ca-cancel">Cancel</button>
          <button class="btn primary" id="ca-save">Save CA</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('ca-x')?.addEventListener('click', close)
  document.getElementById('ca-cancel')?.addEventListener('click', close)

  const btn = document.getElementById('ca-save') as HTMLButtonElement
  const err = document.getElementById('ca-err')!
  btn.addEventListener('click', async () => {
    const headline = (document.getElementById('ca-headline') as HTMLInputElement).value.trim()
    if (!headline) { err.textContent = 'Headline is required.'; return }
    btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = ''
    try {
      await insertCAEntry({
        headline,
        note:     (document.getElementById('ca-note') as HTMLTextAreaElement).value.trim() || null,
        source:   (document.getElementById('ca-source') as HTMLInputElement).value.trim() || null,
        gs_paper: (document.getElementById('ca-gs') as HTMLSelectElement).value,
        ca_date:  today,
        revise:   (document.getElementById('ca-revise') as HTMLInputElement).checked,
      })
      close(); onDone()
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : 'Save failed.'
      btn.disabled = false; btn.textContent = 'Save CA'
    }
  })
}

/** Replace the hardcoded CA feed in #plan with real entries from Supabase. */
export async function bindCAFeed(): Promise<void> {
  const entries = await listCurrentAffairs(7).catch(() => [] as CAEntry[])

  // Find the "Current affairs" feed container
  let feedPanel: HTMLElement | null = null
  document.querySelectorAll<HTMLElement>('#plan .card-label').forEach(lbl => {
    if (lbl.textContent?.toLowerCase().includes('current affairs')) {
      feedPanel = lbl.closest('.panel') as HTMLElement
    }
  })
  if (!feedPanel) return
  const panel = feedPanel as HTMLElement

  // Add "Log CA" button if not already present
  const head = panel.querySelector<HTMLElement>('.card-label')
  if (head && !panel.querySelector('#ca-add-btn')) {
    const btn = document.createElement('button')
    btn.id = 'ca-add-btn'
    btn.className = 'btn ghost'
    btn.style.cssText = 'font-size:11px;padding:4px 10px;float:right;'
    btn.textContent = '+ Log CA'
    btn.addEventListener('click', () => showCALog(() => { void bindCAFeed() }))
    head.insertAdjacentElement('afterend', btn)
  }

  if (entries.length === 0) return  // keep hardcoded demo items if no real data

  // Replace feed content
  const feedDiv = panel.querySelector('[style*="margin-top"]') as HTMLElement | null
  if (!feedDiv) return

  const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  feedDiv.innerHTML = entries.map(e => {
    const parts = (e.ca_date ?? '').split('-').map(Number)
    const m = parts[1] ?? 1; const d = parts[2] ?? 1
    const dateStr = `${MONTH_ABBR[(m - 1)] ?? '?'} ${String(d).padStart(2, '0')}`
    const gs = e.gs_paper ?? 'GS'
    return `
      <div class="feed-item">
        <div class="feed-date">${dateStr}</div>
        <div class="feed-body">
          <h4>${esc(e.headline)}</h4>
          ${e.note ? `<p>${esc(e.note)}</p>` : ''}
          <span class="feed-cat">${gs}${e.revise ? ' · In SRS' : ''}</span>
        </div>
      </div>`
  }).join('')
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
