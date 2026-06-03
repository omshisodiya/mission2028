/**
 * supabase/functions/jarvis-router/index.ts
 * Edge Function — Groq key stays server-side.
 * POST { transcript: string, mode: "classify" | "qa" }
 * Returns { intent, params, language, confidence } for classify
 *      or { answer: string } for qa
 */
// @ts-ignore — Deno runtime
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

// @ts-ignore
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLASSIFY_PROMPT = `You are a voice command classifier for a UPSC exam preparation app called JARVIS.
Classify the user's voice command into exactly ONE intent and extract slot values.
Return ONLY a JSON object — no explanation, no markdown.
Format: {"intent":"<id>","params":{},"language":"en|hi|hinglish","confidence":0.0-1.0}

Intents:
nav.goto            → navigate to app section; slot: section (plan|intelligence|engine|routine|constitution)
timer.start         → start focus timer; slot: minutes (integer, default 25)
timer.stop          → stop or pause timer
score.add           → log test score; slots: score (number), max (number), category (prelims|csat|mains|optional|dpp|mock|sectional), subject (string, optional)
routine.setType     → set today's day type; slot: type (Holiday|College|Leave|Study)
routine.logHours    → log study hours; slot: hours (number)
lecture.markDone    → mark lecture done; slots: subject (string), number (integer, optional)
query.backlog       → how many lectures pending
query.hours         → study time; slot: period (today|week|total)
query.rank          → rank projection
query.selectionProb → selection probability
query.average       → average score; slot: stream (prelims|mains|optional|dpp|overall)
plan.generate       → generate study plan
plan.today          → what to study today
revision.due        → what revisions are due today
mistake.add         → log a mistake; slot: text (string)
ca.add              → log current affairs; slot: text (string)
constitution.lookup → look up article; slot: article (string, e.g. "21" or "21A")
syllabus.show       → show syllabus; slot: paper (GS1|GS2|GS3|GS4|CSAT)
countdown.exam      → days until exam; slot: exam (prelims|mains)
briefing.today      → full daily briefing
qa.answer           → UPSC knowledge question (use for anything not above); slot: question (string)
system.setLanguage  → switch language; slot: lang (hi-IN|en-IN)
system.repeat       → repeat last response
system.sleep        → stop listening / go to sleep`

const QA_PROMPT = `You are JARVIS — a brilliant UPSC exam tutor for Om Shisodiya (CSE 2028, target).
Speak your answer — no markdown, no bullet points, no numbered lists.
Give concise, accurate answers in 2-4 spoken sentences.
Match the user's language: Hindi for Hindi, Hinglish for Hinglish, English for English.
Focus on what's relevant for UPSC Prelims and Mains. Be warm and encouraging.`

// @ts-ignore
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { transcript, mode } = await req.json() as { transcript: string; mode: 'classify' | 'qa' }
    const isQA    = mode === 'qa'
    const model   = isQA ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant'
    const syspmt  = isQA ? QA_PROMPT : CLASSIFY_PROMPT
    const maxTok  = isQA ? 260 : 130
    const temp    = isQA ? 0.60 : 0.05

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: syspmt },
        { role: 'user',   content: transcript },
      ],
      max_tokens: maxTok,
      temperature: temp,
      stream: false,
    }
    if (!isQA) body.response_format = { type: 'json_object' }

    const gr  = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!gr.ok) throw new Error(`Groq ${gr.status}`)
    const d   = await gr.json() as { choices: { message: { content: string } }[] }
    const raw = d.choices[0].message.content.trim()

    const payload = isQA ? { answer: raw } : JSON.parse(raw)
    return new Response(JSON.stringify(payload), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
