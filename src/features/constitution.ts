/**
 * constitution.ts — Full Constitution ambient rotation.
 * Uses a plain setInterval — zero risk of feedback loops or page freeze.
 * The engine's own timer also runs; both show constitution content.
 */

interface Article { num: string | number; heading: string; omitted?: boolean; text?: string }
interface Part    { part: string; title: string; articles: Article[] }
interface ConData { preamble: string; parts: Part[] }

export async function initConstitution(): Promise<void> {
  try {
    const res  = await fetch('/constitution.json')
    const data = await res.json() as ConData

    // Build pool: preamble + every article with full text
    const pool: { num: string; heading: string; text: string }[] = []

    pool.push({
      num:     'Preamble',
      heading: 'Preamble to the Constitution of India',
      text:    data.preamble,
    })

    for (const part of data.parts) {
      for (const a of part.articles) {
        if (!a.omitted && a.text && a.text.length > 10) {
          pool.push({ num: `Article ${a.num}`, heading: a.heading, text: a.text })
        }
      }
    }

    if (!pool.length) return

    let idx = 0

    const update = () => {
      const a       = pool[idx % pool.length]
      const numEl   = document.getElementById('ca-num')
      const titleEl = document.getElementById('ca-title')
      const textEl  = document.getElementById('ca-text')
      if (numEl)   numEl.textContent   = a.num
      if (titleEl) titleEl.textContent = a.heading
      if (textEl)  textEl.textContent  = a.text
      idx++
    }

    // Show immediately, then rotate every 5.2s (same pace as the engine)
    update()
    setInterval(update, 5200)

  } catch (e) {
    // Non-fatal — engine's hardcoded articles continue if JSON load fails
    console.warn('[constitution] failed to load:', e)
  }
}
