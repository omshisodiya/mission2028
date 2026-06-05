/**
 * jarvis-smart-answers.ts — Dynamic answer engine for JARVIS
 *
 * Handles ANY date/time/day/timezone/calculation query locally with zero network.
 * Returns null if not a locally-answerable query → caller sends to Groq.
 */

// ── IST date/time helpers ─────────────────────────────────────────────────────

function nowIST(): Date {
  // Returns a Date adjusted to IST (UTC+5:30)
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
}

function fmtFull(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

function fmtShort(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

// ── Day-of-week helpers ────────────────────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, itwar: 0,
  monday: 1, mon: 1, somvar: 1,
  tuesday: 2, tue: 2, mangalvar: 2,
  wednesday: 3, wed: 3, budhvar: 3,
  thursday: 4, thu: 4, guruvar: 4, brihaspativar: 4,
  friday: 5, fri: 5, shukravar: 5,
  saturday: 6, sat: 6, shanivar: 6,
}

/** Return the date of next occurrence of a given weekday (including today if matches) */
function nextWeekday(dayNum: number, allowToday = false): Date {
  const d = nowIST()
  const cur = d.getDay()
  let diff = dayNum - cur
  if (diff < 0 || (diff === 0 && !allowToday)) diff += 7
  return addDays(d, diff)
}

/** Return the date of previous occurrence of a given weekday */
function prevWeekday(dayNum: number): Date {
  const d = nowIST()
  const cur = d.getDay()
  let diff = cur - dayNum
  if (diff <= 0) diff += 7
  return addDays(d, -diff)
}

// ── Month helpers ──────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
}

// ── Holiday / fixed-date database ─────────────────────────────────────────────

interface Holiday {
  name:    string
  month:   number   // 0-based
  day:     number
}

const FIXED_HOLIDAYS: Holiday[] = [
  { name: 'New Year',                month: 0,  day: 1  },
  { name: 'Republic Day',            month: 0,  day: 26 },
  { name: 'Valentine\'s Day',        month: 1,  day: 14 },
  { name: 'Holi',                    month: 2,  day: 14 }, // approximate
  { name: 'World Water Day',         month: 2,  day: 22 },
  { name: 'April Fools Day',         month: 3,  day: 1  },
  { name: 'Earth Day',               month: 3,  day: 22 },
  { name: 'Labour Day',              month: 4,  day: 1  },
  { name: 'World Environment Day',   month: 5,  day: 5  },
  { name: 'World Yoga Day',          month: 5,  day: 21 },
  { name: 'Independence Day',        month: 7,  day: 15 },
  { name: 'Teacher\'s Day',          month: 8,  day: 5  },
  { name: 'Gandhi Jayanti',          month: 9,  day: 2  },
  { name: 'Dussehra',                month: 9,  day: 2  }, // approximate
  { name: 'Children\'s Day',         month: 10, day: 14 },
  { name: 'Constitution Day',        month: 10, day: 26 },
  { name: 'Christmas',               month: 11, day: 25 },
  { name: 'New Year Eve',            month: 11, day: 31 },
]

function findHoliday(query: string): Holiday | null {
  const tl = query.toLowerCase()
  for (const h of FIXED_HOLIDAYS) {
    if (tl.includes(h.name.toLowerCase().split(' ')[0]) ||
        tl.includes(h.name.toLowerCase())) {
      return h
    }
  }
  // Pattern matches
  if (/republic\s*day|26\s*jan/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Republic Day')!
  if (/independence\s*day|15\s*aug/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Independence Day')!
  if (/gandhi\s*jayanti|2\s*oct/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Gandhi Jayanti')!
  if (/constitution\s*day|samvidhan\s*diwas/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Constitution Day')!
  if (/christmas|xmas/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Christmas')!
  if (/new\s*year|naya\s*saal/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'New Year')!
  if (/teacher.*day|shikshak\s*diwas/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Teacher\'s Day')!
  if (/children.*day|bal\s*diwas/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Children\'s Day')!
  if (/labour|labor|workers.*day|mazdoor/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Labour Day')!
  if (/earth\s*day/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'Earth Day')!
  if (/yoga\s*day/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'World Yoga Day')!
  if (/environment\s*day/i.test(tl)) return FIXED_HOLIDAYS.find(h => h.name === 'World Environment Day')!
  return null
}

function getHolidayDate(h: Holiday, year?: number): Date {
  const y = year ?? nowIST().getFullYear()
  const d = new Date(y, h.month, h.day)
  // If the date has already passed this year, return next year
  const today = nowIST()
  if (d < today && !year) {
    return new Date(y + 1, h.month, h.day)
  }
  return d
}

// ── Timezone database ─────────────────────────────────────────────────────────

interface TZEntry { name: string; tz: string; aliases: string[] }

const TIMEZONES: TZEntry[] = [
  { name: 'India (IST)',       tz: 'Asia/Kolkata',        aliases: ['india','ist','kolkata','delhi','mumbai','bangalore','chennai','hyderabad'] },
  { name: 'New York (EST/EDT)',tz: 'America/New_York',     aliases: ['new york','new york city','nyc','est','edt','eastern'] },
  { name: 'London (GMT/BST)', tz: 'Europe/London',        aliases: ['london','uk','england','britain','gmt','bst'] },
  { name: 'Dubai (GST)',       tz: 'Asia/Dubai',           aliases: ['dubai','uae','abu dhabi','gulf'] },
  { name: 'Tokyo (JST)',       tz: 'Asia/Tokyo',           aliases: ['tokyo','japan','jst'] },
  { name: 'Beijing (CST)',     tz: 'Asia/Shanghai',        aliases: ['beijing','china','shanghai','chinese','cst'] },
  { name: 'Sydney (AEST)',     tz: 'Australia/Sydney',     aliases: ['sydney','australia','melbourne','brisbane','aest'] },
  { name: 'Paris (CET/CEST)', tz: 'Europe/Paris',         aliases: ['paris','france','europe','cet','cest'] },
  { name: 'New York',          tz: 'America/Los_Angeles',  aliases: ['los angeles','la','california','pst','pdt','pacific'] },
  { name: 'Singapore (SGT)',   tz: 'Asia/Singapore',       aliases: ['singapore','sgt'] },
  { name: 'Moscow (MSK)',      tz: 'Europe/Moscow',        aliases: ['moscow','russia','msk'] },
  { name: 'Berlin (CET)',      tz: 'Europe/Berlin',        aliases: ['berlin','germany','german'] },
  { name: 'Washington DC',     tz: 'America/New_York',     aliases: ['washington','dc','washington dc'] },
  { name: 'Karachi (PKT)',     tz: 'Asia/Karachi',         aliases: ['karachi','pakistan','pkt'] },
  { name: 'Dhaka (BST)',       tz: 'Asia/Dhaka',           aliases: ['dhaka','bangladesh'] },
  { name: 'Kathmandu (NPT)',   tz: 'Asia/Kathmandu',       aliases: ['kathmandu','nepal','npt'] },
  { name: 'Colombo (SLST)',    tz: 'Asia/Colombo',         aliases: ['colombo','sri lanka','srilanka'] },
]

function findTimezone(query: string): TZEntry | null {
  const tl = query.toLowerCase()
  // Check aliases
  for (const tz of TIMEZONES) {
    for (const alias of tz.aliases) {
      if (tl.includes(alias)) return tz
    }
  }
  return null
}

// ── Day-difference calculator ─────────────────────────────────────────────────

function daysBetween(d1: Date, d2: Date): number {
  const ms = d2.getTime() - d1.getTime()
  return Math.round(ms / 86_400_000)
}

// ── Historical day-of-week ────────────────────────────────────────────────────

const DAY_WORDS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function historicalDayOfWeek(day: number, month: number, year: number): string {
  const d = new Date(year, month, day)
  return DAY_WORDS[d.getDay()]
}

// ── MAIN SMART ANSWER ENGINE ──────────────────────────────────────────────────

export interface SmartAnswer {
  text: string
  confidence: 'certain' | 'approximate'
}

export function trySmartAnswer(query: string): SmartAnswer | null {
  const t = query.toLowerCase().trim()
  const today = nowIST()

  // ── TIME ─────────────────────────────────────────────────────────────────────
  if (/\btime\b|\bbaje\b|\bclock\b|\bghanta\b|\bsamay\b/i.test(t) &&
      !/timer|pomodoro|study|focus|remaining|how\s+long|exam\s+time|session/i.test(t)) {

    // Timezone-specific time
    const tzEntry = findTimezone(t)
    if (tzEntry && !/india|ist|local/i.test(t.replace(tzEntry.aliases.find(a => t.includes(a)) ?? '', ''))) {
      const tzTime = new Date().toLocaleTimeString('en-IN', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tzEntry.tz,
      })
      return { text: `${tzTime} in ${tzEntry.name}`, confidence: 'certain' }
    }

    // Local IST time
    const ts = new Date().toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
    })
    return { text: `${ts} IST`, confidence: 'certain' }
  }

  // ── TIMEZONE-ONLY query ("what time in London?") ──────────────────────────────
  if (/time\s+in\s+|in\s+\w+\s+time|kya\s+time\s+hai\s+/i.test(t)) {
    const tzEntry = findTimezone(t)
    if (tzEntry) {
      const tzTime = new Date().toLocaleTimeString('en-IN', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tzEntry.tz,
      })
      return { text: `It's ${tzTime} in ${tzEntry.name}.`, confidence: 'certain' }
    }
  }

  // ── HOLIDAY DATE ──────────────────────────────────────────────────────────────
  const holiday = findHoliday(t)
  if (holiday && /date|kab|when|din|day/i.test(t)) {
    const hDate = getHolidayDate(holiday)
    const daysDiff = daysBetween(today, hDate)
    const suffix = daysDiff === 0 ? ' — that\'s today!'
      : daysDiff === 1 ? ' — tomorrow!'
      : daysDiff > 0 ? ` — in ${daysDiff} days.`
      : ` — was ${Math.abs(daysDiff)} days ago.`
    return {
      text: `${holiday.name} is on ${fmtFull(hDate)}${suffix}`,
      confidence: holiday.name.includes('Holi') || holiday.name.includes('Dussehra') ? 'approximate' : 'certain',
    }
  }

  // ── DAYS UNTIL / COUNTDOWN ────────────────────────────────────────────────────
  if (/how\s+many\s+days|kitne\s+din|days?\s+(?:until|till|to|left|remaining|bache)|countdown/i.test(t)) {
    // Days until a holiday
    const hol = findHoliday(t)
    if (hol) {
      const hDate = getHolidayDate(hol)
      const diff = daysBetween(today, hDate)
      if (diff >= 0) return { text: `${diff} day${diff !== 1 ? 's' : ''} until ${hol.name} (${fmtShort(hDate)}).`, confidence: 'certain' }
    }

    // Days until a specific weekday
    for (const [name, num] of Object.entries(DAY_NAMES)) {
      if (t.includes(name)) {
        const next = nextWeekday(num)
        const diff = daysBetween(today, next)
        const dayName = DAY_WORDS[num]
        return { text: `${diff} day${diff !== 1 ? 's' : ''} until ${dayName} (${fmtShort(next)}).`, confidence: 'certain' }
      }
    }

    // Days until a specific month
    for (const [name, num] of Object.entries(MONTH_NAMES)) {
      if (t.includes(name)) {
        const target = new Date(today.getFullYear(), num, 1)
        if (target <= today) target.setFullYear(today.getFullYear() + 1)
        const diff = daysBetween(today, target)
        const mName = target.toLocaleString('en-IN', { month: 'long' })
        return { text: `${diff} days until ${mName} ${target.getFullYear()}.`, confidence: 'certain' }
      }
    }
  }

  // ── RELATIVE DATE (tomorrow, yesterday, day after tomorrow) ──────────────────
  if (/\btomorrow\b|\bkal\b(?!\s+tha|\s+kya\s+tha)/i.test(t) && !/exam|prelims|plan|lecture/i.test(t)) {
    const d = addDays(today, 1)
    if (/date|din|day|kya|kaun|tarikh/i.test(t) || /^(what.*tomorrow|tomorrow.*what|kal.*date|kal.*kya)/.test(t)) {
      return { text: fmtFull(d), confidence: 'certain' }
    }
    // "Is tomorrow a holiday?" type — just give date
    return { text: `Tomorrow is ${fmtFull(d)}.`, confidence: 'certain' }
  }

  if (/\byesterday\b|\bkal\s+tha\b|\bpichle\s+din\b/i.test(t) && !/plan|exam/i.test(t)) {
    return { text: fmtFull(addDays(today, -1)), confidence: 'certain' }
  }

  if (/\bday\s+after\s+tomorrow\b|\bparson\b|\bprasson\b/i.test(t)) {
    return { text: fmtFull(addDays(today, 2)), confidence: 'certain' }
  }

  if (/\bday\s+before\s+yesterday\b|\bpichle\s+kal\s+se\s+pehle\b/i.test(t)) {
    return { text: fmtFull(addDays(today, -2)), confidence: 'certain' }
  }

  // ── NEXT / LAST WEEKDAY ───────────────────────────────────────────────────────
  for (const [name, num] of Object.entries(DAY_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const isNext = /next|agle|upcoming|coming/i.test(t)
      const isLast = /last|pichle|previous|past/i.test(t)
      const isDate = /date|kab|when|tarikh/i.test(t)

      if (isNext || isDate || (!isLast && t.includes(name))) {
        const d = nextWeekday(num, isDate && !isNext)
        return { text: `${DAY_WORDS[num]}, ${fmtShort(d)}`, confidence: 'certain' }
      }
      if (isLast) {
        const d = prevWeekday(num)
        return { text: `Last ${DAY_WORDS[num]} was ${fmtShort(d)}`, confidence: 'certain' }
      }
    }
  }

  // ── WHAT DAY WAS [historical date] ───────────────────────────────────────────
  {
    const histM = t.match(/(?:what\s+day\s+was|day.*on)\s+(?:(\d{1,2})\s+(\w+)\s+(\d{4})|(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2}))/i)
    if (histM) {
      let day: number, month: number, year: number
      if (histM[1]) {
        day = parseInt(histM[1])
        month = MONTH_NAMES[histM[2].toLowerCase()] ?? parseInt(histM[2]) - 1
        year = parseInt(histM[3])
      } else {
        year = parseInt(histM[4]); month = parseInt(histM[5]) - 1; day = parseInt(histM[6])
      }
      if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
        const dayName = historicalDayOfWeek(day, month, year)
        const d = new Date(year, month, day)
        return { text: `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} was a ${dayName}.`, confidence: 'certain' }
      }
    }
  }

  // ── SPECIFIC DATE IN MONTH ────────────────────────────────────────────────────
  // e.g. "what day is 25 December" / "25 December ka din kya hai"
  {
    const specM = t.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i)
    if (specM && /day|din|kya|what|weekday|which/i.test(t)) {
      const day = parseInt(specM[1])
      const month = MONTH_NAMES[specM[2].toLowerCase()]
      if (!isNaN(month)) {
        const year = today.getFullYear()
        const d = new Date(year, month, day)
        if (d < today) d.setFullYear(year + 1)
        const dayName = DAY_WORDS[d.getDay()]
        const diff = daysBetween(today, d)
        return {
          text: `${specM[1]} ${d.toLocaleString('en-IN', { month: 'long' })} ${d.getFullYear()} is a ${dayName}${diff > 0 ? ` (in ${diff} days)` : diff === 0 ? ' (today!)' : ''}.`,
          confidence: 'certain',
        }
      }
    }
  }

  // ── WEEK / MONTH NUMBER ────────────────────────────────────────────────────────
  if (/which\s+week|what\s+week|week\s+number|week\s+no|is\s+it\s+which\s+week/i.test(t)) {
    const startOfYear = new Date(today.getFullYear(), 0, 1)
    const weekNum = Math.ceil(((today.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7)
    return { text: `It's week ${weekNum} of ${today.getFullYear()}.`, confidence: 'certain' }
  }

  if (/which\s+month|what\s+month|current\s+month|is\s+it\s+which\s+month/i.test(t)) {
    const month = today.toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' })
    return { text: `It's ${month} ${today.getFullYear()}.`, confidence: 'certain' }
  }

  // ── TODAY'S DATE ──────────────────────────────────────────────────────────────
  if (/\b(today|aaj|current date|today.*date|date.*today|what.*date|tarikh|date\s+kya|kaun\s+si\s+date)\b/i.test(t) &&
      !/plan|exam|prelims|mains|session|lecture|set|change|study/i.test(t)) {
    return { text: fmtFull(today), confidence: 'certain' }
  }

  // ── QUICK MATH ────────────────────────────────────────────────────────────────
  {
    const mathM = t.replace(/^(what\s+is|calculate|compute|solve|kitna\s+hai)\s+/i, '').trim()
    const pure = mathM.match(/^(-?\d[\d.,]*)\s*([+\-×x*/÷^%])\s*(-?\d[\d.,]*)$/)
    if (pure) {
      const a = parseFloat(pure[1].replace(/,/g,'')), op = pure[2], b = parseFloat(pure[3].replace(/,/g,''))
      let result: number | null = null
      if (op === '+') result = a + b
      else if (op === '-') result = a - b
      else if (op === '*' || op === '×' || op === 'x') result = a * b
      else if (op === '/' || op === '÷') result = b !== 0 ? a / b : null
      else if (op === '%') result = a % b
      if (result !== null && isFinite(result)) {
        return { text: `${a} ${op} ${b} = ${parseFloat(result.toFixed(8))}`, confidence: 'certain' }
      }
    }

    // Percentage: "15% of 200" / "what is 20 percent of 500"
    const pctM = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/)
    if (pctM) {
      const pct = parseFloat(pctM[1]), num = parseFloat(pctM[2])
      return { text: `${pct}% of ${num} = ${(pct * num / 100).toFixed(2)}`, confidence: 'certain' }
    }
  }

  // ── DAY OF WEEK QUERY (generic) ───────────────────────────────────────────────
  if (/what.*day.*today|today.*what.*day|aaj.*kaunsa.*din|kaunsa.*din.*aaj/i.test(t)) {
    const dayName = DAY_WORDS[today.getDay()]
    return { text: `Today is ${dayName}, ${fmtShort(today)}.`, confidence: 'certain' }
  }

  return null
}
