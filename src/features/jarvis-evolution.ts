/**
 * jarvis-evolution.ts — JARVIS Self-Evolution Engine v1
 *
 * JARVIS automatically grows smarter over time by:
 * 1. Tracking every capability gap (failed queries, unmatched patterns)
 * 2. Using Groq to write JavaScript handlers for those gaps
 * 3. Dynamically registering new commands at runtime
 * 4. Running an autonomous improvement cycle in the background
 * 5. Reporting its own growth and remaining gaps
 *
 * This is the system that makes JARVIS perpetually self-improving
 * without any manual code changes.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeneratedCapability {
  id:          string    // hash-based ID
  trigger:     string    // natural-language description of what triggers it
  pattern:     string    // regex pattern string
  code:        string    // JavaScript function body (DOM actions only)
  description: string    // human-readable description
  source:      string    // which failed query inspired it
  createdAt:   string
  useCount:    number
  successRate: number    // 0-1, tracks if it actually works
}

export interface CapabilityGap {
  query:       string
  count:       number
  lastAt:      string
  category:    string   // 'navigation' | 'data' | 'action' | 'knowledge'
  attempted:   boolean  // has evolution been attempted?
}

// ── Storage ────────────────────────────────────────────────────────────────────

const _CAPS_KEY  = 'jarvis_gen_caps_v2'
const _GAPS_KEY  = 'jarvis_gaps_v2'
const _EVOL_KEY  = 'jarvis_evol_state_v1'
const MAX_CAPS   = 200
const MAX_GAPS   = 300

export function loadCaps(): GeneratedCapability[] {
  try { return JSON.parse(localStorage.getItem(_CAPS_KEY) ?? '[]') }
  catch { return [] }
}

function saveCaps(caps: GeneratedCapability[]): void {
  localStorage.setItem(_CAPS_KEY, JSON.stringify(caps.slice(0, MAX_CAPS)))
}

export function loadGaps(): CapabilityGap[] {
  try { return JSON.parse(localStorage.getItem(_GAPS_KEY) ?? '[]') }
  catch { return [] }
}

function saveGaps(gaps: CapabilityGap[]): void {
  localStorage.setItem(_GAPS_KEY, JSON.stringify(gaps.slice(0, MAX_GAPS)))
}

export function logGap(query: string, category = 'action'): void {
  const gaps = loadGaps()
  const norm = query.toLowerCase().trim().slice(0, 200)
  const idx  = gaps.findIndex(g => g.query === norm)
  if (idx >= 0) {
    gaps[idx].count++; gaps[idx].lastAt = new Date().toISOString()
  } else {
    gaps.unshift({ query: norm, count: 1, lastAt: new Date().toISOString(),
      category, attempted: false })
  }
  saveGaps(gaps.sort((a, b) => b.count - a.count))
}

// ── Safe code execution sandbox ────────────────────────────────────────────────
// Only allows DOM operations, toast events, and JARVIS API calls.
// Blocks fetch, XMLHttpRequest, eval re-entry, localStorage.clear, etc.

const BLOCKED_PATTERNS = [
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /localStorage\s*\.\s*clear/,
  /sessionStorage\s*\.\s*clear/,
  /document\s*\.\s*cookie/,
  /window\s*\.\s*location\s*\.\s*(?:href|replace|assign)/,
  /import\s*\(/,
  /require\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/,
  /setTimeout\s*\([^,]+,\s*0\s*\)/,  // prevent 0-delay loops
]

function isSafeCode(code: string): { safe: boolean; reason: string } {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(code)) return { safe: false, reason: `Blocked pattern: ${pat}` }
  }
  if (code.length > 2000) return { safe: false, reason: 'Code too long (max 2000 chars)' }
  return { safe: true, reason: '' }
}

export function executeCapability(cap: GeneratedCapability): { ok: boolean; error?: string } {
  const check = isSafeCode(cap.code)
  if (!check.safe) return { ok: false, error: check.reason }

  try {
    // Provide a safe execution context with only allowed APIs
    const safeCtx = {
      document,
      window: {
        dispatchEvent: window.dispatchEvent.bind(window),
        scrollTo:      window.scrollTo.bind(window),
      },
      toast: (msg: string, type = 'info') => window.dispatchEvent(
        new CustomEvent('app:toast', { detail: { msg, type } })
      ),
      click:  (sel: string) => { const el = document.querySelector<HTMLElement>(sel); el?.click() },
      fill:   (sel: string, val: string) => {
        const el = document.querySelector<HTMLInputElement>(sel)
        if (!el) return
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
        if (setter) setter.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      scroll: (id: string) => document.getElementById(id)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      read:   (sel: string) => document.querySelector<HTMLElement>(sel)?.textContent?.trim() ?? '',
    }

    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(safeCtx), `"use strict";\n${cap.code}`)
    fn(...Object.values(safeCtx))

    // Update success stats
    const caps = loadCaps()
    const idx  = caps.findIndex(c => c.id === cap.id)
    if (idx >= 0) {
      caps[idx].useCount++
      caps[idx].successRate = Math.min(1, caps[idx].successRate + 0.1)
      saveCaps(caps)
    }
    return { ok: true }
  } catch (e) {
    // Reduce confidence on failure
    const caps = loadCaps()
    const idx  = caps.findIndex(c => c.id === cap.id)
    if (idx >= 0) {
      caps[idx].successRate = Math.max(0, caps[idx].successRate - 0.2)
      saveCaps(caps)
    }
    return { ok: false, error: String(e) }
  }
}

// ── Similarity matcher for generated capabilities ─────────────────────────────

function capMatches(cap: GeneratedCapability, query: string): boolean {
  try {
    return new RegExp(cap.pattern, 'i').test(query)
  } catch { return false }
}

export function lookupGeneratedCap(query: string): GeneratedCapability | null {
  const caps = loadCaps().filter(c => c.successRate >= 0.3)
  return caps.find(c => capMatches(c, query)) ?? null
}

// ── Groq-powered capability generation ────────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

function getGroqKey(): string | undefined {
  return import.meta.env.VITE_GROQ_API_KEY as string | undefined
}

const APP_CONTEXT = `
You are writing JavaScript code for a UPSC preparation web app called Mission 2028.
The app has these sections (accessible by scrollIntoView):
- #engine: Focus timer (Pomodoro)
- #plan: Lecture planner with filter buttons
- #intel: Intelligence / analytics section
- #routine-section: Daily routine inputs
- #constitution-section: Indian Constitution browser
DOM helpers available as function arguments: click(selector), fill(selector, value),
scroll(sectionId), read(selector), toast(message, type).
Only use DOM manipulation. No fetch. No external calls. Keep code under 400 chars.
`

export async function generateCapabilityFromGap(
  gap: CapabilityGap,
  respond: (text: string) => void
): Promise<GeneratedCapability | null> {
  const key = getGroqKey()
  if (!key) return null

  respond(`Analyzing gap: "${gap.query.slice(0, 60)}…" and generating a new capability…`)

  const prompt = `${APP_CONTEXT}

User asked: "${gap.query}"
This request was not handled. Write a short JavaScript function body (no function declaration)
that would handle this request using the available DOM helpers.

Return ONLY a JSON object with these exact keys:
{
  "pattern": "<regex string to match this and similar queries>",
  "code": "<javascript function body using only the allowed helpers>",
  "description": "<one line what it does>"
}

Important: pattern must be a valid regex. code must use only: click(), fill(), scroll(), read(), toast().`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400, temperature: 0.3, stream: false,
      }),
    })
    if (!res.ok) return null
    const d = await res.json() as { choices: { message: { content: string } }[] }
    const raw = d.choices[0]?.message?.content ?? ''

    // Extract JSON from response
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { pattern: string; code: string; description: string }

    // Safety check
    const check = isSafeCode(parsed.code)
    if (!check.safe) {
      console.warn('[evolution] Generated code failed safety check:', check.reason)
      return null
    }

    // Test the regex is valid
    try { new RegExp(parsed.pattern, 'i') } catch { return null }

    const cap: GeneratedCapability = {
      id:          Math.abs(gap.query.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)).toString(36),
      trigger:     gap.query,
      pattern:     parsed.pattern,
      code:        parsed.code,
      description: parsed.description,
      source:      gap.query,
      createdAt:   new Date().toISOString(),
      useCount:    0,
      successRate: 0.5,
    }

    // Save it
    const caps = loadCaps()
    caps.unshift(cap)
    saveCaps(caps)

    // Mark gap as attempted
    const gaps = loadGaps()
    const idx  = gaps.findIndex(g => g.query === gap.query)
    if (idx >= 0) { gaps[idx].attempted = true; saveGaps(gaps) }

    respond(`New capability created: "${parsed.description}" — executing now…`)
    return cap
  } catch (e) {
    console.error('[evolution] generateCapability failed:', e)
    return null
  }
}

// ── Autonomous improvement loop ────────────────────────────────────────────────
// Runs in background every 15 min of idle time.
// Generates capabilities for the top 3 unattempted gaps.

let _evolLoopId = 0
let _lastEvolMs = 0

export function startEvolutionLoop(respond: (text: string) => void): void {
  if (_evolLoopId) return

  _evolLoopId = window.setInterval(async () => {
    const now = Date.now()
    if (now - _lastEvolMs < 15 * 60_000) return  // min 15 min between runs

    const key = getGroqKey()
    if (!key) return

    const gaps = loadGaps()
      .filter(g => !g.attempted && g.count >= 2)
      .slice(0, 2)   // process 2 per cycle to save quota

    if (!gaps.length) return
    _lastEvolMs = now

    for (const gap of gaps) {
      const cap = await generateCapabilityFromGap(gap, () => {})  // silent in background
      if (cap) {
        console.info(`[evolution] Generated capability: ${cap.description}`)
      }
      await new Promise(r => setTimeout(r, 2000))  // rate limit
    }

    // Log evolution state
    const state = { lastRun: new Date().toISOString(), capsTotal: loadCaps().length, gapsTotal: loadGaps().length }
    localStorage.setItem(_EVOL_KEY, JSON.stringify(state))
  }, 60_000)  // check every 1 min, execute every 15 min
}

export function stopEvolutionLoop(): void {
  if (_evolLoopId) { clearInterval(_evolLoopId); _evolLoopId = 0 }
}

// ── Self-diagnosis report ──────────────────────────────────────────────────────

export interface EvolutionReport {
  capsTotal:     number
  capsHighConf:  number
  gapsTotal:     number
  gapsAttempted: number
  topGaps:       string[]
  recentCaps:    string[]
  lastRun:       string
}

export function getEvolutionReport(): EvolutionReport {
  const caps  = loadCaps()
  const gaps  = loadGaps()
  const state = (() => {
    try { return JSON.parse(localStorage.getItem(_EVOL_KEY) ?? '{}') as { lastRun?: string } }
    catch { return {} }
  })()

  return {
    capsTotal:     caps.length,
    capsHighConf:  caps.filter(c => c.successRate >= 0.7).length,
    gapsTotal:     gaps.length,
    gapsAttempted: gaps.filter(g => g.attempted).length,
    topGaps:       gaps.filter(g => !g.attempted).slice(0, 5).map(g => `"${g.query.slice(0, 40)}" (${g.count}x)`),
    recentCaps:    caps.slice(0, 5).map(c => c.description),
    lastRun:       state.lastRun ?? 'never',
  }
}

// ── Multi-step task decomposer ─────────────────────────────────────────────────
// Breaks complex requests into sub-tasks and executes them sequentially.

export async function decomposeAndExecute(
  task: string,
  respond: (text: string) => void,
  executeSubtask: (subtask: string) => Promise<void>
): Promise<void> {
  const key = getGroqKey()
  if (!key) { respond('Cannot decompose complex task without Groq API key.'); return }

  respond(`Breaking down: "${task.slice(0, 60)}…"`)

  const prompt = `Break this UPSC app task into 2-4 sequential sub-steps:
"${task}"
Available actions: open sections (plan, intel, engine, routine, constitution),
click buttons, fill forms, show scores, set timer, filter lectures, open panels.
Return ONLY a JSON array of step strings: ["step 1", "step 2", ...]`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200, temperature: 0.2, stream: false,
      }),
    })
    if (!res.ok) throw new Error('Groq failed')
    const d = await res.json() as { choices: { message: { content: string } }[] }
    const match = d.choices[0]?.message?.content?.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array found')

    const steps = JSON.parse(match[0]) as string[]
    respond(`Executing ${steps.length} steps: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' → ')}`)

    for (const step of steps) {
      await executeSubtask(step)
      await new Promise(r => setTimeout(r, 1200))
    }
    respond('All steps complete.')
  } catch (e) {
    respond(`Decomposition failed — executing as single task.`)
    await executeSubtask(task)
  }
}

// ── Creative problem-solver ────────────────────────────────────────────────────
// When JARVIS truly can't do something, this generates a novel approach using Groq.

export async function creativesolve(
  problem: string,
  context: string,
  respond: (text: string) => void
): Promise<string | null> {
  const key = getGroqKey()
  if (!key) return null

  const prompt = `You are JARVIS, a genius AI assistant for UPSC preparation.
User context: ${context}
Problem to solve creatively: "${problem}"
Think like the most creative person in the world. What is an unexpected, clever approach
to solve this? Use what's available: the app's features, offline knowledge, study techniques.
Give ONE creative solution in 2-3 spoken sentences. Be specific and actionable.`

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200, temperature: 0.85, stream: false,
      }),
    })
    if (!res.ok) return null
    const d = await res.json() as { choices: { message: { content: string } }[] }
    return d.choices[0]?.message?.content?.trim() ?? null
  } catch { return null }
}
