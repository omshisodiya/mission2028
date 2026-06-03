/**
 * va-overlay.ts — Siri-style full-screen aurora + waveform voice overlay
 *
 * Uses  data-va-state  on <body> (namespaced to avoid conflicts).
 * Wire-up from jarvis.ts:
 *   VA.setState('listening')  — mic starts
 *   VA.setState('thinking')   — STT received / panel open
 *   VA.setState('speaking')   — TTS starts
 *   VA.setState('idle')       — dismissed / panel closed
 *   VA.setAmplitude(0..1)     — called every rAF from AnalyserNode
 *   VA.setTranscript(t,final) — STT text + TTS reply
 */
import './va-overlay.css'

export type VAState = 'idle' | 'listening' | 'thinking' | 'speaking'

const LABELS: Record<VAState, string> = {
  idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking',
}

// ── Internal state ────────────────────────────────────────────────────────────
let _amp       = 0
let _ampTarget = 0
let _rot       = 0
let _t         = 0
let _lastPeak  = 0
let _ripples: Array<{ r: number; a: number }> = []
let _cvRef: HTMLCanvasElement | null = null  // cached canvas — avoid per-frame DOM lookup
let _ctxRef: CanvasRenderingContext2D | null = null
let _dpr = 1

// ── Public VA API ─────────────────────────────────────────────────────────────
export const VA = {

  setState(s: VAState): void {
    document.body.dataset.vaState = s   // triggers CSS transitions
    const lbl = document.getElementById('va-state-text')
    if (lbl) lbl.textContent = LABELS[s]
    if (s === 'idle') {
      _ampTarget = 0
      this.setTranscript('', true)
    }
    document.dispatchEvent(new CustomEvent('va:state', { detail: s }))
  },

  setAmplitude(v: number): void {
    _ampTarget = Math.max(0, Math.min(1, v))
  },

  setTranscript(text: string, isFinal: boolean): void {
    const el = document.getElementById('va-transcript')
    if (!el) return
    el.innerHTML = text
      ? text + (isFinal ? '' : '<span class="caret"></span>')
      : ''
  },

  get state(): VAState {
    return (document.body.dataset.vaState as VAState) ?? 'idle'
  },
}

// ── DOM mount (called once from initJarvis) ───────────────────────────────────
export function initVAOverlay(): void {
  if (document.getElementById('va-overlay')) return  // guard: already mounted

  // 1. Page dim (behind overlay, above page content)
  const dim = document.createElement('div')
  dim.className = 'va-page-dim'
  document.body.appendChild(dim)

  // 2. Overlay shell: aurora ribbons + conic glow + rim
  const shell = document.createElement('div')
  shell.id = 'va-overlay'
  shell.setAttribute('aria-live', 'assertive')
  shell.setAttribute('aria-atomic', 'true')
  shell.innerHTML = `
    <div class="va-aurora">
      <span class="r1"></span><span class="r2"></span>
      <span class="r3"></span><span class="r4"></span><span class="r5"></span>
    </div>
    <div class="va-glow" id="va-glow"></div>
    <div class="va-rim"></div>`
  document.body.appendChild(shell)

  // 3. Circular waveform canvas (centred, z-index 402)
  const ring = document.createElement('div')
  ring.className = 'va-ring'
  const cv = document.createElement('canvas')
  ring.appendChild(cv)
  document.body.appendChild(ring)
  _cvRef = cv

  // 4. Bottom dock: state label + large transcript
  const dock = document.createElement('div')
  dock.className = 'va-dock'
  dock.innerHTML = `
    <span class="va-state-label">
      <span class="dot"></span>
      <span id="va-state-text"></span>
    </span>
    <div class="va-transcript" id="va-transcript"></div>`
  document.body.appendChild(dock)

  // 5. Init canvas size + get context
  _resizeCv()
  _ctxRef = cv.getContext('2d')

  // 6. Re-size on window resize
  window.addEventListener('resize', _resizeCv)

  // 7. Start rAF loop (unless reduced motion)
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) _startRaf()

  // 8. Expose globally for any legacy inline script
  ;(window as Window & { VA?: typeof VA }).VA = VA

  // 9. Default state
  VA.setState('idle')
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────
function _resizeCv(): void {
  if (!_cvRef) return
  _dpr = Math.min(2, devicePixelRatio || 1)
  _cvRef.width  = 340 * _dpr
  _cvRef.height = 340 * _dpr
}

// ── rAF animation loop ────────────────────────────────────────────────────────
const BARS  = 88
const PHASE = Array.from({ length: BARS }, (_, i) => i * 0.4)

function _startRaf(): void {
  function frame() {
    requestAnimationFrame(frame)
    _t += 0.016

    // Smooth amplitude toward target
    _amp += (_ampTarget - _amp) * 0.12
    document.documentElement.style.setProperty('--amp', _amp.toFixed(3))

    // Rotate the conic glow — speed depends on state
    const st = VA.state
    const spd = st === 'thinking' ? 1.4 : st === 'speaking' ? 0.9 : st === 'listening' ? 0.55 : 0.20
    _rot = (_rot + spd) % 360
    const glow = document.getElementById('va-glow')
    if (glow) glow.style.setProperty('--rot', `${_rot}deg`)

    // Draw radial waveform
    _drawRing(st)
  }
  frame()
}

// ── Waveform renderer ─────────────────────────────────────────────────────────
function _drawRing(st: VAState): void {
  const cv  = _cvRef
  const ctx = _ctxRef
  if (!cv || !ctx) return

  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2
  ctx.clearRect(0, 0, W, H)
  if (st === 'idle') return

  const cs = getComputedStyle(document.documentElement)
  const accent  = cs.getPropertyValue('--va-accent').trim()  || '#f0b54a'
  const accent2 = cs.getPropertyValue('--va-accent2').trim() || '#ffe39a'

  const baseR  = 92 * _dpr
  const maxLen = (st === 'thinking' ? 16 : 64) * _dpr

  // Expanding ripple rings on amplitude peaks
  if ((st === 'listening' || st === 'speaking') && _amp > 0.50 && (_t - _lastPeak) > 0.28) {
    _ripples.push({ r: baseR, a: 0.55 })
    _lastPeak = _t
  }
  _ripples.forEach(rp => { rp.r += 2.4 * _dpr; rp.a -= 0.011 })
  _ripples = _ripples.filter(rp => rp.a > 0)

  _ripples.forEach(rp => {
    ctx.beginPath(); ctx.arc(cx, cy, rp.r, 0, Math.PI * 2)
    ctx.strokeStyle = accent2
    ctx.globalAlpha = Math.max(0, rp.a)
    ctx.lineWidth   = 1.4 * _dpr
    ctx.stroke()
  })
  ctx.globalAlpha = 1

  // 88 radial bars forming the circular waveform
  for (let i = 0; i < BARS; i++) {
    const ang   = (i / BARS) * Math.PI * 2
    const wob   = Math.sin(_t * 4.4 + PHASE[i]) * 0.5 + 0.5
    const react = st === 'thinking' ? 0.22 + 0.28 * wob : _amp * (0.42 + 0.58 * wob)
    const len   = maxLen * react + 3 * _dpr
    const x1 = cx + Math.cos(ang) * baseR
    const y1 = cy + Math.sin(ang) * baseR
    const x2 = cx + Math.cos(ang) * (baseR + len)
    const y2 = cy + Math.sin(ang) * (baseR + len)

    const g = ctx.createLinearGradient(x1, y1, x2, y2)
    g.addColorStop(0, accent)
    g.addColorStop(1, accent2)

    ctx.strokeStyle = g
    ctx.lineWidth   = 3 * _dpr
    ctx.lineCap     = 'round'
    ctx.globalAlpha = 0.92
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  }

  // Soft inner ring outline
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = accent
  ctx.lineWidth   = 1 * _dpr
  ctx.beginPath(); ctx.arc(cx, cy, baseR - 4 * _dpr, 0, Math.PI * 2); ctx.stroke()
  ctx.globalAlpha = 1
}
