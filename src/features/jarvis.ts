/**
 * jarvis.ts — Mission: JARVIS
 * Voice-activated AI assistant for UPSC prep.
 * - Voice input:  Web Speech API (free, built-in)
 * - AI brain:     Groq API free tier — Llama 3.3 70B (VITE_GROQ_API_KEY)
 * - Voice output: Web Speech Synthesis API (free, built-in)
 * - Animation:    Canvas arc-reactor + real mic waveform
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

function startAnimation(): void {
  cancelAnimationFrame(_rafId)
  const W = _canvas!.width  / devicePixelRatio
  const H = _canvas!.height / devicePixelRatio
  const cx = W / 2, cy = H / 2
  let t = 0

  // Frequency data buffer for waveform
  const fftSize = 64
  const dataArr = new Uint8Array(fftSize)

  function frame(): void {
    _rafId = requestAnimationFrame(frame)
    const c = _ctx!
    c.clearRect(0, 0, W, H)
    t += 0.016

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f0b54a'
    const accentRgb = hexToRgb(accent) ?? { r: 240, g: 181, b: 74 }

    if (_analyser && (_state === 'listening' || _state === 'speaking')) {
      _analyser.getByteFrequencyData(dataArr)
    }

    // ── Arc reactor rings ──────────────────────────────────────────────────
    const rings = [
      { r: 18, speed: 0.8,  opacity: 0.9, width: 2.5 },
      { r: 32, speed: -0.5, opacity: 0.5, width: 1.5 },
      { r: 46, speed: 1.2,  opacity: 0.3, width: 1 },
      { r: 62, speed: -0.3, opacity: 0.2, width: 1 },
    ]

    const pulseScale = _state === 'idle'
      ? 1 + Math.sin(t * 1.5) * 0.04
      : _state === 'thinking'
        ? 1 + Math.sin(t * 4) * 0.06
        : 1

    rings.forEach(({ r, speed, opacity, width }) => {
      const angle = t * speed
      const pr = r * pulseScale
      c.save()
      c.translate(cx, cy)
      c.rotate(angle)
      // Dashed ring
      c.beginPath()
      c.arc(0, 0, pr, 0, Math.PI * 2)
      c.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${opacity})`
      c.lineWidth = width
      if (_state === 'thinking') c.setLineDash([6, 8])
      else c.setLineDash([])
      c.stroke()
      // Bright dot on ring
      c.beginPath()
      c.arc(pr, 0, width * 1.8, 0, Math.PI * 2)
      c.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${opacity * 1.5})`
      c.fill()
      c.restore()
    })

    // ── Centre glow ────────────────────────────────────────────────────────
    const glowR = _state === 'listening' ? 10 + Math.sin(t * 6) * 4 : 8
    const grad = c.createRadialGradient(cx, cy, 0, cx, cy, glowR * 3)
    grad.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},.7)`)
    grad.addColorStop(1, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0)`)
    c.beginPath(); c.arc(cx, cy, glowR * 3, 0, Math.PI * 2)
    c.fillStyle = grad; c.fill()

    // ── Waveform bars (listening / speaking) ───────────────────────────────
    if (_state === 'listening' || _state === 'speaking') {
      const barCount = 32
      const barW     = 3
      const radius   = 72
      for (let i = 0; i < barCount; i++) {
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2
        const freqIdx = Math.floor((i / barCount) * (fftSize / 2))
        let amp = dataArr[freqIdx] / 255

        if (_state === 'speaking') {
          // Simulate speaking waveform
          amp = 0.3 + Math.sin(t * 8 + i * 0.5) * 0.25 + Math.sin(t * 13 + i) * 0.15
          amp = Math.max(0, Math.min(1, amp))
        }

        const barH = Math.max(4, amp * 28)
        const x1   = cx + Math.cos(angle) * radius
        const y1   = cy + Math.sin(angle) * radius
        const x2   = cx + Math.cos(angle) * (radius + barH)
        const y2   = cy + Math.sin(angle) * (radius + barH)
        c.beginPath()
        c.moveTo(x1, y1); c.lineTo(x2, y2)
        c.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.4 + amp * 0.6})`
        c.lineWidth = barW
        c.lineCap = 'round'
        c.stroke()
      }
    }
  }
  frame()
}

// ── Voice input ───────────────────────────────────────────────────────────────

async function startListening(): Promise<void> {
  if (_state === 'listening') return
  setState('listening', 'Listening…')

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
  if (!SR) { speak("Speech recognition isn't supported in this browser. Please type your question."); setState('idle', 'Type to ask'); return }

  _recognition = new SR()
  _recognition.lang = 'en-IN'
  _recognition.interimResults = false
  _recognition.maxAlternatives = 1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _recognition.onresult = (e: any) => {
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

function buildSystemPrompt(): string {
  const cs   = getCurrentState()
  const date = todayIST()
  const parts: string[] = [
    `You are JARVIS — the AI assistant built into Mission 2028, Om Shisodiya's personal UPSC CSE 2028 command center.`,
    `Today: ${date}. Subject: ${cs?.today.subject ?? 'Unknown'}.`,
    cs ? `Backlog: ${cs.backlogRemaining} lectures. Streak: ${cs.streak} days. SP: ${cs.selectionProbabilityPct?.toFixed(1) ?? '--'}%. Rank: ${cs.rankProjection}.` : '',
    cs?.performance.prelimsAvg != null ? `Prelims avg accuracy: ${cs.performance.prelimsAvg.toFixed(1)}%.` : '',
    ``,
    `You help Om with UPSC preparation: topic explanations, MCQ generation, answer feedback, current affairs, study planning.`,
    `Address him as "Om". Be concise (2-3 sentences for quick questions; detailed for explanations). Be motivating.`,
    ``,
    `To control the app embed a JSON tag: <CMD>{"action":"ACTION"}</CMD>`,
    `Actions: start_timer | stop_timer | lock_screen | skip_today | open_add_score | open_settings | scroll_to:section`,
    `Sections: engine | intel | routine | constitution | plan`,
    `Example: "Starting your focus timer now. <CMD>{"action":"start_timer"}</CMD>"`,
  ]
  return parts.filter(Boolean).join('\n')
}

// ── App command execution ─────────────────────────────────────────────────────

function executeCommands(reply: string): string {
  const cmdRegex = /<CMD>(.*?)<\/CMD>/g
  const clean = reply.replace(cmdRegex, '').trim()

  const matches = [...reply.matchAll(cmdRegex)]
  for (const m of matches) {
    try {
      const cmd = JSON.parse(m[1]) as { action: string; section?: string }
      runAppCommand(cmd)
    } catch { /* invalid JSON */ }
  }
  return clean
}

function runAppCommand(cmd: { action: string; section?: string }): void {
  switch (cmd.action) {
    case 'start_timer':
      (document.querySelector<HTMLButtonElement>('[data-act="start"]'))?.click(); break
    case 'stop_timer':
    case 'pause_timer':
      (document.querySelector<HTMLButtonElement>('[data-act="start"]'))?.click(); break
    case 'lock_screen':
      document.getElementById('lock-btn')?.click(); break
    case 'skip_today':
      document.getElementById('lp-skip-day')?.click(); break
    case 'open_add_score':
      document.getElementById('cm-add-score')?.click(); break
    case 'open_settings':
      document.getElementById('ai-settings-btn')?.click(); break
    case 'scroll_to':
      document.getElementById(cmd.section ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break
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
  utt.rate  = 1.05
  utt.pitch = 0.95
  utt.volume = 1
  // Prefer a calm, English (India) voice
  const voices = _synth.getVoices()
  const preferred = voices.find(v => v.lang === 'en-IN') ?? voices.find(v => v.lang.startsWith('en'))
  if (preferred) utt.voice = preferred
  utt.onstart = () => setState('speaking', 'Speaking…')
  utt.onend   = () => setState('idle', 'Ready — say something or type')
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
