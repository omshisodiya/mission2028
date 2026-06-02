/**
 * constitution.ts — Full Constitution ambient cross-fade.
 *
 * Rules per user request:
 * - No article selection chips. Only one "Preamble" chip remains.
 * - Clicking Preamble: pauses cycle and shows Preamble.
 * - Clicking Preamble again: resumes cycle from beginning.
 * - Hovering over the article card pauses the cycle; mouse-out resumes.
 * - Article body text is truncated to 240 chars to preserve layout.
 * - Proper fade-out → swap → fade-in sequence using the engine's CSS.
 */

interface Article { num: string | number; heading: string; omitted?: boolean; text?: string }
interface Part    { part: string; title: string; articles: Article[] }
interface ConData { preamble: string; parts: Part[] }

const MAX_TEXT = 200    // body chars shown in the ambient card
const INTERVAL = 5200   // ms between articles (matches engine's pace)

/** Strip the repeated heading prefix (Indian legal drafting: "Heading.—Actual text…")
 *  and clip body to MAX_TEXT. No ellipsis on headings — they display in full. */
function clipBody(heading: string, text: string): string {
  let t = text.trim()
  const dashIdx = t.search(/[—–]/)
  if (dashIdx > 0 && dashIdx < Math.min(heading.length + 20, 120)) {
    t = t.slice(dashIdx + 1).trimStart()
  }
  return t.length <= MAX_TEXT ? t : t.slice(0, MAX_TEXT - 1).trimEnd() + '…'
}

export async function initConstitution(): Promise<void> {
  const numEl   = document.getElementById('ca-num')
  const titleEl = document.getElementById('ca-title')
  const textEl  = document.getElementById('ca-text')
  const stage   = document.getElementById('const-article')
  const ticker  = document.getElementById('const-ticker')
  if (!numEl || !stage) return

  // ── Load JSON ─────────────────────────────────────────────────────────────
  let data: ConData
  try {
    data = await fetch('/constitution.json').then(r => r.json()) as ConData
  } catch (e) {
    console.warn('[constitution] failed to load:', e)
    return
  }

  // ── Build pool (Preamble first, then all articles with text) ──────────────
  type Entry = { num: string; heading: string; text: string }
  const pool: Entry[] = []

  // Preamble — short meaningful excerpt
  const preambleExcerpt = data.preamble.slice(0, MAX_TEXT).trimEnd() + '…'
  pool.push({
    num:     'Preamble',
    heading: 'Preamble',
    text:    preambleExcerpt,
  })

  for (const part of data.parts) {
    for (const a of part.articles) {
      if (!a.omitted && a.text && a.text.trim().length > 5) {
        pool.push({
          num:     `Article ${a.num}`,
          heading: a.heading,   // full heading, no truncation, no ellipsis
          text:    clipBody(a.heading, a.text),
        })
      }
    }
  }

  // Inject once: center-align body text so it matches the heading above it
  if (!document.getElementById('const-body-align')) {
    const s = document.createElement('style')
    s.id = 'const-body-align'
    s.textContent = '#ca-text { text-align: center; }'
    document.head.appendChild(s)
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let idx     = 0
  let paused  = false
  let timer: ReturnType<typeof setInterval> | null = null
  let preambleHeld = false   // true when user clicked Preamble to hold

  // ── Fade-swap function (uses engine's .show class for CSS transition) ─────
  function show(entry: Entry, snap = false): void {
    stage!.classList.remove('show')
    setTimeout(() => {
      if (numEl)   numEl.textContent   = entry.num
      if (titleEl) titleEl.textContent = entry.heading
      if (textEl)  textEl.textContent  = entry.text
      stage!.classList.add('show')
    }, snap ? 0 : 480)
  }

  function startTimer(): void {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      if (paused || preambleHeld) return
      idx = (idx + 1) % pool.length
      show(pool[idx])
    }, INTERVAL)
  }

  // ── Clear ticker + add only Preamble chip ─────────────────────────────────
  if (ticker) {
    ticker.innerHTML = ''
    const btn = document.createElement('button')
    btn.className = 'tick'
    btn.textContent = 'Preamble'
    btn.title = 'Click to pause at Preamble; click again to resume'
    btn.addEventListener('click', () => {
      if (preambleHeld) {
        // Resume cycle
        preambleHeld = false
        btn.classList.remove('active')
        idx = 0           // restart from beginning
        show(pool[idx])
      } else {
        // Pause at Preamble
        preambleHeld = true
        btn.classList.add('active')
        idx = 0
        show(pool[0])
      }
    })
    ticker.appendChild(btn)
  }

  // ── Hover pause (engine already pauses on hover, but so does ours) ────────
  stage.addEventListener('mouseenter', () => { paused = true })
  stage.addEventListener('mouseleave', () => { paused = false })

  // ── Start ─────────────────────────────────────────────────────────────────
  show(pool[0], true)
  startTimer()
}
