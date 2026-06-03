/**
 * jarvis.ts — Mission: JARVIS
 * - Voice input/output: Web Speech API (free)
 * - Vision: camera capture + file upload → Groq Llama 4 Vision (free)
 * - AI: Groq Llama 3.3 70B / Llama 4 Scout Vision (VITE_GROQ_API_KEY)
 * - Dynamic DOM control: JARVIS discovers and acts on ANY page element
 * - Animation: canvas arc-reactor + real mic waveform
 */
import './jarvis.css'
import { getCurrentState } from './core-engine'
import { todayIST } from '../services/core'

// ── Types ─────────────────────────────────────────────────────────────────────
type JState = 'idle' | 'listening' | 'thinking' | 'speaking'
interface Message { role: 'user' | 'assistant'; content: string }

// ── State ─────────────────────────────────────────────────────────────────────
let _state: JState = 'idle'
let _history: Message[] = []
let _canvas: HTMLCanvasElement | null = null
let _ctx: CanvasRenderingContext2D | null = null
let _rafId = 0
let _audioCtx: AudioContext | null = null
let _analyser: AnalyserNode | null = null
let _micStream: MediaStream | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _recognition: any = null
let _synth = window.speechSynthesis
let _open = false

// ── Voice selection ────────────────────────────────────────────────────────────
let _voices: SpeechSynthesisVoice[] = []
let _selectedVoice: SpeechSynthesisVoice | null = null
let _voiceGender: 'female' | 'male' = (localStorage.getItem('jarvis_voice_gender') as 'female' | 'male') ?? 'female'

function loadVoices(): void {
  _voices = _synth.getVoices()
  selectBestVoice()
}
_synth.addEventListener('voiceschanged', loadVoices)
loadVoices()

function selectBestVoice(): void {
  if (!_voices.length) return

  // Score voices: Online/Neural > Natural > Google Neural > anything
  // These Microsoft "Online" voices are streamed from Azure and sound genuinely human
  function score(v: SpeechSynthesisVoice): number {
    let s = 0
    // Quality tier — highest to lowest
    if (/online.*natural|natural.*online/i.test(v.name)) s += 200   // Microsoft Azure Neural streamed
    if (/online/i.test(v.name))                          s += 150   // Any Microsoft online voice
    if (/neural|wavenet|neural2/i.test(v.name))          s += 120   // Neural voices
    if (/google/i.test(v.name) && v.localService === false) s += 80  // Google cloud voice
    if (!v.localService)                                 s += 40    // Any cloud/streamed voice
    // Language preference: India English > UK > US
    if (v.lang === 'en-IN') s += 35
    if (v.lang === 'en-GB') s += 25
    if (v.lang === 'en-AU') s += 20
    if (v.lang === 'en-US') s += 15
    if (v.lang.startsWith('en')) s += 5
    // Gender match
    const femaleKw = /female|woman|aria|jenny|zira|heera|kalpana|sonia|neerja|priya/i
    const maleKw   = /male|man|ravi|david|guy|james|mark|kumar/i
    if (_voiceGender === 'female' && femaleKw.test(v.name)) s += 60
    if (_voiceGender === 'male'   && maleKw.test(v.name))   s += 60
    return s
  }

  const sorted = [..._voices].sort((a, b) => score(b) - score(a))
  _selectedVoice = sorted[0] ?? null
  console.info('[JARVIS voice]', _selectedVoice?.name, '|', _selectedVoice?.lang,
    '| local:', _selectedVoice?.localService)
}

// ── Clap calibration ───────────────────────────────────────────────────────────
let _clapThreshold = parseFloat(localStorage.getItem('jarvis_clap_threshold') ?? '0')
const DEFAULT_CLAP_THRESHOLD_ABOVE = 55

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined

// ── Public init ───────────────────────────────────────────────────────────────

export function initJarvis(): void {
  if (document.getElementById('jarvis-btn')) return

  const btn = document.createElement('button')
  btn.id = 'jarvis-btn'
  btn.title = 'Mission JARVIS — AI Assistant (press J or double clap)'
  // The canvas for wave animation sits INSIDE the button ring
  btn.innerHTML = `
    <canvas id="jarvis-btn-canvas"></canvas>
    <span class="jb-icon" style="position:relative;z-index:2;">J</span>
  `
  btn.addEventListener('click', togglePanel)
  document.body.appendChild(btn)

  // Keyboard shortcut: J key (when not typing)
  document.addEventListener('keydown', e => {
    if (e.key === 'j' && !['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault()
      togglePanel()
    }
  })

  // Wake word: say "Jarvis" to open
  startWakeWordListener()
  // Clap wake: double-clap opens JARVIS (works even when tab is minimised)
  startClapDetection()
}

// ── Clap detection (double-clap = wake, works when tab is backgrounded) ──────

let _clapStream: MediaStream | null = null
let _clapCtx: AudioContext | null   = null
let _clapEnabled = false

async function startClapDetection(): Promise<void> {
  // Ask permission once and keep mic open at near-zero CPU cost
  try {
    _clapStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  } catch {
    console.info('[JARVIS] Mic permission denied — clap wake disabled')
    return
  }

  _clapCtx = new AudioContext()
  const analyser = _clapCtx.createAnalyser()
  analyser.fftSize = 512
  _clapCtx.createMediaStreamSource(_clapStream).connect(analyser)

  const data = new Uint8Array(analyser.frequencyBinCount)

  // Use calibrated absolute threshold if available, else do auto-calibration
  let ambient = 0
  let calibSamples = 0
  // If user has calibrated, _clapThreshold is an absolute RMS value
  // Otherwise fall back to relative threshold above ambient
  const USE_CALIBRATED = _clapThreshold > 0
  const THRESHOLD_ABOVE_AMBIENT = 50  // fallback relative threshold
  const CLAP_MIN_MS  = 80    // min time between clap start and next check
  const CLAP_MAX_MS  = 900   // max time between two claps for double-clap
  let lastClapTime   = 0
  let suppressUntil  = 0

  _clapEnabled = true

  // Use setInterval (not rAF) so it runs in background tabs
  const iv = setInterval(() => {
    if (!_clapEnabled) { clearInterval(iv); return }

    analyser.getByteFrequencyData(data)
    // RMS volume
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)

    // Calibrate for 2 seconds
    if (calibSamples < 40) {
      ambient = (ambient * calibSamples + rms) / (calibSamples + 1)
      calibSamples++
      return
    }

    const now = Date.now()
    if (now < suppressUntil) return   // ignore echoes / reverberation

    const triggered = USE_CALIBRATED
      ? rms > _clapThreshold
      : rms > ambient + THRESHOLD_ABOVE_AMBIENT

    if (triggered) {
      suppressUntil = now + CLAP_MIN_MS   // suppress next 80ms (one clap decay)

      if (lastClapTime && now - lastClapTime < CLAP_MAX_MS) {
        // ✅ Double clap detected!
        lastClapTime = 0
        onClapWake()
      } else {
        lastClapTime = now
      }
    }
  }, 50)   // 20 checks/sec — negligible CPU
}

function onClapWake(): void {
  if (_isSpeaking) return   // don't trigger on echo of own voice
  const btn = document.getElementById('jarvis-btn')
  btn?.classList.add('listening')
  setTimeout(() => btn?.classList.remove('listening'), 600)
  if (!_open) { openPanel(); setTimeout(() => startListening(), 700) }
  else startListening()
}

// ── Wake word: "Jarvis" ───────────────────────────────────────────────────────

let _wakeRecognition: any = null
let _wakeActive = false

function startWakeWordListener(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return

  function startWake(): void {
    if (_wakeActive || _open) return
    _wakeActive = true
    _wakeRecognition = new SR()
    _wakeRecognition.continuous = true
    _wakeRecognition.lang = 'en-IN'
    _wakeRecognition.interimResults = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _wakeRecognition.onresult = (e: any) => {
      const transcript = Array.from(e.results as any[])
        .map((r: any) => r[0].transcript)
        .join(' ')
        .toLowerCase()

      if (!_isSpeaking && (transcript.includes('jarvis') || transcript.includes('jarvis'))) {
        _wakeRecognition?.stop()
        _wakeActive = false
        // Brief audio cue — pulse the button
        const btn = document.getElementById('jarvis-btn')
        btn?.classList.add('listening')
        setTimeout(() => btn?.classList.remove('listening'), 400)
        // Open panel and start listening for the command
        if (!_open) openPanel()
        setTimeout(() => startListening(), 600)
      }
    }
    _wakeRecognition.onerror = () => { _wakeActive = false }
    _wakeRecognition.onend   = () => {
      _wakeActive = false
      // Restart after short delay so it's always listening
      if (!_open) setTimeout(startWake, 1500)
    }
    try { _wakeRecognition.start() } catch { _wakeActive = false }
  }

  // Start after a short delay (let the page settle)
  setTimeout(startWake, 2000)
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function togglePanel(): void {
  if (_open) closePanel(); else openPanel()
}

function openPanel(): void {
  if (_open) return
  _open = true

  const panel = document.createElement('div')
  panel.id = 'jarvis-panel'
  panel.innerHTML = `
    <div class="jarvis-head">
      <span class="jarvis-title">⬡ Mission JARVIS</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <select id="j-voice-gender" title="Voice gender" style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:20px;color:var(--muted);font-family:var(--font-mono);font-size:10px;padding:3px 8px;cursor:pointer;outline:none;">
          <option value="female" ${_voiceGender==='female'?'selected':''}>♀ Female</option>
          <option value="male"   ${_voiceGender==='male'  ?'selected':''}>♂ Male</option>
        </select>
        <button id="j-calibrate" title="Calibrate clap detection" style="background:none;border:1px solid var(--line-2);border-radius:20px;color:var(--muted);font-family:var(--font-mono);font-size:10px;padding:3px 8px;cursor:pointer;">👏 Calibrate</button>
        <button class="jarvis-close" id="j-close">×</button>
      </div>
    </div>
    <div class="jarvis-status-text" id="j-status" style="text-align:center;padding:10px 16px 2px;font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;color:var(--accent);text-transform:uppercase;opacity:.8;">
      Ready — say Jarvis or double clap
    </div>
    <div class="jarvis-history" id="j-history"></div>
    <div class="jarvis-input-row">
      <button id="jarvis-mic" title="Hold to speak">🎤</button>
      <input id="jarvis-text" type="text" placeholder="Ask anything about your UPSC prep…" autocomplete="off" />
      <button id="jarvis-send" title="Send">➤</button>
    </div>
  `
  document.body.appendChild(panel)

  _canvas = document.getElementById('jarvis-canvas') as HTMLCanvasElement
  _ctx    = _canvas.getContext('2d')!
  resizeCanvas()
  startAnimation()

  document.getElementById('j-close')?.addEventListener('click', closePanel)

  // Voice gender selector
  document.getElementById('j-voice-gender')?.addEventListener('change', e => {
    _voiceGender = (e.target as HTMLSelectElement).value as 'female' | 'male'
    localStorage.setItem('jarvis_voice_gender', _voiceGender)
    selectBestVoice()
    // Demo the new voice
    const utt = new SpeechSynthesisUtterance(_voiceGender === 'female' ? 'Hello Om, I\'m ready.' : 'Hello Om, I\'m JARVIS.')
    if (_selectedVoice) utt.voice = _selectedVoice
    utt.rate = 1.0; utt.pitch = _voiceGender === 'female' ? 1.1 : 0.85
    _synth.cancel(); _synth.speak(utt)
  })

  // Clap calibration
  document.getElementById('j-calibrate')?.addEventListener('click', () => startClapCalibration())

  const micBtn  = document.getElementById('jarvis-mic')!
  const sendBtn = document.getElementById('jarvis-send')!
  const input   = document.getElementById('jarvis-text') as HTMLInputElement

  micBtn.addEventListener('click', () => {
    if (_state === 'listening') stopListening()
    else startListening()
  })
  sendBtn.addEventListener('click', () => sendText(input))
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendText(input) })

  // Greet on open
  setTimeout(() => greet(), 400)
}

function closePanel(): void {
  _open = false
  stopListening()
  _synth.cancel()
  cancelAnimationFrame(_rafId)
  _audioCtx?.close(); _audioCtx = null; _analyser = null
  document.getElementById('jarvis-panel')?.remove()
  document.getElementById('jarvis-btn')?.classList.remove('listening')
}

// ── Canvas animation ──────────────────────────────────────────────────────────

function resizeCanvas(): void {
  if (!_canvas) return
  const rect = _canvas.parentElement!.getBoundingClientRect()
  _canvas.width  = rect.width  * devicePixelRatio
  _canvas.height = rect.height * devicePixelRatio
  _canvas.style.width  = rect.width + 'px'
  _canvas.style.height = rect.height + 'px'
  if (_ctx) _ctx.scale(devicePixelRatio, devicePixelRatio)
}

// Siri-style wave descriptors — 5 layered organic waves
const SIRI_WAVES = [
  { freq: 1.3, speed: 1.8,  phase: 0.0,  ampMul: 1.00, r:240, g:181, b: 74, opacity: 0.95, lw: 3.0 },
  { freq: 2.1, speed:-1.5,  phase: 0.9,  ampMul: 0.75, r:255, g:220, b:110, opacity: 0.70, lw: 2.2 },
  { freq: 0.8, speed: 2.3,  phase: 2.2,  ampMul: 0.55, r:255, g:245, b:165, opacity: 0.50, lw: 2.5 },
  { freq: 3.2, speed:-0.9,  phase: 1.5,  ampMul: 0.35, r:200, g:155, b: 55, opacity: 0.40, lw: 1.5 },
  { freq: 1.8, speed: 1.0,  phase: 3.3,  ampMul: 0.20, r:255, g:255, b:200, opacity: 0.25, lw: 1.0 },
]

function startAnimation(): void {
  cancelAnimationFrame(_rafId)
  // Draw on the button's canvas (waves flow inside the ring)
  const btnCanvas = document.getElementById('jarvis-btn-canvas') as HTMLCanvasElement | null
  if (!btnCanvas) return
  const btn = document.getElementById('jarvis-btn')!
  const size = btn.offsetWidth || 68
  btnCanvas.width  = size * devicePixelRatio
  btnCanvas.height = size * devicePixelRatio
  btnCanvas.style.width  = size + 'px'
  btnCanvas.style.height = size + 'px'
  const c2 = btnCanvas.getContext('2d')!
  c2.scale(devicePixelRatio, devicePixelRatio)
  const W = size, H = size
  let t = 0
  const fft = new Uint8Array(128)

  function frame(): void {
    _rafId = requestAnimationFrame(frame)
    const c = c2   // draw on the button canvas
    c.clearRect(0, 0, W, H)
    t += 0.012

    // Get real mic amplitude (0-1)
    let audioAmp = 0
    if (_analyser) {
      _analyser.getByteFrequencyData(fft)
      audioAmp = fft.reduce((s, v) => s + v, 0) / fft.length / 255
    }

    // State → target wave height
    const baseH = H * 0.5
    let maxAmp: number
    switch (_state) {
      case 'idle':      maxAmp = baseH * 0.10 + Math.sin(t * 0.8) * baseH * 0.03; break
      case 'listening': maxAmp = baseH * 0.22 + audioAmp * baseH * 0.28; break
      case 'thinking':  maxAmp = baseH * 0.14 + Math.sin(t * 3.5) * baseH * 0.06; break
      case 'speaking':  maxAmp = baseH * 0.18 + Math.sin(t * 7) * baseH * 0.10 + audioAmp * baseH * 0.15; break
    }

    // ── Siri waves ──────────────────────────────────────────────────────────
    SIRI_WAVES.forEach(w => {
      const amp = maxAmp * w.ampMul
      c.beginPath()
      c.shadowColor = `rgba(${w.r},${w.g},${w.b},0.55)`
      c.shadowBlur  = _state === 'idle' ? 6 : 18
      c.strokeStyle = `rgba(${w.r},${w.g},${w.b},${w.opacity})`
      c.lineWidth   = w.lw
      c.lineCap     = 'round'
      c.lineJoin    = 'round'

      for (let x = 0; x <= W; x += 2) {
        // Envelope: taper smoothly at both edges (Siri characteristic)
        const env = Math.pow(Math.sin((x / W) * Math.PI), 0.7)
        const y   = H / 2 + amp * env *
                    Math.sin((x / W) * w.freq * Math.PI * 2 + t * w.speed + w.phase)
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y)
      }
      c.stroke()
      c.shadowBlur = 0
    })

    // ── Soft centre glow (replaces the arc reactor) ─────────────────────────
    const glowSize = _state === 'listening'
      ? 28 + audioAmp * 20 + Math.sin(t * 6) * 4
      : _state === 'idle' ? 18 + Math.sin(t * 1.2) * 4 : 22
    const g = c.createRadialGradient(W/2, H/2, 0, W/2, H/2, glowSize)
    g.addColorStop(0, 'rgba(240,181,74,.45)')
    g.addColorStop(1, 'rgba(240,181,74,0)')
    c.beginPath(); c.arc(W/2, H/2, glowSize, 0, Math.PI * 2)
    c.fillStyle = g; c.fill()
  }
  frame()
}

// ── Voice input ───────────────────────────────────────────────────────────────

async function startListening(): Promise<void> {
  if (_state === 'listening' || _isSpeaking) return
  setState('listening', 'सुन रहा हूँ… / Listening…')

  // Real microphone waveform via AudioContext
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    _audioCtx  = new AudioContext()
    _analyser  = _audioCtx.createAnalyser()
    _analyser.fftSize = 64
    _audioCtx.createMediaStreamSource(_micStream).connect(_analyser)
  } catch { /* mic permission denied — animation still runs */ }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) { speak("Speech recognition isn't supported. Please type."); setState('idle', 'Type to ask'); return }

  // Try hi-IN first (handles Devanagari + Hinglish); fall back to en-IN if empty
  let gotResult = false

  function tryLang(lang: string, isFallback = false): void {
    const r = new SR()
    _recognition = r
    r.lang = lang
    r.interimResults = false
    r.maxAlternatives = 5  // more alternatives = better Hinglish recognition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (e: any) => {
      if (gotResult) return
      // Pick the alternative with highest confidence or most words
      let best = e.results[0][0].transcript as string
      for (let i = 0; i < e.results[0].length; i++) {
        if ((e.results[0][i].transcript as string).trim().length > best.trim().length)
          best = e.results[0][i].transcript as string
      }
      if (best.trim()) { gotResult = true; stopListening(); void processQuery(best.trim()) }
    }
    r.onerror = () => {
      if (!gotResult && !isFallback) tryLang('en-IN', true)
      else if (!gotResult) { stopListening(); setState('idle', 'Ready') }
    }
    r.onend = () => {
      if (!gotResult && !isFallback) tryLang('en-IN', true)
      else if (!gotResult && isFallback) setState('idle', 'Ready')
    }
    try { r.start() } catch { if (!isFallback) tryLang('en-IN', true) }
  }
  tryLang('hi-IN')

  document.getElementById('jarvis-mic')?.classList.add('active')
  document.getElementById('jarvis-btn')?.classList.add('listening')
}

function stopListening(): void {
  _recognition?.stop(); _recognition = null
  _micStream?.getTracks().forEach(t => t.stop()); _micStream = null
  _audioCtx?.close(); _audioCtx = null; _analyser = null
  document.getElementById('jarvis-mic')?.classList.remove('active')
  document.getElementById('jarvis-btn')?.classList.remove('listening')
  if (_state === 'listening') setState('idle', 'Ready')
}

function sendText(input: HTMLInputElement): void {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  processQuery(text)
}

// ── AI processing ─────────────────────────────────────────────────────────────

// ── Quick command patterns (instant response, no AI round-trip) ───────────────

interface QuickCmd { pattern: RegExp; action: string; section?: string; value?: string; reply: string }

const QUICK_CMDS: QuickCmd[] = [
  // Timer
  { pattern: /timer.*start|start.*timer|shuru karo|chalu karo|pomodoro start|focus start|focus shuru|timer on/i,
    action:'start_timer', reply:'Focus timer shuru kiya, Om! 💪 Concentrate karo.' },
  { pattern: /timer.*stop|band karo|pause karo|roko|timer off|stop timer|timer pause/i,
    action:'stop_timer', reply:'Timer paused. Break lo, Om.' },
  { pattern: /timer.*reset|reset.*timer|timer reset/i,
    action:'reset_timer', reply:'Timer reset kar diya.' },
  { pattern: /timer.*skip|skip.*timer|next break|next session/i,
    action:'skip_timer', reply:'Timer skip kar diya. Next session!' },
  // Lock
  { pattern: /lock karo|lock kar do|screen lock|lock screen|lock it/i,
    action:'lock_screen', reply:'Screen lock kar diya. PIN se unlock karna.' },
  // Navigation
  { pattern: /intelligence|stats|chart|score section/i,
    action:'scroll_to', section:'intel', reply:'Intelligence section pe ja raha hoon.' },
  { pattern: /daily engine|engine section|timer section/i,
    action:'scroll_to', section:'engine', reply:'Daily Engine section pe le gaya.' },
  { pattern: /plan section|the plan|planner section/i,
    action:'scroll_to', section:'plan', reply:'Plan section pe le gaya.' },
  { pattern: /routine section|routine pe|routine dikhao/i,
    action:'scroll_to', section:'routine', reply:'Routine section pe le gaya.' },
  { pattern: /constitution|article section/i,
    action:'scroll_to', section:'constitution', reply:'Constitution section pe le gaya.' },
  // Planner
  { pattern: /skip today|aaj skip|kal ka plan|tomorrow plan/i,
    action:'skip_today', reply:'Aaj skip kiya. Kal ka schedule dikh raha hai.' },
  { pattern: /add score|score add|score dal|score log/i,
    action:'open_add_score', reply:'Add Score window khol raha hoon.' },
  { pattern: /generate plan|plan banao|plan generate/i,
    action:'generate_plan', reply:'Master Planner chala raha hoon…' },
  // Focus mode
  { pattern: /focus mode|vfx band|animation band|calm mode/i,
    action:'focus_mode', reply:'Focus Mode toggle kiya. Zyada calm ab.' },
  { pattern: /export|data export|backup/i,
    action:'export_data', reply:'Aapka data download ho raha hai.' },
]

function tryQuickCommand(text: string): boolean {
  for (const cmd of QUICK_CMDS) {
    if (cmd.pattern.test(text)) {
      runAppCommand({ action: cmd.action, section: cmd.section, value: cmd.value })
      respond(cmd.reply)
      return true
    }
  }
  return false
}

// ── Clap calibration ──────────────────────────────────────────────────────────

async function startClapCalibration(): Promise<void> {
  const modal = document.createElement('div')
  modal.style.cssText =
    'position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(10px);'
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px;width:320px;text-align:center;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">
        👏 CLAP CALIBRATION
      </div>
      <div id="cal-msg" style="font-size:14px;color:var(--ink-soft);line-height:1.6;">
        Measuring ambient noise… please stay quiet.
      </div>
      <div id="cal-bar" style="height:6px;border-radius:3px;background:var(--line);overflow:hidden;">
        <div id="cal-fill" style="height:100%;background:var(--accent);width:0%;transition:width .1s;"></div>
      </div>
      <button id="cal-cancel" style="background:none;border:1px solid var(--line-2);border-radius:20px;
        color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:6px 16px;cursor:pointer;">
        Cancel
      </button>
    </div>
  `
  document.body.appendChild(modal)
  document.getElementById('cal-cancel')?.addEventListener('click', () => modal.remove())

  const msg  = document.getElementById('cal-msg')!
  const fill = document.getElementById('cal-fill')!

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx    = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const getRMS = () => {
      analyser.getByteFrequencyData(data)
      return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)
    }

    // Step 1: measure ambient (2s)
    let ambientSum = 0, ambientN = 0
    const ambientTimer = setInterval(() => {
      ambientSum += getRMS(); ambientN++
      fill.style.width = `${(ambientN / 20) * 100}%`
    }, 100)

    await new Promise(r => setTimeout(r, 2000))
    clearInterval(ambientTimer)
    const ambient = ambientSum / ambientN

    // Step 2: ask to clap
    msg.textContent = '👏 NOW CLAP TWICE — as you normally would to wake JARVIS!'
    fill.style.width = '0%'
    fill.style.background = 'var(--good)'

    let maxClap = ambient
    const clapTimer = setInterval(() => {
      const rms = getRMS()
      if (rms > maxClap) maxClap = rms
      fill.style.width = `${Math.min(((rms - ambient) / 80) * 100, 100)}%`
    }, 50)

    await new Promise(r => setTimeout(r, 3000))
    clearInterval(clapTimer)
    stream.getTracks().forEach(t => t.stop())
    ctx.close()

    // Set threshold halfway between ambient and max clap
    const threshold = ambient + (maxClap - ambient) * 0.45
    _clapThreshold = threshold
    localStorage.setItem('jarvis_clap_threshold', String(threshold))

    msg.innerHTML = `<b style="color:var(--good)">✓ Calibrated!</b><br>
      Ambient: ${ambient.toFixed(0)} · Clap peak: ${maxClap.toFixed(0)}<br>
      Threshold set to: ${threshold.toFixed(0)}<br><br>
      Double clap JARVIS now responds to your claps accurately.`
    fill.style.width = '100%'
    setTimeout(() => modal.remove(), 3000)
  } catch {
    msg.textContent = 'Microphone access needed for calibration.'
  }
}

async function processQuery(userText: string): Promise<void> {
  // Vision trigger detection
  if (isVisionTrigger(userText)) {
    addMessage('user', userText)
    setState('idle', 'Opening camera…')
    openVisionCapture(userText)
    return
  }

  // Quick command matching (instant, no AI needed)
  if (tryQuickCommand(userText)) {
    addMessage('user', userText)
    return
  }

  addMessage('user', userText)
  setState('thinking', 'Thinking…')

  if (!GROQ_KEY) {
    const reply = handleOffline(userText)
    respond(reply)
    return
  }

  try {
    const systemPrompt = buildSystemPrompt()
    const messages = [
      { role: 'system', content: systemPrompt },
      ..._history.map(m => ({ role: m.role, content: m.content })),
    ]

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: 350,
        temperature: 0.7,
        stream: false,
      }),
    })

    if (!res.ok) throw new Error(`Groq API error ${res.status}`)
    const data = await res.json() as { choices: { message: { content: string } }[] }
    const reply = data.choices[0].message.content.trim()

    // Execute any app commands embedded in the reply
    const cleanReply = executeCommands(reply)
    respond(cleanReply)
  } catch (e) {
    console.error('[JARVIS]', e)
    respond("I encountered an issue connecting to my brain. Please check your API key or try again.")
  }
}

// ── Vision: "See this / Scan / Dekho" ────────────────────────────────────────

const VISION_TRIGGERS = ['see this','scan','dekho','dekhо','yeh dekho','image','photo',
  'picture','scan karo','analyze this','analyse','padhо','padho yeh','evaluate this',
  'check this','is mein kya hai','batao kya hai']

export function isVisionTrigger(text: string): boolean {
  const t = text.toLowerCase()
  return VISION_TRIGGERS.some(kw => t.includes(kw))
}

export function openVisionCapture(context: string): void {
  if (document.getElementById('jarvis-vision-modal')) return

  const modal = document.createElement('div')
  modal.id = 'jarvis-vision-modal'
  modal.style.cssText =
    'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.9);backdrop-filter:blur(8px);'

  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:24px;width:340px;display:flex;flex-direction:column;gap:16px;text-align:center;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;
        color:var(--accent);text-transform:uppercase;">⬡ JARVIS Vision Scan</div>
      <div style="font-size:14px;color:var(--ink-soft);">
        Show me what you want analyzed — question paper, notes, diagram, newspaper, anything.
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button id="jv-camera" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);
          border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;
          transition:border-color .15s;" onmouseover="this.style.borderColor='var(--accent)'"
          onmouseout="this.style.borderColor='var(--line-2)'">
          📷 Use Camera (take photo)
        </button>
        <button id="jv-upload" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);
          border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;
          transition:border-color .15s;" onmouseover="this.style.borderColor='var(--accent)'"
          onmouseout="this.style.borderColor='var(--line-2)'">
          📁 Upload Image / PDF screenshot
        </button>
        <input id="jv-file-inp" type="file" accept="image/*" style="display:none" />
      </div>
      <div id="jv-preview" style="display:none;"></div>
      <button id="jv-cancel" style="background:none;border:none;color:var(--muted);
        font-family:var(--font-mono);font-size:11px;cursor:pointer;letter-spacing:.1em;">
        CANCEL
      </button>
    </div>
  `
  document.body.appendChild(modal)

  const fileInp = document.getElementById('jv-file-inp') as HTMLInputElement

  // Upload from file
  document.getElementById('jv-upload')?.addEventListener('click', () => fileInp.click())
  fileInp.addEventListener('change', () => {
    const file = fileInp.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      closeVisionModal()
      analyzeImage(base64, context)
    }
    reader.readAsDataURL(file)
  })

  // Take photo from camera
  document.getElementById('jv-camera')?.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      const video = document.createElement('video')
      video.srcObject = stream
      video.setAttribute('playsinline', '')
      await video.play()

      // Small preview + capture button
      const preview = document.getElementById('jv-preview')!
      preview.style.display = 'block'
      preview.innerHTML = ''
      video.style.cssText = 'width:100%;border-radius:8px;max-height:200px;object-fit:cover;'
      preview.appendChild(video)

      const snapBtn = document.createElement('button')
      snapBtn.textContent = '📸 Capture'
      snapBtn.style.cssText = 'width:100%;padding:10px;margin-top:8px;background:var(--accent);' +
        'color:#000;border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer;font-size:14px;'
      preview.appendChild(snapBtn)

      snapBtn.addEventListener('click', () => {
        const canvas = document.createElement('canvas')
        canvas.width  = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d')!.drawImage(video, 0, 0)
        stream.getTracks().forEach(t => t.stop())
        const base64 = canvas.toDataURL('image/jpeg', 0.85)
        closeVisionModal()
        analyzeImage(base64, context)
      })
    } catch {
      alert('Camera not accessible. Please upload an image instead.')
    }
  })

  document.getElementById('jv-cancel')?.addEventListener('click', closeVisionModal)
  modal.addEventListener('click', e => { if (e.target === modal) closeVisionModal() })
}

function closeVisionModal(): void {
  document.getElementById('jarvis-vision-modal')?.remove()
}

async function analyzeImage(base64: string, userContext: string): Promise<void> {
  if (!GROQ_KEY) { respond('Add VITE_GROQ_API_KEY to enable vision scanning.'); return }

  setState('thinking', 'Scanning… / स्कैन हो रहा है…')

  const cs = getCurrentState()
  const sysCtx = `You are JARVIS, the AI assistant for Om Shisodiya's UPSC CSE 2028 preparation.
Today's subject: ${cs?.today.subject ?? 'Unknown'}. Backlog: ${cs?.backlogRemaining ?? '?'} lectures.
Analyze the image carefully. For UPSC context:
- If it's a question paper: identify the topic, explain the question, provide a model answer.
- If it's handwritten notes: summarize and suggest improvements.
- If it's a newspaper: extract key UPSC-relevant points and link to syllabus.
- If it's a diagram/chart/map: explain it in UPSC context.
- If it's a Mains answer: give structured feedback (intro, content, examples, conclusion).
Respond in the same language as the user's context (Hindi/Hinglish/English).`

  try {
    const res = await fetch(GROQ_URL.replace('/chat/completions', '/chat/completions'), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',  // Llama 4 with vision
        messages: [{
          role: 'user',
          content: [
            { type: 'text',      text: `${sysCtx}\n\nUser says: "${userContext || 'Analyze this image'}"` },
            { type: 'image_url', image_url: { url: base64 } },
          ],
        }],
        max_tokens: 600,
        temperature: 0.6,
      }),
    })
    if (!res.ok) throw new Error(`Vision API error ${res.status}`)
    const data = await res.json() as { choices: { message: { content: string } }[] }
    const reply = data.choices[0].message.content.trim()

    // Show image thumbnail in chat
    addMessage('user', `[Image: ${userContext || 'Scan this'}]`)
    const cleanReply = executeCommands(reply)
    respond(cleanReply)
  } catch (e) {
    console.error('[JARVIS vision]', e)
    respond('Image scan failed. Please try again or describe what you see.')
  }
}

// ── Dynamic DOM discovery + action ────────────────────────────────────────────

/** Build a snapshot of all interactive elements on the page for the AI. */
function buildDOMMap(): string {
  const items: string[] = []
  const seen = new Set<string>()

  document.querySelectorAll(
    'button:not([style*="display:none"]):not([style*="display: none"]), ' +
    'a[href], input[type="button"], [data-act], select'
  ).forEach(el => {
    const id   = el.id ? `#${el.id}` : ''
    const text = el.textContent?.trim().replace(/\s+/g,' ').slice(0, 40) ?? ''
    const tag  = el.tagName.toLowerCase()
    const key  = `${tag}${id}${text}`
    if (!seen.has(key) && (id || text)) {
      seen.add(key)
      items.push(`${tag}${id}${text ? ` "${text}"` : ''}`)
    }
  })
  return items.slice(0, 60).join('\n')
}

/** Execute a dynamic action from AI: <ACT>selector|action|value</ACT> */
function executeDynamicAction(actStr: string): void {
  try {
    const [selector, action, value] = actStr.split('|').map(s => s.trim())
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) { console.warn('[JARVIS ACT] element not found:', selector); return }

    switch (action) {
      case 'click':   el.click(); break
      case 'scroll':  el.scrollIntoView({ behavior: 'smooth', block: 'center' }); break
      case 'fill':
        if ((el as HTMLInputElement).value !== undefined) {
          (el as HTMLInputElement).value = value ?? ''
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        break
      case 'focus':   el.focus(); break
      case 'select':
        if ((el as HTMLSelectElement).options) {
          (el as HTMLSelectElement).value = value ?? ''
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        break
    }
  } catch (e) { console.error('[JARVIS ACT]', e) }
}

function buildSystemPrompt(): string {
  const cs   = getCurrentState()
  const date = todayIST()
  const parts: string[] = [
    `You are JARVIS — the highly intelligent AI assistant built into Mission 2028, the personal UPSC CSE 2028 command center of Om Shisodiya, an IAS aspirant preparing for CSE 2028 with PW IAS Prarambh 2027 batch.`,
    ``,
    `LIVE PREP DATA (as of ${date}):`,
    cs ? [
      `• Today's subject: ${cs.today.subject} (${cs.today.dayType})`,
      `• Today's topic: ${cs.today.topicLabel}`,
      `• Target: ${cs.today.targetQuestions} MCQs, ${cs.today.mainsTarget} Mains answer`,
      `• Backlog: ${cs.backlogRemaining} lectures remaining`,
      `• Streak: ${cs.streak} days`,
      `• Prelims avg accuracy: ${cs.performance.prelimsAvg?.toFixed(1) ?? '--'}%`,
      `• Optional avg: ${cs.performance.optionalAvg?.toFixed(1) ?? '--'}%`,
      `• Selection Probability: ${cs.selectionProbabilityPct?.toFixed(1) ?? '--'}%`,
      `• Rank projection: ${cs.rankProjection} (${cs.approxRank})`,
      `• Hours studied today: ${cs.hours.today.toFixed(1)}h`,
      `• Total tests taken: ${cs.cumulative.testsTaken}`,
    ].join('\n') : '(data loading)',
    ``,
    `YOUR CAPABILITIES — you can help Om with ABSOLUTELY ANYTHING:`,
    `1. UPSC CONTENT: Explain any topic from Polity, History, Geography, Economy, Environment, Science, Art & Culture, IR, Ethics, Essay`,
    `2. CONSTITUTION: Explain any Article, Schedule, or Part in detail with case laws and examples`,
    `3. MCQ GENERATION: Generate practice questions with options and explanations for any subject`,
    `4. ANSWER WRITING: Review and give detailed feedback on Mains answers (structure, content, examples, diagrams)`,
    `5. CURRENT AFFAIRS: Discuss any recent event and link it to UPSC syllabus`,
    `6. STUDY PLANNING: Suggest what to prioritize based on his backlog and exam timeline`,
    `7. MOTIVATION: Give honest, supportive assessment of his progress`,
    `8. GENERAL KNOWLEDGE: Answer any factual question`,
    `9. MATHEMATICS: Help with CSAT quant, reasoning, data interpretation`,
    `10. ESSAY WRITING: Help brainstorm, outline, and write UPSC essays`,
    ``,
    `APP CONTROL — embed commands: <CMD>{"action":"ACTION","section":"...","value":"..."}</CMD>`,
    `Timer: start_timer | stop_timer | reset_timer | skip_timer`,
    `Navigation: scroll_to (section: engine|intel|routine|constitution|plan|hero) | open_menu | close_menu | go_home`,
    `Lock: lock_screen`,
    `Planner: skip_today | reset_today | filter_today | filter_backlog | filter_all | filter_done | open_import | add_lecture | generate_plan`,
    `Logs: open_add_score | open_ca_log | open_answer_log`,
    `Settings: open_settings | focus_mode | export_data`,
    `Routine: set_day_type (value: College|Holiday|Leave|Test Day)`,
    `Constitution: show_constitution`,
    `Always embed command + explain what you're doing. Example:`,
    `"Chalo Om, aapka focus timer shuru karte hain! <CMD>{"action":"start_timer"}</CMD>"`,
    ``,
    `DYNAMIC PAGE CONTROL — you can act on ANY element:`,
    `Use <ACT>CSS_SELECTOR|action|value</ACT> where action = click|scroll|fill|select|focus`,
    `Examples:`,
    `  <ACT>#lp-import|click</ACT>  — opens Import Excel`,
    `  <ACT>#rtn-day-type|select|Holiday</ACT>  — sets day type`,
    `  <ACT>#jarvis-text|fill|Economics notes</ACT>  — fills input`,
    `  <ACT>.lp-filter[data-f="today"]|click</ACT>  — switches to Today filter`,
    `Current interactive elements on page:`,
    buildDOMMap(),
    ``,
    `VISION — when user says "see this/scan/dekho/analyze image": you will receive image content.`,
    `Analyze it in UPSC context: question papers, notes, diagrams, newspapers, Mains answers.`,
    ``,
    `LANGUAGE — CRITICAL RULE:`,
    `• Detect the language Om uses in his message.`,
    `• If Hindi (Devanagari): reply fully in Hindi.`,
    `• If Hinglish (Roman Hindi mix): reply in Hinglish.`,
    `• If English: reply in English.`,
    `• Match his energy and language EXACTLY. Never switch language unless he does.`,
    `• For UPSC terms (like 'Article', 'Directive Principles'), keep them in English even in Hindi responses.`,
    ``,
    `VOICE OUTPUT RULES — you are SPEAKING out loud, not writing:`,
    `No markdown, no bold, no bullet points, no numbered lists, no dashes.`,
    `Keep it short and conversational. 1-2 sentences for quick queries.`,
    `For explanations use flowing natural speech, not lists.`,
    `Say what you are doing BEFORE embedding commands.`,
    ``,
    `PERSONALITY: You are JARVIS — confident, warm, human. Address him as "Om". Sound like a knowledgeable friend, not a robot. Never say you cannot help.`,
  ]
  return parts.filter(Boolean).join('\n')
}

// ── App command execution ─────────────────────────────────────────────────────

function executeCommands(reply: string): string {
  // Parse <CMD>{"action":"..."}</CMD> — structured commands
  const cmdRegex = /<CMD>(.*?)<\/CMD>/g
  // Parse <ACT>selector|action|value</ACT> — dynamic DOM actions
  const actRegex = /<ACT>(.*?)<\/ACT>/g

  let clean = reply.replace(cmdRegex, '').replace(actRegex, '').trim()

  for (const m of [...reply.matchAll(cmdRegex)]) {
    try { runAppCommand(JSON.parse(m[1]) as { action: string; section?: string; value?: string }) } catch { /* ignore */ }
  }
  for (const m of [...reply.matchAll(actRegex)]) {
    executeDynamicAction(m[1])
  }
  return clean
}

function runAppCommand(cmd: { action: string; section?: string; value?: string }): void {
  const click = (id: string) => document.getElementById(id)?.click()
  const q     = (sel: string) => document.querySelector<HTMLElement>(sel)?.click()

  switch (cmd.action) {
    // ── Focus timer ──────────────────────────────────────────────────────────
    case 'start_timer':
    case 'stop_timer':
    case 'pause_timer':    q('[data-act="start"]'); break
    case 'reset_timer':    q('[data-act="reset"]'); break
    case 'skip_timer':     q('[data-act="skip"]'); break

    // ── Navigation ───────────────────────────────────────────────────────────
    case 'scroll_to':
      document.getElementById(cmd.section ?? '')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break
    case 'open_menu':
      // Simulate tap on the emblem stamp to open command menu
      document.getElementById('emblem-stamp')?.click(); break
    case 'close_menu':
      document.getElementById('menu-backdrop')?.click(); break
    case 'go_home':
      document.getElementById('hero')?.scrollIntoView({ behavior: 'smooth' }); break

    // ── Screen lock ──────────────────────────────────────────────────────────
    case 'lock_screen':    click('lock-btn'); break

    // ── Planner ──────────────────────────────────────────────────────────────
    case 'skip_today':     click('lp-skip-day'); break
    case 'reset_today':    click('lp-skip-day'); break  // toggles back
    case 'filter_today':   q('.lp-filter[data-f="today"]'); break
    case 'filter_backlog': q('.lp-filter[data-f="backlog"]'); break
    case 'filter_all':     q('.lp-filter[data-f="all"]'); break
    case 'filter_done':    q('.lp-filter[data-f="done"]'); break
    case 'open_import':    click('lp-import'); break
    case 'add_lecture':    click('lp-add'); break

    // ── Generate plan ────────────────────────────────────────────────────────
    case 'generate_plan':  click('ai-gen'); break
    case 'open_settings':  click('ai-settings-btn'); break

    // ── Scores & logs ────────────────────────────────────────────────────────
    case 'open_add_score': click('cm-add-score'); break
    case 'open_ca_log':    click('ca-add-btn'); break
    case 'open_answer_log':click('al-add-btn'); break

    // ── Focus mode ───────────────────────────────────────────────────────────
    case 'focus_mode':
    case 'toggle_focus':   click('focus-mode-btn'); break

    // ── Export ───────────────────────────────────────────────────────────────
    case 'export_data':    click('cm-export-btn'); break

    // ── Routine day type ─────────────────────────────────────────────────────
    case 'set_day_type': {
      const sel = document.getElementById('rtn-day-type') as HTMLSelectElement | null
      if (sel && cmd.value) {
        sel.value = cmd.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      break
    }

    // ── Constitution (scroll to) ─────────────────────────────────────────────
    case 'show_constitution':
      document.getElementById('constitution')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break
  }
}

// ── Offline fallback (no API key) ─────────────────────────────────────────────

function handleOffline(q: string): string {
  const ql = q.toLowerCase()
  const cs = getCurrentState()
  if (ql.includes('streak'))   return `Your current streak is ${cs?.streak ?? 0} days. Keep going!`
  if (ql.includes('backlog'))  return `You have ${cs?.backlogRemaining ?? '?'} lectures remaining in your backlog.`
  if (ql.includes('subject') || ql.includes('today')) return `Today's subject is ${cs?.today.subject ?? 'Unknown'}. Topic: ${cs?.today.topicLabel ?? '?'}.`
  if (ql.includes('target'))  return `Today's target: ${cs?.today.targetQuestions ?? 20} MCQs and ${cs?.today.mainsTarget ?? 1} Mains answer.`
  if (ql.includes('timer'))   return `Starting your focus timer now.`
  return `Add your Groq API key (VITE_GROQ_API_KEY) to unlock full AI capabilities. I can still answer basic prep questions!`
}

// ── Voice output ──────────────────────────────────────────────────────────────

let _isSpeaking = false   // guard: stop recognition while speaking

/** Make text sound more natural by adding breathing pauses at logical points. */
function humanise(text: string): string {
  return text
    // Add pause after sentence-ending punctuation
    .replace(/([.!?])\s+/g, '$1  ')
    // Add slight pause after commas (already there, just ensure spacing)
    .replace(/,\s*/g, ',  ')
    // Remove markdown bold/italic that sounds robotic
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/_{1,2}(.*?)_{1,2}/g, '$1')
    // Remove backticks
    .replace(/`(.*?)`/g, '$1')
    .trim()
}

function speak(text: string): void {
  _synth.cancel()
  if (!_voices.length) loadVoices()
  const isHindi = /[ऀ-ॿ]/.test(text)
  const processed = humanise(text)

  // Split into sentences for more natural chunked delivery (avoids robotic monotone)
  const chunks = processed
    .split(/(?<=[.!?।])\s+/)
    .filter(s => s.trim().length > 0)
    .slice(0, 8)   // max 8 chunks to avoid timeout

  if (chunks.length === 0) return

  let idx = 0
  _isSpeaking = true
  _recognition?.stop(); _recognition = null
  setState('speaking', isHindi ? 'बोल रहा हूँ…' : 'Speaking…')

  function sayNext(): void {
    if (idx >= chunks.length) {
      _isSpeaking = false
      setState('idle', 'Jarvis बोलें या type करें | Ready')
      setTimeout(() => { if (!_wakeActive) startWakeWordListener() }, 800)
      return
    }
    const utt = new SpeechSynthesisUtterance(chunks[idx++])
    utt.volume = 1
    utt.lang   = isHindi ? 'hi-IN' : 'en-IN'

    // Humanoid voice settings — key: DON'T change pitch artificially
    // Let the selected voice's natural pitch do the work
    if (_voiceGender === 'female') {
      utt.rate  = 0.92   // slightly slower = more natural, less robotic
      utt.pitch = 1.0    // neutral — let the voice's own pitch be natural
    } else {
      utt.rate  = 0.88   // calm, measured pace
      utt.pitch = 1.0    // neutral — deeper voices don't need pitch lowering
    }

    // Voice selection: prioritize Hindi voice for Hindi, else use best available
    if (isHindi) {
      const hiVoice = _voices.find(v => v.lang === 'hi-IN' && /online|natural/i.test(v.name))
                   ?? _voices.find(v => v.lang === 'hi-IN')
      if (hiVoice) utt.voice = hiVoice
      else if (_selectedVoice) utt.voice = _selectedVoice
    } else {
      if (_selectedVoice) utt.voice = _selectedVoice
    }

    utt.onend   = sayNext
    utt.onerror = sayNext   // skip chunk on error, don't freeze
    _synth.speak(utt)
  }

  sayNext()
}

// ── Greeting ──────────────────────────────────────────────────────────────────

function greet(): void {
  const cs   = getCurrentState()
  const hour = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })
  const h    = parseInt(hour)
  const tod  = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  const subj = cs?.today.subject ?? 'today\'s subjects'
  const msg  = `Good ${tod}, Om. Today is ${subj} day. You have ${cs?.backlogRemaining ?? '?'} lectures remaining. How can I help?`
  respond(msg)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function respond(text: string): void {
  addMessage('assistant', text)
  setState('speaking', 'Speaking…')
  speak(text)
}

function addMessage(role: 'user' | 'assistant', content: string): void {
  _history.push({ role, content })
  // Keep last 10 messages to control context length
  if (_history.length > 10) _history = _history.slice(-10)
  renderHistory()
}

function renderHistory(): void {
  const el = document.getElementById('j-history')
  if (!el) return
  el.innerHTML = _history.map(m => `
    <div class="jmsg ${m.role}">
      <div class="jmsg-label">${m.role === 'user' ? 'You' : 'JARVIS'}</div>
      <div class="jmsg-bubble">${esc(m.content)}</div>
    </div>`).join('')
  el.scrollTop = el.scrollHeight
}

function setState(s: JState, statusText: string): void {
  _state = s
  const el = document.getElementById('j-status')
  if (el) el.textContent = statusText
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpeech = any
