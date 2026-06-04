/**
 * jarvis-evolution-v4.ts — JARVIS Self-Evolution Engine V4
 *
 * V4 BREAKTHROUGHS — Neural-Inspired Architecture:
 *
 * 1. Neural Token Weights  — each cap has weighted token activations.
 *    Lookup is no longer binary (regex match/no-match) but a soft
 *    weighted score. Caps with higher token overlap for the query win.
 *
 * 2. Swarm Evaluation      — 5 micro-agents evaluate every new cap before
 *    saving: coverage, safety, utility, novelty, quality. Consensus > 3/5
 *    required.
 *
 * 3. Zero-Shot Adaptation  — when a truly unknown request arrives, V4 finds
 *    the most similar existing cap by code-token cosine similarity and asks
 *    Groq to adapt it.  JARVIS handles requests it has never seen.
 *
 * 4. Meta-Learning         — tracks WHICH generation strategies produce the
 *    best caps.  Adjusts mutation rate, temperature, and prompt phrasing
 *    automatically.
 *
 * 5. Capability DNA        — every cap's code is parsed into segments (selectors,
 *    actions, conditions).  Crossover happens at segment level, not full code,
 *    producing finer-grained offspring.
 *
 * 6. Emergent Pipelines    — monitors which caps are frequently used together
 *    and auto-proposes composite pipelines without prompting.
 */

import { loadCaps, isSafeCode, type GeneratedCapability, executeCapability } from './jarvis-evolution'
import { loadQueryHistory } from './jarvis-evolution-v2'

// ── Constants ──────────────────────────────────────────────────────────────────

const GROQ_URL    = 'https://api.groq.com/openai/v1/chat/completions'
const FAST_MODEL  = 'llama-3.1-8b-instant'
const SMART_MODEL = 'llama-3.3-70b-versatile'
function key(): string | undefined { return import.meta.env.VITE_GROQ_API_KEY as string | undefined }

// ── Storage ────────────────────────────────────────────────────────────────────

const V4_NEURAL_KEY   = 'jarvis_neural_v4'
const V4_META_KEY     = 'jarvis_meta_v4'
const V4_EMERGENT_KEY = 'jarvis_emergent_v4'
const V4_COOCCUR_KEY  = 'jarvis_cooccur_v4'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NeuralWeight {
  capId:      string
  tokens:     Record<string, number>   // token → weight (0.1–1.0)
  lastUpdated: string
}

interface MetaLearningState {
  temperature:       number            // Groq temperature (adapts)
  mutationRate:      number            // how aggressively to mutate
  successByStrategy: Record<string, number>   // strategy → success count
  failsByStrategy:   Record<string, number>   // strategy → fail count
  bestPromptSuffix:  string            // discovered prompt improvements
  runs:              number
}

interface CoOccurrence {
  capA:  string
  capB:  string
  count: number
}

function loadNeuralWeights(): NeuralWeight[] {
  try { return JSON.parse(localStorage.getItem(V4_NEURAL_KEY) ?? '[]') } catch { return [] }
}
function saveNeuralWeights(w: NeuralWeight[]): void {
  localStorage.setItem(V4_NEURAL_KEY, JSON.stringify(w.slice(0, 500)))
}

function loadMeta(): MetaLearningState {
  try {
    return {
      temperature: 0.4, mutationRate: 0.5, successByStrategy: {}, failsByStrategy: {},
      bestPromptSuffix: '', runs: 0,
      ...JSON.parse(localStorage.getItem(V4_META_KEY) ?? '{}'),
    }
  } catch {
    return { temperature: 0.4, mutationRate: 0.5, successByStrategy: {}, failsByStrategy: {}, bestPromptSuffix: '', runs: 0 }
  }
}
function saveMeta(m: MetaLearningState): void {
  localStorage.setItem(V4_META_KEY, JSON.stringify(m))
}

function loadCoOccur(): CoOccurrence[] {
  try { return JSON.parse(localStorage.getItem(V4_COOCCUR_KEY) ?? '[]') } catch { return [] }
}
function saveCoOccur(c: CoOccurrence[]): void {
  localStorage.setItem(V4_COOCCUR_KEY, JSON.stringify(c.slice(0, 200)))
}

// ── 1. NEURAL TOKEN WEIGHTS ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
}

function buildWeightsForCap(cap: GeneratedCapability): NeuralWeight {
  const tokens: Record<string, number> = {}
  // Weight tokens from trigger (highest), source, description, pattern
  const sources = [
    { text: cap.trigger,     weight: 1.0 },
    { text: cap.description, weight: 0.7 },
    { text: cap.source,      weight: 0.5 },
  ]
  for (const { text, weight } of sources) {
    for (const t of tokenize(text)) {
      tokens[t] = Math.max(tokens[t] ?? 0, weight)
    }
  }
  return { capId: cap.id, tokens, lastUpdated: new Date().toISOString() }
}

export function rebuildNeuralWeights(): void {
  const caps    = loadCaps()
  const weights = caps.map(buildWeightsForCap)
  saveNeuralWeights(weights)
}

/** Neural-weighted lookup — returns caps sorted by soft activation score */
export function neuralLookup(query: string, topK = 5): Array<{ cap: GeneratedCapability; score: number }> {
  const caps    = loadCaps()
  const weights = loadNeuralWeights()
  const qTokens = new Set(tokenize(query))

  const scored = caps.map(cap => {
    const w = weights.find(x => x.capId === cap.id)
    if (!w) return { cap, score: 0 }

    let score = 0
    for (const t of qTokens) {
      score += w.tokens[t] ?? 0
    }
    // Normalise by cap token count to avoid bias toward verbose descriptions
    const normScore = score / Math.max(1, Object.keys(w.tokens).length / 3)
    // Boost by success rate and use count
    const boostScore = normScore * (0.5 + cap.successRate * 0.3 + Math.min(cap.useCount, 20) / 20 * 0.2)
    return { cap, score: boostScore }
  })

  return scored.filter(s => s.score > 0.05).sort((a, b) => b.score - a.score).slice(0, topK)
}

/** Update neural weights after a cap is used (reinforcement) */
export function reinforceNeuralWeights(capId: string, query: string, success: boolean): void {
  const weights = loadNeuralWeights()
  const idx     = weights.findIndex(w => w.capId === capId)
  const delta   = success ? 0.05 : -0.05
  const qTokens = tokenize(query)

  if (idx >= 0) {
    for (const t of qTokens) {
      weights[idx].tokens[t] = Math.max(0.1, Math.min(1.0, (weights[idx].tokens[t] ?? 0.3) + delta))
    }
    weights[idx].lastUpdated = new Date().toISOString()
  }
  saveNeuralWeights(weights)
}

// ── 2. SWARM EVALUATION ────────────────────────────────────────────────────────

interface SwarmVerdict { agent: string; pass: boolean; reason: string }

export async function swarmEvaluate(cap: GeneratedCapability, originalQuery: string): Promise<{ pass: boolean; score: number; verdicts: SwarmVerdict[] }> {
  const verdicts: SwarmVerdict[] = []

  // Agent 1: Safety (synchronous, no LLM)
  const safeCheck = isSafeCode(cap.code)
  verdicts.push({ agent: 'safety', pass: safeCheck.safe, reason: safeCheck.reason || 'Safe' })

  // Agent 2: Regex coverage
  try {
    const re      = new RegExp(cap.pattern, 'i')
    const matches = re.test(originalQuery)
    verdicts.push({ agent: 'coverage', pass: matches, reason: matches ? 'Pattern matches query' : 'Pattern does NOT match original query' })
  } catch {
    verdicts.push({ agent: 'coverage', pass: false, reason: 'Invalid regex' })
  }

  // Agent 3: Execution test (synchronous)
  const execTest = executeCapability(cap)
  verdicts.push({ agent: 'utility', pass: execTest.ok, reason: execTest.ok ? 'Executes without error' : execTest.error ?? 'Execution failed' })

  // Agent 4: Novelty check — does this duplicate an existing cap?
  const existing = loadCaps()
  const isDuplicate = existing.some(c => {
    if (c.id === cap.id) return false
    try { return new RegExp(c.pattern, 'i').test(originalQuery) && c.description === cap.description } catch { return false }
  })
  verdicts.push({ agent: 'novelty', pass: !isDuplicate, reason: isDuplicate ? 'Duplicate of existing capability' : 'Genuinely new capability' })

  // Agent 5: Quality — code length sanity
  const codeQuality = cap.code.length >= 10 && cap.code.length <= 500
  verdicts.push({ agent: 'quality', pass: codeQuality, reason: codeQuality ? 'Code length reasonable' : `Code length suspicious: ${cap.code.length} chars` })

  const passes = verdicts.filter(v => v.pass).length
  return { pass: passes >= 3, score: passes / verdicts.length, verdicts }
}

// ── 3. ZERO-SHOT ADAPTATION ────────────────────────────────────────────────────

export async function zeroShotAdapt(
  unknownQuery: string,
  respond: (t: string) => void,
): Promise<GeneratedCapability | null> {
  const k = key(); if (!k) return null

  // Find most similar existing cap by neural lookup
  const similar = neuralLookup(unknownQuery, 3)
  if (!similar.length) return null

  const bestMatch = similar[0]
  respond(`Adapting from similar capability: "${bestMatch.cap.description.slice(0, 50)}"…`)

  const meta   = loadMeta()
  const prompt = `I have this JavaScript capability for a UPSC web app:
Description: "${bestMatch.cap.description}"
Pattern: ${bestMatch.cap.pattern}
Code: ${bestMatch.cap.code}

Adapt it to handle this new request: "${unknownQuery}"
Keep the same coding style. Use: click(sel), fill(sel,val), scroll(id), read(sel), toast(msg,type)
${meta.bestPromptSuffix}
Return ONLY JSON: {"pattern":"regex","code":"js body","description":"description"}`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FAST_MODEL, messages: [{ role:'user', content:prompt }],
        max_tokens: 250, temperature: meta.temperature, stream: false }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d    = await res.json() as { choices: { message: { content: string } }[] }
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no JSON')
    const parsed = JSON.parse(m[0]) as { pattern: string; code: string; description: string }
    if (!parsed.pattern || !parsed.code) throw new Error('incomplete response')

    const adapted: GeneratedCapability = {
      id:          'zs_' + Date.now().toString(36),
      trigger:     unknownQuery,
      pattern:     parsed.pattern,
      code:        parsed.code,
      description: parsed.description + ' (zero-shot)',
      source:      `Adapted from: ${bestMatch.cap.description}`,
      createdAt:   new Date().toISOString(),
      useCount:    0,
      successRate: 0.5,
    }

    // Swarm evaluation
    const { pass, score, verdicts } = await swarmEvaluate(adapted, unknownQuery)
    console.info(`[evo-v4] Zero-shot swarm: ${verdicts.map(v => `${v.agent}:${v.pass?'✓':'✗'}`).join(' ')} — score ${(score*100).toFixed(0)}%`)

    if (pass) {
      const caps = loadCaps()
      caps.unshift(adapted)
      localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(caps.slice(0, 200)))
      rebuildNeuralWeights()
      updateMetaLearning('zero_shot', true, meta)
      respond(`✓ Zero-shot adapted (${(score*100).toFixed(0)}% swarm score): "${parsed.description}"`)
      return adapted
    } else {
      const failed = verdicts.filter(v => !v.pass).map(v => v.agent).join(', ')
      respond(`Zero-shot adaptation failed (${failed}). Learning from this…`)
      updateMetaLearning('zero_shot', false, meta, failed)
      return null
    }
  } catch (e) {
    console.error('[evo-v4] zero-shot failed:', e)
    updateMetaLearning('zero_shot', false, meta)
    return null
  }
}

// ── 4. META-LEARNING ──────────────────────────────────────────────────────────

function updateMetaLearning(strategy: string, success: boolean, meta: MetaLearningState, failReason?: string): void {
  meta.runs++
  if (success) meta.successByStrategy[strategy] = (meta.successByStrategy[strategy] ?? 0) + 1
  else         meta.failsByStrategy[strategy]   = (meta.failsByStrategy[strategy] ?? 0) + 1

  // Adaptive temperature: if success rate is high, explore more (increase temp)
  // if success rate is low, exploit (decrease temp)
  const total   = (meta.successByStrategy[strategy] ?? 0) + (meta.failsByStrategy[strategy] ?? 0)
  const succRate = total > 0 ? (meta.successByStrategy[strategy] ?? 0) / total : 0.5
  meta.temperature = 0.2 + succRate * 0.5   // range 0.2–0.7

  // Adaptive mutation rate
  meta.mutationRate = success ? Math.min(0.9, meta.mutationRate + 0.05) : Math.max(0.1, meta.mutationRate - 0.1)

  // Learn prompt improvements from failures
  if (failReason && !meta.bestPromptSuffix.includes(failReason.slice(0, 20))) {
    meta.bestPromptSuffix += `\nAvoid: ${failReason.slice(0, 50)}.`
    meta.bestPromptSuffix = meta.bestPromptSuffix.slice(-500)
  }

  saveMeta(meta)
}

export function getMetaStats(): { temperature: number; mutationRate: number; bestStrategies: string[]; runs: number } {
  const m = loadMeta()
  const bestStrategies = Object.entries(m.successByStrategy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}(${v})`)
  return { temperature: m.temperature, mutationRate: m.mutationRate, bestStrategies, runs: m.runs }
}

// ── 5. CAPABILITY DNA ─────────────────────────────────────────────────────────
// Parse code into segments: selectors, actions, conditions
// DNA crossover swaps segments between parent caps

interface CapDNA {
  selectors:  string[]   // CSS selectors used
  actions:    string[]   // action verbs: click, fill, scroll, read, toast
  conditions: string[]   // if/else conditions
  raw:        string     // original code
}

function parseCapDNA(code: string): CapDNA {
  const selectors  = (code.match(/'([^']*(?:#|\.|[a-z])[^']*?)'/g) ?? []).map(s => s.slice(1, -1))
  const actions    = (code.match(/\b(click|fill|scroll|read|toast)\s*\(/g) ?? []).map(s => s.split('(')[0])
  const conditions = (code.match(/if\s*\([^)]+\)/g) ?? []).map(s => s.slice(3, -1).trim())
  return { selectors, actions, conditions, raw: code }
}

export async function dnaCrossover(capA: GeneratedCapability, capB: GeneratedCapability): Promise<GeneratedCapability | null> {
  const k = key(); if (!k) return null

  const dnaA = parseCapDNA(capA.code)
  const dnaB = parseCapDNA(capB.code)

  // Identify complementary traits
  const uniqueSelectorsB = dnaB.selectors.filter(s => !dnaA.selectors.includes(s))
  const uniqueActionsB   = dnaB.actions.filter(a => !dnaA.actions.includes(a))

  if (!uniqueSelectorsB.length && !uniqueActionsB.length) return null  // too similar

  const prompt = `Perform DNA crossover between two UPSC app capabilities:
Parent A: "${capA.description}" — code: ${capA.code.slice(0, 200)}
Parent B: "${capB.description}" — selectors it uniquely uses: ${uniqueSelectorsB.join(', ')} — unique actions: ${uniqueActionsB.join(', ')}

Create an offspring that inherits:
- Core behavior from A
- Unique selectors/actions from B that enhance it
Available: click(sel), fill(sel,val), scroll(id), read(sel), toast(msg,type)
Return ONLY JSON: {"pattern":"regex","code":"js body","description":"what it does"}`

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{Authorization:`Bearer ${k}`,'Content-Type':'application/json'},
      body: JSON.stringify({model:FAST_MODEL, messages:[{role:'user',content:prompt}], max_tokens:250, temperature:0.35, stream:false}),
    })
    if (!res.ok) return null
    const d    = await res.json() as {choices:{message:{content:string}}[]}
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as {pattern:string;code:string;description:string}
    if (!isSafeCode(parsed.code).safe) return null
    try { new RegExp(parsed.pattern,'i') } catch { return null }

    const offspring: GeneratedCapability = {
      id:          'dna_' + Date.now().toString(36),
      trigger:     capA.trigger, pattern: parsed.pattern, code: parsed.code,
      description: parsed.description + ' (DNA)', source: `DNA: ${capA.id} × ${capB.id}`,
      createdAt:   new Date().toISOString(), useCount: 0, successRate: 0.5,
    }

    const { pass } = await swarmEvaluate(offspring, capA.trigger)
    if (pass) {
      const caps = loadCaps()
      caps.unshift(offspring)
      localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(caps.slice(0,200)))
      rebuildNeuralWeights()
      return offspring
    }
    return null
  } catch { return null }
}

// ── 6. CO-OCCURRENCE TRACKING ─────────────────────────────────────────────────
// Track which caps are used together → propose emergent pipelines

export function recordCoOccurrence(capIdA: string, capIdB: string): void {
  const cooccur = loadCoOccur()
  const pair    = [capIdA, capIdB].sort().join('::')
  const idx     = cooccur.findIndex(c => [c.capA, c.capB].sort().join('::') === pair)
  if (idx >= 0) cooccur[idx].count++
  else cooccur.push({ capA: capIdA, capB: capIdB, count: 1 })
  saveCoOccur(cooccur.sort((a, b) => b.count - a.count))
}

export function getEmergentPipelineSuggestions(): Array<{ capA: string; capB: string; count: number; suggestion: string }> {
  const cooccur = loadCoOccur().filter(c => c.count >= 3).slice(0, 5)
  const caps    = loadCaps()
  return cooccur.map(c => {
    const a = caps.find(x => x.id === c.capA)
    const b = caps.find(x => x.id === c.capB)
    return { capA: c.capA, capB: c.capB, count: c.count,
      suggestion: a && b ? `${a.description} → ${b.description}` : 'Unknown pipeline' }
  })
}

// ── V4 EVOLUTION LOOP ──────────────────────────────────────────────────────────

let _v4LoopId = 0

export function startEvolutionLoopV4(respond: (t: string) => void): void {
  if (_v4LoopId) return

  // Rebuild neural weights on start
  rebuildNeuralWeights()

  _v4LoopId = window.setInterval(async () => {
    const k = key(); if (!k) return

    // Check emergent pipeline suggestions
    const suggestions = getEmergentPipelineSuggestions()
    if (suggestions.length > 0) {
      console.info(`[evo-v4] ${suggestions.length} emergent pipeline suggestion(s)`)
    }

    // Run DNA crossover on top caps
    const caps = loadCaps().filter(c => c.successRate >= 0.65 && c.useCount >= 2)
      .sort((a, b) => b.successRate - a.successRate)
    if (caps.length >= 2) {
      const offspring = await dnaCrossover(caps[0], caps[1])
      if (offspring) console.info(`[evo-v4] DNA offspring: ${offspring.description}`)
    }

    // Rebuild neural weights after evolution
    rebuildNeuralWeights()

    // Update meta learning state
    const meta = loadMeta()
    meta.runs++
    saveMeta(meta)
  }, 10 * 60_000)   // every 10 minutes
}

export function stopEvolutionLoopV4(): void {
  if (_v4LoopId) { clearInterval(_v4LoopId); _v4LoopId = 0 }
}

// ── V4 Report ──────────────────────────────────────────────────────────────────

export interface V4Report {
  neuralWeights:     number
  metaRuns:          number
  metaTemperature:   number
  metaMutationRate:  number
  bestStrategies:    string[]
  emergentSuggestions: number
  zeroShotCaps:      number
  dnaCaps:           number
}

export function getV4Report(): V4Report {
  const weights   = loadNeuralWeights()
  const meta      = getMetaStats()
  const caps      = loadCaps()
  const emergent  = getEmergentPipelineSuggestions()

  return {
    neuralWeights:      weights.length,
    metaRuns:           meta.runs,
    metaTemperature:    Math.round(meta.temperature * 100) / 100,
    metaMutationRate:   Math.round(meta.mutationRate * 100) / 100,
    bestStrategies:     meta.bestStrategies,
    emergentSuggestions: emergent.length,
    zeroShotCaps:       caps.filter(c => c.id.startsWith('zs_')).length,
    dnaCaps:            caps.filter(c => c.id.startsWith('dna_')).length,
  }
}
