/**
 * jarvis-quiz.ts — Quiz engine extracted from jarvis.ts (Phase 5 split)
 *
 * No imports from jarvis.ts — all shared functions injected via initQuiz().
 * jarvis.ts imports from here (one-way), preventing circular dependencies.
 */

import { todayIST } from '../services/core'

// ── Types ─────────────────────────────────────────────────────────────────────
export type QuizPhase = 'off' | 'asking' | 'revealed'
export interface MCQItem { q: string; opts: string[]; ans: string; exp: string }

interface QuizCallbacks {
  speak:              (text: string) => void
  respond:            (text: string) => void
  addMsg:             (role: 'user' | 'assistant', content: string) => void
  setState:           (s: string) => void
  setStatus:          (s: string) => void
  detectResponseLang: (t: string) => 'en' | 'hi' | 'hinglish'
  saveMem:            () => void
  L:                  (lang: 'en' | 'hi' | 'hinglish', en: string, hi: string, hin?: string) => string
  getMem:             () => { weakTopics: string[]; quizScores: Record<string, number[]>; strongTopics: string[] }
}

// ── Groq constants (same env vars, no circular import needed) ─────────────────
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_KEY   = import.meta.env.VITE_GROQ_API_KEY as string | undefined

// ── Module state ──────────────────────────────────────────────────────────────
let _cbs:       QuizCallbacks | null = null
let _quizPhase: QuizPhase = 'off'
let _quizItems: MCQItem[]  = []
let _quizIdx   = 0
let _quizHits  = 0
let _quizTopic = ''

// ── Public init ───────────────────────────────────────────────────────────────
export function initQuiz(cbs: QuizCallbacks): void { _cbs = cbs }

// ── State accessors (jarvis.ts reads these instead of touching variables) ─────
export function getQuizPhase(): QuizPhase { return _quizPhase }
export function setQuizPhaseOff(): void   { _quizPhase = 'off' }
export function getQuizScore(): { hits: number; idx: number } { return { hits: _quizHits, idx: _quizIdx } }

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function parseQuizAnswer(t: string): string | null {
  if (/\boption a\b|\banswer a\b|\bthe answer is a\b|^a$|^\(a\)$/i.test(t)) return 'A'
  if (/\boption b\b|\banswer b\b|\bthe answer is b\b|^b$|^\(b\)$/i.test(t)) return 'B'
  if (/\boption c\b|\banswer c\b|\bthe answer is c\b|^c$|^\(c\)$/i.test(t)) return 'C'
  if (/\boption d\b|\banswer d\b|\bthe answer is d\b|^d$|^\(d\)$/i.test(t)) return 'D'
  return null
}

function parseQuizResponse(raw: string): MCQItem[] {
  const blocks = raw.split(/---+|\n\n(?=Q[:.])/g).map(b => b.trim()).filter(Boolean)
  const items: MCQItem[] = []
  for (const b of blocks) {
    const qMatch = b.match(/(?:Q[:.\d\s]*|Question\s*\d*[:.])\s*(.+)/i)
    const q    = qMatch?.[1]?.trim() ?? ''
    const optA = b.match(/(?:\(A\)|A[).]|option\s*A:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optB = b.match(/(?:\(B\)|B[).]|option\s*B:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optC = b.match(/(?:\(C\)|C[).]|option\s*C:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const optD = b.match(/(?:\(D\)|D[).]|option\s*D:?)\s*(.+)/i)?.[1]?.trim() ?? ''
    const ans  = (
      b.match(/(?:ANS|Answer|Correct\s*Answer|Key):\s*\(?([A-D])\)?/i) ??
      b.match(/\bThe\s+(?:correct\s+)?answer\s+is\s+\(?([A-D])\)?/i) ??
      b.match(/\(([A-D])\)\s*(?:is correct|✓)/i)
    )?.[1]?.toUpperCase() ?? ''
    const exp = b.match(/(?:EXP(?:LANATION)?|Reason|Note):\s*(.+)/i)?.[1]?.trim() ?? ''
    if (q && (optA || optB) && ans) {
      items.push({ q, opts: [optA, optB, optC, optD].map(o => o || '—'), ans, exp })
    }
  }
  return items.slice(0, 5)
}

// ── Quiz functions ────────────────────────────────────────────────────────────
export async function startQuiz(topic: string): Promise<void> {
  if (!_cbs) return
  const { speak, respond, setState, setStatus, detectResponseLang, getMem } = _cbs
  const lang = detectResponseLang('')
  if (!GROQ_KEY) {
    respond(lang === 'hi' ? 'Quiz के लिए VITE_GROQ_API_KEY add करो।' : 'Add VITE_GROQ_API_KEY to enable quiz mode.')
    return
  }
  _quizTopic = topic
  setState('thinking')
  setStatus(lang === 'hi' ? 'Quiz तैयार हो रहा है…' : 'Preparing quiz…')
  const _hasWeakBias = getMem().weakTopics.length > 0 && !topic.includes(' ')
  const topicWithBias = _hasWeakBias ? `${topic} — focus on commonly missed areas` : topic
  respond(
    lang === 'hi'       ? `${topic} पर 5 MCQs तैयार हो रहे हैं। तैयार हो जाओ।` :
    lang === 'hinglish' ? `${topic} par 5 MCQs aa rahe hain. Taiyar ho jao.` :
                          `Preparing 5 MCQs on ${topicWithBias}. Get ready.`
  )
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{
          role: 'user',
          content: `Generate exactly 5 UPSC Prelims-style MCQs on the topic: "${topicWithBias}".
Format each question EXACTLY like this (no extra text):
Q: [question text]
A) [option]
B) [option]
C) [option]
D) [option]
ANS: [letter A/B/C/D]
EXP: [one-sentence explanation]
---`,
        }],
        max_tokens: 1200, temperature: 0.4, stream: false,
      }),
    })
    if (!res.ok) throw new Error('quiz fetch failed')
    const d = await res.json() as { choices: { message: { content: string } }[] }
    _quizItems = parseQuizResponse(d.choices[0].message.content)
    if (_quizItems.length === 0) { respond('Could not parse quiz questions. Try a different topic.'); return }
    _quizIdx = 0; _quizHits = 0; _quizPhase = 'asking'
    void askQuizQuestion()
  } catch { respond('Quiz fetch failed. Check your connection.') }
}

async function askQuizQuestion(): Promise<void> {
  if (!_cbs) return
  if (_quizIdx >= _quizItems.length) { void finishQuiz(); return }
  const item  = _quizItems[_quizIdx]
  const qText = `Question ${_quizIdx + 1} of ${_quizItems.length}. ${item.q}. Option A: ${item.opts[0]}. Option B: ${item.opts[1]}. Option C: ${item.opts[2]}. Option D: ${item.opts[3]}. Your answer?`
  _cbs.addMsg('assistant', `**Q${_quizIdx + 1}:** ${item.q}\n\nA) ${item.opts[0]}\nB) ${item.opts[1]}\nC) ${item.opts[2]}\nD) ${item.opts[3]}`)
  _cbs.speak(qText)
}

export async function handleQuizAnswer(chosen: string): Promise<void> {
  if (!_cbs) return
  const { respond, addMsg, speak, detectResponseLang, saveMem, L, getMem } = _cbs
  const item = _quizItems[_quizIdx]
  const lang = detectResponseLang('')
  _quizIdx++
  let reply = ''

  if (chosen === item.ans) {
    _quizHits++
    reply =
      lang === 'hi'       ? `बिल्कुल सही! ${item.exp}` :
      lang === 'hinglish' ? `Bilkul sahi! ${item.exp}` :
                            `Correct! ${item.exp}`
  } else {
    reply =
      lang === 'hi'       ? `नहीं, सही उत्तर ${item.ans} है। ${item.exp}` :
      lang === 'hinglish' ? `Nahi, sahi jawab ${item.ans} hai. ${item.exp}` :
                            `Not quite. The answer is ${item.ans}. ${item.exp}`
    // SRS: best-effort revision scheduling on wrong answer (never blocks UI)
    if (_quizTopic) {
      const _todayStr = todayIST()
      void import('../data/repositories/lectures').then(async ({ listLectures }) => {
        try {
          const lectures = await listLectures()
          const topic = _quizTopic.toLowerCase()
          const match = lectures.find(l =>
            (l.title ?? '').toLowerCase().includes(topic) ||
            topic.includes((l.title ?? '').toLowerCase().split(' ').slice(0, 2).join(' '))
          )
          if (match) {
            const { createRevisionSchedule } = await import('../data/repositories/revisions')
            await createRevisionSchedule(match.id, _todayStr)
          }
        } catch { /* offline or no matching lecture — weak topic flagged in memory at quiz end */ }
      })
    }
  }

  addMsg('assistant', reply)
  _quizPhase = 'revealed'
  speak(reply)
  setTimeout(() => {
    if (_quizIdx < _quizItems.length) {
      _quizPhase = 'asking'
      void askQuizQuestion()
    } else {
      void finishQuiz()
    }
  }, 5000)

  void L  // suppress unused-warning for L — used in finishQuiz, not here
  void saveMem  // same
  void getMem
}

export async function nextQuizQuestion(): Promise<void> {
  if (_quizIdx >= _quizItems.length) { void finishQuiz(); return }
  _quizPhase = 'asking'; void askQuizQuestion()
}

function finishQuiz(): void {
  if (!_cbs) return
  const { respond, saveMem, L, detectResponseLang, getMem } = _cbs
  _quizPhase = 'off'
  const pct  = Math.round((_quizHits / _quizItems.length) * 100)
  const lang = detectResponseLang('')
  const mem  = getMem()

  if (_quizTopic) {
    if (!mem.quizScores[_quizTopic]) mem.quizScores[_quizTopic] = []
    mem.quizScores[_quizTopic].push(pct)
    if (mem.quizScores[_quizTopic].length > 5) mem.quizScores[_quizTopic].shift()
    if (pct < 60 && !mem.weakTopics.includes(_quizTopic)) {
      mem.weakTopics.push(_quizTopic)
      if (mem.weakTopics.length > 20) mem.weakTopics.shift()
    }
    if (pct >= 90 && !mem.strongTopics.includes(_quizTopic)) mem.strongTopics.push(_quizTopic)
    saveMem()
  }

  const followUp =
    pct < 60  ? L(lang, ` ${_quizTopic} added to your weak topics list for targeted revision.`,   ` ${_quizTopic} weak topics में add हो गया।`,   ` ${_quizTopic} weak topics mein add ho gaya.`) :
    pct >= 90 ? L(lang, ` ${_quizTopic} flagged as a strong area.`,                               ` ${_quizTopic} strong area में flag हुआ।`,       ` ${_quizTopic} strong area mein flag hua.`) : ''

  if (lang === 'hi') {
    const v = pct >= 80 ? 'शानदार प्रदर्शन!' : pct >= 60 ? 'अच्छा प्रयास।' : 'इस topic को और revise करो।'
    respond(`Quiz पूरा! ${_quizHits} out of ${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  } else if (lang === 'hinglish') {
    const v = pct >= 80 ? 'Zabardast!' : pct >= 60 ? 'Acha effort.' : 'Revise karo is topic ko.'
    respond(`Quiz khatam! ${_quizHits}/${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  } else {
    const v = pct >= 80 ? 'Excellent!' : pct >= 60 ? 'Good effort.' : 'This topic needs more revision.'
    respond(`Quiz complete! ${_quizHits}/${_quizItems.length} — ${pct}%. ${v}${followUp}`)
  }
}
