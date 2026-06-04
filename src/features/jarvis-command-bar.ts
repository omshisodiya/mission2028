/**
 * jarvis-command-bar.ts — Global Spotlight-Style Command Palette
 *
 * Activated by Ctrl+Space or voice "command bar" / "open command"
 * Features:
 * - Fuzzy search through all JARVIS commands with instant results
 * - Contextual suggestions based on current page section
 * - Recent commands history (last 20)
 * - Category filters (Navigation, Timer, Scores, Intelligence, etc.)
 * - Keyboard navigation (↑↓ arrows, Enter to execute, Esc to close)
 * - Animated cinematic entry / exit
 */

import { todayIST } from '../services/core'

// ── Command registry ──────────────────────────────────────────────────────────

export interface CommandEntry {
  id:       string
  label:    string
  desc:     string
  category: string
  icon:     string
  action:   () => void
  keywords: string[]
}

const _registry: CommandEntry[] = []
const _RECENT_KEY = 'jarvis_cmdbar_recent_v1'

export function registerCommand(cmd: CommandEntry): void {
  const idx = _registry.findIndex(c => c.id === cmd.id)
  if (idx >= 0) _registry[idx] = cmd; else _registry.push(cmd)
}

export function registerCommands(cmds: CommandEntry[]): void {
  cmds.forEach(registerCommand)
}

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(_RECENT_KEY) ?? '[]') } catch { return [] }
}

function saveRecent(ids: string[]): void {
  localStorage.setItem(_RECENT_KEY, JSON.stringify(ids.slice(0, 20)))
}

function recordUsage(id: string): void {
  const recent = loadRecent().filter(r => r !== id)
  saveRecent([id, ...recent])
}

// ── Fuzzy search ───────────────────────────────────────────────────────────────

function fuzzyScore(query: string, cmd: CommandEntry): number {
  const q = query.toLowerCase()
  const label = cmd.label.toLowerCase()
  const desc  = cmd.desc.toLowerCase()
  const kws   = cmd.keywords.join(' ').toLowerCase()

  if (label === q) return 100
  if (label.startsWith(q)) return 90
  if (label.includes(q)) return 80
  if (desc.includes(q)) return 60
  if (kws.includes(q)) return 50

  // Character-by-character fuzzy
  let score = 0
  let j     = 0
  for (let i = 0; i < q.length; i++) {
    while (j < label.length && label[j] !== q[i]) j++
    if (j < label.length) { score += 30 - j * 0.5; j++ }
  }
  return score
}

function searchCommands(query: string, limit = 8): CommandEntry[] {
  if (!query.trim()) {
    // Show recent + contextual
    const recent  = loadRecent()
    const ordered = [
      ..._registry.filter(c => recent.includes(c.id)).sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id)),
      ..._registry.filter(c => !recent.includes(c.id)),
    ]
    return ordered.slice(0, limit)
  }

  return _registry
    .map(c => ({ cmd: c, score: fuzzyScore(query, c) }))
    .filter(x => x.score > 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.cmd)
}

// ── Panel rendering ────────────────────────────────────────────────────────────

let _barOpen    = false
let _selectedIdx = 0

export function openCommandBar(
  executeVoiceCmd: (cmd: string) => void,
  prefill = '',
): void {
  if (_barOpen) {
    const inp = document.getElementById('jcb-input') as HTMLInputElement | null
    if (inp) { inp.value = prefill; inp.dispatchEvent(new Event('input')); inp.focus() }
    return
  }
  _barOpen = true; _selectedIdx = 0

  const overlay = document.createElement('div')
  overlay.id = 'jcb-overlay'
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9500;display:flex;justify-content:center;',
    'align-items:flex-start;padding-top:15vh;background:rgba(5,7,15,.75);',
    'backdrop-filter:blur(12px);',
  ].join('')

  overlay.innerHTML = `
    <div id="jcb-panel" style="width:100%;max-width:560px;background:var(--bg-2);
      border:1px solid var(--line-2);border-radius:var(--r);overflow:hidden;
      box-shadow:0 24px 80px rgba(0,0,0,.6);animation:jcb-in .18s ease;">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;
        border-bottom:1px solid var(--line-2);">
        <span style="font-size:16px;flex-shrink:0;">⬡</span>
        <input id="jcb-input" type="text" placeholder="Type a command…" autocomplete="off"
          value="${prefill}"
          style="flex:1;background:none;border:none;outline:none;color:var(--ink);
          font-size:15px;font-family:var(--font-body);" />
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">ESC</span>
      </div>
      <div id="jcb-results" style="max-height:360px;overflow-y:auto;padding:6px;"></div>
      <div style="padding:8px 14px;border-top:1px solid var(--line);display:flex;gap:12px;">
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">↑↓ navigate</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">↵ execute</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--accent);">⬡ JARVIS</span>
      </div>
    </div>
  `

  // Inject keyframe if not present
  if (!document.getElementById('jcb-style')) {
    const s = document.createElement('style')
    s.id = 'jcb-style'
    s.textContent = `
      @keyframes jcb-in { from{opacity:0;transform:translateY(-12px) scale(.97)} to{opacity:1;transform:none} }
      .jcb-item { display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:var(--r-sm);
        cursor:pointer;transition:background .1s; }
      .jcb-item:hover, .jcb-item.selected { background:var(--panel-2); }
      .jcb-item.selected { background:rgba(240,181,74,.1);border-left:2px solid var(--accent); }
    `
    document.head.appendChild(s)
  }

  document.body.appendChild(overlay)

  const input   = document.getElementById('jcb-input') as HTMLInputElement
  const results = document.getElementById('jcb-results')!

  const close = () => {
    overlay.remove(); _barOpen = false
  }

  const renderResults = (query: string) => {
    const cmds = searchCommands(query)
    _selectedIdx = 0
    results.innerHTML = cmds.length
      ? cmds.map((c, i) => `
          <div class="jcb-item${i === 0 ? ' selected' : ''}" data-idx="${i}" data-id="${c.id}">
            <span style="font-size:18px;width:28px;text-align:center;flex-shrink:0;">${c.icon}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:var(--ink);font-weight:500;">${c.label}</div>
              <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.desc}</div>
            </div>
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);flex-shrink:0;padding:2px 6px;
              background:var(--panel-2);border-radius:4px;">${c.category}</span>
          </div>`).join('')
      : '<p style="font-family:var(--font-mono);font-size:12px;color:var(--muted);text-align:center;padding:20px 0;">No commands found — press Enter to send to JARVIS</p>'

    results.querySelectorAll<HTMLElement>('.jcb-item').forEach(item => {
      item.addEventListener('click', () => {
        const id  = item.dataset.id!
        const cmd = _registry.find(c => c.id === id)
        if (cmd) { recordUsage(id); cmd.action(); close() }
      })
    })
  }

  const updateSelection = (newIdx: number) => {
    const items = results.querySelectorAll<HTMLElement>('.jcb-item')
    items.forEach((item, i) => item.classList.toggle('selected', i === newIdx))
    _selectedIdx = newIdx
    items[newIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const executeSelected = () => {
    const items = results.querySelectorAll<HTMLElement>('.jcb-item')
    const sel   = items[_selectedIdx]
    if (sel) {
      const id  = sel.dataset.id!
      const cmd = _registry.find(c => c.id === id)
      if (cmd) { recordUsage(id); cmd.action(); close() }
    } else if (input.value.trim()) {
      // No match → send to JARVIS voice pipeline
      executeVoiceCmd(input.value.trim())
      close()
    }
  }

  input.addEventListener('input', () => renderResults(input.value))
  input.addEventListener('keydown', e => {
    const items = results.querySelectorAll<HTMLElement>('.jcb-item')
    if (e.key === 'ArrowDown') { e.preventDefault(); updateSelection(Math.min(_selectedIdx + 1, items.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); updateSelection(Math.max(_selectedIdx - 1, 0)) }
    if (e.key === 'Enter')     { e.preventDefault(); executeSelected() }
    if (e.key === 'Escape')    { close() }
  })

  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  renderResults(prefill)
  input.focus()
  if (prefill) input.select()
}

export function closeCommandBar(): void {
  document.getElementById('jcb-overlay')?.remove()
  _barOpen = false
}

export function isCommandBarOpen(): boolean { return _barOpen }

// ── Global keyboard shortcut ───────────────────────────────────────────────────

export function initCommandBar(executeVoiceCmd: (cmd: string) => void): void {
  document.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement).tagName
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)

    // Ctrl+Space or Ctrl+/ — open command bar
    if ((e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === '/') && !inInput) {
      e.preventDefault()
      openCommandBar(executeVoiceCmd)
    }
  })

  // Register built-in commands
  registerCommands(BUILTIN_COMMANDS(executeVoiceCmd))
}

// ── Built-in commands ──────────────────────────────────────────────────────────

function BUILTIN_COMMANDS(exec: (cmd: string) => void): CommandEntry[] {
  const q = (cmd: string) => () => exec(cmd)
  return [
    { id:'nav.plan',   label:'Open Planner',           desc:'Go to lecture planner section',          category:'Navigate', icon:'📚', action:()=>document.getElementById('plan')?.scrollIntoView({behavior:'smooth'}),      keywords:['planner','plan','lecture'] },
    { id:'nav.intel',  label:'Open Analytics',         desc:'Go to intelligence / scores section',    category:'Navigate', icon:'📊', action:()=>document.getElementById('intel')?.scrollIntoView({behavior:'smooth'}),     keywords:['analytics','stats','intelligence','chart'] },
    { id:'nav.engine', label:'Open Timer',             desc:'Go to focus timer',                      category:'Navigate', icon:'⏱', action:()=>document.getElementById('engine')?.scrollIntoView({behavior:'smooth'}),    keywords:['timer','focus','pomodoro'] },
    { id:'nav.routine',label:'Open Routine',           desc:'Go to daily routine section',            category:'Navigate', icon:'📋', action:()=>document.getElementById('routine-section')?.scrollIntoView({behavior:'smooth'}), keywords:['routine','daily'] },
    { id:'nav.const',  label:'Open Constitution',      desc:'Browse the Indian Constitution',         category:'Navigate', icon:'📜', action:()=>document.getElementById('constitution-section')?.scrollIntoView({behavior:'smooth'}), keywords:['constitution','article','fundamental'] },

    { id:'timer.start',label:'Start Timer',            desc:'Start a 25-minute Pomodoro session',     category:'Timer', icon:'▶', action:()=>{ const b=document.querySelector<HTMLButtonElement>('[data-act="start"]'); if(/start|resume/i.test(b?.textContent??'')) b?.click() }, keywords:['start','begin','focus'] },
    { id:'timer.pause',label:'Pause Timer',            desc:'Pause the running timer',                category:'Timer', icon:'⏸', action:()=>document.querySelector<HTMLButtonElement>('[data-act="start"]')?.click(),      keywords:['pause','stop'] },
    { id:'timer.reset',label:'Reset Timer',            desc:'Reset timer to starting position',       category:'Timer', icon:'↺', action:()=>document.querySelector<HTMLButtonElement>('[data-act="reset"]')?.click(),     keywords:['reset','restart'] },

    { id:'score.add',  label:'Add Score',              desc:'Log a test, mock, or DPP result',        category:'Scores', icon:'+', action:()=>document.getElementById('cm-add-score')?.click(),                          keywords:['score','marks','result','test','mock'] },
    { id:'mistake.add',label:'Log Mistake',            desc:'Add to mistake notebook',                category:'Learn',  icon:'✗', action:()=>document.getElementById('cm-add-mistake')?.click(),                        keywords:['mistake','wrong','error'] },
    { id:'note.add',   label:'Quick Note',             desc:'Capture an idea or insight',             category:'Learn',  icon:'📝', action:()=>document.getElementById('cm-add-note')?.click(),                          keywords:['note','capture','idea'] },
    { id:'ca.add',     label:'Log Current Affairs',    desc:'Add a CA entry',                        category:'Learn',  icon:'📰', action:()=>document.getElementById('cm-ca-log')?.click(),                            keywords:['current affairs','ca','news'] },
    { id:'ans.log',    label:'Answer Writing',         desc:'Log a mains answer',                     category:'Learn',  icon:'✍', action:()=>document.getElementById('cm-answer-log')?.click(),                        keywords:['answer','mains','writing'] },
    { id:'goals.open', label:'My Goals',               desc:'View and update study targets',          category:'Goals',  icon:'🎯', action:()=>document.getElementById('cm-goals')?.click(),                            keywords:['goals','targets'] },
    { id:'calendar',   label:'Calendar',               desc:'Week and month agenda view',             category:'Plan',   icon:'📅', action:()=>document.getElementById('cm-calendar')?.click(),                         keywords:['calendar','agenda','week'] },
    { id:'review',     label:'Weekly Review',          desc:'Reflect on this week',                   category:'Plan',   icon:'📋', action:()=>document.getElementById('cm-weekly-review')?.click(),                    keywords:['review','reflect','week'] },
    { id:'curriculum', label:'Curriculum',             desc:'Adaptive day-by-day study plan',         category:'Plan',   icon:'🗓', action:()=>document.getElementById('cm-curriculum')?.click(),                       keywords:['curriculum','study plan','schedule'] },
    { id:'export',     label:'Export Data',            desc:'Download JSON or CSV backup',            category:'Data',   icon:'↓', action:()=>document.getElementById('cm-export-btn')?.click(),                        keywords:['export','backup','download'] },
    { id:'settings',   label:'Settings',               desc:'Exam dates, capacity, planner config',   category:'System', icon:'⚙', action:()=>document.getElementById('cm-settings')?.click(),                         keywords:['settings','config','exam date'] },
    { id:'screen.lock',label:'Lock Screen',            desc:'Privacy / screen lock',                  category:'System', icon:'🔒', action:()=>document.getElementById('lock-btn')?.click(),                           keywords:['lock','privacy'] },
    { id:'focus.mode', label:'Focus Mode',             desc:'Toggle heavy animations off',            category:'System', icon:'🎯', action:()=>document.getElementById('focus-mode-btn')?.click(),                     keywords:['focus mode','animation','vfx'] },

    { id:'quiz',       label:'Quiz Me',                desc:'Start a UPSC MCQ quiz on any topic',     category:'Intelligence', icon:'❓', action:q('quiz me on '+(document.querySelector<HTMLElement>('[data-subject]')?.dataset.subject||'Polity')), keywords:['quiz','test','mcq'] },
    { id:'concept.web',label:'Concept Web',           desc:'Visual mind-map of topic connections',   category:'Intelligence', icon:'🕸', action:q('concept web for Polity'),                                          keywords:['concept','web','mind map'] },
    { id:'radar',      label:'UPSC Radar',             desc:'Readiness map across all subjects',      category:'Intelligence', icon:'📡', action:q('show upsc radar'),                                                keywords:['radar','readiness','subjects'] },
    { id:'socratic',   label:'Socratic Mode',          desc:'Deep questioning to test understanding', category:'Intelligence', icon:'🏛', action:q('socratic mode'),                                                   keywords:['socratic','question','understand'] },
    { id:'debate',     label:'Debate Session',         desc:'Argue a UPSC topic with JARVIS',         category:'Intelligence', icon:'⚔', action:q('debate session'),                                                  keywords:['debate','argue','discuss'] },
    { id:'memory',     label:'Memory Palace',          desc:'Spatial memory for facts and lists',     category:'Intelligence', icon:'🏺', action:q('memory palace'),                                                   keywords:['memory','palace','remember'] },

    { id:'status',     label:'Full Status',            desc:'Complete preparation overview',          category:'Report',    icon:'📊', action:q('full status'),                                                         keywords:['status','report','overview'] },
    { id:'evolve',     label:'Evolve JARVIS',          desc:'Trigger capability generation now',      category:'Evolution', icon:'🧬', action:q('evolve now'),                                                       keywords:['evolve','capabilities','generate'] },
    { id:'evolution.report', label:'Evolution Report', desc:'JARVIS growth statistics',              category:'Evolution', icon:'📈', action:q('evolution v2 report'),                                             keywords:['evolution','report','capabilities'] },

    // V5 ULTIMATE commands
    { id:'v5.agent',      label:'Autonomous Agent',     desc:'JARVIS executes a multi-step goal',      category:'V5',        icon:'🤖', action:q('agent: analyze my preparation and suggest this week\'s priority'), keywords:['agent','autonomous','multi-step','goal'] },
    { id:'v5.think',      label:'Deep Think',           desc:'Chain-of-thought reasoning on a topic',  category:'V5',        icon:'💭', action:q('think: what should I focus on for UPSC today?'),                   keywords:['think','chain of thought','reason','deep'] },
    { id:'v5.session',    label:'Start Study Session',  desc:'Orchestrated 2-hour focus session',      category:'V5',        icon:'🎓', action:q('start a 2-hour Polity session'),                                   keywords:['session','orchestrate','2 hour','focus'] },
    { id:'v5.suggestions',label:'Smart Suggestions',    desc:'Time-based study recommendations',       category:'V5',        icon:'⏰', action:q('what should I do now'),                                            keywords:['suggestions','now','what to do','temporal'] },
    { id:'v5.report',     label:'V5 Evolution Report',  desc:'V5 engine: benchmark, pareto, KG stats', category:'V5',        icon:'🔬', action:q('v5 report'),                                                       keywords:['v5','evolution','pareto','benchmark','kg'] },
    { id:'v5.followup.on',label:'Follow-ups On',        desc:'Enable AI-suggested follow-up questions',category:'V5',        icon:'💡', action:q('follow up on'),                                                    keywords:['follow up','suggestions','questions'] },
    { id:'v5.kg',         label:'Knowledge Graph',      desc:'Show connected concepts JARVIS learned',  category:'V5',        icon:'🕸', action:q('concept web for '+(typeof window !== 'undefined' ? (document.querySelector<HTMLElement>('[data-subject]')?.dataset.subject || 'Polity') : 'Polity')), keywords:['knowledge graph','concepts','graph','kg'] },
    { id:'v5.stop.agent', label:'Stop Agent',           desc:'Cancel running autonomous agent',         category:'V5',        icon:'🛑', action:q('stop agent'),                                                      keywords:['stop','cancel','agent'] },
    { id:'v5.cram.agent', label:'Emergency Cram Agent', desc:'Agent builds an emergency cram plan',    category:'V5',        icon:'🚨', action:q('agent: I have 4 hours left. Build me an emergency cram plan for Prelims covering most important topics.'), keywords:['emergency','cram','last minute','urgent'] },
    { id:'v5.mock.agent', label:'Mock Analysis Agent',  desc:'Agent analyses all mock scores & suggests weak areas', category:'V5', icon:'📋', action:q('agent: analyze all my mock test scores and tell me my 3 weakest areas with specific topics to revise'), keywords:['mock','analysis','weak','scores'] },
  ]
}
