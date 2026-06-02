/**
 * constitution.ts — Full Constitution ambient cross-fade.
 *
 * Sources the engine's existing cross-fade from the full constitution JSON
 * (478 articles with text + preamble) instead of the 10 hardcoded ones.
 * No UI added — articles rotate automatically at the engine's 5.2s pace.
 * HARD RULE 1 compliant: engine.js is untouched.
 */

interface Article { num: string | number; heading: string; omitted?: boolean; text?: string }
interface Part    { part: string; title: string; articles: Article[] }
interface ConData { preamble: string; parts: Part[] }

let _pool: { num: string; heading: string; text: string }[] = []
let _idx  = 0

export async function initConstitution(): Promise<void> {
  if (!document.getElementById('ca-num')) return

  try {
    const res  = await fetch('/constitution.json')
    const data = await res.json() as ConData

    // Build the rotation pool: preamble first, then every article that has full text
    _pool.push({
      num:     'Preamble',
      heading: 'Preamble to the Constitution of India',
      text:    data.preamble,
    })

    for (const part of data.parts) {
      for (const a of part.articles) {
        if (!a.omitted && a.text && a.text.trim().length > 10) {
          _pool.push({
            num:     `Article ${a.num}`,
            heading: a.heading,
            text:    a.text.trim(),
          })
        }
      }
    }

    // Shuffle so it doesn't always start at Article 1
    for (let i = _pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[_pool[i], _pool[j]] = [_pool[j], _pool[i]]
    }

    startAmbientOverride()
  } catch (e) {
    console.error('[constitution] failed to load:', e)
  }
}

function startAmbientOverride(): void {
  if (!_pool.length) return

  const numEl   = document.getElementById('ca-num')
  const titleEl = document.getElementById('ca-title')
  const textEl  = document.getElementById('ca-text')
  if (!numEl) return

  // Every time the engine updates #ca-num (its 5.2s setInterval), replace
  // with the next article from our JSON pool — engine drives the timing,
  // we supply the data.
  new MutationObserver(() => {
    const a = _pool[_idx % _pool.length]
    _idx++
    if (numEl)   numEl.textContent   = a.num
    if (titleEl) titleEl.textContent = a.heading
    if (textEl)  textEl.textContent  = a.text
  }).observe(numEl, { childList: true, characterData: true, subtree: true })
}
