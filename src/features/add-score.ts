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
        <details style="margin-top:4px;">
          <summary class="mono muted" style="font-size:11.5px;cursor:pointer;letter-spacing:.06em;">
            MCQ BREAKDOWN (optional — for negative-marking analysis)
          </summary>
          <div class="as-row" style="margin-top:10px;">
            <div class="as-field">
              <span class="card-label">Attempted</span>
              <input class="as-input" name="attempted" type="number" min="0" placeholder="—" />
            </div>
            <div class="as-field">
              <span class="card-label">Correct</span>
              <input class="as-input" name="correct" type="number" min="0" placeholder="—" />
            </div>
            <div class="as-field">
              <span class="card-label">Wrong</span>
              <input class="as-input" name="wrong" type="number" min="0" placeholder="—" />
            </div>
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--muted);font-family:var(--font-mono);">
            Score = Correct×2 − Wrong×0.66 &nbsp;|&nbsp;
            Accuracy = Correct/Attempted×100
          </div>
        </details>
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

  // Live accuracy + negative-marking display
  const scoreIn    = overlay.querySelector<HTMLInputElement>('[name=score]')!
  const maxIn      = overlay.querySelector<HTMLInputElement>('[name=max_score]')!
  const attemptedIn = overlay.querySelector<HTMLInputElement>('[name=attempted]')
  const correctIn  = overlay.querySelector<HTMLInputElement>('[name=correct]')
  const wrongIn    = overlay.querySelector<HTMLInputElement>('[name=wrong]')
  const pctEl      = document.getElementById('as-pct')!
  function updatePct() {
    const cor = parseFloat(correctIn?.value ?? '')
    const wrg = parseFloat(wrongIn?.value ?? '')
    const att = parseFloat(attemptedIn?.value ?? '')
    if (!isNaN(cor) && !isNaN(wrg)) {
      const ts  = cor * 2 - wrg * 0.66
      const acc = !isNaN(att) && att > 0 ? (cor / att * 100).toFixed(1) + '%' : '—'
      pctEl.textContent = `Score: ${ts.toFixed(1)} · Accuracy: ${acc}`
      if (!isNaN(ts)) { scoreIn.value = ts.toFixed(2) }
    } else {
      const s = parseFloat(scoreIn.value), m = parseFloat(maxIn.value)
      pctEl.textContent = (!isNaN(s) && !isNaN(m) && m > 0)
        ? (s / m * 100).toFixed(1) + '%' : '—'
    }
  }
  scoreIn.addEventListener('input', updatePct)
  maxIn.addEventListener('input', updatePct)
  correctIn?.addEventListener('input', updatePct)
  wrongIn?.addEventListener('input', updatePct)
  attemptedIn?.addEventListener('input', updatePct)

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
    const attempted = parseInt(fd.get('attempted') as string) || null
    const correct   = parseInt(fd.get('correct') as string)   || null
    const wrong     = parseInt(fd.get('wrong') as string)     || null
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
        attempted,
        correct,
        wrong,
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
