# Handoff: Mission 2028 — UPSC Command Center

A personal, single-page, scroll-cinematic UPSC preparation "command center" for
**Om Shisodiya**, prepping the full civil-services cycle (Prelims → Mains → Interview)
for **CSE 2028**, studying the **PW IAS Prarambh 2027** batch and recovering from a backlog.

The page opens on a pinned hero whose animation is *scrubbed* by scroll, then flows
through working tracker "acts" with a national-identity motif (Ashoka Chakra, tricolour,
State Emblem, India map) woven throughout, plus heavy VFX and tactile interaction effects.

---

## Theme & images — already baked in

- **Gold is the default.** `styles.css` `:root` ships with `--accent:#f0b54a` / `--accent-2:#ffe39a`
  / `--accent-ink:#f3dba6`, and the Tweaks panel default `accent` matches. (The accent is still
  fully re-themable — the blue/teal/violet/mint/gold palettes are options in the Tweaks panel.)
- **The emblem and map images are included** in two forms:
  - `assets/national-emblem.webp` and `assets/india-map.webp` — real image files, ready to use
    directly in a production rebuild (`<img src="assets/india-map.webp">` etc.).
  - `.image-slots.state.json` — the sidecar the `<image-slot>` component reads, so when you serve
    the folder (`npx serve .`) the seal and map HUD show your images automatically, no drag needed.

> **Run it:** `npx serve .` from the folder, then open the served URL. Serving (not `file://`) is
> required so `<image-slot>` can `fetch('.image-slots.state.json')` and show the emblem + map.
> In a real codebase you'd typically drop `<image-slot>` and just use the files in `assets/`.

---

## About the Design Files

The files here (`UPSC Mission 2028.html`, `styles.css`, `engine.js`, `tweaks-panel.jsx`,
`image-slot.js`) are a **working HTML/CSS/vanilla-JS reference build** — a high-fidelity
prototype of the intended look, motion, and behavior.

They are **not** required to ship as-is. The goal is to **recreate this design in a real
codebase** using that project's patterns. If none exists yet, recommended stack:
**Vite + React + TypeScript**, CSS variables kept as-is (the token system is already CSS
custom properties), and a small persistence layer (today it's `localStorage`; the natural
next step is Supabase/Firebase/a tiny Node+SQLite API so progress syncs across devices).

The prototype is framework-free and self-contained, so you can also just **open it in VS
Code and keep extending the vanilla version** with no build step. Both paths are valid.

> **Run it:** open `UPSC Mission 2028.html` with any static server (e.g. `npx serve .`).
> Opening via `file://` works for most things, but the `<image-slot>` drag-and-drop
> persistence and Tweaks-panel persistence expect to be served from a folder root.

---

## Fidelity

**High-fidelity.** Final colors, type, spacing, motion curves, and interactions are decided
and implemented. Exact tokens live in `styles.css` `:root` and are listed under **Design Tokens**.

---

## Architecture at a glance

```
UPSC Mission 2028.html   — markup for all sections + command menu + Tweaks mount
styles.css               — full design system: tokens (:root) + every component style
engine.js                — ONE IIFE: canvas VFX + scroll choreography + all trackers + persistence
tweaks-panel.jsx         — React Tweaks panel (authoring aid; optional in production)
image-slot.js            — <image-slot> web component (user-fillable, persisted image drop zones)
```

`engine.js` is a single IIFE. Each feature is an isolated function invoked from `boot()`:

```
chakras, emblemStamp(→commandMenu, commandTodo), starfield, warp, reveals, heroScrub,
navAndParallax, nationalScroll, countdown, focusTimer, buildStreak, planner, barCharts,
rankSim, heatmap, donuts, constellation, constitution, aiPlan, countUps, interactions
```

To add a feature: write a function, call it in `boot()`. Reuse the helpers at the top of
the IIFE: `$ / $$` (query), `clamp`, `lerp`, `cssVar`, `reduced` (prefers-reduced-motion),
`onView(el,inFn,outFn,threshold)` (reversible enter/leave), and `store` (persistence).

---

## Persistence model (single integration point)

All app state flows through one object in `engine.js`:

```js
const store = {
  data: JSON.parse(localStorage.getItem('mission2028') || '{}'),
  get(k, def) { return (k in this.data) ? this.data[k] : def; },
  set(k, v) { this.data[k] = v; localStorage.setItem('mission2028', JSON.stringify(this.data)); },
};
```

Persisted keys:
| Key | Shape | Written by |
|---|---|---|
| `focusLog` | `{ 'YYYY-MM-DD': sessionCount }` | focus timer |
| `sessTotal` / `focusMins` | number | focus timer |
| `lectures` | `{ [lectureId]: true }` | lecture planner |
| `rankInputs` | `{ pre, mains, inter }` | rank simulator |
| `heatSeed` | number[] (26×7) | heatmap (seeded once) |
| `todos` | `{ 'YYYY-MM-DD': [ {t, done} ] }` | command-menu daily to-do |

`<image-slot>` images persist **separately** in a `.image-slots.state.json` sidecar (handled
by the component). The Tweaks panel persists separately via its own host protocol.

**To move to a backend:** make `store.get/set` async (seed `store.data` from a fetch on
boot). Every feature reads/writes only through `store`, so this is the one place to change.

---

## Page structure & sections (in scroll order)

1. **Fixed nav** (`.nav`) — brand = a spinning **Ashoka Chakra** mark (`.brand .mark .chakra`)
   + nameplate **"Om Shisodiya"** / designation "ASPIRANT · INDIAN ADMINISTRATIVE SERVICE";
   right-side jump links + "Start Focus" CTA. Solidifies (`.nav.solid`) after 40px scroll.
2. **Hero** (`#hero-track` → sticky `#hero`) — pinned scroll-scrub scene; see below.
3. **Countdown** — live T-minus to estimated CSE Prelims **2028-05-28T09:30+05:30** (`countdown()`).
4. **Bharat / "Why I rise"** — National **Emblem seal** (image-slot + 3 animated rings + Devanagari
   motto सत्यमेव जयते) and the **India map HUD** (image-slot + corner brackets + grid + scan sweep).
5. **Act II — Daily Engine** (`#engine`) — Pomodoro **focus timer** (logs sessions), **14-day streak**
   grid, **lecture planner** (from `PLAN[]`, check-off persists).
6. **Act III — Intelligence** (`#intel`) — count-up stat row, **mock-score bar chart**, **All-India
   Rank simulator** (3 sliders → composite → AIR + band), **26-week heatmap**, **subject-readiness donuts**.
7. **The Living Document** (`#constitution`) — *centered* meditative section; Articles **slowly
   cross-fade** (`ARTICLES[]`, ~5.2s) over an interactive **particle constellation** canvas; clickable
   article-chip ticker; hover pauses rotation.
8. **Act IV — The Plan** (`#plan`) — **AI plan generator** (deterministic typewriter from remaining
   backlog, chakra spinner), current-affairs feed, spaced-revision queue, answer-writing chart.
9. **Footer** — closing line + signature + **"Made by Om Shisodiya"**.

### Hero scroll-scrub (`heroScrub()`)
`#hero-track` is `height:320vh; position:relative`; `#hero` is `position:sticky; top:0;
height:100svh`, so the hero stays pinned for ~3 viewports while its animation is scrubbed by
scroll. `p` = scroll progress 0→1; `ss(a,b,x)` = smoothstep. Mapping (handler runs **synchronously**
on scroll, fully reversible):
- stage `scale = 1 + p*0.75*motion`; `opacity = 1 - ss(0.80,1,p)*0.7`
- msg0 ("The comeback / starts now.") `opacity = 1 - ss(0.24,0.46,p)`
- msg1 ("One block. / Then the next.") `opacity = clamp(ss(0.42,0.60,p) - ss(0.82,0.98,p),0,1)`
Hero background has 4 switchable atmospheres via `body[data-hero]`: `orbital` (default; rings +
grand chakra), `bharat` (chakra + saffron/green aura), `warp` (`#warp` canvas hyperspace), `aurora`.

---

## National-identity system (woven throughout)

- **Ashoka Chakra** — built in JS by `buildChakra()` (24 spokes + rim + glow ring + hub + pin dots)
  into every `.chakra[data-chakra]` host. Used as: nav brand mark, grand hero centerpiece
  (`.hero-chakra`), faint fixed background watermark (`#chakra-watermark`, parallax in `nationalScroll()`),
  section dividers (`.bharat-divider`), the emblem-stamp fallback, the command-menu watermark, and the
  AI-generator spinner. Inherits `--accent`.
- **Tricolour** — fixed scroll-progress thread `#tricolor-progress` (saffron→white→green, width = scroll %),
  `.tricolor-rule` mini-bars in eyebrows, the `bharat` hero aura, and the command-menu top edge. Intensity
  is the `--tricolor-strength` token (Tweaks slider).
- **State Emblem seal** (`.emblem-seal`) — `<image-slot id="national-emblem">` ringed by 3 animated rings;
  user drops the official emblem image (drawing it in code is intentionally avoided — legal sensitivity).
- **India map HUD** (`.map-stage`) — `<image-slot id="india-map">` (the slot sits at `z-index:5` ABOVE the
  decorative `.map-overlay` so its hover **Replace/Remove** controls — rendered just below the image — aren't
  clipped; `.map-stage` has `padding-bottom:40px` to give them room). Borders deliberately not auto-drawn.
- **Persistent emblem stamp** (`#emblem-stamp`, fixed **top-center**, `z-index:120`) — hidden at top, fades in
  once you scroll past `.emblem-wrap` (`emblemStamp()`), and **mirrors the dropped emblem image** (reads the
  slot's shadow-DOM `<img>` via MutationObserver; falls back to a chakra if empty). It is ALSO the drag handle
  for the command menu (below).

---

## Pull-down Command Menu (`commandMenu()` + `commandTodo()`)

The top-center **emblem stamp is a drag handle**. Pulling it **down** opens a full-width glassy
command menu (`#command-menu`) that follows the pointer; a blurred backdrop (`#menu-backdrop`) dims
the page. **Snap physics:** release past ~40% open → snaps open; below → retracts. A quick **tap toggles**.
The emblem **rides down** to the menu's lower edge and becomes the pull-up handle (`.es-pull` chevron
flips). Close by: dragging up, tapping the backdrop, **Esc**, or clicking a card (which smooth-scrolls to
that section). Menu z-order: backdrop 90, menu 100, emblem 120.

Menu contents:
- **6 nav cards** (`.cm-card[data-go]`) → The Mission / Daily Engine / Intelligence / Living Document /
  The Plan / Start Focus — staggered reveal via `#command-menu.open .cm-card:nth-child(n)` delays; hover
  underline-sweep + lift.
- **"Today's intentions" daily to-do** (`#cm-todo-*`) — text input + Add; each row has a checkbox (done →
  strikethrough) and × delete. Dated to today and persisted under `store('todos')[YYYY-MM-DD]` (fresh list
  each day). Staggers in after the cards.

Implementation notes: drag uses Pointer Events with pointer capture; `apply(p, withTransition)` sets the
menu's `translateY(-100%+p*100%)`, backdrop opacity, body `.menu-open`, and the emblem ride-down transform;
`.snap` class toggles the CSS transition for release animations only (off during drag).

---

## VFX & interaction effects

| Effect | Where | Notes |
|---|---|---|
| Starfield + **shooting-star comets** | `starfield()` | 3 parallax depth layers; periodic comets with gradient tails; scroll + mouse offset; scales with `--motion` |
| Warp hyperspace | `warp()` | `#warp` canvas; only when `data-hero="warp"` |
| **Particle constellation** | `constellation()` | `#const-particles`; nodes link within distance + lean toward cursor; only animates while in view |
| Reversible reveals | `reveals()` + `onView()` | IntersectionObserver toggles `.in` both ways (blur+lift+fade) |
| **Glow-sweep headings** | `.scene-head.in h2::after` | one-shot light wipe on reveal |
| **Staggered rise** | `.reveal-stagger` | children cascade up (stat row, etc.) |
| **Panel spotlight** | `interactions()` + `.panel::before` | accent sheen follows cursor inside glass panels |
| **3D tilt** | `.tilt` (#focus, #rank) | cards lean toward pointer (perspective rotateX/Y) |
| **Magnetic buttons + ripple** | `.btn`, `.nav-cta` | nudge toward cursor; ripple span on click |
| **Cursor aura** | `#cursor-aura` | eased blurred halo trailing the pointer |
| Bar/donut/count-up animate | `barCharts/donuts/countUps` | run on enter, reset on leave (reversible) |

All pointer-driven FX (spotlight, tilt, magnetic, aura) auto-disable on touch / reduced-motion.
Every animation respects `@media (prefers-reduced-motion: reduce)`.

---

## Design Tokens (from `styles.css` `:root`)

**Color** — bg `#05070f`, bg-2 `#080d1c`, bg-3 `#0b1224`; ink `#eaf0ff`, ink-soft `#b9c6e6`,
muted `#6f7d9e`; lines `rgba(120,168,255,.13/.22)`; panel fills `rgba(124,170,255,.035/.06)`;
**accent `#3aa0ff`** + accent-2 `#67e8ff` (tweakable; palettes: blue / teal `#2fe0d8` / violet `#b06cff`
/ mint `#2fe0a0` / gold `#f0b54a`); accent-ink `#bfe0ff`; warn `#ffb24a`, good `#45e0a8`, bad `#ff6b7d`;
**saffron `#ff9933`**, india-green `#138808`. Many surfaces derive shades with
`color-mix(in oklab, var(--accent) N%, …)` — keep that so re-theming stays one variable.

**Runtime multipliers (tokens):** `--motion` (0–1.4), `--glow` (0–1.6), `--tricolor-strength` (0–1.4) —
all driven by the Tweaks panel, plus `body[data-hero]` (orbital/bharat/warp/aurora).

**Type** (Google Fonts) — display **Sora** (h1–h3, big numbers), body **Manrope**, mono **JetBrains Mono**
(labels/eyebrows/data), and **Noto Serif Devanagari** (the सत्यमेव जयते motto + Constitution quotes).
H1 hero `clamp(48px,9.2vw,132px)` w600 ls -0.04em lh .92; H2 `clamp(34px,5vw,58px)`; body 17px/1.6;
eyebrows/labels mono 11–12.5px uppercase ls .2–.34em. **No emojis** — deliberate.

**Radius/space/shadow** — `--r 18px`, `--r-sm 11px`, content `--maxw 1180px` (`.wrap` pad 0 32px / 0 20px
< 640px), `section.scene` padding `150px 0` (100px < 640px), `--shadow-soft 0 24px 60px -28px rgba(0,0,0,.8)`.
Motion easing `cubic-bezier(.16,1,.3,1)`; smoothstep `t*t*(3-2*t)`; orbit spins 38/64/96s.

---

## Assets

- **No raster/icon files.** All visuals are CSS/canvas/SVG drawn in code (chakra, starfield, comets,
  constellation, warp, progress ring, donuts, bar charts, HUD, seal rings). The check/chevron icons are
  inline SVG paths.
- **Two user-supplied images** via `<image-slot>`: the **State Emblem** (`#national-emblem`) and the
  **India map** (`#india-map`). They persist to a `.image-slots.state.json` sidecar. In a real app, replace
  `<image-slot>` with your asset/upload component, or hard-code official assets you have rights to.
- **Fonts** load from Google Fonts — self-host in production.
- `tweaks-panel.jsx` is an authoring aid; drop it (or replace with real user settings) in production.

---

## Extending (what comes next)

- **Real lecture data:** the `PLAN[]` array in `engine.js` is the source of truth for the lecture planner —
  make it data-driven from the actual Prarambh 2027 schedule, grouped by subject/week.
- **Surface to-dos on the page:** the command-menu daily to-do (`store('todos')`) could feed a
  "tasks remaining today" indicator near the focus timer.
- **Real AI plan:** swap `aiPlan()`'s deterministic builder for a model call (backend → LLM); keep the
  typewriter reveal. (In the prototype env this would be `window.claude.complete`.)
- **Backend sync / login:** see **Persistence model** — one integration point (`store`).
- **Confirm the exam date** in `countdown()` once the official CSE 2028 Prelims date is announced.
- **More Constitution Articles:** extend the `ARTICLES[]` array.

---

## Files
- `UPSC Mission 2028.html` — all markup, command menu, Tweaks mount
- `styles.css` — tokens + every component style
- `engine.js` — VFX + scroll + trackers + menu + persistence (start here for behavior)
- `tweaks-panel.jsx` — authoring-time Tweaks panel (optional in production)
- `image-slot.js` — user-fillable, persisted image drop-zone web component
