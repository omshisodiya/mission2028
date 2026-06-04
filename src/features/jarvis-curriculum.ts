/**
 * jarvis-curriculum.ts — Adaptive Personalized Study Curriculum
 *
 * Builds a day-by-day study plan that:
 * - Weighs weak vs strong areas from the adaptive engine
 * - Schedules SRS revisions at optimal intervals
 * - Adapts when Om falls behind (redistributes load)
 * - Tracks completion and adjusts future days
 * - Visualises as an interactive timeline panel
 */

import { todayIST } from '../services/core'

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const CURR_KEY   = 'jarvis_curriculum_v1'

function groqKey(): string | undefined { return import.meta.env.VITE_GROQ_API_KEY as string | undefined }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CurriculumDay {
  date:        string
  subjects:    string[]
  lectureGoal: number
  revisions:   number
  mcqTarget:   number
  mainsTarget: number
  mockTest:    boolean
  note:        string
  completed:   boolean
  score?:      number
}

export interface Curriculum {
  createdAt:  string
  examDate:   string
  days:       CurriculumDay[]
  version:    number
  totalDays:  number
  coverage:   number
  adaptedAt?: string
}

// ── Storage ────────────────────────────────────────────────────────────────────

export function loadCurriculum(): Curriculum | null {
  try { return JSON.parse(localStorage.getItem(CURR_KEY) ?? 'null') } catch { return null }
}

function saveCurriculum(c: Curriculum): void {
  localStorage.setItem(CURR_KEY, JSON.stringify(c))
}

// ── Build curriculum ───────────────────────────────────────────────────────────

export async function buildCurriculum(
  examDate: string,
  totalLectures: number,
  doneLectures: number,
  weakTopics: string[],
  strongTopics: string[],
  avgScore: number | null,
  respond: (t: string) => void,
): Promise<Curriculum | null> {
  const k = groqKey(); if (!k) { respond('Groq API key required for curriculum generation.'); return null }

  const today     = todayIST()
  const daysLeft  = Math.ceil((new Date(examDate).getTime() - new Date(today).getTime()) / 86_400_000)
  if (daysLeft <= 0) { respond('Exam date is in the past. Update it in Settings.'); return null }

  const remaining = totalLectures - doneLectures
  respond(`Building ${daysLeft}-day adaptive curriculum for ${remaining} remaining lectures…`)

  const prompt = `Build a UPSC preparation curriculum for Om Shisodiya.
Exam date: ${examDate} (${daysLeft} days away)
Remaining lectures: ${remaining} of ${totalLectures}
Prelims avg score: ${avgScore?.toFixed(1) ?? 'not available'}%
Weak topics: ${weakTopics.slice(0, 5).join(', ') || 'none flagged'}
Strong topics: ${strongTopics.slice(0, 5).join(', ') || 'none flagged'}

Create a realistic ${Math.min(daysLeft, 30)}-day curriculum JSON.
Schedule:
- More lectures on good days (3-4), fewer near exam (revision only)
- Mock tests every 7 days
- Weak topics get 2x time vs strong topics
- Last 7 days: revision only, no new content
- SRS revision: 1-2 per day throughout
- Mains writing: 1 answer daily from day 5 onward

Return ONLY valid JSON (no markdown):
{"days":[{"date":"YYYY-MM-DD","subjects":["Subject"],"lectureGoal":2,"revisions":1,
"mcqTarget":30,"mainsTarget":1,"mockTest":false,"note":"brief note","completed":false}]}`

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{Authorization:`Bearer ${k}`,'Content-Type':'application/json'},
      body: JSON.stringify({model:GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens:3000, temperature:0.3, stream:false}),
    })
    if (!res.ok) throw new Error('Groq error')
    const d    = await res.json() as {choices:{message:{content:string}}[]}
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no JSON')
    const parsed = JSON.parse(m[0]) as { days: CurriculumDay[] }

    const curriculum: Curriculum = {
      createdAt:  new Date().toISOString(),
      examDate,
      days:       parsed.days.slice(0, Math.min(daysLeft, 60)),
      version:    1,
      totalDays:  Math.min(daysLeft, 60),
      coverage:   Math.round(doneLectures / Math.max(1, totalLectures) * 100),
    }

    saveCurriculum(curriculum)
    respond(`Curriculum built: ${curriculum.days.length} days, ${curriculum.days.filter(d => d.mockTest).length} mock tests, ${curriculum.days.reduce((s,d)=>s+d.lectureGoal,0)} total lecture goals.`)
    return curriculum
  } catch (e) {
    console.error('[curriculum]', e)
    respond('Curriculum generation failed. Building local fallback…')
    return buildLocalCurriculum(today, examDate, daysLeft, remaining, weakTopics)
  }
}

function buildLocalCurriculum(today: string, examDate: string, daysLeft: number, remaining: number, weakTopics: string[]): Curriculum {
  const lecturesPerDay = Math.ceil(remaining / Math.max(1, daysLeft * 0.7))
  const SUBJECTS       = ['Polity', 'History', 'Geography', 'Economy', 'Environment', 'Science & Tech', 'Ethics', 'CSAT']
  const days: CurriculumDay[] = []

  for (let i = 0; i < Math.min(daysLeft, 30); i++) {
    const [y, mo, d] = today.split('-').map(Number)
    const date       = new Date(Date.UTC(y, mo-1, d+i)).toISOString().slice(0, 10)
    const isLastWeek = i >= daysLeft - 7
    const dayOfWeek  = new Date(Date.UTC(y, mo-1, d+i)).getUTCDay()
    const isMockDay  = (i + 1) % 7 === 0 && !isLastWeek

    const subject = weakTopics[i % Math.max(1, weakTopics.length)] || SUBJECTS[i % SUBJECTS.length]

    days.push({
      date, subjects: [subject, SUBJECTS[(i + 1) % SUBJECTS.length]],
      lectureGoal: isLastWeek ? 0 : (dayOfWeek === 0 ? 1 : lecturesPerDay),
      revisions: isLastWeek ? 3 : 1,
      mcqTarget: isLastWeek ? 50 : 30,
      mainsTarget: i < 4 ? 0 : 1,
      mockTest: isMockDay,
      note: isLastWeek ? 'Revision only — no new content' : isMockDay ? 'Mock test day' : '',
      completed: false,
    })
  }

  const curriculum: Curriculum = {
    createdAt: new Date().toISOString(), examDate, days, version: 1,
    totalDays: days.length, coverage: 0,
  }
  saveCurriculum(curriculum)
  return curriculum
}

// ── Adapt curriculum ────────────────────────────────────────────────────────────

export function adaptCurriculum(doneDates: string[]): number {
  const curr = loadCurriculum()
  if (!curr) return 0

  // Mark completed days
  let updated = 0
  for (const d of curr.days) {
    if (doneDates.includes(d.date) && !d.completed) { d.completed = true; updated++ }
  }

  // Find missed days and redistribute their load
  const today       = todayIST()
  const missed      = curr.days.filter(d => !d.completed && d.date < today)
  const futureDays  = curr.days.filter(d => d.date >= today && !d.completed)

  if (missed.length > 0 && futureDays.length > 0) {
    const extraLectures = missed.reduce((s, d) => s + d.lectureGoal, 0)
    const perDay        = Math.ceil(extraLectures / Math.min(futureDays.length, 7))
    for (let i = 0; i < Math.min(7, futureDays.length); i++) {
      futureDays[i].lectureGoal += perDay
      futureDays[i].note = `+${perDay} catch-up from missed days`
    }
  }

  curr.adaptedAt = new Date().toISOString()
  saveCurriculum(curr)
  return updated
}

// ── Today's curriculum ─────────────────────────────────────────────────────────

export function getTodayCurriculum(): CurriculumDay | null {
  const today = todayIST()
  return loadCurriculum()?.days.find(d => d.date === today) ?? null
}

// ── Curriculum panel ───────────────────────────────────────────────────────────

export function showCurriculumPanel(): void {
  if (document.getElementById('curr-overlay')) document.getElementById('curr-overlay')!.remove()

  const curr = loadCurriculum()
  const overlay = document.createElement('div')
  overlay.id = 'curr-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.94);backdrop-filter:blur(10px);padding:16px;overflow-y:auto;'

  const today   = todayIST()
  const todayDay = curr?.days.find(d => d.date === today)
  const done    = curr?.days.filter(d => d.completed).length ?? 0
  const total   = curr?.days.length ?? 0
  const pct     = total ? Math.round(done / total * 100) : 0

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:24px 28px;width:100%;max-width:620px;max-height:90vh;overflow-y:auto;
      display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📅 ADAPTIVE CURRICULUM</span>
        <div style="display:flex;gap:6px;">
          <button id="curr-regen" class="btn ghost" style="font-size:11px;padding:5px 10px;">↺ Rebuild</button>
          <button id="curr-x" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">&times;</button>
        </div>
      </div>

      ${!curr ? `
        <div style="text-align:center;padding:24px;color:var(--muted);">
          <p>No curriculum yet.</p>
          <button id="curr-build" class="btn primary" style="margin-top:12px;">Build My Curriculum</button>
        </div>` : `

        <!-- Progress bar -->
        <div>
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">PROGRESS</span>
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--accent);">${done}/${total} days · ${pct}%</span>
          </div>
          <div style="height:4px;background:var(--line-2);border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px;transition:width .5s;"></div>
          </div>
        </div>

        <!-- Today's plan -->
        ${todayDay ? `
          <div style="background:rgba(240,181,74,.08);border:1px solid rgba(240,181,74,.3);border-radius:var(--r-sm);padding:14px;">
            <p style="font-family:var(--font-mono);font-size:10px;color:var(--accent);margin:0 0 8px;">TODAY — ${today}</p>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;font-size:12px;color:var(--ink-soft);">
              <span>📚 ${todayDay.lectureGoal} lectures</span>
              <span>❓ ${todayDay.mcqTarget} MCQs</span>
              <span>↻ ${todayDay.revisions} revisions</span>
              <span>✍ ${todayDay.mainsTarget} answer(s)</span>
              ${todayDay.mockTest ? '<span style="color:var(--accent);font-weight:600;">📝 MOCK TEST DAY</span>' : ''}
            </div>
            ${todayDay.note ? `<p style="font-size:11px;color:var(--muted);margin:6px 0 0;">${todayDay.note}</p>` : ''}
          </div>` : ''}

        <!-- Upcoming days -->
        <div style="display:flex;flex-direction:column;gap:6px;">
          <p style="font-family:var(--font-mono);font-size:10px;color:var(--muted);margin:0;">NEXT 7 DAYS</p>
          ${curr.days.filter(d => d.date >= today).slice(0, 7).map(d => {
            const isToday   = d.date === today
            const dayName   = new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', timeZone:'UTC' })
            const barColor  = d.mockTest ? 'var(--bad)' : isToday ? 'var(--accent)' : '#78a8ff'
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                background:${isToday ? 'rgba(240,181,74,.06)' : 'var(--panel-2)'};
                border:1px solid ${isToday ? 'rgba(240,181,74,.3)' : 'var(--line-2)'};
                border-radius:var(--r-sm);">
                <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);min-width:70px;">${dayName}</span>
                <div style="flex:1;display:flex;gap:6px;flex-wrap:wrap;">
                  ${d.subjects.slice(0,2).map(s=>`<span style="font-size:10px;color:${barColor};font-family:var(--font-mono);">${s.slice(0,8)}</span>`).join('')}
                  ${d.mockTest ? '<span style="font-size:10px;color:var(--bad);font-family:var(--font-mono);">MOCK</span>' : ''}
                </div>
                <span style="font-size:10px;color:var(--muted);">${d.lectureGoal}L·${d.mcqTarget}Q</span>
                ${d.completed ? '<span style="color:#45e0a8;font-size:12px;">✓</span>' : ''}
              </div>`
          }).join('')}
        </div>
        <p style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin:0;text-align:center;">
          Exam: ${curr.examDate} · ${curr.adaptedAt ? 'Adapted ' + curr.adaptedAt.slice(0,10) : 'Not yet adapted'}
        </p>`}
    </div>
  `

  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('curr-x')?.addEventListener('click', close)
  document.getElementById('curr-regen')?.addEventListener('click', () => {
    overlay.remove()
    window.dispatchEvent(new CustomEvent('jarvis:build-curriculum'))
  })
  document.getElementById('curr-build')?.addEventListener('click', () => {
    overlay.remove()
    window.dispatchEvent(new CustomEvent('jarvis:build-curriculum'))
  })
}

export function injectCurriculumToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-curriculum')) return
  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-curriculum'; card.href = '#'
  card.innerHTML = `<span class="cm-no">📅</span><span class="cm-t">Curriculum</span><span class="cm-d">Adaptive day-by-day study plan</span>`
  card.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showCurriculumPanel()
  })
  grid.appendChild(card)
}
