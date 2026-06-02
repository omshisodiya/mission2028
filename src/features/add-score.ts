import { insertScore } from '../data/repositories/scores'
import { todayIST } from '../services/core'
import './add-score.css'

type OnDone = () => void

export function showAddScore(onDone: OnDone): void {
  if (document.getElementById('as-overlay')) return

  const today = todayIST()
  const overlay = document.createElement('div')
  overlay.id = 'as-overlay'
  overlay.innerHTML = `
    <div class="as-panel panel panel-pad">
      <div class="as-head">
        <h3>Add Score</h3>
        <button class="as-close" id="as-x" aria-label="Close">&times;</button>
      </div>
      <form class="as-form" id="as-form" autocomplete="off">
        <div class="as-field">
          <span class="card-label">Label (optional)</span>
          <input class="as-input" name="label" placeholder="e.g. PW Prelims Mock 7, Polity DPP 3" />
        </div>
        <div class="as-row">
          <div class="as-field">
            <span class="card-label">Category</span>
            <select class="as-select" name="category">
              <option value="prelims">Prelims</option>
              <option value="csat">CSAT</option>
              <option value="mains">Mains</option>
              <option value="optional">Optional (Maths)</option>
              <option value="dpp">DPP</option>
              <option value="sectional">Sectional</option>
              <option value="quiz">Quiz</option>
            </select>
          </div>
          <div class="as-field">
            <span class="card-label">Subject (optional)</span>
            <input class="as-input" name="subject" placeholder="Polity, Economy…" />
          </div>
        </div>
        <div class="as-row">
          <div class="as-field">
            <span class="card-label">Score</span>
            <input class="as-input" name="score" type="number" min="0" step="0.5" placeholder="80" required />
          </div>
          <div class="as-field">
            <span class="card-label">Out of (max)</span>
            <input class="as-input" name="max_score" type="number" min="1" step="1" placeholder="100" required />
          </div>
        </div>
        <div class="as-score-display" id="as-pct">—</div>
        <div class="as-field">
          <span class="card-label">Date</span>
          <input class="as-input" name="date" type="date" value="${today}" required />
        </div>
        <p class="as-err" id="as-err"></p>
        <div class="as-footer">
          <button class="btn ghost" type="button" id="as-cancel">Cancel</button>
          <button class="btn primary" type="submit" id="as-submit">Add score</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('as-x')?.addEventListener('click', close)
  document.getElementById('as-cancel')?.addEventListener('click', close)

  // Live accuracy display
  const scoreIn = overlay.querySelector<HTMLInputElement>('[name=score]')!
  const maxIn   = overlay.querySelector<HTMLInputElement>('[name=max_score]')!
  const pctEl   = document.getElementById('as-pct')!
  function updatePct() {
    const s = parseFloat(scoreIn.value)
    const m = parseFloat(maxIn.value)
    if (!isNaN(s) && !isNaN(m) && m > 0) {
      pctEl.textContent = (s / m * 100).toFixed(1) + '%'
    } else {
      pctEl.textContent = '—'
    }
  }
  scoreIn.addEventListener('input', updatePct)
  maxIn.addEventListener('input', updatePct)

  const form = overlay.querySelector<HTMLFormElement>('#as-form')!
  const err  = document.getElementById('as-err')!
  const btn  = document.getElementById('as-submit') as HTMLButtonElement

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const fd = new FormData(form)
    const score     = parseFloat(fd.get('score') as string)
    const max_score = parseFloat(fd.get('max_score') as string)
    if (isNaN(score) || isNaN(max_score) || max_score <= 0) {
      err.textContent = 'Enter a valid score and max.'
      return
    }
    btn.disabled = true
    btn.textContent = 'Saving…'
    err.textContent = ''
    try {
      await insertScore({
        date:      (fd.get('date') as string) || today,
        category:  (fd.get('category') as string) || 'mock',
        subject:   (fd.get('subject') as string).trim() || null,
        score,
        max_score,
        label:     (fd.get('label') as string).trim() || null,
      })
      close()
      onDone()
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : 'Failed to save.'
      btn.disabled = false
      btn.textContent = 'Add score'
    }
  })
}
