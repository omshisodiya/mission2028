/**
 * jarvis-session.ts — Study Session Recorder + Post-Session AI Coach
 *
 * Records everything that happens in a study session:
 * - Lectures completed, scores added, notes taken, mistakes logged
 * - Time distribution, focus quality, interruptions
 * - JARVIS interactions (what was asked, what was useful)
 *
 * After each session, generates a personalised coaching report.
 */

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const SESSION_KEY = 'jarvis_sessions_v1'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionEvent {
  type:    'lecture_done' | 'score_added' | 'note_added' | 'mistake_logged' |
           'quiz_completed' | 'revision_rated' | 'break_taken' | 'distraction' |
           'jarvis_query' | 'timer_started' | 'timer_stopped'
  detail:  string
  at:      string   // ISO timestamp
}

export interface StudySession {
  id:          string
  date:        string
  startMs:     number
  endMs:       number
  durationMin: number
  subject:     string
  events:      SessionEvent[]
  focusScore:  number   // 0-100 computed from event patterns
  lecturesDone: number
  scoresAdded:  number
  mistakesLogged: number
  jarvisQueries:  number
  coaching:       string   // post-session AI coaching text
}

// ── Active session tracking ────────────────────────────────────────────────────

let _activeSession: StudySession | null = null

export function startSession(subject: string): void {
  _activeSession = {
    id:          Date.now().toString(36),
    date:        new Date().toISOString().slice(0, 10),
    startMs:     Date.now(),
    endMs:       0,
    durationMin: 0,
    subject,
    events:      [],
    focusScore:  0,
    lecturesDone:   0,
    scoresAdded:    0,
    mistakesLogged: 0,
    jarvisQueries:  0,
    coaching:       '',
  }
}

export function recordEvent(type: SessionEvent['type'], detail: string): void {
  if (!_activeSession) return
  _activeSession.events.push({ type, detail, at: new Date().toISOString() })

  // Update counters
  if (type === 'lecture_done')   _activeSession.lecturesDone++
  if (type === 'score_added')    _activeSession.scoresAdded++
  if (type === 'mistake_logged') _activeSession.mistakesLogged++
  if (type === 'jarvis_query')   _activeSession.jarvisQueries++
}

export function isSessionActive(): boolean { return _activeSession !== null }
export function getActiveSession(): StudySession | null { return _activeSession }

// ── Focus score computation ────────────────────────────────────────────────────

function computeFocusScore(events: SessionEvent[], durationMin: number): number {
  if (!events.length || durationMin <= 0) return 50

  const activeEvents   = events.filter(e => ['lecture_done','score_added','note_added','revision_rated','jarvis_query'].includes(e.type)).length
  const distractions   = events.filter(e => e.type === 'distraction').length
  const breaks         = events.filter(e => e.type === 'break_taken').length

  // Activity rate: events per 25 min (one Pomodoro unit)
  const activityRate   = (activeEvents / Math.max(1, durationMin)) * 25
  const focusBase      = Math.min(100, activityRate * 20)
  const distractPenalty = distractions * 10
  const breakBonus     = Math.min(15, breaks * 5)  // breaks are good

  return Math.max(0, Math.min(100, focusBase - distractPenalty + breakBonus))
}

// ── End session + coaching ──────────────────────────────────────────────────────

export async function endSession(): Promise<StudySession | null> {
  if (!_activeSession) return null

  const session       = _activeSession
  session.endMs       = Date.now()
  session.durationMin = Math.round((session.endMs - session.startMs) / 60_000)
  session.focusScore  = computeFocusScore(session.events, session.durationMin)
  _activeSession      = null

  // Generate coaching
  session.coaching = await generateSessionCoaching(session)

  // Save
  const saved = loadSessions()
  saved.unshift(session)
  localStorage.setItem(SESSION_KEY, JSON.stringify(saved.slice(0, 90)))

  return session
}

async function generateSessionCoaching(s: StudySession): Promise<string> {
  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) return buildLocalCoaching(s)

  const prompt = `Post-session coaching for UPSC aspirant Om Shisodiya.
Session: ${s.durationMin} min, subject: ${s.subject}, focus score: ${s.focusScore}/100.
Events: ${s.lecturesDone} lectures done, ${s.scoresAdded} scores, ${s.mistakesLogged} mistakes logged,
${s.jarvisQueries} JARVIS queries, ${s.events.filter(e=>e.type==='break_taken').length} breaks,
${s.events.filter(e=>e.type==='distraction').length} distractions.
JARVIS queries: ${s.events.filter(e=>e.type==='jarvis_query').slice(0,3).map(e=>e.detail).join(', ')}.

Give a 2-sentence coaching message: one specific strength from this session, one specific improvement.
Be warm but direct. Reference actual numbers. Spoken format.`

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body: JSON.stringify({model:'llama-3.1-8b-instant', messages:[{role:'user',content:prompt}], max_tokens:150, temperature:0.6, stream:false}),
    })
    if (!res.ok) return buildLocalCoaching(s)
    const d = await res.json() as {choices:{message:{content:string}}[]}
    return d.choices[0]?.message?.content?.trim() ?? buildLocalCoaching(s)
  } catch { return buildLocalCoaching(s) }
}

function buildLocalCoaching(s: StudySession): string {
  const parts: string[] = []
  if (s.durationMin >= 90) parts.push(`Excellent — ${s.durationMin} minutes is a full deep work block.`)
  else if (s.durationMin >= 45) parts.push(`Solid ${s.durationMin}-minute session.`)
  else parts.push(`${s.durationMin} minutes — short but consistent beats infrequent and long.`)

  if (s.lecturesDone > 0) parts.push(`${s.lecturesDone} lecture${s.lecturesDone>1?'s':''} completed.`)
  if (s.mistakesLogged > 0) parts.push(`${s.mistakesLogged} mistake${s.mistakesLogged>1?'s':''} logged — excellent self-awareness.`)
  if (s.focusScore >= 80) parts.push('Focus quality was excellent.')
  else if (s.focusScore < 50) parts.push('Try fewer interruptions next session for deeper learning.')

  return parts.join(' ')
}

// ── Session history & analytics ────────────────────────────────────────────────

export function loadSessions(): StudySession[] {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? '[]') }
  catch { return [] }
}

export function getSessionStats(): {
  totalSessions: number; avgFocus: number; totalMinutes: number;
  lecturesDone: number; topSubjects: string[]
} {
  const sessions = loadSessions()
  if (!sessions.length) return { totalSessions:0, avgFocus:0, totalMinutes:0, lecturesDone:0, topSubjects:[] }

  const totalMins    = sessions.reduce((s, x) => s + x.durationMin, 0)
  const avgFocus     = Math.round(sessions.reduce((s, x) => s + x.focusScore, 0) / sessions.length)
  const lecturesDone = sessions.reduce((s, x) => s + x.lecturesDone, 0)

  const subjectFreq: Record<string, number> = {}
  for (const s of sessions) subjectFreq[s.subject] = (subjectFreq[s.subject] ?? 0) + 1
  const topSubjects = Object.entries(subjectFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s)

  return { totalSessions: sessions.length, avgFocus, totalMinutes: totalMins, lecturesDone, topSubjects }
}

// ── Session report panel ───────────────────────────────────────────────────────

export function showSessionReport(session: StudySession): void {
  if (document.getElementById('session-report-overlay')) document.getElementById('session-report-overlay')!.remove()

  const overlay = document.createElement('div')
  overlay.id = 'session-report-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.94);backdrop-filter:blur(10px);padding:16px;'

  const duration = session.durationMin
  const focusColor = session.focusScore >= 80 ? '#45e0a8' : session.focusScore >= 60 ? '#f0b54a' : '#e05555'

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px;width:100%;max-width:480px;display:flex;flex-direction:column;gap:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📊 SESSION COMPLETE</span>
        <button id="sr-x" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">&times;</button>
      </div>

      <div style="text-align:center;padding:12px 0;">
        <div style="font-size:48px;font-weight:700;color:${focusColor};font-family:var(--font-display);">${session.focusScore}</div>
        <div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);">FOCUS SCORE</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        ${[
          ['⏱', String(duration)+'m', 'Duration'],
          ['📚', String(session.lecturesDone), 'Lectures'],
          ['✗', String(session.mistakesLogged), 'Mistakes'],
        ].map(([icon, val, label]) => `
          <div style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);
            padding:10px;text-align:center;">
            <div style="font-size:20px;">${icon}</div>
            <div style="font-size:20px;font-weight:700;color:var(--accent-ink);">${val}</div>
            <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">${label}</div>
          </div>`).join('')}
      </div>

      ${session.coaching ? `
        <div style="background:rgba(240,181,74,.08);border:1px solid rgba(240,181,74,.25);border-radius:var(--r-sm);padding:14px;
          font-size:13px;color:var(--ink-soft);line-height:1.6;">
          💡 ${session.coaching}
        </div>` : ''}

      <div style="display:flex;gap:8px;">
        <button class="btn ghost" id="sr-close" style="flex:1;">Close</button>
        <button class="btn primary" id="sr-next" style="flex:1;">Start Next Session</button>
      </div>
    </div>`

  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('sr-x')?.addEventListener('click', close)
  document.getElementById('sr-close')?.addEventListener('click', close)
  document.getElementById('sr-next')?.addEventListener('click', () => {
    close()
    window.dispatchEvent(new CustomEvent('jarvis:set-timer', { detail: { focus: 25 } }))
  })
}
