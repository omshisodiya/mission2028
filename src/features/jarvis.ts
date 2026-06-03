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
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_KEY   = import.meta.env.VITE_GROQ_API_KEY as string | undefined

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

  // Pomodoro completion hook
  window.addEventListener('jarvis:session-done', ((e: CustomEvent<{mins:number}>) => {
    _pomodorosDone++
    const totalToday = getTodayFocusMins()
    let msg = ''
    if (_pomodorosDone % 4 === 0)
      msg = `Four sessions complete! ${totalToday} minutes of deep work today. Take a proper long break now, Om.`
    else if (totalToday >= 120 && totalToday % 60 < (e.detail.mins ?? 25))
      msg = `${Math.floor(totalToday/60)} hours of study today. Excellent consistency, Om.`
    if (msg) { if (_open) respond(msg); else showNudge(msg) }
  }) as EventListener)
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
        if (_open) respond(`Reminder: ${r.msg}`)
        else showNudge(`Reminder: ${r.msg}`)
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
      showNudge(`Streak alert: ${cs.streak}-day streak at risk. One 25-minute session will protect it.`)
      return
    }

    // Backlog warning — once in a while during day
    if (cs && (cs.backlogRemaining ?? 0) > 20 && h >= 9 && h < 22 && Math.random() < 0.25) {
      _lastNudgeMs = now
      showNudge(`${cs.backlogRemaining} lectures still pending. Say "generate plan" for an optimized schedule.`)
    }
  }, 3 * 60_000)
}

function buildMorningBrief(cs: ReturnType<typeof getCurrentState>): string {
  if (!cs) return 'Good morning, Om. Ready to build something great today?'
  const parts: string[] = ['Good morning, Om.']
  if (cs.streak) parts.push(`${cs.streak}-day streak — protect it today.`)
  if (cs.today?.subject) parts.push(`Subject for today: ${cs.today.subject}.`)
  if (cs.backlogRemaining) parts.push(`${cs.backlogRemaining} lectures in backlog.`)
  parts.push('What are we starting with?')
  return parts.join(' ')
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
    setStatus(
      code === 'not-allowed' ? 'Mic blocked — allow microphone in browser settings.' :
      code === 'network'     ? 'Network error. Check connection.' :
      code === 'no-speech'   ? 'Nothing heard. Tap 🎙 to try again.' :
                               'Tap 🎙 to retry.'
    )
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
  _rec?.stop();     _rec = null
  // Also stop wake word — prevents mic contention on restart
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

  // 18. CMDS — fast pattern-action table (200+ patterns)
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
  setStatus('Thinking…')
  VA.setState('thinking')

  const safetyTimer = setTimeout(() => {
    if (_state === 'thinking') {
      setState('idle'); VA.setState('idle')
      setStatus('Ready — say Jarvis or double clap')
      respond(offlineAnswer(transcript))
    }
  }, 8000)

  try {
    // ── Tier 1 + 2: route() tries local first, falls to Groq classification ──
    const result: RouterResult & { answer?: string } = await route(transcript)
    clearTimeout(safetyTimer)

    // Determine the language JARVIS should respond in
    const detectedLang = detectResponseLang(transcript)

    if (result.intent === 'qa.answer') {
      // ── Tier 3: UPSC knowledge question → Groq llama-3.3-70b tutor mode ────
      const cacheKey = `${detectedLang}:${transcript.toLowerCase().trim().slice(0, 120)}`
      const cached   = getCached(cacheKey)
      if (cached) { respond(cached); return }

      setStatus(detectedLang === 'hi' ? 'जवाब ढूंढ रहा हूं…' : 'Searching knowledge base…')
      const qaResult = await llmRoute(buildQATranscript(transcript, detectedLang), 'qa')
      const answer   = qaResult.answer?.trim()
      if (answer) { setCached(cacheKey, answer); respond(answer) }
      else respond(offlineAnswer(transcript))
      return
    }

    // ── Dispatch classified intent to app action ─────────────────────────────
    const reply = await dispatchIntent(result)
    respond(reply || offlineAnswer(transcript))

  } catch {
    clearTimeout(safetyTimer)
    setState('idle'); VA.setState('idle')
    respond(offlineAnswer(transcript))
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

// ── App action helpers ────────────────────────────────────────────────────────
const cl       = (id: string) => document.getElementById(id)?.click()
const q        = (sel: string) => document.querySelector<HTMLElement>(sel)?.click()
const scr      = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior:'smooth', block:'start' })
const clickStart = () => {
  const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
  if (btn && /start|resume/i.test(btn.textContent??'')) btn.click()
}

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

  // ── APP CONTROLS ──────────────────────────────────────────────────────────
  // NOTE: lock patterns use word boundaries — avoids false match on "stop locking/listening"
  { re: /\block\s+screen\b|\bscreen\s+lock\b|\block\s+karo\b|\block\s+kar\b/i,            action: () => cl('lock-btn'), reply: 'Screen locked.' },
  { re: /\block\s+phone\b|\block\s+app\b|\bprivacy\s+mode\b/i,                            action: () => cl('lock-btn'), reply: 'Screen locked.' },
  { re: /\bunlock\s+screen\b|\bscreen\s+unlock\b|\bunlock\s+kar\b/i,                      action: () => cl('lock-btn'), reply: 'Unlocking.' },
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
]

// Filter out inline-handled entries (empty reply delegates to respond() inside action)
const FILTERED_CMDS = CMDS

// ── Quiz System ───────────────────────────────────────────────────────────────
async function startQuiz(topic: string): Promise<void> {
  if (!GROQ_KEY) { respond('Add VITE_GROQ_API_KEY to enable quiz mode.'); return }
  setState('thinking'); setStatus('Preparing quiz…')
  respond(`Preparing 5 MCQs on ${topic}. Get ready.`)

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
  _quizIdx++
  let reply = ''
  if (chosen === item.ans) {
    _quizHits++
    reply = `Correct! ${item.exp}`
  } else {
    reply = `Not quite. The answer is ${item.ans}. ${item.exp}`
  }
  addMsg('assistant', reply)
  _quizPhase = 'revealed'
  speak(reply)
  // auto-advance after speaking
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
  const pct = Math.round((_quizHits/_quizItems.length)*100)
  const verdict = pct>=80 ? 'Excellent!' : pct>=60 ? 'Good effort.' : 'Keep revising this topic.'
  respond(`Quiz complete! Score: ${_quizHits} out of ${_quizItems.length} — ${pct}%. ${verdict}`)
}

// ── Report generators ─────────────────────────────────────────────────────────
function buildStatusReport(): string {
  const cs = getCurrentState()
  if (!cs) return 'App state not loaded yet. Try again in a moment.'
  const parts: string[] = []
  if (cs.streak) parts.push(`${cs.streak}-day study streak.`)
  if (cs.today?.subject) parts.push(`Today: ${cs.today.subject}.`)
  if (cs.backlogRemaining != null) parts.push(`${cs.backlogRemaining} lectures pending.`)
  if (cs.performance?.prelimsAvg != null) parts.push(`Prelims average: ${cs.performance.prelimsAvg.toFixed(1)}%.`)
  if (cs.selectionProbabilityPct != null) parts.push(`Selection probability: ${cs.selectionProbabilityPct.toFixed(1)}%.`)
  const focusMins = getTodayFocusMins()
  if (focusMins > 0) parts.push(`${focusMins} minutes studied today.`)
  if (_reminders.length) parts.push(`${_reminders.length} active reminder${_reminders.length>1?'s':''}.`)
  return parts.length ? parts.join(' ') : 'No data yet. Start logging sessions to see your report.'
}

function buildTodayReport(): string {
  const cs = getCurrentState()
  const rows = document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')
  const doneRows = document.querySelectorAll<HTMLElement>('#plan .plan-row.done')
  const pending = Array.from(rows).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0,3)
  const parts: string[] = []
  if (cs?.today?.subject) parts.push(`Today's subject: ${cs.today.subject}.`)
  if (pending.length) parts.push(`Pending: ${pending.join(', ')}.`)
  if (doneRows.length) parts.push(`${doneRows.length} lecture${doneRows.length>1?'s':''} done today.`)
  const mins = getTodayFocusMins()
  if (mins) parts.push(`${mins} minutes focused so far.`)
  return parts.length ? parts.join(' ') : 'Open the Plan section to see today\'s lectures.'
}

function buildExamCountdown(): string {
  try {
    const raw = localStorage.getItem('settings') ?? '{}'
    const settings = JSON.parse(raw) as {prelimsDate?: string}
    if (settings.prelimsDate) {
      const target = new Date(settings.prelimsDate)
      const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000)
      if (days > 0) return `${days} days until Prelims on ${target.toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}. Make every day count.`
      if (days === 0) return 'Prelims is today! You\'ve got this, Om.'
    }
  } catch { /* ignore */ }
  const cs = getCurrentState()
  return cs ? `Prelims date not configured in settings. Set it to get the countdown. Backlog: ${cs.backlogRemaining ?? '?'} lectures.` : 'Set your exam date in Settings for a countdown.'
}

function buildRevisionLine(): string {
  const rows = document.querySelectorAll<HTMLElement>('#plan .plan-row[data-type="revision"]:not(.done)')
  if (!rows.length) return 'No revisions due today. Great discipline!'
  const titles = Array.from(rows).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0,3)
  return `${rows.length} revision${rows.length>1?'s':''} due: ${titles.join(', ')}.`
}

function buildWeekSummary(): string {
  try {
    const raw = localStorage.getItem('focusLog') ?? '{}'
    const log = JSON.parse(raw) as Record<string,number>
    let total = 0, days = 0
    for (let i=0; i<7; i++) {
      const d = new Date(); d.setDate(d.getDate()-i)
      const key = d.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})
      if (log[key]) { total += log[key]; days++ }
    }
    const cs = getCurrentState()
    const parts = [`This week: ${total} session${total!==1?'s':''} across ${days} day${days!==1?'s':''}.`]
    if (cs?.streak) parts.push(`Current streak: ${cs.streak} days.`)
    if (cs?.backlogRemaining) parts.push(`${cs.backlogRemaining} lectures still pending.`)
    return parts.join(' ')
  } catch { return 'Weekly data unavailable. Keep logging sessions to see your summary.' }
}

function buildRankLine(): string {
  const cs = getCurrentState()
  if (!cs) return 'No rank data available yet.'
  return cs.rankProjection ? `Projected rank: ${cs.rankProjection}. SP: ${cs.selectionProbabilityPct?.toFixed(1)??'--'}%.` : 'Enter more test scores to generate a rank estimate.'
}

// ── Motivation & celebration ──────────────────────────────────────────────────
const MOTIVATION = [
  'Every revision is a brick in the wall of your selection. Keep building.',
  "IAS 2028 is the goal. Today's session is the path. Keep walking.",
  'The toppers you admire were exactly where you are now. They kept going.',
  'Consistency beats brilliance. Show up today.',
  'Hard days build the hardest officers. Push through.',
  'You\'ve come too far to stop now, Om. One more session.',
  'The UPSC preparation journey is a marathon. Trust the process.',
  'Focus on today\'s lecture. The rank takes care of itself.',
]
const CELEBRATE = [
  'Excellent work!', 'That\'s the spirit!', 'Keep this momentum!',
  'One down, keep going!', 'Progress!', 'Well done!',
]
const TIPS = [
  'Active recall beats passive re-reading. Close the notes and write what you remember.',
  'Do at least 20 PYQs per topic before moving on. UPSC repeats patterns.',
  'Revise yesterday\'s lecture for 10 minutes before starting today\'s. SRS works.',
  'Answer writing is the final exam skill. Practice at least 2 answers every day.',
  'Map every topic to its GS paper and question pattern — it changes how you study.',
  'Current affairs should connect to static syllabus. One event, multiple angles.',
  'The newspaper is a 250-mark paper. Read with a syllabus lens, not a news lens.',
  'Ethics GS4 is all about consistency between values and actions. Your practice counts.',
]
const QUOTES = [
  '"It always seems impossible until it\'s done." — Nelson Mandela',
  '"Success is the sum of small efforts repeated day in and day out." — R. Collier',
  '"The secret of getting ahead is getting started." — Mark Twain',
  '"Dreams don\'t work unless you do." — John C. Maxwell',
  '"One today is worth two tomorrows." — Benjamin Franklin',
  '"Discipline is choosing between what you want now and what you want most."',
]
function motivationLine(): string { return MOTIVATION[Math.floor(Math.random()*MOTIVATION.length)] }
function celebrationLine(): string { return CELEBRATE[Math.floor(Math.random()*CELEBRATE.length)] }
function studyTip(): string { return TIPS[Math.floor(Math.random()*TIPS.length)] }
function studyQuote(): string { return QUOTES[Math.floor(Math.random()*QUOTES.length)] }

// ── System prompt — rich context ──────────────────────────────────────────────
function buildPrompt(): string {
  const cs  = getCurrentState(), d = todayIST()
  const pending = Array.from(document.querySelectorAll<HTMLElement>('#plan .plan-row:not(.done)')).map(r => r.querySelector('.pl-title')?.textContent?.trim()).filter(Boolean).slice(0,5)
  const focusMins = getTodayFocusMins()
  const remCount  = _reminders.length

  const replyLangInstruction =
    _replyLang === 'hi'       ? 'LANGUAGE: Always respond in Hindi (Devanagari). Never use English words unless it is a proper noun.' :
    _replyLang === 'hinglish' ? 'LANGUAGE: Respond in Hinglish — Hindi words in Roman script mixed with English. Natural conversational mix.' :
    _replyLang === 'en'       ? 'LANGUAGE: Always respond in English.' :
                                'LANGUAGE: Match the user\'s language — Hindi if they write in Hindi, Hinglish if Hinglish, English if English. STRICT — do not switch.'

  return [
    `You are JARVIS — the super-intelligent AI assistant for Om Shisodiya's UPSC CSE 2028 preparation.`,
    `Date: ${d}. Today's subject: ${cs?.today?.subject??'—'}. Backlog: ${cs?.backlogRemaining??'?'} lectures.`,
    cs ? `Streak: ${cs.streak}d. Prelims avg: ${cs.performance?.prelimsAvg?.toFixed(1)??'—'}%. Selection probability: ${cs.selectionProbabilityPct?.toFixed(1)??'—'}%.` : '',
    pending.length ? `Today's pending lectures: ${pending.join(', ')}.` : '',
    focusMins ? `Focus today: ${focusMins} minutes.` : '',
    remCount ? `Active reminders: ${remCount}.` : '',
    ``,
    replyLangInstruction,
    ``,
    `VOICE OUTPUT RULES (you are being spoken aloud, not displayed):`,
    `No markdown. No bullet points. No numbered lists. No asterisks or symbols.`,
    `Short spoken sentences only — 1 to 3 sentences per answer.`,
    `Do not dump statistics unless directly asked. Answer only what was asked.`,
    `Be brilliant, warm, and direct. You care deeply about Om achieving CSE 2028 selection.`,
    ``,
    `SCOPE: UPSC GS1/GS2/GS3/GS4/CSAT, Constitution, current affairs, polity, history, geography, economics, environment, science, answer writing, Prelims MCQs, Mains essays, motivation.`,
    ``,
    `APP COMMANDS — embed when you'd naturally trigger an action:`,
    `<CMD>{"action":"start_timer"}</CMD>  <CMD>{"action":"stop_timer"}</CMD>  <CMD>{"action":"reset_timer"}</CMD>`,
    `<CMD>{"action":"lock_screen"}</CMD>  <CMD>{"action":"skip_today"}</CMD>  <CMD>{"action":"generate_plan"}</CMD>`,
    `<CMD>{"action":"open_add_score"}</CMD>  <CMD>{"action":"focus_mode"}</CMD>`,
    `<CMD>{"action":"scroll_to","section":"engine|intel|plan|routine|constitution"}</CMD>`,
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
  const cs  = getCurrentState(), tl = t.toLowerCase()
  // Data-driven answers — work without any API key
  if (/backlog|lecture|left|baki|pending/i.test(tl)) return `${cs?.backlogRemaining??'?'} lectures remaining in your backlog.`
  if (/streak|consecutive|din.*padha/i.test(tl))     return `${cs?.streak??0}-day streak. Keep it going!`
  if (/subject|today|aaj.*kya|kya.*aaj/i.test(tl))  return `Today: ${cs?.today?.subject??'—'}.`
  if (/rank|select|probability|sp/i.test(tl))        return `Selection probability: ${cs?.selectionProbabilityPct?.toFixed(1)??'--'}%.`
  if (/motivat|inspire|tired|thak|himmat/i.test(tl)) return motivationLine()
  if (/status|report|briefing|how.*doing/i.test(tl)) return buildStatusReport()
  if (/plan|schedule|today.*plan|kya.*padhna/i.test(tl)) return buildTodayReport()
  if (/tip|advice|suggestion/i.test(tl))             return studyTip()
  if (/time.*left|kitna.*time|timer.*remaining/i.test(tl)) {
    const el = document.querySelector<HTMLElement>('.ring-time')
    return el?.textContent ? `${el.textContent} remaining on the timer.` : 'Timer is not running.'
  }
  // Groq not configured — helpful message (not a config error message)
  return "I can handle commands like 'start timer', 'show plan', 'add score', 'quiz me on Polity', and all UPSC topics. What do you need?"
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
        setStatus('Ready — say Jarvis or double clap')
        VA.setState('idle')
        if (_state !== 'listening') startWakeWord()  // don't interrupt if user re-opened mic
      }, 2500)
      return
    }
    const utt   = new SpeechSynthesisUtterance(sentences[i++])
    utt.volume  = 1; utt.rate = 0.90; utt.pitch = 1.0
    utt.lang    = isHindi ? 'hi-IN' : 'en-IN'
    if (isHindi) {
      // Prefer online/neural Hindi voices (same quality logic as English)
      const hv = _voices.find(v => v.lang==='hi-IN' && /online|natural|neural/i.test(v.name))
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

// ── Wake word detection — "Jarvis" at start OR end, strips + routes inline ────
function startWakeWord(): void {
  // Never start wake word while command mic is open — would cause mic contention
  if (!_jarvisEnabled || _wakeRunning || _state === 'listening' || _isSpeaking || _sleeping) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return

  _wakeRunning = true
  const r = new SR(); _wakeRec = r
  r.continuous      = false
  r.lang            = _lang   // respect user's preferred language
  r.interimResults  = false
  r.maxAlternatives = 3

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onresult = (e: any) => {
    if (_isSpeaking) return
    // Collect all alternatives — pick best
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alts = Array.from(e.results[0] as any[]).map((a: any) => (a.transcript as string).trim())
    // Find alternative that has "jarvis" (or variants) as a word
    const WAKE_RE = /\bjarvis\b|\bjarbi\b|\bjarwis\b|\bjar vis\b|\bजार्विस\b/i
    const matched = alts.find(a => WAKE_RE.test(a)) ?? ''
    if (!matched) return  // no wake word in any alternative

    _wakeRunning = false
    // Strip wake word from start or end, plus common prefixes (hey/ok/oi/yo/bhai)
    const command = matched
      .replace(/^(?:hey|ok|okay|oi|yo|bhai|haan)\s+/i, '')   // strip "hey"/"ok" prefix
      .replace(/^(?:jarvis|जार्विस)\s*[,.]?\s*/i, '')
      .replace(/\s*[,.]?\s*(?:jarvis|जार्विस)\s*$/i, '')
      .trim()

    const btn = document.getElementById('jarvis-btn')
    btn?.classList.add('listening')
    setTimeout(() => btn?.classList.remove('listening'), 500)

    if (command) {
      // Inline command: "explain fundamental rights, Jarvis" → route immediately
      _everActivated = true
      if (!_open) openPanel()
      VA.setState('thinking')
      addMsg('user', command)
      void executeIntent(command)
    } else {
      // "Jarvis" alone: always activate listening — never close the panel.
      // Use Case A: panel closed → open (no greeting) + listen
      // Use Case B: panel open already → just listen again (user wants to give another command)
      _everActivated = true
      if (!_open) {
        openPanel(false)   // open WITHOUT greeting so mic starts immediately
        greetWake()        // tiny cue "Yes?" (~400ms)
      } else {
        greetWake()        // tiny cue even when panel already open
      }
      wakeAndListen()      // polls until cue finishes, then starts mic
    }
  }

  r.onend   = () => { _wakeRunning = false; if (_jarvisEnabled && _state !== 'listening' && !_isSpeaking && !_sleeping) setTimeout(startWakeWord, 600) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onerror = (err: any) => {
    _wakeRunning = false
    const delay = err.error === 'network' ? 5000 : 800
    if (_jarvisEnabled && !_sleeping) setTimeout(startWakeWord, delay)
  }
  try { r.start() } catch { _wakeRunning = false; setTimeout(startWakeWord, 3000) }
}

// ── Clap detection — sharp transient only, no ambient sound ──────────────────
async function startClapWatch(): Promise<void> {
  let stream: MediaStream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
  catch { return }

  const ac = new AudioContext()
  const an = ac.createAnalyser(); an.fftSize = 256
  ac.createMediaStreamSource(stream).connect(an)
  const data = new Uint8Array(an.frequencyBinCount)

  let ambient = 0, nSamples = 0
  let lastClap = 0, suppress = 0
  let peakStreak = 0   // consecutive above-threshold samples; claps are brief (≤4 @ 45ms)

  // Clap-only detection — must be a clear spike well above ambient
  const ABOVE   = 58    // needs a strong sharp spike; speech/music won't reach this
  const MIN_ABS = 38    // absolute RMS floor — ignore dead-quiet-room false positives
  const MAX_GAP = 700   // real double-claps land within 700ms of each other
  const MIN_GAP = 80    // min 80ms debounce between any two spikes

  setInterval(() => {
    if (!_jarvisEnabled) return
    an.getByteFrequencyData(data)
    const rms = Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length)

    // Feed ambient mic amplitude to the aurora even when idle (room sound = aurora reacts)
    if (VA.state === 'idle' && !_isSpeaking) {
      const ambAmp = Math.min(1, rms / 80)    // normalise to 0-1, 80 = typical speech level
      VA.setAmplitude(ambAmp * 0.35)          // scale down so ambient is subtle
    }

    if (nSamples < 40) { ambient = (ambient*nSamples+rms)/(nSamples+1); nSamples++; return }

    if (!_everActivated || _isSpeaking || !_clapEnabled) return  // clap check needs activation

    const now = Date.now()
    if (now < suppress) return

    const threshold = _clapThreshold > 0 ? _clapThreshold : ambient + ABOVE

    if (rms > threshold && rms > MIN_ABS) {
      peakStreak++
      // Sustained sound (speech, music) stays above threshold for many samples.
      // A real clap lasts ≤4 samples (~180ms) — anything longer is NOT a clap.
      if (peakStreak > 4) { lastClap = 0; return }
      suppress = now + MIN_GAP

      if (lastClap && now - lastClap < MAX_GAP) {
        // ✅ Double clap!
        lastClap = 0; peakStreak = 0
        if (_isSpeaking) return
        _sleeping = false; _everActivated = true
        const btn = document.getElementById('jarvis-btn')
        btn?.classList.add('listening')
        setTimeout(() => btn?.classList.remove('listening'), 600)
        if (!_open) { openPanel(); setTimeout(() => void startListening(), 700) }
        else void startListening()
      } else {
        lastClap = now
        const btn = document.getElementById('jarvis-btn')
        btn?.style.setProperty('opacity','0.7')
        setTimeout(() => btn?.style.removeProperty('opacity'), 120)
      }
    } else {
      peakStreak = 0  // sound dropped — reset streak so next spike counts fresh
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
  if (!alreadyGreeted) {
    const cs = getCurrentState()
    localStorage.setItem('jarvis_morning', _TODAY)
    _sessionGreeted = true
    respond(buildMorningBrief(cs))
    return
  }
  const h = parseInt(new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',hour12:false}))
  respond(h<12 ? "Good morning, Om. What do you need?" : h<17 ? "Good afternoon, Om. Go ahead." : "Good evening, Om. What's up?")
}

/** Short 1-word cue for wake-word activation — mic opens immediately after this. */
function greetWake(): void {
  setStatus('Listening…')
  speak('Yes?')   // 1 word, <400ms — mic opens as soon as it finishes
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setState(s: JState): void { _state = s }
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
