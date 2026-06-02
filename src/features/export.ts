/**
 * export.ts — one-click JSON + CSV export of all user data.
 * Adds an "Export" button to the command menu.
 */
import { supabase } from '../data/supabase'

async function fetchAll(): Promise<Record<string, unknown[]>> {
  const tables = [
    'routine_days', 'lectures', 'scores', 'answer_practice',
    'current_affairs', 'revisions', 'study_sessions', 'mistakes', 'notes',
  ]
  const result: Record<string, unknown[]> = {}
  await Promise.all(tables.map(async t => {
    const { data } = await supabase.from(t).select('*').limit(10000)
    result[t] = data ?? []
  }))
  return result
}

function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export async function exportJSON(): Promise<void> {
  const data  = await fetchAll()
  const today = new Date().toISOString().slice(0, 10)
  downloadBlob(
    JSON.stringify({ exported_at: new Date().toISOString(), data }, null, 2),
    `mission2028_export_${today}.json`,
    'application/json',
  )
}

export async function exportCSV(): Promise<void> {
  const data  = await fetchAll()
  const today = new Date().toISOString().slice(0, 10)
  const parts: string[] = []
  for (const [table, rows] of Object.entries(data)) {
    if (!rows.length) continue
    const headers = Object.keys(rows[0] as object)
    const csv = [
      `# ${table}`,
      headers.join(','),
      ...rows.map(r =>
        headers.map(h => {
          const v = (r as Record<string, unknown>)[h]
          const s = v == null ? '' : String(v)
          return s.includes(',') || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"`
            : s
        }).join(',')
      ),
    ].join('\n')
    parts.push(csv)
  }
  downloadBlob(parts.join('\n\n'), `mission2028_export_${today}.csv`, 'text/csv')
}

/** Inject Export button into command menu. */
export function injectExportButton(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-export-btn')) return

  const card = document.createElement('a')
  card.className = 'cm-card'
  card.id = 'cm-export-btn'
  card.setAttribute('href', '#')
  card.innerHTML = `
    <span class="cm-no">↓</span>
    <span class="cm-t">Export Data</span>
    <span class="cm-d">Download JSON backup</span>
  `
  card.addEventListener('click', async e => {
    e.preventDefault()
    card.style.opacity = '.5'
    card.querySelector('.cm-d')!.textContent = 'Exporting…'
    try { await exportJSON() } catch (err) { console.error('[export]', err) }
    card.style.opacity = ''
    card.querySelector('.cm-d')!.textContent = 'Download JSON backup'
  })
  grid.appendChild(card)
}
