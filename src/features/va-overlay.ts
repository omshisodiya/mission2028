/**
 * va-overlay.ts — Siri-style full-screen aurora + waveform voice overlay
 *
 * Single source of truth for the visual design is Voice Assistant Design.html.
 * This module:
 *   • Mounts the overlay DOM once at app boot (always present, invisible at idle)
 *   • Exports VA.setState / VA.setAmplitude / VA.setTranscript
 *   • Runs its own rAF loop for the conic-gradient rotation + waveform
 *   • Reads amplitude from jarvis.ts via VA.setAmplitude() each frame
 *
 * Wire-up contract (jarvis.ts calls these, nothing else changes):
 *   VA.setState('listening')   — wake-word / mic start
 *   VA.setState('thinking')    — STT final result received
 *   VA.setState('speaking')    — TTS utterance starts
 *   VA.setState('idle')        — TTS finishes / dismissed
 *   VA.setAmplitude(0..1)      — called every rAF from AnalyserNode
 *   VA.setTranscript(t, final) — STT partial/final + TTS reply text
 */
import './va-overlay.css'

export type VAState = 'idle' | 'listening' | 'thinking' | 'speaking'

// ── Internal animation state ──────────────────────────────────────────────────
let _amp       = 0
let _ampTarget = 0
let _rot       = 0
let _t         = 0
let _lastPeak  = 0
let _ripples: Array<{ r: number; a: number }> = []

const STATE_LABELS: Record<VAState, string> = {
  idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking',
}

// ── Public VA API ─────────────────────────────────────────────────────────────
export const VA = {
  /** Change visual state. 'idle' = overlay hidden. */
  setState(s: VAState): void {
    document.body.dataset.state = s
    const el = document.getElementById('va-state-text')
    if (el) el.textContent = STATE_LABELS[s]
    if (s === 'idle') { _ampTarget = 0; this.setTranscript('', true) }
    document.dispatchEvent(new CustomEvent('va:state', { detail: s }))
  },

  /** Feed normalised RMS 0–1 from an AnalyserNode every animation frame. */
  setAmplitude(v: number): void {
    _ampTarget = Math.max(0, Math.min(1, v))
  },

  /**
   * Show text in the bottom transcript dock.
   * isFinal=false → append a blinking caret (interim STT / being spoken)
   * isFinal=true  → no caret (complete)
   */
  setTranscript(text: string, isFinal: boolean): void {
    const el = document.getElementById('va-transcript')
    if (!el) return
    if (!text) { el.innerHTML = ''; return }
    el.innerHTML = text + (isFinal ? '' : '<span class="caret"></span>')
  },

  /** Convenience: current state */
  get state(): VAState {
    return (document.body.dataset.state as VAState) ?? 'idle'
  },
}

// ── DOM mount ─────────────────────────────────────────────────────────────────
export function initVAOverlay(): void {
  if (document.getElementById('va-overlay')) return   // already mounted

  // 1. Page dim (behind overlay, above page content)
  const dim = document.createElement('div')
  dim.className = 'va-page-dim'
  document.body.appendChild(dim)

  // 2. Main overlay shell (aurora + glow + rim)
  const overlay = document.createElement('div')
  overlay.id = 'va-overlay'
  overlay.setAttribute('aria-live', 'assertive')
  overlay.setAttribute('aria-atomic', 'true')
  overlay.innerHTML = `
    <div class="va-aurora">
      <span class="r1"></span><span class="r2"></span>
      <span class="r3"></span><span class="r4"></span><span class="r5"></span>
    </div>
    <div class="va-glow" id="va-glow"></div>
    <div class="va-rim"></div>
  `
  document.body.appendChild(overlay)

  // 3. Circular waveform canvas (centered)
  const ring = document.createElement('div')
  ring.id = 'va-ring'
  ring.className = 'va-ring'
  ring.innerHTML = '<canvas id="va-ring-cv"></canvas>'
  document.body.appendChild(ring)

  // 4. Bottom dock: state label + transcript
  const dock = document.createElement('div')
  dock.id   = 'va-dock'
  dock.className = 'va-dock'
  dock.innerHTML = `
    <span class="va-state-label">
      <span class="dot"></span>
      <span id="va-state-text"></span>
    </span>
    <div class="va-transcript" id="va-transcript"></div>
  `
  document.body.appendChild(dock)

  // 5. Start animation loop
  _initRaf()

  // 6. Expose globally so legacy inline scripts can access it
  ;(window as Window & { VA?: typeof VA }).VA = VA

  // 7. Default state
  VA.setState('idle')
}

// ── rAF loop: rotate glow + draw waveform ────────────────────────────────────
function _initRaf(): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const cv  = document.getElementById('va-ring-cv') as HTMLCanvasElement | null
  if (!cv) return
  const ctx = cv.getContext('2d')!

  // HiDPI
  let dpr = Math.min(2, devicePixelRatio || 1)
  function resizeCv() {
    dpr = Math.min(2, devicePixelRatio || 1)
    cv!.width  = 340 * dpr
    cv!.height = 340 * dpr
  }
  resizeCv()
  window.addEventListener('resize', resizeCv)

  // Per-bar random phase for organic wobble
  const BARS  = 88
  const phase = Array.from({ length: BARS }, (_, i) => i * 0.4)

  function frame() {
    requestAnimationFrame(frame)
    _t += 0.016

    // Smooth amplitude
    _amp += (_ampTarget - _amp) * 0.12
    document.documentElement.style.setProperty('--amp', _amp.toFixed(3))

    // Rotate the conic glow — speed varies by state
    const st = VA.state
    const spd = st === 'thinking' ? 1.6 : st === 'speaking' ? 0.9 : st === 'listening' ? 0.5 : 0.18
    _rot = (_rot + spd) % 360
    document.getElementById('va-glow')?.style.setProperty('--rot', `${_rot}deg`)

    // Waveform
    if (!reduced) _drawRing(ctx, st, dpr, phase)
  }

  frame()
}

function _drawRing(
  ctx: CanvasRenderingContext2D,
  st: VAState,
  dpr: number,
  phase: number[],
): void {
  const cv = document.getElementById('va-ring-cv') as HTMLCanvasElement
  if (!cv) return
  const W = cv.width, H = cv.height, cx = W/2, cy = H/2
  ctx.clearRect(0, 0, W, H)
  if (st === 'idle') return

  const cs = getComputedStyle(document.documentElement)
  const accent  = cs.getPropertyValue('--accent').trim()  || '#f0b54a'
  const accent2 = cs.getPropertyValue('--accent-2').trim() || '#ffe39a'

  const baseR  = 92 * dpr
  const maxLen = (st === 'thinking' ? 16 : 64) * dpr
  const BARS   = 88

  // Spawn ripple rings on amplitude peaks during listening/speaking
  if ((st === 'listening' || st === 'speaking') && _amp > 0.52 && (_t - _lastPeak) > 0.30) {
    _ripples.push({ r: baseR, a: 0.55 })
    _lastPeak = _t
  }
  _ripples.forEach(rp => { rp.r += 2.4 * dpr; rp.a -= 0.011 })
  _ripples = _ripples.filter(rp => rp.a > 0)

  // Draw ripples
  _ripples.forEach(rp => {
    ctx.beginPath()
    ctx.arc(cx, cy, rp.r, 0, Math.PI * 2)
    ctx.strokeStyle = accent2
    ctx.globalAlpha = Math.max(0, rp.a)
    ctx.lineWidth   = 1.4 * dpr
    ctx.stroke()
  })
  ctx.globalAlpha = 1

  // Radial bars (the circular waveform)
  for (let i = 0; i < BARS; i++) {
    const ang  = (i / BARS) * Math.PI * 2
    const wob  = Math.sin(_t * 4.4 + phase[i]) * 0.5 + 0.5
    const react = st === 'thinking'
      ? 0.2 + 0.25 * wob
      : _amp * (0.42 + 0.58 * wob)
    const len = maxLen * react + 3 * dpr
    const x1  = cx + Math.cos(ang) * baseR
    const y1  = cy + Math.sin(ang) * baseR
    const x2  = cx + Math.cos(ang) * (baseR + len)
    const y2  = cy + Math.sin(ang) * (baseR + len)

    const g = ctx.createLinearGradient(x1, y1, x2, y2)
    g.addColorStop(0, accent)
    g.addColorStop(1, accent2)

    ctx.strokeStyle  = g
    ctx.lineWidth    = 3 * dpr
    ctx.lineCap      = 'round'
    ctx.globalAlpha  = 0.92
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  // Soft inner ring outline
  ctx.globalAlpha  = 0.5
  ctx.strokeStyle  = accent
  ctx.lineWidth    = 1 * dpr
  ctx.beginPath()
  ctx.arc(cx, cy, baseR - 4 * dpr, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
}
