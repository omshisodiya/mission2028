/**
 * constitution.ts — Full Constitution module (v2-B spec).
 *
 * Two behaviours, both keeping the cinematic engine intact (HARD RULE 1):
 * 1. Ambient cross-fade — a MutationObserver intercepts every engine update
 *    to #ca-num and replaces the text with iconic JSON articles instead of
 *    the engine's hardcoded ARTICLES[].
 * 2. Browsable index — injected below #const-ticker. 21 parts (accordion),
 *    481 articles, full text on click. Keyword + number search.
 */
import './constitution.css'

interface Article { num: string | number; heading: string; omitted?: boolean; text?: string }
interface Part    { part: string; title: string; articles: Article[] }
interface ConData { preamble: string; parts: Part[]; schedules: { name: string; about: string }[] }

// Iconic article numbers for the ambient cross-fade
const ICONIC = ['Preamble', '14', '19', '21', '21A', '32', '44', '51A', '17', '368']

let _data: ConData | null = null
let _iconicArticles: { num: string; heading: string; text: string }[] = []
let _iconicIdx = 0
let _observing = false

// ── Public init — call from main.ts after engine boots ────────────────────────

export async function initConstitution(): Promise<void> {
  // Lazy-load JSON only when #constitution section exists
  const section = document.getElementById('constitution')
  if (!section) return

  try {
    const res = await fetch('/constitution.json')
    _data = await res.json() as ConData
  } catch (e) {
    console.error('[constitution] failed to load:', e)
    return
  }

  buildIconicList()
  startAmbientOverride()
  injectBrowser()
}

// ── 1. Ambient cross-fade override ───────────────────────────────────────────

function buildIconicList(): void {
  if (!_data) return
  const allArticles = _data.parts.flatMap(p => p.articles)

  // Add preamble first
  _iconicArticles.push({
    num: 'Preamble',
    heading: 'Preamble to the Constitution of India',
    text: _data.preamble,
  })

  // Add each iconic article
  for (const num of ICONIC.slice(1)) {
    const a = allArticles.find(x => String(x.num) === num)
    if (a) _iconicArticles.push({ num: `Article ${a.num}`, heading: a.heading, text: a.text ?? '' })
  }
}

function startAmbientOverride(): void {
  if (_observing || !_iconicArticles.length) return
  _observing = true

  const numEl   = document.getElementById('ca-num')
  const titleEl = document.getElementById('ca-title')
  const textEl  = document.getElementById('ca-text')
  if (!numEl) return

  // The engine updates #ca-num every 5.2s — intercept and replace with JSON data
  const obs = new MutationObserver(() => {
    const a = _iconicArticles[_iconicIdx % _iconicArticles.length]
    if (numEl)   numEl.textContent   = a.num
    if (titleEl) titleEl.textContent = a.heading
    if (textEl)  textEl.textContent  = (a.text ?? '').trim()
    _iconicIdx++
  })
  obs.observe(numEl, { childList: true, characterData: true, subtree: true })

  // Also replace ticker chips in #const-ticker with our JSON-sourced ones
  const ticker = document.getElementById('const-ticker')
  if (ticker) {
    ticker.innerHTML = ''
    _iconicArticles.forEach((a, k) => {
      const btn = document.createElement('button')
      btn.className = 'tick'
      btn.textContent = a.num
      btn.addEventListener('click', () => {
        _iconicIdx = k
        showInMain(a.num, a.heading, a.text ?? '')
      })
      ticker.appendChild(btn)
    })
  }
}

function showInMain(num: string, heading: string, text: string): void {
  const numEl   = document.getElementById('ca-num')
  const titleEl = document.getElementById('ca-title')
  const textEl  = document.getElementById('ca-text')
  const stage   = document.getElementById('const-article')
  if (!numEl) return
  stage?.classList.remove('show')
  setTimeout(() => {
    if (numEl)   numEl.textContent   = num
    if (titleEl) titleEl.textContent = heading
    if (textEl)  textEl.textContent  = text.trim()
    stage?.classList.add('show')
    // Update ticker active state
    document.querySelectorAll('#const-ticker .tick').forEach((b, k) => {
      b.classList.toggle('active', _iconicArticles[k]?.num === num)
    })
  }, 260)
}

// ── 2. Browsable index ────────────────────────────────────────────────────────

function injectBrowser(): void {
  if (!_data || document.getElementById('const-browser')) return
  const ticker = document.getElementById('const-ticker')
  if (!ticker) return

  const browser = document.createElement('div')
  browser.id = 'const-browser'
  browser.innerHTML = `
    <div class="cb-search-wrap">
      <input id="cb-search" type="search"
        placeholder="Search article number or keyword — e.g. 'education', '21A', 'equality'…" />
      <span class="cb-search-icon">&#9906;</span>
    </div>
    <div id="cb-results-wrap" style="display:none;"></div>
    <div id="cb-index"></div>
    <div id="cb-panel" class="cb-panel" style="display:none;">
      <button class="cb-panel-close" id="cb-close">&times;</button>
      <div class="cb-panel-num" id="cb-num"></div>
      <h3 class="cb-panel-title" id="cb-title"></h3>
      <div class="cb-panel-text" id="cb-text"></div>
    </div>
  `
  ticker.insertAdjacentElement('afterend', browser)

  buildIndex()
  bindSearch()
  document.getElementById('cb-close')?.addEventListener('click', closePanel)
}

function buildIndex(): void {
  if (!_data) return
  const indexEl = document.getElementById('cb-index')
  if (!indexEl) return

  // Preamble entry
  const preBtn = document.createElement('div')
  preBtn.className = 'cb-part-head'
  preBtn.style.cursor = 'pointer'
  preBtn.innerHTML = `<span class="cb-part-name">Preamble</span><span class="cb-part-title">We, the People of India…</span>`
  preBtn.addEventListener('click', () => openPanel('Preamble', 'Preamble to the Constitution', _data?.preamble ?? '', false))
  indexEl.appendChild(preBtn)

  // Parts
  _data.parts.forEach(part => {
    const partEl = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'cb-part-head'
    head.innerHTML = `
      <div>
        <span class="cb-part-name">${esc(part.part)}</span>
        <span class="cb-part-title"> — ${esc(part.title)}</span>
      </div>
      <span class="cb-part-toggle">›</span>
    `
    const articleList = document.createElement('div')
    articleList.className = 'cb-articles'

    head.addEventListener('click', () => {
      const isOpen = head.classList.toggle('open')
      articleList.classList.toggle('open', isOpen)
    })

    part.articles.forEach(art => {
      const btn = document.createElement('button')
      btn.className = 'cb-article-btn' + (art.omitted ? ' cb-art-omitted' : '')
      btn.innerHTML =
        `<span class="cb-art-num">Art. ${esc(String(art.num))}</span>` +
        `<span>${esc(art.heading)}</span>`
      btn.addEventListener('click', () =>
        openPanel(`Article ${art.num}`, art.heading, art.text ?? '', !!art.omitted)
      )
      articleList.appendChild(btn)
    })

    // Schedules after all parts
    partEl.appendChild(head)
    partEl.appendChild(articleList)
    indexEl.appendChild(partEl)
  })

  // Schedules
  _data.schedules.forEach(s => {
    const btn = document.createElement('div')
    btn.className = 'cb-part-head'
    btn.style.cursor = 'pointer'
    btn.innerHTML = `<span class="cb-part-name">${esc(s.name)}</span><span class="cb-part-title">${esc(s.about)}</span>`
    btn.addEventListener('click', () => openPanel(s.name, s.name, s.about, false))
    indexEl.appendChild(btn)
  })
}

// ── Search ────────────────────────────────────────────────────────────────────

function bindSearch(): void {
  const input = document.getElementById('cb-search') as HTMLInputElement | null
  if (!input) return
  let debounce: ReturnType<typeof setTimeout> | null = null
  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => runSearch(input.value.trim()), 200)
  })
}

function runSearch(q: string): void {
  const wrap  = document.getElementById('cb-results-wrap')
  const index = document.getElementById('cb-index')
  if (!wrap || !index || !_data) return

  if (!q) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
    index.style.display = ''
    return
  }

  const qL = q.toLowerCase()
  const allArticles = _data.parts.flatMap(p => p.articles)
  const hits = allArticles.filter(a =>
    String(a.num).toLowerCase().includes(qL) ||
    a.heading.toLowerCase().includes(qL) ||
    (a.text ?? '').toLowerCase().includes(qL)
  ).slice(0, 30)

  index.style.display = 'none'
  wrap.style.display = ''

  if (hits.length === 0) {
    wrap.innerHTML = `<div class="cb-results"><div class="cb-no-results">No results for "${esc(q)}"</div></div>`
    return
  }

  const list = document.createElement('div')
  list.className = 'cb-results'
  hits.forEach(a => {
    const btn = document.createElement('button')
    btn.className = 'cb-result-item'
    btn.innerHTML =
      `<span class="cb-result-num">Art. ${esc(String(a.num))}</span>` +
      `<span>${esc(a.heading)}</span>`
    btn.addEventListener('click', () => openPanel(`Article ${a.num}`, a.heading, a.text ?? '', !!a.omitted))
    list.appendChild(btn)
  })

  wrap.innerHTML = ''
  const count = document.createElement('div')
  count.style.cssText = 'padding:8px 14px;font-size:12px;color:var(--muted);font-family:var(--font-mono);border-bottom:1px solid var(--line);'
  count.textContent = `${hits.length}${hits.length === 30 ? '+' : ''} results for "${q}"`
  wrap.appendChild(count)
  wrap.appendChild(list)
}

// ── Full text panel ───────────────────────────────────────────────────────────

function openPanel(num: string, title: string, text: string, omitted: boolean): void {
  const panel = document.getElementById('cb-panel')
  const numEl = document.getElementById('cb-num')
  const titleEl = document.getElementById('cb-title')
  const textEl = document.getElementById('cb-text')
  if (!panel || !numEl || !titleEl || !textEl) return
  numEl.textContent   = num
  titleEl.textContent = title
  textEl.innerHTML    = omitted
    ? '<span class="cb-omitted-note">This article has been omitted / repealed.</span>'
    : esc(text).replace(/\n/g, '<br>')
  panel.style.display = ''
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  // Also show in main ambient display
  showInMain(num, title, omitted ? '[Omitted]' : text)
}

function closePanel(): void {
  const panel = document.getElementById('cb-panel')
  if (panel) panel.style.display = 'none'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
