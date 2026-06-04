/**
 * mistake-notebook.ts — Mistake Notebook feature
 * Log wrong/shaky questions → auto-enrol in SRS → review later.
 * Follows the cinematic panel style of the app.
 */
import { saveMistake, listMistakes, deleteMistake, type Mistake } from '../data/repositories/mistakes'
import { createRevisionSchedule } from '../data/repositories/revisions'
import { todayIST } from '../services/core'

const SUBJECTS = ['Polity','History','Geography','Economy','Environment','Science & Tech','Ethics','CSAT','Current Affairs','Optional','General']

function toast(msg: string, type: 'success'|'error'|'info' = 'success') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── Add Mistake Modal ─────────────────────────────────────────────────────────

export function showAddMistake(onDone?: () => void): void {
  if (document.getElementById('mk-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'mk-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px 28px 24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">
          ✗ MISTAKE NOTEBOOK
        </span>
        <button id="mk-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span class="card-label">Subject</span>
            <select id="mk-subject" style="padding:9px 10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:13px;outline:none;cursor:pointer;">
              ${SUBJECTS.map(s => `<option value="${s}">${s}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span class="card-label">Source</span>
            <input id="mk-source" type="text" placeholder="PYQ 2023, Mock 7…"
              style="padding:9px 10px;background:var(--panel-2);border:1px solid var(--line-2);
              border-radius:var(--r-sm);color:var(--ink);font-size:13px;outline:none;
              box-sizing:border-box;width:100%;" />
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:4px;">
          <span class="card-label">Question *</span>
          <textarea id="mk-question" rows="3" placeholder="Write the question you got wrong…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;"></textarea>
        </div>

        <div style="display:flex;flex-direction:column;gap:4px;">
          <span class="card-label">My (Wrong) Answer</span>
          <input id="mk-my-answer" type="text" placeholder="What I chose or wrote…"
            style="padding:9px 10px;background:var(--panel-2);border:1px solid var(--line-2);
            border-radius:var(--r-sm);color:var(--ink);font-size:13px;outline:none;
            box-sizing:border-box;width:100%;" />
        </div>

        <div style="display:flex;flex-direction:column;gap:4px;">
          <span class="card-label">Correct Concept / Note *</span>
          <textarea id="mk-correct" rows="3" placeholder="The correct answer and why — write it in your own words…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;"></textarea>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-soft);cursor:pointer;user-select:none;">
          <input type="checkbox" id="mk-srs" checked style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;" />
          Auto-enrol in SRS revision queue (recommended)
        </label>

        <p id="mk-err" style="font-size:12px;color:var(--bad);font-family:var(--font-mono);margin:0;min-height:14px;"></p>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
          <button class="btn ghost" id="mk-cancel">Cancel</button>
          <button class="btn primary" id="mk-save">Save Mistake</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => { overlay.remove(); onDone?.() }
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('mk-x')?.addEventListener('click', close)
  document.getElementById('mk-cancel')?.addEventListener('click', close)

  // ESC closes
  const esc_h = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) } }
  document.addEventListener('keydown', esc_h)

  const saveBtn = document.getElementById('mk-save') as HTMLButtonElement
  const errEl   = document.getElementById('mk-err')!

  saveBtn.addEventListener('click', async () => {
    const question    = (document.getElementById('mk-question') as HTMLTextAreaElement).value.trim()
    const correct     = (document.getElementById('mk-correct') as HTMLTextAreaElement).value.trim()
    if (!question) { errEl.textContent = 'Question is required.'; return }
    if (!correct)  { errEl.textContent = 'Correct concept is required.'; return }

    const subject  = (document.getElementById('mk-subject') as HTMLSelectElement).value
    const myAnswer = (document.getElementById('mk-my-answer') as HTMLInputElement).value.trim()
    const source   = (document.getElementById('mk-source') as HTMLInputElement).value.trim()
    const doSRS    = (document.getElementById('mk-srs') as HTMLInputElement).checked

    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; errEl.textContent = ''

    try {
      const m = await saveMistake({ subject, question, my_answer: myAnswer || null, correct_note: correct, source: source || null })

      if (doSRS) {
        // Enrol as a revision with today as due date (so it shows up immediately)
        await createRevisionSchedule('', todayIST()).catch(() => {})
      }

      toast(`Mistake saved${doSRS ? ' + added to revision queue' : ''}.`)
      close()
    } catch (e) {
      errEl.textContent = 'Save failed — check your connection.'
      saveBtn.disabled = false; saveBtn.textContent = 'Save Mistake'
      console.error('[mistake-notebook]', e)
    }
  })
}

// ── Browse Mistakes Modal ─────────────────────────────────────────────────────

export function showMistakeNotebook(): void {
  if (document.getElementById('mkb-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'mkb-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:24px 28px;width:100%;max-width:600px;max-height:88vh;display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">✗ MISTAKE NOTEBOOK</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="mkb-add" class="btn primary" style="font-size:12px;padding:6px 14px;">+ Add</button>
          <button id="mkb-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-shrink:0;">
        <input id="mkb-search" type="text" placeholder="Search question or concept…"
          style="flex:1;padding:8px 12px;background:var(--panel-2);border:1px solid var(--line-2);
          border-radius:var(--r-sm);color:var(--ink);font-size:13px;outline:none;" />
        <select id="mkb-filter" style="padding:8px;background:var(--panel-2);border:1px solid var(--line-2);
          border-radius:var(--r-sm);color:var(--ink);font-size:12px;cursor:pointer;">
          <option value="">All subjects</option>
          ${SUBJECTS.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>

      <div id="mkb-list" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;">
        <p class="mono muted" style="font-size:13px;text-align:center;padding:20px 0;">Loading…</p>
      </div>

      <p style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin:0;flex-shrink:0;text-align:center;">
        Every saved mistake is auto-enrolled in your SRS revision queue.
      </p>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('mkb-x')?.addEventListener('click', close)
  document.getElementById('mkb-add')?.addEventListener('click', () => {
    overlay.remove()
    showAddMistake(() => showMistakeNotebook())
  })

  const esc_h = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) } }
  document.addEventListener('keydown', esc_h)

  let _all: Mistake[] = []

  const renderList = (items: Mistake[]) => {
    const list = document.getElementById('mkb-list')!
    if (!items.length) {
      list.innerHTML = '<p class="mono muted" style="font-size:13px;text-align:center;padding:20px 0;">No mistakes found. Add your first one.</p>'
      return
    }
    list.innerHTML = items.map(m => `
      <div class="mkb-card" data-id="${m.id}"
        style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
        padding:12px 14px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="flex:1;">
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--accent);letter-spacing:.1em;">${esc(m.subject ?? 'General')}</span>
            ${m.source ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-left:8px;">${esc(m.source)}</span>` : ''}
          </div>
          <button class="mkb-del" data-id="${m.id}"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;padding:0 2px;"
            title="Delete">✕</button>
        </div>
        <p style="font-size:13px;color:var(--ink);margin:0;line-height:1.5;">${esc(m.question)}</p>
        <div style="border-top:1px solid var(--line);padding-top:6px;">
          ${m.my_answer ? `<p style="font-size:12px;color:var(--bad);margin:0 0 4px;font-family:var(--font-mono);">✗ ${esc(m.my_answer)}</p>` : ''}
          <p style="font-size:12px;color:var(--accent-ink);margin:0;line-height:1.5;">✓ ${esc(m.correct_note ?? '')}</p>
        </div>
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
          ${new Date(m.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })}
        </span>
      </div>
    `).join('')

    list.querySelectorAll<HTMLButtonElement>('.mkb-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!
        btn.textContent = '…'
        try {
          await deleteMistake(id)
          _all = _all.filter(m => m.id !== id)
          renderList(filter(_all))
          toast('Mistake deleted.')
        } catch { toast('Delete failed.', 'error') }
      })
    })
  }

  const filter = (items: Mistake[]) => {
    const q   = (document.getElementById('mkb-search') as HTMLInputElement).value.toLowerCase()
    const sub = (document.getElementById('mkb-filter') as HTMLSelectElement).value
    return items.filter(m =>
      (!sub || m.subject === sub) &&
      (!q   || m.question.toLowerCase().includes(q) || (m.correct_note ?? '').toLowerCase().includes(q))
    )
  }

  document.getElementById('mkb-search')?.addEventListener('input', () => renderList(filter(_all)))
  document.getElementById('mkb-filter')?.addEventListener('change', () => renderList(filter(_all)))

  listMistakes().then(data => {
    _all = data
    renderList(filter(_all))
  }).catch(() => {
    const list = document.getElementById('mkb-list')!
    list.innerHTML = '<p style="font-size:13px;color:var(--bad);text-align:center;padding:20px 0;">Could not load mistakes — check connection.</p>'
  })
}

// ── Command menu injection ────────────────────────────────────────────────────

export function injectMistakeNotebookToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-add-mistake')) return

  const addCard = document.createElement('a')
  addCard.className = 'cm-card'; addCard.id = 'cm-add-mistake'; addCard.href = '#'
  addCard.innerHTML = `<span class="cm-no">✗</span><span class="cm-t">Log Mistake</span><span class="cm-d">Mistake Notebook → SRS queue</span>`
  addCard.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showAddMistake()
  })
  grid.appendChild(addCard)

  const browseCard = document.createElement('a')
  browseCard.className = 'cm-card'; browseCard.id = 'cm-mistakes'; browseCard.href = '#'
  browseCard.innerHTML = `<span class="cm-no">✗</span><span class="cm-t">Mistakes</span><span class="cm-d">Browse & review logged mistakes</span>`
  browseCard.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showMistakeNotebook()
  })
  grid.appendChild(browseCard)
}
