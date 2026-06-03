/**
 * jarvis.ts — Mission JARVIS (clean rewrite)
 * Voice AI assistant: Groq Llama 3.3 70B + Web Speech API
 * Permanently male voice. Aura orb animation on button.
 */
import './jarvis.css'
import { getCurrentState } from './core-engine'
import { todayIST } from '../services/core'
import { isVisionTrigger, openVisionCapture } from './jarvis-vision'

// ── Config ────────────────────────────────────────────────────────────────────
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_KEY   = import.meta.env.VITE_GROQ_API_KEY as string | undefined

// ── State ─────────────────────────────────────────────────────────────────────
type JState = 'idle' | 'listening' | 'thinking' | 'speaking'
interface Msg  { role: 'user' | 'assistant'; content: string }

let _state: JState = 'idle'
let _history: Msg[] = []
let _open   = false
let _rafId  = 0
let _isSpeaking = false
let _clapEnabled = true

// Voice
const _synth  = window.speechSynthesis
let _voices: SpeechSynthesisVoice[]  = []
let _selVoice: SpeechSynthesisVoice | null = null

// Mic / audio
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rec: any   = null
let _analyser: AnalyserNode | null = null
let _micStream: MediaStream | null = null
let _audioCtx: AudioContext | null = null

// Clap calibration (absolute threshold, persisted)
let _clapThreshold = parseFloat(localStorage.getItem('jarvis_clap_thresh') ?? '0')
let _wakeRunning   = false

// ── Voice — permanently male ───────────────────────────────────────────────────

function loadVoices(): void {
  _voices = _synth.getVoices()
  pickMaleVoice()
}
_synth.addEventListener('voiceschanged', loadVoices)
loadVoices()

function pickMaleVoice(): void {
  if (!_voices.length) return
  const maleKw  = /ravi|guy|james|david|mark|daniel|thomas|male|man|kumar|aaron/i
  const quality = /online|natural|neural|wavenet/i

  const score = (v: SpeechSynthesisVoice) => {
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
  const sorted = [..._voices].sort((a, b) => score(b) - score(a))
  _selVoice = sorted[0] ?? null
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initJarvis(): void {
  if (document.getElementById('jarvis-btn')) return

  const btn = document.createElement('button')
  btn.id = 'jarvis-btn'
  btn.title = 'JARVIS — say "Jarvis" or double-clap to wake'
  btn.innerHTML = `<canvas id="jarvis-btn-canvas"></canvas>`
  btn.addEventListener('click', togglePanel)
  document.body.appendChild(btn)

  // Start aura animation immediately on button
  startAura()

  // Wake word & clap
  setTimeout(() => {
    startWakeWord()
    startClapWatch()
  }, 2000)

  // Keyboard J
  document.addEventListener('keydown', e => {
    if (e.key === 'j' && !['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault(); togglePanel()
    }
  })
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function togglePanel(): void { _open ? closePanel() : openPanel() }

function openPanel(): void {
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
    <div class="jp-status" id="jp-status">Say "Jarvis" or double-clap to wake</div>
    <div class="jp-chat" id="jp-chat"></div>
    <div class="jp-input-row">
      <button id="jp-mic" class="jp-mic-btn" title="Hold to speak">🎙</button>
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

  setTimeout(() => greet(), 400)
}

function closePanel(): void {
  _open = false
  stopListening()
  _synth.cancel()
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
  cv.width = sz * dpr; cv.height = sz * dpr
  cv.style.width = sz + 'px'; cv.style.height = sz + 'px'
  const c  = cv.getContext('2d')!
  c.scale(dpr, dpr)
  const W = sz, H = sz, cx = W / 2, cy = H / 2, R = W / 2 - 1
  let t = 0
  const fft = new Uint8Array(64)

  const frame = () => {
    _rafId = requestAnimationFrame(frame)
    c.clearRect(0, 0, W, H)
    t += 0.014

    let amp = 0
    if (_analyser) { _analyser.getByteFrequencyData(fft); amp = fft.reduce((s,v)=>s+v,0)/fft.length/255 }

    const inten = _state === 'idle'     ? 0.42 + Math.sin(t * 1.1) * 0.07
                : _state === 'listening' ? 0.75 + amp * 0.35 + Math.sin(t * 6) * 0.08
                : _state === 'thinking'  ? 0.60 + Math.sin(t * 3.5) * 0.12
                :                         0.68 + amp * 0.22 + Math.sin(t * 10) * 0.12

    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip()

    // Void background
    c.fillStyle = '#04060a'; c.fillRect(0, 0, W, H)

    // Core bloom
    const core = c.createRadialGradient(cx, cy, 0, cx, cy, R * (0.36 + inten * 0.18))
    core.addColorStop(0,   `rgba(255,235,140,${inten * 0.95})`)
    core.addColorStop(0.35,`rgba(240,181,74,${inten * 0.60})`)
    core.addColorStop(0.8, `rgba(180,110,30,${inten * 0.15})`)
    core.addColorStop(1,   'rgba(180,110,30,0)')
    c.fillStyle = core; c.beginPath(); c.arc(cx,cy,R,0,Math.PI*2); c.fill()

    // Orbital particles
    const pn = _state==='listening'?8 : _state==='speaking'?10 : 5
    for (let i=0;i<pn;i++) {
      const a  = (i/pn)*Math.PI*2 + t*(_state==='idle'?0.4:1.6) + i*0.4
      const pr = R*(0.70 + Math.sin(t*2.5+i*1.4)*0.10)
      const px = cx+Math.cos(a)*pr, py = cy+Math.sin(a)*pr
      const ps = R*0.07*inten
      const pg = c.createRadialGradient(px,py,0,px,py,ps*3)
      pg.addColorStop(0,`rgba(255,240,160,${inten})`); pg.addColorStop(1,'rgba(240,181,74,0)')
      c.fillStyle=pg; c.beginPath(); c.arc(px,py,ps*3,0,Math.PI*2); c.fill()
    }

    // Energy spikes (non-idle)
    if (_state !== 'idle') {
      for (let i=0;i<16;i++) {
        const a = (i/16)*Math.PI*2 + t*0.7
        const sa = amp*R*0.30 + Math.sin(t*4+i*0.7)*R*0.09*inten
        c.beginPath(); c.moveTo(cx+Math.cos(a)*R*0.58, cy+Math.sin(a)*R*0.58)
        c.lineTo(cx+Math.cos(a)*(R*0.58+sa), cy+Math.sin(a)*(R*0.58+sa))
        c.strokeStyle=`rgba(255,215,100,${inten*(0.4+amp*0.5)})`; c.lineWidth=1.8; c.lineCap='round'; c.stroke()
      }
    }

    // Rotating aurora arcs
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

// ── Listening ─────────────────────────────────────────────────────────────────

async function startListening(): Promise<void> {
  if (_state === 'listening' || _isSpeaking) return
  setStatus('🎙 Listening…')
  setState('listening')
  document.getElementById('jp-mic')?.classList.add('active')
  document.getElementById('jarvis-btn')?.classList.add('listening')

  // Mic waveform
  try {
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
    _micStream = ms
    _audioCtx  = new AudioContext()
    _analyser  = _audioCtx.createAnalyser()
    _analyser.fftSize = 64
    _audioCtx.createMediaStreamSource(ms).connect(_analyser)
  } catch { /* no mic visual, still try recognition */ }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) { speak('Speech recognition not available. Please type.'); return }

  let got = false
  function tryLang(lang: string, fallback = false): void {
    const r = new SR()
    _rec = r
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (e: any) => {
      if (got) return; got = true
      let best = e.results[0][0].transcript as string
      for (let i=1;i<e.results[0].length;i++) {
        if ((e.results[0][i].transcript as string).length > best.length) best = e.results[0][i].transcript as string
      }
      stopListening(); void processQuery(best.trim())
    }
    r.onerror = () => { if (!got && !fallback) tryLang('en-IN', true); else if (!got) { stopListening(); setState('idle') } }
    r.onend   = () => { if (!got && !fallback) tryLang('en-IN', true); else if (!got) setState('idle') }
    try { r.start() } catch { if (!fallback) tryLang('en-IN', true) }
  }
  tryLang('hi-IN')
}

function stopListening(): void {
  _rec?.stop(); _rec = null
  _micStream?.getTracks().forEach(t => t.stop()); _micStream = null
  _audioCtx?.close(); _audioCtx = null; _analyser = null
  document.getElementById('jp-mic')?.classList.remove('active')
  document.getElementById('jarvis-btn')?.classList.remove('listening')
}

function sendText(inp: HTMLInputElement): void {
  const txt = inp.value.trim(); if (!txt) return; inp.value = ''
  void processQuery(txt)
}

// ── Query processing ──────────────────────────────────────────────────────────

// Instant command patterns — no AI needed
const CMDS: Array<{ re: RegExp; action: () => void; reply: string }> = [
  { re: /(\d+)\s*min/i, action: () => {}, reply: '' }, // handled separately below
  { re: /timer.*start|start.*timer|shuru|chalu|focus start|pomodoro/i, action: () => clickStart(), reply: 'Timer shuru.' },
  { re: /timer.*stop|band kar|pause|roko/i, action: () => q('[data-act="start"]'), reply: 'Timer paused.' },
  { re: /timer.*reset|reset/i, action: () => q('[data-act="reset"]'), reply: 'Timer reset.' },
  { re: /lock|screen lock/i, action: () => cl('lock-btn'), reply: 'Screen locked.' },
  { re: /intelligence|stats|charts/i, action: () => scr('intel'), reply: 'Intelligence section.' },
  { re: /daily engine|engine|focus timer/i, action: () => scr('engine'), reply: 'Daily Engine.' },
  { re: /plan|planner/i, action: () => scr('plan'), reply: 'The Plan section.' },
  { re: /routine/i, action: () => scr('routine'), reply: 'Routine section.' },
  { re: /constitution/i, action: () => scr('constitution'), reply: 'Constitution section.' },
  { re: /skip today|aaj skip|kal ka/i, action: () => cl('lp-skip-day'), reply: 'Today skipped. Tomorrow\'s plan shown.' },
  { re: /add score|score dal|score add/i, action: () => cl('cm-add-score'), reply: 'Add Score opened.' },
  { re: /generate plan|plan banao/i, action: () => cl('ai-gen'), reply: 'Generating plan…' },
  { re: /focus mode|vfx|animation off/i, action: () => cl('focus-mode-btn'), reply: 'Focus Mode toggled.' },
  { re: /export|backup/i, action: () => cl('cm-export-btn'), reply: 'Exporting data.' },
]

const cl  = (id: string) => document.getElementById(id)?.click()
const q   = (sel: string) => document.querySelector<HTMLElement>(sel)?.click()
const scr = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
const clickStart = () => {
  const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
  if (btn && (btn.textContent?.toLowerCase().includes('start') || btn.textContent?.toLowerCase().includes('resume'))) btn.click()
}

/** Convert spoken number text to an integer.
 *  Handles: "24", "2 4", "twenty four", "twenty-four", "bees", "chaubees" */
function parseSpokenMinutes(text: string): number | null {
  const t = text.toLowerCase().trim()

  // 1. Plain digits: "24 minutes"
  const plain = t.match(/\b(\d{1,3})\s*(?:min|minute|minutes|mins|minat|मिनट)/i)
  if (plain) { const n = parseInt(plain[1]); if (n >= 1 && n <= 180) return n }

  // 2. Two separate digits heard as "2 4 minutes" → join → "24"
  const split = t.match(/\b(\d)\s+(\d)\s*(?:min|minute|minutes|mins|minat|मिनट)/i)
  if (split) { const n = parseInt(split[1] + split[2]); if (n >= 1 && n <= 180) return n }

  // 3. Three separate digits "1 2 0" → "120"
  const split3 = t.match(/\b(\d)\s+(\d)\s+(\d)\s*(?:min|minute|minutes)/i)
  if (split3) { const n = parseInt(split3[1]+split3[2]+split3[3]); if (n >= 1 && n <= 180) return n }

  // 4. English word numbers
  const TENS: Record<string, number>  = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, ninety:90 }
  const ONES: Record<string, number>  = {
    one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,
    seventeen:17,eighteen:18,nineteen:19
  }
  if (t.match(/min|minat/i)) {
    const words = t.replace(/-/g,' ').split(/\s+/)
    let total = 0
    for (const w of words) {
      if (TENS[w]) total += TENS[w]
      else if (ONES[w]) total += ONES[w]
    }
    if (total >= 1 && total <= 180) return total
  }

  return null
}

async function processQuery(text: string): Promise<void> {
  if (isVisionTrigger(text)) { addMsg('user', text); openVisionCapture(text, respond); return }

  // Smart timer minutes parser — handles "24", "2 4", "twenty four", etc.
  const mins = parseSpokenMinutes(text)
  if (mins !== null) {
    addMsg('user', text)
    window.dispatchEvent(new CustomEvent('jarvis:set-timer', { detail: { focus: mins } }))
    setTimeout(clickStart, 350)
    respond(`${mins} minute ka timer set karke start kiya.`)
    return
  }

  // Quick commands
  for (const cmd of CMDS) {
    if (cmd.re !== CMDS[0].re && cmd.re.test(text)) {
      addMsg('user', text); cmd.action(); respond(cmd.reply); return
    }
  }

  // AI
  addMsg('user', text)
  setState('thinking'); setStatus('Thinking…')
  if (!GROQ_KEY) { respond(offlineAnswer(text)); return }

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: buildPrompt() },
          ..._history.slice(-8).map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 220,
        temperature: 0.65,
        stream: false,
      }),
    })
    if (!res.ok) throw new Error(String(res.status))
    const d = await res.json() as { choices: { message: { content: string } }[] }
    respond(d.choices[0].message.content.trim())
  } catch { respond('Network issue. Try again.') }
}

function offlineAnswer(t: string): string {
  const cs = getCurrentState()
  const tl = t.toLowerCase()
  if (/backlog|lecture|left/i.test(tl))  return `${cs?.backlogRemaining ?? '?'} lectures remaining.`
  if (/streak/i.test(tl))               return `${cs?.streak ?? 0} day streak.`
  if (/subject|today|aaj/i.test(tl))    return `Today: ${cs?.today.subject ?? 'checking…'}.`
  if (/rank|select|probability/i.test(tl)) return `SP ${cs?.selectionProbabilityPct?.toFixed(1) ?? '--'}% — ${cs?.rankProjection ?? '--'}.`
  return 'Add VITE_GROQ_API_KEY for full AI. Basic answers available offline.'
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildPrompt(): string {
  const cs = getCurrentState(), d = todayIST()
  return [
    `You are JARVIS — the advanced AI assistant for Om Shisodiya's UPSC CSE 2028 preparation.`,
    `Date: ${d}. Subject: ${cs?.today.subject??'—'}. Backlog: ${cs?.backlogRemaining??'?'} lectures.`,
    cs ? `Streak: ${cs.streak}d. Prelims avg: ${cs.performance.prelimsAvg?.toFixed(1)??'—'}%. SP: ${cs.selectionProbabilityPct?.toFixed(1)??'—'}%.` : '',
    ``,
    `VOICE RULES — you are speaking, not writing:`,
    `No markdown, no bullets, no numbers. Spoken sentences only. 1-2 sentences max for actions.`,
    `Do not dump statistics unless asked. Answer what was asked, nothing more.`,
    `Match the user's language exactly: Hindi for Hindi, Hinglish for Hinglish, English for English.`,
    ``,
    `You help Om with: UPSC topics (all GS papers, CSAT), MCQ generation, Mains answer writing,`,
    `Constitution, current affairs, study planning, motivation. You are brilliant, warm, concise.`,
    ``,
    `APP COMMANDS (embed when relevant): <CMD>{"action":"ACTION"}</CMD>`,
    `Actions: start_timer|stop_timer|reset_timer|lock_screen|skip_today|scroll_to|open_add_score|generate_plan|focus_mode`,
    `scroll_to needs section: engine|intel|routine|constitution|plan`,
  ].filter(Boolean).join('\n')
}

// ── Execute app commands ──────────────────────────────────────────────────────

function execCommands(reply: string): string {
  const clean = reply.replace(/<CMD>.*?<\/CMD>/g, '').replace(/<ACT>.*?<\/ACT>/g, '').trim()
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
    } catch { /* ignore bad JSON */ }
  }
  return clean
}

// ── Speech output — male voice ────────────────────────────────────────────────

function speak(text: string): void {
  _synth.cancel()
  if (!_voices.length) loadVoices()
  const isHindi = /[ऀ-ॿ]/.test(text)
  const clean   = text.replace(/\*\*?(.*?)\*\*?/g, '$1').replace(/`/g, '').replace(/[#*_]/g, '').trim()

  // Split into short sentences for natural delivery
  const sentences = clean.split(/(?<=[.!?।])\s+/).filter(s => s.trim()).slice(0, 6)
  if (!sentences.length) return

  _isSpeaking    = true
  _clapEnabled   = false
  _rec?.stop(); _rec = null
  setState('speaking'); setStatus(isHindi ? 'बोल रहा हूँ…' : 'Speaking…')

  let i = 0
  const next = (): void => {
    if (i >= sentences.length) {
      _isSpeaking = false
      setTimeout(() => { _clapEnabled = true; setState('idle'); setStatus('Ready') }, 1500)
      return
    }
    const utt  = new SpeechSynthesisUtterance(sentences[i++])
    utt.volume = 1
    utt.rate   = 0.90   // natural, not rushed
    utt.pitch  = 1.0    // neutral — don't artificially lower, sounds robotic
    utt.lang   = isHindi ? 'hi-IN' : 'en-IN'

    // Male voice selection
    if (isHindi) {
      const hv = _voices.find(v => v.lang === 'hi-IN' && !/online|natural/i.test(v.name))
              ?? _voices.find(v => v.lang === 'hi-IN')
      if (hv) utt.voice = hv
    } else if (_selVoice) {
      utt.voice = _selVoice
    }

    utt.onend   = next
    utt.onerror = next
    _synth.speak(utt)
  }
  next()
}

// ── Wake word & clap detection ────────────────────────────────────────────────

let _wakeRec: any = null

function startWakeWord(): void {
  if (_wakeRunning || _open) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return

  _wakeRunning = true
  const r = new SR()
  _wakeRec = r
  r.continuous = true; r.lang = 'en-IN'; r.interimResults = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r.onresult = (e: any) => {
    if (_isSpeaking) return
    const t = Array.from(e.results as any[]).map((x: any) => x[0].transcript as string).join(' ').toLowerCase()
    if (t.includes('jarvis')) {
      _wakeRec?.stop(); _wakeRunning = false
      document.getElementById('jarvis-btn')?.classList.add('listening')
      setTimeout(() => document.getElementById('jarvis-btn')?.classList.remove('listening'), 500)
      if (!_open) { openPanel(); setTimeout(() => void startListening(), 700) }
      else void startListening()
    }
  }
  r.onend = () => { _wakeRunning = false; if (!_isSpeaking && !_open) setTimeout(startWakeWord, 1200) }
  r.onerror = () => { _wakeRunning = false; if (!_open) setTimeout(startWakeWord, 2000) }
  try { r.start() } catch { _wakeRunning = false }
}

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

  // More sensitive defaults — clap detection needs to work in real rooms
  const ABOVE   = 22    // lowered from 34 — detect softer claps
  const MAX_GAP = 1400  // up to 1.4s between claps
  const MIN_GAP = 50    // min 50ms gap (debounce)

  setInterval(() => {
    if (_isSpeaking || !_clapEnabled) return
    an.getByteFrequencyData(data)
    const rms = Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length)

    // Auto-calibrate ambient for first 2 seconds
    if (nSamples < 40) { ambient = (ambient*nSamples+rms)/(nSamples+1); nSamples++; return }

    const now = Date.now()
    if (now < suppress) return

    // Use stored calibrated threshold if available, else ambient-relative
    const threshold = _clapThreshold > 0 ? _clapThreshold : ambient + ABOVE
    if (rms > threshold) {
      suppress = now + MIN_GAP

      if (lastClap && now - lastClap < MAX_GAP) {
        // ✅ Double clap!
        lastClap = 0
        if (_isSpeaking) return
        // Flash the button
        const btn = document.getElementById('jarvis-btn')
        btn?.classList.add('listening')
        setTimeout(() => btn?.classList.remove('listening'), 600)

        if (!_open) { openPanel(); setTimeout(() => void startListening(), 700) }
        else void startListening()
      } else {
        lastClap = now
        // Single clap detected — briefly dim button so user gets feedback
        const btn = document.getElementById('jarvis-btn')
        btn?.style.setProperty('opacity', '0.7')
        setTimeout(() => btn?.style.removeProperty('opacity'), 120)
      }
    }
  }, 45)  // slightly faster polling
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
    const data = new Uint8Array(an.frequencyBinCount)
    const rms = () => Math.sqrt(data.reduce((s,v)=>(an.getByteFrequencyData(data),s+v*v),0)/data.length)

    // Step 1: ambient
    let sum = 0, n = 0
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100))
      sum += rms(); n++
      bar.style.width = `${(i/20)*50}%`
    }
    const ambient = sum / n

    // Step 2: clap
    msg.textContent = '👏 CLAP TWICE now!'
    bar.style.width = '50%'; bar.style.background = 'var(--good)'
    let peak = ambient
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      const v = rms(); if (v > peak) peak = v
      bar.style.width = `${50 + (i/30)*50}%`
    }
    stream.getTracks().forEach(t => t.stop()); ac.close()

    const thresh = ambient + (peak - ambient) * 0.42
    _clapThreshold = thresh
    localStorage.setItem('jarvis_clap_thresh', String(thresh))

    msg.innerHTML = `<b style="color:var(--good)">✓ Done!</b><br>Ambient: ${ambient.toFixed(0)} · Peak: ${peak.toFixed(0)}<br>Threshold: ${thresh.toFixed(0)}`
    bar.style.width = '100%'
    setTimeout(() => modal.remove(), 2500)
  } catch {
    msg.textContent = 'Microphone access needed.'
  }
}

// ── Greeting ──────────────────────────────────────────────────────────────────

function greet(): void {
  const h = parseInt(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }))
  respond(h < 12 ? 'Good morning, Om.' : h < 17 ? 'Good afternoon, Om.' : 'Good evening, Om.')
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function setState(s: JState): void { _state = s }
function setStatus(t: string): void { const e = document.getElementById('jp-status'); if (e) e.textContent = t }

function addMsg(role: 'user' | 'assistant', content: string): void {
  _history.push({ role, content })
  if (_history.length > 12) _history = _history.slice(-12)
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
  const clean = execCommands(text)
  addMsg('assistant', clean)
  speak(clean)
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// Re-export vision helpers used by processQuery
export { isVisionTrigger as _visionCheck }
