import * as XLSX from 'xlsx'
import { insertLectures, type LectureInsert, type LectureStatus } from '../data/repositories/lectures'
import './import-wizard.css'

type OnDone = () => Promise<void>

interface ParsedRow {
  subject: string
  sequence: number | null
  title: string
  duration_min: number
  week: number | null
  status: LectureStatus
}

let _onDone: OnDone = async () => {}
let _parsed: ParsedRow[] = []

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns true only if the wizard overlay is still in the DOM. */
function isOpen(): boolean {
  return !!document.getElementById('iw-overlay')
}

/** Null-safe getElementById. */
function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function setText(id: string, value: string): void {
  const e = el(id)
  if (e) e.textContent = value
}

function setDisplay(id: string, display: string): void {
  const e = el(id)
  if (e) e.style.display = display
}

function close(): void {
  el('iw-overlay')?.remove()
}

function step(name: 'iw-upload' | 'iw-preview' | 'iw-done'): void {
  ;(['iw-upload', 'iw-preview', 'iw-done'] as const).forEach(id => {
    el(id)?.classList.toggle('hidden', id !== name)
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function toStatus(raw: string): LectureStatus {
  const v = raw.toLowerCase().trim()
  if (v === 'today' || v === 'upcoming' || v === 'done') return v
  return 'backlog'
}

// ── public API ────────────────────────────────────────────────────────────────

export function showImportWizard(onDone: OnDone): void {
  _onDone = onDone
  if (isOpen()) return

  const overlay = document.createElement('div')
  overlay.id = 'iw-overlay'
  overlay.innerHTML = `
    <div id="iw-panel" class="panel panel-pad">
      <div class="iw-head">
        <h3>Import PW Lectures</h3>
        <button class="iw-close" id="iw-x" aria-label="Close">&times;</button>
      </div>

      <div class="iw-step" id="iw-upload">
        <div>
          <p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;">
            Download the template, fill in your PW Prarambh lecture list, then drop it below.<br/>
            Columns: <span class="mono" style="font-size:12px;">subject &middot; sequence &middot; title &middot; duration_min &middot; week &middot; status</span>
          </p>
          <button class="btn ghost iw-template" id="iw-download-tpl">&darr; Download template .xlsx</button>
        </div>
        <div class="iw-drop" id="iw-drop">
          <p style="font-size:15px;color:var(--ink-soft);">Drop your .xlsx or .csv file here</p>
          <p style="color:var(--muted);font-size:13px;">or <label class="iw-browse" for="iw-file" style="color:var(--accent);cursor:pointer;">browse</label></p>
          <input type="file" id="iw-file" accept=".xlsx,.xls,.csv" style="display:none" />
        </div>
        <p id="iw-parse-err" class="iw-err" style="display:none;margin-top:10px;"></p>
      </div>

      <div class="iw-step hidden" id="iw-preview">
        <div class="iw-preview-info">
          <span style="font-size:14px;color:var(--ink-soft);">Found <b id="iw-row-count">0</b> lectures ready to import</span>
          <span class="mono muted" style="font-size:12px;" id="iw-file-name"></span>
        </div>
        <div class="iw-table-wrap" id="iw-table-wrap"></div>
        <p class="iw-more" id="iw-more-note" style="display:none;"></p>
        <div class="iw-footer">
          <p id="iw-import-err" class="iw-err" style="display:none;flex:1;margin:0;"></p>
          <button class="btn ghost" id="iw-back">&larr; Back</button>
          <button class="btn primary" id="iw-confirm">Import <span id="iw-confirm-n">0</span> lectures</button>
        </div>
      </div>

      <div class="iw-step hidden" id="iw-done">
        <div class="iw-done">
          <span class="iw-done-icon">&#10003;</span>
          <p><b id="iw-done-n">0</b> lectures imported successfully.</p>
          <p style="color:var(--muted);font-size:13px;">They now appear in the planner below.</p>
        </div>
        <div class="iw-footer" style="justify-content:center;">
          <button class="btn primary" id="iw-close-done">Close</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  // Wire up events
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  el('iw-x')?.addEventListener('click', close)
  el('iw-close-done')?.addEventListener('click', close)
  el('iw-download-tpl')?.addEventListener('click', downloadTemplate)
  el('iw-back')?.addEventListener('click', () => step('iw-upload'))
  el('iw-confirm')?.addEventListener('click', doImport)

  const fileInput = el<HTMLInputElement>('iw-file')
  fileInput?.addEventListener('change', () => {
    if (fileInput.files?.[0]) void handleFile(fileInput.files[0])
  })

  const dropZone = el('iw-drop')!
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
  dropZone?.addEventListener('drop', e => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
    const file = e.dataTransfer?.files[0]
    if (file) void handleFile(file)
  })
  dropZone?.addEventListener('click', () => fileInput?.click())
}

// ── file handling ─────────────────────────────────────────────────────────────

const PREVIEW_MAX = 10

async function handleFile(file: File): Promise<void> {
  if (!isOpen()) return
  setDisplay('iw-parse-err', 'none')

  let ab: ArrayBuffer
  try {
    ab = await file.arrayBuffer()
  } catch {
    if (!isOpen()) return
    setText('iw-parse-err', 'Could not read the file. Please try again.')
    setDisplay('iw-parse-err', 'block')
    return
  }

  // Wizard might have been closed while reading the file
  if (!isOpen()) return

  try {
    const wb = XLSX.read(ab)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

    _parsed = raw
      .map(r => ({
        subject:      String(r['subject'] ?? r['Subject'] ?? '').trim(),
        sequence:     r['sequence'] != null ? Number(r['sequence']) : null,
        title:        String(r['title'] ?? r['Title'] ?? '').trim(),
        duration_min: r['duration_min'] != null ? Number(r['duration_min']) : 60,
        week:         r['week'] != null ? Number(r['week']) : null,
        status:       toStatus(String(r['status'] ?? 'backlog')),
      }))
      .filter(r => r.title.length > 0)

    if (_parsed.length === 0) {
      throw new Error('No valid rows found. Make sure the file has a "title" column.')
    }

    showPreview(file.name, _parsed)
  } catch (e) {
    if (!isOpen()) return
    setText('iw-parse-err', e instanceof Error ? e.message : 'Could not parse file.')
    setDisplay('iw-parse-err', 'block')
  }
}

function showPreview(fileName: string, rows: ParsedRow[]): void {
  if (!isOpen()) return

  setText('iw-file-name', fileName)
  setText('iw-row-count', String(rows.length))
  setText('iw-confirm-n', String(rows.length))

  const preview = rows.slice(0, PREVIEW_MAX)
  const tableWrap = el('iw-table-wrap')
  if (tableWrap) {
    tableWrap.innerHTML = `
      <table class="iw-table">
        <thead><tr>
          <th>#</th><th>Subject</th><th>Title</th><th>Min</th><th>Week</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${preview.map((r, i) => `
            <tr>
              <td>${r.sequence ?? i + 1}</td>
              <td>${esc(r.subject)}</td>
              <td>${esc(r.title)}</td>
              <td>${r.duration_min}</td>
              <td>${r.week ?? '&#8212;'}</td>
              <td>${r.status}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
  }

  const moreNote = el('iw-more-note')
  if (moreNote) {
    if (rows.length > PREVIEW_MAX) {
      moreNote.textContent = `… and ${rows.length - PREVIEW_MAX} more rows`
      moreNote.style.display = 'block'
    } else {
      moreNote.style.display = 'none'
    }
  }

  step('iw-preview')
}

async function doImport(): Promise<void> {
  if (!isOpen()) return
  const btn = el<HTMLButtonElement>('iw-confirm')
  if (!btn) return

  setDisplay('iw-import-err', 'none')
  btn.disabled = true
  btn.textContent = 'Importing…'

  const inserts: LectureInsert[] = _parsed.map(r => ({
    title:        r.title,
    subject:      r.subject || undefined,
    sequence:     r.sequence,
    duration_min: r.duration_min,
    week:         r.week,
    status:       r.status,
  }))

  try {
    await insertLectures(inserts, (done, total) => {
      if (btn && isOpen()) btn.textContent = `Importing… ${done} / ${total}`
    })
    if (!isOpen()) return
    setText('iw-done-n', String(inserts.length))
    step('iw-done')
    await _onDone()
  } catch (e) {
    if (!isOpen()) return
    setText('iw-import-err', e instanceof Error ? e.message : 'Import failed — please try again.')
    setDisplay('iw-import-err', 'block')
    btn.disabled = false
    btn.textContent = `Import ${_parsed.length} lectures`
  }
}

// ── template download ─────────────────────────────────────────────────────────

function downloadTemplate(): void {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['subject', 'sequence', 'title', 'duration_min', 'week', 'status'],
    ['Polity', 1, 'Polity — Lecture 1: Introduction to Constitution', 75, 1, 'backlog'],
    ['Polity', 2, 'Polity — Lecture 2: Making of the Constitution', 80, 1, 'backlog'],
    ['Modern History', 1, 'Modern History — Lecture 1: British East India Company', 80, 1, 'backlog'],
    ['Geography', 1, 'Geography — Lecture 1: Physical Features of India', 70, 2, 'backlog'],
    ['Economy', 1, 'Economy — Lecture 1: Introduction to Indian Economy', 65, 2, 'backlog'],
  ])
  ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 55 }, { wch: 14 }, { wch: 8 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Lectures')
  XLSX.writeFile(wb, 'PW_Prarambh_Template.xlsx')
}
