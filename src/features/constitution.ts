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

  // ── Build pool — each entry has ambient text AND full legal text ──────────
  type Entry = { num: string; heading: string; text: string; fullText: string }
  const pool: Entry[] = []

  const preambleExcerpt = data.preamble.slice(0, MAX_TEXT).trimEnd() + '…'
  pool.push({ num: 'Preamble', heading: 'Preamble', text: preambleExcerpt, fullText: data.preamble })

  for (const part of data.parts) {
    for (const a of part.articles) {
      if (!a.omitted && a.text && a.text.trim().length > 5) {
        pool.push({
          num:      `Article ${a.num}`,
          heading:  a.heading,
          text:     clipBody(a.heading, a.text),
          fullText: a.text.trim(),
        })
      }
    }
  }

  // Center-align body text
  if (textEl) { textEl.style.textAlign = 'center'; textEl.style.width = '100%' }

  // ── Full-text expansion panel (shows below card on click) ─────────────────
  let fullPanel: HTMLElement | null = null
  let currentEntry: Entry | null = null

  function openFullText(entry: Entry): void {
    currentEntry = entry
    if (!fullPanel) {
      fullPanel = document.createElement('div')
      fullPanel.style.cssText =
        'background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);' +
        'padding:28px 32px;margin-top:20px;max-height:55vh;overflow-y:auto;text-align:left;' +
        'line-height:1.8;font-size:15px;color:var(--ink-soft);position:relative;'
      const hdr = document.createElement('div')
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;'
      hdr.innerHTML =
        `<span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);letter-spacing:.12em;" id="cfull-num"></span>` +
        `<button id="cfull-close" style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:20px;color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:3px 12px;cursor:pointer;">✕ CLOSE</button>`
      const body = document.createElement('p')
      body.id = 'cfull-text'
      body.style.cssText = 'margin:0;white-space:pre-wrap;'
      fullPanel.appendChild(hdr); fullPanel.appendChild(body)
      stage!.insertAdjacentElement('afterend', fullPanel)
      document.getElementById('cfull-close')?.addEventListener('click', () => {
        fullPanel?.remove(); fullPanel = null
      })
    }
    const numLbl = fullPanel.querySelector<HTMLElement>('#cfull-num')
    const textLbl = fullPanel.querySelector<HTMLElement>('#cfull-text')
    if (numLbl)  numLbl.textContent  = entry.num
    if (textLbl) textLbl.textContent = entry.fullText
    fullPanel.scrollTop = 0
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
      if (textEl) {
        textEl.textContent  = entry.text
        textEl.style.textAlign = 'center'   // inline — beats any CSS rule
        textEl.style.width     = '100%'
      }
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

  // ── Click → show full text; hover → pause cycle ───────────────────────────
  stage.addEventListener('click', () => {
    // Find current entry by matching article number
    const cur = pool[idx % pool.length]
    openFullText(cur)
    paused = true   // pause while reading
  })
  stage.style.cursor = 'pointer'
  stage.title = 'Click to read the full article text'
  stage.addEventListener('mouseenter', () => { paused = true })
  stage.addEventListener('mouseleave', () => { if (!fullPanel) paused = false })

  // ── Start ─────────────────────────────────────────────────────────────────
  show(pool[0], true)
  startTimer()
}
