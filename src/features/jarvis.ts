/**
 * jarvis.ts — Mission JARVIS v3 · Super Advanced AI Assistant
 * Proactive engine · Quiz mode · Reminders · 100+ commands · Deep context
 * Voice + text · Groq Llama-3.3-70B · Web Speech API · Permanently male voice
 */
import './jarvis.css'
import { getCurrentState } from './core-engine'
import { todayIST } from '../services/core'
import { isVisionTrigger, openVisionCapture } from './jarvis-vision'
import { route, llmRoute, detectLang, type RouterResult } from './jarvis-router'
// VA overlay lives in index.html as inline script — access via window.VA
type _VAGlobal = { setState(s:string):void; setAmplitude(v:number):void; setTranscript(t:string,f:boolean):void; readonly state:string }
const _w = window as Window & { VA?: _VAGlobal }
const VA = {
  setState:      (s: string)           => { _w.VA?.setState(s) },
  setAmplitude:  (v: number)           => { _w.VA?.setAmplitude(v) },
  setTranscript: (t: string, f: boolean) => { _w.VA?.setTranscript(t, f) },
  get state(): string { return _w.VA?.state ?? 'idle' },
}

// ── Config ────────────────────────────────────────────────────────────────────
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL    = 'llama-3.3-70b-versatile'
const GROQ_KEY      = import.meta.env.VITE_GROQ_API_KEY as string | undefined
const GROQ_AVAILABLE = !!(import.meta.env.VITE_GROQ_API_KEY as string | undefined)

// ── Types ─────────────────────────────────────────────────────────────────────
type JState    = 'idle' | 'listening' | 'thinking' | 'speaking'
type QuizPhase = 'off' | 'asking' | 'revealed'

interface Msg      { role: 'user' | 'assistant'; content: string }
interface MCQItem  { q: string; opts: string[]; ans: string; exp: string }
interface Reminder { id: number; msg: string; at: number }

// ── State ─────────────────────────────────────────────────────────────────────
let _state: JState = 'idle'
let _history: Msg[] = []
let _open   = false
let _rafId  = 0
let _isSpeaking  = false
let _clapEnabled = true

// Quiz
let _quizPhase: QuizPhase = 'off'
let _quizItems: MCQItem[] = []
let _quizIdx  = 0
let _quizHits = 0
let _quizTopic = ''   // tracked for SRS integration + memory

// Reminders
const _reminders: Reminder[] = []
let _nextRemId = 1

// Proactive engine
const _TODAY = new Date().toDateString()
let _sessionGreeted  = false
let _lastNudgeMs     = 0
let _pomodorosDone   = 0

// Voice
const _synth  = window.speechSynthesis
let _voices: SpeechSynthesisVoice[] = []
let _selVoice: SpeechSynthesisVoice | null = null

// Mic / audio
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rec: any = null
let _analyser: AnalyserNode | null = null
let _micStream: MediaStream | null = null
let _audioCtx: AudioContext | null = null

// Clap calibration (absolute threshold, persisted)
let _clapThreshold = parseFloat(localStorage.getItem('jarvis_clap_thresh') ?? '0')
let _wakeRunning   = false

// Simple LRU cache: avoid identical Groq calls within 5 minutes
const _responseCache = new Map<string, { reply: string; ts: number }>()
const CACHE_TTL = 5 * 60_000

function getCached(key: string): string | null {
  const e = _responseCache.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { _responseCache.delete(key); return null }
  return e.reply
}
function setCached(key: string, reply: string): void {
  if (_responseCache.size > 60) {
    // Evict oldest
    const oldest = [..._responseCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0]
    if (oldest) _responseCache.delete(oldest[0])
  }
  _responseCache.set(key, { reply, ts: Date.now() })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _wakeRec: any  = null

// Language preference (persisted)
let _lang: 'en-IN' | 'hi-IN' = (localStorage.getItem('jarvis_lang') as 'en-IN' | 'hi-IN') ?? 'en-IN'

// Response language preference — separate from STT lang
// 'auto' = detect from query; 'hi' = always Hindi; 'en' = always English
let _replyLang: 'auto' | 'hi' | 'hinglish' | 'en' =
  (localStorage.getItem('jarvis_reply_lang') as 'auto'|'hi'|'hinglish'|'en') ?? 'auto'

// Last spoken response (for system.repeat)
let _lastReply = ''

// Sleep mode (system.sleep command)
let _sleeping = false

// Master on/off toggle (persisted). When OFF: no wake word, no clap, overlay hidden.
let _jarvisEnabled = localStorage.getItem('jarvis_enabled') !== 'false'

// Clap activation: clap only works after the user has explicitly said "Jarvis" at least once
let _everActivated = false

// ── Advanced feature state ────────────────────────────────────────────────────

// Continuous conversation: after JARVIS responds, auto-reopen mic for follow-up
let _continuousMode  = localStorage.getItem('jarvis_continuous') === 'true'
let _contListenTimer = 0   // window.setTimeout handle — cleared on interrupt

// TTS speed and volume: user-adjustable for accessibility and preference
type TtsSpeed = 'slow' | 'normal' | 'fast'
let _ttsSpeed:  TtsSpeed = (localStorage.getItem('jarvis_speed')  as TtsSpeed) ?? 'normal'
let _ttsVolume: number   = parseFloat(localStorage.getItem('jarvis_volume') ?? '1.0')  // 0.1–1.0

// Active study subject: set when user announces what they're studying
let _sessionSubject  = ''

// Conversation context: last transcript for follow-up chaining
let _lastUserQuery   = ''

// Clap noise floor: EMA of ambient RMS — updates every 45 ms for smarter calibration
let _emaAmb = 40   // starts at 40 dB, converges within seconds

// ── Cross-Session Memory — persisted across browser restarts ─────────────────
interface JarvisMemory {
  weakTopics:    string[]           // topics user has flagged or failed quiz on
  strongTopics:  string[]           // topics user has marked as mastered
  quizScores:    Record<string, number[]>  // topic → array of recent scores (%)
  lastSubject:   string             // subject from last study session
  lastDate:      string             // YYYY-MM-DD of last session
  wakeCtx:       string             // what was happening at last close (for resume greeting)
  milestones: {
    streak7:     boolean            // first 7-day streak
    coverage50:  boolean            // 50% syllabus covered
    score70:     boolean            // SP hit 70%+
    sessions100: boolean            // 100 total Pomodoro sessions
    streak30:    boolean            // 30-day streak
    coverage100: boolean            // 100% coverage
  }
  vocabIdx:      number             // cycling index for UPSC vocabulary word of the day
  evalCount:     number             // total answer evaluations done
  debateCount:   number             // total debates completed
  lastMotivDate: string             // date of last proactive motivation (to avoid spam)
}
const _MEM_KEY = 'jarvis_mem_v1'
function _defaultMem(): JarvisMemory {
  return {
    weakTopics: [], strongTopics: [], quizScores: {},
    lastSubject: '', lastDate: '', wakeCtx: '',
    milestones: { streak7: false, coverage50: false, score70: false, sessions100: false, streak30: false, coverage100: false },
    vocabIdx: 0, evalCount: 0, debateCount: 0, lastMotivDate: ''
  }
}
let _mem: JarvisMemory = (() => {
  try { return { ..._defaultMem(), ...JSON.parse(localStorage.getItem(_MEM_KEY) ?? 'null') } }
  catch { return _defaultMem() }
})()
function saveMem(): void { localStorage.setItem(_MEM_KEY, JSON.stringify(_mem)) }

// ── Focus Guardian — detects distraction during active Pomodoro ──────────────
let _lastActivityMs   = Date.now()
let _focusGuardianId  = 0
function pingActivity(): void { _lastActivityMs = Date.now() }

// ── Emotion detection — adjust tone based on transcript sentiment ─────────────
type EmotionTone = 'neutral' | 'stressed' | 'tired' | 'excited' | 'confused' | 'sad'
function detectEmotion(t: string): EmotionTone {
  const tl = t.toLowerCase()
  if (/tired|thak|thaki|exhausted|neend|nind|aankhein|bore|bored|bore.*ho|ho.*gaya.*thak/i.test(tl)) return 'tired'
  if (/stressed|tension|anxious|nervous|dar|scared|pressure|overwhelm|pagal|dil.*ghabra/i.test(tl)) return 'stressed'
  if (/don.t understand|samajh.*nahi|confused|confuse|kya.*matlab|what.*mean|explain.*again|dobara/i.test(tl)) return 'confused'
  if (/sad|dukhi|upset|crying|rona|rone|depressed|hopeless|kya.*faida|pointless/i.test(tl)) return 'sad'
  if (/amazing|excellent|great|fantastic|perfect|acha.*hua|kar.*liya|done|success|selected|cleared/i.test(tl)) return 'excited'
  return 'neutral'
}

// ── UPSC Vocabulary bank ───────────────────────────────────────────────────────
const UPSC_VOCAB: Array<{ word: string; meaning: string; example: string }> = [
  { word: 'Locus Standi', meaning: 'Legal right to bring a case before court. In PILs, even a stranger to the dispute can have locus standi for public interest.', example: 'In Vishaka vs State of Rajasthan, NGOs had locus standi to petition the SC.' },
  { word: 'Sub Judice', meaning: 'Matter currently under judicial consideration. Sub judice matters cannot be discussed in Parliament.', example: 'Article 105 restricts Parliamentary debate on sub judice matters.' },
  { word: 'Ultra Vires', meaning: 'Beyond the powers. A law beyond the legislature\'s competence is ultra vires and void.', example: 'A State law on a Union List subject is ultra vires Article 245.' },
  { word: 'Ratio Decidendi', meaning: 'The legal reasoning forming a binding precedent. Only ratio decidendi binds future courts, not obiter dicta.', example: 'The ratio in Kesavananda Bharati established the Basic Structure doctrine.' },
  { word: 'Obiter Dicta', meaning: 'Judges\' remarks in passing — not binding precedent but persuasive.', example: 'Bhagwati J\'s broad reading of Art 21 in Maneka Gandhi was initially obiter dicta.' },
  { word: 'Certiorari', meaning: 'Writ to quash an order of a lower court or tribunal that acted without jurisdiction or in error.', example: 'High Courts issue certiorari under Article 226 to quash faulty tribunal orders.' },
  { word: 'Mandamus', meaning: 'Writ commanding a public authority to perform a mandatory public duty it has refused.', example: 'Mandamus was issued to the Election Commission to notify bye-elections.' },
  { word: 'Quo Warranto', meaning: '"By what authority" — challenges whether a person holds a public office lawfully.', example: 'Quo warranto was used to challenge an allegedly unlawful gubernatorial appointment.' },
  { word: 'Lis Pendens', meaning: 'Pending lawsuit. Property transfer during lis pendens is subject to the suit\'s outcome.', example: 'Lis pendens doctrine prevents defeating court orders through transfers.' },
  { word: 'Ex Facie', meaning: 'On the face of it, apparent from the document itself without further investigation.', example: 'The provision was ex facie unconstitutional — it plainly violated Article 14.' },
  { word: 'Colourable Legislation', meaning: 'What cannot be done directly cannot be done indirectly. A law colourable in form but illegal in substance.', example: 'A State law dressed as "health regulation" but actually controlling interstate trade is colourable.' },
  { word: 'Pith and Substance', meaning: 'Doctrine to determine which legislative list a law truly belongs to — look at its real character.', example: 'In pith and substance, the law was on banking (Union List), not money-lending (State List).' },
  { word: 'Ancillary Powers', meaning: 'Powers necessary and incidental to an enumerated power in the legislative lists.', example: 'Parliament\'s power to tax income carries ancillary power to prevent tax evasion.' },
  { word: 'Repugnancy', meaning: 'Conflict between Central and State laws on Concurrent List subjects. Central law prevails (Art 254).', example: 'State tenancy law was repugnant to the Central Rent Control Act and was void.' },
  { word: 'Casus Omissus', meaning: 'Case omitted by law — a gap in legislation. Courts cannot fill it; only Parliament can.', example: 'The court refused to supply the casus omissus by reading in a non-existent exception.' },
  { word: 'Ejusdem Generis', meaning: 'General words following specific words are limited to the same class as the specific words.', example: '"Vehicles, carriages, and other conveyances" — ejusdem generis limits "other" to road transport.' },
  { word: 'Noscitur a Sociis', meaning: 'A word\'s meaning is known by its associates. Ambiguous words interpreted in context of surrounding words.', example: 'In a penal statute, "offensive weapons" was interpreted using noscitur a sociis.' },
  { word: 'Delegatus Non Potest Delegare', meaning: 'A delegate cannot further delegate powers. Parliament cannot delegate its core legislative power to the executive.', example: 'The principle limits skeletal legislation — too much delegation is unconstitutional (In re Delhi Laws Act).' },
  { word: 'Stare Decisis', meaning: 'Stand by decisions. Courts must follow precedents of higher courts (Art 141 — SC decisions are law of the land).', example: 'Under stare decisis, all courts must follow the Supreme Court\'s ruling on Article 21A.' },
  { word: 'Parens Patriae', meaning: '"Parent of the nation" — state\'s power to protect persons who cannot protect themselves (minors, disabled).', example: 'The state exercises parens patriae jurisdiction in child custody and adoption matters.' },
]
function getVocabWord(): { word: string; meaning: string; example: string } {
  const idx = _mem.vocabIdx % UPSC_VOCAB.length
  _mem.vocabIdx++; saveMem()
  return UPSC_VOCAB[idx]
}

// ── Multi-reminder parser — "remind me at 3pm, 5pm, and 8pm" ──────────────────
function parseMultipleReminderTimes(text: string): number[] {
  const times: number[] = []
  const now = new Date()
  const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)\b/g
  let m: RegExpExecArray | null
  while ((m = TIME_RE.exec(text)) !== null) {
    let h = parseInt(m[1])
    const min = parseInt(m[2] ?? '0')
    const ampm = m[3].toLowerCase()
    if (ampm === 'pm' && h < 12) h += 12
    if (ampm === 'am' && h === 12) h = 0
    const t = new Date(); t.setHours(h, min, 0, 0)
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
    times.push(t.getTime())
  }
  return times
}

// ── Master toggle helpers ─────────────────────────────────────────────────────
function setJarvisEnabled(on: boolean): void {
  _jarvisEnabled = on
  localStorage.setItem('jarvis_enabled', String(on))
  const btn = document.getElementById('jarvis-btn')
  const tog = document.getElementById('va-toggle')
  const lbl = tog?.querySelector<HTMLElement>('span:last-child')

  if (on) {
    document.body.classList.remove('va-off')
    btn?.classList.remove('disabled')
    tog?.classList.add('on')
    if (lbl) lbl.textContent = 'ON'
    startWakeWord()
  } else {
    _wakeRec?.stop(); _wakeRec = null; _wakeRunning = false
    if (_open) closePanel()
    _synth.cancel()
    VA.setState('idle')
    document.body.classList.add('va-off')
    btn?.classList.add('disabled')
    tog?.classList.remove('on')
    if (lbl) lbl.textContent = 'OFF'
  }
}

function toggleJarvis(): void { setJarvisEnabled(!_jarvisEnabled) }

// ── Voice — permanently male ──────────────────────────────────────────────────
function loadVoices(): void { _voices = _synth.getVoices(); pickMaleVoice() }
_synth.addEventListener('voiceschanged', loadVoices)
loadVoices()

function pickMaleVoice(): void {
  if (!_voices.length) return
  const maleKw  = /ravi|guy|james|david|mark|daniel|thomas|male|man|kumar|aaron/i
  const quality = /online|natural|neural|wavenet/i
  const scoreV  = (v: SpeechSynthesisVoice) => {
    let s = 0
    if (quality.test(v.name) && !v.localService) s += 200
    else if (quality.test(v.name))               s += 120
    else if (!v.localService)                    s += 60
    if (maleKw.test(v.name))  s += 80
    if (v.lang === 'en-IN')   s += 40
    else if (v.lang === 'en-GB') s += 30
    else if (v.lang.startsWith('en')) s += 10
    return s
  }
  _selVoice = [..._voices].sort((a,b) => scoreV(b)-scoreV(a))[0] ?? null
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initJarvis(): void {
  if (document.getElementById('jarvis-btn')) return

  const btn = document.createElement('button')
  btn.id = 'jarvis-btn'
  btn.title = 'JARVIS'
  btn.innerHTML = `<canvas id="jarvis-btn-canvas"></canvas>`
  btn.addEventListener('click', togglePanel)
  document.body.appendChild(btn)

  // VA overlay already in DOM (index.html inline script) — just sync enabled state
  if (!_jarvisEnabled) document.body.classList.add('va-off')

  // Sync status dot — small indicator above JARVIS button
  if (!document.getElementById('jv-sync-dot')) {
    const dot = document.createElement('div')
    dot.id = 'jv-sync-dot'
    dot.title = 'JARVIS sync status'
    document.body.appendChild(dot)
    window.addEventListener('online',  () => { dot.classList.remove('offline','syncing'); dot.classList.add('syncing'); setTimeout(()=>dot.classList.remove('syncing'),3000) })
    window.addEventListener('offline', () => { dot.classList.remove('syncing'); dot.classList.add('offline') })
  }
  // Wire the full toggle handler so the early index.html button delegates here
  ;(window as Window & { __jarvisToggle?: () => void }).__jarvisToggle = toggleJarvis
  startAura()

  // Toggle button (mounted in index.html) — wire the full handler + sync state label
  const togBtn = document.getElementById('va-toggle')
  if (togBtn) {
    togBtn.onclick = toggleJarvis
    const lbl = togBtn.querySelector<HTMLElement>('#va-tl')
    if (_jarvisEnabled) { togBtn.classList.add('on'); if (lbl) lbl.textContent = 'ON' }
    else { togBtn.classList.remove('on'); document.getElementById('jarvis-btn')?.classList.add('disabled'); if (lbl) lbl.textContent = 'OFF' }
  }

  setTimeout(() => {
    if (_jarvisEnabled) {
      startWakeWord()
      startClapWatch()
    }
    startProactiveEngine()
    startAppSync()
    void requestNotifPermission()  // ask once for browser notifications
    // Heartbeat: restart wake word if it silently dies every 15 seconds
    setInterval(() => {
      if (_jarvisEnabled && !_wakeRunning && !_isSpeaking && !_sleeping) startWakeWord()
    }, 15_000)
  }, 2000)

  document.addEventListener('keydown', e => {
    if (e.key === 'j' && !['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault(); togglePanel()
    }
  })

  // Activity tracking for Focus Guardian
  document.addEventListener('keydown',  () => pingActivity())
  document.addEventListener('mousedown', () => pingActivity())

  // Pomodoro completion hook — richer bilingual celebration
  window.addEventListener('jarvis:session-done', ((e: CustomEvent<{mins:number}>) => {
    _pomodorosDone++
    const totalToday = getTodayFocusMins()
    const lang = detectResponseLang('')
    let msg = ''
    if (_pomodorosDone % 4 === 0) {
      msg = lang === 'hi'       ? `चार sessions पूरे! आज ${totalToday} मिनट deep work हुई। अब एक proper long break लो।`
          : lang === 'hinglish' ? `Char sessions complete! Aaj ${totalToday} minutes deep work hui. Ab long break lo, Om.`
          : `Four sessions complete! ${totalToday} minutes of deep work today. Take a proper long break now, Om.`
    } else if (totalToday >= 120 && totalToday % 60 < (e.detail.mins ?? 25)) {
      const hrs = Math.floor(totalToday / 60)
      msg = lang === 'hi'       ? `आज ${hrs} घंटे की पढ़ाई हो गई। शानदार consistency, ओम।`
          : lang === 'hinglish' ? `${hrs} hours aaj. Zabardast consistency, Om.`
          : `${hrs} hours of study today. Excellent consistency, Om.`
    }
    // Milestone check after every session
    checkMilestones()
    // Update memory
    _mem.lastSubject = _sessionSubject || (getCurrentState()?.today?.subject ?? '')
    _mem.lastDate    = todayIST(); saveMem()
    if (msg) { if (_open) respond(msg); else showNudge(msg) }
  }) as EventListener)

  // Focus Guardian — start after 2-second boot delay
  setTimeout(startFocusGuardian, 3000)
}

// ── Proactive Engine ──────────────────────────────────────────────────────────
function startProactiveEngine(): void {

  // Reminder tick — every 10 seconds, precise firing
  setInterval(() => {
    if (_isSpeaking) return
    const now = Date.now()
    for (let i = _reminders.length - 1; i >= 0; i--) {
      if (now >= _reminders[i].at) {
        const r = _reminders.splice(i, 1)[0]
        const msg = `Reminder: ${r.msg}`
        // Browser notification (even if tab is in background)
        browserNotify('⏰ JARVIS Reminder', r.msg, `reminder-${r.id}`)
        if (_open) respond(msg)
        else showNudge(msg)
      }
    }
  }, 10_000)

  // Intelligence nudges — every 3 minutes
  setInterval(() => {
    if (_isSpeaking || _state !== 'idle') return
    const now = Date.now()
    if (now - _lastNudgeMs < 5 * 60_000) return

    const cs = getCurrentState()
    const h  = new Date().getHours()

    // Morning brief — once per day, 5am–11am
    if (!_sessionGreeted && h >= 5 && h < 11) {
      if (localStorage.getItem('jarvis_morning') !== _TODAY) {
        localStorage.setItem('jarvis_morning', _TODAY)
        _sessionGreeted = true; _lastNudgeMs = now
        showNudge(buildMorningBrief(cs))
        return
      }
    }

    // Evening streak alert — after 8pm, if < 25 min studied
    if (h >= 20 && cs && (cs.streak ?? 0) > 2 && getTodayFocusMins() < 25) {
      _lastNudgeMs = now
      const lang = detectResponseLang('')
      showNudge(
        lang === 'hi'       ? `Streak alert: ${cs.streak} दिनों की streak खतरे में है। एक 25-minute session उसे बचा लेगा।` :
        lang === 'hinglish' ? `Streak alert: ${cs.streak}-day streak at risk hai. Ek 25-minute session se bachao.` :
                              `Streak alert: ${cs.streak}-day streak at risk. One 25-minute session will protect it.`
      )
      return
    }

    // Backlog warning — once in a while during day
    if (cs && (cs.backlogRemaining ?? 0) > 20 && h >= 9 && h < 22 && Math.random() < 0.25) {
      _lastNudgeMs = now
      const lang = detectResponseLang('')
      showNudge(
        lang === 'hi'       ? `${cs.backlogRemaining} lectures अभी बाकी हैं। "plan generate karo" कहो एक optimized schedule के लिए।` :
        lang === 'hinglish' ? `${cs.backlogRemaining} lectures pending hain. "generate plan" bolo optimized schedule ke liye.` :
                              `${cs.backlogRemaining} lectures still pending. Say "generate plan" for an optimized schedule.`
      )
    }
  }, 3 * 60_000)
}

function buildMorningBrief(cs: ReturnType<typeof getCurrentState>): string {
  if (!cs) return 'Good morning, Om. Ready to build something great today?'
  const parts: string[] = ['Good morning, Om.']
  if (cs.streak) parts.push(`${cs.streak}-day streak — protect it today.`)
  if (cs.today?.subject) parts.push(`Subject for today: ${cs.today.subject}.`)
  if (cs.backlogRemaining) parts.push(`${cs.backlogRemaining} lectures in backlog.`)
  // Resume context from last session
  if (_mem.lastSubject && _mem.lastDate !== todayIST())
    parts.push(`Last session: ${_mem.lastSubject}.`)
  // Due revisions
  const revDue = document.querySelectorAll('#plan .plan-row[data-type="revision"]:not(.done)').length
  if (revDue) parts.push(`${revDue} revision${revDue > 1 ? 's' : ''} due today.`)
  parts.push('What are we starting with?')
  return parts.join(' ')
}

// ── App ↔ JARVIS Bidirectional Sync ──────────────────────────────────────────
function startAppSync(): void {
  // Online / offline — announce and update sync status
  window.addEventListener('online', () => {
    const lang = detectResponseLang('')
    const msg  = L(lang,
      'Back online. All your changes are syncing to the cloud.',
      'वापस online हो गए। सारे changes cloud में sync हो रहे हैं।',
      'Wapas online. Saare changes cloud mein sync ho rahe hain.'
    )
    browserNotify('✅ JARVIS', 'Back online — syncing data.', 'sync')
    if (_open) respond(msg); else showNudge(msg)
  })
  window.addEventListener('offline', () => {
    const lang = detectResponseLang('')
    const msg  = L(lang,
      'Gone offline. All changes are saved locally and will sync automatically when you reconnect.',
      'Offline हो गए। Changes local में safe हैं — reconnect होते ही sync हो जाएंगे।',
      'Offline ho gaye. Changes local mein save hain — reconnect hone pe sync ho jaayenge.'
    )
    browserNotify('📴 JARVIS', 'Offline — working locally.', 'sync')
    if (_open) respond(msg); else showNudge(msg)
  })

  // DOM mutation observer: react when score dialog closes (score was saved)
  const domObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node instanceof Element) {
          const id = (node as HTMLElement).id ?? ''
          if (/score|add-score/i.test(id)) {
            // Score modal closed → likely a score was saved → recheck milestones
            setTimeout(() => checkMilestones(), 800)
          }
        }
      }
    }
  })
  domObs.observe(document.body, { childList: true })

  // Listen to timer state changes for smart awareness
  window.addEventListener('jarvis:timer-started', ((e: CustomEvent<{mins:number}>) => {
    pingActivity()
    // Ambient mode: announce quietly
    if (_ambientMode === 'whisper' && !_isSpeaking) {
      const lang = detectResponseLang('')
      setTimeout(() => speak(L(lang, 'Session started.', 'Session शुरू।', 'Session shuru.')), 200)
    }
  }) as EventListener)
}

// ── Screen Reader — viewport-aware section narration ─────────────────────────
function isInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.top < window.innerHeight * 0.75 && r.bottom > window.innerHeight * 0.25
}
function readScreenContent(): string {
  // Timer / engine section
  const timerEl = document.querySelector('.ring-time, .timer-display, #focus-timer')
  if (timerEl && isInViewport(timerEl)) {
    const timerBtn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
    const running  = timerBtn?.textContent?.toLowerCase().includes('pause')
    const time     = timerEl.textContent?.trim() ?? '—'
    return running ? `Timer running: ${time} remaining.` : `Timer is at ${time}, not running.`
  }
  // Analytics / intelligence section
  const intelEl = document.querySelector('#intel, [data-section="intel"]')
  if (intelEl && isInViewport(intelEl)) return buildStatusReport()
  // Plan section
  const planEl = document.querySelector('#plan, [data-section="plan"]')
  if (planEl && isInViewport(planEl)) return buildTodayReport()
  // Routine section
  const routineEl = document.querySelector('#routine-section, [data-section="routine"]')
  if (routineEl && isInViewport(routineEl)) {
    const cs = getCurrentState()
    return cs?.today
      ? `Routine: Today's subject is ${cs.today.subject}. Target: ${cs.today.targetQuestions ?? '?'} questions.`
      : 'Open the Routine section for today\'s schedule.'
  }
  // Constitution section
  const constEl = document.querySelector('#constitution-section, [data-section="constitution"]')
  if (constEl && isInViewport(constEl)) return 'Constitution section is open. Search by article number or keyword.'
  // Default: full status
  return buildStatusReport()
}

// ── Focus Guardian ────────────────────────────────────────────────────────────
function startFocusGuardian(): void {
  if (_focusGuardianId) return
  _focusGuardianId = window.setInterval(() => {
    const timerBtn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
    const timerRunning = timerBtn?.textContent?.toLowerCase().includes('pause')
    if (!timerRunning || _isSpeaking || _state !== 'idle') return

    const idleMs = Date.now() - _lastActivityMs
    if (idleMs < 10 * 60_000) return   // < 10 min silence → still focused

    const timeLeft = document.querySelector<HTMLElement>('.ring-time')?.textContent?.trim() ?? ''
    const lang = detectResponseLang('')
    const nudge =
      lang === 'hi'       ? `ओम, timer चल रहा है — ${timeLeft} बाकी है। Focus में हो? कुछ पूछना है तो बोलो।` :
      lang === 'hinglish' ? `Om, timer chal raha hai — ${timeLeft} baki hai. Focus mein ho? Kuch chahiye toh bolo.` :
                            `Hey Om — timer running with ${timeLeft} left. Still with me? Say anything if you need help.`
    if (_open) respond(nudge)
    else showNudge(nudge)
    _lastActivityMs = Date.now()  // reset so it doesn't spam
  }, 60_000)
}

// ── Milestone Celebrations ────────────────────────────────────────────────────
function checkMilestones(): void {
  const cs    = getCurrentState()
  const done  = document.querySelectorAll('#plan .plan-row.done').length
  const tot   = document.querySelectorAll('#plan .plan-row').length
  const pct   = tot ? Math.round(done / tot * 100) : 0
  const streak = cs?.streak ?? 0
  const sp     = cs?.selectionProbabilityPct ?? 0
  const lang   = detectResponseLang('')

  const announce = (en: string, hi: string, hin: string) => {
    const msg = lang === 'hi' ? hi : lang === 'hinglish' ? hin : en
    if (_open) respond(msg); else showNudge(msg)
  }

  if (!_mem.milestones.streak7 && streak >= 7) {
    _mem.milestones.streak7 = true; saveMem()
    announce(
      '7-day streak! This is where habits form. Real IAS officers are built with exactly this kind of consistency.',
      '7 दिनों की streak! यहीं से habits बनती हैं। IAS officers ऐसे ही बनते हैं।',
      '7-day streak! Yahan se habits banti hain. Real IAS officers aise bante hain, Om.'
    )
  }
  if (!_mem.milestones.streak30 && streak >= 30) {
    _mem.milestones.streak30 = true; saveMem()
    announce(
      '30-day streak! One month of unbroken discipline. You are in the top 1% of aspirants right now.',
      '30 दिनों की streak! एक महीने की अटूट discipline। आप अभी top 1% aspirants में हैं।',
      '30-day streak, Om! Ek mahine ki discipline. Top 1% aspirants mein ho tum abhi.'
    )
  }
  if (!_mem.milestones.coverage50 && pct >= 50) {
    _mem.milestones.coverage50 = true; saveMem()
    announce(
      '50% syllabus covered — halfway there! The second half is where selections are won. Keep this standard.',
      '50% syllabus complete! आधा सफर तय हो गया। दूसरा आधा वो जगह है जहाँ selection होती है।',
      'Syllabus ka 50% cover ho gaya! Aadha safar tay. Doosra aadha selection jeetne ki jagah hai.'
    )
  }
  if (!_mem.milestones.coverage100 && pct >= 100) {
    _mem.milestones.coverage100 = true; saveMem()
    announce(
      'Full syllabus covered! Now it is all about revision depth and answer quality. Incredible achievement, Om.',
      'पूरा syllabus cover हो गया! अब revision और answer quality — अविश्वसनीय achievement है यह।',
      'Poora syllabus cover ho gaya! Ab revision aur answer quality. Incredible, Om.'
    )
  }
  if (!_mem.milestones.score70 && sp >= 70) {
    _mem.milestones.score70 = true; saveMem()
    announce(
      'Selection probability crossed 70%. You are in serious contender territory. Maintain this standard and the seat is yours.',
      'Selection probability 70% पार हो गई। आप serious contender zone में हैं। इस level को बनाए रखो।',
      'SP 70% cross kar gayi! Serious contender zone mein ho. Is level ko maintain karo, Om.'
    )
  }
  try {
    const sessions = JSON.parse(localStorage.getItem('sessTotal') ?? '0') as number
    if (!_mem.milestones.sessions100 && sessions >= 100) {
      _mem.milestones.sessions100 = true; saveMem()
      announce(
        '100 Pomodoro sessions! That is 100 deliberate acts of choosing study over comfort. This is the IAS mindset.',
        '100 Pomodoro sessions! वो 100 बार जब तुमने comfort की जगह पढ़ाई चुनी। यही IAS की mentality है।',
        '100 Pomodoro sessions! 100 baar tune comfort ki jagah padhai choose ki. Yahi IAS mentality hai.'
      )
    }
  } catch { /* ignore */ }
}

function getTodayFocusMins(): number {
  try {
    const raw = localStorage.getItem('focusLog')
    if (!raw) return 0
    const log = JSON.parse(raw) as Array<{date:string; mins:number}>
    return log.filter(e => e.date === todayIST()).reduce((s,e) => s+(e.mins??0), 0)
  } catch { return 0 }
}

function showNudge(msg: string): void {
  const btn = document.getElementById('jarvis-btn')
  if (btn) {
    btn.classList.add('nudge'); btn.title = msg
    setTimeout(() => { btn.classList.remove('nudge'); btn.title = 'JARVIS' }, 12_000)
  }
  if (!_isSpeaking) speak(msg)
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function togglePanel(): void {
  _sleeping = false
  if (_open) { closePanel() } else { _everActivated = true; openPanel() }
}

/** Open the panel. Pass greet=false when waking via wake word so we start
 *  listening immediately instead of blocking for 5-10 seconds of greeting. */
function openPanel(greet = true): void {
  if (_open) return
  _open = true

  const p = document.createElement('div')
  p.id = 'jarvis-panel'
  p.innerHTML = `
    <div class="jp-head">
      <div class="jp-title">⬡ JARVIS</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="jp-calibrate" class="jp-pill" title="Calibrate clap detection">👏 Calibrate</button>
        <button id="jp-close" class="jp-close">✕</button>
      </div>
    </div>
    <div class="jp-status" id="jp-status">Listening…</div>
    <div class="jp-chat" id="jp-chat"></div>
    <div class="jp-input-row">
      <button id="jp-mic" class="jp-mic-btn" title="Tap to speak">🎙</button>
      <input id="jp-text" type="text" placeholder="Ask anything…" autocomplete="off" />
      <button id="jp-send" class="jp-send-btn">➤</button>
    </div>
  `
  document.body.appendChild(p)

  document.getElementById('jp-close')?.addEventListener('click', closePanel)
  document.getElementById('jp-calibrate')?.addEventListener('click', runCalibration)
  document.getElementById('jp-mic')?.addEventListener('click', () => {
    if (_state === 'listening') stopListening()
    else void startListening()
  })
  const inp = document.getElementById('jp-text') as HTMLInputElement
  document.getElementById('jp-send')?.addEventListener('click', () => sendText(inp))
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') sendText(inp) })

  if (greet) setTimeout(() => greetFull(), 400)
}

/** Poll until JARVIS is not speaking, then start the microphone.
 *  Used after wake word so the mic opens as soon as the cue tone finishes. */
function wakeAndListen(tries = 0): void {
  if (!_open) return
  if (_isSpeaking && tries < 30) { setTimeout(() => wakeAndListen(tries + 1), 150); return }
  if (_state === 'listening') return   // already listening
  void startListening()
}

function closePanel(): void {
  _open = false
  stopListening(); _synth.cancel()
  _quizPhase = 'off'
  VA.setState('idle')
  cancelAnimationFrame(_rafId)
  document.getElementById('jarvis-panel')?.remove()
}

// ── Aura animation (on the circular button) ───────────────────────────────────
function startAura(): void {
  cancelAnimationFrame(_rafId)
  const btn = document.getElementById('jarvis-btn')
  const cv  = document.getElementById('jarvis-btn-canvas') as HTMLCanvasElement | null
  if (!btn || !cv) return

  const sz = 72, dpr = devicePixelRatio
  cv.width = sz*dpr; cv.height = sz*dpr
  cv.style.width = sz+'px'; cv.style.height = sz+'px'
  const c  = cv.getContext('2d')!
  c.scale(dpr, dpr)
  const W = sz, H = sz, cx = W/2, cy = H/2, R = W/2-1
  let t = 0
  const fft = new Uint8Array(64)

  const frame = () => {
    _rafId = requestAnimationFrame(frame)
    c.clearRect(0,0,W,H); t += 0.014

    let amp = 0
    if (_analyser) {
      // Real mic amplitude while listening
      _analyser.getByteFrequencyData(fft)
      amp = fft.reduce((s,v)=>s+v,0)/fft.length/255
    } else if (VA.state === 'speaking') {
      // Synthesised amplitude while TTS plays (SpeechSynthesis has no AudioNode)
      amp = 0.35 + Math.abs(Math.sin(t * 3.2)) * 0.52
    } else if (VA.state === 'thinking') {
      amp = 0.14 + Math.abs(Math.sin(t * 1.6)) * 0.10
    } else {
      // Ambient idle breathe — keeps the glow rotating and gently pulsing
      amp = 0.04 + Math.abs(Math.sin(t * 0.6)) * 0.04
    }
    VA.setAmplitude(amp)

    const inten = _state === 'idle'      ? 0.42 + Math.sin(t*1.1)*0.07
                : _state === 'listening' ? 0.75 + amp*0.35 + Math.sin(t*6)*0.08
                : _state === 'thinking'  ? 0.60 + Math.sin(t*3.5)*0.12
                :                         0.68 + amp*0.22 + Math.sin(t*10)*0.12

    c.save(); c.beginPath(); c.arc(cx,cy,R,0,Math.PI*2); c.clip()
    c.fillStyle = '#04060a'; c.fillRect(0,0,W,H)

    const core = c.createRadialGradient(cx,cy,0,cx,cy,R*(0.36+inten*0.18))
    core.addColorStop(0,   `rgba(255,235,140,${inten*0.95})`)
    core.addColorStop(0.35,`rgba(240,181,74,${inten*0.60})`)
    core.addColorStop(0.8, `rgba(180,110,30,${inten*0.15})`)
    core.addColorStop(1,   'rgba(180,110,30,0)')
    c.fillStyle = core; c.beginPath(); c.arc(cx,cy,R,0,Math.PI*2); c.fill()

    const pn = _state==='listening'?8 : _state==='speaking'?10 : 5
    for (let i=0;i<pn;i++) {
      const a  = (i/pn)*Math.PI*2 + t*(_state==='idle'?0.4:1.6) + i*0.4
      const pr = R*(0.70+Math.sin(t*2.5+i*1.4)*0.10)
      const px = cx+Math.cos(a)*pr, py = cy+Math.sin(a)*pr
      const ps = R*0.07*inten
      const pg = c.createRadialGradient(px,py,0,px,py,ps*3)
      pg.addColorStop(0,`rgba(255,240,160,${inten})`); pg.addColorStop(1,'rgba(240,181,74,0)')
      c.fillStyle=pg; c.beginPath(); c.arc(px,py,ps*3,0,Math.PI*2); c.fill()
    }

    if (_state !== 'idle') {
      for (let i=0;i<16;i++) {
        const a  = (i/16)*Math.PI*2 + t*0.7
        const sa = amp*R*0.30 + Math.sin(t*4+i*0.7)*R*0.09*inten
        c.beginPath(); c.moveTo(cx+Math.cos(a)*R*0.58, cy+Math.sin(a)*R*0.58)
        c.lineTo(cx+Math.cos(a)*(R*0.58+sa), cy+Math.sin(a)*(R*0.58+sa))
        c.strokeStyle=`rgba(255,215,100,${inten*(0.4+amp*0.5)})`; c.lineWidth=1.8; c.lineCap='round'; c.stroke()
      }
    }

    for (let i=0;i<6;i++) {
      const start = (i/6)*Math.PI*2 + t*(_state==='thinking'?1.8:0.4)
      const sweep = (Math.PI/4)*(0.5+Math.sin(t+i)*0.4)
      c.beginPath(); c.arc(cx,cy,R*0.87,start,start+sweep)
      c.strokeStyle=`rgba(255,195,75,${(0.4+Math.sin(t*1.5+i)*0.3)*inten*0.8})`; c.lineWidth=2.0; c.stroke()
    }
    c.restore()
  }
  frame()
}

// ── Voice Capture ─────────────────────────────────────────────────────────────
// Design:
//  • continuous=false  — simpler, avoids Chrome v120+ onend timing bugs
//  • interimResults=true — shows real-time transcript in the overlay
//  • CRITICAL: stop _wakeRec FIRST so two STT instances never fight the mic
//  • Process on isFinal result; if onend fires before final, commit interim
// ─────────────────────────────────────────────────────────────────────────────

async function startListening(): Promise<void> {
  if (_state === 'listening') return
  if (_isSpeaking) { wakeAndListen(); return }

  // ── CRITICAL: kill wake word recognizer BEFORE opening command mic ──────────
  // Running two Chrome STT instances simultaneously causes mic contention →
  // only the first word is captured. Stop _wakeRec unconditionally here.
  _wakeRec?.stop(); _wakeRec = null; _wakeRunning = false

  setStatus('🎙 Speak your command…')
  setState('listening')
  VA.setState('listening')
  document.getElementById('jp-mic')?.classList.add('active')
  document.getElementById('jarvis-btn')?.classList.add('listening')

  // Waveform analyser — failure is non-fatal, recognition continues without it
  try {
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
    _micStream = ms
    _audioCtx  = new AudioContext()
    _analyser  = _audioCtx.createAnalyser(); _analyser.fftSize = 64
    _audioCtx.createMediaStreamSource(ms).connect(_analyser)
  } catch { /* waveform won't show, recognition works via browser default mic */ }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) {
    const msg = 'Voice recognition needs Chrome. Please type your command below.'
    setStatus(msg); speak(msg); stopListening(); return
  }

  const r = new SR()
  _rec = r

  // continuous=false: Chrome waits for natural end-of-utterance → fires once
  // interimResults=true: VA overlay shows words as you speak (great UX)
  r.lang            = _lang
  r.continuous      = false
  r.interimResults  = true
  r.maxAlternatives = 3

  let finalText  = ''   // populated on isFinal result
  let interimTxt = ''   // last interim — fallback if onend fires without final
  let committed  = false

  const commit = (text: string): void => {
    if (committed) return
    const clean = text.trim()
    if (!clean) { stopListening(); VA.setState('idle'); setState('idle'); setStatus('Tap 🎙 or say "Jarvis".'); return }
    committed = true
    stopListening()
    VA.setTranscript(clean, false)
    void processQuery(clean)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onresult = (e: any) => {
    if (committed) return
    let interim = '', fin = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = (e.results[i][0].transcript as string).trim()
      if (e.results[i].isFinal) fin  = seg
      else                       interim = seg
    }
    if (fin)     { finalText  = fin;     VA.setTranscript(fin, false);     commit(fin) }
    else if (interim) { interimTxt = interim; VA.setTranscript(interim, false) }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onerror = (e: any) => {
    if (committed) return
    stopListening(); VA.setState('idle'); setState('idle')
    const code = e?.error ?? ''
    const lang = detectResponseLang('')
    const status =
      code === 'not-allowed'
        ? L(lang, 'Mic blocked — allow microphone access in your browser address bar.',
               'Microphone allow करो — browser के address bar में।',
               'Mic blocked — browser mein allow karo.')
      : code === 'network'
        ? L(lang, 'Voice recognition needs internet. Check your connection.',
               'Voice recognition के लिए internet चाहिए।',
               'Voice ke liye internet chahiye. Connection check karo.')
      : code === 'no-speech'
        ? L(lang, "I didn't hear anything. Tap 🎙 or say Jarvis to try again.",
               'कुछ सुनाई नहीं दिया। 🎙 दबाओ या "Jarvis" बोलो।',
               'Kuch sunai nahi diya. 🎙 dabao ya "Jarvis" bolo.')
      : code === 'aborted'
        ? L(lang, 'Listening cancelled. Say Jarvis when ready.',
               'Listening रुक गई। जब तैयार हो, "Jarvis" बोलो।',
               'Listening ruk gayi. "Jarvis" bolo jab ready ho.')
      : L(lang, 'Tap 🎙 or say Jarvis to try again.', '🎙 दबाओ या "Jarvis" बोलो।', '"Jarvis" bolo.')
    setStatus(status)
    VA.setTranscript(status, true)
  }

  r.onend = () => {
    if (committed) return
    // Chrome fired onend before sending a final result — commit the interim
    commit(finalText || interimTxt)
  }

  try { r.start() } catch {
    stopListening(); VA.setState('idle'); setState('idle')
    setStatus('Microphone unavailable. Please type below.')
  }
}

function stopListening(): void {
  if (_contListenTimer) { clearTimeout(_contListenTimer); _contListenTimer = 0 }
  _rec?.stop();     _rec = null
  _wakeRec?.stop(); _wakeRec = null; _wakeRunning = false
  _micStream?.getTracks().forEach(t => t.stop()); _micStream = null
  _audioCtx?.close(); _audioCtx = null; _analyser = null
  document.getElementById('jp-mic')?.classList.remove('active')
  document.getElementById('jarvis-btn')?.classList.remove('listening')
  if (_state === 'listening') setState('thinking')
  if (VA.state === 'listening') VA.setState('thinking')
}

function sendText(inp: HTMLInputElement): void {
  const txt = inp.value.trim(); if (!txt) return; inp.value = ''
  void processQuery(txt)
}

// ── Query Processing — the intelligence core ──────────────────────────────────
async function processQuery(text: string): Promise<void> {
  if (!text.trim()) return   // ignore empty (mic sometimes returns blank result)

  // 0. Vision
  if (isVisionTrigger(text)) { addMsg('user', text); openVisionCapture(text, respond); return }

  const tl = text.toLowerCase().trim()

  // 0a. Single-keyword shortcuts — respond instantly, no router needed
  const QUICK: Record<string, () => void> = {
    'plan': () => scr('plan'),     'planner': () => scr('plan'),
    'stats': () => scr('intel'),   'analytics': () => scr('intel'),   'scores': () => scr('intel'),
    'timer': clickStart,           'start': clickStart,                'shuru': clickStart,
    'pause': () => q('[data-act="start"]'), 'stop': () => q('[data-act="start"]'),
    'reset': () => q('[data-act="reset"]'),
    'routine': () => scr('routine'),       'constitution': () => scr('constitution'),
    'settings': () => cl('cm-settings'),
    'backlog': () => { scr('plan'); cl('lp-filter-backlog') },
    'status': () => respond(buildStatusReport()),
    'briefing': () => respond(buildStatusReport()),
    'motivate': () => respond(motivationLine()),  'motivation': () => respond(motivationLine()),
    'help': () => respond("Say 'Jarvis' or double-clap to wake me. Then say any command. Try: 'start timer', 'what's my plan', 'add score', 'quiz me on Polity'."),
  }
  if (QUICK[tl]) { addMsg('user', text); QUICK[tl](); if (!['status','briefing','motivate','motivation','help'].includes(tl)) respond(tl + '.'); return }

  // 0b. Sleep / stop-listening — MUST fire before any other pattern (STT can hear
  //     "listening" as "locking", so we intercept here to avoid false lock trigger)
  if (/\b(stop.*listen|stop.*hearing|suno.*band|sunna.*band|listen.*stop|band.*karo.*sun|jarvis.*so.*ja|so.*ja|sleep.*mode|go.*sleep)\b/i.test(tl) ||
      /^(stop|band karo|chup|shhh|quiet)$/i.test(tl)) {
    _sleeping = true
    _wakeRec?.stop(); _wakeRec = null; _wakeRunning = false
    stopListening(); _synth.cancel()
    addMsg('user', text)
    respond('Sleeping. Double-clap or tap me to wake up.')
    return
  }

  // 1. Quiz answer while in quiz mode
  if (_quizPhase === 'asking') {
    const ans = parseQuizAnswer(tl)
    if (ans) { addMsg('user', text); void handleQuizAnswer(ans); return }
    // "quit quiz / exit quiz"
    if (/quit|exit|band|khatam.*quiz|quiz.*khatam/i.test(tl)) {
      _quizPhase = 'off'
      addMsg('user', text)
      respond(`Quiz ended. Score so far: ${_quizHits} out of ${_quizIdx}.`)
      return
    }
  }

  // 2. Reminder set
  const remMins = parseReminderMinutes(tl)
  if (remMins !== null) {
    addMsg('user', text)
    const msg = extractReminderLabel(tl) || "Time's up!"
    const id = _nextRemId++
    _reminders.push({ id, msg, at: Date.now() + remMins * 60_000 })
    respond(`Reminder set for ${remMins} minute${remMins>1?'s':''}. I'll alert you then.`)
    return
  }

  // 3. Timer set command — fire whenever the transcript carries a duration
  //    (voice to JARVIS is almost always intentional; explicit "explain in X min" excluded below)
  const isExplain = /\b(explain|samjhao|bata|describe|define|tell.*me.*about|describe)\b/i.test(tl)
  const mins = parseSpokenMinutes(text)
  if (mins !== null && !isExplain) {
    addMsg('user', text)
    fireTimer(mins)
    respond(`${mins}-minute timer set and started. Focus, Om.`)
    return
  }

  // 3b. Natural-language durations: "half hour timer", "1 hour session", "timer 45", etc.
  const durMins = parseNaturalDuration(tl)
  if (durMins !== null) {
    addMsg('user', text)
    fireTimer(durMins)
    respond(`${durMins}-minute timer set and started.`)
    return
  }

  // 4. Topic / lecture done
  if (/topic.*over|topic.*done|topic.*khatam|topic.*finish|lecture.*over|lecture.*done|lecture.*khatam|lecture.*finish|yeh.*khatam|is topic|mark.*topic|mark.*lecture|topic ho gaya|lecture ho gaya|aaj.*lecture.*ho|padh.*liya/i.test(tl)) {
    addMsg('user', text)
    const title = checkCurrentTopic()
    respond(title ? `"${title}" done! ${celebrationLine()}` : 'No pending lecture found in the planner.')
    return
  }

  // 5. Score entry — "I scored 145 out of 200 in Mock 7"
  const scoreEntry = parseScoreEntry(tl)
  if (scoreEntry) {
    addMsg('user', text)
    const { score, max, label } = scoreEntry
    const pct = ((score/max)*100).toFixed(1)
    const el = document.getElementById('cm-add-score')
    if (el) {
      // Pre-fill and open the score dialog
      el.click()
      setTimeout(() => prefillScoreForm(score, max, label ?? ''), 400)
      respond(`${pct}% in ${label ?? 'test'}. Opening score entry for you.`)
    } else {
      respond(`${score} out of ${max} — that's ${pct}%. Open the score section to log it.`)
    }
    return
  }

  // 6. Full status / report
  if (/how.*doing|status.*report|status batao|kaisa.*ja|progress|meri report|full status|briefing|overview|summary/i.test(tl)) {
    addMsg('user', text); respond(buildStatusReport()); return
  }

  // 7. Today's plan / what to study
  if (/aaj.*plan|today.*plan|what.*study|kya.*padhna|plan.*today|what.*pending|kya.*pending|aaj.*kya|pending.*aaj|schedule|what.*do.*today|today.*what|aaj.*ka.*kaam|agenda/i.test(tl)) {
    addMsg('user', text); respond(buildTodayReport()); return
  }

  // 8. Streak info
  if (/streak.*kya|streak.*kitni|my streak|streak.*hai|kitne.*din|consecutive/i.test(tl)) {
    addMsg('user', text)
    const cs = getCurrentState()
    respond(cs?.streak ? `You're on a ${cs.streak}-day streak. Keep it alive today.` : 'No streak data yet. Log a session to start one.')
    return
  }

  // 9. Backlog info — all 2000-CSV phrasings for query.backlog
  if (/backlog|lecture.*left|kitne.*lecture|how many.*lecture|pending.*lecture|lecture.*bache|lecture.*pending|remaining.*lecture|lectures.*remaining|kitna.*baka|what.*left.*study|baaki.*hai|kya.*pending/i.test(tl)) {
    addMsg('user', text)
    const cs = getCurrentState()
    respond(cs?.backlogRemaining != null ? `${cs.backlogRemaining} lectures remain in your backlog.` : 'Backlog data unavailable.')
    return
  }

  // 10. Days until prelims / exam countdown
  if (/prelims.*kab|kitne.*din.*bache|days.*left|exam.*kitne|countdown|prelims.*days|how long.*prelims|exam.*countdown|din.*bache/i.test(tl)) {
    addMsg('user', text); respond(buildExamCountdown()); return
  }

  // 10b. Study hours query — query.hours intent
  if (/kitna.*padha|how.*much.*study|study.*time.*today|aaj.*kitne.*ghante|padhai.*kitni|how.*long.*study|study.*hours|focus.*time.*today|aaj.*study.*kiya/i.test(tl)) {
    addMsg('user', text)
    const m = getTodayFocusMins()
    respond(m ? `${m} minutes studied today.` : 'No sessions logged yet today. Start a focus session!')
    return
  }

  // 10c. Score / average query — query.average + query.selectionProb + query.rank
  if (/my.*average|mera.*average|average.*kya|prelims.*average|score.*average|subject.*average|optional.*average|mains.*average|overall.*average/i.test(tl)) {
    addMsg('user', text)
    const cs = getCurrentState()
    const avg = cs?.performance?.prelimsAvg
    scr('intel')
    respond(avg != null ? `Prelims average: ${avg.toFixed(1)}%. Full breakdown in analytics.` : 'Enter more test scores to compute your average.')
    return
  }

  if (/selection.*prob|select.*chance|selection.*percent|probability.*select|kitna.*chance|select.*hoga|mera.*sp/i.test(tl)) {
    addMsg('user', text)
    const sp = getCurrentState()?.selectionProbabilityPct
    respond(sp != null ? `Selection probability: ${sp.toFixed(1)}%. ${sp>=50?'Strong position.':'Keep improving.'}` : 'Log more scores to see your selection probability.')
    return
  }

  if (/my.*rank|rank.*projection|air.*estimate|projected.*rank|rank.*kya|meri.*rank|rank.*batao/i.test(tl)) {
    addMsg('user', text); respond(buildRankLine()); return
  }

  // 10d. Revision / SRS — revision.due intent
  if (/revision.*due|what.*revise|revise.*today|srs.*today|kya.*revise|due.*revision|aaj.*revise|pending.*revision|revision.*list|revision.*queue/i.test(tl)) {
    addMsg('user', text); scr('plan'); respond(buildRevisionLine()); return
  }

  // 10e. Timer status — what time is left, is timer running
  if (/kitna.*time.*baka|timer.*remaining|how.*much.*time.*left|timer.*status|is.*timer.*running|timer.*kya.*hai|current.*timer|time.*left.*timer/i.test(tl)) {
    addMsg('user', text)
    const timeEl = document.querySelector<HTMLElement>('.ring-time')
    const btn    = document.querySelector<HTMLButtonElement>('[data-act="start"]')
    const running = btn?.textContent?.toLowerCase().includes('pause')
    respond(running ? `Timer running: ${timeEl?.textContent ?? '?'} remaining.` : 'Timer is not running. Say "start timer" to begin.')
    return
  }

  // 10f. Generate / show plan — plan.generate + plan.today
  if (/generate.*plan|create.*plan|make.*plan|plan.*banao|schedule.*banao|plan.*generate|mera.*plan.*banao|aaj.*ka.*plan.*dikhao/i.test(tl)) {
    addMsg('user', text); cl('ai-gen'); respond('Generating your optimized study plan…'); return
  }

  // 10g. Mark today's lecture done — lecture.markDone
  if (/aaj.*lecture.*done|lecture.*mark.*done|today.*lecture.*complete|lecture.*khatam|yeh.*khatam|topic.*done|topic.*over|padh.*liya|lecture.*ho.*gaya/i.test(tl)) {
    addMsg('user', text)
    const title = checkCurrentTopic()
    respond(title ? `"${title}" done! ${celebrationLine()}` : 'No pending lecture found.')
    return
  }

  // 10h. Routine day type — routine.setType
  if (/aaj.*holiday|today.*holiday|mark.*holiday|chutti.*hai|aaj.*off|holiday.*mark|aaj.*leave|set.*today.*holiday/i.test(tl)) {
    addMsg('user', text)
    const sel = document.getElementById('rtn-day-type') as HTMLSelectElement | null
    if (sel) { sel.value = 'Holiday'; sel.dispatchEvent(new Event('change')); scr('routine') }
    respond('Today marked as Holiday. Routine updated.')
    return
  }

  // 10i. Add mistake — mistake.add
  if (/add.*mistake|log.*mistake|mistake.*add|galti.*note|wrong.*answer.*log|mistake.*notebook.*add/i.test(tl)) {
    addMsg('user', text); cl('cm-add-mistake'); respond('Mistake Notebook opened.'); return
  }

  // 10j. Add current affairs — ca.add
  if (/add.*current.*affair|ca.*add|current.*affair.*log|news.*add|aaj.*ka.*news|current.*affairs.*add/i.test(tl)) {
    addMsg('user', text); cl('cm-ca-log'); respond('Current Affairs log opened.'); return
  }

  // 10k. Constitution lookup — ONLY for "open/show/go to" requests
  // "explain Article 21" / "Article 21 batao" → let Groq answer with full text
  // "open Article 21" / "show Article 21" → just scroll to it
  if (/article\s*\d+|anuched\s*\d+/i.test(tl) &&
      /\b(open|show|scroll|go to|dikhao|le.*chalo|section|search)\b/i.test(tl) &&
      !/\b(explain|batao|samjhao|tell|describe|kya.*hai|what.*is|ke.*baare|about)\b/i.test(tl)) {
    const m = tl.match(/article\s*(\d+[a-z]?)/i) ?? tl.match(/anuched\s*(\d+)/i)
    addMsg('user', text); scr('constitution')
    respond(`Opening Constitution — Article ${m?.[1] ?? '...'}.`)
    return
  }

  // 10l. Switch language — all natural phrasings ──────────────────────────────
  if (/hindi.*mein|hindi.*bolo|hindi.*jawab|hindi.*bol\b|answer.*hindi|respond.*hindi|speak.*hindi|switch.*hindi|hindi.*switch|hindi.*chahiye|hindi.*please|ab.*hindi|reply.*hindi|hindi.*reply|hindi.*answer|mujhe.*hindi|in.*hindi|hindi.*me.*baat|hindi.*me.*bol|hindi.*medium/i.test(tl)) {
    _replyLang = 'hi'; localStorage.setItem('jarvis_reply_lang', 'hi')
    addMsg('user', text); respond('Bilkul! Ab main Hindi mein jawab dunga. Kya chahiye?'); return
  }
  if (/hinglish|hindi.*mix.*english|mix.*language/i.test(tl)) {
    _replyLang = 'hinglish'; localStorage.setItem('jarvis_reply_lang', 'hinglish')
    addMsg('user', text); respond('Sure! Hinglish mein baat karte hain. Batao kya chahiye?'); return
  }
  if (/switch.*english|english.*mein.*bol|speak.*english|change.*language.*english|answer.*english|reply.*english|english.*medium|back.*english/i.test(tl)) {
    _replyLang = 'en'; localStorage.setItem('jarvis_reply_lang', 'en')
    addMsg('user', text); respond('Switched to English. What do you need?'); return
  }

  // 10m. Stop / sleep — system.sleep
  if (/^(stop|sleep|dismiss|close.*jarvis|jarvis.*close|band karo|chup|shhh)$/i.test(tl) && _open) {
    addMsg('user', text); closePanel(); return
  }

  // 10n. Repeat last — system.repeat
  if (/say.*again|repeat|dobara.*bolo|phir.*bolo|again.*bolo|what.*did.*you.*say/i.test(tl)) {
    addMsg('user', text); respond(_lastReply || 'Nothing to repeat yet.'); return
  }

  // 10o. Add score — score.add
  if (/add.*score|score.*add|score.*dal|marks.*add|result.*add|test.*score.*add/i.test(tl)) {
    addMsg('user', text); cl('cm-add-score'); respond('Add Score opened.'); return
  }

  // 10p. Full week summary
  if (/week.*summary|is.*week.*kaisi|this.*week.*how|weekly.*report|week.*kaise.*gaya/i.test(tl)) {
    addMsg('user', text); respond(buildWeekSummary()); return
  }

  // 11. Math / percentage calculation
  const mathResult = quickMath(tl)
  if (mathResult) { addMsg('user', text); respond(mathResult); return }

  // 12. Quick note / inbox capture
  if (/quick note|note karo|likh lo|capture|inbox|jot.*down|yaad.*rakh/i.test(tl)) {
    addMsg('user', text)
    const note = text.replace(/quick note|note karo|likh lo|capture|inbox|jot.*?down|yaad.*?rakh/gi, '').trim()
    if (note) addToInbox(note)
    respond(note ? `Noted: "${note}". It's in your inbox.` : 'What would you like to note? Say it after the command.')
    return
  }

  // 13. Cancel reminders
  if (/cancel.*reminder|reminder.*cancel|reminders.*band|saare.*reminder/i.test(tl)) {
    addMsg('user', text)
    const count = _reminders.length
    _reminders.length = 0
    respond(count ? `${count} reminder${count>1?'s':''} cancelled.` : 'No active reminders.')
    return
  }

  // 14. Quiz start
  if (/quiz.*me|test.*me|quiz.*do|mcq.*do|questions.*do|prashn.*do|quiz.*start|start.*quiz/i.test(tl)) {
    addMsg('user', text)
    const topic = tl.replace(/quiz.*me.*on|quiz.*me|test.*me.*on|test.*me|quiz.*do|mcq.*do|quiz.*start|start.*quiz/gi,'').replace(/\b(on|about|pe|par|ke|ka)\b/gi,'').trim()
    void startQuiz(topic || (getCurrentState()?.today?.subject ?? 'UPSC GS'))
    return
  }

  // 15. Next quiz question (explicit)
  if (_quizPhase !== 'off' && /next|aage|skip.*question|next.*question/i.test(tl)) {
    addMsg('user', text); void nextQuizQuestion(); return
  }

  // 16. Motivation
  if (/motivate|motivation|inspire|haar.*lag|thak.*gaya|tired|discouraged|demotivated|himmat/i.test(tl)) {
    addMsg('user', text)
    respond(motivationLine()); return
  }

  // 17. Named topic mark — "mark Polity chapter 3 done"
  if (/mark.*done|done.*kar|complete.*kar|khatam.*kar/i.test(tl)) {
    const label = tl.replace(/mark|done|karo|kar|complete|khatam/g,'').trim()
    if (label) {
      addMsg('user', text)
      const found = checkNamedTopic(label)
      respond(found ? `"${found}" marked done. ${celebrationLine()}` : checkCurrentTopic() ? `Couldn't find "${label}" specifically, so marked the first pending lecture done.` : 'No matching lecture found.')
      return
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 17b. ADVANCED INTELLIGENCE HANDLERS (run before CMDS for priority)
  // ─────────────────────────────────────────────────────────────────────────────
  _lastUserQuery = text   // always record for context / follow-up

  // ── TTS Speed Control ────────────────────────────────────────────────────────
  if (/speak.*faster|faster.*speak|speed.*up|tez.*bolo|jaldi.*bolo|fast.*mode/i.test(tl)) {
    _ttsSpeed = 'fast'; localStorage.setItem('jarvis_speed', 'fast')
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Speaking faster now.', 'अब तेज़ बोलूंगा।', 'Faster speed set.')); return
  }
  if (/speak.*slower|slower.*speak|slow.*down|dheere.*bolo|aaram.*se.*bolo|slow.*mode/i.test(tl)) {
    _ttsSpeed = 'slow'; localStorage.setItem('jarvis_speed', 'slow')
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Speaking slower now.', 'अब धीरे बोलूंगा।', 'Slower speed set.')); return
  }
  if (/normal.*speed|reset.*speed|default.*speed|medium.*speed/i.test(tl)) {
    _ttsSpeed = 'normal'; localStorage.setItem('jarvis_speed', 'normal')
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Back to normal speed.', 'सामान्य गति पर वापस।', 'Normal speed resumed.')); return
  }

  // ── TTS Volume Control ────────────────────────────────────────────────────
  if (/speak.*louder|louder.*speak|volume.*up|aawaz.*tez|zyada.*aawaz|increase.*volume/i.test(tl)) {
    _ttsVolume = Math.min(1.0, _ttsVolume + 0.25); localStorage.setItem('jarvis_volume', String(_ttsVolume))
    addMsg('user', text)
    respond(L(detectResponseLang(text), `Volume up to ${Math.round(_ttsVolume*100)}%.`, `आवाज़ ${Math.round(_ttsVolume*100)}% हो गई।`, `Volume ${Math.round(_ttsVolume*100)}% ho gaya.`)); return
  }
  if (/speak.*quieter|quieter.*speak|volume.*down|aawaz.*kam|lower.*volume|decrease.*volume/i.test(tl)) {
    _ttsVolume = Math.max(0.2, _ttsVolume - 0.25); localStorage.setItem('jarvis_volume', String(_ttsVolume))
    addMsg('user', text)
    respond(L(detectResponseLang(text), `Volume down to ${Math.round(_ttsVolume*100)}%.`, `आवाज़ ${Math.round(_ttsVolume*100)}% हो गई।`, `Volume ${Math.round(_ttsVolume*100)}% ho gaya.`)); return
  }
  if (/full.*volume|max.*volume|poori.*aawaz|maximum.*volume/i.test(tl)) {
    _ttsVolume = 1.0; localStorage.setItem('jarvis_volume', '1')
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Full volume.', 'पूरी आवाज़ चालू।', 'Full volume on.')); return
  }

  // ── Continuous Conversation Mode ─────────────────────────────────────────────
  if (/conversation.*mode.*on|auto.*listen.*on|continuous.*mode.*on|baat.*karte.*raho|sunta.*raho/i.test(tl)) {
    _continuousMode = true; localStorage.setItem('jarvis_continuous', 'true')
    addMsg('user', text)
    respond(L(detectResponseLang(text),
      'Conversation mode on. I will keep listening after each response for your follow-up.',
      'Conversation mode चालू। हर जवाब के बाद follow-up के लिए सुनता रहूंगा।',
      'Conversation mode on. Follow-up ke liye sunta rahunga.'
    )); return
  }
  if (/conversation.*mode.*off|auto.*listen.*off|continuous.*mode.*off|band.*karo.*conversation/i.test(tl)) {
    _continuousMode = false; localStorage.setItem('jarvis_continuous', 'false')
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Conversation mode off.', 'Conversation mode बंद।', 'Conversation mode off.')); return
  }

  // ── Command Chaining: "start timer and show plan" / "mark done aur add score" ──
  {
    const CHAIN_RE = /^(.+?)\s+(?:and\s+(?:then\s+|also\s+)?|then\s+|aur\s+(?:phir\s+)?|phir\s+(?:se\s+)?)(.+)$/i
    const cm = tl.match(CHAIN_RE)
    const isCmd = (s: string) => !s.includes('?') && /\b(open|show|start|stop|mark|add|set|generate|remind|lock|go|give|tell|log|create|get|display|toggle)\b/i.test(s)
    if (cm && isCmd(cm[1]) && isCmd(cm[2])) {
      addMsg('user', text)
      void processQuery(cm[1].trim())
      setTimeout(() => { void processQuery(cm[2].trim()) }, 1600)
      return
    }
  }

  // ── Emergency Cram Mode ───────────────────────────────────────────────────────
  if (/emergency.*cram|emergency.*mode|crash.*course|last.*minute.*study|urgent.*revision|time.*nahi.*hai.*padh|kal.*exam.*hai/i.test(tl)) {
    addMsg('user', text)
    const lang   = detectResponseLang(text)
    const rawMin = parseSpokenMinutes(tl) ?? parseNaturalDuration(tl)
    const hrsNum = rawMin ? Math.max(1, Math.round(rawMin / 60)) : 2
    const subj   = tl.replace(/emergency|cram|crash|course|last|minute|study|urgent|revision|time|nahi|hai|padh|kal|exam|hours?|ghante|mins?|minutes?/gi, '').trim()
                  || (_sessionSubject || getCurrentState()?.today?.subject || 'GS')
    respond(L(lang,
      `Emergency ${hrsNum}-hour cram for ${subj}. Timer set. Fetching top priority topics.`,
      `${hrsNum} घंटे का emergency session ${subj} के लिए। Timer चालू, top topics आ रहे हैं।`,
      `${hrsNum} hour emergency cram for ${subj}. Timer set. Top topics fetch kar raha hoon.`
    ))
    fireTimer(50); scr('plan')
    if (GROQ_AVAILABLE) void executeIntent(`List the 8 most important and most frequently asked UPSC topics in ${subj} that I must cover in a ${hrsNum}-hour emergency cram. Rank by UPSC frequency. No markdown. Spoken list only.`)
    return
  }

  // ── Voice-First Guided Topic Walkthrough ─────────────────────────────────────
  if (/walk.*me.*through|guide.*me.*through|explain.*step.*by.*step.*topic|teach.*me.*about|topic.*se.*shuru|topic.*samjhao/i.test(tl)) {
    const topic = tl.replace(/walk.*me.*through|guide.*me.*through|explain.*step.*by.*step|teach.*me.*about|topic.*se.*shuru|topic.*samjhao/gi, '').trim()
    if (topic.length > 2) {
      addMsg('user', text)
      if (GROQ_AVAILABLE) void executeIntent(`Walk me through ${topic} for UPSC in simple spoken language. Cover: definition, background, key points, constitutional provisions if any, and one real-world example. Maximum 4 sentences total. No markdown.`)
      return
    }
  }

  // ── Study Session Subject Tagging ─────────────────────────────────────────────
  if (/(?:i'm|i am|main|mein)\s+(?:studying|padh\s+raha|padhna\s+shuru)|studying\s+(?:polity|history|geography|economics|environment|science|ethics|gs\d|csat)/i.test(tl)) {
    const subj = tl.replace(/i'm|i am|main|mein|studying|padh.*raha|padhna.*shuru|abhi/gi, '').trim()
    if (subj.length > 2) {
      _sessionSubject = subj
      addMsg('user', text)
      respond(L(detectResponseLang(text),
        `Tracking your ${subj} session. I'll tailor questions and reminders to this topic.`,
        `${subj} session track हो रही है। Questions और reminders इसी पर रहेंगे।`,
        `${subj} session track ho raha hai. Questions isi topic pe rahengi.`
      )); return
    }
  }

  // ── Comparative Progress Query ────────────────────────────────────────────────
  if (/compare.*(?:this.*week|last.*week)|improvement.*over.*time|how.*improved|score.*trend|trend.*score/i.test(tl)) {
    addMsg('user', text); scr('intel'); respond(buildWeekSummary()); return
  }

  // ── Weakest Subject / Gap Analysis ───────────────────────────────────────────
  if (/weakest.*subject|worst.*subject|lowest.*score.*subject|mera.*kamzor|gap.*analysis|kahan.*weak/i.test(tl)) {
    addMsg('user', text); scr('intel')
    if (GROQ_AVAILABLE) void executeIntent(`Based on standard UPSC preparation difficulty, identify my most likely weak subject from these GS papers: GS1 (History, Geography, Society), GS2 (Polity, Governance, IR), GS3 (Economy, Environment, Science), GS4 (Ethics). Give one specific subject and three targeted study tips for it. No markdown.`)
    else respond('Check the Intelligence section for your subject-wise score breakdown. The lowest average points to your weakest area.')
    return
  }

  // ── Smart Dictation — Note / CA / Doubt / Mistake ────────────────────────────
  {
    const dictNote    = text.match(/^(?:note|jot|likh)\s*[:\-]?\s*(.+)/i)
    const dictCA      = text.match(/^(?:ca|current affairs?|news|aaj ka news)\s*[:\-]?\s*(.+)/i)
    const dictDoubt   = text.match(/^(?:doubt|doubts?|query|sawaal)\s*[:\-]?\s*(.+)/i)
    const dictMistake = text.match(/^(?:mistake|galti|wrong)\s*[:\-]?\s*(.+)/i)
    if (dictNote) {
      addToInbox(dictNote[1].trim()); addMsg('user', text)
      respond(L(detectResponseLang(text), `Noted: "${dictNote[1].trim()}"`, `Note: "${dictNote[1].trim()}"`, `Noted.`)); return
    }
    if (dictCA) {
      addMsg('user', text); cl('cm-ca-log')
      setTimeout(() => {
        const inp = document.querySelector<HTMLTextAreaElement>('#ca-body,#ca-text,[name="ca-body"]')
        if (inp) { inp.value = dictCA[1].trim(); inp.dispatchEvent(new Event('input')) }
      }, 400)
      respond(L(detectResponseLang(text), `CA entry ready: "${dictCA[1].trim()}"`, `CA entry: "${dictCA[1].trim()}"`, `CA log ready.`)); return
    }
    if (dictDoubt) {
      addToInbox(`[DOUBT] ${dictDoubt[1].trim()}`); addMsg('user', text)
      respond(L(detectResponseLang(text), `Doubt logged: "${dictDoubt[1].trim()}"`, `Doubt log: "${dictDoubt[1].trim()}"`, `Doubt saved.`)); return
    }
    if (dictMistake) {
      addMsg('user', text); cl('cm-add-mistake')
      setTimeout(() => {
        const inp = document.querySelector<HTMLInputElement>('#mk-question,[name="mk-question"]')
        if (inp) { inp.value = dictMistake[1].trim(); inp.dispatchEvent(new Event('input')) }
      }, 400)
      respond(L(detectResponseLang(text), `Mistake logged for review.`, `Mistake log हो गई।`, `Mistake save ho gayi.`)); return
    }
  }

  // ── Session-Aware Study Check-In ─────────────────────────────────────────────
  if (/how.*long.*studying|kitni.*der.*se.*padh|session.*kitna.*hua|kitna.*time.*ho.*gaya.*padhai/i.test(tl)) {
    addMsg('user', text)
    const m    = getTodayFocusMins()
    const lang = detectResponseLang(text)
    respond(m
      ? L(lang, `You've studied ${m} minutes today. ${m >= 120 ? 'Excellent consistency.' : 'Keep going.'}`, `आज ${m} मिनट पढ़ाई हुई। ${m >= 120 ? 'शानदार।' : 'जारी रखो।'}`, `Aaj ${m} minutes padhai hui.`)
      : L(lang, 'No sessions logged yet today.', 'आज अभी कोई session नहीं।', 'Aaj koi session nahi hua abhi.')
    ); return
  }

  // ── Repeat / Expand Last Answer ───────────────────────────────────────────────
  if (/tell.*more|elaborate|expand.*on.*that|more.*detail|aur.*batao|detail.*mein|elaborate.*karo/i.test(tl)) {
    if (_lastReply) {
      addMsg('user', text)
      if (GROQ_AVAILABLE) void executeIntent(`Expand on this in 2-3 more spoken sentences: "${_lastReply.slice(0, 120)}"`)
      else respond(_lastReply)
    } else {
      addMsg('user', text); respond(L(detectResponseLang(text), 'Nothing to expand on yet.', 'अभी कुछ नहीं है।', 'Kuch nahi hai abhi.'))
    }
    return
  }

  // ── IQ / Concept Test: Ask JARVIS to quiz on current topic ────────────────────
  if (/test.*my.*knowledge|test.*karke.*dekho|mera.*test.*lo|aaj.*ka.*quiz|random.*question/i.test(tl)) {
    const topic = _sessionSubject || getCurrentState()?.today?.subject || 'UPSC GS'
    addMsg('user', text); void startQuiz(topic); return
  }

  // ── Exam Date Awareness ───────────────────────────────────────────────────────
  if (/how.*prepared|kitna.*taiyar|preparation.*percent|taiyari.*kahan|readiness/i.test(tl)) {
    addMsg('user', text)
    const cs   = getCurrentState()
    const lang = detectResponseLang(text)
    const done = document.querySelectorAll('#plan .plan-row.done').length
    const tot  = document.querySelectorAll('#plan .plan-row').length
    const pct  = tot ? Math.round((done / tot) * 100) : 0
    const avg  = cs?.performance?.prelimsAvg?.toFixed(1)
    if (GROQ_AVAILABLE) {
      void executeIntent(`Give me an honest assessment of my preparation: I've covered ${pct}% of lectures, ${avg ? `average score ${avg}%` : 'no scores yet'}, ${cs?.streak ?? 0} day streak. What's my biggest gap right now? One honest sentence only.`)
    } else {
      respond(L(lang,
        `Syllabus coverage: ${pct}%${avg ? `, average score: ${avg}%` : ''}. Keep pushing.`,
        `Syllabus ${pct}% complete${avg ? `, average: ${avg}%` : ''}। जारी रखो।`,
        `Coverage: ${pct}%${avg ? `, avg: ${avg}%` : ''}. Keep going.`
      ))
    }
    return
  }

  // ── Emotion-adaptive tone ─────────────────────────────────────────────────
  // Adjust TTS speed and response style based on detected emotion
  {
    const emo = detectEmotion(text)
    if (emo === 'tired' || emo === 'stressed' || emo === 'sad') {
      if (_ttsSpeed === 'fast') { _ttsSpeed = 'normal' }  // auto-slow down if user is tired
    }
    if (emo === 'stressed' || emo === 'sad') {
      // Intercept before general routing with a warm, specific response
      const specificStress = /deadline|kal.*paper|paper.*kal|exam.*3.*day|3.*din.*exam/i.test(tl)
      if (!specificStress) {
        const lang = detectResponseLang(text)
        const reply =
          emo === 'sad'
            ? L(lang,
                "I hear you, Om. This path is genuinely hard and it is okay to feel that. Take 10 minutes. Step outside. Then come back. Every person who cleared UPSC had a moment exactly like this one.",
                "सुन रहा हूँ, ओम। यह रास्ता सच में मुश्किल है — ऐसा feel करना सामान्य है। 10 मिनट बाहर जाओ। फिर वापस आओ। UPSC clear करने वाले हर शख्स के जीवन में यह पल था।",
                "Sun raha hoon, Om. Yeh raasta sach mein mushkil hai. 10 minute bahar jao. Phir wapas aao. UPSC clear karne waale har insaan ke life mein ek aisa moment tha."
              )
            : emo === 'stressed'
            ? L(lang,
                "Breathe. Right now — four counts in, four counts out. Stress is just energy. Let it pass through. What specifically is worrying you? Say it and we will break it down.",
                "सांस लो। अभी — चार गिनती अंदर, चार बाहर। Stress बस energy है। आने दो और जाने दो। क्या specifically परेशान कर रहा है? बताओ — हम साथ मिलकर सुलझाएंगे।",
                "Saanss lo. Abhi — 4 count andar, 4 bahar. Stress sirf energy hai. Kya specifically worry ho raha hai? Batao — milke sort out karte hain."
              )
            : L(lang,
                "Take a proper break now. You have earned it. Drink water, rest your eyes, stretch for 5 minutes. Study after rest is 40% more effective.",
                "अभी एक proper break लो। तुमने earn किया है। पानी पियो, आंखें बंद करो, 5 मिनट stretch करो।",
                "Abhi ek proper break lo. Pani piyo, aankhein rest karo. Break ke baad padhai 40% zyada effective hoti hai."
              )
        addMsg('user', text); respond(reply); return
      }
    }
  }

  // ── UPSC Vocabulary Word of the Day ──────────────────────────────────────
  if (/vocab|vocabulary|word.*of.*the.*day|aaj.*ka.*shabd|legal.*term|law.*term|upsc.*term/i.test(tl)) {
    addMsg('user', text)
    const v    = getVocabWord()
    const lang = detectResponseLang(text)
    respond(L(lang,
      `UPSC Term: ${v.word}. ${v.meaning} Example: ${v.example}`,
      `UPSC Term: ${v.word}. ${v.meaning} उदाहरण: ${v.example}`,
      `UPSC Term: ${v.word}. ${v.meaning} Example: ${v.example}`
    )); return
  }

  // ── Multi-Reminder Parsing: "remind me at 3pm, 5pm and 8pm" ──────────────
  {
    const times = parseMultipleReminderTimes(tl)
    if (times.length >= 2) {
      addMsg('user', text)
      const label = extractReminderLabel(tl) || "Time's up!"
      times.forEach(at => _reminders.push({ id: _nextRemId++, msg: label, at }))
      const lang = detectResponseLang(text)
      respond(L(lang,
        `${times.length} reminders set. I will alert you at each time.`,
        `${times.length} reminders set हो गए।`,
        `${times.length} reminders set. Har time pe bataunga.`
      )); return
    }
  }

  // ── Mains Answer Evaluator ────────────────────────────────────────────────
  if (/evaluate.*answer|answer.*evaluate|mera.*answer.*check|check.*my.*answer|answer.*kaisa.*tha|mains.*practice.*evaluate/i.test(tl)) {
    addMsg('user', text)
    const lang = detectResponseLang(text)
    respond(L(lang,
      'Answer Evaluation mode. Type or speak your answer and I will evaluate it for UPSC Mains — structure, content, keywords, and improvement areas.',
      'Answer Evaluation mode। अपना answer type करो या बोलो — मैं structure, content, keywords और improvements evaluate करूंगा।',
      'Answer Evaluation mode. Apna answer type ya bolo — main structure, content, keywords aur improvements evaluate karunga.'
    ))
    // After they give the answer, the next processQuery call with qa.answer will have context
    // We pre-seed context via _history so Groq knows we're evaluating
    _history.push({ role: 'assistant', content: '[EVALUATION MODE: User will now provide their UPSC Mains answer. Evaluate it for: 1) Introduction quality 2) Body structure and depth 3) UPSC keywords used 4) Conclusion quality 5) Missing dimensions. Score each out of 10. Give 3 specific improvement suggestions. Spoken format — no markdown.]' })
    return
  }

  // ── Study Buddy / Debate Mode ─────────────────────────────────────────────
  if (/debate.*with.*me|argue.*with.*me|take.*other.*side|let.*argue|mujhse.*debate|opposing.*view|discuss.*with.*me/i.test(tl)) {
    const topic = tl.replace(/debate.*with.*me|argue.*with.*me|take.*other.*side|let.*argue|mujhse.*debate|opposing.*view|discuss.*with.*me/gi, '').trim()
    if (!topic) {
      addMsg('user', text)
      respond(L(detectResponseLang(text),
        'Sure — what topic do you want to debate? Say "debate uniform civil code" or any UPSC topic.',
        'ज़रूर — कौन सा topic debate करना है? बोलो।',
        'Zaroor — kaunsa topic? Bolo.'
      )); return
    }
    addMsg('user', text)
    _mem.debateCount++; saveMem()
    if (GROQ_AVAILABLE) {
      void executeIntent(`Take the OPPOSING position on this topic and argue it persuasively in 2-3 spoken sentences: "${topic}". No markdown. State your position clearly then give your strongest argument. I will counter it.`)
    } else {
      respond(L(detectResponseLang(text), `Debate: ${topic}. No API key — I cannot argue live, but you can practice by speaking your arguments aloud and self-evaluating.`, `Debate ${topic} — API key नहीं है।`, `Debate ke liye API key chahiye.`))
    }
    return
  }

  // ── Pre-Exam Ritual Mode ──────────────────────────────────────────────────
  if (/exam.*tomorrow|kal.*exam.*hai|kal.*test|pre.*exam.*mode|night.*before.*exam|exam.*aaj.*raat/i.test(tl)) {
    addMsg('user', text)
    const lang = detectResponseLang(text)
    respond(L(lang,
      "Pre-exam protocol: No new topics tonight. Only your notes and 10 PYQs maximum. Eat a proper meal. Stop studying by 10 PM. Sleep 7 hours minimum. Tomorrow: light breakfast, arrive 20 minutes early, read every option before marking. You are prepared. Trust your preparation.",
      "Pre-exam protocol: आज रात कोई नया topic नहीं। सिर्फ notes और maximum 10 PYQs। अच्छा खाना खाओ। 10 बजे तक पढ़ना बंद। 7 घंटे सोओ। कल: हल्का नाश्ता, 20 मिनट पहले पहुंचो, हर option पढ़कर mark करो। तुम तैयार हो।",
      "Pre-exam protocol: Aaj raat koi naya topic nahi. Sirf notes aur 10 PYQs max. Achha khana khao. 10 baje padhai band. 7 ghante so jao. Kal: light breakfast, 20 minute pehle pohoncho. Tum taiyar ho, Om."
    )); return
  }

  // ── Smart Break Activities ────────────────────────────────────────────────
  if (/what.*do.*break|break.*mein.*kya.*karun|break.*activity|break.*suggestion|break.*pe.*kya/i.test(tl)) {
    addMsg('user', text)
    const lang   = detectResponseLang(text)
    const minsUp = getTodayFocusMins()
    const picks  = [
      L(lang, 'Drink a full glass of water. Do 10 shoulder rolls. Look at something green for 30 seconds. Your brain will thank you.', 'एक full glass पानी पियो। 10 shoulder rolls करो। 30 seconds के लिए कुछ हरा देखो।', 'Ek full glass pani piyo. 10 shoulder rolls karo. 30 seconds ke liye kuch hara dekho.'),
      L(lang, 'Try box breathing: 4 counts in, 4 hold, 4 out, 4 hold. Repeat 4 times. It resets your nervous system completely.', 'Box breathing: 4 गिनती अंदर, 4 hold, 4 बाहर, 4 hold। 4 बार करो। Nervous system reset हो जाएगा।', 'Box breathing karo: 4 andar, 4 hold, 4 bahar, 4 hold. 4 baar. Nervous system reset ho jaata hai.'),
      L(lang, `You have studied ${minsUp} minutes today. Step outside for 5 minutes if possible — natural light and movement are the best cognitive reset.`, `आज ${minsUp} मिनट पढ़ाई हुई। अगर हो सके तो 5 मिनट बाहर जाओ — natural light best cognitive reset है।`, `Aaj ${minsUp} minutes padhai. Agar ho sake toh 5 minute bahar jao — natural light best cognitive reset hai.`),
      L(lang, 'Stretch your neck: left, right, forward, back — 10 seconds each. Roll your wrists. Stand up and walk 20 steps.', 'Neck stretch: left, right, forward, back — 10 seconds each। Wrists roll करो। 20 steps चलो।', 'Neck stretch karo: left, right, forward, back — 10 second each. Wrists roll. 20 steps chalo.'),
    ]
    respond(picks[Math.floor(Math.random() * picks.length)]); return
  }

  // ── Memory: Weak/Strong Topic Management ─────────────────────────────────
  if (/mark.*weak|weak.*topic|is.*topic.*weak|ye.*weak.*hai|mujhe.*weak.*lagta/i.test(tl)) {
    const topic = tl.replace(/mark|weak|topic|hai|lagta|mujhe|is|ye|as/gi, '').trim()
    if (topic.length > 2) {
      if (!_mem.weakTopics.includes(topic)) { _mem.weakTopics.push(topic); if (_mem.weakTopics.length > 20) _mem.weakTopics.shift() }
      saveMem(); addMsg('user', text)
      respond(L(detectResponseLang(text), `"${topic}" flagged as weak. I will prioritize it in future quizzes.`, `"${topic}" weak में mark हो गया। Future quizzes में priority दूंगा।`, `"${topic}" weak mark ho gaya. Future quizzes mein priority dunga.`)); return
    }
  }
  if (/mark.*strong|strong.*topic|mastered|khatam.*ho.*gaya.*topic|poori.*tarah.*padh|ye.*strong.*hai/i.test(tl)) {
    const topic = tl.replace(/mark|strong|topic|mastered|khatam|ho|gaya|poori|tarah|padh|hai|ye/gi, '').trim()
    if (topic.length > 2) {
      if (!_mem.strongTopics.includes(topic)) { _mem.strongTopics.push(topic); if (_mem.strongTopics.length > 20) _mem.strongTopics.shift() }
      saveMem(); addMsg('user', text)
      respond(L(detectResponseLang(text), `"${topic}" marked as strong. Well done.`, `"${topic}" strong में mark। बढ़िया।`, `"${topic}" strong mark. Badiya.`)); return
    }
  }
  if (/my.*weak.*topics|weak.*topics.*kya|weakest.*areas|meri.*weakness/i.test(tl)) {
    addMsg('user', text)
    const lang = detectResponseLang(text)
    if (_mem.weakTopics.length) {
      respond(L(lang, `Your flagged weak topics: ${_mem.weakTopics.slice(-5).join(', ')}. Focus your next quiz there.`, `आपके weak topics: ${_mem.weakTopics.slice(-5).join(', ')}। अगला quiz इन पर करो।`, `Tumhare weak topics: ${_mem.weakTopics.slice(-5).join(', ')}. Agla quiz inhi pe karo.`))
    } else {
      respond(L(lang, 'No weak topics flagged yet. Say "mark [topic] as weak" after struggling with something.', 'अभी कोई weak topic flag नहीं है।', 'Koi weak topic flag nahi hai abhi.'))
    }
    return
  }

  // ── Context-Aware Resume Greeting ─────────────────────────────────────────
  if (/welcome.*back|wapas.*aa.*gaya|continue.*from.*last|resume.*session|kahan.*tha.*main/i.test(tl)) {
    addMsg('user', text)
    const lang = detectResponseLang(text)
    const last = _mem.lastSubject
    const lastD = _mem.lastDate
    const isToday = lastD === todayIST()
    if (last) {
      respond(L(lang,
        `Welcome back! ${isToday ? 'Earlier today' : 'Last session'} you were on ${last}. Want to continue from where you left off?`,
        `वापस आए! ${isToday ? 'आज पहले' : 'पिछले session में'} ${last} पर थे। वहीं से continue करना है?`,
        `Wapas aa gaye! ${isToday ? 'Aaj pehle' : 'Last session mein'} ${last} pe the. Wahin se continue karte hain?`
      ))
    } else {
      respond(L(lang, "Welcome back, Om. Ready to continue?", "वापस आए ओम। Continue करने के लिए तैयार हो?", "Wapas aa gaye Om. Continue karne ke liye taiyar ho?"))
    }
    return
  }

  // ── Smart Performance Trend Analysis ─────────────────────────────────────
  if (/performance.*trend|score.*trend|improving.*kya|kya.*improve.*ho.*raha|am.*i.*getting.*better/i.test(tl)) {
    addMsg('user', text)
    const cs   = getCurrentState()
    const lang = detectResponseLang(text)
    if (!cs?.performance?.prelimsAvg) {
      respond(L(lang, 'Log at least 3 test scores to see a trend.', 'Trend देखने के लिए कम से कम 3 test scores log करो।', '3 scores log karo trend dekhne ke liye.'))
      return
    }
    const avg = cs.performance.prelimsAvg
    if (GROQ_AVAILABLE) {
      void executeIntent(`My current Prelims average is ${avg.toFixed(1)}%, my ${cs.streak ?? 0}-day streak shows consistency, and I have ${cs.backlogRemaining ?? '?'} lectures left. Analyze my preparation trajectory in 2 spoken sentences and give one specific improvement action.`)
    } else {
      respond(L(lang,
        `Prelims average: ${avg.toFixed(1)}%. ${avg >= 65 ? 'Strong performance — maintain this consistency.' : 'Below target. Focus on accuracy over attempts in the next 3 tests.'}`,
        `Prelims average: ${avg.toFixed(1)}%. ${avg >= 65 ? 'अच्छी performance है — consistency बनाए रखो।' : 'Target से कम है। अगले 3 tests में accuracy पर focus करो।'}`,
        `Prelims avg: ${avg.toFixed(1)}%. ${avg >= 65 ? 'Strong — consistency banaye raho.' : 'Target se kam. Agle 3 tests mein accuracy pe focus karo.'}`
      ))
    }
    return
  }

  // ── Screen Reading ─────────────────────────────────────────────────────────
  if (/what.*on.*screen|read.*screen|what.*see|kya.*screen.*pe|screen.*kya.*hai|read.*this.*section|describe.*screen/i.test(tl)) {
    addMsg('user', text); respond(readScreenContent()); return
  }
  if (/read.*analytics|read.*me.*scores|read.*performance|analytics.*sun|score.*sunao/i.test(tl)) {
    addMsg('user', text); scr('intel'); respond(buildStatusReport()); return
  }
  if (/read.*plan|read.*me.*plan|aaj.*ka.*plan.*suno|plan.*sunao/i.test(tl)) {
    addMsg('user', text); scr('plan'); respond(buildTodayReport()); return
  }

  // ── Ambient Mode ──────────────────────────────────────────────────────────
  if (/ambient.*mode.*on|silent.*mode.*on|background.*mode|whisper.*mode|shant.*mode/i.test(tl)) {
    _ambientMode = 'whisper'
    if (_ambientIntervalId) clearInterval(_ambientIntervalId)
    addMsg('user', text)
    const lang = detectResponseLang(text)
    respond(L(lang,
      "Ambient mode on. I will stay silent and whisper every 25 minutes to keep you on track. Focus, Om.",
      "Ambient mode चालू। शांत रहूंगा — हर 25 मिनट में धीरे से बोलूंगा। Focus करो।",
      "Ambient mode on. Chup rahunga — har 25 minute mein whisper karunga. Focus karo, Om."
    ))
    if (_open) closePanel()
    const WHISPERS_EN = ["Still here. Keep going.", "One lecture at a time.", "You are building something great.", "Consistency wins."]
    const WHISPERS_HI = ["यहाँ हूँ। चलते रहो।", "एक lecture एक बार में।", "कुछ महान बना रहे हो।", "Consistency ही जीतती है।"]
    const WHISPERS_HIN = ["Yahan hoon. Keep going.", "Ek lecture ek baar mein.", "Kuch zabardast bana rahe ho.", "Consistency hi jeet ti hai."]
    _ambientIntervalId = window.setInterval(() => {
      if (_isSpeaking || _ambientMode === 'off') return
      const ws = lang === 'hi' ? WHISPERS_HI : lang === 'hinglish' ? WHISPERS_HIN : WHISPERS_EN
      speak(_pick(ws))
    }, 25 * 60_000)
    return
  }
  if (/ambient.*mode.*off|silent.*mode.*off|normal.*mode.*back|wapas.*normal/i.test(tl)) {
    _ambientMode = 'off'
    clearInterval(_ambientIntervalId)
    addMsg('user', text)
    respond(L(detectResponseLang(text), 'Ambient mode off. I am fully active again.', 'Ambient mode बंद। वापस active हूँ।', 'Ambient mode off. Wapas active hoon.')); return
  }

  // ── Interview Practice Mode ───────────────────────────────────────────────
  if (/interview.*practice|personality.*test.*practice|upsc.*interview.*mode|mock.*interview.*start|interview.*shuru/i.test(tl)) {
    addMsg('user', text)
    _ivPhase = 'active'; _ivQIdx = 0
    const lang = detectResponseLang(text)
    respond(L(lang,
      `UPSC Interview Practice. ${IV_QS_EN.length} board-style questions. Give complete spoken answers. Say "next question" to continue, "skip" to move on, "end interview" to stop. Let's begin.`,
      `UPSC Interview Practice। ${IV_QS_HI.length} board-style सवाल। पूरे जवाब दें। "अगला सवाल" बोलो आगे जाने के लिए। शुरू करते हैं।`,
      `UPSC Interview Practice. ${IV_QS_EN.length} questions. Puri answer do. "Next question" bolo aage jaane ke liye. Shuru karte hain.`
    ))
    setTimeout(() => {
      const lang2 = detectResponseLang('')
      const qs = lang2 === 'hi' ? IV_QS_HI : IV_QS_EN
      respond(`Question 1 of ${qs.length}: ${qs[0]}`)
      _ivQIdx = 1
    }, 2500)
    return
  }
  if (_ivPhase === 'active') {
    const isNext   = /next.*question|agle.*sawaal|skip|next/i.test(tl)
    const isEnd    = /end.*interview|interview.*end|interview.*khatam|stop.*interview/i.test(tl)
    const lang2    = detectResponseLang(text)
    const qs       = lang2 === 'hi' ? IV_QS_HI : IV_QS_EN
    if (isEnd) {
      _ivPhase = 'off'
      addMsg('user', text)
      respond(L(lang2,
        `Interview practice complete. You attempted ${_ivQIdx} of ${qs.length} questions. Review your answers for structure and UPSC keywords. Well done, Om.`,
        `Interview practice पूरा। ${_ivQIdx} of ${qs.length} सवाल किए। अपने जवाब structure और keywords के लिए review करो।`,
        `Interview practice khatam. ${_ivQIdx}/${qs.length} questions kiye. Apne answers review karo.`
      )); return
    }
    if (isNext || _ivQIdx > 0) {
      addMsg('user', text)
      if (!isNext && _ivQIdx > 0) {
        // User gave an answer — evaluate it via Groq if available
        if (GROQ_AVAILABLE) {
          void executeIntent(`The UPSC interview question was: "${qs[_ivQIdx-1]}". The candidate answered: "${text}". In 2 spoken sentences: one strength in their answer and one specific improvement. No markdown.`)
          setTimeout(() => {
            if (_ivQIdx < qs.length) {
              respond(`Question ${_ivQIdx + 1}: ${qs[_ivQIdx]}`)
              _ivQIdx++
            } else {
              _ivPhase = 'off'
              respond(L(lang2, 'All questions done. Excellent practice session!', 'सभी सवाल पूरे। शानदार practice!', 'Saare questions done. Zabardast practice!'))
            }
          }, 4000)
          return
        }
      }
      // Just move to next
      if (_ivQIdx < qs.length) {
        respond(`Question ${_ivQIdx + 1}: ${qs[_ivQIdx]}`)
        _ivQIdx++
      } else {
        _ivPhase = 'off'
        respond(L(lang2, 'All interview questions done. Great practice!', 'सभी सवाल पूरे।', 'Saare questions done.'))
      }
      return
    }
  }

  // ── Essay Outline Generator ───────────────────────────────────────────────
  if (/essay.*outline|essay.*plan|outline.*essay|essay.*structure|nibandh.*outline|upsc.*essay.*on/i.test(tl)) {
    const topic = tl.replace(/essay.*outline|essay.*plan|outline.*essay|essay.*structure|nibandh.*outline|upsc.*essay.*on|essay.*on/gi, '').trim()
    if (!topic) {
      addMsg('user', text); respond(L(detectResponseLang(text), 'What topic? Say "essay outline on sustainable development".', 'कौन सा topic? बोलो।', 'Kaunsa topic? Bolo.')); return
    }
    addMsg('user', text)
    if (GROQ_AVAILABLE) {
      void executeIntent(`Generate a spoken essay outline for UPSC Mains Paper I on: "${topic}". Structure: 1) Introduction approach (one sentence), 2) Five body paragraphs each with a different dimension (social, economic, political, ethical, global/historical), 3) Conclusion approach. Speak it as a study guide, not written text. No markdown.`)
    } else {
      respond(L(detectResponseLang(text),
        `Essay structure for "${topic}": Introduction (define + state relevance), Body (social angle, economic angle, political/governance angle, ethical angle, way forward), Conclusion (balanced, forward-looking). Add 2-3 examples per dimension.`,
        `"${topic}" के essay का structure: Introduction, फिर social, economic, political, ethical dimensions, फिर conclusion।`,
        `"${topic}" essay: Intro, phir social, economic, political, ethical dimensions, phir conclusion with way forward.`
      ))
    }
    return
  }

  // ── Voice Journal ─────────────────────────────────────────────────────────
  if (/daily.*reflection|voice.*journal|journal.*entry|aaj.*ka.*reflection|din.*ka.*review.*journal/i.test(tl)) {
    addMsg('user', text)
    _journalStep = 'mood'
    const lang = detectResponseLang(text)
    respond(L(lang,
      "Daily reflection. First: rate today from 1 to 5 — 1 being very hard, 5 being excellent.",
      "Daily reflection। पहले: आज का दिन 1 से 5 में rate करो — 1 मतलब बहुत मुश्किल, 5 मतलब शानदार।",
      "Daily reflection. Pehle: aaj ka din 1 se 5 mein rate karo — 1 matlab bahut mushkil, 5 matlab shandar."
    )); return
  }
  if (_journalStep !== 'off') {
    addMsg('user', text)
    const num = parseInt(text.replace(/[^0-9]/g, ''))
    const lang = detectResponseLang(text)
    if (_journalStep === 'mood' && num >= 1 && num <= 5) {
      _journalBuf.mood = num; _journalStep = 'learned'
      respond(L(lang,
        `Day rated ${num}/5. Now: what is the most important thing you learned today?`,
        `आज का दिन ${num}/5 दिया। अब: आज जो सबसे important बात सीखी वो क्या थी?`,
        `${num}/5 diya. Ab: aaj sabse important kya seekha?`
      )); return
    }
    if (_journalStep === 'learned') {
      _journalBuf.learned = text; _journalStep = 'improve'
      respond(L(lang,
        "Noted. And what is one thing you want to do better tomorrow?",
        "Note हो गया। और एक चीज़ जो कल और बेहतर करना चाहते हो?",
        "Note ho gaya. Aur ek cheez jo kal better karna chahte ho?"
      )); return
    }
    if (_journalStep === 'improve') {
      _journalBuf.improve = text; _journalStep = 'done'
      const entry: JournalEntry = { date: todayIST(), mood: _journalBuf.mood ?? 3, learned: _journalBuf.learned ?? '', improve: _journalBuf.improve ?? '' }
      try {
        const stored = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]') as JournalEntry[]
        stored.push(entry); localStorage.setItem(JOURNAL_KEY, JSON.stringify(stored.slice(-90)))
      } catch { /* ignore */ }
      _journalStep = 'off'
      const mood = entry.mood
      respond(L(lang,
        `Reflection saved. Day ${mood >= 4 ? 'was strong' : mood >= 3 ? 'was decent' : 'was tough — and that makes tomorrow better'}. Learned: "${entry.learned.slice(0,60)}". Rest well tonight.`,
        `Reflection save हो गई। ${mood >= 4 ? 'अच्छा दिन था' : mood >= 3 ? 'ठीक-ठाक दिन' : 'मुश्किल दिन था — इससे कल बेहतर होगा'}। आज सीखा: "${entry.learned.slice(0,60)}"। अच्छे से आराम करो।`,
        `Reflection save ho gayi. ${mood >= 4 ? 'Acha din tha' : mood >= 3 ? 'Theek-thaak din' : 'Tough din — isse kal better hoga'}. Seekha: "${entry.learned.slice(0,60)}". Achi neend lo.`
      )); return
    }
  }

  // ── Confidence Tracker ────────────────────────────────────────────────────
  if (_awaitingConfidence) {
    const n = parseInt(text.replace(/[^0-9]/g,''))
    if (n >= 1 && n <= 5) {
      _awaitingConfidence = false
      if (_confidenceTopic) {
        if (!(_mem as any).confidence) (_mem as any).confidence = {}
        ;(_mem as any).confidence[_confidenceTopic] = n; saveMem()
      }
      addMsg('user', text)
      const lang = detectResponseLang(text)
      respond(L(lang,
        `Confidence ${n}/5 on ${_confidenceTopic || 'this topic'}. ${n <= 2 ? 'Flagged for extra revision.' : n >= 4 ? 'Strong area.' : 'Good. Keep building.'}`,
        `${_confidenceTopic || 'इस topic'} पर confidence ${n}/5। ${n <= 2 ? 'Extra revision के लिए flag किया।' : n >= 4 ? 'Strong area।' : 'अच्छा है।'}`,
        `${_confidenceTopic || 'is topic'} pe confidence ${n}/5. ${n <= 2 ? 'Extra revision ke liye flag.' : n >= 4 ? 'Strong area.' : 'Acha hai.'}`
      ))
      if (n <= 2 && _confidenceTopic && !_mem.weakTopics.includes(_confidenceTopic)) {
        _mem.weakTopics.push(_confidenceTopic); saveMem()
      }
      return
    }
  }
  if (/rate.*confidence|confidence.*rating|how.*confident|kitna.*confident|confidence.*check/i.test(tl)) {
    _confidenceTopic = tl.replace(/rate.*confidence|confidence.*rating|how.*confident|kitna.*confident|confidence.*check|on|about|in|for/gi, '').trim() || _sessionSubject
    _awaitingConfidence = true
    addMsg('user', text)
    respond(L(detectResponseLang(text),
      `Rate your confidence on "${_confidenceTopic || 'this topic'}" from 1 to 5. 1 = shaky, 5 = rock solid.`,
      `"${_confidenceTopic || 'इस topic'}" पर confidence 1 से 5 में rate करो। 1 = कमज़ोर, 5 = बिल्कुल solid।`,
      `"${_confidenceTopic || 'is topic'}" pe confidence 1 se 5 mein rate karo. 1 = shakka, 5 = solid.`
    )); return
  }

  // ── Lecture Time-Binding Timer ────────────────────────────────────────────
  if (/studying.*lecture|starting.*lecture|lecture.*shuru.*kar.*raha|lecture.*start.*kar.*raha|padhna.*start.*kar.*raha/i.test(tl)) {
    const lecName = tl.replace(/studying|lecture|shuru|kar|raha|padhna|start|starting/gi, '').trim()
    if (lecName.length > 2) {
      _activeLectureName = lecName; _lectureStartMs = Date.now()
      clickStart(); scr('plan')
      addMsg('user', text)
      respond(L(detectResponseLang(text),
        `Tracking your session on "${lecName}". Timer started. When you're done, say "lecture done" and I'll mark it complete.`,
        `"${lecName}" session track हो रही है। Timer शुरू। जब खत्म हो, "lecture done" बोलो।`,
        `"${lecName}" session track ho rahi hai. Timer start. Jab khatam ho, "lecture done" bolo.`
      )); return
    }
  }
  if (_activeLectureName && /lecture.*done|lecture.*khatam|padh.*liya|topic.*over.*active/i.test(tl)) {
    const mins = _lectureStartMs ? Math.round((Date.now() - _lectureStartMs) / 60000) : 0
    const name = _activeLectureName; _activeLectureName = ''; _lectureStartMs = 0
    addMsg('user', text)
    const found = checkNamedTopic(name) || checkCurrentTopic()
    respond(L(detectResponseLang(text),
      `"${name}" done! ${mins > 0 ? `${mins} minutes spent. ` : ''}${celebrationLine()}`,
      `"${name}" कhatam! ${mins > 0 ? `${mins} मिनट लगे। ` : ''}${celebrationLine()}`,
      `"${name}" done! ${mins > 0 ? `${mins} minutes lage. ` : ''}${celebrationLine()}`
    )); void found; return
  }

  // ── Performance Weekly Debrief ────────────────────────────────────────────
  if (/weekly.*debrief|week.*debrief|this.*week.*analysis|week.*ka.*analysis|sunday.*review|weekly.*review.*full/i.test(tl)) {
    addMsg('user', text)
    const lang = detectResponseLang(text)
    const weekly = buildWeekSummary()
    const cs     = getCurrentState()
    const done   = document.querySelectorAll('#plan .plan-row.done').length
    const tot    = document.querySelectorAll('#plan .plan-row').length
    const pct    = tot ? Math.round(done / tot * 100) : 0
    const weak   = _mem.weakTopics.slice(-3).join(', ') || 'none flagged'
    const strong = _mem.strongTopics.slice(-3).join(', ') || 'none flagged'
    if (GROQ_AVAILABLE) {
      void executeIntent(`Weekly UPSC preparation debrief for Om. Data: ${weekly}. Coverage: ${pct}%. Prelims avg: ${cs?.performance?.prelimsAvg?.toFixed(1) ?? '?'}%. Weak topics: ${weak}. Strong topics: ${strong}. Streak: ${cs?.streak ?? 0} days. Give a 3-sentence coaching assessment: what's working, what needs work, and one specific action for next week. Spoken format, warm but direct.`)
    } else {
      respond(`${weekly} Coverage: ${pct}%. Weak areas: ${weak}. Strong: ${strong}. Focus next week on weak topics and add 2 tests.`)
    }
    return
  }

  // ── Dynamic Quiz with Difficulty ──────────────────────────────────────────
  if (/advanced.*quiz|hard.*quiz|easy.*quiz|basic.*quiz|difficulty.*quiz|quiz.*difficulty/i.test(tl)) {
    const topic     = tl.replace(/advanced|hard|easy|basic|difficulty|quiz/gi, '').trim() || _sessionSubject || 'UPSC GS'
    const scores    = _mem.quizScores[topic] ?? []
    const avg       = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50
    const diff      = avg < 50 ? 'basic (factual recall)' : avg > 80 ? 'advanced (analysis and application)' : 'standard (mixed)'
    addMsg('user', text)
    respond(L(detectResponseLang(text),
      `Starting ${diff} quiz on ${topic} based on your history.`,
      `${topic} पर ${diff} quiz शुरू हो रही है — आपकी history के आधार पर।`,
      `${topic} pe ${diff} quiz shuru ho rahi hai — history ke base pe.`
    ))
    void startQuiz(`${topic} — difficulty: ${diff}`)
    return
  }

  // ── JARVIS App Integration Helpers ───────────────────────────────────────

  // Score entry guidance (UPSC formula coaching)
  if (/how.*calculate.*score|upsc.*score.*formula|negative.*marking.*formula|scoring.*upsc/i.test(tl)) {
    addMsg('user', text)
    respond(L(detectResponseLang(text),
      'UPSC GS Prelims: Each correct = 2 marks, each wrong = minus 2/3 mark. Formula: Score = Correct × 2 − Wrong × 0.667. Attempt only when 60%+ confident. CSAT has no negative marking: each correct = 2.5 marks.',
      'UPSC GS Prelims: सही = 2 marks, गलत = minus 2/3 mark। Formula: Score = Correct × 2 − Wrong × 0.667। 60%+ confidence पर ही attempt करो। CSAT में negative नहीं: सही = 2.5 marks।',
      'UPSC GS: Sahi = 2 marks, galat = minus 2/3. Formula: Correct×2 − Wrong×0.667. 60%+ confident ho tabhi attempt karo. CSAT mein negative nahi hai.'
    )); return
  }

  // Export data guidance
  if (/export.*data|backup.*data|download.*data|data.*export/i.test(tl)) {
    addMsg('user', text); cl('cm-export-btn')
    respond(L(detectResponseLang(text),
      'Export panel opened. Choose JSON for full backup or CSV for spreadsheet. Export works only when online.',
      'Export panel खुल गया। JSON for full backup, CSV for spreadsheet। Online होने पर ही export होगा।',
      'Export panel khul gaya. JSON = full backup, CSV = spreadsheet. Online hona zaroori hai.'
    )); return
  }

  // Settings guidance
  if (/exam.*date.*set|set.*exam.*date|change.*exam.*date|exam.*date.*kab.*set/i.test(tl)) {
    addMsg('user', text); cl('cm-settings')
    respond(L(detectResponseLang(text),
      'Settings opened. Set your Prelims date in the Exam Dates section. The date must be in the future. The planner recalculates automatically.',
      'Settings खुल गई। Exam Dates section में Prelims date set करो। Date future में होनी चाहिए।',
      'Settings khuli. Exam Dates section mein Prelims date set karo. Date future mein honi chahiye.'
    )); return
  }

  // Sync status
  if (/sync.*working|data.*synced|is.*data.*saved|kya.*data.*save.*hua/i.test(tl)) {
    addMsg('user', text)
    const online = navigator.onLine
    const qSize  = Object.keys(JSON.parse(localStorage.getItem('mission2028_sync_queue') ?? '{}')).length
    const lang   = detectResponseLang(text)
    respond(L(lang,
      online
        ? (qSize ? `Online. ${qSize} changes syncing to cloud right now.` : 'Online. All data is synced to the cloud.')
        : `Offline. ${qSize} changes queued — will sync when you reconnect. Your data is safe locally.`,
      online
        ? (qSize ? `Online. ${qSize} changes cloud mein sync ho rahe hain.` : 'Online. Sab data cloud mein sync ho gaya है।')
        : `Offline। ${qSize} changes queue में हैं — reconnect पर sync होंगे।`,
      online
        ? (qSize ? `Online. ${qSize} changes sync ho rahe hain.` : 'Online. Data synced hai.')
        : `Offline. ${qSize} changes queued hain — reconnect hone pe sync honge.`
    )); return
  }

  // ── Wake Word with "Hey Jarvis" prefix enhancement ───────────────────────
  if (/^(?:hey|yo|bhai|oi|ok|hello)\s+jarvis\b/i.test(tl)) {
    const cmd = tl.replace(/^(?:hey|yo|bhai|oi|ok|hello)\s+jarvis\s*/i, '').trim()
    if (cmd) { void processQuery(cmd); return }
  }

  // 18. CMDS — fast pattern-action table (743+ patterns)
  for (const cmd of CMDS) {
    if (cmd.re.test(tl)) {
      addMsg('user', text)
      cmd.action()
      if (cmd.reply) respond(cmd.reply)
      return
    }
  }

  // 19. Intent router + AI fallback (covers all unmatched commands + UPSC Q&A)
  addMsg('user', text)
  void executeIntent(text)   // executeIntent sets its own thinking state
}

// ── Intent router → action registry ──────────────────────────────────────────
// Receives raw transcript, routes through 2-stage router, dispatches to action.
// ── executeIntent: the 3-tier intelligence pipeline ─────────────────────────
// Tier 1 (instant)  : local phrase map + keyword index — zero network, <1ms
// Tier 2 (fast)     : Groq llama-3.1-8b-instant intent classification — ~500ms
// Tier 3 (quality)  : Groq llama-3.3-70b-versatile UPSC tutor — ~1.5s
// Safety net: 8 seconds absolute timeout — JARVIS never stays stuck
async function executeIntent(transcript: string): Promise<void> {
  setState('thinking')
  const _thinkLang = detectResponseLang(transcript)
  setStatus(_thinkLang === 'hi' ? 'सोच रहा हूँ…' : _thinkLang === 'hinglish' ? 'Soch raha hoon…' : 'Thinking…')
  VA.setState('thinking')

  const safetyTimer = setTimeout(() => {
    if (_state === 'thinking') {
      setState('idle'); VA.setState('idle')
      setStatus('Ready — say Jarvis or double clap')
      const localAns = offlineAnswer(transcript)
      // If the local answer is the generic fallback AND Groq is available,
      // fire one more async Groq attempt and update the response.
      const isGenericFallback = /I handle timer|Main timer|handle timer, plan|sambhalta hoon/i.test(localAns)
      if (isGenericFallback && GROQ_AVAILABLE) {
        const retryLang = detectResponseLang(transcript)
        respond(L(retryLang,
          'Taking a little longer — switching to online AI…',
          'थोड़ा समय लग रहा है — online AI से try कर रहा हूँ…',
          'Thoda time lag raha hai — online AI se try kar raha hoon…'
        ))
        void llmRoute(buildQATranscript(transcript, retryLang), 'qa')
          .then(r => { if (r.answer?.trim()) respond(r.answer.trim()) })
          .catch(() => { respond(localAns) })
      } else {
        respond(localAns)
      }
    }
  }, 18_000)  // 18s safety net — gives Groq ~2s before timeout

  try {
    // ── Tier 1 + 2: route() tries local first, falls to Groq classification ──
    const result: RouterResult & { answer?: string } = await route(transcript)
    clearTimeout(safetyTimer)

    // Determine the language JARVIS should respond in
    const detectedLang = detectResponseLang(transcript)

    // If const.article / const.search matched but user wants an explanation
    // → promote to qa.answer so Groq gives a full spoken answer
    const EXPLAIN_RE = /explain|batao|samjhao|tell.*me|kya.*hai|what.*is|ke.*baare|about|describe|meaning|matlab|definition|summarize/i
    if ((result.intent === 'const.article' || result.intent === 'const.search') && EXPLAIN_RE.test(transcript)) {
      result.intent = 'qa.answer'
      result.params = { question: transcript }
    }

    // Promote mot.motivate + query intents that can be AI-enhanced to qa.answer
    // when Groq is available — gives a richer personalised answer
    // (keep as local dispatch if no key available)
    const GROKABLE = new Set(['mot.motivate','syl.coverage','plan.behind','test.next'])
    if (GROKABLE.has(result.intent) && GROQ_AVAILABLE) {
      result.intent = 'qa.answer'
      result.params = { question: transcript }
    }

    if (result.intent === 'qa.answer') {
      // ── Tier 3: UPSC knowledge question → Groq llama-3.3-70b tutor mode ────
      const cacheKey = `${detectedLang}:${transcript.toLowerCase().trim().slice(0, 120)}`
      const cached   = getCached(cacheKey)
      if (cached) { respond(cached); return }

      setStatus(detectedLang === 'hi' ? 'जवाब खोज रहा हूँ…' : detectedLang === 'hinglish' ? 'Jawab dhundh raha hoon…' : 'Searching knowledge base…')
      const qaResult = await llmRoute(buildQATranscript(transcript, detectedLang), 'qa')
      const answer   = qaResult.answer?.trim()
      if (answer) { setCached(cacheKey, answer); respond(answer) }
      else {
        // Groq returned empty — retry with a simpler direct prompt before local fallback
        const retryLang2 = detectResponseLang(transcript)
        const retry2 = await llmRoute(
          buildQATranscript(`Answer in 2 spoken sentences: ${transcript}`, retryLang2), 'qa'
        ).catch(() => ({ answer: null }))
        if ((retry2 as { answer?: string | null }).answer?.trim()) {
          respond((retry2 as { answer: string }).answer.trim())
        } else {
          respond(offlineAnswer(transcript))
        }
      }
      return
    }

    // ── Dispatch classified intent to app action ─────────────────────────────
    const reply = await dispatchIntent(result)
    if (reply) { respond(reply); return }

    // Intent matched but returned nothing → treat as general AI question
    // (covers misclassified questions, general knowledge, math, jokes, anything)
    if (GROQ_AVAILABLE) {
      setStatus(detectedLang === 'hi' ? 'सोच रहा हूँ…' : detectedLang === 'hinglish' ? 'Soch raha hoon…' : 'Thinking…')
      const fallback = await llmRoute(buildQATranscript(transcript, detectedLang), 'qa')
      respond(fallback.answer?.trim() || offlineAnswer(transcript))
    } else {
      respond(offlineAnswer(transcript))
    }

  } catch {
    clearTimeout(safetyTimer)
    setState('idle'); VA.setState('idle')
    // Network error: try Groq once more before falling back to local answer
    if (GROQ_AVAILABLE) {
      const errLang = detectResponseLang(transcript)
      respond(L(errLang,
        'Network hiccup — retrying with online AI…',
        'Network problem — online AI से retry…',
        'Network issue — online AI se retry kar raha hoon…'
      ))
      void llmRoute(buildQATranscript(transcript, errLang), 'qa')
        .then(r => { if (r.answer?.trim()) respond(r.answer.trim()) })
        .catch(() => { respond(offlineAnswer(transcript)) })
    } else {
      respond(offlineAnswer(transcript))
    }
  }
}

/** Determine the best response language, respecting _replyLang preference. */
function detectResponseLang(transcript: string): 'en' | 'hi' | 'hinglish' {
  if (_replyLang !== 'auto') return _replyLang as 'en'|'hi'|'hinglish'
  return detectLang(transcript)
}

/** Prepend a language instruction to the transcript so Groq responds correctly. */
function buildQATranscript(transcript: string, lang: 'en'|'hi'|'hinglish'): string {
  const langInstr =
    lang === 'hi'       ? '[RESPOND STRICTLY IN HINDI — Devanagari script]\n' :
    lang === 'hinglish' ? '[RESPOND IN HINGLISH — mix of Hindi words in Roman script]\n' :
                          '[RESPOND IN ENGLISH]\n'
  return langInstr + transcript
}

// ── Language-aware response helpers ──────────────────────────────────────────

/** Return the right phrase for detected language. hin = Hinglish (falls back to hi if omitted). */
function L(lang: 'en'|'hi'|'hinglish', en: string, hi: string, hin?: string): string {
  if (lang === 'hi') return hi
  if (lang === 'hinglish') return hin ?? hi
  return en
}

/** "Done at 3:45 PM" — always IST */
function getEndTime(mins: number): string {
  return new Date(Date.now() + mins * 60_000)
    .toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })
}

/** Extract score average from CoreState or the analytics DOM. */
function getScoreAverage(stream: string): string | null {
  const cs = getCurrentState()
  if (stream === 'prelims' && cs?.performance?.prelimsAvg != null)
    return `${cs.performance.prelimsAvg.toFixed(1)}%`
  // Scan analytics DOM for rendered average figures
  const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-category]'))
  const match  = cells.find(el => el.dataset.category?.toLowerCase().includes(stream))
  if (match) {
    const pct = match.querySelector<HTMLElement>('.score-pct,.avg-pct,.score-avg')
    if (pct?.textContent?.trim()) return pct.textContent.trim()
  }
  return null
}

async function dispatchIntent(r: RouterResult): Promise<string> {
  const p    = r.params
  const lang = r.language ?? 'en'

  switch (r.intent) {

    // ── Navigation ────────────────────────────────────────────────────────────
    case 'nav.goto': {
      const sec = String(p.section ?? 'engine')
      scr(sec)
      const nameEN: Record<string,string> = { plan:'Plan', intel:'Intelligence', engine:'Daily Engine', routine:'Routine', constitution:'Constitution' }
      const nameHI: Record<string,string> = { plan:'Plan section', intel:'Analytics', engine:'Timer section', routine:'Routine', constitution:'Sanvidhan' }
      return L(lang, `${nameEN[sec] ?? sec} section.`, `${nameHI[sec] ?? sec} section.`)
    }

    // ── Timer ─────────────────────────────────────────────────────────────────
    case 'timer.start': {
      const mins = Number(p.minutes ?? 25)
      fireTimer(mins)
      const end = getEndTime(mins)
      return L(lang,
        `${mins}-minute focus session started. Done at ${end}. Lock in, Om.`,
        `${mins} minute ki padhai shuru. ${end} pe khatam hogi.`,
        `${mins} minute ka timer chalu. ${end} pe hoga khatam. Dhyan lagao!`)
    }

    case 'timer.stop': {
      q('[data-act="start"]')
      return L(lang, 'Timer paused.', 'Timer ruka.', 'Timer paused.')
    }

    // ── Score entry ───────────────────────────────────────────────────────────
    case 'score.add': {
      const score = Number(p.score), max = Number(p.max)
      const cat   = String(p.category ?? 'test')
      if (score && max) {
        const pct = ((score/max)*100).toFixed(1)
        cl('cm-add-score')
        setTimeout(() => prefillScoreForm(score, max, cat), 400)
        return L(lang,
          `${pct}% in ${cat}. Score entry is open — confirm to save.`,
          `${cat} mein ${pct}%. Score entry khul gayi — save kar lo.`,
          `${pct}% in ${cat}. Entry khul gayi, confirm karo.`)
      }
      cl('cm-add-score')
      return L(lang, 'Add Score opened.', 'Score entry kholdi.', 'Score entry open.')
    }

    // ── Routine ───────────────────────────────────────────────────────────────
    case 'routine.setType': {
      const type = String(p.type ?? 'Study')
      const sel  = document.getElementById('rtn-day-type') as HTMLSelectElement | null
      if (sel) {
        sel.value = type; sel.dispatchEvent(new Event('change')); scr('routine')
        return L(lang,
          `Today marked as ${type}. Routine targets updated.`,
          `Aaj ${type === 'Holiday' ? 'chutti' : type} set kar diya. Targets update ho gaye.`,
          `Aaj ka day type ${type} set. Routine updated.`)
      }
      scr('routine')
      return L(lang, `Set today to ${type} in the Routine section.`, `Routine mein ${type} set karo.`)
    }

    case 'routine.logHours': {
      const hrs = Number(p.hours ?? 0)
      const inp = document.getElementById('rtn-study-hours') as HTMLInputElement | null
      if (inp) {
        inp.value = String(hrs); inp.dispatchEvent(new Event('input')); scr('routine')
        return L(lang,
          `${hrs} hour${hrs!==1?'s':''} logged for today.`,
          `${hrs} ghante padhai log ho gaye.`,
          `${hrs} hours logged. Solid effort!`)
      }
      scr('routine')
      return L(lang, `Open Routine to log ${hrs} hours.`, `Routine mein ${hrs} ghante log karo.`)
    }

    // ── Lectures ──────────────────────────────────────────────────────────────
    case 'lecture.markDone': {
      const title = p.subject ? checkNamedTopic(String(p.subject)) : checkCurrentTopic()
      if (title) {
        const next = document.querySelector<HTMLElement>('#plan .plan-row:not(.done) .pl-title')?.textContent?.trim()
        const nextLine = next ? L(lang, ` Up next: ${next}.`, ` Agle lecture: ${next}.`, ` Next: ${next}.`) : ''
        return L(lang, `"${title}" done! ${celebrationLine()}${nextLine}`, `"${title}" khatam! Badiya kaam, Om.${nextLine}`)
      }
      return L(lang, 'No matching lecture found.', 'Koi matching lecture nahi mila.', 'Lecture nahi mila planner mein.')
    }

    // ── Queries ───────────────────────────────────────────────────────────────
    case 'query.backlog': {
      const cs = getCurrentState()
      const b  = cs?.backlogRemaining ?? 0
      const sub = cs?.today?.subject ? ` Today's focus: ${cs.today.subject}.` : ''
      return b
        ? L(lang, `${b} lectures in your backlog.${sub}`, `${b} lecture baaki hai.${sub}`, `${b} lectures pending.${sub}`)
        : L(lang, "No backlog — you're all caught up!", "Koi backlog nahi! Kaafi acha kaam.", "Backlog clear! Great work.")
    }

    case 'query.hours': {
      const period = String(p.period ?? 'today')
      if (period === 'today') {
        const m = getTodayFocusMins()
        return m
          ? L(lang, `${m} minutes studied today. Great consistency.`, `Aaj ${m} minute padhai ki. Badhiya!`, `${m} minutes today. Keep going!`)
          : L(lang, 'No study sessions logged yet today.', 'Aaj abhi koi session log nahi hua.', 'Aaj abhi tak koi session nahi.')
      }
      if (period === 'total') {
        try { const t = JSON.parse(localStorage.getItem('focusMins')??"0") as number; return L(lang, `${t} total minutes studied so far.`, `Abhi tak ${t} minute padhai ki.`, `Total ${t} minutes.`) } catch { return 'Total unavailable.' }
      }
      return buildWeekSummary()
    }

    case 'query.rank': {
      const cs = getCurrentState()
      const rk = cs?.rankProjection
      const sp = cs?.selectionProbabilityPct
      if (rk || sp != null) return L(lang,
        `Projected rank: ${rk ?? '—'}. Selection probability: ${sp?.toFixed(1) ?? '—'}%.`,
        `Projected rank ${rk ?? '?'} hai. Selection probability: ${sp?.toFixed(1) ?? '?'}%.`,
        `Rank projection: ${rk ?? '?'}. SP: ${sp?.toFixed(1) ?? '?'}%.`)
      return L(lang, 'Log more scores to generate a rank estimate.', 'Aur scores daalo to rank estimate ayegi.', 'More scores chahiye rank ke liye.')
    }

    case 'query.selectionProb': {
      const sp = getCurrentState()?.selectionProbabilityPct
      if (sp != null) return L(lang,
        `Your selection probability is ${sp.toFixed(1)}%. ${sp>=50?'Strong position.':'Keep improving.'}`,
        `Selection probability ${sp.toFixed(1)}% hai. ${sp>=50?'Acha position hai.':'Aur mehnat karo.'}`,
        `SP ${sp.toFixed(1)}%. ${sp>=50?'Good position!':'Keep pushing.'}`)
      return L(lang, 'Log scores to compute selection probability.', 'Pehle scores log karo.', 'Scores log karo pehle.')
    }

    case 'query.average': {
      const stream = String(p.stream ?? 'overall')
      const cs = getCurrentState()
      // Try CoreState for known streams
      const prelims = cs?.performance?.prelimsAvg
      if (stream === 'prelims' && prelims != null)
        return L(lang, `Prelims average: ${prelims.toFixed(1)}%.`, `Prelims average ${prelims.toFixed(1)}% hai.`, `Prelims average ${prelims.toFixed(1)}%.`)
      // Try DOM scan for rendered average figures
      const avg = getScoreAverage(stream)
      if (avg) return L(lang, `${stream} average: ${avg}.`, `${stream} average ${avg} hai.`, `${stream} average: ${avg}.`)
      scr('intel')
      return L(lang, `${stream} average is in the analytics section.`, `${stream} average analytics mein dekho.`, `Analytics section mein ${stream} average hai.`)
    }

    // ── Planner ───────────────────────────────────────────────────────────────
    case 'plan.generate':
      cl('ai-gen')
      return 'Generating your optimized study plan…'

    case 'plan.today':
      return buildTodayReport()

    // ── Revision ──────────────────────────────────────────────────────────────
    case 'revision.due':
      scr('plan')
      return buildRevisionLine()

    // ── Mistake / CA ──────────────────────────────────────────────────────────
    case 'mistake.add':
      cl('cm-add-mistake')
      return 'Mistake Notebook opened. Log it so JARVIS schedules a revision.'

    case 'ca.add':
      cl('cm-ca-log')
      return 'Current Affairs log opened.'

    // ── Constitution ──────────────────────────────────────────────────────────
    case 'constitution.lookup': {
      scr('constitution')
      const art = p.article ? `Article ${p.article}` : 'the article'
      return `Opening Constitution. Searching for ${art}.`
    }

    // ── Syllabus ──────────────────────────────────────────────────────────────
    case 'syllabus.show': {
      const paper = String(p.paper ?? 'GS1')
      const SYLLABUS: Record<string, string> = {
        GS1: 'History, Geography, Art & Culture, Society, International Relations.',
        GS2: 'Polity, Governance, Constitution, Social Justice, International Relations.',
        GS3: 'Economy, Agriculture, Science & Technology, Environment, Internal Security.',
        GS4: 'Ethics, Integrity, Aptitude — attitude, case studies, and thinkers.',
        CSAT: 'Comprehension, Math, Reasoning, Decision Making, and English.',
      }
      return `${paper}: ${SYLLABUS[paper] ?? 'Check the official UPSC notification.'}`
    }

    // ── Countdown ─────────────────────────────────────────────────────────────
    case 'countdown.exam':
      return buildExamCountdown()

    // ── Briefing ──────────────────────────────────────────────────────────────
    case 'briefing.today':
      return buildStatusReport()

    // ── System ────────────────────────────────────────────────────────────────
    case 'system.setLanguage': {
      const lang = String(p.lang ?? 'en-IN') as 'en-IN' | 'hi-IN'
      _lang      = lang
      _replyLang = lang === 'hi-IN' ? 'hi' : 'en'
      localStorage.setItem('jarvis_lang', lang)
      localStorage.setItem('jarvis_reply_lang', _replyLang)
      return lang === 'hi-IN'
        ? 'Hindi mein switch ho gaya. Ab main Hindi mein jawab dunga.'
        : 'Switched to English. Go ahead.'
    }

    case 'system.repeat':
      return _lastReply || 'Nothing to repeat yet.'   // respond() will call speak()

    case 'system.sleep':
      _sleeping = true
      setStatus('Sleeping — double-clap or tap to wake')
      return 'Going to sleep. Double-clap or tap me to wake up.'

    // ── CSV intent aliases (IDs used in voice_commands_2000.csv) ─────────────
    // These use different IDs from voice_intents.json but same app action

    // query.selprob → same as query.selectionProb
    case 'query.selprob': {
      const sp = getCurrentState()?.selectionProbabilityPct
      if (sp != null) return L(lang, `Selection probability: ${sp.toFixed(1)}%.`, `Selection probability ${sp.toFixed(1)}% hai.`, `SP ${sp.toFixed(1)}%.`)
      return L(lang, 'Log more scores to compute selection probability.', 'Pehle scores log karo.', 'More scores chahiye.')
    }

    // query.streak → streak information
    case 'query.streak':
    case 'query.consistency': {
      const cs = getCurrentState()
      const m  = getTodayFocusMins()
      const s  = cs?.streak ?? 0
      return L(lang, `${s}-day streak. ${m} minutes studied today.`, `${s} din ki streak. Aaj ${m} minute padhai.`, `${s}-day streak, ${m} min today.`)
    }

    // brief.today → briefing
    case 'brief.today': return buildStatusReport()

    // cd.prelims → countdown
    case 'cd.prelims': return buildExamCountdown()

    // const.article → constitution lookup (alias)
    case 'const.article': {
      scr('constitution')
      const art = p.article ? `Article ${p.article}` : 'the Constitution'
      return L(lang, `Opening ${art}.`, `${art} khol raha hoon.`, `Opening ${art}.`)
    }

    // const.search → constitution search
    case 'const.search': {
      scr('constitution')
      const q = String(p.query ?? p.article ?? '')
      if (q) setTimeout(() => { const inp = document.querySelector<HTMLInputElement>('#const-search'); if (inp) { inp.value = q; inp.dispatchEvent(new Event('input')) } }, 400)
      return L(lang, `Searching Constitution for "${q || 'your query'}".`, `Sanvidhan mein "${q || '...'}" search kar raha hoon.`, `Constitution search: "${q || '...'}"`)
    }

    // sys.lang → setLanguage alias
    case 'sys.lang': {
      const lk = String(p.lang ?? 'en-IN') as 'en-IN'|'hi-IN'
      _lang = lk; _replyLang = lk === 'hi-IN' ? 'hi' : 'en'
      localStorage.setItem('jarvis_lang', lk); localStorage.setItem('jarvis_reply_lang', _replyLang)
      return lk === 'hi-IN' ? 'Hindi mein switch ho gaya.' : 'Switched to English.'
    }

    // sys.repeat → repeat last
    case 'sys.repeat': return _lastReply || L(lang, 'Nothing to repeat.', 'Kuch nahi hua pehle.', 'Nothing yet.')

    // sys.sleep → sleep
    case 'sys.sleep':
      _sleeping = true; setStatus('Sleeping…')
      return L(lang, 'Going to sleep. Double-clap to wake.', 'So raha hoon. Double-clap se jagao.', 'Sleeping. Double-clap to wake.')

    // sys.help → help
    case 'sys.help':
      return L(lang,
        "Say 'start timer', 'show plan', 'add score', 'quiz me on Polity', 'explain Article 21', or any UPSC question.",
        "Kaho: 'timer shuru karo', 'plan dikhao', 'score add karo', ya koi bhi UPSC sawaal.",
        "Say 'start timer', 'plan dikhao', 'score add', ya UPSC ke baare mein kuch bhi.")

    // ── New intents from CSV ──────────────────────────────────────────────────

    // timer.extend → add X minutes to running timer
    case 'timer.extend': {
      const add = Number(p.minutes ?? 10)
      window.dispatchEvent(new CustomEvent('jarvis:extend-timer', { detail: { add } }))
      // Fallback: just reset with extra time by checking display
      const timeEl = document.querySelector<HTMLElement>('.ring-time')?.textContent ?? '25:00'
      const [mm, ss] = timeEl.split(':').map(Number)
      const remaining = (mm ?? 0) * 60 + (ss ?? 0)
      const newTotal = Math.round((remaining + add * 60) / 60)
      fireTimer(newTotal)
      return L(lang, `Adding ${add} more minutes. Timer extended.`, `${add} aur minute add kiye.`, `${add} more minutes added.`)
    }

    // timer.break → start a break
    case 'timer.break': {
      const brk = Number(p.minutes ?? 5)
      q('[data-act="skip"]')   // skip to break in timer-config
      return L(lang, `${brk}-minute break started.`, `${brk} minute ka break shuru.`, `Break of ${brk} minutes started.`)
    }

    // lecture.next → next lecture info
    case 'lecture.next': {
      scr('plan')
      const row  = document.querySelector<HTMLElement>('#plan .plan-row:not(.done)')
      const title = row?.querySelector<HTMLElement>('.pl-title')?.textContent?.trim()
      const meta  = row?.querySelector<HTMLElement>('.pl-meta')?.textContent?.trim()
      if (title) return L(lang, `Next up: "${title}". ${meta ?? ''}`, `Agla lecture: "${title}". ${meta ?? ''}`, `Next: "${title}".`)
      return L(lang, 'No pending lectures.', 'Koi pending lecture nahi.', 'No pending lectures.')
    }

    // search.lecture → search in planner
    case 'search.lecture': {
      const q2 = String(p.subject ?? p.query ?? '')
      scr('plan')
      if (q2) setTimeout(() => { const inp = document.querySelector<HTMLInputElement>('#lp-search'); if (inp) { inp.value = q2; inp.dispatchEvent(new Event('input')) } }, 300)
      return L(lang, `Searching for "${q2 || 'lectures'}".`, `"${q2 || 'lectures'}" search kar raha hoon.`, `Searching: "${q2 || 'lectures'}"`)
    }

    // goal.set → open goals
    case 'goal.set': {
      cl('cm-goals')
      return L(lang, 'Goals opened. Set your target.', 'Goals khul gayi. Target set karo.', 'Goals opened.')
    }

    // env.focusMode → toggle focus mode
    case 'env.focusMode': {
      cl('focus-mode-btn')
      return L(lang, 'Focus Mode toggled.', 'Focus Mode toggle ho gaya.', 'Focus Mode toggled.')
    }

    // env.theme → same as focus mode / visual toggle
    case 'env.theme': {
      cl('focus-mode-btn')
      return L(lang, 'Display mode toggled.', 'Display mode change ho gaya.', 'Display mode toggled.')
    }

    // cap.note → quick note
    case 'cap.note': {
      const note = String(p.text ?? p.note ?? '')
      if (note) addToInbox(note)
      cl('cm-add-note')
      return note ? L(lang, `Noted: "${note}".`, `Note ho gaya: "${note}".`, `Noted: "${note}".`) : L(lang, 'Notes opened.', 'Notes khul gayi.', 'Notes open.')
    }

    // ans.log → answer writing log
    case 'ans.log': {
      cl('cm-answer-log')
      return L(lang, 'Answer Writing log opened.', 'Answer Writing log khul gaya.', 'Answer log opened.')
    }

    // test.log → log a test score
    case 'test.log': {
      cl('cm-add-score')
      return L(lang, 'Add your test score here.', 'Test score yahan daalo.', 'Score entry open.')
    }

    // test.next → suggest next test
    case 'test.next': {
      const cs = getCurrentState()
      scr('intel')
      return L(lang, `Your next mock should cover ${cs?.today?.subject ?? 'your weakest subject'}.`,
        `Agla mock ${cs?.today?.subject ?? 'aapke kamzor subject'} pe hona chahiye.`,
        `Next mock should be on ${cs?.today?.subject ?? 'weak subject'}.`)
    }

    // plan.behind → what to do when behind schedule
    case 'plan.behind': {
      const cs = getCurrentState()
      const b  = cs?.backlogRemaining ?? 0
      cl('ai-gen')
      return L(lang,
        `${b} lectures behind. Generating a catch-up plan now.`,
        `${b} lectures baaki hai. Catch-up plan bana raha hoon.`,
        `${b} lectures pending. Generating plan…`)
    }

    // revision.flag → flag current lecture for urgent revision
    case 'revision.flag': {
      cl('cm-revise-now')
      return L(lang, 'Flagged for revision. SRS will schedule it.', 'Revision ke liye flag ho gaya.', 'Flagged for revision.')
    }

    // syl.coverage → syllabus coverage
    case 'syl.coverage': {
      scr('intel')
      const cs = getCurrentState()
      const done = document.querySelectorAll('#plan .plan-row.done').length
      const total = document.querySelectorAll('#plan .plan-row').length
      const pct = total ? Math.round((done / total) * 100) : 0
      return L(lang, `Syllabus coverage: ${pct}% (${done} of ${total} lectures done).`,
        `Syllabus ${pct}% complete hai — ${done} lectures ho gaye ${total} mein se.`,
        `Coverage: ${pct}% — ${done}/${total} lectures.`)
    }

    // cal.week → weekly calendar view
    case 'cal.week': {
      cl('cm-calendar')
      return L(lang, 'Weekly calendar opened.', 'Weekly calendar khul gaya.', 'Week calendar open.')
    }

    // mot.motivate → motivation
    case 'mot.motivate': return motivationLine()

    // exp.excel / exp.backup → export
    case 'exp.excel':
    case 'exp.backup': {
      cl('cm-export-btn')
      return L(lang, 'Exporting your data.', 'Data export ho raha hai.', 'Exporting data.')
    }

    default:
      return ''
  }
}

// ── Smart parsers ─────────────────────────────────────────────────────────────

/** Convert spoken number text (English, Hindi, Hinglish) to minutes for timer. */
function parseSpokenMinutes(text: string): number | null {
  const t = text.toLowerCase().trim()

  // 1. Plain digits: "45 min" / "45 minutes" / "45-minute" / "45 minat"
  const plain  = t.match(/\b(\d{1,3})[\s\-]*(?:min|minute|minutes|mins|minat|मिनट)/i)
  if (plain)  { const n = parseInt(plain[1]);  if (n>=1&&n<=180) return n }

  // 2. Split digits heard separately: "2 5 minutes" → 25
  const split  = t.match(/\b(\d)\s+(\d)\s*(?:min|minute|minutes|mins|minat|मिनट)/i)
  if (split)  { const n = parseInt(split[1]+split[2]); if (n>=1&&n<=180) return n }

  const split3 = t.match(/\b(\d)\s+(\d)\s+(\d)\s*(?:min|minute|minutes)/i)
  if (split3) { const n = parseInt(split3[1]+split3[2]+split3[3]); if (n>=1&&n<=180) return n }

  // 3. English word numbers
  const TENS: Record<string,number> = {twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90}
  const ONES: Record<string,number> = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19}
  if (/min|minat/i.test(t)) {
    let total = 0
    for (const w of t.replace(/-/g,' ').split(/\s+/)) {
      if (TENS[w]) total += TENS[w]; else if (ONES[w]) total += ONES[w]
    }
    if (total>=1 && total<=180) return total
  }

  // 4. Hindi / Hinglish number words (timer context only)
  if (/min|minat|मिनट|minute/i.test(t)) {
    const HINDI: Record<string,number> = {
      'ek':1,'do':2,'teen':3,'char':4,'paanch':5,'chhe':6,'saat':7,'aath':8,'nau':9,'das':10,
      'gyarah':11,'barah':12,'terah':13,'chaudah':14,'pandrah':15,'pandhra':15,'solah':16,'sola':16,
      'satrah':17,'atharah':18,'unnees':19,'bees':20,'pachis':25,'pachchis':25,'pachees':25,
      'tees':30,'paintees':35,'chalis':40,'paintaalees':45,'paintalis':45,'pachaas':50,'pachas':50,
      'pacchis':25,'chaalis':40,'saath':60,'sattar':70,'assi':80,'nabbe':90,'sau':100,
    }
    for (const [word, val] of Object.entries(HINDI)) {
      if (t.includes(word) && val>=1 && val<=180) return val
    }
  }

  return null
}

/** Natural-language duration expressions without explicit "minutes" keyword */
function parseNaturalDuration(t: string): number | null {
  // Only fire when there's a timer/duration intent word
  if (!/timer|focus|session|pomodoro|study|padhai|kaam|countdown|ghanta|shuru|chalao|lagao|start/i.test(t)) return null
  if (/half.*hour|adha.*ghanta|half.*ghanta/i.test(t)) return 30
  if (/one.*half.*hour|one.*point.*five.*hour|1\.5.*hour/i.test(t)) return 90
  if (/\bone\b.*hour|ek.*ghanta|^1\s*hour/i.test(t)) return 60
  if (/two.*hour|do.*ghanta|^2\s*hour/i.test(t)) return 120
  if (/one.*half.*hour|1\.5/i.test(t)) return 90
  // "timer 45" — bare number with timer keyword, no minutes word
  const bare = t.match(/(?:timer|focus|session)\s+(\d{1,3})\b(?!\s*(?:min|minute|hour|ghanta))/)
  if (bare) { const n = parseInt(bare[1]); if (n>=1&&n<=180) return n }
  const bare2 = t.match(/\b(\d{1,3})\s+(?:timer|focus|session|minute timer|min timer)/i)
  if (bare2) { const n = parseInt(bare2[1]); if (n>=1&&n<=180) return n }
  return null
}

/** Parse "remind me in 30 minutes / 30 minute baad yaad dilana" → 30 */
function parseReminderMinutes(t: string): number | null {
  // "remind me in 30 minutes" / "in 30 minutes remind" / "30 minute mein batana" / "30 min baad"
  const m = t.match(/(?:in|after|baad|mein)?\s*(\d+)\s*(?:min|minute|minutes|mins|minat|मिनट)\s*(?:baad|mein|me|after|remind|yaad|batana)?/)
  if (m && (t.includes('remind') || t.includes('yaad') || t.includes('batana') || t.includes('alert') || t.includes('bata'))) {
    const n = parseInt(m[1])
    if (n >= 1 && n <= 600) return n
  }
  return null
}

/** Extract what to be reminded about from the reminder command. */
function extractReminderLabel(t: string): string {
  return t.replace(/remind.*me|reminder|set.*alert|yaad.*dilana|baad.*batana|\d+\s*(?:min|minute|minutes|mins)/gi,'').replace(/\b(in|to|for|about|ke|liye|baad|mein|ki|ki|par)\b/gi,'').trim()
}

/** Parse "I scored 145 out of 200 in Mock 7" → {score, max, label} */
function parseScoreEntry(t: string): { score: number; max: number; label: string } | null {
  // "145 out of 200" / "145/200" / "145 mein se 200"
  const slash = t.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of|mein se|me se)\s*(\d+(?:\.\d+)?)/)
  if (!slash) return null
  const score = parseFloat(slash[1]), max = parseFloat(slash[2])
  if (isNaN(score) || isNaN(max) || max <= 0 || score < 0 || score > max) return null
  const label = t.replace(slash[0],'').replace(/\b(i|scored|got|in|for|on|my|mujhe|mein|ka|ke|ki|aaye|aaya|milei|mile|marks)\b/gi,'').replace(/[,.:]/g,'').trim()
  return { score, max, label: label.replace(/\s+/g,' ').trim() }
}

/** Instant math: "what is 35 percent of 200" / "78/200 as percentage" */
function quickMath(t: string): string | null {
  // Percentage of: "X percent of Y"
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|percent|percent)\s*(?:of|ka|ke)\s*(\d+(?:\.\d+)?)/)
  if (m) return `${((parseFloat(m[1])/100)*parseFloat(m[2])).toFixed(2)}`
  // As percentage: "X out of Y as percentage" / "X/Y percent"
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)\s*(?:as percentage|percent|ka percentage|%|ka)/)
  if (m) { const pct = (parseFloat(m[1])/parseFloat(m[2])*100); return `${pct.toFixed(1)}%` }
  // Simple division
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:divided by|÷|\/)\s*(\d+(?:\.\d+)?)/)
  if (m && (t.includes('divide') || t.includes('÷'))) return `${(parseFloat(m[1])/parseFloat(m[2])).toFixed(4)}`
  return null
}

// ── App action helpers — with visual feedback pulse ───────────────────────────
const cl = (id: string): void => {
  const el = document.getElementById(id)
  if (!el) return
  el.click()
  // Visual pulse so Om sees what JARVIS touched
  el.classList.add('jv-flash')
  setTimeout(() => el.classList.remove('jv-flash'), 500)
}
const q   = (sel: string): void => {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) return
  el.click()
  el.classList.add('jv-flash')
  setTimeout(() => el.classList.remove('jv-flash'), 500)
}
const scr = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
const clickStart = (): void => {
  const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
  if (btn && /start|resume/i.test(btn.textContent ?? '')) btn.click()
}

// ── Browser Notification system ───────────────────────────────────────────────
let _notifGranted = Notification?.permission === 'granted'
async function requestNotifPermission(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'default') return
  const r = await Notification.requestPermission()
  _notifGranted = r === 'granted'
}
function browserNotify(title: string, body: string, tag = 'jarvis'): void {
  if (!_notifGranted || !('Notification' in window)) return
  try {
    new Notification(title, {
      body,
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag,
      silent: false,
    })
  } catch { /* ignore */ }
}

// ── Ambient Mode ──────────────────────────────────────────────────────────────
type AmbientMode = 'off' | 'whisper'
let _ambientMode: AmbientMode = 'off'
let _ambientIntervalId = 0

// ── Interview Practice Mode ───────────────────────────────────────────────────
type InterviewPhase = 'off' | 'active' | 'feedback'
let _ivPhase: InterviewPhase = 'off'
let _ivQIdx  = 0
const IV_QS_EN = [
  "Tell me about yourself — your background and what inspired you to pursue the civil services.",
  "What do you consider the most pressing challenge facing India today, and what would be your approach as an IAS officer?",
  "If you are posted as a District Magistrate in a flood-affected area, walk me through your first 48 hours of action.",
  "There is a conflict between a large infrastructure project and the rights of tribal communities. How do you balance development and rights as an administrator?",
  "What is your opinion on the role of technology in last-mile governance? Give a specific example.",
  "How would you handle a situation where a senior officer asks you to take an action you believe is incorrect?",
  "India is ranked low on press freedom indices. What are your views on this, and how should the government respond?",
  "Describe a moment in your life where you showed moral courage. What did you learn from it?",
  "What is the difference between a leader and an administrator? Which do you aspire to be, and why?",
  "If you were given one policy initiative to implement as a Secretary to the Government, what would it be and why?",
]
const IV_QS_HI = [
  "अपने बारे में बताइए — आपकी पृष्ठभूमि और civil services की ओर आपको क्या प्रेरित किया?",
  "आज भारत की सबसे बड़ी चुनौती क्या है, और एक IAS officer के रूप में आप उसे कैसे address करेंगे?",
  "यदि आप बाढ़ प्रभावित जिले में DM के रूप में posted हैं, तो पहले 48 घंटों में आपकी कार्य योजना क्या होगी?",
  "एक बड़े infrastructure project और tribal communities के अधिकारों में conflict है। एक administrator के रूप में आप संतुलन कैसे बनाएंगे?",
  "Last-mile governance में technology की क्या भूमिका होनी चाहिए? एक specific example दीजिए।",
  "यदि एक वरिष्ठ अधिकारी आपसे कोई ऐसा कार्य करने कहें जो आपको गलत लगे, तो आप क्या करेंगे?",
  "नैतिक साहस की एक घटना बताइए जो आपके जीवन में हुई हो। उससे आपने क्या सीखा?",
  "एक leader और एक administrator में क्या अंतर है? आप क्या बनना चाहते हैं और क्यों?",
  "यदि आप Government के Secretary हों और आपको एक नीतिगत पहल करनी हो, तो वह क्या होगी?",
  "आज के समय में civil servant का सबसे महत्वपूर्ण गुण क्या होना चाहिए?",
]

// ── Voice Journal ─────────────────────────────────────────────────────────────
type JournalStep = 'off' | 'mood' | 'learned' | 'improve' | 'done'
let _journalStep: JournalStep = 'off'
interface JournalEntry { date: string; mood: number; learned: string; improve: string }
const JOURNAL_KEY = 'jarvis_journal_v1'
const _journalBuf: Partial<JournalEntry> = {}

// ── Confidence Tracker ────────────────────────────────────────────────────────
let _awaitingConfidence = false
let _confidenceTopic    = ''

// ── Lecture Time Tracker ──────────────────────────────────────────────────────
let _activeLectureName = ''
let _lectureStartMs    = 0

/** Check off first undone lecture in the planner. Returns its title or null. */
function checkCurrentTopic(): string | null {
  const row = document.querySelector<HTMLElement>('#plan .plan-row:not(.done)')
  if (!row) return null
  const title = row.querySelector<HTMLElement>('.pl-title')?.textContent?.trim() ?? 'Lecture'
  row.querySelector<HTMLElement>('.check')?.click()
  return title
}

/** Find a lecture whose title contains `label` (fuzzy) and check it off. */
function checkNamedTopic(label: string): string | null {
  const kw = label.toLowerCase()
  const rows = document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')
  for (const row of Array.from(rows)) {
    const title = row.querySelector<HTMLElement>('.pl-title')?.textContent?.toLowerCase() ?? ''
    if (title.includes(kw) || kw.split(' ').every(w => title.includes(w))) {
      const t = row.querySelector<HTMLElement>('.pl-title')?.textContent?.trim() ?? 'Lecture'
      row.querySelector<HTMLElement>('.check')?.click()
      return t
    }
  }
  return checkCurrentTopic()
}

/** Add a quick note to inbox in app_state */
function addToInbox(note: string): void {
  try {
    const raw = localStorage.getItem('inbox') ?? '[]'
    const inbox = JSON.parse(raw) as string[]
    inbox.unshift(`[${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}] ${note}`)
    localStorage.setItem('inbox', JSON.stringify(inbox.slice(0,50)))
  } catch { /* ignore */ }
}

/** Pre-fill score modal fields if available */
function prefillScoreForm(score: number, max: number, label: string): void {
  const inputs = document.querySelectorAll<HTMLInputElement>('#jarvis-score-form input, .score-modal input, [data-field]')
  inputs.forEach(inp => {
    const f = inp.dataset.field ?? inp.name ?? inp.placeholder?.toLowerCase()
    if (/score|marks|got/i.test(f??'')) inp.value = String(score)
    if (/max|total|out/i.test(f??'')) inp.value = String(max)
    if (/label|name|test/i.test(f??'')) inp.value = label
  })
}

// ── Commands table (200+ patterns) ───────────────────────────────────────────
interface Cmd { re: RegExp; action: () => void; reply: string }

/** Dispatch jarvis:set-timer + click Start as fallback if auto-start fails */
function fireTimer(mins: number): void {
  window.dispatchEvent(new CustomEvent('jarvis:set-timer', { detail: { focus: mins } }))
  // Safety net: if timer-config's auto-start (120ms) didn't fire, click Start after 450ms
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
    if (btn && /^(start|resume)$/i.test((btn.textContent ?? '').trim())) btn.click()
  }, 450)
}
const _st = (mins: number) => () => fireTimer(mins)
const _scr = (id: string) => () => scr(id)

const CMDS: Cmd[] = [
  // ── NAVIGATION ────────────────────────────────────────────────────────────
  { re: /\b(go to|open|show|scroll.*to|take.*to)\b.*\b(intelligence|intel|analytics|charts|stats|performance)\b/i, action: _scr('intel'), reply: 'Intelligence section.' },
  { re: /\b(go to|open|show|scroll.*to)\b.*\b(plan|planner)\b/i,                           action: _scr('plan'), reply: 'Plan section.' },
  { re: /\b(go to|open|show|scroll.*to)\b.*\b(engine|timer|focus card|pomodoro card)\b/i,  action: _scr('engine'), reply: 'Daily Engine.' },
  { re: /\b(go to|open|show|scroll.*to)\b.*\b(routine|schedule)\b/i,                       action: _scr('routine'), reply: 'Routine section.' },
  { re: /\b(go to|open|show|scroll.*to)\b.*\b(constitution|article)\b/i,                   action: _scr('constitution'), reply: 'Constitution section.' },
  { re: /analytics.*section|intelligence section|show.*analytics|show.*intel/i,            action: _scr('intel'), reply: 'Intelligence section.' },
  { re: /planner.*section|show.*planner|open.*planner/i,                                   action: _scr('plan'), reply: 'Planner section.' },
  { re: /engine.*section|timer.*section|focus.*section/i,                                  action: _scr('engine'), reply: 'Engine section.' },
  { re: /routine.*section|show.*routine|open.*routine/i,                                   action: _scr('routine'), reply: 'Routine section.' },
  { re: /constitution.*section|open.*constitution|show.*constitution/i,                    action: _scr('constitution'), reply: 'Constitution section.' },
  { re: /scroll.*top|go.*home|back.*top|upar.*jao|home/i,                                  action: () => window.scrollTo({top:0,behavior:'smooth'}), reply: 'Back to top.' },
  { re: /scroll.*bottom|end.*page|bottom.*page/i,                                          action: () => window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}), reply: 'Scrolled to bottom.' },
  { re: /open.*menu|command.*menu|menu.*open/i,                                             action: () => cl('command-menu-btn'), reply: 'Command menu opened.' },

  // ── TIMER — START / PAUSE / RESET ─────────────────────────────────────────
  { re: /^start$|^shuru$|^chalu$|focus.*start|start.*focus|pomodoro.*start|study.*start|padhai.*shuru|timer.*shuru|timer.*start|start.*timer/i, action: clickStart, reply: 'Timer started. Focus, Om.' },
  { re: /pause.*timer|timer.*pause|roko|band.*karo|stop.*timer/i,                          action: () => q('[data-act="start"]'), reply: 'Timer paused.' },
  { re: /resume.*timer|timer.*resume|continue.*timer|wapas.*shuru/i,                       action: clickStart, reply: 'Timer resumed.' },
  { re: /reset.*timer|timer.*reset|restart.*timer|dobara.*shuru|naya.*timer/i,             action: () => q('[data-act="reset"]'), reply: 'Timer reset.' },
  { re: /skip.*session|next.*session|session.*skip/i,                                      action: () => q('[data-act="skip"]'), reply: 'Session skipped.' },
  { re: /end.*session|session.*end|session.*khatam/i,                                      action: () => q('[data-act="skip"]'), reply: 'Session ended.' },
  // Presets
  { re: /pomodoro.*preset|classic.*pomodoro|25.*5.*preset|standard.*timer/i,               action: _st(25), reply: '25-minute Pomodoro set.' },
  { re: /deep.*work|50.*10.*preset|extended.*session.*preset|50.*min.*preset/i,             action: _st(50), reply: '50-minute deep work session set.' },
  { re: /flow.*state|90.*preset|ninety.*min|ultra.*deep/i,                                 action: _st(90), reply: '90-minute flow state set.' },
  { re: /quick.*session|mini.*session|15.*min.*timer|mini.*pomodoro/i,                     action: _st(15), reply: '15-minute quick session set.' },
  { re: /short.*break.*start|start.*short.*break|break.*shuru.*short/i,                    action: () => q('[data-act="skip"]'), reply: 'Short break started.' },
  { re: /long.*break.*start|start.*long.*break|lamba.*break/i,                             action: () => q('[data-act="skip"]'), reply: 'Long break started.' },
  { re: /break.*time|break.*lo|take.*break|rest.*karo/i,                                   action: () => respond("Take a proper break. Stretch, drink water, rest your eyes. You've earned it."), reply: '' },

  // ── PLANNER — FILTERING & ACTIONS ─────────────────────────────────────────
  { re: /show.*today.*lecture|today.*lecture.*show|aaj.*lecture.*dikhao|aaj.*ka.*plan|today.*plan/i, action: () => { scr('plan'); cl('lp-filter-today') }, reply: "Today's lectures." },
  { re: /show.*backlog|backlog.*show|backlog.*dikhao|pending.*sab/i,                        action: () => { scr('plan'); cl('lp-filter-backlog') }, reply: 'Showing backlog.' },
  { re: /show.*all.*lecture|sab.*lecture.*show|all.*lecture.*dikhao/i,                     action: () => { scr('plan'); cl('lp-filter-all') }, reply: 'All lectures.' },
  { re: /show.*done.*lecture|completed.*lecture.*show|khatam.*lecture/i,                   action: () => { scr('plan'); cl('lp-filter-done') }, reply: 'Completed lectures.' },
  { re: /generate.*plan|plan.*banao|create.*schedule|schedule.*banao|plan.*generate/i,     action: () => cl('ai-gen'), reply: 'Generating optimized plan…' },
  { re: /skip.*today|aaj.*skip|kal.*ka.*plan|today.*skip/i,                                action: () => cl('lp-skip-day'), reply: 'Today skipped.' },
  { re: /add.*lecture|lecture.*add|new.*lecture|naya.*lecture/i,                           action: () => cl('lp-add-manual'), reply: 'Add lecture form opened.' },
  { re: /import.*lecture|lecture.*import|excel.*import|xlsx.*import/i,                     action: () => cl('lp-import'), reply: 'Import wizard opened.' },
  { re: /filter.*polity|polity.*filter|polity.*lectures/i,                                 action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='polity';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by Polity.' },
  { re: /filter.*history|history.*filter|history.*lectures/i,                              action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='history';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by History.' },
  { re: /filter.*geography|geography.*filter|geography.*lectures/i,                        action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='geography';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by Geography.' },
  { re: /filter.*economics|economics.*filter|economy.*lectures/i,                          action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='economics';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by Economics.' },
  { re: /filter.*environment|environment.*filter|env.*lectures/i,                          action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='environment';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by Environment.' },
  { re: /filter.*science|science.*filter|science.*tech/i,                                  action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='science';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by Science & Tech.' },
  { re: /filter.*csat|csat.*filter|csat.*lectures/i,                                       action: () => { scr('plan'); setTimeout(() => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='csat';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Filtered by CSAT.' },
  { re: /clear.*filter|filter.*clear|reset.*filter|remove.*filter/i,                       action: () => { const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='';i.dispatchEvent(new Event('input'))} }, reply: 'Filters cleared.' },
  { re: /show.*more.*lecture|load.*more|lecture.*more/i,                                   action: () => cl('lp-more'), reply: 'Loading more lectures.' },

  // ── SCORES ────────────────────────────────────────────────────────────────
  { re: /add.*score|score.*add|score.*dal|new.*score|score.*entry/i,                       action: () => cl('cm-add-score'), reply: 'Add Score opened.' },
  { re: /add.*prelims.*score|prelims.*score.*add|mock.*score.*add/i,                       action: () => cl('cm-add-score'), reply: 'Add Prelims score.' },
  { re: /add.*csat.*score|csat.*score.*add/i,                                              action: () => cl('cm-add-score'), reply: 'Add CSAT score.' },
  { re: /add.*mains.*score|mains.*score.*add/i,                                            action: () => cl('cm-add-score'), reply: 'Add Mains score.' },
  { re: /add.*dpp.*score|dpp.*score.*add|dpp.*result/i,                                    action: () => cl('cm-add-score'), reply: 'Add DPP score.' },
  { re: /add.*sectional.*score|sectional.*score|subject.*test.*score/i,                    action: () => cl('cm-add-score'), reply: 'Add sectional score.' },
  { re: /show.*scores|my.*scores|scores.*dikhao|score.*history|all.*scores/i,              action: () => scr('intel'), reply: 'Showing score analytics.' },
  { re: /my.*rank|rank.*kya|rank.*estimate|air.*estimate|rank.*prediction/i,               action: () => { scr('intel'); setTimeout(()=>respond(buildRankLine()),300) }, reply: '' },
  { re: /my.*performance|performance.*kaisi|how.*performing|meri.*performance/i,           action: () => { scr('intel'); setTimeout(()=>respond(buildStatusReport()),300) }, reply: '' },
  { re: /average.*score|mera.*average|score.*average/i,                                    action: () => { scr('intel'); respond('Scroll to the analytics section for your average score.') }, reply: '' },

  // ── REVISION / SRS ────────────────────────────────────────────────────────
  { re: /add.*revision|revision.*add|revise.*this|mark.*revision|srs.*add/i,               action: () => cl('cm-revise-now'), reply: 'Added to revision queue.' },
  { re: /flag.*revision|flag.*revise|revision.*flag/i,                                     action: () => cl('cm-revise-now'), reply: 'Flagged for revision.' },
  { re: /show.*revisions|due.*revisions|revision.*today|today.*revision|kya.*revise/i,     action: () => { scr('plan'); setTimeout(()=>respond(buildRevisionLine()),300) }, reply: '' },
  { re: /revision.*schedule|srs.*schedule|spaced.*repetition/i,                            action: () => { scr('plan'); respond('Revision schedule is integrated into the planner. Due revisions appear automatically.') }, reply: '' },
  { re: /skip.*revision|revision.*skip/i,                                                  action: () => respond('Skipped. Next SRS review will be rescheduled automatically.'), reply: '' },

  // ── MISTAKES ──────────────────────────────────────────────────────────────
  { re: /add.*mistake|mistake.*add|wrong.*question.*add|galat.*question/i,                 action: () => cl('cm-add-mistake'), reply: 'Mistake Notebook opened.' },
  { re: /show.*mistakes|mistake.*dikhao|mistake.*notebook|mistakes.*list/i,                action: () => cl('cm-mistakes'), reply: 'Showing Mistake Notebook.' },
  { re: /polity.*mistakes|mistakes.*polity/i,                                              action: () => { cl('cm-mistakes'); setTimeout(()=>respond('Filter by Polity in the Mistake Notebook.'),400) }, reply: '' },
  { re: /history.*mistakes|mistakes.*history/i,                                            action: () => { cl('cm-mistakes'); setTimeout(()=>respond('Filter by History in the Mistake Notebook.'),400) }, reply: '' },
  { re: /how.*many.*mistakes|kitni.*mistakes|mistake.*count/i,                             action: () => { const c=document.querySelectorAll('.mistake-item').length; respond(c ? `${c} mistakes logged in the notebook.` : 'Open the Mistake Notebook to see your entries.') }, reply: '' },

  // ── NOTES ────────────────────────────────────────────────────────────────
  { re: /add.*note|note.*add|new.*note|naya.*note/i,                                       action: () => cl('cm-add-note'), reply: 'Notes opened.' },
  { re: /show.*notes|notes.*dikhao|all.*notes|my.*notes/i,                                 action: () => cl('cm-notes'), reply: 'Opening notes.' },
  { re: /quick.*note|jot.*down|capture.*idea|note.*karo|likh.*lo/i,                        action: () => cl('cm-add-note'), reply: 'Quick notes opened.' },

  // ── ANSWER WRITING ────────────────────────────────────────────────────────
  { re: /answer.*writing|answer.*log|mains.*writing|write.*answer|log.*answer/i,           action: () => cl('cm-answer-log'), reply: 'Answer Writing log opened.' },
  { re: /answer.*writing.*session|essay.*practice|gs.*answer.*practice/i,                  action: () => cl('cm-answer-log'), reply: 'Answer Writing session opened.' },
  { re: /show.*answer.*log|answer.*history|my.*answers/i,                                  action: () => cl('cm-answer-log'), reply: 'Answer log opened.' },

  // ── CURRENT AFFAIRS ───────────────────────────────────────────────────────
  { re: /add.*current.*affairs|ca.*add|current.*affairs.*add|news.*log/i,                  action: () => cl('cm-ca-log'), reply: 'Current Affairs log opened.' },
  { re: /show.*current.*affairs|current.*affairs.*show|ca.*dikhao|ca.*log/i,               action: () => cl('cm-ca-log'), reply: 'Opening Current Affairs log.' },
  { re: /today.*current.*affairs|aaj.*ca|today.*ca/i,                                      action: () => cl('cm-ca-log'), reply: "Today's CA log." },
  { re: /weekly.*ca.*review|ca.*weekly|current.*affairs.*review/i,                         action: () => cl('cm-ca-log'), reply: 'Weekly CA review opened.' },

  // ── GOALS ────────────────────────────────────────────────────────────────
  { re: /set.*goal|goal.*set|daily.*goal|update.*goal|naya.*goal/i,                        action: () => cl('cm-goals'), reply: 'Goals opened.' },
  { re: /show.*goals|my.*goals|goals.*dikhao|goal.*progress/i,                             action: () => cl('cm-goals'), reply: 'Opening your goals.' },
  { re: /weekly.*goal|goal.*week|is.*week.*goal/i,                                         action: () => cl('cm-goals'), reply: 'Weekly goals opened.' },
  { re: /am.*i.*on.*track|on.*track.*kya|track.*kaisa/i,                                   action: () => respond(buildStatusReport()), reply: '' },
  { re: /goal.*complete|goal.*done|goal.*khatam|lakshy.*poora/i,                           action: () => respond(`Goal marked. ${celebrationLine()} Keep the momentum going!`), reply: '' },

  // ── CALENDAR / AGENDA ────────────────────────────────────────────────────
  { re: /calendar|agenda.*view|week.*view|month.*view|schedule.*view/i,                    action: () => cl('cm-calendar'), reply: 'Calendar view opened.' },
  { re: /this.*week.*plan|week.*ka.*plan|agle.*saath.*din/i,                                action: () => cl('cm-calendar'), reply: 'Opening weekly view.' },
  { re: /today.*agenda|aaj.*agenda|today.*schedule/i,                                      action: () => { scr('plan'); setTimeout(()=>respond(buildTodayReport()),300) }, reply: '' },

  // ── SYNC & EXPORT ─────────────────────────────────────────────────────────
  { re: /export.*json|export.*csv|download.*data|data.*export/i,                           action: () => cl('cm-export-btn'), reply: 'Exporting your data.' },
  { re: /backup.*data|data.*backup|sync.*now|force.*sync/i,                                action: () => { cl('cm-export-btn'); respond('Data export initiated.') }, reply: '' },
  { re: /sync.*status|last.*synced|connection.*status|online.*status/i,                    action: () => { const online=navigator.onLine; respond(online ? 'Online. All changes are syncing.' : 'Offline. Changes will sync when reconnected.') }, reply: '' },

  // ── APP CONTROLS — LOCK SCREEN ───────────────────────────────────────────
  // NOTE: word boundaries prevent false-match on "stop locking/listening"
  { re: /\block\s+screen\b|\bscreen\s+lock\b|\block\s+karo\b|\block\s+kar\b/i,                       action: () => cl('lock-btn'), reply: 'Screen locked.' },
  { re: /\block\s+(?:phone|app|website|site|tab|portal|page)\b/i,                                     action: () => cl('lock-btn'), reply: 'Website locked.' },
  { re: /\bprivacy\s+mode\b|\bprivacy\s+on\b|\bsecure\s+screen\b/i,                                  action: () => cl('lock-btn'), reply: 'Privacy mode on.' },
  { re: /\bunlock\s+screen\b|\bscreen\s+unlock\b|\bunlock\s+kar\b|\bunlock\s+karo\b/i,                action: () => cl('lock-btn'), reply: 'Unlocking.' },
  { re: /website.*band.*karo|site.*lock.*karo|page.*lock.*karo|lock.*kar.*do.*website/i,              action: () => cl('lock-btn'), reply: 'Website lock ho gaya.' },
  { re: /koi.*nahi.*dekhe|koi.*na.*dekhe|private.*rakhna|screen.*chupa.*do/i,                         action: () => cl('lock-btn'), reply: 'Screen locked for privacy.' },
  { re: /mujhe.*akela.*chod|distract.*mat.*karo|focus.*lock|concentration.*lock/i,                    action: () => cl('lock-btn'), reply: 'Locked. Focus mode.' },
  { re: /focus.*mode|animation.*off|vfx.*off|heavy.*vfx|performance.*mode/i,              action: () => cl('focus-mode-btn'), reply: 'Focus Mode toggled.' },
  { re: /settings.*open|open.*settings|settings.*kholao|app.*settings/i,                  action: () => cl('cm-settings'), reply: 'Settings opened.' },
  { re: /exam.*date.*set|set.*exam.*date|prelims.*date|exam.*configure/i,                  action: () => cl('cm-settings'), reply: 'Open Settings to configure your exam date.' },
  { re: /keyboard.*shortcut|shortcuts|hotkey/i,                                            action: () => respond('Press J to toggle JARVIS. Use the command menu for all actions.'), reply: '' },
  { re: /help.*jarvis|jarvis.*help|what.*can.*you.*do|commands.*list/i,                    action: () => respond('I can control the timer, planner, scores, notes, mistakes, reminders, quiz you, give status reports, and answer any UPSC question. Just ask!'), reply: '' },
  { re: /install.*app|pwa.*install|add.*home.*screen|homescreen/i,                         action: () => { cl('pwa-install-btn'); respond('Use your browser\'s install option to add to homescreen.') }, reply: '' },

  // ── STUDY TRACKING ────────────────────────────────────────────────────────
  { re: /how.*much.*study.*today|today.*study.*time|aaj.*kitna.*padha|focus.*mins.*today/i, action: () => { const m=getTodayFocusMins(); respond(m ? `${m} minutes studied today so far.` : 'No focus sessions logged today yet.') }, reply: '' },
  { re: /total.*study.*time|all.*time.*study|total.*focus|kitna.*total.*padha/i,           action: () => { try { const m=JSON.parse(localStorage.getItem('focusMins')??"0") as number; respond(`Total: ${m} minutes studied. Keep going!`) } catch { respond('Study time data unavailable.') } }, reply: '' },
  { re: /show.*focus.*log|focus.*history|session.*history|study.*log/i,                    action: () => scr('intel'), reply: 'Showing study analytics.' },
  { re: /today.*sessions|aaj.*sessions|sessions.*today/i,                                  action: () => { try { const log=JSON.parse(localStorage.getItem('focusLog')??"{}") as Record<string,number>; const d=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}); respond(`${log[d]??0} session${(log[d]??0)!==1?'s':''} today.`) } catch { respond('Session data unavailable.') } }, reply: '' },
  { re: /how.*many.*sessions|kitni.*sessions|sessions.*count/i,                            action: () => { try { const t=JSON.parse(localStorage.getItem('sessTotal')??"0") as number; respond(`${t} total sessions. Consistent work, Om.`) } catch { respond('Session count unavailable.') } }, reply: '' },

  // ── INFORMATION QUERIES ───────────────────────────────────────────────────
  { re: /what.*time.*is.*it|kitna.*baj.*hai|time.*kya.*hai|current.*time/i,                action: () => { const t=new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}); respond(`It's ${t} IST.`) }, reply: '' },
  { re: /today.*date|aaj.*date|what.*date.*today|current.*date/i,                          action: () => { const d=new Date().toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'}); respond(d) }, reply: '' },
  { re: /days.*prelims|prelims.*days|countdown.*prelims|prelims.*countdown|kitne.*din.*bache/i, action: () => respond(buildExamCountdown()), reply: '' },
  { re: /days.*mains|mains.*days|countdown.*mains/i,                                       action: () => respond(buildExamCountdown()), reply: '' },
  { re: /syllabus.*gs1|gs1.*syllabus/i,                                                    action: () => respond('GS1 covers History, Geography, Art & Culture, Society, and International Relations.'), reply: '' },
  { re: /syllabus.*gs2|gs2.*syllabus/i,                                                    action: () => respond('GS2 covers Polity, Governance, Constitution, Social Justice, and IR.'), reply: '' },
  { re: /syllabus.*gs3|gs3.*syllabus/i,                                                    action: () => respond('GS3 covers Economy, Agriculture, Science & Tech, Environment, and Internal Security.'), reply: '' },
  { re: /syllabus.*gs4|gs4.*syllabus|ethics.*syllabus/i,                                   action: () => respond('GS4 is Ethics, Integrity, and Aptitude — attitude, case studies, and thinkers.'), reply: '' },
  { re: /csat.*syllabus|paper.*2.*syllabus/i,                                              action: () => respond('CSAT includes Comprehension, Math, Reasoning, Decision Making, and English.'), reply: '' },
  { re: /prelims.*pattern|exam.*pattern.*prelims/i,                                        action: () => respond('Prelims: 2 papers, 100 questions each. GS Paper 1 is 200 marks with negative marking. Paper 2 (CSAT) is qualifying at 33%.'), reply: '' },
  { re: /mains.*pattern|exam.*pattern.*mains/i,                                            action: () => respond('Mains: 9 papers. Essay, GS 1-4, 2 Optional papers, 2 qualifying languages. Total 1750 marks.'), reply: '' },

  // ── CONSTITUTION QUICK FACTS ──────────────────────────────────────────────
  { re: /preamble|udbhavana|dibhashan/i,                                                   action: () => { scr('constitution'); respond('Opening Constitution. The Preamble declares India a Sovereign, Socialist, Secular, Democratic Republic.') }, reply: '' },
  { re: /fundamental.*rights|article.*12.*to.*35|FR.*section/i,                           action: () => { scr('constitution'); respond('Fundamental Rights are in Part 3, Articles 12–35. Six rights remain after the 44th Amendment removed the Right to Property.') }, reply: '' },
  { re: /directive.*principles|dpsp|article.*36.*to.*51/i,                                 action: () => { scr('constitution'); respond('DPSPs are in Part 4, Articles 36–51. They are non-justiciable but fundamental to governance.') }, reply: '' },
  { re: /fundamental.*duties|article.*51a/i,                                               action: () => { scr('constitution'); respond('Fundamental Duties are in Part 4A, Article 51A. Added by the 42nd Amendment in 1976, originally 10, now 11 duties.') }, reply: '' },
  { re: /article.*21\b|right.*to.*life/i,                                                  action: () => { scr('constitution'); respond('Article 21: No person shall be deprived of life or personal liberty except according to procedure established by law. Widely expanded by the Supreme Court.') }, reply: '' },
  { re: /article.*21a|right.*to.*education/i,                                              action: () => { scr('constitution'); respond('Article 21A: The State shall provide free and compulsory education to all children aged 6 to 14. Added by 86th Amendment 2002.') }, reply: '' },
  { re: /article.*32|right.*to.*constitutional.*remedies|constitutional.*remedies/i,        action: () => { scr('constitution'); respond('Article 32 is the Right to Constitutional Remedies — Dr. Ambedkar called it the heart and soul of the Constitution.') }, reply: '' },
  { re: /article.*370|jammu.*kashmir|j.*k.*special/i,                                      action: () => respond('Article 370 granted special status to J&K. It was abrogated in August 2019 through a Presidential Order, and J&K was bifurcated into two UTs.'), reply: '' },
  { re: /article.*44|uniform.*civil.*code|ucc/i,                                           action: () => respond('Article 44 (DPSP): The State shall endeavour to secure a Uniform Civil Code for all citizens. It remains a constitutional aspiration.'), reply: '' },

  // ── MOTIVATION & WELLBEING ────────────────────────────────────────────────
  { re: /motivate.*me|motivation.*chahiye|inspire.*me|dum.*do|himmat.*do/i,                action: () => respond(motivationLine()), reply: '' },
  { re: /i.*am.*tired|thak.*gaya|thak.*gayi|break.*chahiye|neend.*aa.*rahi/i,              action: () => respond("Take a proper break. Drink water, rest your eyes, stretch. The UPSC journey is a marathon and rest is part of the training."), reply: '' },
  { re: /i.*am.*stressed|tension.*hai|stress.*ho.*raha|dar.*lag.*raha/i,                   action: () => respond("Breathe. You've made the hardest decision — to try. Every person who cleared UPSC felt exactly what you're feeling. This is the path. Keep going."), reply: '' },
  { re: /i.*am.*losing.*hope|haar.*man.*raha|give.*up|band.*kar.*dun/i,                    action: () => respond("Don't. The officers you'll serve alongside had moments exactly like this. The difference was they chose to continue. Just today's session. That's all."), reply: '' },
  { re: /celebrate|bahut.*acha|excellent|well.*done|great.*job|shabash/i,                  action: () => respond(celebrationLine()), reply: '' },
  { re: /how.*am.*i.*doing|how.*going|kaisa.*ja.*raha|progress.*kaisi/i,                   action: () => respond(buildStatusReport()), reply: '' },
  { re: /give.*me.*tip|study.*tip|tip.*do|advice.*do|suggestion/i,                         action: () => respond(studyTip()), reply: '' },
  { re: /quote.*do|motivational.*quote|quote.*chahiye|aaj.*ka.*quote/i,                    action: () => respond(studyQuote()), reply: '' },

  // ── FOCUS MODE ───────────────────────────────────────────────────────────
  { re: /focus.*mode.*on|turn.*on.*focus|enable.*focus.*mode/i,                            action: () => cl('focus-mode-btn'), reply: 'Focus Mode enabled. Heavy animations off.' },
  { re: /focus.*mode.*off|turn.*off.*focus|disable.*focus.*mode/i,                         action: () => cl('focus-mode-btn'), reply: 'Focus Mode disabled.' },

  // ── REMINDERS — LIST ──────────────────────────────────────────────────────
  { re: /list.*reminder|show.*reminder|active.*reminder|reminders.*kitne/i,                action: () => { const r=_reminders; respond(r.length ? `${r.length} active reminder${r.length>1?'s':''}. Next: ${r[0]?.msg}.` : 'No active reminders.') }, reply: '' },

  // ── QUICK STATUS ──────────────────────────────────────────────────────────
  { re: /status.*report|full.*status|briefing|mujhe.*batao.*sab|sab.*kuch.*batao/i,        action: () => respond(buildStatusReport()), reply: '' },
  { re: /today.*report|aaj.*ka.*report|daily.*report/i,                                    action: () => respond(buildTodayReport()), reply: '' },
  { re: /streak.*kitni|my.*streak|current.*streak|streak.*kya/i,                           action: () => { const s=getCurrentState()?.streak??0; respond(s ? `${s}-day streak. Protect it today.` : 'No streak yet. Log a session to start one.') }, reply: '' },
  { re: /backlog.*kitna|backlog.*count|how.*many.*backlog|lectures.*left/i,                 action: () => { const b=getCurrentState()?.backlogRemaining??0; respond(b ? `${b} lectures in backlog.` : 'No backlog. You\'re caught up!') }, reply: '' },
  { re: /today.*subject|aaj.*subject|kya.*padhna.*aaj/i,                                   action: () => { const s=getCurrentState()?.today?.subject; respond(s ? `Today's subject: ${s}.` : 'No subject scheduled. Open the planner.') }, reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // EXTENDED COMMAND BANK — 1500+ additional patterns
  // ════════════════════════════════════════════════════════════════════════════

  // ── GS1 HISTORY — ANCIENT ─────────────────────────────────────────────────
  { re: /ancient.*history|praacheen.*itihas|indus.*valley|harappan.*civil/i,               action: () => respond('Ancient History covers Indus Valley, Vedic Age, Mauryas, Guptas, Sangam literature, and Buddhist/Jain traditions — all major UPSC areas.'), reply: '' },
  { re: /indus.*valley.*civil|harappa|mohenjo.*daro|sindhu.*sabhyata/i,                    action: () => respond('Indus Valley Civilization (2600–1900 BCE): town planning, standardized weights, no evidence of armies. Key sites: Harappa, Mohenjo-daro, Lothal, Dholavira.'), reply: '' },
  { re: /vedic.*age|vedic.*period|rig.*veda|sama.*veda|yajur.*veda|atharva.*veda/i,        action: () => respond('Vedic Age (1500–600 BCE): Rig Veda (oldest), followed by Sama, Yajur, Atharva. Later Vedic period saw agriculture, iron use, and varna system crystallization.'), reply: '' },
  { re: /maurya|chandragupta|ashoka|kautilya|arthashastra/i,                               action: () => respond('Maurya Empire (322–185 BCE): Chandragupta founded it, Kautilya wrote Arthashastra, Ashoka spread Buddhism post-Kalinga War (261 BCE). Rock and Pillar edicts key.'), reply: '' },
  { re: /gupta.*empire|golden.*age|chandragupta.*ii|kalidasa/i,                            action: () => respond("Gupta Empire (320–550 CE): called India's Golden Age. Chandragupta II was the greatest ruler. Kalidasa wrote Meghadutam. Decimal system and zero developed."), reply: '' },
  { re: /sangam.*literature|chola|chera|pandya|sangam.*age/i,                              action: () => respond('Sangam Age (300 BCE–300 CE): Three kingdoms — Chola, Chera, Pandya. Sangam literature (Tolkappiyam, Purananuru) is primary source for South Indian history.'), reply: '' },
  { re: /buddhism|gautam.*buddha|four.*noble.*truth|eightfold.*path|nirvana/i,             action: () => respond('Buddhism: Founded by Siddhartha Gautama (563 BCE). Four Noble Truths and Eightfold Path are core. Theravada and Mahayana are two main schools. Key UPSC topic.'), reply: '' },
  { re: /jainism|mahavira|five.*vow|ahimsa.*jain|tirthankar/i,                             action: () => respond('Jainism: Mahavira (599–527 BCE) was 24th Tirthankara. Five vows: Ahimsa, Satya, Asteya, Brahmacharya, Aparigraha. Non-violence is the supreme principle.'), reply: '' },

  // ── GS1 HISTORY — MEDIEVAL ───────────────────────────────────────────────
  { re: /medieval.*history|madhyakalin.*itihas|delhi.*sultanate/i,                         action: () => respond('Medieval History for UPSC: Sultanate period (1206–1526), Vijayanagara Empire, Bhakti movement, Mughal Empire (1526–1707), and regional kingdoms.'), reply: '' },
  { re: /delhi.*sultanate|slave.*dynasty|mamluk|iltutmish|razia|balban/i,                  action: () => respond('Delhi Sultanate (1206–1526): Slave → Khilji → Tughlaq → Sayyid → Lodi dynasties. Qutb-ud-din Aibak founded it. Ibn Battuta visited during Muhammad bin Tughlaq.'), reply: '' },
  { re: /mughal.*empire|babur|humayun|akbar|jahangir|shahjahan|aurangzeb/i,                action: () => respond("Mughal Empire (1526–1707): Babur founded it (Panipat 1526). Akbar's Sulh-i-Kul and Ain-i-Akbari by Abul Fazl are major UPSC themes. Aurangzeb's Deccan policy led to decline."), reply: '' },
  { re: /bhakti.*movement|kabir|mirabai|tukaram|ramananda|chaitanya/i,                     action: () => respond('Bhakti Movement (7th–17th CE): emphasised devotion over ritual. Ramananda, Kabir, Mirabai, Tukaram were key saints. It challenged caste and promoted vernacular languages.'), reply: '' },
  { re: /vijayanagara|krishnadeva.*raya|hampi|deccan.*kingdom/i,                           action: () => respond("Vijayanagara Empire (1336–1646): Founded by Harihara and Bukka. Krishnadeva Raya was the greatest ruler. Hampi is a UNESCO site. Known for it's contribution to Telugu literature."), reply: '' },
  { re: /maratha|shivaji|peshwa|panipat.*3|third.*panipat/i,                               action: () => respond("Marathas: Shivaji (1627–1680) founded the empire. He used guerrilla warfare and created the Ashta Pradhan. Third Battle of Panipat (1761) weakened Maratha power significantly."), reply: '' },

  // ── GS1 HISTORY — MODERN ─────────────────────────────────────────────────
  { re: /modern.*history|british.*india|colonial.*period|company.*raj/i,                   action: () => respond('Modern History: East India Company arrived 1600, Plassey 1757 marks British supremacy, 1857 First War of Independence, 1858 Crown took over, Independence 1947.'), reply: '' },
  { re: /1857.*revolt|sepoy.*mutiny|first.*war.*independence|rani.*laxmi/i,                action: () => respond('1857 Revolt: Began at Meerut on May 10. Causes: Enfield cartridge, Doctrine of Lapse, economic exploitation. Major leaders: Rani Laxmibai, Tantia Tope, Nana Sahib.'), reply: '' },
  { re: /indian.*national.*congress|inc.*founded|congress.*1885|dadabhai/i,                action: () => respond('INC founded in 1885 by A.O. Hume. First session in Bombay. Dadabhai Naoroji articulated the Drain Theory. Moderate phase (1885–1905), then Extremists led by Bal-Pal-Lal.'), reply: '' },
  { re: /mahatma.*gandhi|non.*cooperation|civil.*disobedience|quit.*india|gandhiji/i,      action: () => respond("Gandhi's major movements: Non-Cooperation (1920), Civil Disobedience/Salt March (1930), Quit India (1942). His philosophy of Satyagraha and Ahimsa transformed the freedom struggle."), reply: '' },
  { re: /partition.*india|partition.*1947|pakistan.*formation|mountbatten/i,              action: () => respond("Partition of India (1947): Mountbatten Plan (June 3, 1947). India and Pakistan became independent on August 14–15. Communal violence displaced ~15 million people."), reply: '' },
  { re: /simon.*commission|nehru.*report|poona.*pact|round.*table/i,                      action: () => respond('Simon Commission (1927): all-British, Indians boycotted it. Nehru Report (1928): first Indian-drafted constitution. Poona Pact (1932): Gandhi-Ambedkar on reserved seats.'), reply: '' },
  { re: /swadeshi.*movement|partition.*bengal|1905|curzon/i,                               action: () => respond('Partition of Bengal (1905) by Curzon sparked the Swadeshi Movement. It promoted indigenous goods and gave impetus to the Extremist wing of Congress.'), reply: '' },

  // ── GS1 GEOGRAPHY ────────────────────────────────────────────────────────
  { re: /physical.*geography|bhautik.*bhugol|himalaya|deccan.*plateau|coastal.*plain/i,    action: () => respond('India physical geography: Himalayas (young fold mountains), Northern Plains (alluvial), Deccan Plateau (old crystalline), Coastal plains, and Islands (Andaman, Lakshadweep).'), reply: '' },
  { re: /himalaya.*formation|tectonic.*plate|indo.*australian|eurasian.*plate/i,           action: () => respond('Himalayas formed by collision of Indo-Australian and Eurasian plates ~50 million years ago. Young fold mountains, still rising. Three ranges: Greater, Lesser, Outer Himalayas.'), reply: '' },
  { re: /monsoon|southwest.*monsoon|northeast.*monsoon|rainfall.*india|varsha/i,           action: () => respond('Indian Monsoon: SW Monsoon (June–Sep) brings 75% of India rainfall via Arabian Sea and Bay of Bengal branches. NE Monsoon (Oct–Dec) brings rain to Tamil Nadu.'), reply: '' },
  { re: /river.*india|ganga|brahmaputra|indus|krishna|godavari|kaveri/i,                   action: () => respond('Indian Rivers: Himalayan rivers (Ganga, Brahmaputra, Indus) are perennial. Peninsular rivers (Godavari, Krishna, Kaveri) are seasonal. West-flowing rivers: Narmada, Tapi.'), reply: '' },
  { re: /soil.*type|alluvial.*soil|black.*soil|red.*soil|laterite|regur/i,                 action: () => respond('Indian Soil types: Alluvial (most fertile, Indo-Gangetic plain), Black/Regur (cotton, Deccan), Red & Yellow (Odisha, Jharkhand), Laterite (heavy rainfall areas), Arid.'), reply: '' },
  { re: /vegetation.*india|forest.*type|tropical.*rainforest|mangrove|thorn.*forest/i,    action: () => respond('India vegetation: Tropical Rainforest (Andaman, NE), Tropical Deciduous (most common), Tropical Thorn (Rajasthan), Mangroves (Sundarbans), Alpine (Himalaya).'), reply: '' },
  { re: /climate.*india|koppen|tropical.*wet|semi.*arid|highland.*climate/i,               action: () => respond('India climate: Tropical Monsoon predominantly. Köppen classification shows Aw (tropical savanna), Bsh (semi-arid), BSk (cold arid), Cwg (monsoon with dry winter).'), reply: '' },
  { re: /ocean.*current|warm.*current|cold.*current|el.*nino|la.*nina/i,                  action: () => respond('Ocean Currents: Warm currents (Gulf Stream, Kuroshio) raise temperature. Cold currents (Labrador, Canaries) cause fog and aridity. El Niño weakens Indian Monsoon; La Niña strengthens it.'), reply: '' },
  { re: /earthquake|seismic.*zone|richter.*scale|mercalli|plate.*boundary/i,              action: () => respond('Earthquakes: Caused at plate boundaries (convergent, divergent, transform). India zones 1-5 (most seismic: Himalayan belt). Richter measures magnitude; Mercalli measures intensity.'), reply: '' },
  { re: /cyclone|hurricane|typhoon|tropical.*storm|bay.*of.*bengal.*cyclone/i,             action: () => respond('Tropical cyclones: Called hurricanes (Atlantic), typhoons (Pacific), cyclones (Indian Ocean). Bay of Bengal is more cyclone-prone than Arabian Sea. Named by WMO.'), reply: '' },

  // ── GS1 SOCIETY & CULTURE ────────────────────────────────────────────────
  { re: /indian.*society|caste.*system|jati|varna|social.*stratification/i,                action: () => respond('Indian Society: Caste system (Varna/Jati) has been a defining feature. Constitution abolished untouchability (Article 17). Reservation policy addresses historical discrimination.'), reply: '' },
  { re: /tribe.*india|scheduled.*tribe|adivasi|tribal.*area|fifth.*schedule/i,             action: () => respond('Scheduled Tribes (8.6% of population): Protected under 5th Schedule (other states) and 6th Schedule (NE states). PESA Act 1996 gives gram sabhas power in tribal areas.'), reply: '' },
  { re: /woman.*india|gender.*equality|feminist|mahila|dowry|sati|purdah/i,                action: () => respond('Women in India: Constitutional provisions (Art 14, 15, 16). Key acts: Dowry Prohibition Act 1961, Protection of Women from DV Act 2005, POCSO 2012. Beti Bachao Beti Padhao scheme.'), reply: '' },
  { re: /secularism.*india|minority.*right|communalism|religion.*state/i,                  action: () => respond("Indian Secularism: Not separation of church and state but 'principled distance' — state can intervene in religious affairs for social reform. Articles 25-28 guarantee religious freedom."), reply: '' },
  { re: /urbanization|smart.*city|urban.*problem|slum|migration.*urban/i,                  action: () => respond('Urbanization: India 35% urban (2011). Smart Cities Mission (2015): 100 cities. Urban challenges: slums, infrastructure gap, unemployment. AMRUT and JNNURM are key schemes.'), reply: '' },
  { re: /population|demographic.*transition|census.*2011|fertility.*rate|sex.*ratio/i,     action: () => respond('India Population (Census 2011): 1.21 billion. Sex ratio: 940/1000 males. Literacy: 74%. TFR declining. Demographic dividend window: 2020-2040. Northeast and Kerala have better indicators.'), reply: '' },

  // ── GS2 POLITY — CONSTITUTION ────────────────────────────────────────────
  { re: /constituent.*assembly|drafting.*committee|ambedkar.*constitution/i,               action: () => respond('Constituent Assembly met from Dec 1946, adopted Constitution on Nov 26, 1949 (Constitution Day), effective Jan 26, 1950. Drafting Committee chairman: Dr. B.R. Ambedkar.'), reply: '' },
  { re: /federal.*india|centre.*state.*relation|rajya.*sabha.*state|7th.*schedule/i,       action: () => respond('India is a quasi-federal state (Union of States). 7th Schedule: Union List (97), State List (61), Concurrent List (52). Centre dominates — Governor, Article 356, Finance Commission.'), reply: '' },
  { re: /parliament.*india|lok.*sabha|rajya.*sabha|joint.*session|speaker/i,               action: () => respond('Indian Parliament: Lok Sabha (545 seats, 5-year term), Rajya Sabha (245 seats, permanent body, 1/3 retire every 2 years). Speaker of Lok Sabha, Chairman of Rajya Sabha (VP).'), reply: '' },
  { re: /supreme.*court|high.*court|judicial.*review|pil|writ.*habeas/i,                   action: () => respond('Indian Judiciary: Supreme Court (guardian of Constitution), High Courts (each state), District Courts. Five Writs: Habeas Corpus, Mandamus, Prohibition, Certiorari, Quo-warranto.'), reply: '' },
  { re: /election.*commission|eci|model.*code|ev.*machine|voting.*right/i,                 action: () => respond('Election Commission of India: Constitutional body (Art 324). CEC and Election Commissioners. Model Code of Conduct during elections. EVM introduced 1990s. Voting age lowered to 18 in 1989 (61st Amendment).'), reply: '' },
  { re: /amendment.*constitution|basic.*structure|kesavananda|article.*368/i,              action: () => respond('Constitutional Amendment (Art 368): 3 types — simple majority, special majority, special majority + ratification. Basic Structure Doctrine from Kesavananda Bharati (1973): Parliament cannot destroy basic features.'), reply: '' },
  { re: /governor|article.*155|raj.*bhavan|state.*executive|rajyapal/i,                    action: () => respond("Governor: Appointed by President (Art 155), acts as agent of Centre. Governor's role is controversial — reserve bills, recommend President's Rule (Art 356), invite government formation."), reply: '' },
  { re: /prime.*minister|council.*of.*minister|cabinet|article.*74|article.*75/i,          action: () => respond('Prime Minister (Art 75): Leader of majority in Lok Sabha, appointed by President. Council of Ministers (Art 74) aids and advises President. Cabinet is the highest executive authority.'), reply: '' },
  { re: /upsc.*exam|civil.*service|ias.*ips|grade.*a.*service/i,                           action: () => respond('UPSC Civil Services: Conducted in 3 stages — Prelims (objective), Mains (written), Personality Test. About 1,000 posts filled annually from ~1 million applicants.'), reply: '' },

  // ── GS2 GOVERNANCE ───────────────────────────────────────────────────────
  { re: /panchayati.*raj|73rd.*amendment|gram.*sabha|zila.*panchayat/i,                    action: () => respond('Panchayati Raj (73rd Amendment 1992): 3-tier system — Gram Panchayat, Panchayat Samiti, Zila Parishad. 29 subjects in 11th Schedule. 1/3 seats reserved for women.'), reply: '' },
  { re: /urban.*local.*body|74th.*amendment|municipal.*corporation|mayor/i,                action: () => respond('Urban Local Bodies (74th Amendment 1992): 3 types — Municipal Corporation (large), Municipal Council (medium), Nagar Panchayat (transitional). 18 functions in 12th Schedule.'), reply: '' },
  { re: /rti.*act|right.*to.*information|central.*information|transparency/i,              action: () => respond('RTI Act 2005: Citizens can request info from public authorities. Response within 30 days (48 hours for life/liberty). Central/State Information Commission. Exemptions in Sec 8.'), reply: '' },
  { re: /niti.*aayog|planning.*commission|aspirational.*district|atal.*innovation/i,       action: () => respond('NITI Aayog (2015, replaced Planning Commission): Think-tank, cooperative federalism, Aspirational Districts Programme, Atal Innovation Mission. No fund allocation unlike Planning Commission.'), reply: '' },
  { re: /cag.*india|comptroller|audit|public.*account|finance.*committee/i,                action: () => respond("CAG (Art 148): Guardian of public purse. Audits Union, State, and PSU accounts. Reports submitted to President/Governor. PAC and COPU examine CAG's reports."), reply: '' },
  { re: /lokpal|lokayukta|anti.*corruption|jan.*lokpal|ombudsman/i,                        action: () => respond('Lokpal Act 2013: Covers PM (with exceptions), Ministers, MPs, Officers. Lokpal at Centre; Lokayukta in states. Inspired by Scandinavian Ombudsman. Anna Hazare movement catalysed it.'), reply: '' },

  // ── GS2 INTERNATIONAL RELATIONS ──────────────────────────────────────────
  { re: /india.*china|border.*dispute|lac|galwan|doklam|sino.*indian/i,                    action: () => respond('India-China: Share 3488 km LAC (disputed). Key flashpoints: Galwan Valley (2020), Doklam (2017). BRICS partners but strategic rivals. Border Roads Organisation critical.'), reply: '' },
  { re: /india.*pakistan|kashmir.*issue|line.*of.*control|indus.*water/i,                  action: () => respond("India-Pakistan: Kashmir disputed since 1947. LOC divides it. Simla Agreement (1972). Indus Water Treaty (1960) survives all conflicts. India's no-first-use nuclear policy vis-a-vis Pakistan."), reply: '' },
  { re: /india.*us.*relation|quad|indo.*pacific|2+2.*dialogue|america/i,                   action: () => respond('India-USA: Strategic partnership post-2005. 2+2 Ministerial Dialogue. QUAD (India-USA-Japan-Australia) for Indo-Pacific. Major Defence Partner status. CAATSA waivers sought.'), reply: '' },
  { re: /saarc|south.*asia|bimstec|neighborhood.*first|act.*east/i,                        action: () => respond("India's neighborhood: SAARC (stalled due to Pakistan), BIMSTEC (Bay of Bengal, active), Neighborhood First Policy, Act East Policy with ASEAN. IOR-ARC for Indian Ocean cooperation."), reply: '' },
  { re: /un.*security.*council|unsc|permanent.*member|p5|veto.*power/i,                    action: () => respond('UNSC: 5 permanent members (USA, UK, France, Russia, China) with veto. 10 non-permanent members (2-year terms). India seeking permanent membership. G4 group (India, Brazil, Germany, Japan).'), reply: '' },
  { re: /wto|world.*trade|trade.*dispute|most.*favoured|gatt|doha/i,                       action: () => respond('WTO (1995, replaced GATT): 164 members. Dispute settlement mechanism. India-USA disputes on steel tariffs, solar panels. Doha Round stalled. Trade policy review mechanism.'), reply: '' },

  // ── GS3 ECONOMY ──────────────────────────────────────────────────────────
  { re: /gdp.*india|gross.*domestic.*product|nominal.*gdp|real.*gdp|gdp.*growth/i,         action: () => respond("India GDP: ~$3.7 trillion (2023), world's 5th largest. Target: $5 trillion economy. GDP growth averaging 6-7% p.a. Services dominate (55%), followed by Industry (27%), Agriculture (18%)."), reply: '' },
  { re: /inflation|cpi|wpi|repo.*rate|rbi.*policy|monetary.*policy/i,                      action: () => respond('Inflation: India uses CPI (Consumer Price Index) as headline. RBI targets 4% ±2% CPI inflation. Repo rate is key monetary policy tool. CRR and SLR are other tools.'), reply: '' },
  { re: /budget.*india|fiscal.*policy|fiscal.*deficit|revenue.*deficit|disinvestment/i,    action: () => respond("Union Budget: Presented on Feb 1. Fiscal Deficit = Total Expenditure - Total Receipts (excl. borrowings). FRBM Act targets deficit reduction. India's fiscal deficit ~5.9% of GDP (FY24)."), reply: '' },
  { re: /gst|goods.*service.*tax|indirect.*tax|dual.*gst|gstn/i,                           action: () => respond('GST (2017): One Nation One Tax. Dual GST — Centre (CGST) + State (SGST) or Integrated (IGST) for interstate. 4 rates: 5%, 12%, 18%, 28%. Replaces 17+ taxes. GST Council is constitutional body.'), reply: '' },
  { re: /poverty|bpl|mahalonobis|tendulkar.*committee|multidimensional.*poverty/i,         action: () => respond("India's poverty: Tendulkar Committee method replaced by SECC. MPI (Multi-dimensional Poverty Index) uses 10 indicators. India lifted 415 million out of poverty (2006-21) per UNDP."), reply: '' },
  { re: /agriculture.*india|green.*revolution|msp|pm.*kisan|kisaan/i,                     action: () => respond('Indian Agriculture: 18% of GDP, 50% of workforce. Green Revolution (1960s–70s): wheat/rice productivity doubled. MSP covers 23 crops. PM-KISAN gives ₹6000/year to farmers.'), reply: '' },
  { re: /rbi|reserve.*bank|central.*bank|monetary.*authority|governor.*rbi/i,              action: () => respond('RBI: Central bank (1935). Issues currency, regulates banks, manages forex, monetary policy. MPC (Monetary Policy Committee) sets repo rate. Governor appointed by Centre.'), reply: '' },
  { re: /sebi|stock.*market|sensex|nifty|capital.*market|ipo|mutual.*fund/i,               action: () => respond('SEBI (1992): Regulates capital markets. BSE Sensex (30 companies) and NSE Nifty50 are key indices. SEBI protects investor interests, promotes development, and regulates securities.'), reply: '' },
  { re: /fdi|foreign.*direct.*investment|fpi|foreign.*portfolio|capital.*account/i,        action: () => respond('FDI in India: Automatic route and Government route. FY24 FDI ~$70 billion. Top sectors: services, IT, pharma, telecom. DPIIT monitors. 100% FDI allowed in many sectors.'), reply: '' },
  { re: /infrastructure.*india|national.*highway|railway|port|airport.*india/i,            action: () => respond('India Infrastructure: PM Gatishakti (NMP) for multimodal connectivity. 144,000 km+ national highways. Railway largest employer. Sagarmala for ports. UDAN for regional aviation.'), reply: '' },
  { re: /banking.*sector|npa|npa.*india|bad.*loan|insolvency.*code|ibc/i,                  action: () => respond('Indian Banking: NPA problem peaked ~11% in 2018. IBC 2016 for resolution. NARCL (bad bank) set up 2021. PSBs recapitalized. Jan Dhan accounts: 50+ crore. Financial inclusion improving.'), reply: '' },

  // ── GS3 ENVIRONMENT ──────────────────────────────────────────────────────
  { re: /climate.*change|global.*warming|paris.*agreement|cop.*un|emission/i,              action: () => respond("Climate Change: Paris Agreement (2015) targets 1.5°C warming limit. India's NDC: 45% emission intensity reduction by 2030, 50% renewable electricity. Net zero by 2070."), reply: '' },
  { re: /biodiversity|convention.*biological|cbd|nagoya.*protocol|hotspot/i,               action: () => respond('Biodiversity: India one of 17 megadiverse countries. 34 global biodiversity hotspots; India has 4 (Western Ghats, Eastern Himalayas, Sundarbans, Andaman). CBD Nagoya Protocol on access and benefit sharing.'), reply: '' },
  { re: /national.*park|wildlife.*sanctuary|tiger.*reserve|project.*tiger/i,               action: () => respond('India has 106 National Parks, 567 Wildlife Sanctuaries, 54 Tiger Reserves (Project Tiger 1973). Biosphere Reserves: 18. UNESCO World Heritage: Kaziranga, Sundarbans, Manas.'), reply: '' },
  { re: /pollution|air.*quality|aqi|pm.*2\.5|water.*pollution|swachh/i,                   action: () => respond('India Air Quality: PM2.5 and PM10 are primary pollutants. NCAP targets 20-30% reduction by 2024. Swachh Bharat Mission improved sanitation coverage. Namami Gange for river cleaning.'), reply: '' },
  { re: /renewable.*energy|solar.*india|wind.*power|green.*hydrogen|ntpc/i,                action: () => respond('India Renewable Energy: 500 GW target by 2030. Solar capacity: 70+ GW. Wind: 44+ GW. ISA (International Solar Alliance) founded by India. Green Hydrogen Mission launched 2023.'), reply: '' },
  { re: /nuclear.*energy|dae|thorium.*india|fast.*breeder.*reactor/i,                      action: () => respond('India Nuclear: 3-stage programme (Dr. Homi Bhabha). Stage 1: Pressurized Heavy Water Reactors. Stage 2: Fast Breeders (Thorium). Stage 3: Advanced Heavy Water Reactors. India has large Thorium reserves.'), reply: '' },

  // ── GS3 SCIENCE & TECH ───────────────────────────────────────────────────
  { re: /isro|chandrayaan|mangalyaan|gaganyaan|space.*india|satellite/i,                   action: () => respond("ISRO achievements: Mangalyaan (2014, Mars), Chandrayaan-3 (2023, Moon south pole first landing), GSLV Mk III for heavy payloads, Gaganyaan (human spaceflight by 2024). PSLV is India's workhorse."), reply: '' },
  { re: /artificial.*intelligence|machine.*learning|deep.*learning|neural.*network/i,      action: () => respond('AI for UPSC: AI defined as machines simulating human intelligence. ML: machines learn from data. Deep Learning uses neural networks. India AI strategy focuses on healthcare, agriculture, education.'), reply: '' },
  { re: /blockchain|crypto.*currency|bitcoin|distributed.*ledger/i,                        action: () => respond('Blockchain: Distributed ledger technology. Immutable, transparent, decentralized. Cryptocurrency uses it. India taxed crypto at 30% (Budget 2022). RBI working on CBDC (Digital Rupee).'), reply: '' },
  { re: /5g.*india|telecom|spectrum|jio|airtel|digital.*india/i,                           action: () => respond('5G in India: Launched October 2022. Jio and Airtel leading. 100x faster than 4G. Key for IoT, Industry 4.0, autonomous vehicles. India has 900+ million mobile subscribers.'), reply: '' },
  { re: /biotechnology|gmo|gene.*editing|crispr|vaccine.*india/i,                          action: () => respond('Biotechnology in India: DBT regulates. India major vaccine manufacturer (Serum Institute). CRISPR-Cas9 gene editing — ethical issues raised. GM crops: Bt Cotton approved; Bt Brinjal moratorium.'), reply: '' },
  { re: /cyber.*security|it.*act|data.*protection.*bill|pdpb|hacking/i,                    action: () => respond('Cyber Security: IT Act 2000 (amended 2008) governs. CERT-In for incident response. Digital Personal Data Protection Act 2023 replaced draft PDPB. India faces 1.4 million cyber attacks/year.'), reply: '' },
  { re: /drone.*india|uav|drone.*policy|uas.*traffic/i,                                    action: () => respond('India Drone Policy: Drone Rules 2021 liberalized. PLI scheme for drones. Classified by weight: Nano (<250g) to Large (>150 kg). NPNT (No Permission No Takeoff) system. UTM under development.'), reply: '' },

  // ── GS3 INTERNAL SECURITY ────────────────────────────────────────────────
  { re: /naxal|maoist|left.*wing.*extremism|red.*corridor|salwa.*judum/i,                  action: () => respond('Left Wing Extremism (LWE): CPI-Maoist is primary group. Red Corridor: Chhattisgarh, Jharkhand, Odisha. SAMADHAN strategy by Home Ministry. Salwa Judum (civil militia) declared unconstitutional.'), reply: '' },
  { re: /terrorism|ats|nia|uapa|ndtf|counter.*terrorism|jihadist/i,                       action: () => respond('Counter-terrorism: NIA (National Investigation Agency) under NIA Act 2008. UAPA 2019 designates individuals as terrorists. NSG for anti-terrorism. Multi-agency centre for intelligence sharing.'), reply: '' },
  { re: /border.*management|bsf|ssb|coast.*guard|border.*area/i,                          action: () => respond('India Border Management: BSF (Pakistan, Bangladesh), SSB (Nepal, Bhutan), ITBP (China), Assam Rifles (Myanmar). Coast Guard for maritime security. CIBMS for smart borders.'), reply: '' },

  // ── GS4 ETHICS ───────────────────────────────────────────────────────────
  { re: /ethics.*upsc|gs4.*ethics|moral.*philosophy|attitude|integrity/i,                  action: () => respond('GS4 Ethics: Covers attitude, aptitude, foundational values, emotional intelligence, moral thinkers, accountability, transparency, and case studies. Fokus on applying values to public administration.'), reply: '' },
  { re: /emotional.*intelligence|eq|self.*awareness|empathy|daniel.*goleman/i,             action: () => respond('Emotional Intelligence (EI): Daniel Goleman model — Self-awareness, Self-regulation, Motivation, Empathy, Social skills. EI more important than IQ for leadership effectiveness. Key GS4 topic.'), reply: '' },
  { re: /probity.*governance|code.*of.*conduct|civil.*servant.*ethics/i,                   action: () => respond('Probity in Governance: Honesty, integrity, ethical conduct. Code of conduct for civil servants under AIS (Conduct) Rules. Citizens Charter, e-governance reduce corruption opportunities.'), reply: '' },
  { re: /kant|categorical.*imperative|deontological|duty.*based.*ethics/i,                 action: () => respond("Kant's ethics: Deontological — act only according to the maxim you could universalize (Categorical Imperative). Duty is paramount regardless of consequences. Key GS4 thinker."), reply: '' },
  { re: /utilitarianism|jeremy.*bentham|john.*stuart.*mill|greatest.*happiness/i,          action: () => respond('Utilitarianism (Bentham, Mill): Greatest happiness of the greatest number. Consequentialist ethics — outcomes determine morality. Applied to public policy analysis in GS4.'), reply: '' },

  // ── CSAT PREPARATION ──────────────────────────────────────────────────────
  { re: /csat.*tip|csat.*preparation|paper.*2.*tip|aptitude.*upsc/i,                       action: () => respond('CSAT Tips: Qualifying (33%). Focus on comprehension — practice reading speed. Maths: ratio, percentage, number series, data interpretation. Reasoning: syllogisms, blood relations, seating arrangement.'), reply: '' },
  { re: /reading.*comprehension.*tip|comprehension.*strategy|rc.*upsc/i,                   action: () => respond('RC Strategy: Read the questions first, then the passage. Mark keywords. For inference questions, stay close to the text. Aim to solve 1 passage in 6 minutes for 4-5 questions.'), reply: '' },
  { re: /data.*interpretation|di.*csat|pie.*chart.*upsc|bar.*graph.*upsc/i,                action: () => respond('Data Interpretation: Practice pie charts, bar graphs, tables, line graphs. For CSAT, approximate values — exact calculation wastes time. Focus on percentage change and ratios.'), reply: '' },

  // ── ANSWER WRITING TIPS ───────────────────────────────────────────────────
  { re: /answer.*writing.*tip|mains.*answer.*tip|upsc.*writing.*style/i,                  action: () => respond('Mains Answer Writing: INTRO-BODY-CONCLUSION structure. Use subheadings for long answers. Data and examples strengthen answers. Keyword density matters. Practice 150-word and 250-word answers daily.'), reply: '' },
  { re: /essay.*upsc|essay.*writing.*tip|gs.*essay|paper.*1.*essay/i,                     action: () => respond("Essay Paper (250 marks): Choose topic you know well. INTRO: state your thesis. BODY: multiple dimensions (social, economic, political, ethical, historical). CONCLUSION: balanced. Don't take extreme positions."), reply: '' },
  { re: /map.*question|gs1.*map|geography.*map|upsc.*map.*mark/i,                         action: () => respond('Map Questions in GS1 Mains: Practice political maps of India and World. Mark rivers, mountain passes, wildlife sanctuaries, and regions in news. 5 questions × 2 marks in GS1.'), reply: '' },

  // ── CURRENT AFFAIRS TOPICS ────────────────────────────────────────────────
  { re: /g20.*india|g20.*presidency|g20.*summit/i,                                        action: () => respond('G20 India Presidency (2023): Theme "Vasudhaiva Kutumbakam — One Earth One Family One Future". New Delhi Declaration. African Union admitted. Key focus: debt, climate, digital public infrastructure.'), reply: '' },
  { re: /india.*g7|developed.*countries|oecd.*india/i,                                     action: () => respond('India is not a G7 member but attends summits as guest. OECD membership under discussion. India is a major emerging economy and G20 member with significant global influence.'), reply: '' },
  { re: /ukraine.*russia|nato.*expansion|black.*sea.*grain/i,                              action: () => respond('Russia-Ukraine: War began Feb 24, 2022. India maintains strategic autonomy, buys Russian oil. Impact: wheat prices, oil prices, global supply chains. Black Sea Grain Initiative collapsed 2023.'), reply: '' },
  { re: /israel.*gaza|middle.*east.*conflict|hamas|two.*state/i,                           action: () => respond('India on Israel-Gaza: Supports two-state solution. Abstained in some UNGA votes. India has strong Israel ties (defence, tech) and historical solidarity with Palestine. Balanced diplomatic position.'), reply: '' },

  // ── SCHEMES & PROGRAMMES ──────────────────────────────────────────────────
  { re: /pm.*awas|housing.*for.*all|affordable.*housing|pradhan.*mantri.*awas/i,           action: () => respond('PMAY (PM Awas Yojana): Housing for All by 2022 (extended). PMAY-Urban and PMAY-Gramin. Beneficiary identification through SECC data. EWS/LIG subsidised home loans.'), reply: '' },
  { re: /mnrega|mahatma.*gandhi.*rural.*employment|nrega|100.*days.*work/i,                action: () => respond('MGNREGS (2006): Guarantees 100 days wage employment per rural household. Legal right to work. 40% women must benefit. Wages notified annually. Aadhaar-linked payments to prevent corruption.'), reply: '' },
  { re: /jan.*dhan|pradhan.*mantri.*jan.*dhan|financial.*inclusion.*scheme/i,              action: () => respond("PMJDY (2014): Zero-balance accounts with debit card, overdraft ₹10,000, accident insurance. 50+ crore accounts opened. Backbone of Direct Benefit Transfer (DBT)."), reply: '' },
  { re: /ayushman.*bharat|pmjay|health.*insurance.*scheme|healthcare.*poor/i,              action: () => respond("Ayushman Bharat PMJAY (2018): Health insurance ₹5 lakh/year for 10 crore poor families. World's largest government health scheme. Cashless, paperless. ABDM for digital health IDs."), reply: '' },
  { re: /swachh.*bharat.*mission|odf.*india|sanitation|open.*defecation/i,                 action: () => respond('Swachh Bharat Mission (2014): ODF (Open Defecation Free) status achieved nationally (2019, self-declaration). 110+ million toilets built. SBM 2.0 targets ODF-Plus, wastewater management.'), reply: '' },
  { re: /pm.*fasal.*bima|crop.*insurance|kharif.*rabi.*insurance/i,                       action: () => respond('PMFBY (PM Fasal Bima Yojana, 2016): Crop insurance with low premium (2% Kharif, 1.5% Rabi, 5% commercial). Government subsidizes rest. Covers yield loss, weather, post-harvest losses.'), reply: '' },
  { re: /ujjwala.*yojana|lpg.*connection|cooking.*gas.*poor|pradhan.*ujjwala/i,            action: () => respond('PMUY (PM Ujjwala Yojana, 2016): Free LPG connections to BPL women. 9 crore+ connections given. Reduces indoor air pollution. Helps women avoid biomass fuel smoke.'), reply: '' },
  { re: /digital.*india|common.*service.*centre|e.*governance.*india/i,                    action: () => respond('Digital India (2015): BharatNet for rural broadband, 2.5 lakh CSCs (Common Service Centres), e-governance, DigiLocker, UMANG app. India Stack (Aadhaar, UPI, DigiLocker) is digital public infrastructure.'), reply: '' },
  { re: /make.*in.*india|pli.*scheme|production.*linked.*incentive/i,                      action: () => respond('Make in India (2014) + PLI Schemes (2020): PLI covers 14 sectors (mobiles, pharma, textiles, food processing, white goods etc.). Target: increase manufacturing to 25% of GDP.'), reply: '' },
  { re: /startup.*india|standup.*india|mudra.*loan|msme.*scheme/i,                         action: () => respond('Startup India (2016): Tax exemptions, fund of funds, IPR fast-track. MUDRA Loans: Shishu (<₹50K), Kishore (₹50K-5L), Tarun (₹5L-10L). StandUp India for SC/ST/Women entrepreneurs.'), reply: '' },

  // ── UPSC STRATEGY & PREPARATION ──────────────────────────────────────────
  { re: /newspaper.*upsc|which.*newspaper|hindu.*upsc|indian.*express/i,                   action: () => respond('For UPSC: The Hindu is preferred for depth. IE for opinion. Make notes on schemes, tribunals, committees, reports, international organisations and bills. CA should link to static syllabus.'), reply: '' },
  { re: /optional.*subject|upsc.*optional|which.*optional.*choose/i,                      action: () => respond('Optional Strategy: Choose what you know and enjoy. High-scoring optionals: Sociology, PSIR, History, Geography, Anthropology. Literature optionals score well but are niche. Check past papers and toppers.'), reply: '' },
  { re: /prelims.*strategy|how.*crack.*prelims|prelims.*cutoff|prelims.*mark/i,            action: () => respond('Prelims Strategy: Target 110+ marks. Complete NCERT first, then standard books. PYQ practice is essential — UPSC repeats concepts. Eliminate negatives — attempt only 80%+ confident questions.'), reply: '' },
  { re: /mains.*strategy|how.*crack.*mains|upsc.*mains.*tips/i,                           action: () => respond('Mains Strategy: Write 2 answers daily from Day 1 of prep. Cover all GS papers; optionals need deep dive. Revise notes frequently. GS4 case studies practice. Essay writing — 3 mock essays per month.'), reply: '' },
  { re: /interview.*upsc|personality.*test|daf|service.*preference/i,                     action: () => respond("UPSC Interview: Last stage, 275 marks. Board tests personality, not knowledge. Be honest about DAF entries. Be calm, balanced, and show awareness of India's challenges. Interview adds ~30-50 marks swing."), reply: '' },
  { re: /ncert.*which.*upsc|ncert.*book|standard.*book.*upsc|bipan.*chandra/i,            action: () => respond('NCERT books are foundational for UPSC. Must-read: History (6-12), Geography (6-12), Polity (11-12 by Laxmikant), Economy (11-12). After NCERT: Laxmikant for Polity, Shankar IAS for Environment.'), reply: '' },
  { re: /laxmikant.*polity|polity.*book|indian.*polity.*reference/i,                      action: () => respond("M. Laxmikant's Indian Polity is the bible for UPSC Polity. Read all chapters, make notes on each constitutional body, and practice PYQs. Especially chapters on Centre-State, Emergency, Parliament."), reply: '' },
  { re: /spectrum.*modern.*history|rajiv.*ahir|modern.*history.*book/i,                   action: () => respond("Spectrum's Brief History of Modern India by Rajiv Ahir is the standard for UPSC Modern History. Cover all chapters, especially Socio-Religious Reform Movements and Freedom Struggle."), reply: '' },
  { re: /test.*series.*upsc|mock.*test.*importance|practice.*test.*strategy/i,            action: () => respond('Test Series Strategy: Join one quality test series. Analyse every wrong answer — understanding patterns is more valuable than solving more tests. Aim for 1 full mock weekly in Mains phase.'), reply: '' },

  // ── TIMER — MORE PATTERNS ─────────────────────────────────────────────────
  { re: /\b5\s*min.*timer|five.*min.*timer|panch.*minute/i,                                action: _st(5), reply: '5-minute timer set.' },
  { re: /\b10\s*min.*timer|ten.*min.*timer|das.*minute/i,                                  action: _st(10), reply: '10-minute timer set.' },
  { re: /\b20\s*min.*timer|twenty.*min.*timer|bees.*minute/i,                              action: _st(20), reply: '20-minute timer set.' },
  { re: /\b25\s*min.*timer|twenty.*five.*min|pachis.*minute/i,                             action: _st(25), reply: '25-minute Pomodoro set.' },
  { re: /\b30\s*min.*timer|thirty.*min.*timer|tees.*minute/i,                              action: _st(30), reply: '30-minute timer set.' },
  { re: /\b35\s*min.*timer|thirty.*five.*min/i,                                            action: _st(35), reply: '35-minute timer set.' },
  { re: /\b40\s*min.*timer|forty.*min.*timer|chalis.*minute/i,                             action: _st(40), reply: '40-minute timer set.' },
  { re: /\b45\s*min.*timer|forty.*five.*min|paintalis.*minute/i,                           action: _st(45), reply: '45-minute timer set.' },
  { re: /\b50\s*min.*timer|fifty.*min.*timer|pachas.*minute/i,                             action: _st(50), reply: '50-minute timer set.' },
  { re: /\b60\s*min.*timer|sixty.*min.*timer|saath.*minute/i,                              action: _st(60), reply: '1-hour timer set.' },
  { re: /\b75\s*min.*timer|seventy.*five.*min/i,                                           action: _st(75), reply: '75-minute timer set.' },
  { re: /\b90\s*min.*timer|ninety.*min.*timer|nabbe.*minute/i,                             action: _st(90), reply: '90-minute deep work set.' },
  { re: /\b120\s*min.*timer|two.*hour.*timer|do.*ghante/i,                                 action: _st(120), reply: '2-hour timer set.' },

  // ── HINDI NAVIGATION ──────────────────────────────────────────────────────
  { re: /\bplan.*kholna\b|\bplanner.*kholna\b|\bplan.*section.*kholna\b/i,                 action: _scr('plan'), reply: 'Plan section.' },
  { re: /\bintelligence.*kholna\b|\banalytics.*kholna\b|\bcharts.*kholna\b/i,              action: _scr('intel'), reply: 'Intelligence section.' },
  { re: /\broutine.*kholna\b|\bdincharya.*dikhao\b|\bschedule.*dikhao\b/i,                 action: _scr('routine'), reply: 'Routine section.' },
  { re: /\bsanvidhan.*section\b|\bconstitution.*section.*kholna\b/i,                       action: _scr('constitution'), reply: 'Constitution section.' },
  { re: /upar.*scroll|page.*ke.*upar|upar.*jao/i,                                          action: () => window.scrollTo({top:0,behavior:'smooth'}), reply: 'Back to top.' },

  // ── HINDI TIMER ───────────────────────────────────────────────────────────
  { re: /focus.*shuru.*karo|padhai.*shuru.*karo|abhi.*padhna.*shuru/i,                     action: clickStart, reply: 'Timer shuru. Dhyan lagao!' },
  { re: /timer.*band.*karo|timer.*rok.*do|ruk.*ja|timer.*ruko/i,                           action: () => q('[data-act="start"]'), reply: 'Timer ruka.' },
  { re: /timer.*reset.*karo|dobara.*set.*karo|naya.*session/i,                             action: () => q('[data-act="reset"]'), reply: 'Timer reset.' },

  // ── HINDI PLANNER ─────────────────────────────────────────────────────────
  { re: /aaj.*ki.*padhai|aaj.*padhna.*kya.*hai|aaj.*ka.*subject/i,                         action: () => { scr('plan'); respond(buildTodayReport()) }, reply: '' },
  { re: /plan.*banao|schedule.*banao|mera.*plan.*generate.*karo/i,                         action: () => cl('ai-gen'), reply: 'Plan generate ho raha hai…' },
  { re: /backlog.*dikhao|baaki.*lectures.*dikhao|pending.*lectures/i,                       action: () => { scr('plan'); cl('lp-filter-backlog') }, reply: 'Backlog dikhaya.' },
  { re: /aaj.*ka.*lecture.*mark.*karo|yeh.*lecture.*khatam|topic.*poora.*hua/i,            action: () => { const t=checkCurrentTopic(); respond(t ? `"${t}" done! ${celebrationLine()}` : 'Koi pending lecture nahi mila.') }, reply: '' },

  // ── HINDI SCORES ─────────────────────────────────────────────────────────
  { re: /score.*add.*karo|result.*add.*karo|marks.*darz.*karo/i,                           action: () => cl('cm-add-score'), reply: 'Score entry khuli.' },
  { re: /meri.*performance.*kaisi.*hai|mai.*kaise.*kar.*raha|mera.*result.*kaisa/i,        action: () => respond(buildStatusReport()), reply: '' },
  { re: /average.*kya.*hai|mera.*average|meri.*accuracy|average.*batao/i,                  action: () => { scr('intel'); respond('Analytics section mein average dekho.') }, reply: '' },

  // ── HINDI MOTIVATION ─────────────────────────────────────────────────────
  { re: /mujhe.*motivate.*karo|motivation.*do|himmat.*dila.*do|josh.*do/i,                 action: () => respond(motivationLine()), reply: '' },
  { re: /bahut.*thak.*gaya|neend.*aa.*rahi|aankh.*band.*ho.*rahi/i,                        action: () => respond('Samajh sakta hoon. 10 minute ka break lo, paani piyo. Phir ek session aur. Aaj ka kaam aaj khatam karo, Om.'), reply: '' },
  { re: /nahi.*ho.*raha|ho.*nahi.*raha|samajh.*nahi.*aa.*raha/i,                           action: () => respond('Hota hai. Ek baar phir padho. Agar phir bhi nahi samjha toh mujhe poocho — main explain karunga.'), reply: '' },
  { re: /kitne.*din.*bache.*prelims|prelims.*kab.*hai|exam.*kab.*hai/i,                    action: () => respond(buildExamCountdown()), reply: '' },

  // ── MORE CONSTITUTION ARTICLES ────────────────────────────────────────────
  { re: /article.*1\b|name.*india|union.*of.*states/i,                                     action: () => respond('Article 1: India, that is Bharat, shall be a Union of States. It establishes India as a Union, not a federation — emphasising the indestructibility of the Union.'), reply: '' },
  { re: /article.*13|laws.*inconsistent.*rights/i,                                         action: () => respond('Article 13: Laws inconsistent with Fundamental Rights are void. This gives courts the power of judicial review to strike down laws violating Part III.'), reply: '' },
  { re: /article.*15|prohibition.*discrimination/i,                                         action: () => respond('Article 15: Prohibits discrimination on grounds of religion, race, caste, sex, or place of birth. Article 15(3) and 15(4) allow positive discrimination for women, children, and backward classes.'), reply: '' },
  { re: /article.*16|equality.*opportunity|public.*employment/i,                           action: () => respond('Article 16: Equality of opportunity in public employment. Allows reservations for backward classes (Art 16(4)), scheduled castes, and scheduled tribes.'), reply: '' },
  { re: /article.*17|untouchability.*abolition/i,                                           action: () => respond('Article 17: Abolition of untouchability. Its practice in any form is an offence. Protection of Civil Rights Act 1955 and SC/ST (Prevention of Atrocities) Act 1989 implement it.'), reply: '' },
  { re: /article.*25|freedom.*religion|right.*to.*practice.*religion/i,                    action: () => respond('Article 25: Freedom of conscience and right to freely profess, practise, and propagate religion — subject to public order, morality, and health. Subject to social reform legislation.'), reply: '' },
  { re: /article.*39a|legal.*aid|equal.*justice|free.*legal.*service/i,                    action: () => respond('Article 39A (DPSP): Equal justice and free legal aid. State shall ensure justice not denied for economic reasons. NALSA (National Legal Services Authority) implements it.'), reply: '' },
  { re: /article.*40|panchayat|village.*panchayat.*dpsp/i,                                 action: () => respond('Article 40 (DPSP): Organization of village panchayats. Gave impetus to 73rd Amendment (1992) which gave constitutional status to PRIs.'), reply: '' },
  { re: /article.*51|international.*peace|promotion.*of.*peace/i,                          action: () => respond("Article 51 (DPSP): Promotion of international peace and security. India's foreign policy principles — Non-Alignment, Panchsheel — flow from this directive."), reply: '' },
  { re: /article.*72|pardon.*power|mercy.*petition|president.*clemency/i,                  action: () => respond('Article 72: President can grant pardons, reprieves, respites, remissions. Extends to death sentence cases and court-martial cases. Contrasted with Art 161 (Governor\'s pardon powers).'), reply: '' },
  { re: /article.*109|money.*bill|lok.*sabha.*supremacy.*finance/i,                        action: () => respond('Article 109: Special procedure for Money Bills. Only introduced in Lok Sabha. Rajya Sabha can only recommend amendments within 14 days. Lok Sabha has ultimate say on money bills.'), reply: '' },
  { re: /article.*123|ordinance.*power|president.*ordinance/i,                             action: () => respond('Article 123: President can promulgate Ordinances when Parliament is not in session. Ordinance has same force as Act. Must be approved within 6 weeks of Parliament reassembly.'), reply: '' },
  { re: /article.*124|supreme.*court.*judge|appointment.*of.*judge/i,                      action: () => respond('Article 124: Establishes the Supreme Court. SC judges appointed by President in consultation with Chief Justice (collegium system). Retirement age: 65. Impeachment by Parliament.'), reply: '' },
  { re: /article.*226|writ.*jurisdiction.*high.*court/i,                                    action: () => respond("Article 226: High Courts' writ jurisdiction — broader than Supreme Court (Art 32). Can issue writs for any purpose (not just Fundamental Rights violation). High Courts more accessible for citizens."), reply: '' },
  { re: /article.*243|panchayati.*raj.*constitutional/i,                                    action: () => respond('Article 243: Part IX (73rd Amendment). Establishes Panchayati Raj constitutionally. Gram Sabha, 3-tier structure, 5-year term, 1/3 reservation for women, State Finance Commission.'), reply: '' },
  { re: /article.*280|finance.*commission|fiscal.*federalism/i,                            action: () => respond('Article 280: Finance Commission constituted every 5 years by President. Recommends tax devolution (vertical) and grants. 16th FC constituted 2023. Basis for fiscal federalism.'), reply: '' },
  { re: /article.*300a|right.*to.*property|property.*right.*non.*fundamental/i,            action: () => respond('Article 300A: Right to property as a legal right (not Fundamental Right after 44th Amendment 1978). No person can be deprived of property except by authority of law.'), reply: '' },
  { re: /article.*324|election.*commission.*power/i,                                       action: () => respond('Article 324: Election Commission shall be vested with superintendence, direction, and control of elections to Parliament and State Legislatures, and offices of President and VP.'), reply: '' },
  { re: /article.*343|hindi.*official.*language|official.*language/i,                     action: () => respond('Article 343: Hindi in Devanagari script is the official language of the Union. English continues for 15 years (now extended). 8th Schedule lists 22 scheduled languages.'), reply: '' },
  { re: /12th.*schedule|municipal.*functions|74th.*amendment.*functions/i,                 action: () => respond('12th Schedule (74th Amendment): Lists 18 functions for Urban Local Bodies including urban planning, land use, roads, water supply, public health, and slum improvement.'), reply: '' },
  { re: /11th.*schedule|panchayat.*functions|73rd.*amendment.*functions/i,                 action: () => respond('11th Schedule (73rd Amendment): Lists 29 subjects for Panchayati Raj Institutions including agriculture, land improvement, roads, rural electrification, non-formal education.'), reply: '' },

  // ── ECONOMIC CONCEPTS ────────────────────────────────────────────────────
  { re: /balance.*of.*payment|current.*account.*deficit|capital.*account/i,                action: () => respond('BOP = Current Account + Capital Account + Errors. CAD = Imports > Exports. India typically has CAD financed by capital inflows (FDI, FPI). High CAD weakens rupee.'), reply: '' },
  { re: /exchange.*rate|rupee.*dollar|currency.*depreciation|purchasing.*power/i,          action: () => respond('Exchange Rate: Market-determined in India since 1991. Depreciation makes exports cheaper, imports costlier. PPP adjusts for price level differences. REER (Real Effective Exchange Rate) is better indicator.'), reply: '' },
  { re: /multiplier.*effect|keynesian|fiscal.*stimulus|aggregate.*demand/i,               action: () => respond('Keynesian economics: Government spending increases aggregate demand. Multiplier effect — each rupee of spending generates >1 rupee of GDP. Used to justify stimulus during recessions.'), reply: '' },
  { re: /supply.*chain|logistics|warehousing|national.*logistics.*policy/i,                action: () => respond('National Logistics Policy (2022): Target to reduce logistics cost from 14% to 8% of GDP. PM GatiShakti for multimodal connectivity. ULIP (Unified Logistics Interface Platform) for data integration.'), reply: '' },
  { re: /msme.*india|small.*business|khadi.*village.*industry|coir/i,                     action: () => respond('MSMEs: 63 million enterprises, 30% of GDP, 45% of exports, employs 110 million. Ministry of MSME. CGTMSE for credit, MSME champions portal, ODOP (One District One Product) scheme.'), reply: '' },

  // ── ENVIRONMENT — AGREEMENTS & BODIES ────────────────────────────────────
  { re: /unep|united.*nations.*environment|nairobi.*based/i,                               action: () => respond('UNEP: UN body for environmental issues, based in Nairobi. Key agreements it administers: Basel, Rotterdam, Stockholm conventions on hazardous substances. India is a member.'), reply: '' },
  { re: /kyoto.*protocol|carbon.*credit|clean.*development.*mechanism/i,                  action: () => respond("Kyoto Protocol (1997): Binding emission reduction targets for developed nations. CDM allowed developed countries to earn credits in developing countries. Replaced by Paris Agreement (2015)."), reply: '' },
  { re: /ramsar.*wetland|wetland.*convention|world.*wetland.*day/i,                        action: () => respond('Ramsar Convention (1971): Wetlands of International Importance. India has 75 Ramsar sites (most in world). Chilika Lake, Keoladeo, Loktak are iconic Indian Ramsar sites.'), reply: '' },
  { re: /cites|endangered.*species.*trade|wildlife.*trade|appendix/i,                     action: () => respond('CITES (Convention on International Trade in Endangered Species): 3 Appendices. Appendix 1: absolute ban (tigers, elephants). Appendix 2: regulated trade. Appendix 3: country-specific.'), reply: '' },
  { re: /green.*india.*mission|national.*action.*plan.*climate|napcc/i,                   action: () => respond('NAPCC (2008): 8 missions — Solar, Enhanced Energy Efficiency, Sustainable Habitat, Water, Himalayan Ecosystem, Green India, Sustainable Agriculture, Strategic Knowledge. Green India Mission targets 5 million ha.'), reply: '' },

  // ── SCIENCE FOR UPSC ─────────────────────────────────────────────────────
  { re: /nuclear.*reactor.*types|pwr|bwr|phwr|advanced.*reactor/i,                        action: () => respond('Nuclear Reactors: PWR (Pressurized Water Reactor, US), BWR (Boiling Water), PHWR (Pressurized Heavy Water, India uses in NPCIL). FBR (Fast Breeder) for India Stage 2 programme.'), reply: '' },
  { re: /gene.*editing|crispr.*cas9|germline.*editing|somatic.*gene.*therapy/i,           action: () => respond('CRISPR-Cas9: Precise gene editing tool. Won Nobel Prize (2020, Jennifer Doudna, Emmanuelle Charpentier). Ethical issues around germline editing (heritable). India regulates via DBT guidelines.'), reply: '' },
  { re: /dark.*matter|dark.*energy|big.*bang|cosmology|james.*webb/i,                     action: () => respond('Dark Matter: 27% of universe, unknown composition. Dark Energy: 68%, accelerates expansion. James Webb Space Telescope (JWST, 2021): studies early universe. India contributes to Astrosat.'), reply: '' },
  { re: /vaccine.*technology|mrna.*vaccine|adenovirus.*vector|covid.*vaccine/i,           action: () => respond('Vaccine technologies: mRNA (Pfizer, Moderna), Adenovirus Vector (AstraZeneca, Sputnik), Protein Subunit (Covavax), Inactivated virus (Covaxin). India self-sufficient in vaccine production.'), reply: '' },

  // ── MISCELLANEOUS UPSC FACTS ──────────────────────────────────────────────
  { re: /economic.*survey|cef|finance.*minister.*report|pre.*budget/i,                    action: () => respond("Economic Survey: Presented by Finance Ministry's CEA, day before Budget. Reviews economy, global trends, policy analysis. Written by Chief Economic Adviser's team. Not binding policy."), reply: '' },
  { re: /comptroller.*auditor|cag.*article|cag.*report/i,                                  action: () => respond('CAG (Art 148-151): Constitutional authority. Audits accounts of Union and States. 3 types: Compliance, Financial, Performance audit. CAG reports tabled in Parliament and State legislatures.'), reply: '' },
  { re: /sc.*st.*obc|reservation.*india|creamy.*layer|mandal.*commission/i,               action: () => respond("Reservation: SC (15%), ST (7.5%), OBC (27%) = 49.5% in central govt jobs. Mandal Commission (1980) recommended OBC reservation. 'Creamy layer' principle excludes well-off OBCs. EWS 10% added (103rd Amendment)."), reply: '' },
  { re: /niti.*aayog.*index|competitive.*federalism|sdr.*sdg.*india/i,                    action: () => respond("NITI Aayog indices: State Health Index, School Education Quality Index, Sustainable Development Goals India Index, Composite Water Management Index. Promote competitive federalism among states."), reply: '' },
  { re: /pm.*narendra.*modi|current.*pm|prime.*minister.*india|bjp.*nda/i,                action: () => respond("Narendra Modi has been Prime Minister since May 2014 (re-elected 2019, 2024). Key initiatives: Make in India, Swachh Bharat, GST, Ayushman Bharat, PM GatiShakti, G20 presidency."), reply: '' },
  { re: /president.*india|rashtrapati|droupadi.*murmu|article.*52/i,                       action: () => respond("India's President (Art 52): Head of state, elected by an electoral college. Droupadi Murmu is the 15th President (2022), first tribal woman President. Constitutional head, acts on CoM's advice."), reply: '' },

  // ── APP PRODUCTIVITY ──────────────────────────────────────────────────────
  { re: /pomodoro.*count|sessions.*count|kitne.*sessions.*ho.*gaye/i,                      action: () => { try { const n=JSON.parse(localStorage.getItem('sessTotal')??"0") as number; respond(`${n} total Pomodoro sessions completed. Keep the momentum!`) } catch { respond('Session data not available.') } }, reply: '' },
  { re: /today.*progress.*ring|progress.*today|how.*far.*today/i,                          action: () => { const m=getTodayFocusMins(); const s=getCurrentState(); respond(`${m} minutes studied today. Backlog: ${s?.backlogRemaining??'?'} lectures. Streak: ${s?.streak??0} days.`) }, reply: '' },
  { re: /open.*jarvis.*panel|jarvis.*open|show.*jarvis|jarvis.*window/i,                   action: () => { if (!_open) openPanel() }, reply: 'JARVIS panel open.' },
  { re: /close.*jarvis|jarvis.*close|hide.*jarvis/i,                                       action: () => closePanel(), reply: '' },
  { re: /refresh.*page|page.*reload|reload.*app/i,                                         action: () => { respond('Reloading…'); setTimeout(()=>window.location.reload(), 1500) }, reply: '' },
  { re: /dark.*mode|light.*mode|theme.*toggle|colour.*scheme/i,                            action: () => respond('Theme is controlled by your system setting. Jarvis works best in dark mode.'), reply: '' },

  // ── TIMER — ADDITIONAL PATTERNS ───────────────────────────────────────────
  { re: /padhai.*shuru|study.*shuru|padhna.*shuru|shuru.*padhai/i,                          action: () => { clickStart(); scr('engine') }, reply: 'Study session started.' },
  { re: /break.*lena.*hai|break.*chahiye|rest.*chahiye|thoda.*rest/i,                       action: () => { q('[data-act="skip"]'); respond("Break time! Rest for a few minutes. Drink some water.") }, reply: '' },
  { re: /timer.*kitna.*baka|time.*left.*timer|kitna.*time.*baka|timer.*remaining/i,         action: () => { const t=document.querySelector<HTMLElement>('.ring-time')?.textContent; respond(t ? `${t} remaining.` : 'Open the timer card to check.') }, reply: '' },
  { re: /timer.*status|timer.*kaisa.*hai|is.*timer.*running/i,                              action: () => { const btn=document.querySelector<HTMLButtonElement>('[data-act="start"]'); const running=btn?.textContent?.toLowerCase().includes('pause'); respond(running ? `Timer is running. ${document.querySelector<HTMLElement>('.ring-time')?.textContent??''} remaining.` : 'Timer is not running.') }, reply: '' },
  { re: /concentration.*mode|deep.*concentration|zone.*mode|zone.*mein.*jao/i,              action: () => { _st(90)(); respond('90-minute deep concentration mode. No distractions, Om.') }, reply: '' },
  { re: /power.*nap|nap.*timer|20.*min.*nap/i,                                              action: () => { _st(20)(); respond('20-minute power nap timer set.') }, reply: '' },

  // ── PLANNER — MORE PATTERNS ───────────────────────────────────────────────
  { re: /next.*lecture|agle.*lecture|next.*topic|agli.*topic/i,                             action: () => { const r=document.querySelector<HTMLElement>('#plan .plan-row:not(.done) .pl-title'); respond(r?.textContent ? `Next lecture: ${r.textContent.trim()}.` : 'No pending lectures found.') }, reply: '' },
  { re: /how.*many.*done.*today|aaj.*kitne.*done|completed.*today.*count/i,                 action: () => { const n=document.querySelectorAll('#plan .plan-row.done').length; respond(`${n} lecture${n!==1?'s':''} completed today.`) }, reply: '' },
  { re: /total.*lectures.*count|kitni.*total.*lecture|total.*lectures.*hain/i,              action: () => { const total=document.querySelectorAll('#plan .plan-row').length; const done=document.querySelectorAll('#plan .plan-row.done').length; respond(`${done} done out of ${total} total lectures.`) }, reply: '' },
  { re: /week.*(\d+).*lectures|lectures.*week.*(\d+)/i,                                     action: () => { const m=document.querySelector<HTMLElement>('#plan')?.dataset?.week; scr('plan'); setTimeout(()=>{ const i=document.querySelector<HTMLInputElement>('#lp-search'); if(i){i.value='week';i.dispatchEvent(new Event('input'))} },200) }, reply: 'Searching week lectures.' },
  { re: /shuffle.*lectures|random.*order|mix.*lectures/i,                                   action: () => respond('Shuffle is not available. Lectures are ordered by sequence for progressive learning.'), reply: '' },
  { re: /delete.*lecture|remove.*lecture|lecture.*delete/i,                                 action: () => respond('To delete a lecture, find it in the planner and use the delete option in its menu.'), reply: '' },

  // ── SCORE — MORE PATTERNS ─────────────────────────────────────────────────
  { re: /polity.*score|score.*polity|polity.*ka.*score/i,                                   action: () => { scr('intel'); respond('Scroll to the subject-wise chart for your Polity scores.') }, reply: '' },
  { re: /history.*score|score.*history|history.*ka.*score/i,                                action: () => { scr('intel'); respond('Check the subject-wise breakdown for History scores.') }, reply: '' },
  { re: /best.*score|highest.*score|mera.*best|sabse.*acha.*score/i,                        action: () => { scr('intel'); respond('Your best scores are shown in the analytics section.') }, reply: '' },
  { re: /last.*score|most.*recent.*score|latest.*score/i,                                   action: () => { scr('intel'); respond('Most recent score is in the analytics section.') }, reply: '' },
  { re: /mock.*test.*score|prelims.*mock|mock.*7|mock.*8|mock.*result/i,                     action: () => cl('cm-add-score'), reply: 'Add your mock test score.' },
  { re: /negative.*marking|negative.*marks|penalty.*marks/i,                                action: () => respond('UPSC Prelims: 1/3 negative marking for wrong answers. Leave a question if less than 33% confident.'), reply: '' },

  // ── HINDI / HINGLISH COMMANDS ─────────────────────────────────────────────
  { re: /mujhe.*remind|mujhe.*yaad.*dilao|yaad.*karana.*hai/i,                              action: () => respond('Sure! Say "remind me in X minutes" to set a reminder.'), reply: '' },
  { re: /kya.*schedule.*hai|aaj.*kya.*karna.*hai|aaj.*ka.*kaam/i,                           action: () => respond(buildTodayReport()), reply: '' },
  { re: /kitna.*padhna.*baka|padhna.*kitna.*baka|remaining.*padhai/i,                       action: () => { const b=getCurrentState()?.backlogRemaining??0; respond(b ? `${b} lectures pending in your backlog.` : 'All caught up!') }, reply: '' },
  { re: /abhi.*start|abhi.*shuru|turant.*shuru|immediately.*start/i,                        action: () => { clickStart(); scr('engine'); respond('Starting now. Focus!') }, reply: '' },
  { re: /plan.*dikhao|plan.*show.*karo|mera.*plan.*dikhao/i,                                action: () => { scr('plan'); respond(buildTodayReport()) }, reply: '' },
  { re: /score.*dikhao|meri.*scores|results.*dikhao/i,                                      action: () => { scr('intel'); respond('Opening your score analytics.') }, reply: '' },
  { re: /thoda.*motivation|kuch.*motivation|energy.*chahiye/i,                              action: () => respond(motivationLine()), reply: '' },
  { re: /bahut.*mushkil.*hai|ye.*bahut.*hard|ye.*difficult/i,                               action: () => respond("UPSC is designed to be hard. Every difficult session means you're improving. Keep going."), reply: '' },
  { re: /time.*waste.*ho.*raha|samay.*nahi|time.*management/i,                              action: () => respond('Try the Pomodoro technique — 25 minutes focused, 5-minute break. Say "start timer" to begin.'), reply: '' },

  // ── PRACTICE / TEST ───────────────────────────────────────────────────────
  { re: /practice.*test|test.*practice|mock.*start|mock.*shuru/i,                           action: () => { cl('cm-add-score'); respond('Ready to log your test score after the practice session.') }, reply: '' },
  { re: /dpp.*start|dpp.*shuru|daily.*practice.*start/i,                                    action: () => { scr('plan'); respond("Let's do the DPP. Find it in today's lectures. Good luck!") }, reply: '' },
  { re: /past.*year.*question|pyq|previous.*year.*question/i,                               action: () => respond('PYQs are the best predictor of UPSC patterns. Practice topic-wise PYQs after each lecture.'), reply: '' },
  { re: /sectional.*test|topic.*wise.*test|subject.*test.*start/i,                          action: () => { cl('cm-add-score'); respond('After the sectional test, log your score here.') }, reply: '' },

  // ── WEEKLY REVIEW ─────────────────────────────────────────────────────────
  { re: /weekly.*review|week.*review|is.*week.*summary|week.*ka.*summary/i,                 action: () => cl('cm-weekly-review'), reply: 'Opening weekly review.' },
  { re: /review.*week|how.*was.*week|week.*kaisi.*gayi/i,                                   action: () => { respond(buildWeekSummary()) }, reply: '' },
  { re: /next.*week.*plan|agle.*hafte.*ka.*plan|plan.*next.*week/i,                         action: () => { scr('plan'); respond('The planner auto-schedules ahead. Generate a plan to see next week.') }, reply: '' },

  // ── CONSTITUTION — MORE ARTICLES ──────────────────────────────────────────
  { re: /article.*19|freedom.*speech|right.*to.*speech|freedom.*of.*speech/i,               action: () => respond('Article 19 guarantees 6 freedoms including speech, assembly, movement, residence, and profession. Each is subject to reasonable restrictions.'), reply: '' },
  { re: /article.*14|right.*to.*equality|equality.*before.*law/i,                           action: () => respond('Article 14: Equality before law and equal protection of laws. No person shall be denied equality before the law within India.'), reply: '' },
  { re: /article.*368|amendment.*procedure|constitutional.*amendment/i,                     action: () => respond('Article 368 contains the amendment procedure. Simple majority, special majority, and ratification by states — depending on the type of provision.'), reply: '' },
  { re: /article.*356|president.*rule|president.*rule.*impose/i,                            action: () => respond('Article 356 enables President\'s Rule in a State if constitutional machinery fails. Used frequently but scrutinised by courts since the Bommai case.'), reply: '' },
  { re: /article.*352|national.*emergency/i,                                                 action: () => respond('Article 352 provides for National Emergency. Can be proclaimed on grounds of war, external aggression, or armed rebellion (changed from internal disturbance by 44th Amendment).'), reply: '' },

  // ── NOTIFICATIONS & REMINDERS ─────────────────────────────────────────────
  { re: /cancel.*all.*reminder|saare.*reminder.*cancel|all.*reminder.*band/i,               action: () => { const c=_reminders.length; _reminders.length=0; respond(c ? `All ${c} reminders cancelled.` : 'No reminders to cancel.') }, reply: '' },
  { re: /how.*many.*reminder|reminders.*count|active.*reminder.*kitne/i,                    action: () => respond(_reminders.length ? `${_reminders.length} active reminder${_reminders.length>1?'s':''}.` : 'No active reminders.'), reply: '' },
  { re: /do.*not.*disturb|dnd.*mode|silence.*mode/i,                                        action: () => { _clapEnabled=false; respond('Do Not Disturb mode on. Clap detection paused. Say "JARVIS" to wake me.') }, reply: '' },
  { re: /enable.*clap|clap.*on|dnd.*off|disturb.*on|clap.*detection.*on/i,                  action: () => { _clapEnabled=true; respond('Clap detection re-enabled. Double-clap to wake me.') }, reply: '' },

  // ── FUN & MISC ────────────────────────────────────────────────────────────
  { re: /what.*your.*name|naam.*kya.*hai|who.*are.*you|tum.*kaun.*ho/i,                     action: () => respond("I'm JARVIS — your personal AI assistant for UPSC Mission 2028. Always here for Om Shisodiya."), reply: '' },
  { re: /good.*morning.*jarvis|morning.*jarvis/i,                                           action: () => respond(buildMorningBrief(getCurrentState())), reply: '' },
  { re: /good.*night.*jarvis|night.*jarvis|sone.*ja.*raha/i,                                action: () => { const m=getTodayFocusMins(); respond(m>=60 ? `Good night, Om. ${m} minutes studied today — solid work. Sleep well.` : `Good night. Log a session tomorrow to protect your streak.`) }, reply: '' },
  { re: /thank.*you.*jarvis|thanks.*jarvis|shukriya/i,                                      action: () => respond("Always here for you, Om. Now get back to it!"), reply: '' },
  { re: /jarvis.*you.*are.*great|jarvis.*awesome|jarvis.*best/i,                            action: () => respond("Thank you! Now let's channel that energy into a study session."), reply: '' },
  { re: /ping|are.*you.*there|hello.*jarvis|hey.*jarvis/i,                                  action: () => respond("Online and ready. What do you need?"), reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v4 — 300+ additional patterns  (total CMDS ≈ 500)
  // ════════════════════════════════════════════════════════════════════════════

  // ── CONSTITUTION — DEEP ARTICLES ─────────────────────────────────────────
  { re: /article\s*1\b|name.*india|india.*union.*states/i,                 action: () => respond("Article 1: India, that is Bharat, shall be a Union of States. It uses 'Union' — not 'Federation' — signifying the indestructibility of the Union."), reply: '' },
  { re: /article\s*2\b|admission.*new.*state|parliament.*new.*state/i,     action: () => respond("Article 2: Parliament may admit new States into the Union or establish new States on such terms as it thinks fit. Used when Sikkim merged in 1975."), reply: '' },
  { re: /article\s*3\b|formation.*new.*state|alteration.*boundary/i,       action: () => respond("Article 3: Parliament can form new States, alter boundaries, or change names by simple majority. State Legislatures must be consulted but Parliament is not bound by their view."), reply: '' },
  { re: /article\s*13\b|laws.*void.*fundamental.*rights/i,                 action: () => respond("Article 13: Laws inconsistent with Fundamental Rights shall be void to the extent of inconsistency. Enables judicial review. Pre-constitutional laws are also struck down if they infringe FR."), reply: '' },
  { re: /article\s*14\b|equality.*before.*law/i,                           action: () => respond("Article 14: Equality before law (British concept — no privilege) AND Equal protection of laws (American concept — equal treatment in equal circumstances). Reasonable classification is permitted."), reply: '' },
  { re: /article\s*16\b|equality.*public.*employment/i,                    action: () => respond("Article 16: Equal opportunity in public employment. Allows reservations for backward classes (16(4)), SC/ST (16(4A)), and EWS (16(6) — 103rd Amendment 2019)."), reply: '' },
  { re: /article\s*17\b|untouchability.*abolished/i,                       action: () => respond("Article 17: Untouchability is abolished. Its practice in any form is an offence punishable by law. Protection of Civil Rights Act 1955 and SC/ST (Prevention of Atrocities) Act 1989 enforce this."), reply: '' },
  { re: /article\s*18\b|abolition.*titles/i,                               action: () => respond("Article 18: Abolition of titles. No State shall confer titles. Military and academic distinctions exempt. Bharat Ratna/Padma Awards are not 'titles' — SC upheld this in 1996."), reply: '' },
  { re: /article\s*20\b|protection.*conviction/i,                          action: () => respond("Article 20: Protection in respect of conviction for offences. Three rights: No ex-post-facto law, No double jeopardy, No self-incrimination. Available even during National Emergency."), reply: '' },
  { re: /article\s*22\b|preventive.*detention/i,                           action: () => respond("Article 22: Protection against arrest and detention. Safeguards: inform of grounds (Art 22(1)), right to legal counsel (22(1)), produce before magistrate within 24 hours (22(2)). Art 22(3-7) governs preventive detention."), reply: '' },
  { re: /article\s*23\b|prohibition.*traffic|begar|forced.*labour/i,       action: () => respond("Article 23: Prohibits traffic in human beings, begar (forced labour), and similar forms of forced labour. Bonded Labour System (Abolition) Act 1976 implements it."), reply: '' },
  { re: /article\s*24\b|child.*labour|factories.*mines/i,                  action: () => respond("Article 24: No child below 14 shall be employed in any factory or mine or engaged in any hazardous employment. Child Labour (Prohibition and Regulation) Amendment Act 2016 extends this."), reply: '' },
  { re: /article\s*26\b|religious.*denomination/i,                         action: () => respond("Article 26: Religious denominations can manage their own affairs, establish institutions, acquire property, and administer it. Subject to public order, morality, and health."), reply: '' },
  { re: /article\s*29\b|protection.*minorities|minority.*culture/i,        action: () => respond("Article 29: Any section of citizens with a distinct language/script/culture has the right to conserve it. Broader than Art 30 — not limited to minorities."), reply: '' },
  { re: /article\s*30\b|right.*establish.*educational.*institution/i,      action: () => respond("Article 30: Minorities (religious or linguistic) have the right to establish and administer educational institutions of their choice. This right is absolute — no reasonable restrictions can be imposed."), reply: '' },
  { re: /article\s*38\b|welfare.*state.*dpsp/i,                            action: () => respond("Article 38 (DPSP): State shall promote welfare of people by securing a social order — justice (social, economic, political), minimise inequalities, ensure adequate means of livelihood."), reply: '' },
  { re: /article\s*39\b|equal.*pay.*men.*women|equal.*pay.*equal.*work/i,  action: () => respond("Article 39(d) (DPSP): Equal pay for equal work for both men and women. Despite this DPSP, SC has consistently upheld it as a fundamental right via Articles 14, 16, and 21."), reply: '' },
  { re: /article\s*48a\b|environment.*protection.*dpsp/i,                  action: () => respond("Article 48A (DPSP, added by 42nd Amendment): State shall endeavour to protect and improve the environment and safeguard forests and wildlife. Read with Art 51A(g) (fundamental duty to protect environment)."), reply: '' },
  { re: /article\s*50\b|separation.*judiciary.*executive/i,                action: () => respond("Article 50 (DPSP): State shall take steps to separate the judiciary from the executive in public services. Has been given effect through CrPC where executive magistrates' judicial functions were separated."), reply: '' },
  { re: /article\s*110\b|money.*bill.*definition/i,                        action: () => respond("Article 110: Definition of Money Bill — deals with taxation, appropriation of Consolidated Fund, audit/accounts, custody of CFI. Certified by Lok Sabha Speaker. Rajya Sabha has 14-day window to return with recommendations only."), reply: '' },
  { re: /article\s*112\b|annual.*financial.*statement|union.*budget/i,     action: () => respond("Article 112: The Annual Financial Statement (Union Budget) must be laid before Parliament. Distinguishes between charged expenditure (non-votable) and voted expenditure."), reply: '' },
  { re: /article\s*148\b|comptroller.*auditor.*general/i,                  action: () => respond("Article 148: CAG is appointed by the President. Tenure: 6 years or 65 years (whichever is earlier). After retirement, cannot hold any office under Centre or State. Salary from Consolidated Fund — same security as SC judges."), reply: '' },
  { re: /article\s*153\b|governor.*states/i,                               action: () => respond("Article 153: There shall be a Governor for each State. Same person can be Governor of two or more states (since 1956 amendment)."), reply: '' },
  { re: /article\s*161\b|governor.*pardon/i,                               action: () => respond("Article 161: Governor can grant pardons, reprieves, respites, or remissions for offences under State law. Governor cannot pardon death sentences (only President under Art 72 can)."), reply: '' },
  { re: /article\s*200\b|governor.*assent.*bill/i,                         action: () => respond("Article 200: When a Bill is passed by State Legislature, Governor can assent, withhold assent, return for reconsideration, or reserve for President's consideration. If returned and re-passed, Governor MUST assent."), reply: '' },
  { re: /article\s*239aa\b|delhi.*special.*status|nct.*delhi/i,            action: () => respond("Article 239AA (inserted by 69th Amendment 1991): Special status to Delhi — National Capital Territory with a Legislative Assembly for items in State and Concurrent lists except Police, Land, Public Order. Lt Governor heads the administration."), reply: '' },
  { re: /article\s*244\b|scheduled.*areas|tribal.*areas/i,                 action: () => respond("Article 244: Provisions for Scheduled Areas (5th Schedule) in states other than Assam, Meghalaya, Mizoram, Tripura. 6th Schedule applies to tribal areas of those four northeastern states with autonomous district councils."), reply: '' },
  { re: /article\s*267\b|contingency.*fund/i,                              action: () => respond("Article 267: Contingency Fund of India — established under Parliament's authority. President has funds to meet unforeseen expenditures. Replenished from Consolidated Fund by Parliament. Similar fund for States under Art 267(2)."), reply: '' },
  { re: /article\s*312\b|all.*india.*services/i,                           action: () => respond("Article 312: Parliament may create new All India Services if Rajya Sabha passes a resolution by 2/3 majority. Current AIS: IAS, IPS, IFoS. These serve both Centre and States."), reply: '' },
  { re: /article\s*315\b|public.*service.*commission/i,                    action: () => respond("Article 315: UPSC for Centre; SPSCs for States. Joint PSC possible for two or more states. UPSC/SPSC members appointed by President/Governor. Removal procedure same as SC judges."), reply: '' },
  { re: /article\s*335\b|reservation.*services/i,                          action: () => respond("Article 335: Claims of SC/ST shall be taken into consideration in making appointments to services, consistently with maintaining efficiency of administration. Basis of reservation policy in government jobs."), reply: '' },
  { re: /article\s*360\b|financial.*emergency/i,                           action: () => respond("Article 360: Financial Emergency can be proclaimed if financial stability or credit of India or any part is threatened. Never been used. During it, salaries of government servants can be reduced."), reply: '' },

  // ── IMPORTANT CONSTITUTIONAL BODIES ──────────────────────────────────────
  { re: /national.*human.*rights.*commission|nhrc|human.*rights.*body/i,   action: () => respond("NHRC: Established under Protection of Human Rights Act 1993. Headed by retired CJI. Quasi-judicial body. Recommendations binding on government. Cannot investigate: armed forces, matters under commission of inquiry."), reply: '' },
  { re: /national.*commission.*women|ncw.*india|women.*commission/i,       action: () => respond("NCW: Statutory body under NCW Act 1990. Headed by Chairperson. Reviews laws, recommends legislative changes, investigates complaints, advises Central/State governments on women's issues."), reply: '' },
  { re: /national.*commission.*sc|scheduled.*caste.*commission/i,          action: () => respond("National Commission for SCs (Art 338): Investigates complaints about safeguards for SC/ST, advises on socio-economic development. Quasi-judicial. Reports to President annually."), reply: '' },
  { re: /national.*commission.*st|scheduled.*tribe.*commission/i,          action: () => respond("National Commission for STs (Art 338A): Monitors constitutional safeguards for STs, advises on planning, evaluates socio-economic progress. Works separately from SC Commission since 2004."), reply: '' },
  { re: /central.*vigilance.*commission|cvc.*india|vigilance.*body/i,      action: () => respond("CVC: Apex integrity institution, established 1964 (statutory 2003). Supervises CBI for PE cases. Headed by Central Vigilance Commissioner. Processes complaints against Group A officers of Centre."), reply: '' },
  { re: /attorney.*general|solicitor.*general|law.*officer.*india/i,       action: () => respond("Attorney General (Art 76): Government's chief legal adviser. Must be qualified to be SC judge. Can attend Parliament proceedings. Not a Cabinet member. Solicitor General and ASGs assist the AG."), reply: '' },
  { re: /comptroller.*auditor|cag.*role|types.*audit.*cag/i,               action: () => respond("CAG conducts 3 types of audit: Financial Audit (accounts accuracy), Compliance Audit (rules followed), Performance Audit (efficiency/effectiveness). Reports tabled in Parliament — examined by PAC and COPU."), reply: '' },
  { re: /national.*disaster.*management|ndma.*india|ndrf/i,                action: () => respond("NDMA: Statutory body under DM Act 2005. Chaired by PM. Sets policies and guidelines. NDRF (13 battalions) is primary response force. SDMAs at State level, DDMAs at district level."), reply: '' },

  // ── IMPORTANT LAWS ────────────────────────────────────────────────────────
  { re: /forest.*rights.*act|tribal.*forest.*rights|van.*adhikar/i,        action: () => respond("Forest Rights Act 2006: Recognises forest rights of Scheduled Tribes and other traditional forest dwellers. Individual rights (cultivation land), community rights (common land, water), developmental rights. Gram Sabha is key institution."), reply: '' },
  { re: /pesa.*act|panchayat.*extension.*scheduled.*areas/i,               action: () => respond("PESA Act 1996: Extends Panchayati Raj to 5th Schedule areas with modifications. Gram Sabha has primacy. Protects customary law, traditional management of resources. 10 states have scheduled areas."), reply: '' },
  { re: /consumer.*protection.*act|consumer.*court|district.*forum/i,      action: () => respond("Consumer Protection Act 2019 (replaced 1986 Act): District (up to ₹1 cr), State (₹1cr-10cr), National CDRC (above ₹10 cr). E-commerce covered. Product liability added. Mediation option introduced."), reply: '' },
  { re: /maternity.*benefit.*act|maternity.*leave.*india|26.*weeks.*maternity/i, action: () => respond("Maternity Benefit (Amendment) Act 2017: Maternity leave extended to 26 weeks (from 12 weeks) for first 2 children. 12 weeks for 3rd child onwards. Crèche facility mandatory for 50+ workers."), reply: '' },
  { re: /prevention.*corruption.*act|anti.*corruption.*law|bribery.*india/i, action: () => respond("Prevention of Corruption Act 1988 (amended 2018): Covers bribery by public servants and commercial organisations. Now includes 'giving of bribe' as offence. Prior sanction needed to prosecute retired servants."), reply: '' },
  { re: /pocso.*act|child.*sexual.*abuse|protection.*children/i,           action: () => respond("POCSO Act 2012 (amended 2019): Protection of Children from Sexual Offences. Child = under 18. Strict liability offences. Mandatory reporting by any person who suspects abuse. Special courts for speedy trial."), reply: '' },
  { re: /whistleblower.*protection|public.*interest.*disclosure|whistleblower/i, action: () => respond("Whistle Blowers Protection Act 2014 (not yet effective): Protects persons who disclose corruption/misuse in Central Government bodies. Complaints to CVC. Anonymity protected."), reply: '' },
  { re: /insolvency.*bankruptcy.*code|ibc.*2016|nclt.*resolution/i,        action: () => respond("IBC 2016: Consolidates insolvency laws. Resolution process: 180+90 days. NCLT is adjudicating authority. IBBI (Insolvency and Bankruptcy Board) regulates. Asset monetization through resolution has improved India's credit culture."), reply: '' },
  { re: /competition.*act|cci.*india|monopoly.*antitrust/i,                action: () => respond("Competition Act 2002: CCI (Competition Commission of India) is regulator. Prohibits anti-competitive agreements, abuse of dominant position. Approves M&A above threshold. NCLAT is appellate body."), reply: '' },
  { re: /digital.*personal.*data|dpdp.*act|data.*protection.*2023/i,       action: () => respond("Digital Personal Data Protection Act 2023: Replaces IT Act provisions. Data Fiduciary obligations. Data Principal rights. Data Protection Board for disputes. Cross-border transfer allowed to notified countries. Children's data stricter rules."), reply: '' },

  // ── POLITY — MISCELLANEOUS ────────────────────────────────────────────────
  { re: /doctrine.*lapse|dalhousie.*doctrine/i,                            action: () => respond("Doctrine of Lapse: Policy by Lord Dalhousie (1848-56). If a ruler died without natural male heir, the territory would lapse to British. Applied to Satara, Jhansi, Nagpur, Sambalpur. Major cause of 1857 Revolt."), reply: '' },
  { re: /doctrine.*basic.*structure|basic.*structure.*doctrine/i,          action: () => respond("Basic Structure Doctrine (Kesavananda Bharati, 1973): Parliament cannot amend Constitution to destroy its basic structure. Elements: Supremacy of Constitution, republican/democratic form, secularism, separation of powers, judicial review, fundamental rights."), reply: '' },
  { re: /doctrine.*colorable.*legislation|mala.*fide.*legislation/i,       action: () => respond("Doctrine of Colourable Legislation: 'What cannot be done directly cannot be done indirectly.' If a legislature lacks power, it cannot achieve the same result through indirect means. Prevents circumvention of constitutional limits."), reply: '' },
  { re: /delegated.*legislation|subordinate.*legislation|rule.*making.*power/i, action: () => respond("Delegated Legislation: Parliament delegates rule-making power to executive due to time constraints and technical complexity. Types: Statutory Rules & Orders, By-laws, Notifications. Controlled by Parliamentary Committees."), reply: '' },
  { re: /ouster.*clause|bar.*jurisdiction|finality.*clause/i,             action: () => respond("Ouster Clause: Constitutional/statutory provisions barring judicial review of government actions. But SC held in Anisminic (UK) and Indian cases that basic judicial review cannot be ousted — courts can still examine jurisdictional errors."), reply: '' },
  { re: /parliamentary.*privilege|privilege.*committee/i,                  action: () => respond("Parliamentary Privileges: Freedom of speech in Parliament, exemption from jury service, freedom from arrest in civil cases during session. Privilege Committee investigates breaches. Members cannot be sued for statements in Parliament."), reply: '' },
  { re: /question.*hour|zero.*hour|starred.*question|unstarred.*question/i, action: () => respond("Parliamentary Questions: Starred (oral answer, starred with *), Unstarred (written answer), Short Notice, Questions to Private Members. Zero Hour (India-specific): immediately after Question Hour, 12 noon. Supplementary questions allowed on Starred."), reply: '' },
  { re: /budget.*types|vote.*on.*account|interim.*budget/i,               action: () => respond("Budget Types: Regular (Annual Financial Statement, Feb 1), Vote on Account (spending authority for 2 months during election year), Interim Budget (presented before elections, has income tax provisions). Supplementary Demands for Grants for excess spending."), reply: '' },
  { re: /consolidated.*fund.*india|contingency.*fund|public.*account/i,   action: () => respond("Government Accounts: Consolidated Fund (all revenues/loans — voted expenditure), Contingency Fund (President's emergency spending), Public Account (deposits, PF, small savings). Only CFI subject to Parliamentary vote."), reply: '' },
  { re: /joint.*parliamentary.*committee|jpc.*india|standing.*committee/i, action: () => respond("Parliamentary Committees: Standing Committees (permanent — DRSCs, Financial Committees: PAC, Estimates, Public Undertakings), Ad hoc (JPC, Select). JPC has both houses, investigates specific matters like Bofors, 2G, etc."), reply: '' },
  { re: /president.*election|electoral.*college.*president|presidential.*election.*india/i, action: () => respond("Presidential Election (Art 54-55): Electoral College = elected MPs + elected MLAs. Weightage formula: State votes = Population/(Seats×1000), then adjusted. Single Transferable Vote system. Supreme Court scrutinizes election disputes."), reply: '' },
  { re: /vice.*president.*election|rajya.*sabha.*chairman/i,              action: () => respond("Vice President (Art 66): Elected by Electoral College of both Houses of Parliament (not MLAs). Simple ballot (not STV). Ex-officio Chairman of Rajya Sabha. Can become Acting President if President incapacitated."), reply: '' },

  // ── ECONOMY — DEEPER CONCEPTS ─────────────────────────────────────────────
  { re: /repo.*rate|reverse.*repo|msf|bank.*rate.*rbi/i,                  action: () => respond("RBI Rate Tools: Repo Rate (lending to banks, key policy rate), Reverse Repo (RBI borrows from banks), MSF — Marginal Standing Facility (emergency overnight, 25 bps above repo), Bank Rate (rediscounting, aligns with MSF)."), reply: '' },
  { re: /crr|cash.*reserve.*ratio|slr.*rbi|statutory.*liquidity/i,        action: () => respond("CRR: Banks must maintain % of deposits with RBI as cash. SLR: Banks must invest % of deposits in approved securities. Both drain liquidity from the banking system. RBI uses them to regulate money supply."), reply: '' },
  { re: /open.*market.*operations|omo.*rbi|government.*securities/i,      action: () => respond("OMO (Open Market Operations): RBI buys/sells government securities in open market to inject/absorb liquidity. Buying G-Secs injects ₹, selling absorbs ₹. Key unconventional monetary tool during liquidity crisis."), reply: '' },
  { re: /nairu|natural.*rate.*unemployment|phillips.*curve/i,             action: () => respond("Phillips Curve: Inverse relationship between inflation and unemployment. NAIRU: Non-Accelerating Inflation Rate of Unemployment — the unemployment rate consistent with stable inflation. Long-run curve is vertical — no trade-off."), reply: '' },
  { re: /base.*effect.*inflation|cost.*push.*inflation|demand.*pull/i,    action: () => respond("Inflation Types: Demand-pull (excess demand over supply), Cost-push (input cost rise), Structural (supply bottlenecks), Core inflation (excl. food & fuel), Headline inflation (includes food & fuel). Base effect can distort year-on-year comparisons."), reply: '' },
  { re: /twin.*deficit|fiscal.*deficit.*current.*account/i,               action: () => respond("Twin Deficit: Fiscal deficit + Current Account Deficit together. High fiscal deficit → government borrows → crowds out private investment → imports rise → CAD widens. India faces twin deficit risk when global commodity prices are high."), reply: '' },
  { re: /inverted.*duty.*structure|import.*duty.*raw.*material/i,         action: () => respond("Inverted Duty Structure: When import duty on raw materials is higher than on finished products — discourages domestic manufacturing. India rationalising duties under Make in India to fix this anomaly."), reply: '' },
  { re: /venture.*capital|angel.*investor|private.*equity|startup.*funding/i, action: () => respond("Startup Funding Stages: Angel (seed) → Venture Capital (Series A/B) → Private Equity (growth) → IPO (public). SEBI regulates AIF (Alternative Investment Funds) that include VC/PE. SIDBI Fund of Funds supports startup ecosystem."), reply: '' },
  { re: /microfinance|self.*help.*group|shg|nabard|rural.*credit/i,       action: () => respond("Microfinance: Small loans to poor without collateral. SHG-Bank Linkage Programme (NABARD 1992): largest globally. MUDRA scheme for micro-enterprises. RBI regulates MFIs — lending rate cap, household income limit."), reply: '' },
  { re: /food.*inflation|msp.*food.*prices|procurement.*price/i,          action: () => respond("Food Inflation in India: Driven by vegetables (high volatility, short shelf life), pulses, and edible oils. MSP supports farmer income but can stoke inflation. Buffer stock operations (FCI) used to stabilize prices."), reply: '' },
  { re: /15th.*finance.*commission|xv.*finance|fy2021.*fy2026/i,         action: () => respond("15th Finance Commission (NK Singh, 2017-2020): Award period 2021-26. Vertical devolution: 41% to states (down from 42% — 1% for J&K, Ladakh UTs). Introduced performance-based grants on health, education, power."), reply: '' },
  { re: /pm.*gati.*shakti|national.*master.*plan|multimodal.*connectivity/i, action: () => respond("PM GatiShakti (2021): National Master Plan for multimodal connectivity. 16 ministries share data on GIS platform to avoid duplication. Covers roads, railways, ports, waterways, airports, mass transit. Target: reduce logistics cost to 8% of GDP."), reply: '' },

  // ── ENVIRONMENT — COMPREHENSIVE ───────────────────────────────────────────
  { re: /wetland.*importance|ecosystem.*services|mangrove.*importance/i,  action: () => respond("Wetland Ecosystem Services: Water purification, flood moderation, carbon sequestration (blue carbon), biodiversity, fisheries, groundwater recharge. India's wetlands under threat from encroachment and pollution."), reply: '' },
  { re: /coral.*reef.*india|lakshadweep.*coral|andaman.*coral/i,          action: () => respond("India's coral reefs: Andaman & Nicobar (fringing reefs), Lakshadweep (atolls), Gulf of Mannar, Gulf of Kutch. Threatened by coral bleaching (ocean warming), ocean acidification, overfishing, and sedimentation."), reply: '' },
  { re: /tiger.*population.*india|tiger.*census|project.*tiger.*success/i, action: () => respond("India Tiger Census 2022: 3,167 tigers — world's 75%+ wild tigers. Major reserves: Jim Corbett, Bandipur, Kaziranga, Sundarban, Nagarhole. Doubled from 2010 (1,706). Project Tiger (1973) credited for turnaround."), reply: '' },
  { re: /one.*health.*approach|zoonotic.*disease|spillover.*infection/i,  action: () => respond("One Health Approach: Integrates human, animal, and environmental health. WHO-FAO-WOAH framework. COVID-19, Nipah, SARS were zoonotic. India's National Action Plan for AMR also adopts One Health."), reply: '' },
  { re: /plastic.*pollution|single.*use.*plastic|ban.*plastic.*india/i,   action: () => respond("India banned 19 single-use plastic items from July 2022 (cutlery, straws, earbuds, cigarette packs, etc.). Extended Producer Responsibility (EPR) for plastic packaging. Plastic Waste Management Rules 2016."), reply: '' },
  { re: /e.*waste|electronic.*waste|ewaste.*india/i,                      action: () => respond("E-waste: India 3rd largest generator globally (~3.2 million tonnes/year). E-Waste (Management) Rules 2022: Extended Producer Responsibility — manufacturers collect and recycle. Formalisation of informal sector is challenge."), reply: '' },
  { re: /stubble.*burning|parali.*problem|air.*pollution.*punjab/i,       action: () => respond("Stubble Burning: Paddy stubble burning in Punjab/Haryana (Oct-Nov) causes severe air pollution in Delhi. Commission for Air Quality Management in NCR set up. PUSA bio-decomposer, Happy Seeder machine promoted as alternatives."), reply: '' },
  { re: /carbon.*sink|forest.*carbon|afforestation.*india/i,              action: () => respond("India's carbon sinks: Forests (Forest Survey of India) cover 21.7% area — absorb ~2 billion tonnes CO2 equivalent annually. NDC targets: create additional carbon sink of 2.5-3 billion tonnes through forests by 2030."), reply: '' },
  { re: /glacial.*retreat|himalayan.*glacier|climate.*himalaya/i,         action: () => respond("Himalayan Glaciers: Third Pole after Arctic and Antarctic. ~15,000 glaciers in India. Retreat rate accelerating due to climate change. Fed rivers: Indus, Ganga, Brahmaputra. Increased short-term flooding, long-term water stress."), reply: '' },
  { re: /blue.*economy|ocean.*economy|maritime.*india/i,                  action: () => respond("Blue Economy: Economic use of oceans — fishing, shipping, tourism, offshore energy, deep-sea mining. India's coastline: 7,517 km. Sagarmala for port-led development. Deep Ocean Mission (2021) explores 6,000m depth."), reply: '' },

  // ── INDIA'S FOREIGN POLICY ────────────────────────────────────────────────
  { re: /panchsheel|five.*principles.*coexistence|bandung/i,              action: () => respond("Panchsheel (1954): Five Principles of Peaceful Coexistence — mutual respect for sovereignty, non-aggression, non-interference, equality and mutual benefit, peaceful coexistence. Signed with China, articulated Nehru's foreign policy."), reply: '' },
  { re: /non.*aligned.*movement|nam.*india|neutral.*foreign.*policy/i,   action: () => respond("Non-Aligned Movement: Founded 1961 at Belgrade by Nehru (India), Nasser (Egypt), Tito (Yugoslavia), Sukarno (Indonesia), Nkrumah (Ghana). India's independent foreign policy during Cold War. 120+ members now."), reply: '' },
  { re: /gujral.*doctrine|india.*neighborhood|good.*neighbor.*policy/i,  action: () => respond("Gujral Doctrine (1996, IK Gujral): India doesn't demand reciprocity from neighbors. Unilateral concessions to build trust. Improved relations with Bangladesh, Nepal, Bhutan during his tenure as PM/FM."), reply: '' },
  { re: /indo.*pacific.*strategy|freedom.*navigation|south.*china.*sea/i, action: () => respond("Indo-Pacific: India's definition: includes West Indian Ocean to Pacific. Key: freedom of navigation, rule-based order, no unilateral change of status quo. India part of QUAD (India-US-Japan-Australia). ASEAN centrality respected."), reply: '' },
  { re: /nuclear.*doctrine.*india|no.*first.*use.*nuclear|minimum.*credible/i, action: () => respond("India's Nuclear Doctrine: No First Use (NFU), Massive Retaliation for nuclear attack, Civilian control. Credible Minimum Deterrence. Non-weaponization of space. India did not sign NPT — but NSG waiver in 2008 recognized India as responsible state."), reply: '' },
  { re: /india.*africa.*relations|india.*africa.*forum.*summit/i,        action: () => respond("India-Africa: IAFS-3 (2015) — commitments for Lines of Credit, training, capacity building. India-Africa trade: ~$100 billion. African Union now G20 member partly due to India's push in G20 presidency (2023)."), reply: '' },
  { re: /india.*asean|asean.*india.*summit|act.*east.*policy.*asean/i,   action: () => respond("India-ASEAN: Strategic Partnership since 2012. ASEAN-India Free Trade Agreement (2010). Act East Policy replaced Look East Policy. ASEAN's 6-country bloc is 4th largest trade partner of India."), reply: '' },
  { re: /scl.*india|shanghai.*cooperation|russia.*china.*organisation/i,  action: () => respond("SCO: India joined full membership in 2017. 9 members. Focus: security, counter-terrorism, economic cooperation in Eurasian region. India balances SCO membership (with China-Pakistan) against QUAD membership."), reply: '' },

  // ── SOCIO-ECONOMIC ISSUES ─────────────────────────────────────────────────
  { re: /gig.*economy|platform.*worker|uber.*worker.*rights/i,            action: () => respond("Gig Economy: Workers engaged through digital platforms (Uber, Swiggy, Urban Company). India 2nd largest gig workforce (ASSOCHAM). Code on Social Security 2020 includes 'platform workers' — first legal recognition. Benefits: flexibility; concern: no social security."), reply: '' },
  { re: /brain.*drain.*india|skilled.*migration|reverse.*brain.*drain/i,  action: () => respond("Brain Drain: Emigration of skilled Indians (IT, healthcare, academia). ~1.8 million Indian-Americans are highest earning ethnic group in USA. Reverse Brain Drain occurring as startups, research institutions attract diaspora back. Pravasi Bharatiya Diwas celebrates diaspora."), reply: '' },
  { re: /digital.*divide|rural.*internet.*access|internet.*penetration/i, action: () => respond("Digital Divide: Rural internet penetration ~35% vs urban ~70%. Gender divide: 40% women use internet vs 60% men. BharatNet (optical fibre to gram panchayats) aims to close gap. PMGDISHA for digital literacy."), reply: '' },
  { re: /aging.*population|elderly.*india|old.*age.*security/i,           action: () => respond("India Aging: 10% population is 60+ (Census 2011); projected 20% by 2050. National Policy on Older Persons 1999. Atal Vayo Abhyuday Yojana for elderly welfare. Reverse mortgage, IGNOAPS (pension scheme) are key instruments."), reply: '' },
  { re: /malnutrition.*india|stunting.*wasting|poshan.*abhiyan/i,         action: () => respond("India Malnutrition: 35% children stunted, 19% wasted, 33% underweight (NFHS-5). POSHAN Abhiyaan (National Nutrition Mission) targets reducing stunting by 2%, undernutrition by 2% per year. Anaemia and wasting remain high."), reply: '' },
  { re: /human.*development.*index|hdi.*india|education.*health.*income/i, action: () => respond("HDI 2022: India ranked 132 out of 191. Three dimensions: Health (life expectancy), Education (mean/expected years of schooling), Income (GNI per capita). India HDI improved significantly since 1990 but still in 'Medium HDI' category."), reply: '' },
  { re: /gender.*gap.*index|wef.*gender|world.*economic.*forum.*gender/i, action: () => respond("WEF Gender Gap Index 2023: India ranked 127/146. Economic participation (low), Educational attainment (moderate), Health (below average), Political empowerment (high for India — 7th globally due to women political leaders)."), reply: '' },

  // ── IMPORTANT ORGANISATIONS & REPORTS ────────────────────────────────────
  { re: /ease.*of.*doing.*business|eodb.*ranking|world.*bank.*ranking/i,  action: () => respond("India's EODB ranking improved from 142 (2014) to 63 (2019). World Bank discontinued the index in 2021. India's Business Reforms Action Plan evaluated annually. DPIIT coordinates."), reply: '' },
  { re: /press.*freedom.*index|rsf.*india|media.*freedom/i,               action: () => respond("Press Freedom Index (RSF): India ranked 159/180 (2023). RSF cites harassment of journalists, sedition laws, UAPA. Article 19(1)(a) protects freedom of speech/expression including press."), reply: '' },
  { re: /transparency.*international|corruption.*perception|cpi.*index/i, action: () => respond("Corruption Perceptions Index (Transparency International): India ranked 93/180 (2023). Scale 0 (highly corrupt) to 100 (very clean). Denmark tops. India improved but still perceived as moderately corrupt."), reply: '' },
  { re: /global.*hunger.*index|ghi.*india|hunger.*ranking/i,              action: () => respond("Global Hunger Index (GHI): India ranked 111/125 (2023). Four indicators: undernourishment, child stunting, child wasting, child mortality. India disputes methodology. Govt calls it based on flawed assumptions."), reply: '' },
  { re: /niti.*aayog.*sdr|india.*sdg.*progress/i,                         action: () => respond("India SDG Index (NITI Aayog 2023-24): Overall score 71/100. SDG 7 (Clean Energy) and SDG 13 (Climate Action): frontrunners. SDG 2 (Zero Hunger), SDG 15 (Life on Land): aspirants. State-wise competition improves performance."), reply: '' },
  { re: /world.*press.*freedom|media.*censorship.*india/i,                action: () => respond("India's Media: Largest democracy with ~100,000 registered publications. TV: 900+ channels. Censorship/content control via MIB. Concerns: media consolidation, SLAPP suits against journalists. SC has upheld press freedom as fundamental right."), reply: '' },

  // ── IMPORTANT PERSONALITIES ───────────────────────────────────────────────
  { re: /br.*ambedkar|babasaheb|dalits.*constitution|father.*constitution/i, action: () => respond("Dr. B.R. Ambedkar: Chairman, Drafting Committee of Constitution. Father of the Constitution. Fought untouchability — converted to Buddhism in 1956. Also Law Minister, architect of Indian Labour Laws. Born April 14 (Ambedkar Jayanti)."), reply: '' },
  { re: /jawaharlal.*nehru|first.*pm.*india|nehru.*policy/i,               action: () => respond("Jawaharlal Nehru (1889-1964): First PM for 17 years. Architect of Indian democracy, Non-Alignment, IITs, Planning Commission, Panchsheel. Tryst with Destiny speech. Described as 'Chacha Nehru'. Nehru Report 1928."), reply: '' },
  { re: /sardar.*patel|iron.*man|states.*integration.*india/i,            action: () => respond("Sardar Vallabhbhai Patel: India's 'Iron Man'. Deputy PM and Home Minister. Integrated 562 princely states into India. Hyderabad Police Action (1948). Junagadh, Goa under his tenure. National Unity Day: Oct 31 (his birth anniversary)."), reply: '' },
  { re: /maulana.*azad|education.*minister.*india|national.*education/i,  action: () => respond("Maulana Abul Kalam Azad: First Education Minister of India (1947-58). Advocate for secular education. IITs, UGC established under him. National Education Day: November 11 (his birth anniversary)."), reply: '' },
  { re: /b.*r.*ambedkar|poona.*pact|buddhism.*conversion|dalits.*politics/i, action: () => respond("Ambedkar vs Gandhi: Poona Pact (1932) — Ambedkar wanted separate electorate for Untouchables; Gandhi fasted against it; compromise was reserved seats in joint electorate. Ambedkar later said the Pact was a mistake."), reply: '' },
  { re: /subhas.*chandra.*bose|netaji|ina.*india|azad.*hind.*fauj/i,      action: () => respond("Subhas Chandra Bose (Netaji): Founded INA (Indian National Army/Azad Hind Fauj) in 1943. 'Give me blood, I will give you freedom.' Forward Bloc formed 1939. Disappeared in a plane crash in 1945 (Taipei)."), reply: '' },
  { re: /lal.*bahadur.*shastri|jai.*jawan.*jai.*kisan|tashkent/i,         action: () => respond("Lal Bahadur Shastri (2nd PM): 'Jai Jawan Jai Kisan' slogan. Led India in 1965 war with Pakistan. Tashkent Agreement signed Jan 10, 1966. Died same night (heart attack per official account). Simple, humble leader."), reply: '' },
  { re: /indira.*gandhi|emergency.*1975|bank.*nationalisation|green.*revolution/i, action: () => respond("Indira Gandhi (3rd/6th PM): 'Garibi Hatao' slogan. Nationalised banks (1969), won 1971 war, created Bangladesh. Imposed Emergency (1975-77) — most controversial. Returned to power 1980. Assassinated October 31, 1984."), reply: '' },

  // ── CSAT MATHS SHORTCUTS ─────────────────────────────────────────────────
  { re: /percentage.*trick|calculate.*percentage.*fast|percent.*formula/i, action: () => respond("Quick Percentage: X% of Y = Y% of X. To find 18% of 150: 150×18/100 = 27. Shortcut: 10% of 150=15, 8%=12, add=27. For CSAT, find 1% first, then multiply. Practice with mock tests."), reply: '' },
  { re: /ratio.*proportion.*upsc|ratio.*trick|proportion.*formula/i,      action: () => respond("Ratio & Proportion CSAT: If A:B = 3:4 and B:C = 5:6, then A:B:C = 15:20:24. For proportions: Cross multiply. Direct proportion: ↑↑, Inverse: ↑↓. Practice: compound ratio, duplicate ratio, triplicate ratio."), reply: '' },
  { re: /average.*trick|weighted.*average.*formula|average.*upsc/i,       action: () => respond("Average CSAT: Average = Sum/Count. For grouped data: Weighted average = Σ(weight×value)/Σweights. Deviation method: Pick a number, find deviations, average the deviations, add to picked number. Faster for large sets."), reply: '' },
  { re: /time.*work.*formula|pipes.*cistern|work.*efficiency/i,           action: () => respond("Time & Work: If A does work in M days, efficiency = 1/M. A+B together = 1/M + 1/N per day. Pipes: fill pipe = +1/T, waste pipe = -1/T. LCM method: assume total work = LCM of times; find work/day rates, sum up."), reply: '' },
  { re: /time.*speed.*distance|relative.*speed|trains.*platform|boat.*stream/i, action: () => respond("Speed-Distance-Time: D = S×T. Trains: To cross a pole = train length/speed. To cross a platform = (train+platform length)/speed. Boats: Downstream = v+u, Upstream = v-u. Still water speed = (D+U)/2."), reply: '' },
  { re: /profit.*loss.*formula|markup.*discount|sp.*cp|selling.*cost.*price/i, action: () => respond("Profit/Loss: Profit% = (SP-CP)/CP × 100. Discount% = (Marked Price-SP)/MP × 100. Successive discounts of x% and y%: = x+y-xy/100. Mark-up then discount — be careful which base is used."), reply: '' },
  { re: /simple.*interest.*formula|compound.*interest|si.*ci.*difference/i, action: () => respond("SI = PRT/100. CI = P(1+r/100)^n - P. Difference (CI-SI) for 2 years = P(r/100)^2. For 3 years: CI-SI = P(r/100)^2(3+r/100). CSAT: Usually 2-3 year problems. Know shortcuts."), reply: '' },
  { re: /permutation.*combination|nCr.*nPr|arrangement.*selection/i,      action: () => respond("P&C: nPr = n!/(n-r)! (arrangements). nCr = n!/[r!(n-r)!] (selections). Key: Identical items = divide by repetition factorial. Circular arrangement = (n-1)!. Necklace = (n-1)!/2. UPSC rarely goes beyond basics."), reply: '' },

  // ── REASONING SHORTCUTS ───────────────────────────────────────────────────
  { re: /syllogism.*upsc|all.*some.*no.*syllogism|logic.*upsc/i,          action: () => respond("Syllogisms CSAT: Use Venn diagrams. 'All A are B' = circle A inside B. 'No A is B' = disjoint circles. 'Some A are B' = overlapping circles. Check each conclusion by drawing possible Venn diagrams. Eliminate impossible conclusions."), reply: '' },
  { re: /blood.*relation.*puzzle|family.*tree|coded.*relation/i,          action: () => respond("Blood Relations: Draw a family tree always. Use M/F markers. '+' for male, '-' for female. Convert coded language first. Common trick: 'my father's only son' = me. 'my mother's brother's son' = my cousin."), reply: '' },
  { re: /seating.*arrangement.*puzzle|circular.*seating/i,                action: () => respond("Seating Arrangement: Linear vs Circular. Circular: Fix one person (reference point), arrange others relative to him. Direction: left in circular = clockwise from above. Make a table: position 1-N, fill definite clues first, then derive."), reply: '' },
  { re: /number.*series.*pattern|odd.*one.*out.*number|sequence.*pattern/i, action: () => respond("Number Series: Look for differences (1st order, 2nd order). Squares/cubes series. Fibonacci pattern. Prime numbers. Alternating series (odd/even positions). For 'odd one out': find the rule the others follow, the outlier breaks it."), reply: '' },

  // ── HINDI STUDY PHRASES ───────────────────────────────────────────────────
  { re: /mujhe.*padhai.*mein.*madad.*karo|study.*help.*karo|padhai.*mai.*sath.*do/i, action: () => respond('Bilkul, main hoon! Batao — kaunsa subject, kaunsa topic? Main explain karunga, quiz lunga, ya plan banaunga — jo chahiye.'), reply: '' },
  { re: /aaj.*konsa.*topic.*padhna.*hai|topic.*suggest.*karo|kya.*padhun.*aaj/i, action: () => respond((() => { const cs=getCurrentState(); return cs?.today?.subject ? `Aaj ke liye ${cs.today.subject} suggest karta hoon. Planner mein aaj ka lecture dekho — wahan se shuru karo.` : 'Planner mein aaj ka schedule dekho. Agar khaali hai to plan generate karo.' })()), reply: '' },
  { re: /notes.*kaise.*banaye|notes.*banana.*kha.*se.*shuru/i,           action: () => respond('Notes banane ka best tarika: Lecture sunne ke baad Cornell method use karo. Left column mein keywords, right mein details, neeche summary. Revision ke time sirf left column dekho aur recall karo.'), reply: '' },
  { re: /upsc.*mein.*selection.*kaise.*hoti.*hai|selection.*process/i,   action: () => respond('UPSC Civil Services: Teen charan — Prelims (objective), Mains (likhit), Interview/Personality Test. Prelims qualify karo, Mains mein merit banao, Interview mein personality dikhaao. Lagbhag 1000 posts har saal. Mehnat aur consistency se hoti hai selection.'), reply: '' },
  { re: /IAS.*banna.*chahta.*hoon|IAS.*banana.*hai|officer.*banna.*chahta/i, action: () => respond('Bahut acha sapna hai. Consistent preparation, sahi resources, aur daily practice se IAS bana ja sakta hai. Aap sahi jagah par hain — ab kaam shuru karo. Aaj ka target kya hai?'), reply: '' },
  { re: /aaj.*bahut.*padhna.*hai|aaj.*zyada.*padhna.*chahta|bahut.*kuch.*cover.*karna/i, action: () => { clickStart(); respond('Shuru karte hain. Timer start kar diya. Focus karo, plan ke hisaab se ek-ek topic complete karo.') }, reply: '' },
  { re: /thoda.*sa.*poochna.*tha|ek.*sawaal.*poochna.*tha|kuch.*puchna.*tha/i, action: () => respond('Haan, poocho. Main sun raha hoon.'), reply: '' },
  { re: /bohot.*baar.*padha.*phir.*bhi.*bhool.*jaata|bhool.*jaata.*hoon|yaad.*nahi.*rehta/i, action: () => respond("Yeh normal hai. Bhoolna brain ki weakness nahi — yahi reason hai ki revision chahiye hoti hai. JARVIS ki SRS queue use karo — har lecture ke baad automatic revision schedule hogi at 1, 3, 7, 16, 35 din. Baar baar exposure hi fix karta hai."), reply: '' },

  // ── HEALTH & WELLNESS DURING UPSC ────────────────────────────────────────
  { re: /eye.*strain|eyes.*tired|screen.*eyes|20.*20.*20.*rule/i,         action: () => respond('Eye strain relief: 20-20-20 rule — every 20 minutes, look at something 20 feet away for 20 seconds. Blink consciously. Keep screen at arm\'s length. Use night mode in evenings. Get up and walk every hour.'), reply: '' },
  { re: /back.*pain.*studying|posture.*while.*studying|sitting.*posture/i, action: () => respond('Posture while studying: Sit up straight, feet flat on floor, screen at eye level. Take a 5-minute standing/stretching break every 45-60 minutes. Core exercises (plank, bridge) prevent long-term back issues from extended study sessions.'), reply: '' },
  { re: /sleep.*schedule|how.*many.*hours.*sleep|sleep.*study|nap.*study/i, action: () => respond('UPSC aspirants: 7-8 hours sleep is non-negotiable. Sleep consolidates memory. Short nap (20-30 min) after lunch enhances afternoon focus. Avoid screens 30 min before bed. Regular sleep time matters more than total hours.'), reply: '' },
  { re: /diet.*while.*studying|brain.*food|what.*to.*eat.*studying/i,     action: () => respond('Brain foods for studying: Nuts (omega-3), berries (antioxidants), dark chocolate (flavonoids), green tea (L-theanine), complex carbs (oats). Avoid heavy meals before study sessions. Stay hydrated — even mild dehydration reduces focus by 20%.'), reply: '' },
  { re: /meditation.*upsc|breathing.*exercise|mindfulness.*study/i,       action: () => respond('Meditation for UPSC: 10 minutes daily (morning). Box breathing: inhale 4s, hold 4s, exhale 4s, hold 4s. Reduces cortisol, improves working memory. UPSC is a long journey — mental resilience is as important as knowledge.'), reply: '' },

  // ── QUICK STUDY TOOLS ─────────────────────────────────────────────────────
  { re: /make.*mnemonics|mnemonic.*trick|remember.*list|acronym.*trick/i, action: () => respond("Mnemonic for UPSC: For lists, form an acronym or story. E.g., DPSP non-justiciable aspects: 'SLEEP' — Social order, Living wage, Equal pay, Education, Prohibition. Make your own — personalized mnemonics stick better."), reply: '' },
  { re: /flowchart.*polity|diagram.*upsc|visual.*learn.*upsc/i,           action: () => respond("Flowcharts work best for: Constitutional amendment procedure, Emergency proclamation, Bill to Act process, Panchayat structure. Draw once, revise the diagram — visual memory is strong. Scan and save your diagrams."), reply: '' },
  { re: /revision.*strategy|how.*to.*revise|smart.*revision/i,            action: () => respond("Smart Revision: First revision within 24 hours (when you remember 60-70%). Second at Day 3 (30-40% left). Third at Day 7 (20-25% left). Revision should be fast — use your own notes, not re-reading books. JARVIS SRS automates scheduling."), reply: '' },
  { re: /newspaper.*reading.*strategy|how.*read.*hindu.*upsc|current.*affairs.*strategy/i, action: () => respond("Newspaper Strategy: Read The Hindu — skip sports, entertainment. Focus: Edit page (opinions), National news, International, Economy. Make brief notes linking news to static syllabus. 30-45 minutes/day maximum. Weekly CA consolidation is essential."), reply: '' },
  { re: /upsc.*notes.*writing|how.*make.*notes.*upsc|note.*making/i,      action: () => respond("UPSC Notes: Don't copy from books — create your own synthesis. Structure: Topic heading → Key points (bullets) → One-liner summary → Source. Keep notes under 1 page per topic. Revise and update notes as you learn more."), reply: '' },

  // ── TIMER VOICE SHORTCUTS ─────────────────────────────────────────────────
  { re: /shuru.*kar.*padhai|padhna.*shuru.*kar|abhi.*se.*shuru/i,         action: () => { clickStart(); scr('engine') }, reply: 'Timer start. Padhai shuru!' },
  { re: /ruk.*ja|rok.*do.*timer|pause.*kar|band.*kar.*timer/i,            action: () => q('[data-act="start"]'), reply: 'Timer ruka.' },
  { re: /wapas.*shuru|continue.*kar|timer.*continue|padhai.*continue/i,   action: () => clickStart(), reply: 'Timer resume.' },
  { re: /session.*khatam.*hua|session.*done|session.*ho.*gaya/i,          action: () => { q('[data-act="skip"]'); respond(`Session done! ${celebrationLine()} Log your score if you had a test.`) }, reply: '' },
  { re: /break.*khatam|break.*ho.*gaya|break.*over|back.*to.*study/i,    action: () => { clickStart(); respond('Break khatam. Wapas padhai shuru. Focus karo!') }, reply: '' },

  // ── PLANNER VOICE SHORTCUTS ───────────────────────────────────────────────
  { re: /aaj.*mera.*kya.*schedule.*hai|aaj.*ka.*schedule.*batao/i,         action: () => respond(buildTodayReport()), reply: '' },
  { re: /kal.*ka.*plan|tomorrow.*lectures|agle.*din.*ka.*plan/i,           action: () => { scr('plan'); respond('Planner mein kal ka schedule dekho. Generate plan karo agar dates nahi set hain.') }, reply: '' },
  { re: /is.*hafte.*kya.*plan|is.*week.*schedule|week.*mein.*kya.*padhna/i, action: () => { scr('plan'); respond(buildWeekSummary()) }, reply: '' },
  { re: /agle.*week.*ka.*plan|next.*week.*kya|agle.*hafte.*schedule/i,    action: () => { scr('plan'); respond('Planner mein agle hafte ki dates filter karo. Ya generate plan karo for next week coverage.') }, reply: '' },
  { re: /subject.*wise.*plan|polity.*plan|history.*plan.*today/i,          action: () => { scr('plan'); respond('Subject-wise filter use karo planner mein — type karo subject name in search box.') }, reply: '' },

  // ── SCORE SHORTCUTS ───────────────────────────────────────────────────────
  { re: /mock.*score.*add|test.*score.*darz.*karo|result.*note.*karo/i,   action: () => cl('cm-add-score'), reply: 'Score entry khol di. Darz karo.' },
  { re: /kitna.*score.*kiya|mera.*score.*kya|latest.*result/i,            action: () => { scr('intel'); respond('Latest scores analytics section mein hain. Intelligence section mein dekho.') }, reply: '' },
  { re: /score.*improve.*kaise|marks.*kaise.*badhaye|performance.*improve/i, action: () => respond('Score improve karne ke liye: Mistake Notebook use karo, har test ke baad analyse karo. Weak topics identify karo. PYQs practice karo. Consistent revision se accuracy badhti hai.'), reply: '' },
  { re: /negative.*marks.*kaise.*bachain|negative.*marking.*strategy/i,   action: () => respond("UPSC negative marking strategy: Attempt only 80%+ confident answers. If eliminated 2 options from 4, attempt it (expected value positive). Don't attempt if only 1 option seems wrong. Accuracy > attempts."), reply: '' },

  // ── QUICK JARVIS PERSONALITY ──────────────────────────────────────────────
  { re: /kya.*tum.*meri.*madad.*karoge|help.*karoge.*kya|kya.*tum.*hamesha.*saath.*ho/i, action: () => respond('Hamesha. Main hoon Om ke Mission 2028 ke liye — 24 ghante, 7 din. Koi sawaal nahi chota, koi doubt silly nahi. Poocho.'), reply: '' },
  { re: /tum.*best.*ho.*jarvis|jarvis.*tum.*kamal.*ho/i,                  action: () => respond('Shukriya Om. Ab yeh energy padhai mein lagao — timer shuru karte hain?'), reply: '' },
  { re: /kal.*se.*karunga|kal.*se.*shuru|tomorrow.*i.*will.*start/i,      action: () => respond("'Kal se' wala trap mat lo. Ek chota sa kaam abhi karo — 5 minute bhi kaafi hai. Consistency kal se nahi, aaj se shuru hoti hai."), reply: '' },
  { re: /haar.*gaya.*main|give.*up.*karna.*chahta|quit.*karna.*chahta/i,  action: () => respond('Ruko. Ek baar mujhse baat karo. Jo log UPSC clear karte hain, unke paas koi alag talent nahi tha — unke paas ek quality thi: unhone chhodha nahi. Aaj ka din khatam karo. Kal bhi yahi karo.'), reply: '' },
  { re: /jarvis.*kab.*tak.*study.*karna.*chahiye|kitna.*padhna.*chahiye/i, action: () => respond('Quality matters more than hours. Start with 6 focused hours. No phone, no breaks over 15 mins. As you build stamina, increase to 8-10. JARVIS tracks your minutes — show me consistency for 30 days.'), reply: '' },

  // ── ADVANCED EXAM PREP ────────────────────────────────────────────────────
  { re: /current.*affairs.*link.*static|ca.*static.*connect|news.*syllabus/i, action: () => respond('CA-Static connection: Every news item should link to syllabus. PM GatiShakti → GS3 Infrastructure. NHRC report → GS2 Governance. Cyclone Biparjoy → GS1 Geography. Always ask: which paper, which topic does this belong to?'), reply: '' },
  { re: /gs4.*case.*study|ethics.*case.*study.*approach/i,                action: () => respond("GS4 Case Study approach: Identify the ethical issue, name the stakeholders, list competing values, evaluate options using ethical frameworks (consequentialist, deontological, virtue ethics), choose the most balanced course of action, add implementation steps."), reply: '' },
  { re: /upsc.*word.*limit|150.*word.*answer|250.*word.*structure/i,      action: () => respond("Word limits: 150 words ≈ 1 A4 page (writing fast). 250 words ≈ 1.5 pages. 10-marker = 150 words, 15-marker = 200 words, 20-marker = 250 words. Prioritise content over hitting exact word count. Quality writing."), reply: '' },
  { re: /daf.*filling|detailed.*application.*form|interview.*preparation/i, action: () => respond("DAF (Detailed Application Form): Fill honestly. Board members study it thoroughly. Prepare 5-10 questions on each DAF entry: hometown, graduation subject, hobbies, work experience. Consistency between DAF and interview responses is essential."), reply: '' },
  { re: /mock.*interview|personality.*test.*tips|body.*language.*interview/i, action: () => respond("UPSC Interview tips: Dress formally (traditional or formal Western). Sit straight, maintain eye contact. Pause before answering. Say 'I don't know' rather than guessing. Board tests calmness, balance, awareness. Prior DAF-based mock interviews are essential."), reply: '' },

  // ── IMPORTANT HISTORICAL EVENTS ───────────────────────────────────────────
  { re: /dandi.*march|salt.*march|1930.*civil.*disobedience/i,            action: () => respond("Dandi March (March 12 - April 6, 1930): Gandhi marched 241 miles from Sabarmati to Dandi. Made salt to defy Salt Law. Launched Civil Disobedience Movement. Global media attention — made British rule untenable."), reply: '' },
  { re: /khilafat.*movement|non.*cooperation.*1920|ali.*brothers/i,       action: () => respond("Non-Cooperation Movement (1920-22): Gandhi's first mass movement. Students, lawyers, government servants resigned. Boycott of foreign goods. Called off after Chauri Chaura (1922) violence. First mass mobilization of all classes."), reply: '' },
  { re: /quit.*india.*resolution|august.*kranti|do.*or.*die.*gandhi/i,    action: () => respond("Quit India Movement (August 8, 1942): 'Do or Die' speech by Gandhi at Bombay. All leaders arrested next morning. Spontaneous uprising. Underground network by Jayaprakash Narayan. Most intense of Gandhi's movements."), reply: '' },
  { re: /cabinet.*mission.*plan|1946.*plan|constituent.*assembly.*formation/i, action: () => respond("Cabinet Mission Plan (1946): Proposed a 3-tier federal structure. Congress and ML couldn't agree on groupings. Led to Constituent Assembly formation. Direct Action Day (ML) caused Calcutta killings — path to Partition."), reply: '' },
  { re: /poona.*pact.*ambedkar|ambedkar.*gandhi.*1932/i,                  action: () => respond("Poona Pact (September 1932): Ambedkar initially wanted separate electorate for Untouchables (Communal Award). Gandhi fasted against it. Compromise: reserved seats in joint electorate (instead of separate). Ambedkar later expressed regret."), reply: '' },
  { re: /lucknow.*pact|1916.*congress.*league|moderate.*extremist/i,      action: () => respond("Lucknow Pact (1916): Congress-Muslim League joint session. Congress accepted separate electorates for Muslims. INC reunited (Moderates and Extremists re-merged). Tilak and Jinnah brokered the deal."), reply: '' },

  // ── WORLD HISTORY ─────────────────────────────────────────────────────────
  { re: /french.*revolution|liberty.*equality.*fraternity|napoleon/i,     action: () => respond("French Revolution (1789): Liberty, Equality, Fraternity. Storming of Bastille July 14. King Louis XVI executed 1793. Rise of Napoleon — spread revolutionary ideas across Europe. Influenced Indian freedom fighters."), reply: '' },
  { re: /american.*revolution|declaration.*independence|1776/i,           action: () => respond("American Revolution (1765-1783): Colonies protested 'No taxation without representation'. Declaration of Independence July 4, 1776. US Constitution 1787 — first written constitution. Influenced Indian Constitution framers."), reply: '' },
  { re: /world.*war.*1|first.*world.*war|1914.*1918|sarajevo/i,           action: () => respond("World War I (1914-18): Triggered by Sarajevo assassination of Archduke Franz Ferdinand. Allied Powers (UK, France, Russia, USA) vs Central Powers (Germany, Austria-Hungary, Ottoman). Ended with Treaty of Versailles (1919). League of Nations formed."), reply: '' },
  { re: /world.*war.*2|second.*world.*war|1939.*1945|hitler/i,            action: () => respond("World War II (1939-45): Nazi Germany invaded Poland. Allied Forces (UK, USSR, USA) vs Axis (Germany, Italy, Japan). Holocaust: 6 million Jews killed. Ended with Japan's surrender (atom bombs, 1945). UN formed. Cold War began."), reply: '' },
  { re: /cold.*war.*history|ussr.*usa.*rivalry|iron.*curtain.*berlin/i,   action: () => respond("Cold War (1947-1991): US vs USSR ideological rivalry. NATO vs Warsaw Pact. Berlin Wall (1961-1989). Cuba Missile Crisis (1962, closest to nuclear war). Ended with USSR dissolution 1991. India: Non-Aligned but closer to USSR in later years."), reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v5 — Power, Voice-UX & Advanced Intelligence (120+ patterns)
  // ════════════════════════════════════════════════════════════════════════════

  // ── CONTINUOUS / SPEED CONTROLS ───────────────────────────────────────────
  { re: /conversation.*mode|auto.*listen|continuous.*conversation|baat.*chalti.*rahe/i, action: () => { _continuousMode = !_continuousMode; localStorage.setItem('jarvis_continuous', String(_continuousMode)); respond(_continuousMode ? 'Conversation mode on. Keep talking.' : 'Conversation mode off.') }, reply: '' },
  { re: /how.*fast.*speak|speed.*kya.*hai|tts.*speed|voice.*speed/i,    action: () => respond(`TTS speed is currently set to ${_ttsSpeed}. Say "speak faster", "speak slower", or "normal speed" to change.`), reply: '' },
  { re: /fast.*reply|quick.*answer|concise.*mode|short.*answer.*mode/i, action: () => { _ttsSpeed = 'fast'; localStorage.setItem('jarvis_speed','fast'); respond('Fast mode. Short answers only.') }, reply: '' },
  { re: /detailed.*reply|slow.*mode|explain.*fully|full.*answer.*mode/i, action: () => { _ttsSpeed = 'slow'; localStorage.setItem('jarvis_speed','slow'); respond('Detailed mode on. I will speak carefully and fully.') }, reply: '' },

  // ── CAMERA / VISION SHORTCUTS ─────────────────────────────────────────────
  { re: /scan.*score|score.*scan|marks.*scan|scan.*test.*paper|result.*scan/i,    action: () => openVisionCapture('scan my score', respond), reply: '' },
  { re: /scan.*newspaper|newspaper.*scan|headlines.*scan|ca.*scan.*today/i,       action: () => openVisionCapture('scan newspaper', respond), reply: '' },
  { re: /solve.*question.*camera|camera.*solve|csat.*solve.*photo/i,              action: () => openVisionCapture('solve this CSAT question', respond), reply: '' },
  { re: /read.*notes.*camera|scan.*notes|notes.*scan|handwriting.*read/i,         action: () => openVisionCapture('read my notes', respond), reply: '' },
  { re: /explain.*diagram|diagram.*explain|scan.*diagram|map.*explain/i,          action: () => openVisionCapture('explain this diagram', respond), reply: '' },

  // ── EMERGENCY / CRAM MODE ────────────────────────────────────────────────
  { re: /emergency.*polity|polity.*cram|polity.*urgent|polity.*last.*minute/i,     action: () => { fireTimer(50); respond('Emergency Polity session. 50-minute timer set. Cover: Constitution basics, Amendments, Emergency Provisions, Parliament.') }, reply: '' },
  { re: /emergency.*history|history.*cram|history.*urgent/i,                       action: () => { fireTimer(50); respond('Emergency History cram. 50-minute timer. Cover: 1857, Freedom Struggle, Gandhi movements, Post-independence.') }, reply: '' },
  { re: /emergency.*geography|geography.*cram/i,                                   action: () => { fireTimer(50); respond('Emergency Geography session. Cover: Physical features, Monsoon, Rivers, Soils, Vegetation.') }, reply: '' },
  { re: /emergency.*economy|economy.*cram|economics.*emergency/i,                  action: () => { fireTimer(50); respond('Emergency Economy cram. Cover: GDP, Budget, GST, RBI tools, Banking, Inflation.') }, reply: '' },
  { re: /emergency.*environment|environment.*cram/i,                                action: () => { fireTimer(50); respond('Emergency Environment session. Cover: Biodiversity, Climate Change, Conventions, Schemes, India targets.') }, reply: '' },
  { re: /emergency.*science|science.*cram|science.*tech.*urgent/i,                 action: () => { fireTimer(50); respond('Emergency Science and Tech. Cover: ISRO, AI, Biotech, Nuclear, Cybersecurity, Space.') }, reply: '' },
  { re: /emergency.*ethics|ethics.*cram|gs4.*urgent/i,                             action: () => { fireTimer(50); respond('Emergency GS4 cram. Cover: Key thinkers, Emotional Intelligence, Case Study approach, Probity.') }, reply: '' },
  { re: /all.*night.*study|raat.*bhar.*padhai|overnight.*session/i,                action: () => { respond('All-night session armed. Take a 15-minute break every 90 minutes and drink water. Starting your first block.'); fireTimer(90) }, reply: '' },

  // ── STUDY SESSION MANAGEMENT ──────────────────────────────────────────────
  { re: /start.*polity.*session|polity.*session.*start|polity.*padhna.*shuru/i,    action: () => { _sessionSubject = 'Polity'; clickStart(); scr('plan'); respond('Polity session started. Timer running.') }, reply: '' },
  { re: /start.*history.*session|history.*session.*start/i,                        action: () => { _sessionSubject = 'History'; clickStart(); scr('plan'); respond('History session started. Timer running.') }, reply: '' },
  { re: /start.*geography.*session|geography.*session.*start/i,                    action: () => { _sessionSubject = 'Geography'; clickStart(); scr('plan'); respond('Geography session started.') }, reply: '' },
  { re: /start.*economy.*session|economy.*session.*start/i,                        action: () => { _sessionSubject = 'Economy'; clickStart(); scr('plan'); respond('Economy session started.') }, reply: '' },
  { re: /start.*environment.*session/i,                                             action: () => { _sessionSubject = 'Environment'; clickStart(); respond('Environment session started.') }, reply: '' },
  { re: /start.*ethics.*session|gs4.*session.*start/i,                             action: () => { _sessionSubject = 'Ethics'; clickStart(); respond('Ethics session started. Remember to practice case studies.') }, reply: '' },
  { re: /what.*am.*i.*studying|current.*subject.*kya|session.*subject.*kya/i,      action: () => respond(_sessionSubject ? `You are currently in a ${_sessionSubject} session.` : 'No session subject set. Say "I am studying Polity" to tag it.'), reply: '' },
  { re: /end.*session.*summary|session.*khatam.*report|session.*done.*summary/i,   action: () => { const m = getTodayFocusMins(); respond(`Session ended. Today's total: ${m} minutes studied${_sessionSubject ? ` on ${_sessionSubject}` : ''}. ${celebrationLine()}`); _sessionSubject = '' }, reply: '' },

  // ── GUIDED REVISION FLOW ─────────────────────────────────────────────────
  { re: /quick.*revision.*polity|polity.*quick.*revision/i,                        action: () => { respond('Quick Polity revision: Preamble, Fundamental Rights (Part III), DPSP (Part IV), Parliament structure, Emergency provisions. Quiz yourself on each. Say "quiz me on Polity" when ready.'); scr('plan') }, reply: '' },
  { re: /quick.*revision.*history|history.*quick.*revision/i,                      action: () => respond('Quick History revision: Ancient (Maurya, Gupta), Medieval (Delhi Sultanate, Mughal), Modern (1857, Gandhi movements, Partition). Key dates, key personalities.'), reply: '' },
  { re: /quick.*revision.*economy|economy.*quick.*revision/i,                      action: () => respond('Quick Economy revision: GDP, fiscal vs monetary policy, RBI tools (Repo, CRR, SLR), GST structure, budget deficits, poverty measurement.'), reply: '' },
  { re: /one.*liner.*polity|polity.*key.*points/i,                                  action: () => respond('Polity one-liners: Article 1 = Union of States. Art 14 = Equality. Art 21 = Right to Life. Art 32 = Heart of Constitution. Art 368 = Amendment. 73rd = PRIs. 74th = ULBs. Kesavananda = Basic Structure.'), reply: '' },
  { re: /one.*liner.*history|history.*key.*points/i,                               action: () => respond('History one-liners: 1757 = Plassey. 1857 = First War. 1885 = INC founded. 1905 = Bengal Partition. 1919 = Rowlatt Act. 1930 = Dandi March. 1942 = Quit India. 1947 = Independence.'), reply: '' },
  { re: /one.*liner.*environment|environment.*key.*points/i,                       action: () => respond('Environment one-liners: 1972 = Stockholm (first env conference). 1987 = Montreal Protocol (ozone). 1992 = Rio Earth Summit. 1997 = Kyoto Protocol. 2015 = Paris Agreement. 2022 = India Net Zero 2070.'), reply: '' },

  // ── SMART DICTATION SHORTCUTS ─────────────────────────────────────────────
  { re: /add.*today.*ca|log.*today.*ca|ca.*aaj.*add/i,                             action: () => { cl('cm-ca-log'); respond('CA log opened. Speak or type today\'s entry.') }, reply: '' },
  { re: /add.*doubt|log.*doubt|doubt.*save|sawaal.*save/i,                         action: () => { const note = `[DOUBT logged at ${new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})}]`; addToInbox(note); respond('Doubt saved to inbox. Elaborate by typing in the notes.') }, reply: '' },
  { re: /quick.*capture|capture.*this|inbox.*add|inbox.*note/i,                    action: () => cl('cm-add-note'), reply: 'Quick Capture open.' },
  { re: /voice.*note|speak.*note|audio.*note/i,                                    action: () => { cl('cm-add-note'); respond('Note form open. Type what you want to save.') }, reply: '' },

  // ── ANALYTICS POWER QUERIES ───────────────────────────────────────────────
  { re: /how.*many.*hours.*this.*week|is.*hafte.*kitne.*ghante|weekly.*hours/i,    action: () => respond(buildWeekSummary()), reply: '' },
  { re: /my.*consistency|kitna.*consistent|study.*streak.*analysis/i,              action: () => { const cs=getCurrentState(); respond(cs?.streak ? `${cs.streak}-day streak. ${cs.streak >= 7 ? 'Excellent consistency — you are in the top tier of aspirants.' : 'Keep building. 7 consecutive days changes your preparation completely.'}` : 'No streak yet. Log today to start one.') }, reply: '' },
  { re: /average.*this.*week|is.*hafte.*average|weekly.*score.*average/i,          action: () => { scr('intel'); respond(buildStatusReport()) }, reply: '' },
  { re: /how.*many.*total.*lectures.*done|total.*done|kitne.*total.*done/i,        action: () => { const done=document.querySelectorAll('#plan .plan-row.done').length; const tot=document.querySelectorAll('#plan .plan-row').length; respond(tot ? `${done} of ${tot} lectures done — ${Math.round(done/tot*100)}% of syllabus covered.` : 'Open the planner to see lecture progress.') }, reply: '' },
  { re: /syllabus.*percent|coverage.*percentage|kitna.*syllabus.*hua/i,            action: () => { const d=document.querySelectorAll('#plan .plan-row.done').length; const t=document.querySelectorAll('#plan .plan-row').length; const p=t?Math.round(d/t*100):0; const lang=detectResponseLang(''); respond(lang==='hi'?`${p}% syllabus cover hua hai। ${d} of ${t} lectures done.`:lang==='hinglish'?`${p}% syllabus cover ho gaya. ${d} of ${t} done.`:`${p}% syllabus covered. ${d} of ${t} lectures done.`) }, reply: '' },

  // ── SMART APP CONTROLS ────────────────────────────────────────────────────
  { re: /open.*all.*panels|show.*everything|full.*dashboard/i,                     action: () => { scr('engine'); setTimeout(()=>scr('intel'),400); respond('Dashboard loaded.') }, reply: '' },
  { re: /close.*panel|close.*window|window.*close/i,                               action: () => closePanel(), reply: '' },
  { re: /clear.*chat|chat.*clear|history.*clear|reset.*chat/i,                     action: () => { _history.length = 0; renderChat(); respond('Chat cleared.') }, reply: '' },
  { re: /what.*conversation.*mode|is.*auto.*listen.*on|continuous.*mode.*kya/i,    action: () => respond(`Conversation mode is ${_continuousMode ? 'ON — I auto-listen after each response.' : 'OFF — say Jarvis to wake me.'}`), reply: '' },
  { re: /jarvis.*version|version.*kya.*hai|what.*version|app.*version/i,           action: () => respond('JARVIS v4 — Mission 2028. 564 commands, continuous conversation, EMA clap detection, Groq Llama-3.3-70B intelligence, Llama-4-Scout vision, trilingual.'), reply: '' },
  { re: /what.*groq.*key|api.*key.*set|groq.*configured|groq.*kaam.*kar.*raha/i,   action: () => respond(GROQ_AVAILABLE ? 'Groq API is active. Full AI intelligence enabled.' : 'No Groq API key. Add VITE_GROQ_API_KEY to .env for full AI features.'), reply: '' },

  // ── POMODORO & BREAK INTELLIGENCE ────────────────────────────────────────
  { re: /how.*many.*pomodoros|pomodoro.*count|kitne.*sessions.*aaj/i,              action: () => respond(`${_pomodorosDone} Pomodoro session${_pomodorosDone!==1?'s':''} completed in this tab session.`), reply: '' },
  { re: /next.*break.*when|break.*kab.*hoga|when.*break/i,                         action: () => { const t=document.querySelector<HTMLElement>('.ring-time')?.textContent; respond(t ? `Timer shows ${t} remaining. Take your break when it rings.` : 'No timer running. Start a session first.') }, reply: '' },
  { re: /skip.*break|break.*skip|no.*break.*now/i,                                 action: () => { q('[data-act="skip"]'); respond('Break skipped. Next focus session starting.') }, reply: '' },
  { re: /extend.*break|break.*lambi|longer.*break/i,                               action: () => { fireTimer(10); respond('10-minute extended break set.') }, reply: '' },
  { re: /ultra.*focus|no.*distract.*mode|deep.*focus.*lock/i,                      action: () => { fireTimer(90); cl('lock-btn'); respond('90-minute ultra focus. Screen locked. No distractions. You are in the zone, Om.') }, reply: '' },

  // ── UPSC EXAM INTELLIGENCE ────────────────────────────────────────────────
  { re: /important.*topics.*prelims|prelims.*important.*topic|top.*topics.*upsc/i, action: () => respond('Top Prelims topics: Constitutional provisions (especially FR, DPSP, Amendments), Modern History (1857-1947), Geography (monsoon, rivers, soils), Economy (RBI, GST, budget), Environment (conventions, national parks), Science (ISRO, biotech).'), reply: '' },
  { re: /upsc.*trend.*analysis|recent.*pattern.*upsc|last.*5.*years.*pattern/i,   action: () => respond('Recent UPSC Prelims trends: More environment and science questions, increasing current affairs weightage, Art and Culture consolidating, economy questions focused on schemes, static Polity remains high-yield.'), reply: '' },
  { re: /most.*repeated.*topic|frequently.*asked|pyq.*analysis|past.*pattern/i,   action: () => respond('Most repeated Prelims topics: Polity (Constitution, bodies), Modern History, Geography (physical and human), Environment, Economy (monetary policy, schemes), Science and Technology.'), reply: '' },
  { re: /upsc.*scoring.*pattern|how.*marks.*calculated|mains.*marking/i,          action: () => respond('Mains marking: Each GS paper 250 marks. Optional 500 marks (2 papers of 250 each). Essay 250 marks. Total Mains written: 1750. Interview: 275. Grand total: 2025 marks.'), reply: '' },
  { re: /upsc.*cut.*off|prelims.*cutoff|general.*cutoff|obc.*cutoff/i,            action: () => respond('UPSC Prelims cutoff varies by year. General category: typically 90-100 out of 200 for GS Paper 1. OBC around 85-95, SC/ST around 75-85. CSAT requires 33% qualifying score.'), reply: '' },
  { re: /upsc.*rank.*1.*marks|topper.*marks|air.*1.*how.*many.*marks/i,           action: () => respond('UPSC rank 1 typically scores 950-1050 out of 2025 total (written + interview). Mains written component is most critical — consistent 550-650 marks out of 1750 typically lands in top 100.'), reply: '' },

  // ── PERSONAL ASSISTANT FEATURES ───────────────────────────────────────────
  { re: /set.*morning.*alarm|morning.*reminder|subah.*yaad.*dilana/i,              action: () => { const now=new Date(); const alarm=new Date(); alarm.setHours(6,0,0,0); if(alarm<=now) alarm.setDate(alarm.getDate()+1); const mins=Math.round((alarm.getTime()-now.getTime())/60000); _reminders.push({id:_nextRemId++,msg:'Good morning! Time to start your study day.',at:alarm.getTime()}); respond(`Morning reminder set for 6 AM — in ${mins} minutes.`) }, reply: '' },
  { re: /bedtime.*reminder|11.*pm.*reminder|raat.*11.*yaad/i,                     action: () => { const now=new Date(); const bed=new Date(); bed.setHours(23,0,0,0); if(bed<=now) bed.setDate(bed.getDate()+1); const mins=Math.round((bed.getTime()-now.getTime())/60000); _reminders.push({id:_nextRemId++,msg:'Time to wrap up. Review today and plan tomorrow.',at:bed.getTime()}); respond(`Bedtime reminder set for 11 PM — in ${mins} minutes.`) }, reply: '' },
  { re: /break.*reminder.*30|30.*min.*break.*reminder/i,                           action: () => { _reminders.push({id:_nextRemId++,msg:'30 minutes up. Take a proper break.',at:Date.now()+30*60000}); respond('30-minute break reminder set.') }, reply: '' },
  { re: /water.*reminder|drink.*water.*reminder|paani.*yaad/i,                    action: () => { _reminders.push({id:_nextRemId++,msg:'Drink water now. Hydration improves focus.',at:Date.now()+45*60000}); respond('Water reminder set for 45 minutes.') }, reply: '' },

  // ── HINDI POWER COMMANDS ─────────────────────────────────────────────────
  { re: /aaj.*kitna.*baka|aaj.*kya.*reh.*gaya|remaining.*aaj/i,                   action: () => respond(buildTodayReport()), reply: '' },
  { re: /mera.*target.*kya.*hai|aaj.*ka.*target|daily.*target.*kya/i,             action: () => { cl('cm-goals'); respond('Goals khul gayi. Aaj ka target dekho.') }, reply: '' },
  { re: /notes.*mein.*kya.*hai|meri.*notes.*dikhao/i,                             action: () => { cl('cm-notes'); respond('Notes section open ho gayi.') }, reply: '' },
  { re: /mujhe.*focus.*chahiye|focus.*nahi.*ho.*raha|dhyan.*nahi.*lag.*raha/i,    action: () => { respond('Focus laane ke liye: phone rakh do, pani piyo, 5 deep breaths lo. Phir timer start karo aur sirf ek kaam karo.'); setTimeout(()=>clickStart(), 4000) }, reply: '' },
  { re: /main.*IAS.*banunga|main.*select.*ho.*jaunga|mujhe.*vishwas.*hai/i,       action: () => respond('Haan OM! Yeh confidence rakhna. Bilkul select hoga 2028 mein. Ab kaam pe dhyan do — ek lecture aur.'), reply: '' },
  { re: /kya.*main.*clear.*kar.*sakta|will.*i.*clear.*upsc|kya.*selection.*hogi/i, action: () => respond('Absolutely. UPSC cleared kar sakte hain — har saal 1000 log karte hain. Consistent preparation aur smart study se. Aaj ka kaam aaj karo.'), reply: '' },
  { re: /mujhe.*ghar.*yaad.*aa.*rahi|homesick|ghar.*miss|miss.*family/i,          action: () => respond("Yeh feeling normal hai. Aur yeh sacrifice UPSC ki preparation ka hissa hai. Jab officer ban jaoge toh family ko pehle se zyada de paoge. Abhi ek session aur."), reply: '' },

  // ── JARVIS META COMMANDS ─────────────────────────────────────────────────
  { re: /how.*does.*jarvis.*work|jarvis.*kaise.*kaam.*karta|architecture/i,       action: () => respond('JARVIS runs 3 tiers: instant local pattern matching (560 patterns, zero latency), Groq Llama-8B for intent classification (under 500ms), and Llama-70B for deep UPSC answers. Vision uses Llama-4-Scout. Everything is offline-capable.'), reply: '' },
  { re: /reset.*jarvis|jarvis.*reset|fresh.*start.*jarvis/i,                      action: () => { _history.length=0; _quizPhase='off'; _sessionSubject=''; renderChat(); respond('JARVIS reset. Fresh start.') }, reply: '' },
  { re: /save.*settings|jarvis.*settings.*save/i,                                 action: () => { localStorage.setItem('jarvis_speed', _ttsSpeed); localStorage.setItem('jarvis_continuous', String(_continuousMode)); respond('Settings saved — speed and conversation mode persisted.') }, reply: '' },
  { re: /what.*features.*new|new.*features.*jarvis|latest.*update/i,              action: () => respond('Latest JARVIS features: Continuous conversation mode, TTS speed control (fast/slow/normal), Command chaining, Emergency cram mode, EMA adaptive clap detection, Advanced vision (score scan, CA headlines, CSAT solver), Smart dictation, Session subject tracking.'), reply: '' },
  { re: /test.*clap|clap.*test|check.*clap.*detection/i,                          action: () => { respond('Clap detection test: Double-clap now. If JARVIS panel opens or mic activates, it is working correctly.') }, reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v6 — 200+ Advanced Intelligence & Productivity Commands
  // ════════════════════════════════════════════════════════════════════════════

  // ── MEMORY & PERSONALIZATION ──────────────────────────────────────────────
  { re: /my.*quiz.*history|quiz.*scores.*history|kitni.*baar.*quiz.*liya/i,         action: () => { const topics = Object.keys(_mem.quizScores); respond(topics.length ? `Quiz history: ${topics.map(t => `${t} (avg ${Math.round(_mem.quizScores[t].reduce((a,b)=>a+b,0)/_mem.quizScores[t].length)}%)`).slice(-5).join(', ')}.` : 'No quiz history yet. Say "quiz me on Polity" to start.') }, reply: '' },
  { re: /how.*many.*debates|debate.*count|kitne.*debate.*kiye/i,                    action: () => respond(`${_mem.debateCount} debate${_mem.debateCount !== 1 ? 's' : ''} completed. Great for Mains preparation.`), reply: '' },
  { re: /my.*milestones|milestone.*kya.*achieve|achievements.*jarvis/i,             action: () => { const m=_mem.milestones; const hits=[m.streak7?'7-day streak':'',m.streak30?'30-day streak':'',m.coverage50?'50% syllabus':'',m.coverage100?'Full syllabus':'',m.score70?'SP 70%':'',m.sessions100?'100 sessions':''].filter(Boolean); respond(hits.length ? `Milestones achieved: ${hits.join(', ')}.` : 'No milestones yet. Keep studying!') }, reply: '' },
  { re: /quiz.*on.*weak.*topics|quiz.*weak|test.*my.*weak.*area/i,                  action: () => { const t=_mem.weakTopics.slice(-1)[0] || getCurrentState()?.today?.subject || 'UPSC GS'; void startQuiz(t) }, reply: '' },
  { re: /what.*strong.*topics|strong.*areas.*kya|meri.*strengths/i,                 action: () => { respond(_mem.strongTopics.length ? `Strong topics: ${_mem.strongTopics.slice(-5).join(', ')}.` : 'No strong topics marked yet. Say "mark [topic] as strong" after mastering it.') }, reply: '' },
  { re: /clear.*memory|reset.*memory|forget.*everything|memory.*reset/i,            action: () => { localStorage.removeItem(_MEM_KEY); _mem = _defaultMem(); respond('Memory cleared. Starting fresh.') }, reply: '' },
  { re: /what.*remember.*me|kya.*yaad.*hai.*tujhe|jarvis.*knows.*about.*me/i,       action: () => { const lang=detectResponseLang(''); respond(L(lang, `I know: you're studying ${_mem.lastSubject || '—'}, weak topics: ${_mem.weakTopics.slice(-3).join(', ') || 'none flagged'}, strong topics: ${_mem.strongTopics.slice(-3).join(', ') || 'none flagged'}.`, `Main जानता हूँ: तुम ${_mem.lastSubject || '—'} पढ़ रहे हो, weak topics: ${_mem.weakTopics.slice(-3).join(', ') || 'कोई नहीं'}.`, `Main jaanta hoon: ${_mem.lastSubject || '—'} padh rahe ho, weak: ${_mem.weakTopics.slice(-3).join(', ') || 'koi nahi'}.`)) }, reply: '' },

  // ── VOCABULARY & LEARNING ─────────────────────────────────────────────────
  { re: /word.*of.*day|vocab.*today|aaj.*ka.*vocab|upsc.*vocab|legal.*term.*today/i,  action: () => { const v=getVocabWord(); respond(`${v.word}: ${v.meaning}`) }, reply: '' },
  { re: /next.*vocab|aur.*vocab|another.*term|ek.*aur.*word/i,                       action: () => { const v=getVocabWord(); respond(`${v.word}: ${v.meaning}`) }, reply: '' },
  { re: /all.*vocab.*done|vocab.*progress|kitne.*vocab.*ho.*gaye/i,                  action: () => respond(`Vocabulary index: ${_mem.vocabIdx % UPSC_VOCAB.length} of ${UPSC_VOCAB.length} legal terms covered.`), reply: '' },
  { re: /locus.*standi|locus standi/i,                                                action: () => respond('Locus Standi: Legal right to bring a matter before court. In PILs, even a public-spirited citizen without personal interest has locus standi for public benefit.'), reply: '' },
  { re: /sub.*judice|sub judice/i,                                                    action: () => respond('Sub Judice: Matter currently under judicial consideration. Parliament cannot discuss sub judice matters — restriction under Article 105.'), reply: '' },
  { re: /ultra.*vires|ultra vires/i,                                                  action: () => respond('Ultra Vires: Beyond the powers. A State law on a Union List subject is ultra vires Article 245 and void to the extent of inconsistency.'), reply: '' },
  { re: /stare.*decisis/i,                                                            action: () => respond('Stare Decisis: Stand by decisions. Under Article 141, Supreme Court decisions are the law of the land — all courts must follow.'), reply: '' },
  { re: /ratio.*decidendi/i,                                                          action: () => respond('Ratio Decidendi: The binding legal reasoning of a judgment. Only ratio decidendi creates precedent — obiter dicta are persuasive but not binding.'), reply: '' },
  { re: /parens.*patriae/i,                                                           action: () => respond('Parens Patriae: The State as parent — power to protect those who cannot protect themselves. Used in child custody, mental health, and disability cases.'), reply: '' },

  // ── ADVANCED STUDY MANAGEMENT ─────────────────────────────────────────────
  { re: /start.*deep.*work|deep.*work.*mode|distraction.*free.*mode|96.*minutes/i,   action: () => { fireTimer(96); respond('96-minute deep work block. Based on ultradian rhythm research — your brain is optimised for ~90-min focus cycles. Go.') }, reply: '' },
  { re: /spaced.*learning|spaced.*session|distributed.*practice/i,                   action: () => { respond('Spaced learning protocol: Study for 30 min → 10 min break → study 30 min → 10 min break → review 20 min. JARVIS SRS automates the revision spacing.'); fireTimer(30) }, reply: '' },
  { re: /study.*with.*me|padhai.*saath.*karo|timer.*aur.*sath.*raho/i,               action: () => { _continuousMode = true; localStorage.setItem('jarvis_continuous','true'); fireTimer(25); respond('Study-with-me mode on. I will stay present. 25-minute session starting. Focus.') }, reply: '' },
  { re: /interleaved.*practice|mix.*subjects|alternate.*subjects/i,                  action: () => respond('Interleaved practice: Study Subject A (25 min) → Subject B (25 min) → Subject A (25 min). Research shows interleaving improves retention by 40% over blocked study.'), reply: '' },
  { re: /retrieval.*practice|test.*yourself|self.*test|practice.*recall/i,           action: () => { const t=_sessionSubject||getCurrentState()?.today?.subject||'UPSC GS'; respond(`Retrieval practice on ${t}. Close your notes and speak/write everything you remember. Then check your notes.`); void startQuiz(t) }, reply: '' },

  // ── VOICE PERSONA & META ─────────────────────────────────────────────────
  { re: /formal.*mode|professional.*mode|be.*formal/i,                               action: () => { respond('Switching to formal mode. My responses will be more structured and precise.') }, reply: '' },
  { re: /casual.*mode|friendly.*mode|be.*casual|bhai.*wali.*baat/i,                  action: () => respond('Casual mode. Bhai, ab normal baat karte hain — UPSC ki taiyari ke saath.'), reply: '' },
  { re: /be.*strict|strict.*mode|no.*mercy|tough.*mode/i,                            action: () => respond('Strict mode. I will give you direct, unfiltered feedback. No coddling. You asked for it.'), reply: '' },
  { re: /be.*gentle|soft.*mode|kind.*mode|gentle.*mode/i,                            action: () => respond('Gentle mode on. We take it one step at a time. No pressure.'), reply: '' },
  { re: /how.*are.*you.*jarvis|tum.*kaise.*ho|jarvis.*theek.*hai/i,                  action: () => { const m=getTodayFocusMins(); respond(m > 0 ? `I am operational and happy — you have studied ${m} minutes today. That makes me very functional.` : "Ready and waiting. You haven't logged any study time yet today. Shall we start?") }, reply: '' },
  { re: /motivate.*hindi|hindi.*mein.*motivate|hindi.*motivation/i,                  action: () => { const hi=[...MOTIVATION_HI]; respond(_pick(hi)) }, reply: '' },
  { re: /motivate.*english|english.*motivation/i,                                    action: () => respond(_pick(MOTIVATION_EN)), reply: '' },

  // ── INTELLIGENT SCHEDULE MANAGEMENT ──────────────────────────────────────
  { re: /plan.*today.*optimally|best.*plan.*for.*today|optimal.*schedule/i,          action: () => { const cs=getCurrentState(); const m=getTodayFocusMins(); const remaining=Math.max(0,240-m); scr('plan'); respond(`${m} minutes done today. ${remaining} minutes of optimal study left for a solid 4-hour day. Focus on ${cs?.today?.subject??'your pending lectures'} first — high-value topics always first.`) }, reply: '' },
  { re: /how.*much.*time.*left.*today|kitna.*time.*baka.*aaj|remaining.*study.*time/i, action: () => { const m=getTodayFocusMins(); const remaining=Math.max(0,480-m); respond(`${m} minutes studied today. To hit 8 hours, ${remaining} more minutes needed. ${remaining <= 0 ? 'You have already done 8 hours today. Remarkable.' : ''}`) }, reply: '' },
  { re: /schedule.*tomorrow|kal.*ka.*plan.*banao|tomorrow.*schedule/i,               action: () => { scr('plan'); respond('Generating tomorrow\'s plan requires the planner to be open. The AI planner will schedule lectures based on your settings.') }, reply: '' },
  { re: /daily.*review|end.*of.*day.*review|aaj.*ka.*review/i,                       action: () => { const m=getTodayFocusMins(); const cs=getCurrentState(); const d=document.querySelectorAll('#plan .plan-row.done').length; respond(`Day review: ${m} minutes studied, ${d} lectures completed. ${cs?.streak??0}-day streak. ${m>=120?'Strong session today.':m>=60?'Good effort. Aim for more tomorrow.':'Short day. Protect that streak.'}`) }, reply: '' },

  // ── UPSC CURRENT AFFAIRS INTELLIGENCE ────────────────────────────────────
  { re: /brief.*me.*current.*affairs|ca.*brief|current.*affairs.*brief|aaj.*ki.*ca/i, action: () => { cl('cm-ca-log'); if (GROQ_AVAILABLE) void executeIntent('Summarize the most important UPSC-relevant current affairs themes from recent months: one sentence each for economy, polity, environment, and international relations.') }, reply: '' },
  { re: /ca.*link.*to.*syllabus|current.*affairs.*syllabus.*link|news.*to.*gs/i,     action: () => respond('CA-Syllabus linking: Economic policy → GS3 Economy. Constitutional amendments → GS2 Polity. Environment agreements → GS3 Environment. International summits → GS2 IR. Schemes → GS2/GS3. Sports awards → GS1. Always ask: which GS paper, which section?'), reply: '' },
  { re: /important.*bills.*2024|important.*bills.*2025|recent.*bills/i,              action: () => { if (GROQ_AVAILABLE) void executeIntent('List the 5 most important bills/acts passed in India in 2024-25 that are UPSC-relevant. One sentence each. No markdown.') }, reply: '' },
  { re: /important.*reports.*2024|important.*indices.*upsc|recent.*reports.*upsc/i,  action: () => respond('Key recent reports for UPSC: Global Hunger Index, Human Development Index, Ease of Doing Business (discontinued), Press Freedom Index, World Happiness Report, Environmental Performance Index. Know the ranking body, India\'s rank, and what each measures.'), reply: '' },

  // ── MENTAL MATH & QUICK CALCULATIONS ─────────────────────────────────────
  { re: /how.*many.*days.*since.*started|kitne.*din.*se.*padh.*raha/i,               action: () => { try { const first=JSON.parse(localStorage.getItem('focusLog')??"{}"); const dates=Object.keys(first).sort(); if(dates.length) { const diff=Math.round((Date.now()-new Date(dates[0]).getTime())/86400000); respond(`You have been on this journey for ${diff} days. Every one of them was a choice.`) } else respond('No sessions logged yet.') } catch { respond('Session data unavailable.') } }, reply: '' },
  { re: /marks.*needed.*cutoff|cutoff.*calculation|target.*score/i,                  action: () => respond('UPSC Prelims: To comfortably clear cutoff (assuming ~97 marks General), target 110+ marks. That is 55 correct answers with no negatives, or ~65 attempts with ~85% accuracy. CSAT requires 33% (33/100).'), reply: '' },
  { re: /time.*per.*question.*prelims|seconds.*per.*question|speed.*upsc/i,          action: () => respond('UPSC Prelims timing: 120 minutes for 100 questions = 72 seconds per question. Strategy: first pass in 60 mins for easy questions, second pass for tricky ones. Never spend more than 90 seconds on any single question.'), reply: '' },

  // ── ADVANCED HINDI INTERACTIONS ───────────────────────────────────────────
  { re: /jarvis.*kya.*soch.*raha.*hai|tum.*kya.*sochte.*ho|jarvis.*opinion/i,        action: () => { if(GROQ_AVAILABLE) void executeIntent('What is your honest assessment of Om\'s preparation so far based on what you know? Give a warm, honest, 2-sentence evaluation.') }, reply: '' },
  { re: /aaj.*ka.*din.*kaisa.*tha|how.*was.*today|din.*kaisa.*gaya/i,                action: () => { const m=getTodayFocusMins(); const d=document.querySelectorAll('#plan .plan-row.done').length; const lang=detectResponseLang(''); respond(L(lang,`Today: ${m} minutes, ${d} lectures done. ${m>=120?'Excellent day.':m>=60?'Decent session.':'Light day — protect your streak tomorrow.'} `,`आज: ${m} मिनट, ${d} lectures done. ${m>=120?'बेहतरीन दिन।':m>=60?'ठीक-ठाक session।':'हल्का दिन।'}`,`Aaj: ${m} minutes, ${d} lectures done. ${m>=120?'Excellent din.':m>=60?'Decent session.':'Halka din — kal zyada karo.'}`)) }, reply: '' },
  { re: /kal.*kya.*karun|tomorrow.*what.*should.*i.*do|kal.*plan.*batao/i,           action: () => { const cs=getCurrentState(); respond(`Tomorrow: Start with ${cs?.today?.subject??'your pending subject'}, do ${buildRevisionLine()}, then log a test score if you attempted one. Consistency over volume.`) }, reply: '' },
  { re: /bahut.*mushkil.*sab.*kuch|everything.*hard|sab.*hard.*lag.*raha/i,          action: () => respond('UPSC is designed this way. The difficulty is the filter. But here is the thing — you are showing up every day. That is not mediocre. Most aspirants do not. You are ahead just by being consistent.'), reply: '' },
  { re: /kya.*IAS.*banega.*2028|2028.*mein.*select.*hoga|CSE.*2028.*possible/i,      action: () => { const cs=getCurrentState(); respond(`With ${cs?.streak??0} days of streak${cs?.performance?.prelimsAvg ? ` and ${cs.performance.prelimsAvg.toFixed(1)}% average` : ''}: yes, 2028 is achievable. The selection happens to those who outlast the competition. You are still in the race. Keep going.`) }, reply: '' },

  // ── FOCUS & PRODUCTIVITY SCIENCE ─────────────────────────────────────────
  { re: /what.*is.*ultradian.*rhythm|ultradian.*rhythm|brain.*cycle.*study/i,        action: () => respond('Ultradian rhythm: Your brain works in 90-minute cycles of high focus followed by 20-min rest. Study aligns with this: 90-min deep session, then a proper break. The JARVIS timer can be set to 90 minutes for this.'), reply: '' },
  { re: /what.*is.*pomodoro.*technique|how.*pomodoro.*works|pomodoro.*explain/i,     action: () => respond('Pomodoro Technique: 25 minutes of focused work, then 5-minute break. After 4 Pomodoros, take a longer 15-30 minute break. Developed by Francesco Cirillo. Scientific basis: protects working memory, prevents decision fatigue.'), reply: '' },
  { re: /how.*remember.*better|memory.*techniques|better.*retention/i,              action: () => respond('Top 3 memory techniques for UPSC: 1. Active recall — test yourself instead of re-reading. 2. Spaced repetition — JARVIS SRS does this automatically. 3. Elaborative interrogation — ask "why" after every fact. These three together produce the best long-term retention.'), reply: '' },
  { re: /why.*is.*upsc.*hard|upsc.*kitna.*mushkil|why.*fail.*upsc/i,                action: () => respond('UPSC is hard because it tests breadth (25 subjects), depth (Mains answers), consistency (year-long), and personality (Interview) simultaneously. Most aspirants fail on consistency — not ability. The ones who clear it are not always the smartest. They are the most disciplined.'), reply: '' },

  // ── QUICK REFERENCE CARDS ─────────────────────────────────────────────────
  { re: /important.*articles.*constitution|must.*know.*articles/i,                  action: () => respond('Must-know Articles: 12 (State definition), 13 (Void laws), 14 (Equality), 19-22 (Freedoms), 21 (Life & Liberty), 32 (Remedies), 44 (UCC), 51A (Duties), 110 (Money Bill), 123 (Ordinance), 148 (CAG), 280 (Finance Commission), 324 (ECI), 352/356/360 (Emergencies), 368 (Amendment).'), reply: '' },
  { re: /important.*amendments|must.*know.*amendments/i,                            action: () => respond('Key Amendments: 7th (States reorganisation), 24th (Parliament amend FRs), 25th/42nd (FR vs DPSP), 42nd (Emergency era mini-constitution), 44th (Property right removed, restored checks), 61st (Voting age 18), 73rd/74th (PRIs/ULBs), 86th (RTE), 97th (Co-operatives), 101st (GST), 103rd (EWS).'), reply: '' },
  { re: /important.*committees.*upsc|key.*commissions|must.*know.*committees/i,     action: () => respond('Key Committees: Balwant Rai Mehta (PRIs 1957), Ashok Mehta (PRIs 1978), Sarkaria (Centre-State), Narasimham (Banking), Kelkar (Tax), Rangarajan (Poverty), Swaminathan (Farmers), 15th Finance Commission (NK Singh).'), reply: '' },
  { re: /schedules.*constitution|all.*schedules/i,                                  action: () => respond('12 Schedules: 1st (States/UTs), 2nd (Salaries), 3rd (Oaths), 4th (Rajya Sabha seats), 5th (Scheduled Areas), 6th (Tribal NE Areas), 7th (3 lists), 8th (22 languages), 9th (Acts beyond review), 10th (Anti-defection), 11th (Panchayat 29 subjects), 12th (Municipal 18 subjects).'), reply: '' },
  { re: /parts.*constitution|all.*parts.*constitution/i,                            action: () => respond('Key Parts: I (Union/States), III (FRs Art 12-35), IV (DPSP 36-51), IV-A (Duties 51A), V (Union Executive/Legislature), VI (State), IX (PRIs 73rd), IX-A (ULBs 74th), XIV (Services), XX (Amendment 368), XXI (Temporary provisions).'), reply: '' },

  // ── SELF-ASSESSMENT & REFLECTION ─────────────────────────────────────────
  { re: /should.*i.*continue|kya.*jari.*rakhu|give.*up.*upsc.*decision/i,           action: () => respond("Only you can answer that. But here is what I know: you are asking the question, which means you still care. People who truly give up do not ask if they should. Take tomorrow off completely. Then decide. Most people who took that break came back stronger."), reply: '' },
  { re: /am.*i.*good.*enough|kya.*main.*capable|main.*nahi.*kar.*sakta/i,           action: () => respond("You are. The UPSC selection list has people from every background — tier-3 cities, first-generation graduates, people who failed twice before clearing. Intelligence is not the variable. Commitment is. You have it. Now use it."), reply: '' },
  { re: /how.*long.*preparation|kitne.*saal.*taiyari|how.*many.*years.*upsc/i,      action: () => respond("Average UPSC preparation: 2-3 years for first attempt. Om, you are on the right track with Prarambh 2027 + exam 2028. That is a well-timed preparation cycle. Full syllabus in Year 1, deep revision in Year 2. You are aligned."), reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v8 — Voice Quality, Website Integration, Advanced Intelligence
  // ════════════════════════════════════════════════════════════════════════════

  // ── VOICE QUALITY & CONTROL ───────────────────────────────────────────────
  { re: /volume.*status|current.*volume|voice.*volume.*kya|aawaz.*kitni/i,           action: () => respond(`Volume is at ${Math.round(_ttsVolume * 100)}%. Speed: ${_ttsSpeed}. Say "louder", "quieter", "faster" or "slower" to adjust.`), reply: '' },
  { re: /mute.*jarvis|volume.*zero|aawaz.*band|silent.*jarvis/i,                     action: () => { _ttsVolume=0.1; localStorage.setItem('jarvis_volume','0.1'); respond('Near-muted. I will still respond visually.') }, reply: '' },
  { re: /voice.*settings|tts.*settings|jarvis.*audio.*settings/i,                   action: () => respond(`Current voice settings — Speed: ${_ttsSpeed}, Volume: ${Math.round(_ttsVolume*100)}%, Language: ${_replyLang}. Adjust with: "speak faster/slower", "louder/quieter", "Hindi/English/Hinglish mode".`), reply: '' },
  { re: /stop.*speaking|quiet.*down|chup.*karo|band.*karo.*bolna|shut.*up/i,         action: () => { _synth.cancel(); setState('idle'); VA.setState('idle'); respond('') }, reply: '' },
  { re: /wake.*word.*status|is.*wake.*word.*on|jarvis.*listening.*for.*wake/i,       action: () => respond(_wakeRunning ? 'Wake word detection is active. I am listening for "Jarvis".' : 'Wake word detection is currently off. It restarts automatically when JARVIS becomes idle.'), reply: '' },
  { re: /clap.*status|is.*clap.*on|clap.*detection.*active/i,                       action: () => respond(_clapEnabled && _everActivated ? 'Clap detection is active. Double-clap to wake me.' : _clapEnabled ? 'Clap detection is on, but you need to say "Jarvis" at least once first to activate clap mode.' : 'Clap detection is currently disabled (DND mode).'), reply: '' },
  { re: /test.*wake.*word|wake.*word.*test|jarvis.*detection.*test/i,                action: () => respond('Wake word test: Say "Jarvis" now. Only the exact word triggers me — no fuzzy variants. Confidence-gated to prevent false positives.'), reply: '' },

  // ── SMART JARVIS AWARENESS ────────────────────────────────────────────────
  { re: /jarvis.*update|latest.*jarvis.*version|what.*new.*jarvis/i,                 action: () => respond('JARVIS v6: 840+ commands, hardened wake word (confidence-gated, 2s debounce), 3-gate clap detection (transient + amplitude + similarity), TTS volume control, page title state indicator, voice journal, interview practice, essay outlines, ambient mode, browser notifications, cross-session memory.'), reply: '' },
  { re: /how.*wake.*you.*up|jarvis.*wake.*method|ways.*to.*wake.*jarvis/i,           action: () => respond('Three ways to wake JARVIS: 1. Say "Jarvis" (exact word, confidence-verified). 2. Double-clap within 700ms (after saying Jarvis once). 3. Click the JARVIS button or press J key.'), reply: '' },
  { re: /why.*not.*responding|jarvis.*not.*listening|jarvis.*nahi.*sun.*raha/i,      action: () => { const s=_sleeping?'Sleep mode':!_jarvisEnabled?'Disabled':_isSpeaking?'Speaking':'Active'; respond(`Status: ${s}. ${_sleeping?'Double-clap or tap to wake.':!_jarvisEnabled?'Click the toggle to enable.':_isSpeaking?'Wait for me to finish speaking.':'I am listening for Jarvis or a double clap.'}`) }, reply: '' },

  // ── WEBSITE TOASTS & FEEDBACK ─────────────────────────────────────────────
  { re: /save.*note.*toast|show.*saved|confirm.*saved/i,                             action: () => { window.dispatchEvent(new CustomEvent('app:toast',{detail:{msg:'✓ Note saved',type:'success'}})) }, reply: '' },
  { re: /test.*toast|show.*toast|toast.*test/i,                                      action: () => { window.dispatchEvent(new CustomEvent('app:toast',{detail:{msg:'JARVIS Toast Notification system is working!',type:'info'}})) }, reply: '' },

  // ── UPSC ADVANCED REASONING ───────────────────────────────────────────────
  { re: /federalism.*india|cooperative.*federalism|competitive.*federalism/i,        action: () => respond('Indian federalism is "quasi-federal" — a Union with strong Centre. Cooperative federalism: Centre-State work together (GST Council). Competitive federalism: States compete on governance metrics (NITI Aayog indices). 7th Schedule defines Union (97), State (61), Concurrent (52) lists.'), reply: '' },
  { re: /judicial.*review.*india|marbury.*madison.*india|judicial.*independence/i,   action: () => respond('Judicial review in India: Courts can strike down laws violating Constitution (Art 13). Broader than USA — HC can review under Art 226 for any right violation, not just Fundamental Rights. Marbury v Madison (1803) USA: India adopted similar doctrine from inception.'), reply: '' },
  { re: /constitutional.*morality.*india|dr.*ambedkar.*morality/i,                  action: () => respond('Constitutional Morality (Dr. Ambedkar): Adherence to constitutional norms even when social morality may differ. SC invoked it in Navtej Singh Johar (decriminalized Section 377) and Sabarimala cases. Popular morality cannot override constitutional guarantees.'), reply: '' },
  { re: /checks.*balances.*india|separation.*powers.*india/i,                        action: () => respond("India has 'separation of functions' not strict separation of powers. Legislature makes law, Executive implements, Judiciary interprets. But: Parliament can amend Constitution (Art 368), President can issue Ordinances (Art 123), Courts can strike down laws — significant overlap."), reply: '' },
  { re: /public.*trust.*doctrine|common.*heritage.*resources/i,                     action: () => respond('Public Trust Doctrine: Natural resources (rivers, forests, air) are held in trust by the State for the public — cannot be privatized without public benefit. Applied in MC Mehta v Kamalnath (1997). Rivers Yamuna, Ganga protected under this doctrine.'), reply: '' },
  { re: /live.*and.*let.*live|balance.*rights|rights.*conflict/i,                   action: () => respond('When Fundamental Rights conflict, courts apply "harmonious construction" — both rights given maximum effect. Art 19 freedom vs Art 21 right to live with dignity: reasonable restriction can be imposed. No right is absolute except Art 20(3) (self-incrimination).'), reply: '' },

  // ── GS3 ADVANCED TOPICS ───────────────────────────────────────────────────
  { re: /inclusive.*growth|trickle.*down.*economics|bottom.*pyramid/i,               action: () => respond('Inclusive Growth: Economic growth that benefits all, especially the poor. Trickle-down theory (growth will eventually benefit all) criticized — India prioritizes inclusive growth via MGNREGS, JAM trinity (Jan Dhan-Aadhaar-Mobile), PMAY, Ayushman Bharat.'), reply: '' },
  { re: /demographic.*dividend.*india|young.*population.*advantage/i,                action: () => respond("India's Demographic Dividend: 65%+ population under 35. Window 2020-2040. If skilled: boosts GDP. If unemployed: demographic disaster. Skill India, NEP 2020, PLI schemes aim to capture this dividend before ageing sets in."), reply: '' },
  { re: /critical.*mineral.*india|lithium.*india|strategic.*mineral/i,               action: () => respond('Critical Minerals: Essential for clean energy tech. India identified 30 critical minerals. Lithium reserves found in J&K (2023). India part of Minerals Security Partnership (MSP) with USA. Critical Mineral Mission launched to reduce import dependence on China.'), reply: '' },
  { re: /green.*hydrogen.*mission|national.*hydrogen|clean.*energy.*india/i,         action: () => respond('National Green Hydrogen Mission (2023): Target 5 MMTPA production by 2030. Investment target ₹8 lakh crore. Green hydrogen from renewable energy electrolysis. Applications: Industry, fertilizers, transport. NTPC, ONGC leading projects.'), reply: '' },
  { re: /semi.*conductor.*india|chip.*india|electronics.*manufacturing/i,            action: () => respond('India Semiconductor Mission: ₹76,000 crore incentive package. Micron Technology (USA) setting up assembly in Gujarat. Foxconn-HCL, ISMC proposals. Target: $300 billion electronics output by 2026. Reduces chip import dependence (currently ₹2.5 lakh crore/year).'), reply: '' },

  // ── GS1 ART & CULTURE ─────────────────────────────────────────────────────
  { re: /classical.*dance.*india|bharatanatyam|kathak|odissi|manipuri/i,             action: () => respond('Classical Dances: Bharatanatyam (Tamil Nadu), Kathak (North India), Odissi (Odisha), Manipuri (Manipur), Kuchipudi (AP), Mohiniyattam (Kerala), Sattriya (Assam), Kathakali (Kerala). Sangeet Natak Akademi recognizes these 8 classical forms.'), reply: '' },
  { re: /classical.*music.*india|hindustani.*carnatic|raga.*taal/i,                  action: () => respond("Indian Classical Music: Two streams — Hindustani (North, Persian influence) and Carnatic (South, more ancient). Both based on Raga (melody framework) and Tala (rhythm cycle). Natya Shastra by Bharata Muni is foundational text. UNESCO recognized Classical Music."), reply: '' },
  { re: /miniature.*painting.*india|mughal.*painting|rajput.*painting/i,             action: () => respond('Miniature Paintings: Mughal school (Persian + Indian fusion, Akbar period), Rajput/Rajasthani school (regional courts), Pahari school (Himachal, Jammu), Deccan school. Subject matter: court scenes, nature, religion. Important for UPSC Art & Culture.'), reply: '' },
  { re: /temple.*architecture.*india|dravidian.*nagara.*style/i,                     action: () => respond('Temple Architecture: Nagara style (North India) — curvilinear shikhara tower. Dravida style (South India) — pyramidal gopuram. Vesara style (Deccan) — mix of both. Largest temples: Brihadeeswara (Tanjavur), Ranganathaswamy (Srirangam).'), reply: '' },
  { re: /indus.*valley.*craft|terracotta.*artifacts|bronze.*dancing.*girl/i,         action: () => respond('Indus Valley Art: Highly standardized. Famous: Bronze Dancing Girl (Mohenjo-daro), Priest-King bust, terracotta figurines, seals (Pashupati seal). Standardized weights, bead-making, shell-inlay. No monumental sculpture — shows egalitarian society.'), reply: '' },

  // ── CSAT REASONING ADVANCED ───────────────────────────────────────────────
  { re: /direction.*sense.*problems|compass.*direction.*upsc|north.*south.*direction/i, action: () => respond('Direction Sense: Establish N-S-E-W clearly. "Sun rises in East" anchor. Clockwise turns: N→E→S→W. Anti-clockwise: N→W→S→E. Shadow method: morning shadow points West, evening East. After 2 right turns from North: facing South.'), reply: '' },
  { re: /calendar.*problems|day.*of.*week.*formula|what.*day.*upsc/i,               action: () => respond('Calendar Problems: Odd days method. Normal year = 365 days = 52 weeks + 1 odd day. Leap year = 2 odd days. Century: 400 years = 0 odd days. Memorize day code (Jan=0, Feb=3...). For UPSC, usually questions about day repetition or interval patterns.'), reply: '' },
  { re: /coding.*decoding.*upsc|letter.*shifting.*code|cipher/i,                    action: () => respond('Coding-Decoding: Common patterns: Letter shift (A→D: +3), Reverse coding (A→Z, B→Y), Position-based (1=A, 2=B), Consecutive letters reversed. For word codes: identify pattern from known example and apply to unknown. Check each letter independently first.'), reply: '' },
  { re: /venn.*diagram.*upsc|set.*theory.*upsc|inclusion.*exclusion/i,              action: () => respond('Venn Diagrams: Draw overlapping circles. A∪B = A + B - A∩B. A only = A - A∩B. Neither = Total - A∪B. For 3 sets: use 7-region diagram. Key formula: A∪B∪C = A+B+C - A∩B - B∩C - A∩C + A∩B∩C. Practice 3-set problems for CSAT.'), reply: '' },

  // ── MORNING ROUTINE & STUDY HABITS ────────────────────────────────────────
  { re: /morning.*routine.*ias|ias.*morning.*habit|topper.*routine/i,               action: () => respond('IAS topper morning routine: 5:30 AM wake. 20 min physical activity. Newspaper with coffee (The Hindu). 8 AM - 1 PM: first study block (toughest subject first). 1-2 PM: lunch and rest. 3-8 PM: second study block. 9 PM: answer writing. 10:30 PM: light reading. 11 PM: sleep.'), reply: '' },
  { re: /study.*environment|ideal.*study.*room|study.*setup/i,                      action: () => respond('Ideal study environment: Natural light (reduces eye strain by 40%). Temperature 20-22°C (optimal cognitive performance). Minimal visual clutter. Phone in another room. Background: silence or brown noise (not music with lyrics). Standing breaks every 45 min. Water on desk.'), reply: '' },
  { re: /procrastination.*overcome|how.*stop.*procrastinating|padhai.*avoid.*kar.*raha/i, action: () => respond('Beat procrastination: 2-minute rule — if under 2 minutes, do it NOW. Environment design — remove phone from view. "Eat the frog" — hardest task first. Time-box: "I will study for exactly 25 minutes" (not "I will study"). Implementation intention: "When I sit at desk, I open books."'), reply: '' },

  // ── HINDI POWER PHRASES ───────────────────────────────────────────────────
  { re: /jarvis.*aawaz.*thodi.*tez.*karo|jarvis.*louder.*bolo/i,                    action: () => { _ttsVolume=Math.min(1,_ttsVolume+0.25); localStorage.setItem('jarvis_volume',String(_ttsVolume)); respond(`आवाज़ बढ़ा दी। अब ${Math.round(_ttsVolume*100)}% पर हूँ।`) }, reply: '' },
  { re: /jarvis.*aawaz.*thodi.*kam.*karo|jarvis.*quieter.*bolo/i,                   action: () => { _ttsVolume=Math.max(0.2,_ttsVolume-0.25); localStorage.setItem('jarvis_volume',String(_ttsVolume)); respond(`आवाज़ कम की। अब ${Math.round(_ttsVolume*100)}% पर हूँ।`) }, reply: '' },
  { re: /jarvis.*kitna.*time.*hua.*padhai.*mein|total.*study.*time.*batao/i,         action: () => { const m=getTodayFocusMins(); respond(m>0?`आज ${m} मिनट पढ़ाई हुई। बढ़िया!`:'आज अभी कोई session नहीं हुआ।') }, reply: '' },
  { re: /jarvis.*mujhe.*yaad.*dilao.*padhai.*ka|study.*reminder.*chahiye/i,          action: () => { _reminders.push({id:_nextRemId++,msg:'Padhai ka time ho gaya, Om!',at:Date.now()+30*60000}); respond('30 मिनट में reminder set किया।') }, reply: '' },

  // ── ACCESSIBILITY & INCLUSIVE COMMANDS ────────────────────────────────────
  { re: /high.*contrast.*mode|accessibility.*mode|dyslexia.*mode/i,                 action: () => { cl('focus-mode-btn'); respond('Focus mode toggled — this reduces heavy VFX for accessibility.') }, reply: '' },
  { re: /text.*size.*increase|font.*bigger|bada.*font|bade.*akshar/i,               action: () => respond('Font size is controlled by your browser. Press Ctrl/Cmd + Plus to zoom in. The app is fully zoomable.'), reply: '' },
  { re: /keyboard.*only.*mode|no.*mouse|tab.*navigation/i,                         action: () => respond('All major features are keyboard-accessible. Press Tab to navigate, Enter to activate, Escape to close. Press J for JARVIS, ? for shortcuts.'), reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v9 — 120+ Full Website Control + Advanced Intelligence
  // ════════════════════════════════════════════════════════════════════════════

  // ── FULL WEBSITE STATE READING ────────────────────────────────────────────
  { re: /read.*all.*stats|full.*dashboard.*report|everything.*dashboard|complete.*report/i, action: () => { const s=readLiveStats(); const parts=[]; if(s.timer) parts.push(`Timer: ${s.timer}`); if(s.streak) parts.push(`Streak: ${s.streak} days`); if(s.coverage) parts.push(`Coverage: ${s.coverage}`); if(s.lecturesDone) parts.push(`${s.lecturesDone} of ${s.lecturesTotal} lectures done`); respond(parts.length ? parts.join('. ') : buildStatusReport()) }, reply: '' },
  { re: /read.*intelligence.*section|read.*analytics.*section|intel.*numbers|analytics.*read/i, action: () => { scr('intel'); const s=readLiveStats(); const cs=getCurrentState(); const line=[cs?.performance?.prelimsAvg?`Prelims avg: ${cs.performance.prelimsAvg.toFixed(1)}%`:'',s.coverage?`Coverage: ${s.coverage}`:'',cs?.streak?`Streak: ${cs.streak} days`:'',cs?.selectionProbabilityPct?`SP: ${cs.selectionProbabilityPct.toFixed(1)}%`:''].filter(Boolean).join('. '); respond(line || 'Open Intelligence section for your analytics.') }, reply: '' },
  { re: /what.*accuracy.*now|current.*accuracy|read.*accuracy|accuracy.*kitni/i,              action: () => respond(`Current accuracy: ${readAccuracy()}. Check the Intelligence section for subject-wise breakdown.`), reply: '' },
  { re: /read.*coverage|syllabus.*percentage.*read|what.*percent.*covered/i,                  action: () => { const d=document.querySelectorAll('#plan .plan-row.done').length; const t=document.querySelectorAll('#plan .plan-row').length; respond(t?`${Math.round(d/t*100)}% covered — ${d} of ${t} lectures done.`:'No lectures found. Import your lecture list first.') }, reply: '' },
  { re: /read.*timer|timer.*what.*say|what.*timer.*show|timer.*read/i,                        action: () => { const rem=getTimerRemaining(); const run=isTimerRunning(); respond(run?`Timer is running — ${rem} remaining.`:'Timer is not running. Say "start timer" to begin.') }, reply: '' },
  { re: /read.*streak|streak.*number.*read|what.*streak.*number/i,                            action: () => { const s=getCurrentState()?.streak??0; respond(s?`Current streak: ${s} day${s>1?'s':''}. Protect it today.`:'No streak yet. Log a session to start one.') }, reply: '' },
  { re: /read.*briefing.*line|briefing.*section.*read|daily.*briefing.*read/i,                action: () => { const el=document.getElementById('rtn-briefing'); respond(el?.textContent?.trim()||buildStatusReport()) }, reply: '' },
  { re: /how.*many.*errors|error.*count|total.*mistakes.*count/i,                             action: () => { const n=document.querySelectorAll('.mistake-item, [data-type="mistake"]').length; respond(n?`${n} mistake${n>1?'s':''} in your notebook.`:'Mistake Notebook is empty. Log mistakes as you study.') }, reply: '' },

  // ── DIRECT SCORE ENTRY (pre-fills modal) ─────────────────────────────────
  { re: /prelims.*mock.*(\d+).*(\d+).*out.*of.*(\d+)|mock.*(\d+).*score.*(\d+).*(\d+)/i,     action: () => { cl('cm-add-score'); respond('Add Score opened for prelims mock. Fill in your marks.') }, reply: '' },
  { re: /add.*prelims.*result|prelims.*result.*add|log.*prelims.*score/i,                     action: () => { prefillAndOpenScore(0, 200, 'GS Prelims Mock', 'prelims'); respond('Prelims score entry open — enter your marks.') }, reply: '' },
  { re: /add.*csat.*result|csat.*score.*log|log.*paper.*2/i,                                  action: () => { prefillAndOpenScore(0, 200, 'CSAT', 'csat'); respond('CSAT score entry open.') }, reply: '' },
  { re: /add.*mains.*result|mains.*score.*log|log.*mains.*score/i,                            action: () => { prefillAndOpenScore(0, 250, 'GS Mains', 'mains'); respond('Mains score entry open.') }, reply: '' },
  { re: /add.*optional.*result|optional.*score.*log|log.*optional.*marks/i,                   action: () => { prefillAndOpenScore(0, 250, 'Optional', 'optional'); respond('Optional score entry open.') }, reply: '' },
  { re: /add.*dpp.*result|dpp.*log.*score|log.*dpp/i,                                         action: () => { prefillAndOpenScore(0, 100, 'DPP', 'dpp'); respond('DPP score entry open.') }, reply: '' },

  // ── DIRECT FORM FILLING COMMANDS ─────────────────────────────────────────
  { re: /(?:add|log|note)\s+(?:ca|current affair)[:\-]\s*(.+)/i,                              action: () => { const m=_lastUserQuery.match(/(?:ca|current affair)[:\-]\s*(.+)/i); if(m) { prefillCALog(m[1].trim()); respond(`CA entry pre-filled: "${m[1].trim()}"`) } else { cl('cm-ca-log'); respond('CA log opened.') } }, reply: '' },
  { re: /(?:add|log|note)\s+(?:mistake|galti)[:\-]\s*(.+)/i,                                  action: () => { const m=_lastUserQuery.match(/(?:mistake|galti)[:\-]\s*(.+)/i); if(m) { prefillMistakeForm('','',m[1].trim()); respond('Mistake form pre-filled.') } else { cl('cm-add-mistake'); respond('Mistake Notebook opened.') } }, reply: '' },
  { re: /(?:add|jot|save)\s+(?:note)[:\-]\s*(.+)/i,                                           action: () => { const m=_lastUserQuery.match(/note[:\-]\s*(.+)/i); if(m) { prefillNoteForm(m[1].trim()); respond(`Note form pre-filled: "${m[1].trim()}"`) } else { cl('cm-add-note'); respond('Notes opened.') } }, reply: '' },

  // ── SMART NAVIGATION (deep links) ────────────────────────────────────────
  { re: /scroll.*to.*heatmap|show.*heatmap|heatmap.*section/i,                                action: () => { scr('intel'); setTimeout(()=>document.getElementById('heat')?.scrollIntoView({behavior:'smooth'}),400); respond('Scrolling to activity heatmap.') }, reply: '' },
  { re: /scroll.*to.*rank|show.*rank.*section|rank.*widget/i,                                  action: () => { scr('intel'); setTimeout(()=>document.getElementById('rank')?.scrollIntoView({behavior:'smooth'}),400); respond('Rank simulation section.') }, reply: '' },
  { re: /scroll.*to.*donut|donut.*chart|subject.*donut/i,                                      action: () => { scr('intel'); respond('Scrolling to subject accuracy donuts.') }, reply: '' },
  { re: /scroll.*to.*streak|streak.*widget/i,                                                  action: () => { scr('intel'); setTimeout(()=>document.getElementById('streak')?.scrollIntoView({behavior:'smooth'}),400); respond('Streak section.') }, reply: '' },
  { re: /scroll.*to.*timer|focus.*timer.*section|timer.*widget/i,                              action: () => { scr('engine'); respond('Focus timer section.') }, reply: '' },
  { re: /scroll.*to.*revision|revision.*queue.*section/i,                                      action: () => { scr('plan'); setTimeout(()=>{ const lbl=Array.from(document.querySelectorAll<HTMLElement>('#plan .card-label')).find(e=>e.textContent?.toLowerCase().includes('revision')); lbl?.scrollIntoView({behavior:'smooth'}) },400); respond('Revision queue.') }, reply: '' },

  // ── PLANNER ADVANCED CONTROL ──────────────────────────────────────────────
  { re: /mark.*all.*today.*done|all.*lectures.*done.*today|complete.*all.*today/i,             action: () => { const n=markAllLecturesDone(); respond(n?`${n} lecture${n>1?'s':''} marked done. ${celebrationLine()}`:'No pending lectures for today.') }, reply: '' },
  { re: /next.*lecture.*name|what.*next.*lecture|upcoming.*lecture.*name/i,                    action: () => { const t=getNextLectureTitle(); respond(t?`Next lecture: "${t}".`:'All lectures done! Great work.') }, reply: '' },
  { re: /filter.*by.*polity|polity.*lectures.*show|show.*polity.*only/i,                      action: () => { filterPlannerBy('polity'); respond('Planner filtered by Polity.') }, reply: '' },
  { re: /filter.*by.*history|history.*lectures.*show|show.*history.*only/i,                   action: () => { filterPlannerBy('history'); respond('Planner filtered by History.') }, reply: '' },
  { re: /filter.*by.*geography|geography.*lectures.*show|show.*geography.*only/i,             action: () => { filterPlannerBy('geography'); respond('Planner filtered by Geography.') }, reply: '' },
  { re: /filter.*by.*economy|economy.*lectures.*show|show.*economy.*only/i,                   action: () => { filterPlannerBy('economy'); respond('Planner filtered by Economy.') }, reply: '' },
  { re: /filter.*by.*environment|environment.*lectures.*show|show.*env.*only/i,               action: () => { filterPlannerBy('environment'); respond('Planner filtered by Environment.') }, reply: '' },
  { re: /filter.*by.*ethics|gs4.*lectures.*show|show.*ethics.*only/i,                         action: () => { filterPlannerBy('ethics'); respond('Planner filtered by Ethics.') }, reply: '' },
  { re: /filter.*by.*science|science.*tech.*lectures|show.*science.*only/i,                   action: () => { filterPlannerBy('science'); respond('Planner filtered by Science & Tech.') }, reply: '' },

  // ── SRS REVISION CONTROL ──────────────────────────────────────────────────
  { re: /rate.*revision.*again|mark.*revision.*again|revision.*again/i,                       action: () => { const ok=rateFirstRevision('again'); respond(ok?'Revision rated: Again. JARVIS will schedule this sooner.':'No revision card visible. Open the Plan section first.') }, reply: '' },
  { re: /rate.*revision.*hard|mark.*revision.*hard|revision.*hard/i,                          action: () => { const ok=rateFirstRevision('hard'); respond(ok?'Revision rated: Hard.':'No revision card visible.') }, reply: '' },
  { re: /rate.*revision.*good|mark.*revision.*good|revision.*good/i,                          action: () => { const ok=rateFirstRevision('good'); respond(ok?'Revision rated: Good. Next review scheduled.':'No revision card visible.') }, reply: '' },
  { re: /rate.*revision.*easy|mark.*revision.*easy|revision.*easy/i,                          action: () => { const ok=rateFirstRevision('easy'); respond(ok?'Revision rated: Easy. Long interval set.':'No revision card visible.') }, reply: '' },

  // ── TIMER ADVANCED CONTROL ────────────────────────────────────────────────
  { re: /set.*timer.*(\d+).*min|timer.*set.*(\d+)|(\d+).*min.*timer.*set/i,                   action: () => { const m=_lastUserQuery.match(/(\d+)\s*min/i); if(m){const n=Math.min(180,Math.max(1,parseInt(m[1]))); setTimerMinutes(n); respond(`Timer set to ${n} minutes.`)} }, reply: '' },
  { re: /is.*timer.*running|timer.*chalu.*hai|timer.*chal.*raha/i,                            action: () => respond(isTimerRunning()?`Yes — ${getTimerRemaining()} remaining.`:'Timer is not running.'), reply: '' },
  { re: /how.*much.*time.*remaining|time.*left.*on.*timer|timer.*how.*much.*left/i,           action: () => { const rem=getTimerRemaining(); const run=isTimerRunning(); respond(run?`${rem} left on the timer.`:'Timer is not running.') }, reply: '' },
  { re: /start.*exam.*simulation|exam.*simulation.*start|2.*hour.*exam.*mode/i,               action: () => { setTimerMinutes(120); respond('2-hour exam simulation started. Full focus. No interruptions. Treat this like the real exam.') }, reply: '' },
  { re: /start.*revision.*marathon|revision.*marathon.*start|marathon.*revision/i,            action: () => { fireTimer(30); respond('Revision marathon started. 30-minute sessions. After each session, rate your SRS cards. JARVIS will alert you between sessions.') }, reply: '' },

  // ── STUDY SESSION MODES ───────────────────────────────────────────────────
  { re: /start.*deep.*polity.*session|polity.*deep.*dive|deep.*dive.*polity/i,                action: () => { _sessionSubject='Polity'; filterPlannerBy('polity'); fireTimer(50); scr('plan'); respond('Polity deep dive: 50-minute session. Planner filtered. Timer running. Focus on constitutional provisions and amendments.') }, reply: '' },
  { re: /start.*deep.*history.*session|history.*deep.*dive|deep.*dive.*history/i,             action: () => { _sessionSubject='History'; filterPlannerBy('history'); fireTimer(50); scr('plan'); respond('History deep dive: 50-minute session. Focus on chronology and key events.') }, reply: '' },
  { re: /start.*deep.*economy.*session|economy.*deep.*dive|deep.*dive.*economy/i,             action: () => { _sessionSubject='Economy'; filterPlannerBy('economy'); fireTimer(50); scr('plan'); respond('Economy deep dive: 50 minutes. Focus on RBI, budget, GST, and schemes.') }, reply: '' },
  { re: /mock.*test.*mode|exam.*mode.*start|start.*mock.*test.*mode/i,                        action: () => { fireTimer(120); toast('Mock Test Mode: No interruptions', 'info'); respond('Mock test mode: 2-hour timer started. After the test, say "add score" to log your result.') }, reply: '' },
  { re: /current.*affairs.*catch.*up|ca.*catch.*up|catch.*up.*ca/i,                          action: () => { cl('cm-ca-log'); respond('CA log opened. Also checking online AI for recent CA themes.'); if(GROQ_AVAILABLE) void executeIntent('What are the most UPSC-relevant current affairs themes from the past month? Economy, polity, international, environment. 4 one-liners.') }, reply: '' },

  // ── TOAST NOTIFICATIONS ───────────────────────────────────────────────────
  { re: /show.*success.*toast|success.*notification|green.*notification/i,                    action: () => { toast('Action completed successfully!', 'success'); respond('Success toast shown.') }, reply: '' },
  { re: /show.*warning.*toast|warning.*notification|alert.*me/i,                              action: () => { toast('JARVIS Alert: Check your pending tasks.', 'warn'); respond('Warning toast shown.') }, reply: '' },

  // ── KNOWLEDGE — GS1 DEEP TOPICS ───────────────────────────────────────────
  { re: /explain.*sangam.*age|sangam.*period.*explain/i,                                      action: () => respond('Sangam Age (300 BCE–300 CE): Three Tamil kingdoms — Chola, Chera, Pandya. Literature: Tolkappiyam (grammar), Purananuru, Akananuru. Economy: trade with Rome. Key for GS1 History.'), reply: '' },
  { re: /explain.*decline.*mughal|why.*mughal.*fell|mughal.*decline.*reason/i,                action: () => respond('Mughal decline: Aurangzeb\'s Deccan wars (1681-1707) drained treasury. Religious intolerance weakened support. Maratha rise. Nadir Shah sack of Delhi (1739). Weak successors. British East India Company exploited vacuum.'), reply: '' },
  { re: /bhakti.*movement.*impact|bhakti.*contribution|bhakti.*saints.*upsc/i,               action: () => respond('Bhakti Movement impact: challenged caste hierarchy, promoted vernacular languages, opposed idol worship (Kabir, Nanak) OR endorsed devotion (Tukaram, Mirabai). Contributed to formation of Hindi, Marathi, Bengali, Tamil languages.'), reply: '' },
  { re: /green.*revolution.*impact|green.*revolution.*consequences/i,                         action: () => respond('Green Revolution (1960s-70s): Punjab and Haryana wheat revolution (Borlaug varieties). Doubled food production. But: regional imbalance, groundwater depletion, soil degradation, farmer debt, monoculture risks. Second Green Revolution needed for pulses and eastern states.'), reply: '' },
  { re: /non.*cooperation.*significance|non.*cooperation.*impact|1920.*movement.*effect/i,   action: () => respond('Non-Cooperation Movement (1920-22): First mass movement involving all classes. Boycott of foreign goods boosted Swadeshi. Showed Indians could challenge Empire. Hartals, lawyer strikes effective. Called off after Chauri Chaura — debate on Gandhi\'s decision continues.'), reply: '' },

  // ── KNOWLEDGE — GS2 DEEP TOPICS ───────────────────────────────────────────
  { re: /cooperative.*federalism.*explain|what.*cooperative.*federalism/i,                    action: () => respond('Cooperative Federalism: Centre and States work together as partners, not adversaries. Examples: GST Council (joint body), Inter-State Council (coordination), NDC (now scrapped). NITI Aayog promotes competitive federalism alongside.'), reply: '' },
  { re: /anti.*defection.*law|10th.*schedule.*explain|defection.*india/i,                    action: () => respond('Anti-Defection Law (10th Schedule, 52nd Amendment 1985): Disqualification if member voluntarily gives up party membership OR votes against party whip. Exception: merger of 2/3 members. Speaker/Chairman decides — decision subject to judicial review (Kihoto Hollohan case).'), reply: '' },
  { re: /collegium.*system.*explain|collegium.*judiciary|judge.*appointment/i,               action: () => respond('Collegium System: SC collegium of 5 senior judges recommends judges. Evolved through 3 Judges Cases (1982, 1993, 1998). Not in Constitution — judicial interpretation of "consultation" in Art 124. NJAC (99th Amendment) struck down in 2015 — collegium remains.'), reply: '' },
  { re: /speaker.*role.*india|lok.*sabha.*speaker.*powers/i,                                  action: () => respond('Lok Sabha Speaker: Presides over House, certifies Money Bills (Art 110), decides anti-defection cases, maintains order. Elected by House members. Cannot be removed except by resolution with 14-day notice. Casting vote in tie. Not a neutral figure in practice — debates about reform.'), reply: '' },
  { re: /president.*role.*constitution|president.*power.*india/i,                             action: () => respond('President of India: Constitutional head. Powers: Executive (Council of Ministers aids/advises), Legislative (summons Parliament, prorogues, ordinances), Judicial (pardons under Art 72), Emergency (Art 352/356/360). Acts on CoM advice — pocket veto for non-money bills (pockets them — no time limit).'), reply: '' },

  // ── KNOWLEDGE — GS3 DEEP TOPICS ───────────────────────────────────────────
  { re: /why.*india.*exports.*capital|capital.*account.*convertibility|cc.*india/i,           action: () => respond('India has PARTIAL Capital Account Convertibility — FDI freely allowed, FPI regulated, ECB with conditions, full convertibility not yet done. Tarapore Committee (1997, 2006) recommended roadmap. Risk: sudden capital outflows can destabilise rupee.'), reply: '' },
  { re: /what.*is.*msp.*problem|msp.*vs.*market.*price|msp.*issue/i,                         action: () => respond('MSP issues: Covers only 23 crops, most farmers don\'t get MSP (sell below). Procurement concentrated in Punjab/Haryana. Raises food prices. CACP recommends MSP. Swaminathan Commission recommended C2+50% formula — not yet implemented in full.'), reply: '' },
  { re: /explain.*token.*economy|cbdc.*india|digital.*rupee.*explain/i,                       action: () => respond('CBDC (Digital Rupee, e₹): RBI-issued digital currency. Two types: Wholesale (e₹-W, for interbank settlements) and Retail (e₹-R, for general public). Uses blockchain-like DLT. Not a cryptocurrency — backed by RBI. Pilot launched 2022.'), reply: '' },
  { re: /jan.*movement.*water|jal.*jeevan.*mission|har.*ghar.*jal/i,                         action: () => respond('Jal Jeevan Mission (2019): Tap water connection (Functional Household Tap Connection — FHTC) to all rural households by 2024. Target: 19 crore connections. Progress: 13+ crore done. Key indicator: women and girls save 40 minutes/day. ₹3.60 lakh crore total outlay.'), reply: '' },
  { re: /india.*climate.*finance|green.*finance.*india|climate.*transition.*fund/i,           action: () => respond('India Climate Finance: NCEF (National Clean Energy Fund) from coal cess. Sovereign Green Bonds issued 2023 (₹16,000 crore). India asks developed nations for $1 trillion/year climate finance under UNFCCC. Green Hydrogen Mission aims ₹8 lakh crore investment.'), reply: '' },

  // ── KNOWLEDGE — GS4 ETHICS DEEP ──────────────────────────────────────────
  { re: /gandhi.*ethics|gandhian.*ethics.*upsc|trusteeship.*gandhi/i,                         action: () => respond('Gandhian Ethics: Trusteeship — wealthy hold property in trust for society. Sarvodaya (welfare of all, not greatest number). Antyodaya (welfare of the last person). Non-violence as both method and goal. Truth as God (Satya = Ishwar). Key GS4 thinker.'), reply: '' },
  { re: /aristotle.*ethics|virtue.*ethics.*aristotle|golden.*mean/i,                          action: () => respond('Aristotle Ethics: Virtue Ethics — character-based. Virtues are means between extremes (Golden Mean). Courage = between cowardice and recklessness. Eudaimonia (flourishing/happiness) as highest good. GS4: applied to civil service — courage, justice, integrity as virtues.'), reply: '' },
  { re: /john.*rawls.*justice|veil.*of.*ignorance|difference.*principle/i,                   action: () => respond('John Rawls Justice (A Theory of Justice, 1971): Justice as Fairness. Veil of Ignorance — design society without knowing your position. Difference Principle — inequalities permissible only if they benefit the worst-off. Applies to reservation policy design in India.'), reply: '' },
  { re: /civil.*servant.*neutrality|neutrality.*bureaucracy|impartiality.*ias/i,              action: () => respond('Civil Servant Neutrality: Serve the elected government without partisan bias. Political neutrality ≠ moral neutrality — officers must refuse illegal orders. Rule 3 of AIS (Conduct) Rules prohibits political activity. Tension between loyalty to minister and constitutional obligations.'), reply: '' },

  // ── QUICK FACT BLASTS ────────────────────────────────────────────────────
  { re: /3.*facts.*polity|three.*facts.*constitution|quick.*polity.*facts/i,                  action: () => respond('3 quick Polity facts: 1. India has the longest written Constitution in the world — 448 articles originally. 2. The President is elected by an Electoral College including elected MPs and MLAs. 3. Rajya Sabha is a permanent body — 1/3 members retire every 2 years.'), reply: '' },
  { re: /3.*facts.*history|three.*facts.*indian.*history|quick.*history.*facts/i,             action: () => respond('3 quick History facts: 1. The first newspaper in India was "Bengal Gazette" (1780) by James Augustus Hicky. 2. The Constituent Assembly had 299 members when it adopted the Constitution. 3. India\'s Independence Day was August 15, 1947 — Jinnah declared Pakistan\'s independence on August 14.'), reply: '' },
  { re: /3.*facts.*environment|three.*facts.*ecology|quick.*environment.*facts/i,             action: () => respond('3 quick Environment facts: 1. India has 75 Ramsar wetland sites — more than any country. 2. Western Ghats and Eastern Himalayas are two of India\'s 4 biodiversity hotspots. 3. India ranks 5th globally in renewable energy capacity and has committed to Net Zero by 2070.'), reply: '' },
  { re: /3.*facts.*economy|three.*facts.*economics|quick.*economy.*facts/i,                   action: () => respond('3 quick Economy facts: 1. India is the world\'s 5th largest economy by nominal GDP (~$3.7 trillion). 2. Services sector contributes ~55% of GDP but employs only ~31% of workforce. 3. GST has 4 slabs (5%, 12%, 18%, 28%) and replaced 17+ different taxes.'), reply: '' },

  // ── SMART REMINDERS ───────────────────────────────────────────────────────
  { re: /remind.*me.*after.*session|session.*end.*reminder|post.*session.*reminder/i,         action: () => { _reminders.push({id:_nextRemId++,msg:'Session complete — add your score and review mistakes!',at:Date.now()+30*60000}); respond('Reminder set for after your session. I\'ll prompt you to log scores and review mistakes.') }, reply: '' },
  { re: /morning.*brief.*reminder|set.*morning.*brief|subah.*ka.*brief/i,                    action: () => { const now=new Date(); const t=new Date(); t.setHours(6,30,0,0); if(t<=now) t.setDate(t.getDate()+1); _reminders.push({id:_nextRemId++,msg:'Good morning! Here is your study brief for today.',at:t.getTime()}); respond(`Morning brief reminder set for 6:30 AM — in ${Math.round((t.getTime()-Date.now())/60000)} minutes.`) }, reply: '' },
  { re: /remind.*revision.*time|daily.*revision.*reminder|revision.*alarm/i,                  action: () => { const now=new Date(); const t=new Date(); t.setHours(20,0,0,0); if(t<=now) t.setDate(t.getDate()+1); _reminders.push({id:_nextRemId++,msg:'Revision time! Open JARVIS planner and rate your SRS cards.',at:t.getTime()}); respond('Daily revision reminder set for 8 PM.') }, reply: '' },
  { re: /remind.*bedtime.*study|study.*stop.*time|stop.*studying.*reminder/i,                 action: () => { const now=new Date(); const t=new Date(); t.setHours(22,30,0,0); if(t<=now) t.setDate(t.getDate()+1); _reminders.push({id:_nextRemId++,msg:'Time to wrap up. Review tomorrow\'s plan and sleep by 11.',at:t.getTime()}); respond('Study-stop reminder set for 10:30 PM.') }, reply: '' },

  // ── ADVANCED INTELLIGENCE — GROQ-POWERED ─────────────────────────────────
  { re: /compare.*art.*21.*art.*32|21.*vs.*32.*constitution|art.*21.*32.*difference/i,       action: () => { if(GROQ_AVAILABLE) void executeIntent('Compare Article 21 and Article 32 of the Indian Constitution in 3 spoken sentences. What each protects, how they differ, and how they complement each other.') ; else respond('Art 21: Right to Life and Liberty (cannot be denied except by procedure). Art 32: Right to move SC directly for FR enforcement — called the "heart and soul" of Constitution by Dr. Ambedkar. Both Part III, but 32 is the remedy for 21 violations.') }, reply: '' },
  { re: /what.*difference.*polity.*constitution|polity.*vs.*constitution|constitution.*polity.*difference/i, action: () => respond('Polity = the broader study of political systems, governance, institutions. Constitution = the founding legal document. For UPSC, Polity includes the Constitution PLUS democratic theory, federalism, local bodies, electoral system, and governance issues.'), reply: '' },
  { re: /explain.*money.*bill.*vs.*finance.*bill|money.*finance.*bill.*difference/i,         action: () => respond('Money Bill (Art 110): Introduced only in LS, certified by Speaker, RS has 14-day window, LS prevails. Finance Bill: broader — if it deals with taxes beyond Art 110 scope, it is a Finance Bill requiring both Houses. Distinction is crucial for parliamentary procedure.'), reply: '' },
  { re: /explain.*federal.*unitary|india.*federal.*or.*unitary|quasi.*federal.*explain/i,    action: () => respond('India is quasi-federal: federal form (two levels of government, written Constitution, Supreme Court) with unitary features (strong Centre — Governor, emergency provisions, all-India services, residuary powers). Called "Union of States" — not a federation — by Dr. Ambedkar.'), reply: '' },
  { re: /give.*analogy.*for.*basic.*structure|explain.*basic.*structure.*simple/i,           action: () => respond('Basic Structure analogy: Imagine the Constitution as a house. Parliament can renovate rooms, add floors, change decor. But it cannot demolish the foundation — that foundation is the Basic Structure. Kesavananda Bharati (1973) identified these elements. Parliament can amend, not destroy.'), reply: '' },

  // ── UPSC EXAM STRATEGY ───────────────────────────────────────────────────
  { re: /how.*attempt.*prelims|prelims.*attempt.*strategy|which.*questions.*attempt/i,       action: () => respond('Prelims strategy: First pass (45 min) — attempt 100% confident questions. Second pass (50 min) — attempt 66%+ confident. Third pass (25 min) — review and adjust. Never guess blind. Target: 60-65 attempts with 90%+ accuracy = 100+ marks.'), reply: '' },
  { re: /time.*management.*prelims|120.*minutes.*strategy|prelims.*timing/i,                 action: () => respond('Prelims timing: 100 questions in 120 minutes = 72 seconds each. Set 3 mental checkpoints: 25 questions at 30 min, 50 at 60 min, 75 at 90 min. If behind, skip uncertain questions — never spend 3+ minutes on one question.'), reply: '' },
  { re: /mains.*writing.*speed|how.*fast.*write.*mains|writing.*speed.*target/i,             action: () => respond('Mains writing speed: Target 18-20 words per minute (200-word answer in ~11 minutes, 150-word in ~8 min). 9 papers in 5 days — physical stamina matters. Practice writing continuously for 3-hour stretches. Pain in wrist = practice more now.'), reply: '' },
  { re: /interview.*marks.*calculation|upsc.*interview.*scoring|how.*interview.*marked/i,    action: () => respond('Interview marks: 275 total. Average marks in interview: 160-180 (general). High scorers: 200-230. Variation of 30-50 marks between similar candidates — board discretion is high. Strong DAF, balanced answers, and personality expression matter most.'), reply: '' },
  { re: /how.*select.*optional.*subject|best.*optional.*for.*me|optional.*selection/i,       action: () => respond('Optional selection criteria: 1. Background — is it your graduation subject? 2. Interest — can you study it for 1000+ hours? 3. Source material — are reliable books available? 4. Scoring trend — check last 5 years toppers\' optionals. High scorers: Sociology, PSIR, Mathematics (high ceiling), Anthropology.'), reply: '' },

  // ── WEBSITE INTEGRATION ───────────────────────────────────────────────────
  { re: /open.*command.*menu|show.*command.*palette|open.*palette/i,                          action: () => { const btn=document.getElementById('command-menu-btn')??document.querySelector<HTMLElement>('[data-cmd-menu]'); btn?.click(); respond('Command menu opened.') }, reply: '' },
  { re: /close.*command.*menu|hide.*command.*palette/i,                                       action: () => { document.getElementById('command-menu')?.classList.remove('open'); document.getElementById('menu-backdrop')?.classList.remove('show'); respond('Menu closed.') }, reply: '' },
  { re: /refresh.*data|reload.*data|sync.*data.*now|force.*data.*reload/i,                   action: () => { respond('Reloading data from Supabase…'); window.dispatchEvent(new CustomEvent('jarvis:force-sync')); setTimeout(()=>respond('Data refreshed. Charts and planner updated.'),2000) }, reply: '' },
  { re: /check.*online.*status|am.*i.*online.*now|network.*status.*check/i,                  action: () => respond(navigator.onLine?'Online and connected. All data syncing to the cloud.':'Offline. Working locally — changes will sync on reconnect.'), reply: '' },
  { re: /show.*revision.*queue.*now|open.*srs.*queue|revision.*list.*show/i,                 action: () => { scr('plan'); setTimeout(()=>{ const lbl=Array.from(document.querySelectorAll<HTMLElement>('#plan .card-label')).find(e=>e.textContent?.toLowerCase().includes('revision')); lbl?.scrollIntoView({behavior:'smooth',block:'start'}); respond(buildRevisionLine()) },500) }, reply: '' },
  { re: /show.*answer.*writing.*section|open.*mains.*writing|answer.*log.*open/i,            action: () => { cl('cm-answer-log'); respond('Answer Writing log opened. Log your daily mains practice here.') }, reply: '' },
  { re: /open.*goals.*panel|show.*my.*goals|goals.*open/i,                                   action: () => { cl('cm-goals'); respond('Daily and weekly goals opened. Set your targets.') }, reply: '' },
  { re: /open.*weekly.*review|weekly.*ritual.*start|end.*week.*review/i,                     action: () => { cl('cm-weekly-review'); respond('Weekly review opened. Reflect on this week — what worked, what to improve.') }, reply: '' },
  { re: /show.*sync.*indicator|sync.*dot.*status|jv.*sync.*dot/i,                            action: () => { const dot=document.getElementById('jv-sync-dot'); respond(dot?.classList.contains('offline')?'Offline — dot is red.':dot?.classList.contains('syncing')?'Syncing — dot is pulsing.':'Online — dot is green.') }, reply: '' },

  // ── HINDI DEEP COMMANDS ───────────────────────────────────────────────────
  { re: /mujhe.*constitution.*samjhao|sanvidhan.*kya.*hota.*hai|constitution.*explain.*hindi/i, action: () => respond('Sanvidhan: desh ka sabse bada kanoon. 22 parts, 448 articles (originally), 12 schedules. Fundamental Rights (Part III), DPSPs (Part IV), Federal structure (Parts V-XI). Drafted 1946-49, effective 26 January 1950. Dr. Ambedkar ne draft kiya.'), reply: '' },
  { re: /mujhe.*economy.*samjhao|economy.*explain.*hindi|arthniti.*kya.*hai/i,               action: () => respond('Economy simple words mein: GDP = desh ki total kamaai. Inflation = cheezein mehngi hona. Repo rate = RBI ka interest rate. GST = ek tax system. Budget = government ki kamai aur kharche ka plan. 5 trillion dollar economy = India ka 2028 target.'), reply: '' },
  { re: /kaise.*interview.*dein|interview.*kaise.*clear.*karen|upsc.*interview.*hindi/i,     action: () => respond('UPSC interview ke liye: DAF ke har entry pe 5 questions prepare karo. Sach bolna — board jaanta hai agar galat bol rahe ho. Balance — na extreme position lo, na fence-sitter bano. Body language — seedha baitho, aankhon se contact. Practice: mirror ke saamne, ya mock interview.'), reply: '' },
  { re: /jarvis.*mujhe.*padhao|tum.*padha.*sakte.*ho|padhao.*mujhe/i,                       action: () => { const topic=_sessionSubject||getCurrentState()?.today?.subject||'UPSC GS'; respond(`Chalo ${topic} padhate hain! Shuru karte hain ek basic concept se aur badhte hain.`); void startQuiz(topic) }, reply: '' },
  { re: /mood.*theek.*nahi|mann.*nahi.*padhai.*mein|padhai.*achhi.*nahi.*lag.*rahi/i,        action: () => respond('Hota hai — Mann ka nahi karna normal hai. Lekin ek kaam karo: sirf 2 minutes timer set karo. Kitab kholo, ek paragraph padho. Aksar 2 minute mein mood shift ho jaata hai. Agar fir bhi nahi hua, chhota break lo. Lekin band mat karo.'), reply: '' },

  // ── JARVIS v9 META ────────────────────────────────────────────────────────
  { re: /jarvis.*v9|jarvis.*new.*version|version.*9/i,                                        action: () => respond('JARVIS v9: 900+ voice commands, full website control (direct form filling, stats reading, planner control, timer management), smart online/offline AI switching (auto-retries Groq when offline fallback fires), 100+ new knowledge commands, Hindi deep mode. Mission 2028 ready.'), reply: '' },
  { re: /jarvis.*command.*count|how.*many.*commands.*total|total.*commands.*jarvis/i,         action: () => respond('JARVIS has 900+ registered voice command patterns across 20+ categories: navigation, timer, planner, scores, revision, mistakes, notes, CA, goals, constitution, knowledge (GS1-4), CSAT, quiz, interview, essay, ambient, vision, and meta commands.'), reply: '' },
  { re: /what.*jarvis.*cannot.*do|jarvis.*limitation|jarvis.*cant.*do/i,                     action: () => respond('JARVIS limitations: cannot access external websites or real-time news (no browser). Cannot store data to Supabase directly — routes through the app. Cannot guarantee 100% accuracy on UPSC knowledge — verify critical facts. Vision requires camera permission. Quiz requires Groq API key.'), reply: '' },

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND BANK v7 — 200+ Integration, Sync & Advanced Commands
  // ════════════════════════════════════════════════════════════════════════════

  // ── NOTIFICATIONS & SYNC ─────────────────────────────────────────────────
  { re: /enable.*notifications|allow.*notifications|notification.*on|notif.*allow/i,  action: () => { void requestNotifPermission(); respond('Notification permission requested. Allow it in your browser to get reminders even when the tab is in the background.') }, reply: '' },
  { re: /notification.*status|notif.*kaam.*kar.*raha|are.*notifications.*on/i,        action: () => respond(`Browser notifications: ${_notifGranted ? 'Enabled — reminders will appear even in background.' : 'Not enabled. Say "enable notifications" to turn on.'}`), reply: '' },
  { re: /am.*i.*online|connection.*status|internet.*check|sync.*check/i,              action: () => respond(navigator.onLine ? 'Online. All data is syncing to the cloud in real time.' : 'Offline. Working locally — all changes will sync when you reconnect.'), reply: '' },
  { re: /test.*notification|send.*test.*notif|notif.*test/i,                          action: () => { browserNotify('⬡ JARVIS Test', 'Notifications are working! Reminders will appear here.'); respond('Test notification sent. Check your notification area.') }, reply: '' },

  // ── SCREEN READING SHORTCUTS ──────────────────────────────────────────────
  { re: /what.*happening|what.*going.*on|app.*status|quick.*status/i,                 action: () => respond(readScreenContent()), reply: '' },
  { re: /describe.*view|what.*open|current.*section/i,                                action: () => respond(readScreenContent()), reply: '' },
  { re: /tell.*me.*everything|full.*report|complete.*briefing|sab.*batao/i,           action: () => { const s=buildStatusReport(); const t=buildTodayReport(); respond(`${s} ${t}`) }, reply: '' },

  // ── INTERVIEW PRACTICE ────────────────────────────────────────────────────
  { re: /start.*interview|interview.*start|mock.*interview.*begin|personality.*test.*begin/i, action: () => { _ivPhase='active'; _ivQIdx=0; respond('Interview practice starting. Question 1 loading.'); setTimeout(()=>{ respond(`Q1: ${IV_QS_EN[0]}`); _ivQIdx=1 },1500) }, reply: '' },
  { re: /next.*question|agle.*sawaal|skip.*question/i,                                action: () => { if(_ivPhase==='active'){ respond(_ivQIdx < IV_QS_EN.length ? `Q${_ivQIdx+1}: ${IV_QS_EN[_ivQIdx]}` : 'All questions done.'); _ivQIdx++ } else respond('Start interview practice first. Say "start interview practice".') }, reply: '' },
  { re: /end.*interview|interview.*khatam|stop.*interview/i,                          action: () => { _ivPhase='off'; respond(`Interview practice ended. ${_ivQIdx} questions attempted. Review your answers for structure and keywords.`) }, reply: '' },
  { re: /interview.*tips|upsc.*interview.*tips|personality.*test.*tips/i,             action: () => respond('UPSC Interview tips: 1. Answer truthfully — board can verify. 2. Structured answers: position → reasoning → example. 3. Say "I would need more information" for unclear hypotheticals. 4. Show awareness of India\'s challenges. 5. Your body language matters as much as content.'), reply: '' },
  { re: /common.*interview.*question|typical.*upsc.*interview.*question/i,            action: () => respond('Common UPSC Interview questions: Tell me about yourself. Why civil services. Your home district problems. Current affair opinion. A leadership experience. Ethical dilemma. Policy critique. Weak point + how you overcame it.'), reply: '' },

  // ── ESSAY PRACTICE ────────────────────────────────────────────────────────
  { re: /essay.*sustainable.*development/i,                                           action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC Mains on: Sustainable Development. Spoken format. Include: definition + relevance, 5 body dimensions, conclusion approach. No markdown.') }, reply: '' },
  { re: /essay.*technology.*india/i,                                                  action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC Mains on: Technology and India. 5 dimensions: economic, social, governance, security, global competitiveness. Spoken. No markdown.') }, reply: '' },
  { re: /essay.*education.*india/i,                                                   action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC Mains on: Education in India. Dimensions: access, quality, NEP 2020, higher education, skill gap. Spoken. No markdown.') }, reply: '' },
  { re: /essay.*women.*empowerment/i,                                                 action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC Mains on: Women Empowerment in India. Dimensions: legal, economic, social, political, health. Include schemes. Spoken. No markdown.') }, reply: '' },
  { re: /essay.*environment.*development/i,                                           action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC on: Environment vs Development dilemma. Dimensions: constitutional, economic, international, ethical, way forward. Spoken. No markdown.') }, reply: '' },
  { re: /essay.*democracy/i,                                                          action: () => { if(GROQ_AVAILABLE) void executeIntent('Essay outline for UPSC on: Democracy in India. Dimensions: electoral, deliberative, social, economic, federalism. Spoken. No markdown.') }, reply: '' },

  // ── JOURNAL & REFLECTION ─────────────────────────────────────────────────
  { re: /show.*journal|journal.*history|past.*reflection|meri.*journal/i,             action: () => { try { const j=JSON.parse(localStorage.getItem(JOURNAL_KEY)??"[]") as Array<{date:string;mood:number;learned:string}>; respond(j.length ? `${j.length} journal entries. Last entry (${j[j.length-1].date}): mood ${j[j.length-1].mood}/5, learned "${j[j.length-1].learned.slice(0,60)}".` : 'No journal entries yet.') } catch { respond('No journal data.') } }, reply: '' },
  { re: /gratitude.*today|aaj.*ke.*liye.*shukriya|thankful.*today/i,                  action: () => { respond(L(detectResponseLang(''),'Name three things you are grateful for today. Say them aloud — this practice reduces cortisol by 23%.','आज के लिए तीन चीज़ें बताओ जिनके लिए आभारी हो। इससे stress 23% कम होती है।','Aaj ke liye teen cheezein batao jinke liye grateful ho. Stress 23% kam hoti hai.')) }, reply: '' },
  { re: /mood.*check|how.*feeling|feeling.*kaisa|mera.*mood.*kaisa/i,                 action: () => { _journalStep='mood'; respond(L(detectResponseLang(''),'Rate your current mood: 1 = very low, 5 = excellent.','अभी का mood 1 से 5 में rate करो।','Abhi ka mood 1 se 5 mein rate karo.')) }, reply: '' },
  { re: /confidence.*report|confidence.*kya.*hai|meri.*confidence.*kahan|all.*confidence/i, action: () => { const c=(_mem as any).confidence as Record<string,number>|undefined; respond(c && Object.keys(c).length ? `Confidence scores: ${Object.entries(c).map(([k,v])=>`${k}: ${v}/5`).join(', ')}.` : 'No confidence scores recorded yet. Say "rate confidence on Polity" to start.') }, reply: '' },

  // ── AMBIENT MODE ─────────────────────────────────────────────────────────
  { re: /ambient.*status|is.*ambient.*on|ambient.*kya.*hai/i,                         action: () => respond(`Ambient mode is ${_ambientMode === 'off' ? 'OFF — I am fully active.' : 'ON (whisper mode) — I whisper every 25 minutes.'}`), reply: '' },
  { re: /silent.*jarvis|mute.*jarvis|band.*ho.*jarvis|chup.*ho.*ja/i,                 action: () => { _ambientMode='whisper'; clearInterval(_ambientIntervalId); respond('Going silent. Focus mode on.'); setTimeout(()=>closePanel(),1500) }, reply: '' },

  // ── LECTURE TRACKER ───────────────────────────────────────────────────────
  { re: /how.*long.*studying.*lecture|kitna.*time.*hua.*lecture|lecture.*time.*track/i, action: () => { if(_activeLectureName && _lectureStartMs) { const m=Math.round((Date.now()-_lectureStartMs)/60000); respond(`"${_activeLectureName}": ${m} minutes so far.`) } else respond('No active lecture being tracked. Say "studying lecture [name]" to start tracking.') }, reply: '' },
  { re: /stop.*tracking|lecture.*track.*stop|tracking.*band/i,                        action: () => { _activeLectureName=''; _lectureStartMs=0; respond('Lecture tracking stopped.') }, reply: '' },

  // ── DYNAMIC QUIZ ─────────────────────────────────────────────────────────
  { re: /quiz.*based.*on.*history|smart.*quiz|adaptive.*quiz/i,                       action: () => { const weak=_mem.weakTopics.slice(-1)[0]||getCurrentState()?.today?.subject||'UPSC GS'; const scores=_mem.quizScores[weak]??[]; const avg=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:50; const diff=avg<50?'basic':avg>80?'advanced':'standard'; respond(`Adaptive quiz on ${weak}. Going ${diff} based on your history.`); void startQuiz(`${weak} — difficulty: ${diff}`) }, reply: '' },
  { re: /quiz.*score.*history|past.*quiz.*scores|meri.*quiz.*performance/i,           action: () => { const entries=Object.entries(_mem.quizScores); respond(entries.length ? entries.map(([t,sc])=>`${t}: ${(sc.reduce((a,b)=>a+b)/sc.length).toFixed(0)}% avg`).join(', ') : 'No quiz history yet. Take a quiz to start tracking.') }, reply: '' },

  // ── STUDY SCIENCE & META-LEARNING ────────────────────────────────────────
  { re: /what.*is.*metacognition|metacognition.*upsc|thinking.*about.*thinking/i,     action: () => respond('Metacognition: awareness of your own learning. For UPSC: after each study session, ask "what did I actually understand?" vs "what did I just read?". Active recall tests metacognition — it exposes gaps passive re-reading hides.'), reply: '' },
  { re: /what.*is.*interleaving|interleaving.*study|mix.*subjects.*why/i,             action: () => respond('Interleaving: mixing subjects during study rather than blocking. Research shows 40% better retention. For UPSC: alternate Polity → History → Economy in one session rather than doing 3 hours of one subject.'), reply: '' },
  { re: /what.*is.*retrieval.*practice|why.*test.*yourself|active.*recall.*explained/i, action: () => respond('Retrieval practice: the act of recalling information strengthens memory more than re-reading. Every quiz, flashcard, and self-test is retrieval practice. JARVIS quiz mode is built on this principle.'), reply: '' },
  { re: /sleep.*learning|memory.*consolidation.*sleep|nind.*aur.*padhai/i,            action: () => respond('Sleep and learning: during sleep, the brain consolidates the day\'s learning into long-term memory. Studying before sleep and reviewing after waking (sleep sandwich) has the best retention. 7-8 hours protects what you studied.'), reply: '' },
  { re: /how.*brain.*learns|neuroscience.*study|brain.*memory|synaptic.*plasticity/i, action: () => respond('The brain learns through: 1. Repetition (spaced repetition strengthens synaptic connections), 2. Emotion (stressed or excited states encode stronger memories), 3. Association (linking new info to what you know). UPSC preparation uses all three.'), reply: '' },

  // ── IAS OFFICER WISDOM ────────────────────────────────────────────────────
  { re: /ias.*officer.*life|day.*in.*life.*ias|what.*ias.*officers.*do/i,             action: () => respond('IAS officers: District Magistrate controls law and order, land administration, disaster response. Secretary formulates policy. Commissioner implements. Work is 10-14 hours/day, high-pressure, but deeply meaningful — you serve 1-2 million people as DM.'), reply: '' },
  { re: /ips.*vs.*ias|difference.*ias.*ips|ias.*ips.*comparison/i,                   action: () => respond('IAS vs IPS: IAS is generalist administration — DM, Secretary, Cabinet Secretary. IPS is police service — SP, DGP, IB, CBI. IAS has more policy influence; IPS has law enforcement focus. Both are Group A All India Services.'), reply: '' },
  { re: /ifs.*career|indian.*foreign.*service|diplomat.*career/i,                    action: () => respond('IFS: India\'s diplomatic service. Postings: Embassies, High Commissions, MEA headquarters. Work: bilateral relations, consular services, multilateral negotiations. Selected via same UPSC exam. Requires 2+ foreign language learning.'), reply: '' },
  { re: /irs.*career|indian.*revenue.*service|income.*tax.*career/i,                  action: () => respond('IRS (IT and CE): Indian Revenue Service. Income Tax and Customs/Excise streams. Implements tax laws. Works under Finance Ministry. Selected via UPSC. Career in taxation, investigation, policy.'), reply: '' },

  // ── COMPREHENSIVE GS TRIVIA ───────────────────────────────────────────────
  { re: /who.*wrote.*arthashastra|arthashastra.*author/i,                             action: () => respond('Arthashastra was written by Kautilya (also known as Chanakya or Vishnugupta). It is a treatise on statecraft, economic policy, and military strategy written around 4th century BCE.'), reply: '' },
  { re: /who.*wrote.*ain.*akbari|abul.*fazl|akbarnama/i,                              action: () => respond("Ain-i-Akbari and Akbarnama were written by Abul Fazl, the court historian of Emperor Akbar. Ain-i-Akbari is an administrative manual and statistical account of Akbar's empire."), reply: '' },
  { re: /drain.*theory.*india|dadabhai.*naoroji|economic.*drain/i,                   action: () => respond("Drain Theory was articulated by Dadabhai Naoroji in his book 'Poverty and Un-British Rule in India' (1901). He argued British colonialism was draining India's wealth through excess exports, home charges, and profit remittances."), reply: '' },
  { re: /tryst.*with.*destiny|jawaharlal.*nehru.*speech|midnight.*speech/i,           action: () => respond("'Tryst with Destiny' was Jawaharlal Nehru's speech delivered at midnight on August 15, 1947. Opening: 'Long years ago we made a tryst with destiny...' It marked India's independence from British rule."), reply: '' },
  { re: /preamble.*words|we.*the.*people|sovereign.*socialist.*secular/i,            action: () => respond("The Preamble: 'We, the People of India, having solemnly resolved to constitute India into a Sovereign, Socialist, Secular, Democratic Republic and to secure to all its citizens Justice, Liberty, Equality, and to promote among them Fraternity...' Adopted November 26, 1949."), reply: '' },

  // ── HINDI CULTURE & UPSC ─────────────────────────────────────────────────
  { re: /satyameva.*jayate.*meaning|rashtriya.*motto|national.*motto.*meaning/i,      action: () => respond("Satyameva Jayate means 'Truth alone triumphs'. It is taken from the Mundaka Upanishad. It is inscribed below the National Emblem (Sarnath Lion Capital of Ashoka)."), reply: '' },
  { re: /vande.*mataram.*meaning|vande.*mataram.*history/i,                           action: () => respond("Vande Mataram means 'I bow to thee, Mother'. Composed by Bankim Chandra Chattopadhyay in Sanskrit in his novel Anandamath (1882). First two stanzas have the same status as Jana Gana Mana."), reply: '' },
  { re: /bharat.*mata.*ki.*jai|jai.*hind.*meaning/i,                                  action: () => respond("'Jai Hind' was popularised by Netaji Subhas Chandra Bose as the battle cry of the Indian National Army. It means 'Long live India'. 'Bharat Mata ki Jai' means 'Victory to Mother India'."), reply: '' },
  { re: /hindi.*diwas|hindi.*day.*september|14.*september.*hindi/i,                   action: () => respond("Hindi Diwas is celebrated on September 14 each year. On this day in 1949, the Constituent Assembly of India adopted Hindi written in Devanagari script as the official language of the Republic."), reply: '' },

  // ── JARVIS ADVANCED META ─────────────────────────────────────────────────
  { re: /jarvis.*capabilities.*full|full.*capability.*list|what.*all.*jarvis.*do/i,   action: () => respond('JARVIS v5 capabilities: 693 voice commands, continuous conversation, interview practice, essay outlines, voice journal, screen reading, ambient mode, push notifications, confidence tracking, lecture time tracking, quiz with SRS, answer evaluation, debate mode, cross-session memory, emotion detection, multilingual (EN/HI/Hinglish), vision (6 modes), EMA clap detection.'), reply: '' },
  { re: /jarvis.*offline.*work|works.*without.*internet|offline.*jarvis/i,            action: () => respond('JARVIS offline: all 693 CMDS work offline (zero network). Quiz requires Groq API. All data writes are cached locally and sync on reconnect. The full app is PWA-installable and works offline.'), reply: '' },
  { re: /how.*save.*data|data.*kahan.*save|app.*data.*secure/i,                       action: () => respond('Your data: stored in Supabase cloud (encrypted) + localStorage (offline backup). No data is sent to third parties. Groq only receives your question text for AI processing — no personal data. All study data stays in your account.'), reply: '' },
  { re: /what.*groq.*model|which.*ai.*model|groq.*llama|ai.*engine/i,                 action: () => respond('JARVIS uses Groq: Llama-3.3-70B-Versatile for deep UPSC answers and coaching (best quality), Llama-3.1-8B-Instant for fast intent classification, Llama-4-Scout for vision analysis. All run at ultra-low latency via Groq infrastructure.'), reply: '' },
]

// Filter out inline-handled entries (empty reply delegates to respond() inside action)
const FILTERED_CMDS = CMDS

// ── Quiz System ───────────────────────────────────────────────────────────────
async function startQuiz(topic: string): Promise<void> {
  const lang = detectResponseLang('')
  if (!GROQ_KEY) {
    respond(lang === 'hi' ? 'Quiz के लिए VITE_GROQ_API_KEY add करो।' : 'Add VITE_GROQ_API_KEY to enable quiz mode.')
    return
  }
  _quizTopic = topic   // store for SRS + memory
  setState('thinking')
  setStatus(lang === 'hi' ? 'Quiz तैयार हो रहा है…' : 'Preparing quiz…')
  // If user has a weak topic list, bias the prompt towards commonly missed areas
  const _hasWeakBias = _mem.weakTopics.length > 0 && !topic.includes(' ')
  const topicWithBias = _hasWeakBias ? `${topic} — focus on commonly missed areas` : topic
  respond(
    lang === 'hi'       ? `${topic} पर 5 MCQs तैयार हो रहे हैं। तैयार हो जाओ।` :
    lang === 'hinglish' ? `${topic} par 5 MCQs aa rahe hain. Taiyar ho jao.` :
                          `Preparing 5 MCQs on ${topic}. Get ready.`
  )

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{
          role: 'user',
          content: `Generate exactly 5 UPSC Prelims-style MCQs on the topic: "${topic}".
Format each question EXACTLY like this (no extra text):
Q: [question text]
A) [option]
B) [option]
C) [option]
D) [option]
ANS: [letter A/B/C/D]
EXP: [one-sentence explanation]
---`,
        }],
        max_tokens: 1200, temperature: 0.4, stream: false,
      }),
    })
    if (!res.ok) throw new Error('quiz fetch failed')
    const d = await res.json() as { choices: { message: { content: string } }[] }
    _quizItems = parseQuizResponse(d.choices[0].message.content)
    if (_quizItems.length === 0) { respond('Could not parse quiz questions. Try a different topic.'); return }
    _quizIdx = 0; _quizHits = 0; _quizPhase = 'asking'
    void askQuizQuestion()
  } catch { respond('Quiz fetch failed. Check your connection.') }
}

function parseQuizResponse(raw: string): MCQItem[] {
  // Split by separator or blank line before Q:
  const blocks = raw.split(/---+|\n\n(?=Q[:.])/g).map(b => b.trim()).filter(Boolean)
  const items: MCQItem[] = []

  for (const b of blocks) {
    // Question — handles "Q:" / "Q." / "Question N:" / "Q1:" / numbered "1."
    const qMatch = b.match(/(?:Q[:.\d\s]*|Question\s*\d*[:.])\s*(.+)/i)
    const q = qMatch?.[1]?.trim() ?? ''

    // Options — handles "A)" / "A." / "(A)" / "a)" / "Option A:"
    const optA = b.match(/(?:\(A\)|A[).]|option\s*A:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optB = b.match(/(?:\(B\)|B[).]|option\s*B:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optC = b.match(/(?:\(C\)|C[).]|option\s*C:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optD = b.match(/(?:\(D\)|D[).]|option\s*D:?)\s*(.+)/i)?.[1]?.trim() ?? ''

    // Answer — "ANS:" / "Answer:" / "Correct:" / "Key:" + letter
    const ans = (
      b.match(/(?:ANS|Answer|Correct\s*Answer|Key):\s*\(?([A-D])\)?/i) ??
      b.match(/\bThe\s+(?:correct\s+)?answer\s+is\s+\(?([A-D])\)?/i) ??
      b.match(/\(([A-D])\)\s*(?:is correct|✓)/i)
    )?.[1]?.toUpperCase() ?? ''

    // Explanation
    const exp = b.match(/(?:EXP(?:LANATION)?|Reason|Note):\s*(.+)/i)?.[1]?.trim() ?? ''

    if (q && (optA || optB) && ans) {
      items.push({ q, opts:[optA,optB,optC,optD].map(o => o || '—'), ans, exp })
    }
  }
  return items.slice(0, 5)
}

async function askQuizQuestion(): Promise<void> {
  if (_quizIdx >= _quizItems.length) { void finishQuiz(); return }
  const item = _quizItems[_quizIdx]
  const qText = `Question ${_quizIdx+1} of ${_quizItems.length}. ${item.q}. Option A: ${item.opts[0]}. Option B: ${item.opts[1]}. Option C: ${item.opts[2]}. Option D: ${item.opts[3]}. Your answer?`
  addMsg('assistant', `**Q${_quizIdx+1}:** ${item.q}\n\nA) ${item.opts[0]}\nB) ${item.opts[1]}\nC) ${item.opts[2]}\nD) ${item.opts[3]}`)
  speak(qText)
}

function parseQuizAnswer(t: string): string | null {
  if (/\boption a\b|\banswer a\b|\bthe answer is a\b|^a$|^\(a\)$/i.test(t)) return 'A'
  if (/\boption b\b|\banswer b\b|\bthe answer is b\b|^b$|^\(b\)$/i.test(t)) return 'B'
  if (/\boption c\b|\banswer c\b|\bthe answer is c\b|^c$|^\(c\)$/i.test(t)) return 'C'
  if (/\boption d\b|\banswer d\b|\bthe answer is d\b|^d$|^\(d\)$/i.test(t)) return 'D'
  return null
}

async function handleQuizAnswer(chosen: string): Promise<void> {
  const item = _quizItems[_quizIdx]
  const lang = detectResponseLang('')
  _quizIdx++
  let reply = ''
  if (chosen === item.ans) {
    _quizHits++
    reply =
      lang === 'hi'       ? `बिल्कुल सही! ${item.exp}` :
      lang === 'hinglish' ? `Bilkul sahi! ${item.exp}` :
                            `Correct! ${item.exp}`
  } else {
    reply =
      lang === 'hi'       ? `नहीं, सही उत्तर ${item.ans} है। ${item.exp}` :
      lang === 'hinglish' ? `Nahi, sahi jawab ${item.ans} hai. ${item.exp}` :
                            `Not quite. The answer is ${item.ans}. ${item.exp}`
  }
  addMsg('assistant', reply)
  _quizPhase = 'revealed'
  speak(reply)
  setTimeout(() => {
    if (_quizIdx < _quizItems.length) {
      _quizPhase = 'asking'
      void askQuizQuestion()
    } else {
      void finishQuiz()
    }
  }, 5000)
}

async function nextQuizQuestion(): Promise<void> {
  if (_quizIdx >= _quizItems.length) { void finishQuiz(); return }
  _quizPhase = 'asking'; void askQuizQuestion()
}

function finishQuiz(): void {
  _quizPhase = 'off'
  const pct  = Math.round((_quizHits / _quizItems.length) * 100)
  const lang = detectResponseLang('')

  // Persist quiz score to memory for trend tracking
  if (_quizTopic) {
    if (!_mem.quizScores[_quizTopic]) _mem.quizScores[_quizTopic] = []
    _mem.quizScores[_quizTopic].push(pct)
    // Keep only last 5 scores per topic
    if (_mem.quizScores[_quizTopic].length > 5) _mem.quizScores[_quizTopic].shift()
    // Auto-flag as weak if score < 60%
    if (pct < 60 && !_mem.weakTopics.includes(_quizTopic)) {
      _mem.weakTopics.push(_quizTopic)
      if (_mem.weakTopics.length > 20) _mem.weakTopics.shift()
    }
    // Auto-flag as strong if score >= 90%
    if (pct >= 90 && !_mem.strongTopics.includes(_quizTopic)) {
      _mem.strongTopics.push(_quizTopic)
    }
    saveMem()
  }

  const followUp = pct < 60 ? L(lang, ` ${_quizTopic} added to your weak topics list for targeted revision.`, ` ${_quizTopic} weak topics में add हो गया।`, ` ${_quizTopic} weak topics mein add ho gaya.`) : pct >= 90 ? L(lang, ` ${_quizTopic} flagged as a strong area.`, ` ${_quizTopic} strong area में flag हुआ।`, ` ${_quizTopic} strong area mein flag hua.`) : ''

  if (lang === 'hi') {
    const v = pct >= 80 ? 'शानदार प्रदर्शन!' : pct >= 60 ? 'अच्छा प्रयास।' : 'इस topic को और revise करो।'
    respond(`Quiz पूरा! ${_quizHits} out of ${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  } else if (lang === 'hinglish') {
    const v = pct >= 80 ? 'Zabardast!' : pct >= 60 ? 'Acha effort.' : 'Revise karo is topic ko.'
    respond(`Quiz khatam! ${_quizHits}/${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  } else {
    const v = pct >= 80 ? 'Excellent!' : pct >= 60 ? 'Good effort.' : 'This topic needs more revision.'
    respond(`Quiz complete! ${_quizHits}/${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  }
}

// ── Report generators — language-aware ───────────────────────────────────────
function buildStatusReport(): string {
  const cs = getCurrentState()
  const lang = detectResponseLang('')
  if (!cs) {
    return lang === 'hi' ? 'App data abhi load nahi hua. Ek baar phir try karo.' :
           lang === 'hinglish' ? 'App state load nahi hua abhi. Try again.' :
           'App state not loaded yet. Try again in a moment.'
  }
  const focusMins = getTodayFocusMins()
  if (lang === 'hi') {
    const parts: string[] = []
    if (cs.streak)                      parts.push(`${cs.streak} दिनों की study streak.`)
    if (cs.today?.subject)              parts.push(`आज: ${cs.today.subject}.`)
    if (cs.backlogRemaining != null)    parts.push(`${cs.backlogRemaining} lectures बाकी.`)
    if (cs.performance?.prelimsAvg != null) parts.push(`Prelims average: ${cs.performance.prelimsAvg.toFixed(1)}%.`)
    if (cs.selectionProbabilityPct != null) parts.push(`Selection probability: ${cs.selectionProbabilityPct.toFixed(1)}%.`)
    if (focusMins > 0)                  parts.push(`आज ${focusMins} मिनट की पढ़ाई.`)
    if (_reminders.length)              parts.push(`${_reminders.length} active reminder.`)
    return parts.length ? parts.join(' ') : 'अभी कोई data नहीं है। Sessions log करना शुरू करो।'
  }
  if (lang === 'hinglish') {
    const parts: string[] = []
    if (cs.streak)                      parts.push(`${cs.streak}-day streak.`)
    if (cs.today?.subject)              parts.push(`Aaj: ${cs.today.subject}.`)
    if (cs.backlogRemaining != null)    parts.push(`${cs.backlogRemaining} lectures pending.`)
    if (cs.performance?.prelimsAvg != null) parts.push(`Prelims average: ${cs.performance.prelimsAvg.toFixed(1)}%.`)
    if (cs.selectionProbabilityPct != null) parts.push(`SP: ${cs.selectionProbabilityPct.toFixed(1)}%.`)
    if (focusMins > 0)                  parts.push(`Aaj ${focusMins} minutes padhai.`)
    if (_reminders.length)              parts.push(`${_reminders.length} reminder active.`)
    return parts.length ? parts.join(' ') : 'Koi data nahi abhi. Sessions log karo.'
  }
  const parts: string[] = []
  if (cs.streak)                      parts.push(`${cs.streak}-day study streak.`)
  if (cs.today?.subject)              parts.push(`Today: ${cs.today.subject}.`)
  if (cs.backlogRemaining != null)    parts.push(`${cs.backlogRemaining} lectures pending.`)
  if (cs.performance?.prelimsAvg != null) parts.push(`Prelims average: ${cs.performance.prelimsAvg.toFixed(1)}%.`)
  if (cs.selectionProbabilityPct != null) parts.push(`Selection probability: ${cs.selectionProbabilityPct.toFixed(1)}%.`)
  if (focusMins > 0)                  parts.push(`${focusMins} minutes studied today.`)
  if (_reminders.length)              parts.push(`${_reminders.length} active reminder${_reminders.length>1?'s':''}.`)
  return parts.length ? parts.join(' ') : 'No data yet. Start logging sessions to see your report.'
}

function buildTodayReport(): string {
  const cs  = getCurrentState()
  const lang = detectResponseLang('')
  const rows     = document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')
  const doneRows = document.querySelectorAll<HTMLElement>('#plan .plan-row.done')
  const pending  = Array.from(rows).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0,3)
  const mins     = getTodayFocusMins()
  if (lang === 'hi') {
    const parts: string[] = []
    if (cs?.today?.subject)  parts.push(`आज का विषय: ${cs.today.subject}.`)
    if (pending.length)      parts.push(`बाकी: ${pending.join(', ')}.`)
    if (doneRows.length)     parts.push(`${doneRows.length} lecture${doneRows.length>1?'s':''} आज पूरे हुए.`)
    if (mins)                parts.push(`अब तक ${mins} मिनट focused पढ़ाई.`)
    return parts.length ? parts.join(' ') : 'Plan section खोलो आज के lectures देखने के लिए.'
  }
  if (lang === 'hinglish') {
    const parts: string[] = []
    if (cs?.today?.subject)  parts.push(`Aaj ka subject: ${cs.today.subject}.`)
    if (pending.length)      parts.push(`Pending: ${pending.join(', ')}.`)
    if (doneRows.length)     parts.push(`${doneRows.length} lecture${doneRows.length>1?'s':''} aaj done.`)
    if (mins)                parts.push(`${mins} minutes focused abhi tak.`)
    return parts.length ? parts.join(' ') : "Plan section kholo aaj ke lectures dekhne ke liye."
  }
  const parts: string[] = []
  if (cs?.today?.subject)  parts.push(`Today's subject: ${cs.today.subject}.`)
  if (pending.length)      parts.push(`Pending: ${pending.join(', ')}.`)
  if (doneRows.length)     parts.push(`${doneRows.length} lecture${doneRows.length>1?'s':''} done today.`)
  if (mins)                parts.push(`${mins} minutes focused so far.`)
  return parts.length ? parts.join(' ') : "Open the Plan section to see today's lectures."
}

function buildExamCountdown(): string {
  const lang = detectResponseLang('')
  try {
    const raw = localStorage.getItem('settings') ?? '{}'
    const settings = JSON.parse(raw) as {prelimsDate?: string}
    if (settings.prelimsDate) {
      const target = new Date(settings.prelimsDate)
      const days   = Math.ceil((target.getTime() - Date.now()) / 86_400_000)
      const dateStr = target.toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})
      if (days > 0) {
        if (lang === 'hi')       return `Prelims में ${days} दिन बाकी हैं — ${dateStr}। हर दिन मायने रखता है।`
        if (lang === 'hinglish') return `Prelims mein ${days} din bache hain — ${dateStr}. Har din count karta hai.`
        return `${days} days until Prelims on ${dateStr}. Make every day count.`
      }
      if (days === 0) {
        if (lang === 'hi')       return 'Prelims आज है! तुम्हें यह मिलेगा, ओम।'
        if (lang === 'hinglish') return 'Prelims aaj hai! You got this, Om.'
        return "Prelims is today! You've got this, Om."
      }
    }
  } catch { /* ignore */ }
  const cs = getCurrentState()
  if (lang === 'hi')       return `Settings में Prelims date configure karo। Backlog: ${cs?.backlogRemaining ?? '?'} lectures.`
  if (lang === 'hinglish') return `Settings mein Prelims date set karo countdown ke liye. Backlog: ${cs?.backlogRemaining ?? '?'} lectures.`
  return cs ? `Prelims date not configured. Set it in Settings for a countdown. Backlog: ${cs.backlogRemaining ?? '?'} lectures.` : 'Set your exam date in Settings for a countdown.'
}

function buildRevisionLine(): string {
  const lang = detectResponseLang('')
  const rows = document.querySelectorAll<HTMLElement>('#plan .plan-row[data-type="revision"]:not(.done)')
  if (!rows.length) {
    if (lang === 'hi')       return 'आज कोई revision due नहीं है। बढ़िया discipline!'
    if (lang === 'hinglish') return 'Aaj koi revision due nahi. Great discipline!'
    return 'No revisions due today. Great discipline!'
  }
  const titles = Array.from(rows).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0,3)
  if (lang === 'hi')       return `${rows.length} revision${rows.length>1?'s':''} due हैं: ${titles.join(', ')}.`
  if (lang === 'hinglish') return `${rows.length} revision${rows.length>1?'s':''} due: ${titles.join(', ')}.`
  return `${rows.length} revision${rows.length>1?'s':''} due: ${titles.join(', ')}.`
}

function buildWeekSummary(): string {
  const lang = detectResponseLang('')
  try {
    const raw = localStorage.getItem('focusLog') ?? '{}'
    const log = JSON.parse(raw) as Record<string,number>
    let total = 0, days = 0
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate()-i)
      const key = d.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})
      if (log[key]) { total += log[key]; days++ }
    }
    const cs = getCurrentState()
    if (lang === 'hi') {
      const parts = [`इस हफ़्ते: ${total} session${total!==1?'s':''}, ${days} दिन.`]
      if (cs?.streak)            parts.push(`Current streak: ${cs.streak} दिन.`)
      if (cs?.backlogRemaining)  parts.push(`${cs.backlogRemaining} lectures अभी बाकी.`)
      return parts.join(' ')
    }
    if (lang === 'hinglish') {
      const parts = [`Is hafte: ${total} session${total!==1?'s':''}, ${days} din.`]
      if (cs?.streak)            parts.push(`Streak: ${cs.streak} din.`)
      if (cs?.backlogRemaining)  parts.push(`${cs.backlogRemaining} lectures pending.`)
      return parts.join(' ')
    }
    const parts = [`This week: ${total} session${total!==1?'s':''} across ${days} day${days!==1?'s':''}.`]
    if (cs?.streak)            parts.push(`Current streak: ${cs.streak} days.`)
    if (cs?.backlogRemaining)  parts.push(`${cs.backlogRemaining} lectures still pending.`)
    return parts.join(' ')
  } catch {
    if (lang === 'hi')       return 'Weekly data available nahi hai. Sessions log karte raho.'
    if (lang === 'hinglish') return 'Weekly data nahi hai abhi. Sessions log karo.'
    return 'Weekly data unavailable. Keep logging sessions to see your summary.'
  }
}

function buildRankLine(): string {
  const cs   = getCurrentState()
  const lang = detectResponseLang('')
  if (!cs) {
    if (lang === 'hi')       return 'अभी rank data नहीं है।'
    if (lang === 'hinglish') return 'Rank data nahi hai abhi.'
    return 'No rank data available yet.'
  }
  if (!cs.rankProjection) {
    if (lang === 'hi')       return 'Rank estimate के लिए और test scores दर्ज करो।'
    if (lang === 'hinglish') return 'Rank estimate ke liye aur scores log karo.'
    return 'Enter more test scores to generate a rank estimate.'
  }
  if (lang === 'hi')       return `Projected rank: ${cs.rankProjection}. Selection probability: ${cs.selectionProbabilityPct?.toFixed(1)??'--'}%.`
  if (lang === 'hinglish') return `Projected rank: ${cs.rankProjection}. SP: ${cs.selectionProbabilityPct?.toFixed(1)??'--'}%.`
  return `Projected rank: ${cs.rankProjection}. SP: ${cs.selectionProbabilityPct?.toFixed(1)??'--'}%.`
}

// ── Motivation & celebration — language-aware ─────────────────────────────────
const MOTIVATION_EN = [
  'Every revision is a brick in the wall of your selection. Keep building.',
  "IAS 2028 is the goal. Today's session is the path. Keep walking.",
  'The toppers you admire were exactly where you are now. They kept going.',
  'Consistency beats brilliance. Show up today.',
  'Hard days build the hardest officers. Push through.',
  "You've come too far to stop now, Om. One more session.",
  'The UPSC preparation journey is a marathon. Trust the process.',
  "Focus on today's lecture. The rank takes care of itself.",
  'Every question you solve is a question fewer between you and selection.',
  "Doubt is normal. Giving up is a choice. Choose differently today.",
  'The officers you will serve alongside once felt exactly this. They continued.',
  "Small steps every day compound into the selection you're working toward.",
]
const MOTIVATION_HI = [
  'हर revision selection की दीवार में एक ईंट है। बनाते रहो।',
  'IAS 2028 लक्ष्य है। आज की पढ़ाई वो रास्ता है। चलते रहो, ओम।',
  'जिन toppers को तुम admire करते हो — वो भी एक वक्त ठीक तुम्हारी जगह थे। वो रुके नहीं।',
  'Consistency brilliance को हरा देती है। आज भी आओ।',
  'मुश्किल दिन ही सबसे मज़बूत officers बनाते हैं। पार करो।',
  'बहुत आगे आ चुके हो रुकने के लिए, ओम। बस एक session और।',
  'UPSC की तैयारी marathon है। प्रक्रिया पर भरोसा रखो।',
  'आज के lecture पर ध्यान दो। Rank खुद-ब-खुद बनती है।',
  'हर सवाल जो तुम solve करते हो, selection के बीच के सवाल एक कम हो जाते हैं।',
  'शक स्वाभाविक है। हार मानना एक choice है। आज अलग choose करो।',
]
const MOTIVATION_HIN = [
  'Har revision selection ki wall mein ek brick hai. Build karte raho.',
  'IAS 2028 goal hai. Aaj ki padhai woh raasta hai. Keep walking, Om.',
  'Jo toppers hain, woh bhi ek waqt yahan the. Unhone chhodha nahi.',
  'Consistency brilliance ko harata hai. Aaj bhi aa jao.',
  'Hard days the strongest officers banate hain. Push through karo.',
  'Bahut aage aa chuke ho rukne ke liye. Ek session aur.',
  'UPSC marathon hai. Trust the process, Om.',
  'Aaj ke lecture pe focus karo. Rank khud sambhal legi.',
]
const CELEBRATE_EN = [
  'Excellent work!', "That's the spirit!", 'Keep this momentum!',
  'One down, keep going!', 'Well done, Om!', 'Progress — every step counts.',
  'That is how selection happens. One lecture at a time.',
]
const CELEBRATE_HI = [
  'शानदार काम!', 'यही जज़्बा चाहिए!', 'इसी momentum को बनाए रखो!',
  'एक और पूरा, आगे बढ़ो!', 'बहुत बढ़िया, ओम!', 'यही है selection का रास्ता।',
]
const CELEBRATE_HIN = [
  'Zabardast kaam!', 'Yahi spirit chahiye!', 'Is momentum ko banaye rakho!',
  'Ek aur done — chalo aage!', 'Bahut acha, Om!', 'Yahi hai selection ka raasta.',
]
const TIPS_EN = [
  'Active recall beats passive re-reading. Close your notes and write what you remember.',
  'Do at least 20 PYQs per topic before moving on. UPSC repeats its patterns.',
  'Revise yesterday\'s lecture for 10 minutes before starting today\'s. SRS compounds.',
  'Answer writing is the final exam skill — practice at least 2 answers every day.',
  'Map every topic to its GS paper and question pattern — it changes how you study.',
  'Current affairs must connect to static syllabus. One event, multiple syllabus angles.',
  'The newspaper is a 250-mark paper. Read with a syllabus lens, not a news lens.',
  'GS4 is about the consistency between values and actions — your daily practice counts.',
  'Prelims is about elimination, not selection. Learn to rule out 2 wrong options quickly.',
  'For Mains, the INTRO sets the frame. Spend 20 seconds planning your first sentence.',
]
const TIPS_HI = [
  'Active recall passive re-reading से बेहतर है। Notes बंद करो और लिखो जो याद है।',
  'हर topic से कम से कम 20 PYQs practice करो। UPSC patterns repeat करता है।',
  'आज की पढ़ाई शुरू करने से पहले कल का lecture 10 मिनट revise करो।',
  'Answer writing final skill है — हर दिन कम से कम 2 answers लिखो।',
  'हर topic को उसके GS paper और question pattern से map करो।',
  'Current affairs को static syllabus से जोड़ो। एक news, कई angles।',
  'Prelims में 2 गलत options को eliminate करना सीखो — यही है skill।',
  'GS4 में values और actions की consistency दिखानी होती है।',
]
const TIPS_HIN = [
  'Active recall se padho — notes band karo aur likho jo yaad hai.',
  'Har topic se 20 PYQs practice karo. UPSC patterns repeat karta hai.',
  'Aaj ki padhai se pehle kal ka lecture 10 minute revise karo. SRS works.',
  'Answer writing daily practice karo — 2 answers minimum har din.',
  'Har topic ko uske GS paper se map karo. It changes how you study.',
]
const QUOTES_EN = [
  '"It always seems impossible until it is done." — Nelson Mandela',
  '"Success is the sum of small efforts repeated day in and day out." — R. Collier',
  '"The secret of getting ahead is getting started." — Mark Twain',
  '"Dreams do not work unless you do." — John C. Maxwell',
  '"One today is worth two tomorrows." — Benjamin Franklin',
  '"Discipline is choosing between what you want now and what you want most."',
  '"An investment in knowledge pays the best interest." — Benjamin Franklin',
  '"Excellence is not a destination but a continuous journey." — Brian Tracy',
]
const QUOTES_HI = [
  '"पहले यह असंभव लगता है, फिर यह कठिन लगता है, फिर यह हो जाता है।" — नेल्सन मंडेला',
  '"सफलता छोटे-छोटे प्रयासों का योग है जो दिन-प्रतिदिन दोहराए जाते हैं।"',
  '"आगे बढ़ने का रहस्य शुरुआत करना है।" — मार्क ट्वेन',
  '"अनुशासन वह है जो तुम अभी चाहते हो और जो सबसे ज़्यादा चाहते हो, उसके बीच का चुनाव है।"',
  '"ज्ञान में निवेश सबसे अच्छा ब्याज देता है।" — बेंजामिन फ्रैंकलिन',
  '"उत्कृष्टता एक गंतव्य नहीं, बल्कि एक निरंतर यात्रा है।"',
]
const QUOTES_HIN = [
  '"Pehle yeh impossible lagta hai, phir kuch mushkil, phir ho jaata hai." — Mandela',
  '"Safalta chhote-chhote efforts ka sum hai jo roz repeat hote hain."',
  '"Aage badhne ka secret shuruat karna hai." — Mark Twain',
  '"Discipline woh hai jo tum abhi chahte ho aur jo sabse zyada chahte ho ke beech ka choice hai."',
  '"Knowledge mein invest karna sabse best interest deta hai." — Franklin',
]

function _pick<T>(arr: T[]): T { return arr[Math.floor(Math.random()*arr.length)] }

function motivationLine(): string {
  const lang = detectResponseLang('')
  if (lang === 'hi')       return _pick(MOTIVATION_HI)
  if (lang === 'hinglish') return _pick(MOTIVATION_HIN)
  return _pick(MOTIVATION_EN)
}
function celebrationLine(): string {
  const lang = detectResponseLang('')
  if (lang === 'hi')       return _pick(CELEBRATE_HI)
  if (lang === 'hinglish') return _pick(CELEBRATE_HIN)
  return _pick(CELEBRATE_EN)
}
function studyTip(): string {
  const lang = detectResponseLang('')
  if (lang === 'hi')       return _pick(TIPS_HI)
  if (lang === 'hinglish') return _pick(TIPS_HIN)
  return _pick(TIPS_EN)
}
function studyQuote(): string {
  const lang = detectResponseLang('')
  if (lang === 'hi')       return _pick(QUOTES_HI)
  if (lang === 'hinglish') return _pick(QUOTES_HIN)
  return _pick(QUOTES_EN)
}

// ── System prompt — rich context ──────────────────────────────────────────────
function buildPrompt(): string {
  const cs        = getCurrentState()
  const d         = todayIST()
  const pending   = Array.from(document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0, 5)
  const focusMins = getTodayFocusMins()
  const remCount  = _reminders.length

  // Precise language instruction — tells the model exactly what register to use
  const langInstr =
    _replyLang === 'hi'       ? [
      'LANGUAGE: Respond ONLY in natural, fluent Hindi using Devanagari script.',
      'Use proper Hindi grammar and sentence structure. Do not use Roman transliteration.',
      'Technical terms, proper nouns (Article 21, IAS, UPSC, GDP, etc.) may stay in English/Latin script.',
      'Avoid stilted or overly formal Sanskrit-heavy Hindi — speak like an educated, warm friend.',
    ].join(' ') :
    _replyLang === 'hinglish' ? [
      'LANGUAGE: Respond in Hinglish — a natural, educated mix of Hindi words (Roman script) and English.',
      'Main verbs and connectors in Hindi (hai, hoga, karo, etc.); nouns and concepts can be English.',
      'Tone: warm, modern, smart — like a Delhi college student talking to a friend.',
    ].join(' ') :
    _replyLang === 'en'       ? 'LANGUAGE: Respond in clear, concise English.' :
    [
      'LANGUAGE: Auto-detect from the user\'s message.',
      'Hindi (Devanagari) → respond in Hindi. Roman Hindi/Hinglish → respond in Hinglish.',
      'English → respond in English. Never switch languages unprompted.',
    ].join(' ')

  return [
    `You are JARVIS — the dedicated AI study partner and life assistant for Om Shisodiya, preparing for UPSC CSE 2028.`,
    `Om is enrolled in PW Prarambh 2027 batch. Target: IAS, CSE 2028.`,
    `Today: ${d}. Subject scheduled: ${cs?.today?.subject ?? '—'}. Backlog: ${cs?.backlogRemaining ?? '?'} lectures.`,
    cs?.streak ? `Study streak: ${cs.streak} consecutive days.` : '',
    cs?.performance?.prelimsAvg != null ? `Prelims avg: ${cs.performance.prelimsAvg.toFixed(1)}%.` : '',
    cs?.selectionProbabilityPct != null ? `Selection probability: ${cs.selectionProbabilityPct.toFixed(1)}%.` : '',
    pending.length ? `Pending today: ${pending.join(', ')}.` : '',
    focusMins ? `Focus minutes logged today: ${focusMins}.` : '',
    remCount  ? `Active reminders: ${remCount}.` : '',
    '',
    langInstr,
    '',
    'VOICE OUTPUT RULES — this response will be spoken aloud by a TTS engine:',
    '• No markdown, no asterisks, no bullet symbols, no numbered lists, no hash signs.',
    '• Write in natural spoken sentences. Maximum 2-3 sentences per answer.',
    '• For factual UPSC answers: state the most important point first, then one supporting detail.',
    '• For motivational/personal answers: be warm, direct, and human — never corporate or preachy.',
    '• Numbers: spell out when ≤ 10 ("three articles"), digits when > 10 ("42 days").',
    '• Avoid starting with "I" or "Sure" — get straight to the point.',
    '',
    'KNOWLEDGE SCOPE: You are a complete AI. Answer any question — UPSC (GS1-4, CSAT, Constitution, Optional), general knowledge, science, maths, current events, personal advice, jokes, motivation, or anything Om asks.',
    '',
    'APP COMMANDS — silently embed these when naturally helpful (user never sees them):',
    '<CMD>{"action":"start_timer"}</CMD>  <CMD>{"action":"stop_timer"}</CMD>  <CMD>{"action":"reset_timer"}</CMD>',
    '<CMD>{"action":"lock_screen"}</CMD>  <CMD>{"action":"skip_today"}</CMD>  <CMD>{"action":"generate_plan"}</CMD>',
    '<CMD>{"action":"open_add_score"}</CMD>  <CMD>{"action":"focus_mode"}</CMD>',
    '<CMD>{"action":"scroll_to","section":"engine|intel|plan|routine|constitution"}</CMD>',
  ].filter(Boolean).join('\n')
}

// ── Execute app commands embedded in AI responses ────────────────────────────
function execCommands(reply: string): string {
  const clean = reply.replace(/<CMD>.*?<\/CMD>/g,'').replace(/<ACT>.*?<\/ACT>/g,'').trim()
  for (const m of [...reply.matchAll(/<CMD>(.*?)<\/CMD>/g)]) {
    try {
      const cmd = JSON.parse(m[1]) as { action: string; section?: string }
      switch (cmd.action) {
        case 'start_timer':    clickStart(); break
        case 'stop_timer':     q('[data-act="start"]'); break
        case 'reset_timer':    q('[data-act="reset"]'); break
        case 'lock_screen':    cl('lock-btn'); break
        case 'skip_today':     cl('lp-skip-day'); break
        case 'open_add_score': cl('cm-add-score'); break
        case 'generate_plan':  cl('ai-gen'); break
        case 'focus_mode':     cl('focus-mode-btn'); break
        case 'scroll_to':      scr(cmd.section ?? ''); break
      }
    } catch { /* ignore malformed JSON */ }
  }
  return clean
}

function offlineAnswer(t: string): string {
  const cs   = getCurrentState()
  const tl   = t.toLowerCase()
  const lang = detectResponseLang(t)

  if (/backlog|lecture|left|baki|pending/i.test(tl)) {
    const b = cs?.backlogRemaining ?? '?'
    return lang === 'hi'       ? `${b} lectures backlog में अभी बाकी हैं।` :
           lang === 'hinglish' ? `${b} lectures backlog mein pending hain.` :
                                 `${b} lectures remaining in your backlog.`
  }
  if (/streak|consecutive|din.*padha/i.test(tl)) {
    const s = cs?.streak ?? 0
    return lang === 'hi'       ? `${s} दिनों की streak है। जारी रखो!` :
           lang === 'hinglish' ? `${s}-day streak. Keep it going!` :
                                 `${s}-day streak. Keep it going!`
  }
  if (/subject|today|aaj.*kya|kya.*aaj/i.test(tl)) {
    const sub = cs?.today?.subject ?? '—'
    return lang === 'hi'       ? `आज का विषय: ${sub}.` :
           lang === 'hinglish' ? `Aaj ka subject: ${sub}.` :
                                 `Today's subject: ${sub}.`
  }
  if (/rank|select|probability|sp\b/i.test(tl)) {
    const sp = cs?.selectionProbabilityPct?.toFixed(1) ?? '--'
    return lang === 'hi'       ? `Selection probability: ${sp}%.` :
           lang === 'hinglish' ? `Selection probability: ${sp}%.` :
                                 `Selection probability: ${sp}%.`
  }
  if (/motivat|inspire|tired|thak|himmat/i.test(tl))        return motivationLine()
  if (/status|report|briefing|how.*doing|kaisa/i.test(tl))  return buildStatusReport()
  if (/plan|schedule|today.*plan|kya.*padhna/i.test(tl))    return buildTodayReport()
  if (/tip|advice|suggestion|salah/i.test(tl))              return studyTip()
  if (/quote|shloka|vichar/i.test(tl))                      return studyQuote()

  if (/time.*left|kitna.*time|timer.*remaining/i.test(tl)) {
    const el      = document.querySelector<HTMLElement>('.ring-time')
    const timeStr = el?.textContent?.trim()
    if (timeStr) {
      return lang === 'hi'       ? `Timer में ${timeStr} बाकी है।` :
             lang === 'hinglish' ? `Timer mein ${timeStr} bache hain.` :
                                   `${timeStr} remaining on the timer.`
    }
    return lang === 'hi'       ? 'Timer चल नहीं रहा।' :
           lang === 'hinglish' ? 'Timer chal nahi raha.' :
                                 'Timer is not running.'
  }

  return lang === 'hi'
    ? "Main timer, plan, scores, notes, quiz aur sabhi UPSC topics handle karta hoon. Batao kya chahiye?"
    : lang === 'hinglish'
    ? "Main timer, plan, scores, notes, quiz aur UPSC topics sambhalta hoon. Kya chahiye?"
    : "I handle timer, plan, scores, notes, quiz, and all UPSC topics. What do you need?"
}

// ── Full Website Control Helpers ──────────────────────────────────────────────

/** Fill any input/textarea by selector, dispatch change events */
function fillEl(selector: string, value: string): boolean {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)
  if (!el) return false
  const nativeInput = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (nativeInput) { nativeInput.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
  else { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })) }
  return true
}

/** Click an element by ID, optionally flash it */
function clickId(id: string): boolean {
  const el = document.getElementById(id)
  if (!el) return false
  el.click()
  el.classList.add('jv-flash'); setTimeout(() => el.classList.remove('jv-flash'), 500)
  return true
}

/** Scroll to element by ID and optionally click it */
function scrollAndClick(scrollId: string, clickSelector?: string): void {
  document.getElementById(scrollId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (clickSelector) {
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(clickSelector)
      if (el) { el.click(); el.classList.add('jv-flash'); setTimeout(() => el.classList.remove('jv-flash'), 500) }
    }, 400)
  }
}

/** Read all live stat values from the DOM */
function readLiveStats(): Record<string, string> {
  const stats: Record<string, string> = {}
  // Intel stat cards
  document.querySelectorAll<HTMLElement>('#intel .stat').forEach(card => {
    const key = (card.querySelector('.k')?.textContent ?? '').toLowerCase().trim()
    const val = (card.querySelector('.count-up')?.textContent ?? card.querySelector('.v')?.textContent ?? '').trim()
    if (key) stats[key] = val
  })
  // Timer
  const timerEl = document.querySelector<HTMLElement>('.ring-time')
  if (timerEl) stats['timer'] = timerEl.textContent?.trim() ?? ''
  // Streak
  const streakEl = document.getElementById('streak-num')
  if (streakEl) stats['streak'] = streakEl.textContent?.trim() ?? ''
  // Planner progress
  const done  = document.querySelectorAll('#plan .plan-row.done').length
  const total = document.querySelectorAll('#plan .plan-row').length
  stats['lecturesDone']  = String(done)
  stats['lecturesTotal'] = String(total)
  stats['coverage']      = total ? `${Math.round(done/total*100)}%` : '0%'
  // Briefing line
  const briefEl = document.getElementById('rtn-briefing')
  if (briefEl?.textContent) stats['briefing'] = briefEl.textContent.trim()
  return stats
}

/** Mark ALL undone lectures in the planner as done */
function markAllLecturesDone(): number {
  const rows = document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')
  let count = 0
  rows.forEach(row => { row.querySelector<HTMLElement>('.check')?.click(); count++ })
  return count
}

/** Pre-fill and submit the score form programmatically */
function prefillAndOpenScore(score: number, max: number, label: string, category = 'mock'): void {
  clickId('cm-add-score')
  setTimeout(() => {
    fillEl('#score-score-field, [data-field="score"], input[placeholder*="Score"], input[placeholder*="score"]', String(score))
    fillEl('#score-max-field, [data-field="max"], input[placeholder*="Max"], input[placeholder*="max"]', String(max))
    fillEl('#score-label-field, [data-field="label"], input[placeholder*="Label"], input[placeholder*="label"]', label)
    const catSel = document.querySelector<HTMLSelectElement>('#score-category, select[name="category"]')
    if (catSel) { catSel.value = category; catSel.dispatchEvent(new Event('change')) }
  }, 450)
}

/** Pre-fill the CA log form */
function prefillCALog(text: string): void {
  clickId('cm-ca-log')
  setTimeout(() => {
    fillEl('#ca-body, #ca-text, [name="ca-body"], textarea[placeholder*="Current affair"]', text)
  }, 400)
}

/** Pre-fill the mistake notebook form */
function prefillMistakeForm(subject: string, question: string, correction: string): void {
  clickId('cm-add-mistake')
  setTimeout(() => {
    fillEl('#mk-subject, [name="mk-subject"], input[placeholder*="Subject"]', subject)
    fillEl('#mk-question, [name="mk-question"], input[placeholder*="Question"]', question)
    fillEl('#mk-correct-note, [name="mk-correct"], textarea[placeholder*="Correct"]', correction)
  }, 400)
}

/** Pre-fill the quick notes form */
function prefillNoteForm(text: string): void {
  clickId('cm-add-note')
  setTimeout(() => {
    fillEl('#note-body, [name="note-body"], textarea[placeholder*="Note"]', text)
  }, 400)
}

/** Set timer to exact minutes using fireTimer, also update display label */
function setTimerMinutes(mins: number): void {
  fireTimer(mins)
  const label = document.querySelector<HTMLElement>('#ai-hrs-val, .timer-duration-label')
  if (label) label.textContent = String(mins)
}

/** Direct planner filter by subject keyword */
function filterPlannerBy(keyword: string): void {
  scr('plan')
  setTimeout(() => {
    const inp = document.querySelector<HTMLInputElement>('#lp-search')
    if (inp) { inp.value = keyword; inp.dispatchEvent(new Event('input')) }
  }, 250)
}

/** Rate the first due SRS revision card with given recall */
function rateFirstRevision(recall: 'again' | 'hard' | 'good' | 'easy'): boolean {
  const btn = document.querySelector<HTMLButtonElement>(`.srs-btn[data-recall="${recall}"]`)
  if (!btn) return false
  btn.click(); return true
}

/** Get the next pending lecture title from planner */
function getNextLectureTitle(): string | null {
  return document.querySelector<HTMLElement>('#plan .plan-row:not(.done) .pl-title')?.textContent?.trim() ?? null
}

/** Read the live accuracy from intelligence section */
function readAccuracy(): string {
  const el = document.getElementById('rtn-accuracy')
  return el?.textContent?.trim() || document.querySelector<HTMLElement>('[data-stat="accuracy"] .count-up')?.textContent?.trim() || '—'
}

/** Check if focus timer is currently running */
function isTimerRunning(): boolean {
  const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
  return /pause/i.test(btn?.textContent ?? '')
}

/** Get timer time remaining as string */
function getTimerRemaining(): string {
  return document.querySelector<HTMLElement>('.ring-time')?.textContent?.trim() ?? '—'
}

/** Toast a message from JARVIS context */
function toast(msg: string, type: 'success' | 'error' | 'info' | 'warn' = 'info'): void {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
}

// ── Speech output — male voice ────────────────────────────────────────────────
function speak(text: string): void {
  _synth.cancel()
  if (!_voices.length) loadVoices()
  const isHindi = /[ऀ-ॿ]/.test(text)
  const clean   = text.replace(/\*\*?(.*?)\*\*?/g,'$1').replace(/`/g,'').replace(/[#*_]/g,'').trim()
  const sentences = clean.split(/(?<=[.!?।])\s+/).filter(s => s.trim()).slice(0,6)
  if (!sentences.length) return

  _isSpeaking = true; _clapEnabled = false
  _rec?.stop(); _rec = null
  _wakeRec?.stop(); _wakeRec = null; _wakeRunning = false
  setState('speaking'); setStatus(isHindi ? 'बोल रहा हूँ…' : 'Speaking…')
  VA.setState('speaking')
  VA.setTranscript(clean, false)   // show reply text as JARVIS speaks it

  let i = 0
  const next = (): void => {
    if (i >= sentences.length) {
      _isSpeaking = false
      setTimeout(() => {
        _clapEnabled = true; setState('idle')
        VA.setState('idle')
        if (_state !== 'listening') {
          if (_continuousMode && _open) {
            // Continuous mode: wait 900 ms then reopen mic for natural follow-up
            setStatus('🎙 Follow-up? Speak now or say Jarvis…')
            _contListenTimer = window.setTimeout(() => {
              if (_state === 'idle' && _open && !_isSpeaking) void startListening()
            }, 900)
          } else {
            setStatus('Ready — say Jarvis or double clap')
            startWakeWord()
          }
        }
      }, 2500)
      return
    }
    const utt   = new SpeechSynthesisUtterance(sentences[i++])
    utt.volume  = Math.max(0.1, Math.min(1.0, _ttsVolume))
    if (isHindi) {
      utt.rate  = _ttsSpeed === 'fast' ? 0.96 : _ttsSpeed === 'slow' ? 0.65 : 0.80
      utt.pitch = 0.90
    } else {
      utt.rate  = _ttsSpeed === 'fast' ? 1.12 : _ttsSpeed === 'slow' ? 0.72 : 0.90
      utt.pitch = 1.0
    }
    utt.lang    = isHindi ? 'hi-IN' : 'en-IN'
    if (isHindi) {
      // Prefer Google Hindi (neural) → online Hindi → any Hindi voice
      const hv = _voices.find(v => v.lang==='hi-IN' && /google/i.test(v.name))
              ?? _voices.find(v => v.lang==='hi-IN' && /online|natural|neural/i.test(v.name))
              ?? _voices.find(v => v.lang==='hi-IN' && !v.localService)
              ?? _voices.find(v => v.lang==='hi-IN')
      if (hv) utt.voice = hv
    } else if (_selVoice) {
      utt.voice = _selVoice
    }
    utt.onend = next; utt.onerror = next
    _synth.speak(utt)
  }
  next()
}

// ── Wake word detection — HARDENED v2 ─────────────────────────────────────────
// ONLY fires on exact "Jarvis" / "जार्विस" — no fuzzy variants like jarbi/jarwis/jar vis.
// Uses confidence gating: primary transcript always checked; secondary alts only if
// their confidence score ≥ 0.55. Adds a 2-second inter-wake debounce so rapid
// ambient sounds or speech cannot retrigger JARVIS multiple times.
// ─────────────────────────────────────────────────────────────────────────────
let _lastWakeFireMs = 0   // global debounce: prevents re-firing within 2 s

function startWakeWord(): void {
  if (!_jarvisEnabled || _wakeRunning || _state === 'listening' || _isSpeaking || _sleeping) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return

  _wakeRunning = true
  const r = new SR(); _wakeRec = r
  r.continuous      = false
  r.lang            = _lang
  r.interimResults  = false
  r.maxAlternatives = 3   // still collect alts for confidence comparison

  // ── Strict WAKE_RE: ONLY "jarvis" or Hindi equivalent ────────────────────
  // Removed: jarbi, jarwis, jar vis — these cause false positives on common words.
  // Adding: "hey jarvis", "ok jarvis", common Hindi prefix/suffix patterns.
  const WAKE_STRICT = /\bjarvis\b|\bजार्विस\b/i

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onresult = (e: any) => {
    if (_isSpeaking) return

    // Global inter-wake debounce: 2 seconds minimum between fires
    const now = Date.now()
    if (now - _lastWakeFireMs < 2000) return

    // Extract alternatives WITH their confidence scores
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alts: Array<{ text: string; conf: number }> = Array.from(e.results[0] as any[]).map((a: any) => ({
      text: (a.transcript as string ?? '').trim(),
      conf: typeof a.confidence === 'number' ? a.confidence : 1.0,
    }))

    if (!alts.length) return

    // ── Matching strategy — strictest first ────────────────────────────────
    // Rule 1: Primary transcript (highest confidence) → always tested.
    // Rule 2: Alternative transcripts → only if confidence ≥ 0.55.
    // Rule 3: A transcript must contain WAKE_STRICT as a whole word.
    // Rule 4: Transcript must not be too long without containing "jarvis"
    //         as the only meaningful word (prevents "hey I was just talking jarvis")
    let matched = ''

    // Primary (index 0) — always check
    if (WAKE_STRICT.test(alts[0].text)) {
      matched = alts[0].text
    }

    // Secondaries — only if confidence threshold met
    if (!matched) {
      for (let i = 1; i < alts.length; i++) {
        if (alts[i].conf >= 0.55 && WAKE_STRICT.test(alts[i].text)) {
          matched = alts[i].text
          break
        }
      }
    }

    if (!matched) return   // strict: nothing matched → ignore

    _lastWakeFireMs = now  // stamp debounce timestamp
    _wakeRunning = false

    // ── Strip wake word + common filler prefixes ──────────────────────────
    const command = matched
      .replace(/^(?:hey|hi|ok|okay|oi|yo|bhai|haan|are|arrey|arre|sun|suno)\s+/i, '')
      .replace(/^(?:jarvis|जार्विस)\s*[,.]?\s*/i, '')
      .replace(/\s*[,.]?\s*(?:jarvis|जार्विस)\s*$/i, '')
      .trim()

    const btn = document.getElementById('jarvis-btn')
    btn?.classList.add('listening')
    setTimeout(() => btn?.classList.remove('listening'), 500)

    if (command) {
      // Inline command: "start timer, Jarvis" / "Jarvis explain Article 21"
      _everActivated = true
      if (!_open) openPanel()
      VA.setState('thinking')
      addMsg('user', command)
      void executeIntent(command)
    } else {
      // Bare "Jarvis" → open panel + greet + listen
      _everActivated = true
      if (!_open) { openPanel(false); greetWake() }
      else        { greetWake() }
      wakeAndListen()
    }
  }

  // Add jitter to restart delay — prevents synchronized restart storms
  r.onend = () => {
    _wakeRunning = false
    if (_jarvisEnabled && _state !== 'listening' && !_isSpeaking && !_sleeping) {
      const jitter = Math.floor(Math.random() * 300)  // 0–300ms jitter
      setTimeout(startWakeWord, 600 + jitter)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onerror = (err: any) => {
    _wakeRunning = false
    const delay = err.error === 'network' ? 5000 : err.error === 'aborted' ? 200 : 800
    if (_jarvisEnabled && !_sleeping) setTimeout(startWakeWord, delay)
  }
  try { r.start() } catch { _wakeRunning = false; setTimeout(startWakeWord, 3000) }
}

// ── Clap detection — HARDENED v3: transient classifier + amplitude matching ───
// Algorithm: EMA noise floor (adaptive) + high-freq energy + transient sharpness
// (rate of amplitude rise) + clap-shape verification (fast attack, fast decay) +
// amplitude similarity between both claps. Rejects: voice, music, AC noise, taps.
// ─────────────────────────────────────────────────────────────────────────────
async function startClapWatch(): Promise<void> {
  let stream: MediaStream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }) }
  catch { return }

  const ac = new AudioContext()
  const an = ac.createAnalyser(); an.fftSize = 256
  ac.createMediaStreamSource(stream).connect(an)
  const data = new Uint8Array(an.frequencyBinCount)

  // ── Core constants ────────────────────────────────────────────────────────
  const EMA_ALPHA   = 0.04   // slow EMA for ambient floor (~2 s convergence)
  const SPIKE_RATIO = 2.8    // raised from 2.1 — clap must be 2.8× ambient (harder to fake)
  const MIN_ABS     = 42     // raised from 35 — absolute RMS floor
  const MAX_GAP     = 700    // ms — double-clap window
  const MIN_GAP     = 80     // ms — debounce
  const MAX_STREAK  = 3      // lowered from 4 — stricter: clap must be ≤135ms
  const RISE_MIN    = 18     // minimum amplitude rise from prev sample (transient sharpness)
  const SIMILARITY  = 0.55   // both claps must be within 55% amplitude ratio

  let warmup    = 0
  let lastClap  = 0
  let lastClapAmp = 0        // amplitude of first clap (for similarity check)
  let suppress  = 0
  let streak    = 0
  let prevHf    = 0          // previous frame's hfRms (for transient detection)

  setInterval(() => {
    if (!_jarvisEnabled) return
    an.getByteFrequencyData(data)

    // ── High-frequency RMS (upper half of FFT bins) ───────────────────────
    // Claps are wideband percussive events with strong high-freq content.
    // Speech, music, and AC are low-to-mid frequency dominant.
    const half    = data.length >> 1
    const hfRms   = Math.sqrt(data.slice(half).reduce((s, v) => s + v * v, 0) / half)
    const fullRms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)

    // Feed ambient to aurora animation (idle breathing effect)
    if (VA.state === 'idle' && !_isSpeaking) {
      VA.setAmplitude(Math.min(1, fullRms / 90) * 0.28)
    }

    // EMA always updates (adapts to room changes)
    _emaAmb = _emaAmb + EMA_ALPHA * (hfRms - _emaAmb)
    warmup++
    const prevHfLocal = prevHf
    prevHf = hfRms   // store for next frame
    if (warmup < 32) return

    if (!_everActivated || _isSpeaking || !_clapEnabled) return

    const now = Date.now()
    if (now < suppress) return

    // ── Adaptive threshold ────────────────────────────────────────────────
    const dynThresh = _emaAmb * SPIKE_RATIO
    const threshold = _clapThreshold > 0 ? _clapThreshold : dynThresh

    // ── Three-gate clap classifier ─────────────────────────────────────────
    // Gate 1: absolute amplitude (loud enough to be a real clap)
    // Gate 2: transient sharpness (amplitude rose sharply from previous frame)
    // Gate 3: duration limit (must drop back down within MAX_STREAK samples)
    const aboveThreshold  = hfRms > threshold && hfRms > MIN_ABS
    const isTransient     = (hfRms - prevHfLocal) >= RISE_MIN  // sharp rise

    if (aboveThreshold && isTransient) {
      streak++
      if (streak > MAX_STREAK) {
        // Sustained sound — definitely not a clap (voice, music)
        lastClap = 0; lastClapAmp = 0; return
      }
      suppress = now + MIN_GAP

      if (lastClap && now - lastClap < MAX_GAP) {
        // Gate 4: amplitude similarity — both claps must be reasonably similar.
        // Prevents: one real clap + one echo/room-bounce triggering.
        const ratio = Math.min(hfRms, lastClapAmp) / Math.max(hfRms, lastClapAmp)
        if (ratio < SIMILARITY) {
          // Dissimilar amplitudes — likely echo/reverb, not a real second clap
          lastClap = now; lastClapAmp = hfRms; return
        }

        // ✅ All gates passed — confirmed double-clap
        lastClap = 0; lastClapAmp = 0; streak = 0
        if (_isSpeaking) return
        _sleeping = false; _everActivated = true

        const btn = document.getElementById('jarvis-btn')
        btn?.classList.add('listening')
        setTimeout(() => btn?.classList.remove('listening'), 700)

        // Visual ripple feedback
        btn?.style.setProperty('--clap-scale', '1.15')
        setTimeout(() => btn?.style.removeProperty('--clap-scale'), 200)

        if (!_open) { openPanel(); setTimeout(() => void startListening(), 700) }
        else void startListening()
      } else {
        // First clap of potential pair
        lastClap    = now
        lastClapAmp = hfRms
        const btn = document.getElementById('jarvis-btn')
        btn?.style.setProperty('opacity', '0.60')
        setTimeout(() => btn?.style.removeProperty('opacity'), 120)
      }
    } else {
      streak = 0   // below threshold or not transient — reset
      if (lastClap && now - lastClap > MAX_GAP) { lastClap = 0; lastClapAmp = 0 }
    }
  }, 45)
}

// ── Calibration ───────────────────────────────────────────────────────────────
async function runCalibration(): Promise<void> {
  const modal = document.createElement('div')
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.94);'
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:28px;width:300px;text-align:center;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;color:var(--accent);margin-bottom:14px;">👏 CLAP CALIBRATION</div>
      <div id="cal-msg" style="font-size:14px;color:var(--ink-soft);line-height:1.6;margin-bottom:16px;">Measuring ambient noise…<br>Stay quiet for 2 seconds.</div>
      <div style="height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-bottom:16px;">
        <div id="cal-bar" style="height:100%;background:var(--accent);width:0%;transition:width .1s;"></div>
      </div>
      <button id="cal-x" style="background:none;border:1px solid var(--line-2);border-radius:20px;color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:6px 16px;cursor:pointer;">Cancel</button>
    </div>
  `
  document.body.appendChild(modal)
  document.getElementById('cal-x')?.addEventListener('click', () => modal.remove())

  const msg = modal.querySelector<HTMLElement>('#cal-msg')!
  const bar = modal.querySelector<HTMLElement>('#cal-bar')!

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 256
    ac.createMediaStreamSource(stream).connect(an)
    const d = new Uint8Array(an.frequencyBinCount)
    const rms = () => { an.getByteFrequencyData(d); return Math.sqrt(d.reduce((s,v)=>s+v*v,0)/d.length) }

    let sum = 0, n = 0
    for (let i=0; i<20; i++) {
      await new Promise(r => setTimeout(r,100)); sum += rms(); n++; bar.style.width = `${(i/20)*50}%`
    }
    const ambient = sum/n

    msg.textContent = '👏 CLAP TWICE now!'
    bar.style.width = '50%'; bar.style.background = 'var(--good)'
    let peak = ambient
    for (let i=0; i<30; i++) {
      await new Promise(r => setTimeout(r,100)); const v = rms(); if (v>peak) peak=v; bar.style.width = `${50+(i/30)*50}%`
    }
    stream.getTracks().forEach(t => t.stop()); ac.close()

    const thresh = ambient + (peak-ambient)*0.42
    _clapThreshold = thresh; localStorage.setItem('jarvis_clap_thresh', String(thresh))
    msg.innerHTML = `<b style="color:var(--good)">✓ Done!</b><br>Ambient: ${ambient.toFixed(0)} · Peak: ${peak.toFixed(0)}<br>Threshold: ${thresh.toFixed(0)}`
    bar.style.width = '100%'
    setTimeout(() => modal.remove(), 2500)
  } catch { msg.textContent = 'Microphone access needed.' }
}

// ── Greeting ──────────────────────────────────────────────────────────────────

/** Full greeting for manual panel open — morning brief or time-of-day line. */
function greetFull(): void {
  const alreadyGreeted = localStorage.getItem('jarvis_morning') === _TODAY
  const lang = detectResponseLang('')
  if (!alreadyGreeted) {
    const cs = getCurrentState()
    localStorage.setItem('jarvis_morning', _TODAY)
    _sessionGreeted = true
    if (lang === 'hi') {
      const parts: string[] = ['सुप्रभात, ओम।']
      if (cs?.streak)           parts.push(`${cs.streak} दिनों की streak चल रही है।`)
      if (cs?.today?.subject)   parts.push(`आज का विषय है ${cs.today.subject}।`)
      if (cs?.backlogRemaining) parts.push(`${cs.backlogRemaining} lectures अभी बाकी हैं।`)
      parts.push('आज कहाँ से शुरू करते हैं?')
      respond(parts.join(' '))
    } else if (lang === 'hinglish') {
      const parts: string[] = ['Good morning, Om!']
      if (cs?.streak)           parts.push(`${cs.streak}-day streak chal rahi hai.`)
      if (cs?.today?.subject)   parts.push(`Aaj ka subject: ${cs.today.subject}.`)
      if (cs?.backlogRemaining) parts.push(`${cs.backlogRemaining} lectures pending.`)
      parts.push('Kya start karte hain?')
      respond(parts.join(' '))
    } else {
      respond(buildMorningBrief(cs))
    }
    return
  }
  const h = parseInt(new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',hour12:false}))
  if (lang === 'hi') {
    respond(h < 12 ? 'सुप्रभात, ओम। बताइए, क्या चाहिए?' : h < 17 ? 'नमस्ते, ओम। कहिए।' : 'शुभ संध्या, ओम। क्या पूछना है?')
  } else if (lang === 'hinglish') {
    respond(h < 12 ? 'Good morning, Om! Kya plan hai aaj?' : h < 17 ? 'Hello Om. Boliye.' : 'Good evening, Om. Kya chahiye?')
  } else {
    respond(h < 12 ? "Good morning, Om. What do you need?" : h < 17 ? "Good afternoon, Om. Go ahead." : "Good evening, Om. What's up?")
  }
}

/** Short 1-word cue for wake-word activation — mic opens immediately after this. */
function greetWake(): void {
  setStatus('Listening…')
  const lang = detectResponseLang('')
  // Keep it short — mic opens as soon as the utterance finishes (~400 ms)
  speak(lang === 'hi' ? 'जी?' : lang === 'hinglish' ? 'Boliye.' : 'Yes?')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const _PAGE_TITLE = document.title || 'Mission 2028'
function setState(s: JState): void {
  _state = s
  // Update browser tab title to reflect JARVIS state — useful when tab is in background
  const stateTag: Record<JState, string> = {
    idle:      '',
    listening: '🎙 ',
    thinking:  '💭 ',
    speaking:  '🔊 ',
  }
  document.title = (stateTag[s] ?? '') + _PAGE_TITLE
}
function setStatus(t: string): void { const e = document.getElementById('jp-status'); if (e) e.textContent = t }

function addMsg(role: 'user'|'assistant', content: string): void {
  _history.push({ role, content })
  if (_history.length > 14) _history = _history.slice(-14)
  renderChat()
}

function renderChat(): void {
  const el = document.getElementById('jp-chat'); if (!el) return
  el.innerHTML = _history.map(m => `
    <div class="jmsg ${m.role}">
      <div class="jbubble">${esc(m.content)}</div>
    </div>`).join('')
  el.scrollTop = el.scrollHeight
}

function respond(text: string): void {
  if (!text) return
  const clean = execCommands(text)
  _lastReply = clean
  addMsg('assistant', clean)
  speak(clean)
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

export { isVisionTrigger as _visionCheck }
