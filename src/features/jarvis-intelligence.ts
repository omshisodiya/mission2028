/**
 * jarvis-intelligence.ts — Advanced Intelligence Modules
 *
 * 1. Socratic Mode       — JARVIS asks questions back to test understanding
 * 2. Concept Web         — Maps connections between UPSC topics across GS papers
 * 3. Memory Palace       — Spatial memory technique for lists/articles/facts
 * 4. Adaptive Engine     — Adjusts difficulty/depth based on user knowledge level
 * 5. PYQ Pattern Miner   — Identifies recurring exam patterns for prediction
 * 6. Study Optimizer     — Cognitive-science-based session scheduling
 * 7. Debate Engine       — Structured, tracked debate sessions with scoring
 * 8. Citation Builder    — Generates UPSC-ready citations for facts
 * 9. Answer Architect    — Builds structured mains answers from bullet points
 *10. UPSC Radar          — Visual readiness map for all GS topics
 */

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const FAST_MODEL = 'llama-3.1-8b-instant'

function getKey(): string | undefined { return import.meta.env.VITE_GROQ_API_KEY as string | undefined }

async function groq(prompt: string, model = GROQ_MODEL, maxTokens = 300): Promise<string | null> {
  const key = getKey(); if (!key) return null
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.6, stream: false }),
    })
    if (!res.ok) return null
    return ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message?.content?.trim() ?? null
  } catch { return null }
}

// ── 1. SOCRATIC MODE ──────────────────────────────────────────────────────────

export interface SocraticSession {
  topic:      string
  turns:      number
  userAnswers: string[]
  score:      number   // 0–100
}

let _socraticSession: SocraticSession | null = null

export function isSocraticActive(): boolean { return _socraticSession !== null }

export async function startSocraticMode(topic: string, respond: (t: string) => void): Promise<void> {
  _socraticSession = { topic, turns: 0, userAnswers: [], score: 0 }
  const q = await groq(
    `You are Socrates teaching "${topic}" for UPSC. Ask one probing question that will reveal the student's understanding. Not a factual question — a reasoning question. Maximum 2 sentences.`,
    FAST_MODEL, 120
  )
  respond(q ?? `Let's explore "${topic}". What do you think is the most important principle to understand here?`)
}

export async function continueSocratic(userAnswer: string, respond: (t: string) => void): Promise<void> {
  if (!_socraticSession) return
  _socraticSession.userAnswers.push(userAnswer)
  _socraticSession.turns++

  if (_socraticSession.turns >= 5) {
    const eval_ = await groq(
      `Student studied "${_socraticSession.topic}" via Socratic method. Their answers: ${_socraticSession.userAnswers.join(' | ')}. Score 0-100 for UPSC understanding and give one key improvement. Format: "Score: X/100. [assessment]. Key gap: [one sentence]."`,
      FAST_MODEL, 150
    )
    respond(eval_ ?? `Socratic session complete (${_socraticSession.turns} turns). Great thinking, Om.`)
    _socraticSession = null
    return
  }

  const followUp = await groq(
    `Socratic teaching "${_socraticSession.topic}" for UPSC. Student said: "${userAnswer.slice(0, 200)}". Ask a follow-up question that pushes deeper. One sentence only.`,
    FAST_MODEL, 100
  )
  respond(followUp ?? `Interesting. But consider — what are the constitutional implications of that?`)
}

export function endSocratic(): void { _socraticSession = null }

// ── 2. CONCEPT WEB ────────────────────────────────────────────────────────────
// Shows how topics connect across GS papers. Renders a visual mind-map panel.

interface ConceptNode { id: string; label: string; gs: string; color: string }
interface ConceptLink { from: string; to: string; label: string }

const GS_COLORS: Record<string, string> = {
  GS1: '#f0b54a', GS2: '#78a8ff', GS3: '#45e0a8', GS4: '#e05555', General: '#9b8fd9'
}

export async function buildConceptWeb(topic: string, respond: (t: string) => void): Promise<void> {
  respond(`Building concept web for "${topic}"…`)

  const raw = await groq(
    `Create a concept web for UPSC topic "${topic}". Show 6-8 related concepts across GS papers.
Return ONLY JSON: {"nodes":[{"id":"n1","label":"concept","gs":"GS1|GS2|GS3|GS4|General"}], "links":[{"from":"n1","to":"n2","label":"relates via"}]}
Keep labels under 20 chars.`,
    GROQ_MODEL, 500
  )

  if (!raw) { respond('Could not build concept web — check connection.'); return }

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('no JSON')
    const data = JSON.parse(match[0]) as { nodes: ConceptNode[]; links: ConceptLink[] }

    // Render as SVG panel
    renderConceptWeb(topic, data.nodes, data.links)
    respond(`Concept web for "${topic}" is open. ${data.nodes.length} concepts across ${[...new Set(data.nodes.map(n => n.gs))].join(', ')}.`)
  } catch (e) {
    respond(`Concept web data generated but could not render. Key connections for "${topic}": ${raw.slice(0, 200)}`)
  }
}

function renderConceptWeb(topic: string, nodes: ConceptNode[], links: ConceptLink[]): void {
  if (document.getElementById('concept-web-overlay')) document.getElementById('concept-web-overlay')!.remove()

  const overlay = document.createElement('div')
  overlay.id = 'concept-web-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.94);backdrop-filter:blur(10px);padding:16px;'

  const W = 560, H = 420, CX = W / 2, CY = H / 2
  const R = Math.min(W, H) * 0.36

  // Place nodes in a circle
  const positioned = nodes.map((n, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2
    return { ...n, x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle), color: GS_COLORS[n.gs] ?? '#888' }
  })

  const linkSVG = links.map(l => {
    const from = positioned.find(n => n.id === l.from)
    const to   = positioned.find(n => n.id === l.to)
    if (!from || !to) return ''
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="rgba(255,255,255,.15)" stroke-width="1.5"/>
    <text x="${mx}" y="${my}" text-anchor="middle" font-size="8" fill="rgba(255,255,255,.4)" font-family="monospace">${l.label.slice(0,15)}</text>`
  }).join('')

  const nodeSVG = positioned.map(n => `
    <g transform="translate(${n.x},${n.y})" style="cursor:pointer">
      <circle r="32" fill="${n.color}20" stroke="${n.color}" stroke-width="1.5"/>
      <text text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="600" fill="${n.color}" font-family="monospace" dy="-6">${n.label.slice(0,12)}</text>
      <text text-anchor="middle" dominant-baseline="central" font-size="8" fill="${n.color}99" font-family="monospace" dy="7">${n.gs}</text>
    </g>`).join('')

  const legend = Object.entries(GS_COLORS).map(([gs, col]) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:${col};font-family:monospace;">${gs}</span>`
  ).join('<span style="color:var(--muted);margin:0 4px;">·</span>')

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:20px 24px;width:100%;max-width:620px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">🕸 CONCEPT WEB — ${topic.toUpperCase().slice(0,30)}</span>
        <button id="cw-x" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <svg width="100%" viewBox="0 0 ${W} ${H}" style="max-height:360px;">
        <rect width="${W}" height="${H}" fill="var(--panel-2)" rx="8"/>
        <circle cx="${CX}" cy="${CY}" r="42" fill="var(--accent)18" stroke="var(--accent)55" stroke-width="1.5"/>
        <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="700" fill="var(--accent)" font-family="monospace">${topic.slice(0,12)}</text>
        ${linkSVG}
        ${nodeSVG}
      </svg>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);">${legend}</div>
    </div>`

  document.body.appendChild(overlay)
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  document.getElementById('cw-x')?.addEventListener('click', () => overlay.remove())
}

// ── 3. MEMORY PALACE ──────────────────────────────────────────────────────────

export async function buildMemoryPalace(topic: string, items: string[], respond: (t: string) => void): Promise<void> {
  if (!items.length) {
    respond(`Tell me the items to remember: "memory palace for [topic]: item1, item2, item3"`)
    return
  }

  const palace = await groq(
    `Create a vivid, memorable memory palace for these UPSC items about "${topic}":
${items.slice(0, 10).map((x, i) => `${i + 1}. ${x}`).join('\n')}

Use a familiar Indian location (Parliament, Red Fort, IIT campus, etc.).
Place each item at a specific spot with a SHOCKING or FUNNY visual image.
Format: "Location: [place]. ${items.map((_, i) => `Stop ${i + 1}: [vivid image for item ${i + 1}]`).join('. ')}"
Spoken format, maximum 4 sentences total.`,
    GROQ_MODEL, 350
  )
  respond(palace ?? `Memory palace for ${topic}: ${items.slice(0,5).map((x,i) => `Stop ${i+1}: ${x}`).join('. ')}`)
}

// ── 4. ADAPTIVE DIFFICULTY ENGINE ─────────────────────────────────────────────

export interface AdaptiveProfile {
  topic:      string
  level:      'beginner' | 'intermediate' | 'advanced' | 'expert'
  recentScores: number[]
  lastAdapted: string
}

const _ADAPT_KEY = 'jarvis_adaptive_v1'

function loadAdaptiveProfiles(): AdaptiveProfile[] {
  try { return JSON.parse(localStorage.getItem(_ADAPT_KEY) ?? '[]') }
  catch { return [] }
}

function saveAdaptiveProfiles(p: AdaptiveProfile[]): void {
  localStorage.setItem(_ADAPT_KEY, JSON.stringify(p.slice(0, 50)))
}

export function updateAdaptiveProfile(topic: string, score: number): AdaptiveProfile {
  const profiles = loadAdaptiveProfiles()
  const idx      = profiles.findIndex(p => p.topic === topic)
  const profile: AdaptiveProfile = idx >= 0 ? profiles[idx] : { topic, level: 'intermediate', recentScores: [], lastAdapted: '' }

  profile.recentScores.push(score)
  if (profile.recentScores.length > 5) profile.recentScores.shift()

  const avg = profile.recentScores.reduce((a, b) => a + b, 0) / profile.recentScores.length
  profile.level = avg >= 85 ? 'expert' : avg >= 70 ? 'advanced' : avg >= 50 ? 'intermediate' : 'beginner'
  profile.lastAdapted = new Date().toISOString()

  if (idx >= 0) profiles[idx] = profile; else profiles.unshift(profile)
  saveAdaptiveProfiles(profiles)
  return profile
}

export function getAdaptiveLevel(topic: string): AdaptiveProfile['level'] {
  return loadAdaptiveProfiles().find(p => p.topic === topic)?.level ?? 'intermediate'
}

export async function adaptiveExplain(topic: string, query: string, respond: (t: string) => void): Promise<void> {
  const level = getAdaptiveLevel(topic)
  const depthMap = {
    beginner:     'Simple analogies, no jargon, relate to everyday life. 2 sentences.',
    intermediate: 'Core concepts + one example. 2-3 sentences.',
    advanced:     'Deep analysis, constitutional provisions, case laws, PYQ angles. 3 sentences.',
    expert:       'Nuanced debate, conflicting interpretations, examiner-level precision. 3 sentences.',
  }

  const enriched = `[User level for ${topic}: ${level}. Calibrate depth: ${depthMap[level]}]\n${query}`
  respond(`(${level} mode) `)

  const ans = await groq(enriched, GROQ_MODEL, 250)
  if (ans) respond(ans)
}

// ── 5. PYQ PATTERN MINER ─────────────────────────────────────────────────────

const PYQ_PATTERNS: Record<string, string[]> = {
  Polity:      ['Basic Structure doctrine', 'Governor\'s discretion', 'Ordinance power', 'Emergency provisions', 'Centre-State relations', 'Article 370 aftermath', 'Judicial appointments collegium'],
  History:     ['Peasant movements linkage', 'Press laws colonial', 'Constitutional reforms 1919-35', 'Non-cooperation impact', 'Social reform movements'],
  Geography:   ['Monsoon anomalies', 'River interlinking', 'Soil-crop correlation', 'Cyclone vulnerability', 'Glacier retreat impact'],
  Economy:     ['FRBM targets', 'JAM trinity outcomes', 'Agricultural distress causes', 'NPA resolution IBC', 'Startup India effectiveness'],
  Environment: ['CITES vs Biodiversity convention', 'Paris Agreement NDC', 'Wetland significance', 'Biosphere reserve levels', 'EIA process'],
  Ethics:      ['Whistleblower vs loyalty', 'Civil servant neutrality limits', 'Probity in governance', 'Emotional intelligence leadership'],
}

export async function minePYQPatterns(subject: string, respond: (t: string) => void): Promise<void> {
  const patterns = PYQ_PATTERNS[subject] ?? []
  const predict  = await groq(
    `UPSC PYQ analysis for ${subject}. Known recurring themes: ${patterns.slice(0,5).join(', ')}.
What are the 3 highest-probability questions for UPSC Prelims 2025 in ${subject}?
For each: topic, why it's likely, and the exam angle. Spoken format. 3 sentences total.`,
    GROQ_MODEL, 250
  )
  respond(predict ?? `Top ${subject} patterns: ${patterns.slice(0, 4).join('; ')}. All are high-frequency PYQ themes.`)
}

// ── 6. STUDY OPTIMIZER ────────────────────────────────────────────────────────

export function optimizeStudySession(availableHours: number, subjects: string[]): string {
  // Based on cognitive load theory + spaced repetition science
  const recommendations: string[] = []

  if (availableHours >= 6) {
    recommendations.push(`Start with hardest subject (${subjects[0] || 'Economy'}) — peak focus in first 90 min.`)
    recommendations.push(`Take a 20-min break after every 90 min (ultradian rhythm).`)
    recommendations.push(`Interleave 2 subjects per slot — improves retention by 40%.`)
    recommendations.push(`Reserve last 30 min for active recall / quiz mode — consolidates learning.`)
  } else if (availableHours >= 3) {
    recommendations.push(`3-hour protocol: 80 min subject A → 15 min break → 80 min subject B → 25 min active recall.`)
  } else {
    recommendations.push(`Short session: single subject, full focus. No multitasking. Deep beats wide.`)
  }

  recommendations.push(`Optimal study time: 8-11 AM (peak cognition) and 4-7 PM (second peak).`)
  return recommendations.join(' ')
}

// ── 7. DEBATE ENGINE ─────────────────────────────────────────────────────────

export interface DebateSession {
  topic:    string
  position: 'for' | 'against'
  rounds:   number
  score:    { user: number; jarvis: number }
}

let _debate: DebateSession | null = null

export async function startDebateSession(topic: string, respond: (t: string) => void): Promise<void> {
  _debate = { topic, position: 'against', rounds: 0, score: { user: 0, jarvis: 0 } }
  const opening = await groq(
    `You are a UPSC debate partner. Topic: "${topic}". You STRONGLY ARGUE AGAINST this position.
Give your opening argument in 2 punchy sentences. Be persuasive, use facts, don't be gentle.`,
    FAST_MODEL, 150
  )
  respond(`Debate: "${topic}". You argue FOR, I argue AGAINST. Give me your best case. Mine first: ${opening ?? 'This policy has failed empirically — prove me wrong.'}`)
}

export async function continueDebate(userArg: string, respond: (t: string) => void): Promise<void> {
  if (!_debate) return
  _debate.rounds++

  if (_debate.rounds >= 4) {
    const verdict = await groq(
      `Debate on "${_debate.topic}" concluded after ${_debate.rounds} rounds.
User argued FOR, JARVIS argued AGAINST. Final statements: User: "${userArg.slice(0,150)}".
Give a fair 2-sentence verdict: who made the stronger case and why? UPSC examiner perspective.`,
      FAST_MODEL, 150
    )
    respond(`Debate complete! ${verdict ?? 'Both sides made valid points. A balanced view serves UPSC answers best.'} Try "debate [topic]" for another round.`)
    _debate = null
    return
  }

  const counter = await groq(
    `Debate: "${_debate.topic}". I argue AGAINST. User's point: "${userArg.slice(0,200)}".
Give a 2-sentence counter-argument using specific Indian examples or Supreme Court cases. Be sharp.`,
    FAST_MODEL, 150
  )
  respond(counter ?? `Interesting point, but consider the opposing evidence: ${_debate.topic} has real implementation challenges that theory ignores.`)
}

export function isDebateActive(): boolean { return _debate !== null }
export function endDebate(): void { _debate = null }

// ── 8. CITATION BUILDER ───────────────────────────────────────────────────────

export async function buildCitation(fact: string, respond: (t: string) => void): Promise<void> {
  const cite = await groq(
    `For the UPSC fact: "${fact}", provide the authoritative citation.
Format: "Source: [Act/Article/Case/Report/Amendment/Treaty]. Year: [year]. Key provision: [one line]."
If multiple sources, give the primary one. Be precise.`,
    FAST_MODEL, 120
  )
  respond(cite ?? `Citation for "${fact.slice(0,50)}": Verify through the primary source — relevant Act, Article, or Supreme Court judgment.`)
}

// ── 9. ANSWER ARCHITECT ───────────────────────────────────────────────────────

export async function architectAnswer(question: string, bulletPoints: string[], respond: (t: string) => void): Promise<void> {
  const bullets = bulletPoints.join(', ')
  const arch    = await groq(
    `Build a structured UPSC Mains answer for: "${question}"
User's bullet points: ${bullets}
Create a 150-word answer with: 1-line intro, 3 structured body paragraphs each with UPSC keywords,
1-line balanced conclusion. Spoken format showing the structure clearly.`,
    GROQ_MODEL, 400
  )
  respond(arch ?? `Answer structure for "${question.slice(0,50)}": Intro (define + relevance) → 3 body dimensions → Conclusion (way forward).`)
}

// ── 10. UPSC RADAR ────────────────────────────────────────────────────────────

interface RadarArea {
  subject:    string
  coverage:   number   // 0-100%
  accuracy:   number   // 0-100%
  revisions:  number   // times revised
  confidence: number   // self-rated 1-5
}

export function buildUPSCRadar(coreState: {
  performance?: { prelimsAvg?: number | null }
  subjectAccuracy?: Record<string, number>
} | null): RadarArea[] {
  const SUBJECTS = ['Polity', 'History', 'Geography', 'Economy', 'Environment', 'Science & Tech', 'Ethics', 'CSAT']
  const subjectAcc = coreState?.subjectAccuracy ?? {}
  const confMap   = (() => {
    try { return JSON.parse(localStorage.getItem('jarvis_mem_v1') ?? '{}')?.confidence ?? {} as Record<string,number> }
    catch { return {} as Record<string,number> }
  })()

  return SUBJECTS.map(s => {
    const kw   = s.toLowerCase().split(' ')[0]
    const acc  = subjectAcc[kw] ?? subjectAcc[s.toLowerCase()] ?? coreState?.performance?.prelimsAvg ?? 0
    const conf = confMap[s] ?? confMap[kw] ?? 3
    return { subject: s, coverage: Math.min(100, acc * 1.2), accuracy: acc, revisions: 0, confidence: conf }
  })
}

export function renderUPSCRadar(areas: RadarArea[]): void {
  if (document.getElementById('radar-overlay')) document.getElementById('radar-overlay')!.remove()

  const overlay = document.createElement('div')
  overlay.id = 'radar-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.94);backdrop-filter:blur(10px);padding:16px;'

  const N = areas.length, W = 420, H = 420, CX = W/2, CY = H/2, R = 160

  const rings  = [0.25, 0.5, 0.75, 1.0].map(r =>
    `<polygon points="${areas.map((_,i) => { const a = (i/N)*2*Math.PI-Math.PI/2; return `${CX+R*r*Math.cos(a)},${CY+R*r*Math.sin(a)}` }).join(' ')}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`
  ).join('')

  const axes = areas.map((_, i) => {
    const a = (i/N)*2*Math.PI-Math.PI/2
    return `<line x1="${CX}" y1="${CY}" x2="${CX+R*Math.cos(a)}" y2="${CY+R*Math.sin(a)}" stroke="rgba(255,255,255,.1)" stroke-width="1"/>`
  }).join('')

  const poly = areas.map((ar, i) => {
    const a   = (i/N)*2*Math.PI-Math.PI/2
    const val = Math.max(0, Math.min(100, ar.accuracy)) / 100
    return `${CX+R*val*Math.cos(a)},${CY+R*val*Math.sin(a)}`
  }).join(' ')

  const labels = areas.map((ar, i) => {
    const a    = (i/N)*2*Math.PI-Math.PI/2
    const lx   = CX+(R+28)*Math.cos(a), ly = CY+(R+28)*Math.sin(a)
    const acc  = ar.accuracy.toFixed(0)
    const color = ar.accuracy >= 70 ? '#45e0a8' : ar.accuracy >= 50 ? '#f0b54a' : '#e05555'
    return `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="${color}" font-family="monospace" font-weight="600">${ar.subject.slice(0,6)}\n${acc}%</text>`
  }).join('')

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:24px;width:100%;max-width:480px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📡 UPSC READINESS RADAR</span>
        <button id="radar-x" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <svg width="100%" viewBox="0 0 ${W} ${H}" style="max-height:360px;">
        <rect width="${W}" height="${H}" fill="var(--panel-2)" rx="8"/>
        ${rings}${axes}
        <polygon points="${poly}" fill="rgba(240,181,74,.15)" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
        ${labels}
      </svg>
      <p style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:8px;text-align:center;">
        Based on your scores. Green = strong · Gold = developing · Red = needs work
      </p>
    </div>`

  document.body.appendChild(overlay)
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  document.getElementById('radar-x')?.addEventListener('click', () => overlay.remove())
}
