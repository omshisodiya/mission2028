import { DEFAULT_SETTINGS, type PlannerSettings } from '../services/planner'
import './settings.css'

type Store = { get(k: string, def: unknown): unknown; set(k: string, v: unknown): void }

function getStore(): Store | null {
  return (window as { MISSION?: { store: Store } }).MISSION?.store ?? null
}

export function loadSettings(): PlannerSettings {
  const store = getStore()
  if (!store) return { ...DEFAULT_SETTINGS }
  const saved = store.get('settings', null) as Partial<PlannerSettings> | null
  if (!saved) return { ...DEFAULT_SETTINGS }
  return {
    weekdayCapacity:       { ...DEFAULT_SETTINGS.weekdayCapacity,    ...saved.weekdayCapacity },
    examDate:              saved.examDate              ?? DEFAULT_SETTINGS.examDate,
    bufferDays:            saved.bufferDays            ?? DEFAULT_SETTINGS.bufferDays,
    subjectWeightage:      { ...DEFAULT_SETTINGS.subjectWeightage,   ...saved.subjectWeightage },
    maxMinsPerSubjectPerDay: saved.maxMinsPerSubjectPerDay ?? DEFAULT_SETTINGS.maxMinsPerSubjectPerDay,
  }
}

export function saveSettings(s: PlannerSettings): void {
  const store = getStore()
  if (!store) return
  // Merge with existing store entry so non-PlannerSettings keys (e.g. focusMode) are preserved
  const existing = (store.get('settings', {}) ?? {}) as object
  store.set('settings', { ...existing, ...s })
}

const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const DAY_FULL: Record<string,string> = {
  Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday',
  Fri:'Friday', Sat:'Saturday', Sun:'Sunday',
}
const SUBJECTS = [
  'Polity', 'Modern History', 'Geography', 'Economy',
  'Environment', 'Mathematics', 'CSAT', 'Art & Culture', 'Bridge Course',
]

export function showSettings(onSave: (s: PlannerSettings) => void): void {
  if (document.getElementById('settings-overlay')) return

  const current = loadSettings()
  const overlay = document.createElement('div')
  overlay.id = 'settings-overlay'
  overlay.innerHTML = `
    <div id="settings-panel" class="panel panel-pad">
      <div class="st-head">
        <h3>Planner Settings</h3>
        <button class="st-close" id="st-x">&times;</button>
      </div>

      <div class="st-section">
        <div class="st-section-title">Daily Study Capacity (minutes)</div>
        <div class="st-grid-7">
          ${DAYS.map(d => `
            <div class="st-day-field">
              <span class="st-day-label">${d}</span>
              <input class="st-day-input" type="number" id="cap-${d}"
                min="0" max="720" step="30" value="${current.weekdayCapacity[d] ?? 0}" />
            </div>`).join('')}
        </div>
        <p class="st-note">Enter 0 to mark a day off. 180 = 3 hours.</p>
      </div>

      <div class="st-section">
        <div class="st-section-title">Exam Dates</div>
        <div class="st-field">
          <span class="card-label">Prelims date</span>
          <input class="st-input" type="date" id="exam-date" value="${current.examDate}" />
        </div>
        <div class="st-field">
          <span class="card-label">Buffer (days before exam — revisions only)</span>
          <input class="st-input" type="number" id="buf-days" min="0" max="180" value="${current.bufferDays}" />
        </div>
      </div>

      <div class="st-section">
        <div class="st-section-title">Subject Weightage (PYQ priority)</div>
        ${SUBJECTS.map(s => {
          const w = (current.subjectWeightage[s] ?? 1.0).toFixed(1)
          return `
          <div class="st-weight-row">
            <span class="st-weight-name">${s}</span>
            <input class="st-weight-slider" type="range" id="wt-${s.replace(/\s+/g,'-')}"
              min="0.5" max="2.0" step="0.1" value="${w}" />
            <span class="st-weight-val" id="wv-${s.replace(/\s+/g,'-')}">${w}×</span>
          </div>`
        }).join('')}
        <p class="st-note">Higher = scheduled earlier. 1.5 = high-yield, 0.8 = low-yield.</p>
      </div>

      <div class="st-save-row">
        <button class="btn ghost" id="st-cancel">Cancel</button>
        <button class="btn primary" id="st-save">Save & Re-generate</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('st-x')?.addEventListener('click', close)
  document.getElementById('st-cancel')?.addEventListener('click', close)

  // Live weightage display
  SUBJECTS.forEach(s => {
    const id = s.replace(/\s+/g, '-')
    const sl = document.getElementById(`wt-${id}`) as HTMLInputElement | null
    const vl = document.getElementById(`wv-${id}`)
    sl?.addEventListener('input', () => { if (vl) vl.textContent = parseFloat(sl.value).toFixed(1) + '×' })
  })

  const saveErr = document.createElement('p')
  saveErr.style.cssText = 'color:var(--bad,#e05555);font-family:var(--font-mono);font-size:11.5px;margin:4px 0 0;min-height:16px;'
  document.querySelector('.st-save-row')?.insertAdjacentElement('beforebegin', saveErr)

  document.getElementById('st-save')?.addEventListener('click', () => {
    saveErr.textContent = ''
    const examDateVal = (document.getElementById('exam-date') as HTMLInputElement)?.value ?? DEFAULT_SETTINGS.examDate
    const today = new Date().toISOString().slice(0, 10)
    if (examDateVal && examDateVal <= today) {
      saveErr.textContent = 'Exam date must be in the future.'
      return
    }
    const weekCap = Object.fromEntries(
      DAYS.map(d => [d, Math.max(0, Math.min(720, parseInt((document.getElementById(`cap-${d}`) as HTMLInputElement)?.value ?? '0')))])
    )
    const totalCap = Object.values(weekCap).reduce((a, b) => a + b, 0)
    if (totalCap === 0) {
      saveErr.textContent = 'At least one day must have study capacity > 0.'
      return
    }
    const s: PlannerSettings = {
      weekdayCapacity: weekCap,
      examDate:   examDateVal,
      bufferDays: Math.max(0, Math.min(180, parseInt((document.getElementById('buf-days') as HTMLInputElement)?.value ?? '60'))),
      subjectWeightage: Object.fromEntries(
        SUBJECTS.map(sub => {
          const id  = sub.replace(/\s+/g, '-')
          const val = Math.max(0.5, Math.min(2.0, parseFloat((document.getElementById(`wt-${id}`) as HTMLInputElement)?.value ?? '1.0')))
          return [sub, val]
        })
      ),
      maxMinsPerSubjectPerDay: current.maxMinsPerSubjectPerDay,
    }
    saveSettings(s)
    close()
    onSave(s)
  })
}
