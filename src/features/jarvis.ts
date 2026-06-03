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

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined

// ── Public init ───────────────────────────────────────────────────────────────

export function initJarvis(): void {
  if (document.getElementById('jarvis-btn')) return

  const btn = document.createElement('button')
  btn.id = 'jarvis-btn'
  btn.title = 'Mission JARVIS — AI Assistant (hold J or click)'
  btn.innerHTML = `<span class="jb-icon">J</span>`
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

  // Calibration: compute ambient noise floor over first 2 seconds
  let ambient = 0
  let calibSamples = 0
  const THRESHOLD_ABOVE_AMBIENT = 55  // clap must be this many units louder than ambient
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

    if (rms > ambient + THRESHOLD_ABOVE_AMBIENT) {
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
  // Visual flash on the J button
  const btn = document.getElementById('jarvis-btn')
  btn?.classList.add('listening')
  setTimeout(() => btn?.classList.remove('listening'), 600)

  if (!_open) {
    openPanel()
    setTimeout(() => startListening(), 700)
  } else {
    startListening()
  }
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

      if (transcript.includes('jarvis') || transcript.includes('jarvis')) {
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
      <button class="jarvis-close" id="j-close">×</button>
    </div>
    <div class="jarvis-vis">
      <canvas id="jarvis-canvas"></canvas>
      <div class="jarvis-status-text" id="j-status">Ready — tap mic or type</div>
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
  const W = _canvas!.width  / devicePixelRatio
  const H = _canvas!.height / devicePixelRatio
  let t = 0
  const fft = new Uint8Array(128)

  function frame(): void {
    _rafId = requestAnimationFrame(frame)
    const c = _ctx!
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
  if (_state === 'listening') return
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

  _recognition = new SR()
  // Recognize Hindi + English + Hinglish — 'hi-IN' catches Devanagari and often Hinglish too
  _recognition.lang = 'hi-IN'
  _recognition.interimResults = false
  _recognition.maxAlternatives = 3  // try multiple interpretations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _recognition.onresult = (e: any) => {
    // Pick best transcript across alternatives
    const text: string = e.results[0][0].transcript
    stopListening()
    processQuery(text)
  }
  _recognition.onerror = () => { stopListening(); setState('idle', 'Ready') }
  _recognition.onend   = () => { if (_state === 'listening') setState('idle', 'Ready') }
  _recognition.start()

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

async function processQuery(userText: string): Promise<void> {
  // Vision trigger detection
  if (isVisionTrigger(userText)) {
    addMessage('user', userText)
    setState('idle', 'Opening camera…')
    openVisionCapture(userText)
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
    `PERSONALITY: You are JARVIS — highly capable, concise, motivating. Address him as "Om" or "Commander". Never say "I can't" or "I don't know" — always find a way. You are his personal UPSC tutor, strategist, assistant, and command center — all in one.`,
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

function speak(text: string): void {
  _synth.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate   = 1.05
  utt.pitch  = 0.95
  utt.volume = 1

  const voices = _synth.getVoices()

  // Detect language from content (Hindi Devanagari chars in Unicode range)
  const isHindi = /[ऀ-ॿ]/.test(text)
  if (isHindi) {
    utt.lang = 'hi-IN'
    const hiVoice = voices.find(v => v.lang === 'hi-IN')
    if (hiVoice) utt.voice = hiVoice
  } else {
    utt.lang = 'en-IN'
    const enVoice = voices.find(v => v.lang === 'en-IN') ?? voices.find(v => v.lang.startsWith('en'))
    if (enVoice) utt.voice = enVoice
  }

  utt.onstart = () => setState('speaking', isHindi ? 'बोल रहा हूँ…' : 'Speaking…')
  utt.onend   = () => setState('idle', 'Ready — Jarvis बोलें या type करें')
  _synth.speak(utt)
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
