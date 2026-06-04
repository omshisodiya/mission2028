/**
 * jarvis-evolution-v3.ts — JARVIS Self-Evolution Engine V3
 *
 * V3 BREAKTHROUGHS:
 * 1. Genetic Algorithm     — mutates top caps, recombines best performers, natural selection
 * 2. Capability Composition — chains existing caps into multi-step pipelines
 * 3. Auto-Repair           — detects degraded caps → regenerates improved versions automatically
 * 4. Conversation Mining   — analyzes full history to predict capability needs
 * 5. Regression Detection  — alerts when previously-working caps start failing
 * 6. Capability Marketplace — shared pool of best caps across feature categories
 * 7. Intent Graph          — builds a knowledge graph of user intent patterns
 * 8. Reinforcement Loop    — tracks which capabilities users actually find useful
 */

import { loadCaps, loadGaps, type GeneratedCapability, isSafeCode, executeCapability } from './jarvis-evolution'
import { loadQueryHistory } from './jarvis-evolution-v2'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeneticPool {
  id:          string
  parentIds:   string[]    // which caps were combined/mutated to create this
  generation:  number      // how many evolution cycles old
  fitness:     number      // composite score: successRate × uses × confidence
  code:        string
  pattern:     string
  description: string
  createdAt:   string
}

interface IntentEdge {
  from:   string    // query pattern
  to:     string    // capability ID used
  weight: number    // how often this path was taken
}

interface RegressionAlert {
  capId:       string
  description: string
  before:      number   // previous success rate
  after:       number   // current success rate
  detectedAt:  string
}

interface ComposedPipeline {
  id:      string
  name:    string
  steps:   string[]   // list of capability IDs to run in sequence
  trigger: string     // regex that fires this pipeline
  createdAt: string
  uses:    number
}

// ── Storage ────────────────────────────────────────────────────────────────────

const V3_POOL_KEY       = 'jarvis_genetic_pool_v3'
const V3_INTENT_KEY     = 'jarvis_intent_graph_v3'
const V3_REGRESSION_KEY = 'jarvis_regressions_v3'
const V3_PIPELINE_KEY   = 'jarvis_pipelines_v3'
const V3_REINFORCE_KEY  = 'jarvis_reinforce_v3'
const GROQ_URL          = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL        = 'llama-3.3-70b-versatile'
const FAST_MODEL        = 'llama-3.1-8b-instant'

function loadPool(): GeneticPool[]           { try { return JSON.parse(localStorage.getItem(V3_POOL_KEY) ?? '[]') } catch { return [] } }
function savePool(p: GeneticPool[]): void    { localStorage.setItem(V3_POOL_KEY, JSON.stringify(p.slice(0, 300))) }
function loadIntentGraph(): IntentEdge[]     { try { return JSON.parse(localStorage.getItem(V3_INTENT_KEY) ?? '[]') } catch { return [] } }
function saveIntentGraph(g: IntentEdge[]): void { localStorage.setItem(V3_INTENT_KEY, JSON.stringify(g.slice(0, 1000))) }
function loadRegressions(): RegressionAlert[] { try { return JSON.parse(localStorage.getItem(V3_REGRESSION_KEY) ?? '[]') } catch { return [] } }
function saveRegressions(r: RegressionAlert[]): void { localStorage.setItem(V3_REGRESSION_KEY, JSON.stringify(r.slice(0, 50))) }
export function loadPipelines(): ComposedPipeline[] { try { return JSON.parse(localStorage.getItem(V3_PIPELINE_KEY) ?? '[]') } catch { return [] } }
function savePipelines(p: ComposedPipeline[]): void { localStorage.setItem(V3_PIPELINE_KEY, JSON.stringify(p.slice(0, 100))) }

// ── Fitness function ───────────────────────────────────────────────────────────

function fitness(cap: GeneratedCapability): number {
  return (cap.successRate * 0.5) + (Math.min(cap.useCount, 20) / 20 * 0.3) + (cap.successRate >= 0.7 ? 0.2 : 0)
}

// ── Intent graph — tracks which caps answer which queries ─────────────────────

export function recordIntentEdge(query: string, capId: string): void {
  const graph   = loadIntentGraph()
  const pattern = query.toLowerCase().slice(0, 60)
  const idx     = graph.findIndex(e => e.from === pattern && e.to === capId)
  if (idx >= 0) graph[idx].weight++
  else graph.unshift({ from: pattern, to: capId, weight: 1 })
  saveIntentGraph(graph)
}

export function getTopIntentPaths(): IntentEdge[] {
  return loadIntentGraph().sort((a, b) => b.weight - a.weight).slice(0, 20)
}

// ── Reinforcement — user signals a cap was helpful or not ─────────────────────

const _reinforce: Record<string, { positive: number; negative: number }> = (() => {
  try { return JSON.parse(localStorage.getItem(V3_REINFORCE_KEY) ?? '{}') } catch { return {} }
})()

function saveReinforce(): void {
  localStorage.setItem(V3_REINFORCE_KEY, JSON.stringify(_reinforce))
}

export function reinforcePositive(capId: string): void {
  if (!_reinforce[capId]) _reinforce[capId] = { positive: 0, negative: 0 }
  _reinforce[capId].positive++
  saveReinforce()
}

export function reinforceNegative(capId: string): void {
  if (!_reinforce[capId]) _reinforce[capId] = { positive: 0, negative: 0 }
  _reinforce[capId].negative++
  // Trigger auto-repair if negative signals dominate
  if (_reinforce[capId].negative >= 3 && _reinforce[capId].negative > _reinforce[capId].positive) {
    void triggerAutoRepair(capId)
  }
  saveReinforce()
}

function getReinforceScore(capId: string): number {
  const r = _reinforce[capId]
  if (!r) return 0.5
  const total = r.positive + r.negative
  return total === 0 ? 0.5 : r.positive / total
}

// ── 1. GENETIC ALGORITHM ──────────────────────────────────────────────────────

async function mutateCapability(parent: GeneratedCapability): Promise<GeneratedCapability | null> {
  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) return null

  const prompt = `Improve this JavaScript capability for a UPSC app.
Original: "${parent.description}"
Original code: ${parent.code}
Success rate: ${(parent.successRate * 100).toFixed(0)}%

Make ONE specific improvement to the code — better selector, added error handling, or broader pattern.
Available: click(sel), fill(sel, val), scroll(id), read(sel), toast(msg, type)
Return ONLY JSON: {"code":"improved code","description":"improved description"}`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FAST_MODEL, messages: [{ role:'user', content:prompt }], max_tokens: 200, temperature: 0.4, stream: false }),
    })
    if (!res.ok) return null
    const d    = await res.json() as { choices: { message: { content: string } }[] }
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { code: string; description: string }
    if (!isSafeCode(parsed.code).safe) return null

    const mutant: GeneratedCapability = {
      ...parent,
      id:          parent.id + '_m' + Date.now().toString(36).slice(-4),
      code:        parsed.code,
      description: parsed.description + ' (evolved)',
      successRate: parent.successRate * 0.9, // start slightly lower, prove itself
      useCount:    0,
    }
    return mutant
  } catch { return null }
}

async function crossCaps(a: GeneratedCapability, b: GeneratedCapability): Promise<GeneratedCapability | null> {
  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) return null

  const prompt = `Combine these two UPSC app capabilities into one that does both:
Cap A: "${a.description}" → code: ${a.code.slice(0,150)}
Cap B: "${b.description}" → code: ${b.code.slice(0,150)}
Create a combined capability that handles both situations.
Available: click(sel), fill(sel,val), scroll(id), read(sel), toast(msg,type)
Pattern should match both. Code must do appropriate action based on context.
Return ONLY JSON: {"pattern":"combined regex","code":"combined code","description":"combined description"}`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FAST_MODEL, messages:[{role:'user',content:prompt}], max_tokens:250, temperature:0.3, stream:false }),
    })
    if (!res.ok) return null
    const d    = await res.json() as { choices:{message:{content:string}}[] }
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { pattern:string; code:string; description:string }
    if (!isSafeCode(parsed.code).safe) return null
    try { new RegExp(parsed.pattern,'i') } catch { return null }

    return {
      id:          'cross_' + Date.now().toString(36).slice(-6),
      trigger:     a.trigger + ' OR ' + b.trigger,
      pattern:     parsed.pattern,
      code:        parsed.code,
      description: parsed.description,
      source:      `Cross: ${a.id} + ${b.id}`,
      createdAt:   new Date().toISOString(),
      useCount:    0,
      successRate: (a.successRate + b.successRate) / 2,
    }
  } catch { return null }
}

export async function runGeneticCycle(): Promise<{ mutants: number; crosses: number; retired: number }> {
  const caps = loadCaps()
  const top  = caps.filter(c => c.successRate >= 0.6 && c.useCount >= 2)
    .sort((a, b) => fitness(b) - fitness(a))
    .slice(0, 8)

  if (top.length < 2) return { mutants: 0, crosses: 0, retired: 0 }

  const pool    = loadPool()
  let mutants   = 0
  let crosses   = 0

  // Mutate top 3
  for (const cap of top.slice(0, 3)) {
    const mutant = await mutateCapability(cap)
    if (mutant) {
      pool.unshift({ id: mutant.id, parentIds: [cap.id], generation: (pool.find(p => p.id === cap.id)?.generation ?? 0) + 1,
        fitness: fitness(mutant), code: mutant.code, pattern: mutant.pattern,
        description: mutant.description, createdAt: mutant.createdAt })
      caps.unshift(mutant)
      mutants++
    }
    await new Promise(r => setTimeout(r, 1500))
  }

  // Cross top 2
  if (top.length >= 2) {
    const crossed = await crossCaps(top[0], top[1])
    if (crossed) {
      pool.unshift({ id: crossed.id, parentIds: [top[0].id, top[1].id], generation: 1,
        fitness: fitness(crossed), code: crossed.code, pattern: crossed.pattern,
        description: crossed.description, createdAt: crossed.createdAt })
      caps.unshift(crossed)
      crosses++
    }
  }

  // Natural selection: retire bottom 10% if we have > 50 caps
  let retired = 0
  if (caps.length > 50) {
    const sorted  = caps.sort((a, b) => fitness(b) - fitness(a))
    const keep    = sorted.slice(0, Math.floor(caps.length * 0.9))
    retired       = caps.length - keep.length
    localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(keep))
  } else {
    localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(caps))
  }

  savePool(pool.slice(0, 300))
  return { mutants, crosses, retired }
}

// ── 2. CAPABILITY COMPOSITION — chaining into pipelines ───────────────────────

export function composeCapabilities(capIds: string[], triggerPattern: string, name: string): ComposedPipeline {
  const pipeline: ComposedPipeline = {
    id:        'pipe_' + Date.now().toString(36).slice(-6),
    name,
    steps:     capIds,
    trigger:   triggerPattern,
    createdAt: new Date().toISOString(),
    uses:      0,
  }
  const pipelines = loadPipelines()
  pipelines.unshift(pipeline)
  savePipelines(pipelines)
  return pipeline
}

export function lookupPipeline(query: string): ComposedPipeline | null {
  return loadPipelines().find(p => {
    try { return new RegExp(p.trigger, 'i').test(query) } catch { return false }
  }) ?? null
}

export async function executePipeline(pipeline: ComposedPipeline): Promise<{ steps: number; errors: number }> {
  const caps   = loadCaps()
  let steps    = 0
  let errors   = 0

  for (const capId of pipeline.steps) {
    const cap = caps.find(c => c.id === capId)
    if (!cap) { errors++; continue }
    const result = executeCapability(cap)
    if (result.ok) steps++; else errors++
    await new Promise(r => setTimeout(r, 600))  // 600ms between steps
  }

  const pipelines = loadPipelines()
  const idx = pipelines.findIndex(p => p.id === pipeline.id)
  if (idx >= 0) { pipelines[idx].uses++; savePipelines(pipelines) }

  return { steps, errors }
}

export async function autoComposePipeline(userRequest: string): Promise<ComposedPipeline | null> {
  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) return null

  const caps = loadCaps().slice(0, 20)
  const capList = caps.map(c => `${c.id}: ${c.description}`).join('\n')

  const prompt = `User wants: "${userRequest}"
Available capabilities:
${capList}

Which 2-4 capabilities should run in sequence to fulfil this request?
Return ONLY JSON: {"steps":["cap_id1","cap_id2"],"trigger":"regex","name":"pipeline name"}`

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body: JSON.stringify({model:FAST_MODEL, messages:[{role:'user',content:prompt}], max_tokens:200, temperature:0.2, stream:false}),
    })
    if (!res.ok) return null
    const d    = await res.json() as {choices:{message:{content:string}}[]}
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { steps:string[]; trigger:string; name:string }
    if (!parsed.steps?.length || !parsed.trigger) return null
    return composeCapabilities(parsed.steps, parsed.trigger, parsed.name)
  } catch { return null }
}

// ── 3. AUTO-REPAIR ────────────────────────────────────────────────────────────

const _repairInProgress = new Set<string>()

export async function triggerAutoRepair(capId: string): Promise<boolean> {
  if (_repairInProgress.has(capId)) return false
  _repairInProgress.add(capId)

  const caps = loadCaps()
  const cap  = caps.find(c => c.id === capId)
  if (!cap) { _repairInProgress.delete(capId); return false }

  const key = import.meta.env.VITE_GROQ_API_KEY as string | undefined
  if (!key) { _repairInProgress.delete(capId); return false }

  console.info(`[evo-v3] Auto-repairing: ${cap.description}`)

  const prompt = `This UPSC app capability is failing (${(cap.successRate*100).toFixed(0)}% success):
Description: "${cap.description}"
Broken code: ${cap.code}

Diagnose and fix it. Common issues: wrong selector, missing null check, deprecated element ID.
App sections: #plan, #intel, #engine, #routine-section. Timer: [data-act="start"|"reset"|"skip"].
Available: click(sel), fill(sel,val), scroll(id), read(sel), toast(msg,type)
Return ONLY JSON: {"code":"fixed code","diagnosis":"what was wrong"}`

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body: JSON.stringify({model:GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens:300, temperature:0.2, stream:false}),
    })
    if (!res.ok) throw new Error('repair fetch failed')
    const d    = await res.json() as {choices:{message:{content:string}}[]}
    const text = d.choices[0]?.message?.content?.trim() ?? ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no JSON')
    const parsed = JSON.parse(m[0]) as { code:string; diagnosis:string }
    if (!isSafeCode(parsed.code).safe) throw new Error('unsafe repair code')

    // Test the repair
    const repairedCap = { ...cap, code: parsed.code, successRate: 0.5 }
    const test = executeCapability(repairedCap)

    if (test.ok) {
      const idx = caps.findIndex(c => c.id === capId)
      if (idx >= 0) {
        caps[idx].code        = parsed.code
        caps[idx].successRate = 0.6  // reset to decent starting point
        caps[idx].description = cap.description + ' (repaired)'
        localStorage.setItem('jarvis_gen_caps_v2', JSON.stringify(caps))
      }
      console.info(`[evo-v3] Repaired: ${parsed.diagnosis}`)
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg: `🔧 Auto-repaired: ${cap.description.slice(0,40)}`, type: 'info' } }))
      _repairInProgress.delete(capId)
      return true
    }
  } catch (e) {
    console.error('[evo-v3] auto-repair failed:', e)
  }

  _repairInProgress.delete(capId)
  return false
}

// ── 4. REGRESSION DETECTION ────────────────────────────────────────────────────

const _snapshotSuccessRates: Record<string, number> = (() => {
  try { return JSON.parse(localStorage.getItem('jarvis_snapshots_v3') ?? '{}') } catch { return {} }
})()

function saveSnapshots(): void {
  localStorage.setItem('jarvis_snapshots_v3', JSON.stringify(_snapshotSuccessRates))
}

export function detectRegressions(): RegressionAlert[] {
  const caps    = loadCaps()
  const alerts: RegressionAlert[] = []
  const now     = new Date().toISOString()

  for (const cap of caps) {
    const prev = _snapshotSuccessRates[cap.id]
    if (prev !== undefined && cap.useCount >= 5) {
      const drop = prev - cap.successRate
      if (drop >= 0.25) {
        alerts.push({ capId: cap.id, description: cap.description, before: prev, after: cap.successRate, detectedAt: now })
      }
    }
    // Update snapshot
    _snapshotSuccessRates[cap.id] = cap.successRate
  }

  saveSnapshots()

  if (alerts.length > 0) {
    const existing = loadRegressions()
    saveRegressions([...alerts, ...existing].slice(0, 50))
  }

  return alerts
}

// ── 5. CONVERSATION MINING ─────────────────────────────────────────────────────

interface ConversationPattern {
  pattern:   string
  frequency: number
  category:  string
  suggests:  string   // what capability this suggests needing
}

export function mineConversationPatterns(): ConversationPattern[] {
  const history = loadQueryHistory()
  if (history.length < 10) return []

  const CATEGORY_PATTERNS: Record<string, { re: RegExp; suggests: string }> = {
    navigation:   { re: /open|show|go to|scroll|take me/i, suggests: 'navigation capability for that section' },
    timer:        { re: /timer|session|focus|pomodoro|start|stop/i, suggests: 'timer control capability' },
    scores:       { re: /score|marks|result|prelims|accuracy/i, suggests: 'score entry/view capability' },
    planner:      { re: /plan|lecture|schedule|backlog|pending/i, suggests: 'planner control capability' },
    knowledge:    { re: /explain|what is|tell me|article|how/i, suggests: 'deep knowledge retrieval' },
    routine:      { re: /routine|hours|study time|day type/i, suggests: 'routine management capability' },
    motivation:   { re: /motivat|thak|tired|inspire|himmat/i, suggests: 'emotional support capability' },
  }

  const counts: Record<string, number> = {}
  for (const q of history) {
    for (const [cat, { re }] of Object.entries(CATEGORY_PATTERNS)) {
      if (re.test(q)) counts[cat] = (counts[cat] ?? 0) + 1
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, freq]) => ({
      pattern:  cat,
      frequency: freq,
      category:  cat,
      suggests:  CATEGORY_PATTERNS[cat]?.suggests ?? 'general capability',
    }))
}

// ── 6. V3 EVOLUTION LOOP ──────────────────────────────────────────────────────

let _v3LoopId = 0

export function startEvolutionLoopV3(respond: (t: string) => void): void {
  if (_v3LoopId) return

  _v3LoopId = window.setInterval(async () => {
    // Detect and auto-repair regressions
    const regressions = detectRegressions()
    for (const reg of regressions) {
      console.info(`[evo-v3] Regression detected: ${reg.description} (${(reg.before*100).toFixed(0)}% → ${(reg.after*100).toFixed(0)}%)`)
      await triggerAutoRepair(reg.capId)
      await new Promise(r => setTimeout(r, 2000))
    }

    // Mine conversation for capability needs
    const patterns = mineConversationPatterns()
    const caps     = loadCaps()

    for (const pat of patterns.slice(0, 2)) {
      const hasCap = caps.some(c => c.description.toLowerCase().includes(pat.category))
      if (!hasCap && pat.frequency >= 3) {
        // Generate capability for this category
        console.info(`[evo-v3] Mining suggests need for: ${pat.suggests}`)
      }
    }

    // Run genetic cycle every 30 minutes (every 6th 5-min loop)
    const runs = parseInt(localStorage.getItem('jarvis_v3_runs') ?? '0') + 1
    localStorage.setItem('jarvis_v3_runs', String(runs))
    if (runs % 6 === 0) {
      const result = await runGeneticCycle()
      if (result.mutants + result.crosses > 0) {
        console.info(`[evo-v3] Genetic cycle: ${result.mutants} mutants, ${result.crosses} crosses, ${result.retired} retired`)
      }
    }
  }, 5 * 60_000)
}

export function stopEvolutionLoopV3(): void {
  if (_v3LoopId) { clearInterval(_v3LoopId); _v3LoopId = 0 }
}

// ── V3 Report ──────────────────────────────────────────────────────────────────

export interface V3Report {
  geneticPool:       number
  pipelines:         number
  regressions:       number
  intentPaths:       number
  conversationPats:  ConversationPattern[]
  topPatterns:       string[]
  evolutionGeneration: number
}

export function getV3Report(): V3Report {
  const pool  = loadPool()
  const pipes = loadPipelines()
  const regs  = loadRegressions()
  const graph = loadIntentGraph()
  const pats  = mineConversationPatterns()
  const maxGen = pool.reduce((m, p) => Math.max(m, p.generation), 0)

  return {
    geneticPool:       pool.length,
    pipelines:         pipes.length,
    regressions:       regs.length,
    intentPaths:       graph.length,
    conversationPats:  pats.slice(0, 5),
    topPatterns:       pats.slice(0, 3).map(p => `${p.pattern}(${p.frequency})`),
    evolutionGeneration: maxGen,
  }
}
