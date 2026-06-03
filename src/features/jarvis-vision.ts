/** jarvis-vision.ts — Advanced vision engine: scan, solve, read, translate */

const GROQ_VISION_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_VISION_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined
const VISION_MODEL     = 'meta-llama/llama-4-scout-17b-16e-instruct'

// ── Vision trigger keywords (extended) ──────────────────────────────────────
export const VISION_KW = [
  // English
  'see this', 'scan', 'analyze', 'analyse', 'evaluate', 'check this',
  'image', 'photo', 'picture', 'capture', 'snapshot', 'scan this',
  'read this', 'solve this', 'what is this', 'explain this diagram',
  'scan my score', 'scan score', 'read my test', 'scan test paper',
  'scan newspaper', 'read newspaper', 'extract headlines',
  'ocr this', 'transcribe', 'what does this say',
  // Hindi / Hinglish
  'dekho', 'yeh dekho', 'is mein', 'padho', 'kya hai',
  'scan karo', 'dekh lo', 'photo lo', 'image dekho', 'samjhao yeh',
  'score scan karo', 'newspaper scan karo', 'yeh padhо',
]

// Scan mode detection from context
type ScanMode = 'score' | 'newspaper' | 'csat' | 'diagram' | 'notes' | 'general'

function detectScanMode(ctx: string): ScanMode {
  const t = ctx.toLowerCase()
  if (/score|marks|result|test paper|mock.*result|answer sheet/i.test(t)) return 'score'
  if (/newspaper|news|headlines?|hindu|express|editorial/i.test(t))         return 'newspaper'
  if (/csat|aptitude|math|reasoning|solve|calculate|question paper/i.test(t)) return 'csat'
  if (/diagram|map|chart|graph|flowchart|structure|image|photo/i.test(t))   return 'diagram'
  if (/notes?|handwriting|written|reading|text/i.test(t))                   return 'notes'
  return 'general'
}

function buildVisionPrompt(mode: ScanMode, ctx: string): string {
  const base = `You are JARVIS, the dedicated UPSC AI assistant for Om Shisodiya (CSE 2028 aspirant). Voice rules: no markdown, no bullets, no asterisks. Spoken sentences only. Max 3-4 sentences.`
  switch (mode) {
    case 'score':
      return `${base} Scan this test paper / score sheet. Extract: the score obtained (numerator), maximum marks (denominator), and the test/subject name if visible. Reply in this exact format: "Score: [score] out of [max] in [test name or 'this test']. That's [percentage]%." Then in one sentence: whether this is above or below a typical UPSC target of 60%.`
    case 'newspaper':
      return `${base} Scan this newspaper / article. Extract only the UPSC-relevant stories (ignore sports, entertainment, local crime). For each relevant story give one sentence: what happened and which UPSC GS paper / syllabus topic it connects to. Maximum 4 stories.`
    case 'csat':
      return `${base} This is a CSAT or aptitude question. Read it carefully, solve it step by step in your head, and give the answer clearly spoken. Say: "The answer is [option] because [brief reason]." If multiple questions, solve each one.`
    case 'diagram':
      return `${base} This is a diagram, map, or chart. Explain what it shows in 2-3 spoken sentences tailored for UPSC exam preparation. Mention which GS paper this concept falls under.`
    case 'notes':
      return `${base} Read these notes or handwritten text carefully — handle any handwriting or font. Summarize the key points in 2-3 spoken sentences. Then suggest one revision tip for this topic.`
    default:
      return `${base} Analyze this image for Om's UPSC preparation. If it's a question: explain and answer. If notes: summarize. If newspaper: extract UPSC-relevant points. If a diagram or map: explain in UPSC context. User context: "${ctx || 'analyze this'}".`
  }
}

export function isVisionTrigger(text: string): boolean {
  const t = text.toLowerCase()
  return VISION_KW.some(k => t.includes(k))
}

// ── Main entry: opens capture UI ────────────────────────────────────────────
export function openVisionCapture(context: string, onResult: (text: string) => void): void {
  if (document.getElementById('jv-modal')) return
  const mode = detectScanMode(context)

  const modeLabel: Record<ScanMode, string> = {
    score:    '📊 Score Scanner',
    newspaper:'📰 CA Headline Scanner',
    csat:     '🧮 CSAT Question Solver',
    diagram:  '🗺 Diagram Explainer',
    notes:    '📝 Notes Reader',
    general:  '🔍 JARVIS Vision',
  }
  const modeHint: Record<ScanMode, string> = {
    score:    'Point camera at your test paper or score sheet. JARVIS will read your marks automatically.',
    newspaper:'Show a newspaper page. JARVIS will extract UPSC-relevant headlines and link them to the syllabus.',
    csat:     'Show a CSAT or maths question. JARVIS will solve it step by step.',
    diagram:  'Show a diagram, map, chart, or flowchart. JARVIS will explain it for UPSC.',
    notes:    'Show any handwritten or printed notes. JARVIS will read and summarize.',
    general:  'Show anything — question paper, notes, newspaper, diagram. JARVIS will analyze it for your prep.',
  }

  const modal = document.createElement('div')
  modal.id = 'jv-modal'
  modal.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.92);backdrop-filter:blur(10px);'
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:24px;width:340px;display:flex;flex-direction:column;gap:14px;text-align:center;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">${modeLabel[mode]}</div>
      <div style="font-size:13px;color:var(--ink-soft);line-height:1.5;">${modeHint[mode]}</div>
      <button id="jv-cam" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
        <span style="font-size:20px;">📷</span><span>Open Camera</span>
      </button>
      <button id="jv-file-btn" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
        <span style="font-size:20px;">📁</span><span>Upload from Gallery</span>
      </button>
      <input id="jv-inp" type="file" accept="image/*" capture="environment" style="display:none" />
      <div id="jv-preview" style="margin-top:4px;"></div>
      <div id="jv-status" style="font-size:12px;color:var(--muted);min-height:16px;"></div>
      <button id="jv-cancel" style="background:none;border:none;color:var(--muted);font-family:var(--font-mono);font-size:11px;cursor:pointer;letter-spacing:.12em;">✕  Cancel</button>
    </div>
  `
  document.body.appendChild(modal)

  const close   = () => modal.remove()
  const setMsg  = (m: string) => { const el = document.getElementById('jv-status'); if (el) el.textContent = m }
  modal.addEventListener('click', e => { if (e.target === modal) close() })
  document.getElementById('jv-cancel')?.addEventListener('click', close)

  const fileInp = document.getElementById('jv-inp') as HTMLInputElement
  document.getElementById('jv-file-btn')?.addEventListener('click', () => fileInp.click())
  fileInp.addEventListener('change', () => {
    const f = fileInp.files?.[0]; if (!f) return
    setMsg('Reading image…')
    const reader = new FileReader()
    reader.onload = () => { close(); void analyzeImage(reader.result as string, mode, context, onResult) }
    reader.readAsDataURL(f)
  })

  document.getElementById('jv-cam')?.addEventListener('click', async () => {
    setMsg('Opening camera…')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } })
      const video  = document.createElement('video')
      video.srcObject = stream; video.setAttribute('playsinline', '')
      await video.play()

      const prev  = document.getElementById('jv-preview')!
      prev.innerHTML = ''
      video.style.cssText = 'width:100%;border-radius:8px;max-height:200px;object-fit:cover;'
      prev.appendChild(video)

      const snapBtn = document.createElement('button')
      snapBtn.innerHTML = '📸 &nbsp;Capture'
      snapBtn.style.cssText = 'width:100%;padding:11px;margin-top:8px;background:var(--accent);color:#000;border:none;border-radius:var(--r-sm);font-weight:700;font-size:14px;cursor:pointer;'
      prev.appendChild(snapBtn)
      setMsg('Hold steady and tap Capture.')

      snapBtn.addEventListener('click', () => {
        const cv = document.createElement('canvas')
        cv.width  = video.videoWidth;  cv.height = video.videoHeight
        cv.getContext('2d')!.drawImage(video, 0, 0)
        stream.getTracks().forEach(t => t.stop())
        setMsg('Analyzing…')
        close()
        void analyzeImage(cv.toDataURL('image/jpeg', 0.90), mode, context, onResult)
      })
    } catch { setMsg('Camera not accessible. Please upload instead.') }
  })
}

// ── Core analysis: sends image to Groq vision model ─────────────────────────
async function analyzeImage(
  base64: string,
  mode: ScanMode,
  ctx: string,
  onResult: (t: string) => void
): Promise<void> {
  if (!GROQ_VISION_KEY) { onResult('Add VITE_GROQ_API_KEY to enable vision.'); return }
  onResult('Scanning… one second.')
  try {
    const res = await fetch(GROQ_VISION_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${GROQ_VISION_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    VISION_MODEL,
        messages: [{
          role:    'user',
          content: [
            { type: 'text',      text: buildVisionPrompt(mode, ctx) },
            { type: 'image_url', image_url: { url: base64 } },
          ],
        }],
        max_tokens:  600,
        temperature: mode === 'csat' ? 0.1 : 0.5,   // CSAT needs determinism
      }),
    })
    if (!res.ok) throw new Error(`Vision API ${res.status}`)
    const d   = await res.json() as { choices: { message: { content: string } }[] }
    const raw = d.choices[0].message.content.trim()

    // Score mode: try to auto-prefill the score form
    if (mode === 'score') {
      const match = raw.match(/Score:\s*(\d+(?:\.\d+)?)\s*out\s*of\s*(\d+(?:\.\d+)?)/i)
      if (match) {
        const score = parseFloat(match[1]), max = parseFloat(match[2])
        if (!isNaN(score) && !isNaN(max)) {
          const cmBtn = document.getElementById('cm-add-score')
          if (cmBtn) {
            cmBtn.click()
            setTimeout(() => {
              const sInp = document.querySelector<HTMLInputElement>('[name="score"],[id="score-input"],#sc-score')
              const mInp = document.querySelector<HTMLInputElement>('[name="max"],[id="max-input"],#sc-max')
              if (sInp) { sInp.value = String(score); sInp.dispatchEvent(new Event('input')) }
              if (mInp) { mInp.value = String(max);   mInp.dispatchEvent(new Event('input')) }
            }, 450)
          }
        }
      }
    }

    onResult(raw)
  } catch (err) {
    console.error('Vision error:', err)
    onResult('Image scan failed. Make sure the image is clear and try again.')
  }
}
