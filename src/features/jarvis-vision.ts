/** jarvis-vision.ts — Image scan feature (split out to keep jarvis.ts clean) */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined

export const VISION_KW = ['see this','scan','dekho','analyze','analyse','padhо','evaluate','check this',
  'image','photo','picture','kya hai','yeh dekho','is mein']

export function isVisionTrigger(text: string): boolean {
  const t = text.toLowerCase()
  return VISION_KW.some(k => t.includes(k))
}

export function openVisionCapture(context: string, onResult: (text: string) => void): void {
  if (document.getElementById('jv-modal')) return

  const modal = document.createElement('div')
  modal.id = 'jv-modal'
  modal.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.9);backdrop-filter:blur(8px);'
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:24px;width:320px;display:flex;flex-direction:column;gap:14px;text-align:center;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">⬡ JARVIS VISION</div>
      <div style="font-size:13.5px;color:var(--ink-soft);">Show me what to analyze — question paper, notes, newspaper, diagram, anything.</div>
      <button id="jv-cam" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;">📷 Use Camera</button>
      <button id="jv-file-btn" style="padding:12px;background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);color:var(--ink);font-size:14px;cursor:pointer;">📁 Upload Image</button>
      <input id="jv-inp" type="file" accept="image/*" style="display:none" />
      <div id="jv-preview"></div>
      <button id="jv-cancel" style="background:none;border:none;color:var(--muted);font-family:var(--font-mono);font-size:11px;cursor:pointer;">Cancel</button>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.addEventListener('click', e => { if (e.target === modal) close() })
  document.getElementById('jv-cancel')?.addEventListener('click', close)

  const fileInp = document.getElementById('jv-inp') as HTMLInputElement
  document.getElementById('jv-file-btn')?.addEventListener('click', () => fileInp.click())
  fileInp.addEventListener('change', () => {
    const f = fileInp.files?.[0]; if (!f) return
    const reader = new FileReader()
    reader.onload = () => { close(); void analyzeImage(reader.result as string, context, onResult) }
    reader.readAsDataURL(f)
  })

  document.getElementById('jv-cam')?.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const video = document.createElement('video')
      video.srcObject = stream; video.setAttribute('playsinline', '')
      await video.play()
      const prev = document.getElementById('jv-preview')!
      prev.innerHTML = ''
      video.style.cssText = 'width:100%;border-radius:8px;max-height:180px;object-fit:cover;'
      prev.appendChild(video)
      const snap = document.createElement('button')
      snap.textContent = '📸 Capture'
      snap.style.cssText = 'width:100%;padding:10px;margin-top:8px;background:var(--accent);color:#000;border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer;'
      prev.appendChild(snap)
      snap.addEventListener('click', () => {
        const cv = document.createElement('canvas')
        cv.width = video.videoWidth; cv.height = video.videoHeight
        cv.getContext('2d')!.drawImage(video, 0, 0)
        stream.getTracks().forEach(t => t.stop())
        close(); void analyzeImage(cv.toDataURL('image/jpeg', 0.85), context, onResult)
      })
    } catch { alert('Camera not accessible. Upload instead.') }
  })
}

async function analyzeImage(base64: string, ctx: string, onResult: (t: string) => void): Promise<void> {
  if (!GROQ_KEY) { onResult('Add VITE_GROQ_API_KEY to enable vision.'); return }
  const cs = (window as any)._jarvisState?.() // optional CoreState
  onResult('Scanning… ek second.')
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `You are JARVIS, UPSC AI assistant. Analyze this image for Om's UPSC prep. If it's a question: explain and answer. If notes: summarize. If newspaper: extract UPSC-relevant points. If diagram/map: explain in UPSC context. If handwriting: read it carefully — you can read any handwriting or font. Speak naturally (no markdown, no bullets). User context: "${ctx || 'analyze this'}".` },
            { type: 'image_url', image_url: { url: base64 } },
          ],
        }],
        max_tokens: 500,
        temperature: 0.6,
      }),
    })
    const d = await res.json() as { choices: { message: { content: string } }[] }
    onResult(d.choices[0].message.content.trim())
  } catch { onResult('Image scan failed. Try again.') }
}
