/**
 * jarvis-evolution-v2.ts — JARVIS Self-Evolution Engine V2
 *
 * MAJOR UPGRADES OVER V1:
 * 1. Gap Clustering    — groups semantically similar failures → batch-generate one powerful cap
 * 2. Proactive mode    — anticipates gaps from query history BEFORE they recur
 * 3. Capability testing— validates every generated cap against 3 test inputs
 * 4. Version history   — rollback if a cap degrades in performance
 * 5. Learning ledger   — tracks what types of capabilities JARVIS is good/bad at
 * 6. Self-assessment   — JARVIS knows its own capability areas + confidence levels
 * 7. Drift detection   — auto-retires stale caps that stopped working
 * 8. Meta-prompt tuning— improves the Groq prompt itself based on generation quality
 */

import { type GeneratedCapability, loadCaps, loadGaps, type CapabilityGap,
         isSafeCode, executeCapability } from './jarvis-evolution'

// Re-export the safe-code check for use by other modules
export { isSafeCode }

// ── Types ─────────────────────────────────────────────────────────────────────

interface GapCluster {
  centroid:    string          // representative query
  members:     CapabilityGap[] // all similar gaps
  totalCount:  number
  category:    string
}

interface CapVersion {
  capId:   string
  version: number
  code:    string
  savedAt: string
  metrics: { uses: number; successRate: number }
}

interface LearningLedger {
  area:          string     // e.g. 'navigation', 'form-fill', 'data-read', 'timer'
  genAttempts:   number
  genSuccesses:  number
  avgConfidence: number
  lastUpdated:   string
}

interface CapabilityAssessment {
  area:       string
  confidence: number   // 0-1
  gaps:       number
  caps:       number
  verdict:    'strong' | 'developing' | 'weak'
}

// ── Storage ────────────────────────────────────────────────────────────────────

const V2_VERSIONS_KEY  = 'jarvis_cap_versions_v2'
const V2_LEDGER_KEY    = 'jarvis_ledger_v2'
const V2_HISTORY_KEY   = 'jarvis_query_history_v2'
const V2_PROMPT_KEY    = 'jarvis_metaprompt_v2'
const MAX_HISTORY      = 500
const MAX_VERSIONS     = 100

function loadVersions(): CapVersion[] {
  try { return JSON.parse(localStorage.getItem(V2_VERSIONS_KEY) ?? '[]') }
  catch { return [] }
}
function saveVersions(v: CapVersion[]): void {
  localStorage.setItem(V2_VERSIONS_KEY, JSON.stringify(v.slice(0, MAX_VERSIONS)))
}

function loadLedger(): LearningLedger[] {
  try { return JSON.parse(localStorage.getItem(V2_LEDGER_KEY) ?? '[]') }
  catch { return [] }
}
function saveLedger(l: LearningLedger[]): void {
  localStorage.setItem(V2_LEDGER_KEY, JSON.stringify(l))
}

export function loadQueryHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(V2_HISTORY_KEY) ?? '[]') }
  catch { return [] }
}
export function appendQueryHistory(q: string): void {
  const h = loadQueryHistory()
  h.unshift(q.toLowerCase().trim().slice(0, 150))
  localStorage.setItem(V2_HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)))
}

function loadMetaPromptAdditions(): string {
  return localStorage.getItem(V2_PROMPT_KEY) ?? ''
}
function saveMetaPromptAdditions(s: string): void {
  localStorage.setItem(V2_PROMPT_KEY, s.slice(0, 2000))
}

// ── Gap Clustering ─────────────────────────────────────────────────────────────
// Groups similar gaps using bigram Jaccard similarity (threshold 0.35)

function tokenBigrams(s: string): Set<string> {
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3)
  const set = new Set<string>(words)
  for (let i = 0; i < words.length - 1; i++) set.add(`${words[i]}_${words[i+1]}`)
  return set
}

function gapSimilarity(a: string, b: string): number {
  const sa = tokenBigrams(a), sb = tokenBigrams(b)
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const t of sa) { if (sb.has(t)) inter++ }
  return inter / (sa.size + sb.size - inter)
}

export function clusterGaps(gaps: CapabilityGap[]): GapCluster[] {
  const clusters: GapCluster[] = []
  const used = new Set<number>()

  for (let i = 0; i < gaps.length; i++) {
    if (used.has(i)) continue
    const cluster: GapCluster = {
      centroid:   gaps[i].query,
      members:    [gaps[i]],
      totalCount: gaps[i].count,
      category:   gaps[i].category,
    }
    used.add(i)

    for (let j = i + 1; j < gaps.length; j++) {
      if (used.has(j)) continue
      if (gapSimilarity(gaps[i].query, gaps[j].query) >= 0.35) {
        cluster.members.push(gaps[j])
        cluster.totalCount += gaps[j].count
        used.add(j)
        // Re-centroid to highest-count member
        if (gaps[j].count > cluster.members[0].count) cluster.centroid = gaps[j].query
      }
    }
    clusters.push(cluster)
  }

  return clusters.sort((a, b) => b.totalCount - a.totalCount)
}

// ── Proactive gap anticipation ─────────────────────────────────────────────────
// Looks at recent query history → predicts next likely gaps → pre-generates

export function anticipateNextGaps(): string[] {
  const history = loadQueryHistory().slice(0, 100)
  if (history.length < 10) return []

  // Find topic clusters in recent history
  const topicFreq: Record<string, number> = {}
  const TOPIC_RE: Record<string, RegExp> = {
    polity:       /polity|constitution|article|parliament|president|governor/i,
    history:      /history|mughal|british|gandhi|independence|freedom/i,
    geography:    /geography|monsoon|river|soil|climate|physical/i,
    economy:      /economy|gdp|rbi|gst|budget|fiscal|inflation/i,
    environment:  /environment|climate|biodiversity|pollution|forest|wildlife/i,
    timer:        /timer|session|focus|pomodoro|study.*start/i,
    scores:       /score|marks|result|mock|prelims|accuracy/i,
    revision:     /revision|revise|srs|spaced|due/i,
  }

  for (const q of history) {
    for (const [topic, re] of Object.entries(TOPIC_RE)) {
      if (re.test(q)) topicFreq[topic] = (topicFreq[topic] ?? 0) + 1
    }
  }

  // Top topic that doesn't have many capabilities yet
  const caps = loadCaps()
  return Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([topic]) => caps.filter(c => c.description.toLowerCase().includes(topic)).length < 3)
    .map(([topic]) => `Help me with ${topic} in my UPSC preparation`)
}

// ── Capability version history ─────────────────────────────────────────────────

export function versionCap(cap: GeneratedCapability): void {
  const versions = loadVersions()
  const existing = versions.filter(v => v.capId === cap.id)
  versions.unshift({
    capId:   cap.id,
    version: (existing[0]?.version ?? 0) + 1,
    code:    cap.code,
    savedAt: new Date().toISOString(),
    metrics: { uses: cap.useCount, successRate: cap.successRate },
  })
  saveVersions(versions)
}

export function rollbackCap(capId: string): boolean {
  const caps     = loadCaps()
  const versions = loadVersions()
  const prev     = versions.filter(v => v.capId === capId).sort((a, b) => b.version - a.version)[1]
  if (!prev) return false

  const idx = caps.findIndex(c => c.id === capId)
  if (idx >= 0) { caps[idx].code = prev.code; caps[idx].successRate = prev.metrics.successRate; localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(caps)) }
  return true
}

// ── Capability testing ─────────────────────────────────────────────────────────
// Before saving, test a generated cap against 3 simulated queries.

export async function testCapability(cap: GeneratedCapability): Promise<{ pass: boolean; score: number }> {
  let successes = 0
  const testCases = [cap.source, cap.trigger, `please ${cap.source}`]

  for (const tc of testCases) {
    try {
      const re = new RegExp(cap.pattern, 'i')
      if (re.test(tc)) successes++
    } catch { /* invalid regex */ }
  }

  // Execute and check no error
  const result = executeCapability(cap)
  if (result.ok) successes++

  const score = successes / (testCases.length + 1)
  return { pass: score >= 0.5, score }
}

// ── Learning ledger ────────────────────────────────────────────────────────────

export function updateLedger(area: string, success: boolean, confidence: number): void {
  const ledger = loadLedger()
  const idx    = ledger.findIndex(l => l.area === area)
  if (idx >= 0) {
    const l = ledger[idx]
    l.genAttempts++
    if (success) l.genSuccesses++
    l.avgConfidence = (l.avgConfidence * (l.genAttempts - 1) + confidence) / l.genAttempts
    l.lastUpdated   = new Date().toISOString()
  } else {
    ledger.push({ area, genAttempts: 1, genSuccesses: success ? 1 : 0, avgConfidence: confidence, lastUpdated: new Date().toISOString() })
  }
  saveLedger(ledger)
}

export function assessCapabilityAreas(): CapabilityAssessment[] {
  const ledger = loadLedger()
  const caps   = loadCaps()
  const gaps   = loadGaps()

  const areas = ['navigation', 'timer', 'form-fill', 'data-read', 'scores', 'planner', 'revision', 'knowledge']

  return areas.map(area => {
    const l        = ledger.find(x => x.area === area)
    const areaCaps = caps.filter(c => c.description.toLowerCase().includes(area) || c.source.toLowerCase().includes(area)).length
    const areaGaps = gaps.filter(g => g.category === area && !g.attempted).length
    const conf     = l ? l.genSuccesses / Math.max(1, l.genAttempts) : (areaCaps > 2 ? 0.7 : 0.3)

    return {
      area,
      confidence: conf,
      gaps:       areaGaps,
      caps:       areaCaps,
      verdict:    (conf >= 0.7 ? 'strong' : conf >= 0.4 ? 'developing' : 'weak') as 'strong' | 'developing' | 'weak',
    }
  }).sort((a, b) => b.confidence - a.confidence)
}

// ── Drift detection ────────────────────────────────────────────────────────────
// Auto-retires caps with successRate < 0.15 and useCount > 5 (they're broken)

export function pruneStaleCapabilities(): number {
  const caps    = loadCaps()
  const before  = caps.length
  const healthy = caps.filter(c => !(c.useCount > 5 && c.successRate < 0.15))
  localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(healthy))
  return before - healthy.length
}

// ── Meta-prompt tuning ─────────────────────────────────────────────────────────
// When capabilities keep failing for an area, adjust the generation prompt.

export function refineGenerationPrompt(area: string, failReason: string): void {
  const current = loadMetaPromptAdditions()
  const addition = `\n[${area} note]: Avoid ${failReason.slice(0, 100)}.`
  saveMetaPromptAdditions((current + addition).slice(-2000))
}

export function getMetaPromptAdditions(): string {
  return loadMetaPromptAdditions()
}

// ── Enhanced generation with V2 features ──────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

const BASE_APP_CONTEXT = `
You are writing JavaScript for Mission 2028 — a UPSC preparation web app.
Available DOM helpers (as function arguments):
  click(selector)       — clicks an element by CSS selector
  fill(selector, value) — fills an input by CSS selector
  scroll(sectionId)     — scrolls to a section: 'plan','intel','engine','routine-section','constitution-section'
  read(selector)        — returns text content of an element
  toast(msg, type)      — shows a toast: type = 'success'|'error'|'info'|'warn'

Key element selectors:
  '#lp-search' = planner search, '#ai-gen' = generate plan button,
  '[data-act="start"]' = timer start/pause, '[data-act="reset"]' = timer reset,
  '#rtn-study-hours' = study hours input, '#rtn-day-type' = day type select,
  '#rtn-save' = save routine button, '.plan-row:not(.done)' = next lecture,
  '#rank-num' = rank number, '#streak-num' = streak counter

Rules: No fetch. No XMLHttpRequest. No eval. No localStorage.clear. Code under 400 chars.
`

export async function generateCapabilityV2(
  cluster: GapCluster,
  respond: (text: string) => void,
): Promise<GeneratedCapability | null> {
  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) return null

  const metaAdditions = getMetaPromptAdditions()
  const allExamples   = cluster.members.slice(0, 3).map(m => `"${m.query}"`).join(', ')

  const prompt = `${BASE_APP_CONTEXT}${metaAdditions}

Generate a JavaScript capability to handle these user requests:
${allExamples}

They all want to: ${cluster.centroid}

Return ONLY valid JSON (no markdown, no code block):
{
  "pattern": "regex string matching all variations",
  "code": "javascript function body using only click/fill/scroll/read/toast",
  "description": "one-line description of what it does"
}

The pattern should match all ${cluster.members.length} example(s) above.
The code must be short, direct, and use only the helper functions.`

  try {
    const res = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.2, stream: false }),
    })
    if (!res.ok) throw new Error(`Groq ${res.status}`)
    const d    = await res.json() as { choices: { message: { content: string } }[] }
    const text = d.choices[0]?.message?.content?.trim() ?? ''

    // Robust JSON extraction
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) { console.warn('[evo-v2] No JSON in response'); return null }

    const parsed = JSON.parse(jsonMatch[0]) as { pattern: string; code: string; description: string }
    if (!parsed.pattern || !parsed.code || !parsed.description) return null

    // Safety check
    const { safe, reason } = isSafeCode(parsed.code)
    if (!safe) {
      refineGenerationPrompt(cluster.category, `generated unsafe code: ${reason}`)
      return null
    }

    // Validate regex
    try { new RegExp(parsed.pattern, 'i') } catch {
      refineGenerationPrompt(cluster.category, 'generated invalid regex')
      return null
    }

    const id = Math.abs(cluster.centroid.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)).toString(36)

    const cap: GeneratedCapability = {
      id, trigger: cluster.centroid, pattern: parsed.pattern,
      code: parsed.code, description: parsed.description,
      source: cluster.members.map(m => m.query).join(' | ').slice(0, 300),
      createdAt: new Date().toISOString(), useCount: 0, successRate: 0.5,
    }

    // V2: Test before saving
    const { pass, score } = await testCapability(cap)
    if (!pass) {
      console.warn(`[evo-v2] Capability failed testing (score=${score.toFixed(2)})`, parsed)
      refineGenerationPrompt(cluster.category, `capability failed test with score ${score.toFixed(2)}`)
      updateLedger(cluster.category, false, 0.2)
      return null
    }

    // V2: Version it
    versionCap(cap)

    // Save
    const existingCaps = loadCaps()
    existingCaps.unshift(cap)
    localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(existingCaps.slice(0, 200)))

    // Mark ALL cluster members as attempted
    const gaps = loadGaps()
    for (const m of cluster.members) {
      const idx = gaps.findIndex(g => g.query === m.query)
      if (idx >= 0) gaps[idx].attempted = true
    }
    localStorage.setItem('jarvis_gaps_v2', JSON.stringify(gaps.slice(0, 300)))

    updateLedger(cluster.category, true, score)
    respond(`✓ New capability (v2): "${parsed.description}" — tested & validated (score: ${(score*100).toFixed(0)}%)`)
    return cap

  } catch (e) {
    console.error('[evo-v2] generation failed:', e)
    updateLedger(cluster.category, false, 0)
    return null
  }
}

// ── V2 Evolution Loop ──────────────────────────────────────────────────────────

let _v2LoopId = 0

export function startEvolutionLoopV2(respond: (text: string) => void): void {
  if (_v2LoopId) return

  _v2LoopId = window.setInterval(async () => {
    const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
    if (!key) return

    // Prune stale caps
    const pruned = pruneStaleCapabilities()
    if (pruned > 0) console.info(`[evo-v2] Pruned ${pruned} stale capabilities`)

    // Cluster all unattempted gaps
    const rawGaps   = loadGaps().filter(g => !g.attempted && g.count >= 1)
    const clusters  = clusterGaps(rawGaps).slice(0, 3)

    for (const cluster of clusters) {
      if (cluster.totalCount < 2) continue
      await generateCapabilityV2(cluster, () => {})  // silent
      await new Promise(r => setTimeout(r, 3000))
    }

    // Proactive: anticipate and pre-generate for hot topics
    const anticipated = anticipateNextGaps()
    for (const query of anticipated.slice(0, 1)) {  // 1 per cycle
      const fakeGap: CapabilityGap = { query, count: 2, lastAt: new Date().toISOString(), category: 'knowledge', attempted: false }
      await generateCapabilityV2({ centroid: query, members: [fakeGap], totalCount: 2, category: 'knowledge' }, () => {})
      await new Promise(r => setTimeout(r, 3000))
    }

  }, 5 * 60_000)  // every 5 minutes
}

export function stopEvolutionLoopV2(): void {
  if (_v2LoopId) { clearInterval(_v2LoopId); _v2LoopId = 0 }
}

// ── V2 Report ──────────────────────────────────────────────────────────────────

export interface V2Report {
  capsTotal:       number
  capsValidated:   number
  capVersions:     number
  gapsClustered:   number
  ledgerAreas:     LearningLedger[]
  assessments:     CapabilityAssessment[]
  anticipatedGaps: string[]
  topCaps:         string[]
}

export function getV2Report(): V2Report {
  const caps        = loadCaps()
  const rawGaps     = loadGaps().filter(g => !g.attempted)
  const clusters    = clusterGaps(rawGaps)
  const versions    = loadVersions()
  const ledger      = loadLedger()
  const assessments = assessCapabilityAreas()
  const anticipated = anticipateNextGaps()

  return {
    capsTotal:       caps.length,
    capsValidated:   caps.filter(c => c.successRate >= 0.5).length,
    capVersions:     versions.length,
    gapsClustered:   clusters.length,
    ledgerAreas:     ledger,
    assessments,
    anticipatedGaps: anticipated,
    topCaps:         caps.slice(0, 5).map(c => c.description),
  }
}
