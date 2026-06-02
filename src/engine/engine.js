/* ============================================================
   MISSION 2028 — engine.js
   Canvas VFX + scroll choreography + persisted trackers
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp  = (a, b, t) => a + (b - a) * t;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- tiny localStorage store ---------- */
  const KEY = 'mission2028';
  const store = {
    data: JSON.parse(localStorage.getItem(KEY) || '{}'),
    get(k, def) { return (k in this.data) ? this.data[k] : def; },
    set(k, v) { this.data[k] = v; localStorage.setItem(KEY, JSON.stringify(this.data)); },
  };

  /* ============================================================
     0. ASHOKA CHAKRA builder (24 spokes) + national motifs
     ============================================================ */
  function buildChakra(host) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.classList.add('chakra-svg');
    const cx = 100, cy = 100;
    const mk = (tag, attrs, cls) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (cls) e.setAttribute('class', cls);
      return e;
    };
    // outer rim + inner glow ring
    svg.appendChild(mk('circle', { cx, cy, r: 92, 'stroke-width': 2 }, 'rim'));
    svg.appendChild(mk('circle', { cx, cy, r: 86, 'stroke-width': 1, opacity: 0.6 }, 'glowring'));
    // hub
    svg.appendChild(mk('circle', { cx, cy, r: 11, 'stroke-width': 2.5 }, 'hub'));
    svg.appendChild(mk('circle', { cx, cy, r: 3.4, 'stroke-width': 0, fill: 'currentColor' }, 'hub'));
    // 24 spokes + outer pin dots
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(a) * 12, y1 = cy + Math.sin(a) * 12;
      const x2 = cx + Math.cos(a) * 84, y2 = cy + Math.sin(a) * 84;
      svg.appendChild(mk('line', { x1, y1, x2, y2, 'stroke-width': 1.4 }, 'spoke'));
      const px = cx + Math.cos(a) * 84, py = cy + Math.sin(a) * 84;
      svg.appendChild(mk('circle', { cx: px, cy: py, r: 2.1, 'stroke-width': 0, fill: 'currentColor' }, 'pin'));
    }
    host.appendChild(svg);
  }
  function chakras() {
    $$('.chakra[data-chakra]').forEach(c => { if (!c.firstChild) buildChakra(c); });
  }

  /* ============================================================
     0b. PERSISTENT EMBLEM STAMP — mirrors the dropped emblem,
         reveals after scrolling past the seal
     ============================================================ */
  function emblemStamp() {
    const stamp = $('#emblem-stamp');
    const seal = $('.emblem-wrap');
    const slot = $('image-slot#national-emblem');
    if (!stamp || !seal) return;
    const imgEl = stamp.querySelector('.es-img');

    function syncImage() {
      let src = null;
      if (slot && slot.shadowRoot) {
        const im = slot.shadowRoot.querySelector('.frame img') || slot.shadowRoot.querySelector('img');
        if (im && im.src && !im.src.startsWith('data:,')) src = im.src;
      }
      if (src) {
        imgEl.style.backgroundImage = `url("${src}")`;
        stamp.classList.add('has-img');
      } else {
        imgEl.style.backgroundImage = '';
        stamp.classList.remove('has-img');
      }
    }
    syncImage();
    [400, 1200, 2600].forEach(t => setTimeout(syncImage, t));
    if (slot && slot.shadowRoot) {
      const mo = new MutationObserver(syncImage);
      mo.observe(slot.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
    if (slot) slot.addEventListener('click', () => setTimeout(syncImage, 300));

    function onScroll() {
      const b = seal.getBoundingClientRect().bottom;
      stamp.classList.toggle('show', b < 90);
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    commandMenu(stamp);
  }

  /* ============================================================
     0c. PULL-DOWN COMMAND MENU (emblem is the drag handle)
     ============================================================ */
  function commandMenu(stamp) {
    const menu = $('#command-menu');
    const backdrop = $('#menu-backdrop');
    if (!menu || !stamp) return;
    let H = 0, open = 0, dragging = false, startY = 0, startOpen = 0, moved = 0;

    function measure() { H = menu.offsetHeight || 360; }
    measure(); addEventListener('resize', measure);

    function apply(p, withTransition) {
      p = clamp(p, 0, 1);
      open = p;
      menu.classList.toggle('snap', !!withTransition);
      menu.style.transform = `translateY(${(-100 + p * 100).toFixed(2)}%)`;
      // emblem rides down to the menu's lower edge as it opens
      const travel = Math.max(0, H - 16 - stamp.offsetHeight * 0.4);
      const baseY = parseFloat(getComputedStyle(stamp).top) || 16;
      stamp.style.transform = `translate(-50%, ${(p * travel).toFixed(1)}px) scale(1)`;
      backdrop.classList.toggle('on', p > 0.02);
      backdrop.style.opacity = String(p);
      document.body.classList.toggle('menu-open', p > 0.5);
      menu.classList.toggle('open', p > 0.5);
    }
    function openMenu() { measure(); apply(1, true); document.body.classList.add('menu-open'); }
    function closeMenu() {
      apply(0, true);
      document.body.classList.remove('menu-open');
      setTimeout(() => { stamp.style.transform = ''; }, 640); // restore .show transform
    }

    // drag
    stamp.addEventListener('pointerdown', (e) => {
      if (!stamp.classList.contains('show')) return;
      e.preventDefault();
      measure();
      dragging = true; moved = 0; startY = e.clientY; startOpen = open;
      stamp.classList.add('dragging'); document.body.classList.add('menu-dragging');
      menu.classList.remove('snap');
      stamp.setPointerCapture(e.pointerId);
    });
    stamp.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY; moved = Math.max(moved, Math.abs(dy));
      apply(startOpen + dy / H, false);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      stamp.classList.remove('dragging'); document.body.classList.remove('menu-dragging');
      try { stamp.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved < 6) { (open > 0.5 ? closeMenu : openMenu)(); return; } // treat as tap → toggle
      (open > 0.4 ? openMenu : closeMenu)();
    }
    stamp.addEventListener('pointerup', endDrag);
    stamp.addEventListener('pointercancel', endDrag);

    // close affordances
    backdrop.addEventListener('click', closeMenu);
    $$('.cm-card', menu).forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('data-go');
      const t = id === '#hero' ? document.body : $(id);
      closeMenu();
      setTimeout(() => {
        if (id === '#hero') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 20, behavior: 'smooth' });
      }, 200);
    }));
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && open > 0.5) closeMenu(); });

    commandTodo();
  }

  /* daily to-do list (persisted per day) inside the command menu */
  function commandTodo() {
    const form = $('#cm-todo-form'), input = $('#cm-todo-input'), list = $('#cm-todo-list');
    const countEl = $('#cm-todo-count'), todayEl = $('#cm-today');
    if (!form) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    if (todayEl) todayEl.textContent = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const all = () => store.get('todos', {});
    const get = () => all()[todayKey] || [];
    function save(items) { const a = all(); a[todayKey] = items; store.set('todos', a); }
    function render() {
      const items = get();
      list.innerHTML = '';
      items.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = 'cm-todo-row' + (it.done ? ' done' : '');
        row.innerHTML = '<button class="check" aria-label="toggle"><svg viewBox="0 0 24 24" fill="none" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg></button>'
          + '<span class="ct-text"></span><button class="ct-del" aria-label="delete">\u00d7</button>';
        row.querySelector('.ct-text').textContent = it.t;
        row.querySelector('.check').addEventListener('click', () => { items[idx].done = !items[idx].done; save(items); render(); });
        row.querySelector('.ct-del').addEventListener('click', () => { items.splice(idx, 1); save(items); render(); });
        list.appendChild(row);
      });
      if (countEl) countEl.textContent = items.length;
      if (!items.length) {
        const e = document.createElement('p');
        e.className = 'cm-todo-empty';
        e.textContent = 'No intentions set yet. Name your first win for today.';
        list.appendChild(e);
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim(); if (!v) return;
      const items = get(); items.push({ t: v, done: false }); save(items);
      input.value = ''; render(); input.focus();
    });
    render();
  }

  /* tricolour scroll-progress thread + chakra watermark parallax */
  function nationalScroll() {
    const bar = $('#tricolor-progress');
    const wm = $('#chakra-watermark');
    function onScroll() {
      const h = document.documentElement;
      const max = Math.max(1, h.scrollHeight - innerHeight);
      const p = clamp(window.scrollY / max, 0, 1);
      if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
      if (wm) {
        const motion = parseFloat(cssVar('--motion')) || 1;
        wm.style.transform = `translateY(calc(-50% + ${(-window.scrollY * 0.05 * motion).toFixed(1)}px))`;
      }
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }


  function starfield() {
    const cv = $('#starfield');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H, DPR, stars = [];
    const layers = [
      { n: 90, sp: 0.02, r: [0.4, 0.9], a: 0.5 },
      { n: 55, sp: 0.05, r: [0.6, 1.3], a: 0.7 },
      { n: 28, sp: 0.10, r: [0.9, 1.8], a: 0.95 },
    ];
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      W = cv.width = innerWidth * DPR;
      H = cv.height = innerHeight * DPR;
      cv.style.width = innerWidth + 'px';
      cv.style.height = innerHeight + 'px';
      build();
    }
    function build() {
      stars = [];
      layers.forEach((L, li) => {
        for (let i = 0; i < L.n; i++) {
          stars.push({
            x: Math.random() * W, y: Math.random() * H,
            r: lerp(L.r[0], L.r[1], Math.random()) * DPR,
            a: L.a * (0.4 + Math.random() * 0.6),
            sp: L.sp, li,
            tw: Math.random() * Math.PI * 2,
          });
        }
      });
    }
    let scrollY = 0, mx = 0, my = 0;
    addEventListener('scroll', () => { scrollY = scrollY; }, { passive: true });
    addEventListener('mousemove', (e) => {
      mx = (e.clientX / innerWidth - 0.5);
      my = (e.clientY / innerHeight - 0.5);
    }, { passive: true });

    let t = 0;
    let comets = [];
    let nextComet = 3 + Math.random() * 5;
    function spawnComet() {
      const fromLeft = Math.random() < 0.5;
      comets.push({
        x: fromLeft ? -40 : W + 40,
        y: Math.random() * H * 0.5,
        vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 3) * DPR,
        vy: (1.4 + Math.random() * 1.2) * DPR,
        life: 1,
      });
    }
    function frame() {
      const motion = parseFloat(cssVar('--motion')) || 1;
      const accent = cssVar('--accent') || '#3aa0ff';
      const accent2 = cssVar('--accent-2') || '#67e8ff';
      t += 0.016;
      ctx.clearRect(0, 0, W, H);
      const sy = window.scrollY;
      for (const s of stars) {
        const par = sy * s.sp * DPR * motion;
        let y = (s.y - par) % H;
        if (y < 0) y += H;
        const px = s.x + mx * 26 * (s.li + 1) * DPR * motion;
        const py = y + my * 18 * (s.li + 1) * DPR * motion;
        const tw = 0.65 + 0.35 * Math.sin(t * (1 + s.li) + s.tw);
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fillStyle = (s.li === 2 ? accent2 : (s.li === 1 ? accent : '#cfe0ff'));
        ctx.globalAlpha = s.a * tw * clamp(motion, 0.2, 1.4);
        ctx.fill();
      }
      // comets / shooting stars
      nextComet -= 0.016 * clamp(motion, 0.3, 1.4);
      if (nextComet <= 0 && comets.length < 3) { spawnComet(); nextComet = 4 + Math.random() * 6; }
      for (const c of comets) {
        c.x += c.vx * motion; c.y += c.vy * motion; c.life -= 0.006;
        const tx = c.x - c.vx * 9, ty = c.y - c.vy * 9;
        const g = ctx.createLinearGradient(c.x, c.y, tx, ty);
        g.addColorStop(0, accent2); g.addColorStop(1, 'transparent');
        ctx.strokeStyle = g; ctx.globalAlpha = clamp(c.life, 0, 1) * 0.9;
        ctx.lineWidth = 1.6 * DPR; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.beginPath(); ctx.arc(c.x, c.y, 1.8 * DPR, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      }
      comets = comets.filter(c => c.life > 0 && c.x > -80 && c.x < W + 80 && c.y < H + 80);
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    resize();
    addEventListener('resize', resize);
    if (!reduced) frame(); else {
      // static draw
      for (const s of stars) { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fillStyle = '#cfe0ff'; ctx.globalAlpha = s.a; ctx.fill(); }
    }
  }

  /* ============================================================
     2. WARP canvas (hero variant)
     ============================================================ */
  function warp() {
    const cv = $('#warp');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H, DPR, pts = [];
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      W = cv.width = cv.offsetWidth * DPR;
      H = cv.height = cv.offsetHeight * DPR;
    }
    function reset(p) {
      const ang = Math.random() * Math.PI * 2;
      p.ang = ang; p.d = Math.random() * 30 * DPR; p.sp = (0.6 + Math.random() * 2.2) * DPR; p.len = 0;
    }
    function build() { pts = []; for (let i = 0; i < 160; i++) { const p = {}; reset(p); p.d = Math.random() * Math.max(W, H) * 0.6; pts.push(p); } }
    let on = false;
    function frame() {
      if (document.body.dataset.hero === 'warp') {
        on = true;
        const motion = parseFloat(cssVar('--motion')) || 1;
        const accent = cssVar('--accent') || '#3aa0ff';
        const accent2 = cssVar('--accent-2') || '#67e8ff';
        ctx.fillStyle = 'rgba(5,7,15,0.35)';
        ctx.fillRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2;
        for (const p of pts) {
          const x1 = cx + Math.cos(p.ang) * p.d;
          const y1 = cy + Math.sin(p.ang) * p.d;
          p.d += p.sp * (1 + p.d / Math.max(W, H)) * 2.2 * motion;
          const x2 = cx + Math.cos(p.ang) * p.d;
          const y2 = cy + Math.sin(p.ang) * p.d;
          ctx.strokeStyle = p.d > Math.max(W, H) * 0.35 ? accent2 : accent;
          ctx.globalAlpha = clamp(p.d / (Math.max(W, H) * 0.5), 0, 1) * 0.8;
          ctx.lineWidth = clamp(p.d / Math.max(W, H) * 2.4, 0.4, 2.4) * DPR;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          if (p.d > Math.hypot(W, H) * 0.6) reset(p);
        }
        ctx.globalAlpha = 1;
      } else if (on) {
        on = false; ctx.clearRect(0, 0, W, H);
      }
      requestAnimationFrame(frame);
    }
    resize(); build();
    addEventListener('resize', () => { resize(); build(); });
    if (!reduced) frame();
  }

  /* ---------- view helper: fires in/out as element enters/leaves ---------- */
  function onView(el, inFn, outFn, th) {
    if (reduced) { inFn && inFn(); return; }
    const io = new IntersectionObserver((es) => {
      es.forEach(e => { if (e.isIntersecting) inFn && inFn(); else outFn && outFn(); });
    }, { threshold: th || 0.2 });
    io.observe(el);
  }

  /* ============================================================
     3. REVEAL on scroll (reversible — replays up & down)
     ============================================================ */
  function reveals() {
    const els = $$('.reveal');
    if (reduced) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver((ents) => {
      ents.forEach(en => {
        const on = en.isIntersecting;
        en.target.classList.toggle('in', on);
        en.target.dispatchEvent(new CustomEvent(on ? 'revealed' : 'hidden'));
      });
    }, { threshold: 0.16 });
    els.forEach(e => io.observe(e));
  }

  /* ============================================================
     3b. HERO scroll-scrub (pinned scene — animation plays in place)
     ============================================================ */
  function heroScrub() {
    const track = $('#hero-track');
    if (!track) return;
    const stage = $('.hero-stage');
    const m0 = $('.hero-msg[data-msg="0"]');
    const m1 = $('.hero-msg[data-msg="1"]');
    const cue = $('.scroll-cue');
    const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    let ticking = false;
    function apply() {
      ticking = false;
      const total = Math.max(1, track.offsetHeight - innerHeight);
      const p = clamp(-track.getBoundingClientRect().top / total, 0, 1);
      const motion = parseFloat(cssVar('--motion')) || 1;
      if (stage) {
        stage.style.transform = `scale(${1 + p * 0.75 * motion}) translateZ(0)`;
        stage.style.opacity = String(1 - ss(0.80, 1, p) * 0.7);
      }
      if (m0) {
        m0.style.opacity = String(1 - ss(0.24, 0.46, p));
        m0.style.transform = `translateY(${-p * 80 * motion}px) scale(${1 - p * 0.12})`;
      }
      if (m1) {
        m1.style.opacity = String(clamp(ss(0.42, 0.60, p) - ss(0.82, 0.98, p), 0, 1));
        m1.style.transform = `translateY(${(0.55 - p) * 50}px)`;
      }
      if (cue) cue.style.opacity = String(1 - ss(0, 0.10, p));
    }
    function onScroll() { apply(); if (!ticking) { ticking = true; requestAnimationFrame(apply); } }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', apply);
    apply();
  }

  /* ============================================================
     4. NAV solidify + parallax
     ============================================================ */
  function navAndParallax() {
    const nav = $('.nav');
    const pars = $$('.par');
    function onScroll() {
      const y = window.scrollY;
      if (nav) nav.classList.toggle('solid', y > 40);
      const motion = parseFloat(cssVar('--motion')) || 1;
      pars.forEach(p => {
        const sp = parseFloat(p.dataset.par || '0.1');
        const r = p.getBoundingClientRect();
        const center = r.top + r.height / 2 - innerHeight / 2;
        p.style.transform = `translateY(${(-center * sp * motion).toFixed(1)}px)`;
      });
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ============================================================
     5. COUNTDOWN to UPSC CSE Prelims (est. 2028)
     ============================================================ */
  function countdown() {
    const el = $('#countdown');
    if (!el) return;
    const target = new Date('2028-05-28T09:30:00+05:30'); // estimated CSE Prelims 2028
    const cells = {
      d: $('[data-cd="d"]', el), h: $('[data-cd="h"]', el),
      m: $('[data-cd="m"]', el), s: $('[data-cd="s"]', el),
    };
    function tick() {
      const now = new Date();
      let diff = Math.max(0, target - now);
      const d = Math.floor(diff / 864e5); diff -= d * 864e5;
      const h = Math.floor(diff / 36e5); diff -= h * 36e5;
      const m = Math.floor(diff / 6e4); diff -= m * 6e4;
      const s = Math.floor(diff / 1e3);
      if (cells.d) cells.d.textContent = String(d);
      if (cells.h) cells.h.textContent = String(h).padStart(2, '0');
      if (cells.m) cells.m.textContent = String(m).padStart(2, '0');
      if (cells.s) cells.s.textContent = String(s).padStart(2, '0');
    }
    tick(); setInterval(tick, 1000);
  }

  /* ============================================================
     6. FOCUS TIMER (Pomodoro) + streak log
     ============================================================ */
  function focusTimer() {
    const card = $('#focus');
    if (!card) return;
    const fg = $('.ring-fg', card);
    const timeEl = $('.ring-time', card);
    const modeEl = $('.ring-mode', card);
    const startBtn = $('[data-act="start"]', card);
    const resetBtn = $('[data-act="reset"]', card);
    const skipBtn = $('[data-act="skip"]', card);
    const sessEl = $('#sess-count');
    const minEl = $('#focus-mins');
    const R = 116, C = 2 * Math.PI * R;
    fg.style.strokeDasharray = C;

    const MODES = { focus: 25 * 60, break: 5 * 60 };
    let mode = 'focus', remaining = MODES.focus, total = MODES.focus, running = false, iv = null;

    function render() {
      const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      timeEl.textContent = `${mm}:${ss}`;
      modeEl.textContent = mode === 'focus' ? 'Deep Focus' : 'Recover';
      fg.style.strokeDashoffset = C * (1 - (total - remaining) / total);
      startBtn.textContent = running ? 'Pause' : (remaining < total ? 'Resume' : 'Start');
    }
    function setMode(m) { mode = m; total = MODES[m]; remaining = MODES[m]; render(); }
    function logSession() {
      const today = new Date().toISOString().slice(0, 10);
      const log = store.get('focusLog', {});
      log[today] = (log[today] || 0) + 1;
      store.set('focusLog', log);
      const tot = store.get('sessTotal', 0) + 1; store.set('sessTotal', tot);
      const mins = store.get('focusMins', 0) + 25; store.set('focusMins', mins);
      refreshStats();
      buildStreak();
    }
    function refreshStats() {
      if (sessEl) sessEl.textContent = store.get('sessTotal', 0);
      if (minEl) minEl.textContent = (store.get('focusMins', 0)).toLocaleString();
    }
    function tickDown() {
      remaining--;
      if (remaining < 0) {
        clearInterval(iv); running = false;
        if (mode === 'focus') { logSession(); setMode('break'); }
        else setMode('focus');
        pulse();
      }
      render();
    }
    function toggle() {
      running = !running;
      if (running) { iv = setInterval(tickDown, 1000); }
      else clearInterval(iv);
      render();
    }
    function pulse() {
      card.animate([{ boxShadow: '0 0 0 0 rgba(58,160,255,0.5)' }, { boxShadow: '0 0 0 24px rgba(58,160,255,0)' }], { duration: 700 });
    }
    startBtn.addEventListener('click', toggle);
    resetBtn.addEventListener('click', () => { clearInterval(iv); running = false; setMode(mode); });
    skipBtn.addEventListener('click', () => { clearInterval(iv); running = false; if (mode==='focus'){logSession(); setMode('break');} else setMode('focus'); });
    refreshStats(); setMode('focus');
  }

  /* ============================================================
     7. STREAK grid (last 14 days)
     ============================================================ */
  function buildStreak() {
    const grid = $('#streak');
    if (!grid) return;
    const log = store.get('focusLog', {});
    grid.innerHTML = '';
    let curStreak = 0, broken = false;
    for (let i = 13; i >= 0; i--) {
      const day = new Date(); day.setDate(day.getDate() - i);
      const key = day.toISOString().slice(0, 10);
      const v = log[key] || 0;
      const cell = document.createElement('div');
      cell.className = 'streak-cell' + (v >= 6 ? ' l4' : v >= 4 ? ' l3' : v >= 2 ? ' l2' : v >= 1 ? ' l1' : '');
      cell.title = `${key}: ${v} session${v !== 1 ? 's' : ''}`;
      grid.appendChild(cell);
    }
    // current streak (consecutive days up to today with >=1)
    for (let i = 0; i < 60 && !broken; i++) {
      const day = new Date(); day.setDate(day.getDate() - i);
      const key = day.toISOString().slice(0, 10);
      if ((log[key] || 0) >= 1) curStreak++;
      else if (i === 0) { /* today not done yet, keep looking from yesterday */ }
      else broken = true;
    }
    const sEl = $('#streak-num'); if (sEl) sEl.textContent = curStreak;
  }

  /* ============================================================
     8. LECTURE PLANNER (PW IAS Prarambh) — persisted
     ============================================================ */
  const PLAN = [
    { id: 'pol-12', t: 'Polity — Lecture 12: Fundamental Rights (Art 19–22)', meta: ['PW · Prarambh', '92 min'], tag: 'backlog' },
    { id: 'pol-13', t: 'Polity — Lecture 13: Directive Principles', meta: ['PW · Prarambh', '78 min'], tag: 'backlog' },
    { id: 'hist-08', t: 'Modern History — Lecture 8: Revolt of 1857', meta: ['PW · Prarambh', '85 min'], tag: 'today' },
    { id: 'geo-05', t: 'Geography — Lecture 5: Climatology Basics', meta: ['PW · Prarambh', '70 min'], tag: 'today' },
    { id: 'eco-04', t: 'Economy — Lecture 4: National Income', meta: ['PW · Prarambh', '64 min'], tag: 'today' },
    { id: 'csat-02', t: 'CSAT — Lecture 2: Reading Comprehension Drill', meta: ['PW · Prarambh', '55 min'], tag: 'today' },
  ];
  function planner() {
    const list = $('#planner');
    if (!list) return;
    const doneMap = store.get('lectures', {});
    function pct() {
      const done = PLAN.filter(p => doneMap[p.id]).length;
      return Math.round(done / PLAN.length * 100);
    }
    function syncBar() {
      const bar = $('#plan-bar > i'); if (bar) bar.style.width = pct() + '%';
      const lab = $('#plan-pct'); if (lab) lab.textContent = pct() + '%';
      const cnt = $('#plan-count'); if (cnt) cnt.textContent = `${PLAN.filter(p=>doneMap[p.id]).length} / ${PLAN.length}`;
    }
    list.innerHTML = '';
    PLAN.forEach(p => {
      const row = document.createElement('div');
      row.className = 'plan-row' + (doneMap[p.id] ? ' done' : '');
      row.innerHTML = `
        <button class="check" aria-label="toggle complete">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
        </button>
        <div class="pl-body">
          <div class="pl-title">${p.t}</div>
          <div class="pl-meta">${p.meta.map(m => `<span>${m}</span>`).join('')}</div>
        </div>
        <span class="pl-tag ${p.tag === 'backlog' ? 'backlog' : ''}">${p.tag}</span>`;
      row.querySelector('.check').addEventListener('click', () => {
        doneMap[p.id] = !doneMap[p.id];
        store.set('lectures', doneMap);
        row.classList.toggle('done', !!doneMap[p.id]);
        syncBar();
      });
      list.appendChild(row);
    });
    syncBar();
  }

  /* ============================================================
     9. BAR CHARTS (mock scores + answer-writing) — replay on view
     ============================================================ */
  function barCharts() {
    $$('.bars').forEach(b => {
      const cols = $$('.col', b);
      onView(b,
        () => cols.forEach((c, i) => setTimeout(() => { c.style.height = c.dataset.v + '%'; }, i * 70)),
        () => cols.forEach(c => { c.style.height = '0%'; }),
        0.25);
    });
  }

  /* ============================================================
     10. RANK SIMULATOR
     ============================================================ */
  function rankSim() {
    const root = $('#rank');
    if (!root) return;
    const sliders = $$('input[type=range]', root);
    const out = $('#rank-num');
    const band = $('#rank-band');
    function compute() {
      const pre = +$('#s-pre').value;   // /200
      const mains = +$('#s-mains').value; // /250 avg per paper proxy 0-100
      const inter = +$('#s-inter').value; // /275
      // composite weighting (mains+interview dominate final)
      const composite = (mains / 100) * 0.55 + (inter / 275) * 0.25 + (pre / 200) * 0.20;
      // map composite [0..1] -> AIR (lower better). best ~1, worst ~9000
      const air = Math.round(lerp(9000, 1, Math.pow(composite, 1.7)));
      out.textContent = air.toLocaleString('en-IN');
      let b = 'Not qualifying';
      if (air <= 20) b = 'Top 20 · IAS likely';
      else if (air <= 180) b = 'IAS / IPS range';
      else if (air <= 700) b = 'IPS / IFS / IRS range';
      else if (air <= 1000) b = 'Final list contention';
      else b = 'Below cut-off — push harder';
      band.textContent = b;
      store.set('rankInputs', { pre, mains, inter });
    }
    const saved = store.get('rankInputs', null);
    if (saved) { $('#s-pre').value = saved.pre; $('#s-mains').value = saved.mains; $('#s-inter').value = saved.inter; }
    sliders.forEach(s => s.addEventListener('input', () => { updateLabel(s); compute(); }));
    function updateLabel(s) {
      const lab = root.querySelector(`label[for="${s.id}"] b`);
      if (lab) lab.textContent = s.value + (s.dataset.unit || '');
    }
    sliders.forEach(updateLabel);
    compute();
  }

  /* ============================================================
     11. HEATMAP (study calendar) — seeded persisted
     ============================================================ */
  function heatmap() {
    const root = $('#heat');
    if (!root) return;
    let seed = store.get('heatSeed', null);
    if (!seed) {
      seed = [];
      for (let i = 0; i < 26 * 7; i++) {
        const r = Math.random();
        seed.push(r < 0.32 ? 0 : r < 0.55 ? 1 : r < 0.78 ? 2 : r < 0.93 ? 3 : 4);
      }
      store.set('heatSeed', seed);
    }
    root.innerHTML = '';
    seed.forEach(l => {
      const c = document.createElement('div');
      c.className = 'c' + (l ? ' h' + l : '');
      root.appendChild(c);
    });
    const active = seed.filter(v => v > 0).length;
    const e = $('#heat-active'); if (e) e.textContent = active;
  }

  /* ============================================================
     12. DONUTS (subject balance) — replay on view
     ============================================================ */
  function donuts() {
    const line = 'rgba(120,168,255,0.13)';
    $$('.donut').forEach(d => {
      const v = +d.dataset.v;
      const ring = $('.ring', d);
      let raf;
      function spin() {
        const accent = cssVar('--accent');
        cancelAnimationFrame(raf);
        const t0 = performance.now();
        (function step(now) {
          const k = clamp((now - t0) / 900, 0, 1);
          const cur = v * (1 - Math.pow(1 - k, 3));
          ring.style.background = `conic-gradient(${accent} ${cur}%, ${line} 0)`;
          if (k < 1) raf = requestAnimationFrame(step);
        })(performance.now());
      }
      ring.style.background = `conic-gradient(${line} 0)`;
      onView(d, spin, () => { cancelAnimationFrame(raf); ring.style.background = `conic-gradient(${line} 0)`; }, 0.4);
    });
  }

  /* ============================================================
     13b. CONSTELLATION particle network (Constitution backdrop)
     ============================================================ */
  function constellation() {
    const cv = $('#const-particles');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H, DPR, pts = [], mxp = -999, myp = -999, visible = false;
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      W = cv.width = cv.offsetWidth * DPR;
      H = cv.height = cv.offsetHeight * DPR;
      build();
    }
    function build() {
      const n = Math.round((cv.offsetWidth * cv.offsetHeight) / 22000);
      pts = [];
      for (let i = 0; i < n; i++) {
        pts.push({ x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.25 * DPR, vy: (Math.random() - 0.5) * 0.25 * DPR,
          r: (0.8 + Math.random() * 1.4) * DPR });
      }
    }
    cv.parentElement.addEventListener('mousemove', (e) => {
      const r = cv.getBoundingClientRect();
      mxp = (e.clientX - r.left) * DPR; myp = (e.clientY - r.top) * DPR;
    });
    cv.parentElement.addEventListener('mouseleave', () => { mxp = -999; myp = -999; });
    new IntersectionObserver((es) => es.forEach(e => visible = e.isIntersecting), { threshold: 0.05 })
      .observe(cv);
    const LINK = 130;
    function frame() {
      requestAnimationFrame(frame);
      if (!visible || reduced) { ctx.clearRect(0, 0, W, H); return; }
      const motion = parseFloat(cssVar('--motion')) || 1;
      const accent = cssVar('--accent') || '#3aa0ff';
      ctx.clearRect(0, 0, W, H);
      const L = LINK * DPR;
      for (const p of pts) {
        p.x += p.vx * motion; p.y += p.vy * motion;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        // mouse attraction
        const dxm = mxp - p.x, dym = myp - p.y, dm = Math.hypot(dxm, dym);
        if (dm < 160 * DPR) { p.x += dxm / dm * 0.6 * motion; p.y += dym / dm * 0.6 * motion; }
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < L) {
            ctx.strokeStyle = accent;
            ctx.globalAlpha = (1 - d / L) * 0.22;
            ctx.lineWidth = DPR * 0.7;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7);
        ctx.fillStyle = accent; ctx.globalAlpha = 0.5; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    resize(); addEventListener('resize', resize);
    frame();
  }

  /* ============================================================
     13c. CONSTITUTION — articles slowly cross-fade
     ============================================================ */
  const ARTICLES = [
    { n: 'Preamble', t: 'We, the People of India', x: 'have solemnly resolved to constitute India into a Sovereign Socialist Secular Democratic Republic — securing to all its citizens justice, liberty, equality and fraternity.' },
    { n: 'Article 14', t: 'Equality before law', x: 'The State shall not deny to any person equality before the law or the equal protection of the laws within the territory of India.' },
    { n: 'Article 19(1)(a)', t: 'Freedom of speech and expression', x: 'All citizens shall have the right to freedom of speech and expression — the breath of a democratic Republic.' },
    { n: 'Article 21', t: 'Protection of life and personal liberty', x: 'No person shall be deprived of his life or personal liberty except according to procedure established by law.' },
    { n: 'Article 25', t: 'Freedom of conscience', x: 'All persons are equally entitled to freedom of conscience and the right freely to profess, practise and propagate religion.' },
    { n: 'Article 32', t: 'Right to constitutional remedies', x: 'The right to move the Supreme Court for the enforcement of fundamental rights — called by Ambedkar "the heart and soul of the Constitution".' },
    { n: 'Article 44', t: 'Uniform civil code', x: 'The State shall endeavour to secure for the citizens a uniform civil code throughout the territory of India.' },
    { n: 'Article 51A', t: 'Fundamental duties', x: 'It shall be the duty of every citizen to cherish the noble ideals of the freedom struggle and to develop the scientific temper, humanism and the spirit of inquiry.' },
    { n: 'Article 17', t: 'Abolition of untouchability', x: '"Untouchability" is abolished and its practice in any form is forbidden — a vow of dignity for every Indian.' },
    { n: 'Article 368', t: 'Power to amend', x: 'Parliament may, in exercise of its constituent power, amend the Constitution — yet never its basic structure.' },
  ];
  function constitution() {
    const numEl = $('#ca-num'), titleEl = $('#ca-title'), textEl = $('#ca-text');
    const ticker = $('#const-ticker');
    if (!numEl) return;
    let i = 0, paused = false;
    if (ticker) {
      ARTICLES.forEach((a, k) => {
        const s = document.createElement('button');
        s.className = 'tick'; s.textContent = a.n;
        s.addEventListener('click', () => { i = k; show(); restart(); });
        ticker.appendChild(s);
      });
    }
    const stage = $('#const-article');
    if (stage) {
      stage.addEventListener('mouseenter', () => paused = true);
      stage.addEventListener('mouseleave', () => paused = false);
    }
    function show() {
      const a = ARTICLES[i];
      const el = $('#const-article');
      el.classList.remove('show');
      // wait for fade-out then swap
      setTimeout(() => {
        numEl.textContent = a.n; titleEl.textContent = a.t; textEl.textContent = a.x;
        if (ticker) $$('.tick', ticker).forEach((b, k) => b.classList.toggle('active', k === i));
        el.classList.add('show');
      }, reduced ? 0 : 520);
    }
    let iv;
    function restart() { clearInterval(iv); iv = setInterval(() => { if (!paused) { i = (i + 1) % ARTICLES.length; show(); } }, 5200); }
    show(); restart();
  }


  function aiPlan() {
    const root = $('#ai');
    if (!root) return;
    const out = $('#ai-out', root);
    const btn = $('#ai-gen', root);
    const hoursEl = $('#ai-hours');
    function buildPlan() {
      const h = +(hoursEl ? hoursEl.value : 8);
      const backlog = store.get('lectures', {});
      const pending = PLAN.filter(p => !backlog[p.id]);
      const lines = [];
      lines.push(`» MISSION 2028 · ADAPTIVE WEEKLY PLAN`);
      lines.push(`» Capacity: ${h} hrs/day · Source: PW IAS Prarambh 2027`);
      lines.push(``);
      lines.push(`PRIORITY — clear backlog first (${pending.length} lecture${pending.length!==1?'s':''} pending)`);
      const blocks = [
        `MON  ▸ Polity backlog (2 lec) + 30 PYQs + revise yesterday`,
        `TUE  ▸ Modern History backlog + answer-writing (1 GS2 Q)`,
        `WED  ▸ Geography + map practice · CSAT 1 hr`,
        `THU  ▸ Economy backlog + current-affairs consolidation`,
        `FRI  ▸ Full subject revision (spaced) + 50-Q mini test`,
        `SAT  ▸ Sectional mock + analysis + error log`,
        `SUN  ▸ Light revision + essay/ethics reflection + reset`,
      ];
      lines.push(...blocks);
      lines.push(``);
      lines.push(`MICRO-RULES`);
      lines.push(`• 4 deep-focus blocks/day · log every session`);
      lines.push(`• Revise within 24h, 7d, 21d (spaced repetition)`);
      lines.push(`• 1 answer written daily — no zero days`);
      lines.push(``);
      lines.push(`> Momentum compounds. One block at a time. ▮`);
      return lines.join('\n');
    }
    function type(text) {
      out.textContent = '';
      if (reduced) { out.textContent = text; return; }
      let i = 0;
      const cur = document.createElement('span'); cur.className = 'cursor';
      (function step() {
        out.textContent = text.slice(0, i);
        out.appendChild(cur);
        i += Math.ceil(text.length / 180);
        if (i <= text.length) setTimeout(step, 12);
        else { out.textContent = text; }
      })();
    }
    btn.addEventListener('click', () => {
      const spin = btn.querySelector('.ai-spinner');
      const glyph = spin && spin.querySelector('.chakra');
      if (spin) { spin.classList.add('on'); if (glyph) glyph.classList.add('spin-med'); }
      type(buildPlan());
      setTimeout(() => { if (spin) { spin.classList.remove('on'); if (glyph) glyph.classList.remove('spin-med'); } }, reduced ? 200 : 2600);
    });
    // show a static prompt initially
    out.textContent = '> Press “Generate plan” to compile your adaptive weekly schedule from current backlog…';
  }

  /* ============================================================
     14. COUNT-UP numbers
     ============================================================ */
  function countUps() {
    $$('.count-up[data-to]').forEach(el => {
      const to = +el.dataset.to;
      let raf;
      function run() {
        cancelAnimationFrame(raf);
        const t0 = performance.now(), dur = 1200;
        (function step(now) {
          const k = clamp((now - t0) / dur, 0, 1);
          const e = 1 - Math.pow(1 - k, 3);
          const val = to * e;
          el.textContent = el.dataset.float ? val.toFixed(1) : Math.round(val).toLocaleString('en-IN');
          if (k < 1) raf = requestAnimationFrame(step);
        })(performance.now());
      }
      onView(el, run, () => { cancelAnimationFrame(raf); el.textContent = el.dataset.float ? '0.0' : '0'; }, 0.4);
    });
  }

  /* ============================================================
     14b. PREMIUM INTERACTIONS — spotlight, tilt, magnetic, ripple, aura
     ============================================================ */
  function interactions() {
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (reduced || !finePointer) return;

    // panel spotlight (follows cursor)
    $$('.panel').forEach(p => {
      p.addEventListener('mousemove', (e) => {
        const r = p.getBoundingClientRect();
        p.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        p.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });

    // 3D tilt
    $$('.tilt').forEach(el => {
      const MAX = 6;
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        const m = parseFloat(cssVar('--motion')) || 1;
        el.style.transform = `perspective(900px) rotateX(${(-py * MAX * m).toFixed(2)}deg) rotateY(${(px * MAX * m).toFixed(2)}deg)`;
      });
      el.addEventListener('mouseleave', () => { el.style.transform = ''; });
    });

    // magnetic buttons + ripple
    $$('.btn, .nav-cta').forEach(b => {
      b.addEventListener('mousemove', (e) => {
        const r = b.getBoundingClientRect();
        const mxp = (e.clientX - r.left - r.width / 2) / r.width;
        const myp = (e.clientY - r.top - r.height / 2) / r.height;
        b.style.transform = `translate(${(mxp * 8).toFixed(1)}px, ${(myp * 6).toFixed(1)}px)`;
      });
      b.addEventListener('mouseleave', () => { b.style.transform = ''; });
      b.addEventListener('click', (e) => {
        const r = b.getBoundingClientRect();
        const d = Math.max(r.width, r.height) * 2;
        const rip = document.createElement('span');
        rip.className = 'ripple';
        rip.style.width = rip.style.height = d + 'px';
        rip.style.left = (e.clientX - r.left) + 'px';
        rip.style.top = (e.clientY - r.top) + 'px';
        b.appendChild(rip);
        setTimeout(() => rip.remove(), 600);
      });
    });

    // global cursor aura with easing
    const aura = $('#cursor-aura');
    if (aura) {
      let tx = innerWidth / 2, ty = innerHeight / 2, ax = tx, ay = ty;
      addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; document.body.classList.add('has-aura'); }, { passive: true });
      addEventListener('mouseleave', () => document.body.classList.remove('has-aura'));
      (function loop() {
        ax += (tx - ax) * 0.12; ay += (ty - ay) * 0.12;
        aura.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px)`;
        requestAnimationFrame(loop);
      })();
    }
  }


  function boot() {
    chakras();
    emblemStamp();
    starfield();
    warp();
    reveals();
    heroScrub();
    navAndParallax();
    nationalScroll();
    countdown();
    focusTimer();
    buildStreak();
    planner();
    barCharts();
    rankSim();
    heatmap();
    donuts();
    constellation();
    constitution();
    aiPlan();
    countUps();
    interactions();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // re-apply visuals when tweaks change accent/hero
  window.addEventListener('tweakchange', () => { /* CSS vars handle most; canvases read live */ });

  // expose for tweaks panel
  window.MISSION = { store };
})();
