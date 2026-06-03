/**
 * jarvis-router.ts — Two-stage intent router for JARVIS voice layer
 *
 * Stage 1 (local fast-path): keyword index built from voice_commands_2000.csv
 *         → instant, zero-cost, offline-capable, handles ~80% of commands
 *
 * Stage 2 (LLM fallback): calls the jarvis-router Supabase Edge Function
 *         → llama-3.1-8b-instant for intent classification (key stays server-side)
 *         → llama-3.3-70b-versatile for qa.answer (UPSC tutor)
 */
import csvRaw    from '../data/voice_commands_2000.csv?raw'
import intentsRaw from '../data/voice_intents.json'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface RouterResult {
  intent:     string
  params:     Record<string, string | number>
  language:   'en' | 'hi' | 'hinglish'
  confidence: number
}

const _allIntentIds = ((intentsRaw as { intents: { id: string }[] }).intents).map(i => i.id)

// ── CSV parsing → keyword index ───────────────────────────────────────────────
const STOPWORDS = new Set([
  'a','an','the','to','of','in','at','is','it','me','my','for','on','and','or',
  'do','am','be','by','up','so','no','not','what','how','i','you','your','we',
  'jarvis','जार्विस',
])

function tokenize(t: string): string[] {
  return t.toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w))
}

function buildIndex(): Map<string, Map<string, number>> {
  // intent → (word → TF·IDF weight)
  const intentWordFreq = new Map<string, Map<string, number>>()
  const wordDocCount   = new Map<string, Set<string>>()

  for (const line of csvRaw.split('\n').slice(1)) {
    const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1)
    if (c1 < 0 || c2 < 0) continue
    const cmd    = line.slice(0, c1).trim().toLowerCase()
    const intent = line.slice(c2 + 1).split(',')[0].trim()
    if (!cmd || !intent) continue

    if (!intentWordFreq.has(intent)) intentWordFreq.set(intent, new Map())
    const freq = intentWordFreq.get(intent)!
    for (const w of tokenize(cmd)) {
      freq.set(w, (freq.get(w) ?? 0) + 1)
      if (!wordDocCount.has(w)) wordDocCount.set(w, new Set())
      wordDocCount.get(w)!.add(intent)
    }
  }

  const N   = intentWordFreq.size
  const idx = new Map<string, Map<string, number>>()
  for (const [intent, freq] of intentWordFreq) {
    const weights = new Map<string, number>()
    for (const [w, tf] of freq) {
      const df  = wordDocCount.get(w)?.size ?? 1
      const idf = Math.log((N + 1) / df)
      weights.set(w, Math.min(tf * idf, 6))
    }
    idx.set(intent, weights)
  }
  return idx
}

const _kwIndex = buildIndex()

// ── Direct phrase map: every CSV row → intent (exact O(1) lookup) ─────────────
function buildPhraseMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of csvRaw.split('\n').slice(1)) {
    const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1)
    if (c1 < 0 || c2 < 0) continue
    const raw    = line.slice(0, c1).trim().toLowerCase()
    const intent = line.slice(c2 + 1).split(',')[0].trim()
    if (!raw || !intent) continue
    // Strip the wake word prefix/suffix so we match stripped transcripts
    const clean = raw
      .replace(/^jarvis\s+/i, '')
      .replace(/\s+jarvis$/i, '')
      .replace(/^\s*,?\s*|\s*,?\s*$/g, '')
      .trim()
    if (clean && !map.has(clean)) map.set(clean, intent)
  }
  return map
}

const _phraseMap = buildPhraseMap()

// ── Local fast-path ───────────────────────────────────────────────────────────
export function localRoute(transcript: string): RouterResult | null {
  const clean = transcript.toLowerCase().replace(/\s+/g, ' ').trim()

  // Stage 1: Exact phrase match against all 1857 CSV rows — confidence 1.0
  const exactIntent = _phraseMap.get(clean)
  if (exactIntent) {
    return { intent: exactIntent, params: extractSlots(exactIntent, transcript), language: detectLang(transcript), confidence: 1.0 }
  }

  // Stage 2: Prefix/suffix phrase match — confidence 0.88
  for (const [phrase, intent] of _phraseMap) {
    if (phrase.length >= 8 && (clean.startsWith(phrase) || clean.endsWith(phrase))) {
      return { intent, params: extractSlots(intent, transcript), language: detectLang(transcript), confidence: 0.88 }
    }
  }

  // Stage 3: Keyword scoring (handles novel phrasings not in CSV)
  const words = tokenize(transcript)
  if (!words.length) return null

  let best = '', bestScore = 0
  for (const [intent, weights] of _kwIndex) {
    let score = 0
    for (const w of words) score += weights.get(w) ?? 0
    const norm = score / (Math.sqrt(words.length) + 1)
    if (norm > bestScore) { bestScore = norm; best = intent }
  }

  if (bestScore < 0.32 || !best) return null

  return {
    intent:     best,
    params:     extractSlots(best, transcript),
    language:   detectLang(transcript),
    confidence: Math.min(bestScore, 0.90),
  }
}

// ── Supabase Edge Function call ───────────────────────────────────────────────
// Falls back to direct Groq if no Supabase URL is configured.
const SUPABASE_URL  = (import.meta.env.VITE_SUPABASE_URL  as string | undefined) ?? ''
const GROQ_BROWSER  = (import.meta.env.VITE_GROQ_API_KEY  as string | undefined) ?? ''
const GROQ_URL_DIRECT = 'https://api.groq.com/openai/v1/chat/completions'

export async function llmRoute(transcript: string, mode: 'classify' | 'qa' = 'classify'): Promise<RouterResult & { answer?: string }> {
  const edgeFnUrl = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/jarvis-router` : ''

  if (edgeFnUrl) {
    // Preferred path — Groq key stays server-side
    try {
      const res = await fetch(edgeFnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, mode }),
      })
      if (!res.ok) throw new Error(`Edge ${res.status}`)
      const d = await res.json() as RouterResult & { answer?: string }
      if (!_allIntentIds.includes(d.intent ?? '')) d.intent = 'qa.answer'
      return d
    } catch { /* fall through to direct */ }
  }

  // Direct browser Groq call (fallback when Edge Function not deployed)
  if (!GROQ_BROWSER) {
    return { intent: 'qa.answer', params: { question: transcript }, language: detectLang(transcript), confidence: 0 }
  }

  const isQA   = mode === 'qa'
  const model  = isQA ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant'
  const syspmt = isQA ? QA_PROMPT : CLASSIFY_PROMPT

  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role:'system', content:syspmt }, { role:'user', content:transcript }],
      max_tokens: isQA ? 260 : 130,
      temperature: isQA ? 0.6 : 0.05,
      stream: false,
    }
    if (!isQA) body.response_format = { type: 'json_object' }

    const res = await fetch(GROQ_URL_DIRECT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_BROWSER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Groq ${res.status}`)
    const d   = await res.json() as { choices: { message: { content: string } }[] }
    const raw = d.choices[0].message.content.trim()
    if (isQA) return { intent:'qa.answer', params:{question:transcript}, language:detectLang(transcript), confidence:0.9, answer:raw }
    const parsed = JSON.parse(raw) as RouterResult
    if (!_allIntentIds.includes(parsed.intent)) parsed.intent = 'qa.answer'
    return { ...parsed, params: parsed.params ?? {} }
  } catch {
    return { intent:'qa.answer', params:{ question:transcript }, language:detectLang(transcript), confidence:0 }
  }
}

// ── Main route entry point ────────────────────────────────────────────────────
export async function route(transcript: string): Promise<RouterResult & { answer?: string }> {
  const local = localRoute(transcript)
  // High-confidence local match → instant response
  if (local && local.confidence >= 0.50) return local
  // Low-confidence or no match → ask Groq to classify
  return llmRoute(transcript, 'classify')
}

// ── Slot extraction per intent ────────────────────────────────────────────────
export function extractSlots(intent: string, t: string): Record<string, string | number> {
  const tl     = t.toLowerCase()
  const params: Record<string, string | number> = {}

  switch (intent) {
    case 'nav.goto': {
      const SMAP: [RegExp, string][] = [
        [/plan|planner/i,                     'plan'],
        [/intel|analytics|charts|stats|score.*section/i, 'intel'],
        [/engine|timer|focus.*card|pomodoro.*card/i, 'engine'],
        [/routine|schedule.*section/i,        'routine'],
        [/constitution|article.*section/i,    'constitution'],
      ]
      for (const [re, sec] of SMAP) { if (re.test(tl)) { params.section = sec; break } }
      if (!params.section) params.section = 'engine'
      break
    }

    case 'timer.start': {
      const m = tl.match(/\b(\d{1,3})\s*(?:min|minute|minutes|mins)/i)
      if (m)                                        params.minutes = parseInt(m[1])
      else if (/half.*hour|adha.*ghanta/i.test(tl)) params.minutes = 30
      else if (/\bone\b.*hour|ek.*ghanta/i.test(tl))params.minutes = 60
      else if (/two.*hour|do.*ghanta/i.test(tl))    params.minutes = 120
      else                                          params.minutes = 25
      break
    }

    case 'score.add': {
      const slash = tl.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of|mein se)\s*(\d+(?:\.\d+)?)/)
      if (slash) { params.score = parseFloat(slash[1]); params.max = parseFloat(slash[2]) }
      for (const c of ['prelims','csat','mains','optional','dpp','sectional','mock']) {
        if (tl.includes(c)) { params.category = c; break }
      }
      if (!params.category) params.category = 'mock'
      break
    }

    case 'routine.setType': {
      if (/holiday|छुट्टी|chutti/i.test(t))  params.type = 'Holiday'
      else if (/leave/i.test(tl))             params.type = 'Leave'
      else if (/college/i.test(tl))           params.type = 'College'
      else                                    params.type = 'Study'
      break
    }

    case 'routine.logHours': {
      const m = tl.match(/(\d+(?:\.\d+)?)\s*(?:ghante|hour|hours|hr|घंटे)/i)
      if (m) params.hours = parseFloat(m[1])
      break
    }

    case 'lecture.markDone': {
      for (const s of ['polity','history','geography','economics','environment','science','csat','gs1','gs2','gs3','gs4','optional']) {
        if (tl.includes(s)) { params.subject = s; break }
      }
      const nm = tl.match(/(?:lecture|chapter|lec|no\.?)\s*(\d+)/i)
      if (nm) params.number = parseInt(nm[1])
      break
    }

    case 'query.average': {
      for (const s of ['prelims','mains','optional','csat','mock','dpp']) {
        if (tl.includes(s)) { params.stream = s; break }
      }
      if (!params.stream) params.stream = 'overall'
      break
    }

    case 'query.hours': {
      params.period = /week|hafte/i.test(tl) ? 'week' : /total|all|sab/i.test(tl) ? 'total' : 'today'
      break
    }

    case 'constitution.lookup': {
      const m = tl.match(/article\s*(\d+[a-z]?)/i) ?? tl.match(/(\d+[a-z]?)\s*article/i) ?? tl.match(/anuched\s*(\d+)/i)
      if (m) params.article = m[1].toUpperCase()
      break
    }

    case 'syllabus.show': {
      const m = tl.match(/gs\s*([1-4])/i) ?? tl.match(/(csat|paper\s*2)/i)
      if (m) params.paper = m[1] ? `GS${m[1]}` : 'CSAT'
      break
    }

    case 'countdown.exam': {
      params.exam = /mains/i.test(tl) ? 'mains' : 'prelims'
      break
    }

    case 'system.setLanguage': {
      params.lang = /hindi|हिंदी/i.test(t) ? 'hi-IN' : 'en-IN'
      break
    }

    case 'qa.answer': {
      params.question = t
      break
    }
  }
  return params
}

// ── Language detection ────────────────────────────────────────────────────────
export function detectLang(t: string): 'en' | 'hi' | 'hinglish' {
  if (/[ऀ-ॿ]/.test(t) && /[a-z]/i.test(t)) return 'hinglish'
  if (/[ऀ-ॿ]/.test(t)) return 'hi'
  if (/\b(karo|hai|hain|mein|nahi|batao|dikhao|shuru|band|wala|aaj|kitna|kitne|chahiye|bolo|do|dena|kya|kaisa|samjhao|pe|ke|ka|ki|ko)\b/i.test(t)) return 'hinglish'
  return 'en'
}

// ── Prompts (kept here so Edge Function and direct path share them) ───────────
export const CLASSIFY_PROMPT = `You are a voice command classifier for a UPSC exam prep app JARVIS.
Classify the voice command into ONE intent, extract slots. Return ONLY valid JSON.
{"intent":"<id>","params":{},"language":"en|hi|hinglish","confidence":0.0-1.0}

Intents: nav.goto(section) timer.start(minutes) timer.stop score.add(score,max,category,subject?)
routine.setType(type) routine.logHours(hours) lecture.markDone(subject,number?)
query.backlog query.hours(period) query.rank query.selectionProb query.average(stream)
plan.generate plan.today revision.due mistake.add(text) ca.add(text)
constitution.lookup(article) syllabus.show(paper) countdown.exam(exam) briefing.today
qa.answer(question) system.setLanguage(lang) system.repeat system.sleep`

export const QA_PROMPT = `You are JARVIS — brilliant UPSC tutor for Om Shisodiya (CSE 2028).
Speak your answer aloud — no markdown, no bullets, just natural spoken sentences.
2-4 sentences max. Match user's language exactly. Be warm, accurate, UPSC-focused.`
