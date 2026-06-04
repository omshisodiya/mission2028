/**
 * quick-notes.ts — Searchable notes attached to any lecture/topic.
 * Synced to Supabase `notes` table with full offline support.
 */
import { saveNote, listNotes, deleteNote, updateNote, type Note } from '../data/repositories/notes'

function toast(msg: string, type: 'success' | 'error' | 'info' = 'success') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Add/Edit Note Modal ───────────────────────────────────────────────────────

export function showAddNote(prefill = '', lectureId?: string, onDone?: () => void): void {
  if (document.getElementById('note-add-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'note-add-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px;width:100%;max-width:480px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📝 QUICK NOTE</span>
        <button id="note-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          <span class="card-label">Note (markdown supported)</span>
          <textarea id="note-body" rows="6" placeholder="Write your note — key insight, important fact, doubt, concept link…"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:10px 12px;
            background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;
            line-height:1.6;">${esc(prefill)}</textarea>
        </div>
        <p id="note-err" style="font-size:12px;color:var(--bad);font-family:var(--font-mono);margin:0;min-height:14px;"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn ghost" id="note-cancel">Cancel</button>
          <button class="btn primary" id="note-save">Save Note</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  ;(document.getElementById('note-body') as HTMLTextAreaElement).focus()

  const close = () => { overlay.remove(); onDone?.() }
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('note-x')?.addEventListener('click', close)
  document.getElementById('note-cancel')?.addEventListener('click', close)

  const esc_h = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) }
  }
  document.addEventListener('keydown', esc_h)

  const saveBtn = document.getElementById('note-save') as HTMLButtonElement
  const errEl   = document.getElementById('note-err')!

  saveBtn.addEventListener('click', async () => {
    const body = (document.getElementById('note-body') as HTMLTextAreaElement).value.trim()
    if (!body) { errEl.textContent = 'Note cannot be empty.'; return }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; errEl.textContent = ''

    try {
      await saveNote(body, lectureId ?? null)
      toast('Note saved.')
      close()
    } catch (e) {
      errEl.textContent = 'Save failed — check connection.'
      saveBtn.disabled = false; saveBtn.textContent = 'Save Note'
      console.error('[quick-notes]', e)
    }
  })
}

// ── Browse Notes Modal ────────────────────────────────────────────────────────

export function showNotes(): void {
  if (document.getElementById('notes-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'notes-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:24px 28px;width:100%;max-width:600px;max-height:88vh;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📝 NOTES</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="notes-add" class="btn primary" style="font-size:12px;padding:6px 14px;">+ New</button>
          <button id="notes-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
        </div>
      </div>

      <input id="notes-search" type="text" placeholder="Search notes…"
        style="flex-shrink:0;padding:8px 12px;background:var(--panel-2);border:1px solid var(--line-2);
        border-radius:var(--r-sm);color:var(--ink);font-size:13px;outline:none;" />

      <div id="notes-list" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;">
        <p class="mono muted" style="font-size:13px;text-align:center;padding:20px 0;">Loading…</p>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('notes-x')?.addEventListener('click', close)
  document.getElementById('notes-add')?.addEventListener('click', () => {
    overlay.remove()
    showAddNote('', undefined, () => showNotes())
  })

  const esc_h = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) }
  }
  document.addEventListener('keydown', esc_h)

  let _all: Note[] = []

  const renderNotes = (items: Note[]) => {
    const list = document.getElementById('notes-list')!
    if (!items.length) {
      list.innerHTML = '<p class="mono muted" style="font-size:13px;text-align:center;padding:24px 0;">No notes yet. Start capturing ideas!</p>'
      return
    }
    list.innerHTML = items.map(n => {
      const preview = n.body.slice(0, 200).replace(/\n/g, ' ')
      const date    = new Date(n.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      return `
        <div class="note-card" data-id="${n.id}"
          style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
          padding:12px 14px;display:flex;gap:10px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <p style="margin:0 0 4px;font-size:13px;color:var(--ink);line-height:1.5;
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(preview)}</p>
            <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">${date}</span>
          </div>
          <button class="note-del" data-id="${n.id}"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;
            line-height:1;flex-shrink:0;padding:2px 4px;" title="Delete note">✕</button>
        </div>`
    }).join('')

    list.querySelectorAll<HTMLButtonElement>('.note-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!
        try {
          await deleteNote(id)
          _all = _all.filter(n => n.id !== id)
          renderNotes(filter(_all))
          toast('Note deleted.')
        } catch { toast('Delete failed.', 'error') }
      })
    })
  }

  const filter = (items: Note[]) => {
    const q = (document.getElementById('notes-search') as HTMLInputElement).value.toLowerCase()
    return q ? items.filter(n => n.body.toLowerCase().includes(q)) : items
  }

  document.getElementById('notes-search')?.addEventListener('input', () => renderNotes(filter(_all)))

  listNotes().then(data => {
    _all = data
    renderNotes(filter(_all))
  }).catch(() => {
    const list = document.getElementById('notes-list')!
    list.innerHTML = '<p style="font-size:13px;color:var(--bad);text-align:center;padding:20px 0;">Could not load notes — check connection.</p>'
  })
}

// ── Command menu injection ────────────────────────────────────────────────────

export function injectNotesToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-add-note')) return

  const addCard = document.createElement('a')
  addCard.className = 'cm-card'; addCard.id = 'cm-add-note'; addCard.href = '#'
  addCard.innerHTML = `<span class="cm-no">📝</span><span class="cm-t">Quick Note</span><span class="cm-d">Capture idea, insight or doubt</span>`
  addCard.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showAddNote()
  })
  grid.appendChild(addCard)

  const browseCard = document.createElement('a')
  browseCard.className = 'cm-card'; browseCard.id = 'cm-notes'; browseCard.href = '#'
  browseCard.innerHTML = `<span class="cm-no">📝</span><span class="cm-t">Notes</span><span class="cm-d">Browse all saved notes</span>`
  browseCard.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showNotes()
  })
  grid.appendChild(browseCard)
}
