import { insertOneLecture, type LectureStatus } from '../data/repositories/lectures'
import './manual-add.css'

type OnDone = () => Promise<void>

let _onDone: OnDone = async () => {}

export function showManualAdd(onDone: OnDone): void {
  _onDone = onDone
  if (document.getElementById('ma-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'ma-overlay'
  overlay.innerHTML = `
    <div class="ma-panel panel panel-pad">
      <div class="ma-head">
        <h3>Add Lecture</h3>
        <button class="ma-close" id="ma-x" aria-label="Close">×</button>
      </div>
      <form class="ma-form" id="ma-form" autocomplete="off">
        <input class="ma-input" name="title" placeholder="Title *" required />
        <input class="ma-input" name="subject" placeholder="Subject (e.g. Polity, Geography)" />
        <div class="ma-row">
          <input class="ma-input" name="sequence" type="number" min="1" placeholder="Sequence #" />
          <input class="ma-input" name="duration_min" type="number" min="1" value="60" placeholder="Duration (min)" />
          <input class="ma-input" name="week" type="number" min="1" placeholder="Week #" />
        </div>
        <select class="ma-select" name="status">
          <option value="backlog">Backlog</option>
          <option value="today">Today</option>
          <option value="upcoming">Upcoming</option>
        </select>
        <input class="ma-input" name="source" placeholder="Source (default: PW · Prarambh)" />
        <p class="ma-err" id="ma-err"></p>
        <div class="ma-footer">
          <button class="btn ghost" type="button" id="ma-cancel">Cancel</button>
          <button class="btn primary" type="submit" id="ma-submit">Add lecture</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('ma-x')?.addEventListener('click', close)
  document.getElementById('ma-cancel')?.addEventListener('click', close)

  const form = document.getElementById('ma-form') as HTMLFormElement
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const btn = document.getElementById('ma-submit') as HTMLButtonElement
    const errEl = document.getElementById('ma-err')!
    errEl.textContent = ''

    const fd = new FormData(form)
    const title = (fd.get('title') as string).trim()
    if (!title) return

    btn.disabled = true
    btn.textContent = 'Adding…'

    try {
      await insertOneLecture({
        title,
        subject:     (fd.get('subject') as string).trim() || undefined,
        sequence:    fd.get('sequence') ? Number(fd.get('sequence')) : null,
        duration_min: fd.get('duration_min') ? Number(fd.get('duration_min')) : 60,
        week:        fd.get('week') ? Number(fd.get('week')) : null,
        status:      (fd.get('status') as LectureStatus) ?? 'backlog',
        source:      (fd.get('source') as string).trim() || undefined,
      })
      close()
      await _onDone()
    } catch (err) {
      errEl.textContent = err instanceof Error ? err.message : 'Failed to add lecture.'
      btn.disabled = false
      btn.textContent = 'Add lecture'
    }
  })
}
