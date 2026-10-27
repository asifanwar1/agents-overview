'use strict';

/* =====================================================================
   Constants & helpers
   ===================================================================== */

const CATS = {
  read:  { code: 'SCAN',  name: 'Reading',    color: '#00e5ff', glyph: '◉' },
  write: { code: 'WRITE', name: 'Writing',    color: '#39ff9f', glyph: '✎' },
  exec:  { code: 'EXEC',  name: 'Commands',   color: '#ffb020', glyph: '❯' },
  web:   { code: 'NET',   name: 'Web',        color: '#a07bff', glyph: '◍' },
  agent: { code: 'SPAWN', name: 'Agents',     color: '#ff2bd6', glyph: '✦' },
  plan:  { code: 'PLAN',  name: 'Planning',   color: '#4d8bff', glyph: '◇' },
  mcp:   { code: 'LINK',  name: 'Connectors', color: '#2de2c4', glyph: '⌬' },
  other: { code: 'TOOL',  name: 'Other',      color: '#9fb3c8', glyph: '•' },
};
const COLORS = { main: '#00e5ff', sub: '#ff2bd6', done: '#39ff9f', error: '#ff4d6d', idle: '#4f7ca8', replay: '#ffb020' };
const STATUS_TEXT = { working: '● EXECUTING', thinking: '◌ THINKING', idle: '○ STANDBY', done: '✓ COMPLETE', error: '✕ FAILED' };
const MONO = '"JetBrains Mono", Consolas, monospace';
const DISPLAY = 'Orbitron, "JetBrains Mono", sans-serif';
const FEED_MAX = 160;
const STALE_MS = 120_000;

const $ = sel => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const catOf = c => CATS[c] || CATS.other;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '';
}
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function projectOf(cwd) {
  return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
}
function shortModel(model) {
  return model ? model.replace(/^claude-/, '').toUpperCase() : '';
}
function restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

/* =====================================================================
   Model: the state of one session, built from its event stream
   ===================================================================== */

class Model {
  constructor(key) {
    this.key = key;
    this.info = {};
    this.liveFlag = false;
    this.agents = new Map();
    this.tools = new Map();
    this.files = new Map();
    this.stats = { tools: 0, web: 0, out: 0, errors: 0, cats: {} };
    this.recent = [];
    this.feedTotal = 0;
    this.lastFeedKind = '';
    this.lastPrompt = '';
    this.firstTs = 0;
    this.lastTs = 0;
    this.silent = false;
    this.hooks = {};
    this.agent('main');
  }

  get live() { return this.liveFlag; }
  get project() { return projectOf(this.info.cwd); }

  emit(name, ...args) {
    const hook = this.hooks[name];
    if (hook) hook(...args);
  }

  fx(kind, a, rec) {
    if (!this.silent) this.emit('fx', kind, a, rec);
  }

  agent(id, parent) {
    let a = this.agents.get(id);
    if (!a) {
      a = {
        id, parent: id === 'main' ? null : (parent || 'main'),
        kind: id === 'main' ? 'Claude' : 'helper', desc: '',
        state: 'idle', done: false, ok: true, lastAct: 0, tools: 0,
        running: new Set(), nodes: [],
        x: null, y: null, tx: 0, ty: 0, r: 30, ang: 0,
        spin: Math.random() * 6, ring: 0, appear: this.silent ? 1 : 0, nextRipple: 0,
      };
      this.agents.set(id, a);
    } else if (parent && id !== 'main') {
      a.parent = parent;
    }
    return a;
  }

  touch(a, ts) {
    if (!a.done) a.state = 'active';
    if (!ts) return;
    if (ts > a.lastAct) a.lastAct = ts;
    if (!this.firstTs || ts < this.firstTs) this.firstTs = ts;
    if (ts > this.lastTs) this.lastTs = ts;
  }

  statusOf(a) {
    if (a.done) return a.ok ? 'done' : 'error';
    if (a.running.size) return 'working';
    if (a.state === 'active' && Date.now() - a.lastAct < STALE_MS) return 'thinking';
    return 'idle';
  }

  who(id) {
    if (id === 'main' || !id) return 'MAIN';
    const a = this.agents.get(id);
    return `${(a ? a.kind : 'agent').toUpperCase()}·${id.slice(0, 4)}`;
  }

  feedEntry(entry) {
    if (entry.kind === 'idle' && this.lastFeedKind === 'idle') return;
    this.lastFeedKind = entry.kind;
    entry.model = this;
    this.feedTotal++;
    this.recent.push(entry);
    if (this.recent.length > FEED_MAX * 2) this.recent.splice(0, this.recent.length - FEED_MAX);
    if (!this.silent) this.emit('feed', entry);
  }

  trackFile(file, op, ts) {
    // Windows paths arrive with mixed drive-letter case and slash styles.
    const key = file.replace(/\\/g, '/').toLowerCase();
    const f = this.files.get(key) || { file, reads: 0, writes: 0, last: 0, hot: 0 };
    if (op === 'W') f.writes++; else f.reads++;
    f.last = Math.max(f.last, ts || 0);
    if (!this.silent) f.hot = performance.now();
    this.files.set(key, f);
  }

  apply(ev) {
    switch (ev.t) {
      case 'meta':
        Object.assign(this.info, ev);
        return this.emit('meta');

      case 'prompt': {
        const a = this.agent(ev.agent);
        this.touch(a, ev.ts);
        if (a.id === 'main') {
          this.lastPrompt = ev.text;
          this.emit('directive', ev.text, !this.silent);
          this.fx('shock', a);
        } else if (!a.desc) {
          a.desc = ev.text;
        }
        return this.feedEntry({ kind: 'prompt', ev });
      }

      case 'think':
        return this.touch(this.agent(ev.agent), ev.ts);

      case 'text': {
        const a = this.agent(ev.agent);
        this.touch(a, ev.ts);
        if (a.id === 'main') this.emit('say', ev.text, !this.silent);
        return this.feedEntry({ kind: 'text', ev });
      }

      case 'tool': {
        const a = this.agent(ev.agent);
        this.touch(a, ev.ts);
        const rec = {
          ...ev, model: this, end: null, ok: null, x: null, y: null,
          appear: this.silent ? 1 : 0, doneAt: -99, landAt: 0, launchAt: -99, card: null,
        };
        this.tools.set(ev.id, rec);
        a.running.add(ev.id);
        a.nodes.push(rec);
        a.tools++;
        this.stats.tools++;
        this.stats.cats[ev.cat] = (this.stats.cats[ev.cat] || 0) + 1;
        if (ev.cat === 'web') this.stats.web++;
        if (ev.file) this.trackFile(ev.file, ev.op, ev.ts);
        this.fx('launch', a, rec);
        return this.feedEntry({ kind: 'tool', ev, rec });
      }

      case 'result': {
        const rec = this.tools.get(ev.id);
        if (!rec) return;
        const a = this.agent(rec.agent);
        this.touch(a, ev.ts);
        Object.assign(rec, { end: ev.ts || Date.now(), ok: ev.ok, ms: ev.ms, summary: ev.summary, output: ev.output });
        a.running.delete(ev.id);
        if (!ev.ok) this.stats.errors++;
        this.fx('land', a, rec);
        return this.emit('update', rec);
      }

      case 'agent': {
        const a = this.agent(ev.agent, ev.parent);
        a.kind = ev.kind || a.kind;
        a.desc = ev.desc || a.desc;
        this.touch(a, ev.ts);
        this.fx('spawn', a);
        return this.feedEntry({ kind: 'agent', ev });
      }

      case 'agent_done': {
        const a = this.agent(ev.agent);
        a.done = true;
        a.ok = ev.ok;
        a.running.clear();
        this.touch(a, ev.ts);
        this.fx('report', a);
        return this.feedEntry({ kind: 'done', ev });
      }

      case 'usage':
        this.stats.out += ev.out || 0;
        return;

      case 'idle': {
        const a = this.agent(ev.agent);
        if (!a.done) a.state = 'idle';
        if (ev.ts > this.lastTs) this.lastTs = ev.ts;
        if (a.id === 'main') this.feedEntry({ kind: 'idle', ev });
        return;
      }

      case 'error': {
        const a = this.agent(ev.agent || 'main');
        this.stats.errors++;
        this.fx('error', a);
        return this.feedEntry({ kind: 'error', ev });
      }

      case 'notice':
        return this.feedEntry({ kind: 'notice', ev });
    }
  }

  // A session that has gone quiet can't still be running tools; mark them as interrupted.
  settle() {
    if (this.live) return;
    for (const a of this.agents.values()) {
      for (const id of a.running) {
        const r = this.tools.get(id);
        if (r) Object.assign(r, { end: r.ts, stale: true });
      }
      a.running.clear();
      if (!a.done) a.state = 'idle';
    }
  }

  // What is happening right now, for the status bars.
  nowState() {
    let best = null;
    for (const a of this.agents.values()) {
      for (const id of a.running) {
        const r = this.tools.get(id);
        if (r && (!best || r.ts > best.ts)) best = r;
      }
    }
    if (best) {
      const c = catOf(best.cat);
      return {
        tag: `${c.glyph} ${c.code}`, label: best.label, sub: `${this.who(best.agent)} · ${best.detail || best.name}`,
        timer: fmtDur(Date.now() - best.ts), color: c.color, busy: true,
      };
    }
    if (this.statusOf(this.agents.get('main')) === 'thinking') {
      return { tag: '◌ THINK', label: 'Thinking about the next step…', sub: 'The model is reasoning or writing a response', color: COLORS.main, busy: true };
    }
    if (!this.live) {
      return {
        tag: '⟲ REPLAY', label: 'This session is not active right now',
        sub: this.lastTs ? `Last activity ${ago(this.lastTs)} · showing what happened` : '', color: COLORS.replay,
      };
    }
    return { tag: '○ STANDBY', label: 'Waiting for your next instruction', sub: 'Claude finished its turn', color: COLORS.done };
  }
}

/* =====================================================================
   Graph view: animated canvas for one Model
   ===================================================================== */

const VIEWS = new Set();
const sprites = new Map();
let T = 0;

function sprite(color) {
  let s = sprites.get(color);
  if (!s) {
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(0.22, rgba(color, 0.5));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites.set(color, s);
  }
  return s;
}

class GraphView {
  constructor(canvas, model, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.compact = Boolean(opts.compact);
    this.wrap = opts.wrap || canvas.parentElement;
    this.hasConic = typeof this.ctx.createConicGradient === 'function';
    this.particles = [];
    this.shocks = [];
    this.dust = [];
    this.W = 0;
    this.H = 0;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    VIEWS.add(this);
  }

  destroy() {
    this.ro.disconnect();
    VIEWS.delete(this);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width;
    this.H = r.height;
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dust = Array.from({ length: Math.round((this.W * this.H) / 9000) }, () => ({
      x: Math.random() * this.W, y: Math.random() * this.H, p: Math.random() * 6, s: Math.random() < 0.15 ? 1.6 : 1,
    }));
  }

  /* ---------- Primitives ---------- */

  glow(x, y, size, color, alpha) {
    if (alpha <= 0.01 || size <= 0) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite(color), x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  arcRing(x, y, r, color, alpha, segs, fill, rot, width) {
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = width;
    const step = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      const a0 = rot + i * step;
      ctx.beginPath();
      ctx.arc(x, y, r, a0, a0 + step * fill);
      ctx.stroke();
    }
  }

  hexPath(x, y, r, rot) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i * Math.PI) / 3;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  line(x1, y1, x2, y2) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  agentColor(a, st) {
    if (st === 'error') return COLORS.error;
    if (st === 'done') return COLORS.done;
    return a.id === 'main' ? COLORS.main : COLORS.sub;
  }

  /* ---------- Layout ---------- */

  visibleSubs() {
    const max = this.compact ? 6 : 8;
    const subs = [...this.model.agents.values()].filter(a => a.id !== 'main');
    if (subs.length <= max) return subs;
    const keep = new Set(subs.filter(a => !a.done).map(a => a.id));
    for (let i = subs.length - 1; i >= 0 && keep.size < max; i--) keep.add(subs[i].id);
    return subs.filter(a => keep.has(a.id));
  }

  layout(dt) {
    const { W, H, compact, model } = this;
    const main = model.agent('main');
    const cx = W / 2, cy = compact ? H / 2 - 4 : H / 2 - 28;
    const base = compact ? Math.min(W, H) : Math.max(260, Math.min(W, H));
    main.tx = cx;
    main.ty = cy;
    main.r = compact ? clamp(base * 0.075, 12, 30) : clamp(base * 0.062, 22, 50);

    const subs = this.visibleSubs();
    const shown = new Set(subs.map(a => a.id));
    const top = subs.filter(a => !a.parent || a.parent === 'main' || !shown.has(a.parent));
    const slots = Math.max(top.length, 5);
    const rx = compact ? clamp(W / 2 - 55, 60, W * 0.42) : clamp(W / 2 - 95, 100, W * 0.4);
    const ry = compact ? clamp(H / 2 - 45, 45, H * 0.38) : clamp(H / 2 - 115, 95, H * 0.34);
    const minDist = main.r * 4.6 + main.r * 0.62 * 2.6; // keep satellites clear of the core's orbit rings
    top.forEach((a, i) => {
      // First helper sits on top; with 5 slots none lands straight below the core's label.
      a.ang = -Math.PI / 2 + (i * Math.PI * 2) / slots;
      let dx = Math.cos(a.ang) * rx, dy = Math.sin(a.ang) * ry;
      const d = Math.hypot(dx, dy);
      if (d < minDist) { dx *= minDist / d; dy *= minDist / d; }
      a.tx = clamp(cx + dx, compact ? 30 : 60, W - (compact ? 30 : 60));
      a.ty = clamp(cy + dy, compact ? 26 : 60, H - (compact ? 40 : 165));
      a.r = main.r * 0.62;
    });
    subs.filter(a => !top.includes(a)).forEach((a, i) => {
      const p = model.agents.get(a.parent);
      a.ang = p.ang + (i % 2 ? 0.55 : -0.55);
      a.tx = p.tx + Math.cos(a.ang) * base * 0.17;
      a.ty = p.ty + Math.sin(a.ang) * base * 0.17;
      a.r = main.r * 0.5;
    });

    const all = [main, ...subs];
    const k = Math.min(1, dt * 3.5);
    for (const a of all) {
      if (a.x == null) {
        const p = a.parent && model.agents.get(a.parent);
        a.x = p && p.x != null ? p.x : a.tx;
        a.y = p && p.y != null ? p.y : a.ty;
      }
      a.x += (a.tx - a.x) * k;
      a.y += (a.ty - a.y) * k;
      a.appear = Math.min(1, a.appear + dt * 1.6);
    }
    return all;
  }

  layoutNodes(a, dt) {
    const isMain = a.id === 'main';
    const maxRing = isMain ? (this.compact ? 14 : 18) : (this.compact ? 7 : 9);
    const rIn = a.r * 2.3, rOut = a.r * (isMain ? 3.5 : 3.2);
    a.ring += dt * (isMain ? 0.05 : 0.09);

    const run = [], done = [];
    for (const n of a.nodes) (this.isRunning(n) ? run : done).push(n);
    if (done.length > maxRing) {
      const drop = new Set(done.splice(0, done.length - maxRing));
      a.nodes = a.nodes.filter(n => !drop.has(n));
    }
    run.forEach((n, j) => {
      const ang = -Math.PI / 2 + T * 0.3 + (j * Math.PI * 2) / run.length;
      n.tx = a.x + Math.cos(ang) * rIn;
      n.ty = a.y + Math.sin(ang) * rIn;
    });
    for (let k = 0; k < done.length; k++) {
      const n = done[done.length - 1 - k];
      const ang = -Math.PI / 2 + a.ring + (k * Math.PI * 2) / maxRing;
      n.tx = a.x + Math.cos(ang) * rOut;
      n.ty = a.y + Math.sin(ang) * rOut;
      n.fade = 1 - (k / maxRing) * 0.8;
    }
    const kk = Math.min(1, dt * 5);
    for (const n of a.nodes) {
      if (n.x == null) { n.x = a.x; n.y = a.y; }
      n.x += (n.tx - n.x) * kk;
      n.y += (n.ty - n.y) * kk;
      n.appear = Math.min(1, n.appear + dt * 2.5);
    }
    return { run, done, rIn, rOut };
  }

  isRunning(n) {
    return n.end == null || T < n.landAt;
  }

  /* ---------- Drawing ---------- */

  drawDust() {
    const ctx = this.ctx;
    ctx.fillStyle = '#9fd8ff';
    for (const d of this.dust) {
      ctx.globalAlpha = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(T * 0.8 + d.p));
      ctx.fillRect(d.x, d.y, d.s, d.s);
    }
    ctx.globalAlpha = 1;
  }

  drawGuides(a, L, st) {
    const ctx = this.ctx;
    const col = this.agentColor(a, st);
    ctx.setLineDash([2, 7]);
    ctx.strokeStyle = rgba(col, 0.13);
    ctx.lineWidth = 1;
    for (const r of [L.rIn, L.rOut]) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (a.id !== 'main') return;

    const R = L.rOut + a.r * 0.9;
    if (this.hasConic) {
      const g = ctx.createConicGradient(T * 0.7, a.x, a.y);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.78, rgba(col, 0));
      g.addColorStop(1, rgba(col, st === 'idle' ? 0.07 : 0.17));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(a.x, a.y, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = rgba(col, 0.22);
    const ticks = this.compact ? 60 : 90;
    for (let i = 0; i < ticks; i++) {
      const ang = (i * Math.PI * 2) / ticks - T * 0.02;
      const len = i % 15 === 0 ? 9 : i % 5 === 0 ? 5 : 2.5;
      const c = Math.cos(ang), s = Math.sin(ang);
      this.line(a.x + c * R, a.y + s * R, a.x + c * (R + len), a.y + s * (R + len));
    }
  }

  drawLink(a, st) {
    const ctx = this.ctx;
    const p = this.model.agents.get(a.parent) || this.model.agents.get('main');
    if (!p || p.x == null) return;
    const col = st === 'error' ? COLORS.error : st === 'done' ? COLORS.done : COLORS.sub;
    const active = st === 'working' || st === 'thinking';
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.strokeStyle = rgba(col, (active ? 0.38 : 0.13) * a.appear);
    if (!active) ctx.setLineDash([4, 7]);
    this.line(p.x, p.y, a.x, a.y);
    ctx.setLineDash([]);
    if (!active) return;
    for (let i = 0; i < 4; i++) {
      const t = (T * 0.45 + i / 4) % 1;
      this.glow(lerp(p.x, a.x, t), lerp(p.y, a.y, t), this.compact ? 12 : 18, col, 0.9);
    }
  }

  drawNode(a, n) {
    const ctx = this.ctx;
    const c = catOf(n.cat).color;
    const running = this.isRunning(n);
    const bad = n.ok === false && !running;
    const col = bad ? COLORS.error : c;
    const scale = this.compact ? 0.75 : 1;
    const r = (running ? 8.5 : 6) * scale * (0.35 + 0.65 * easeOut(n.appear));
    const fade = running ? 1 : n.fade ?? 1;

    if (running) {
      ctx.strokeStyle = rgba(c, 0.3);
      ctx.lineWidth = 1;
      this.line(a.x, a.y, n.x, n.y);
      for (let i = 0; i < 3; i++) {
        const t = (T * 0.9 + i / 3) % 1;
        this.glow(lerp(a.x, n.x, t), lerp(a.y, n.y, t), 12 * scale, c, 0.95);
      }
      this.glow(n.x, n.y, r * 6, c, 0.5 + 0.25 * Math.sin(T * 5 + (n.ts % 7)));
      this.arcRing(n.x, n.y, r * 1.9, c, 0.75, 3, 0.55, T * 2.6, 1.2);
      if (n.cat === 'web' && Math.random() < 0.12) {
        const ang = Math.random() * Math.PI * 2, d = (120 + Math.random() * 80) * scale;
        this.travel({ x: n.x + Math.cos(ang) * d, y: n.y + Math.sin(ang) * d }, n, c, 1, 50, 7 * scale, 0);
      }
    } else {
      const age = T - n.doneAt;
      if (age < 1) {
        ctx.strokeStyle = rgba(col, 0.35 * (1 - age));
        ctx.lineWidth = 1;
        this.line(a.x, a.y, n.x, n.y);
      }
      if (age < 0.7) {
        ctx.strokeStyle = rgba(bad ? COLORS.error : COLORS.done, 1 - age / 0.7);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + age * 45 * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.glow(n.x, n.y, r * 4.5, col, 0.25 * fade);
    }

    const alpha = running ? 1 : 0.3 + 0.6 * fade;
    this.hexPath(n.x, n.y, r, Math.PI / 6);
    ctx.fillStyle = rgba('#040a16', 0.92);
    ctx.fill();
    ctx.strokeStyle = rgba(col, alpha);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = rgba(col, alpha);
    ctx.font = `${Math.max(6, Math.round(r * 1.05))}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bad ? '✕' : catOf(n.cat).glyph, n.x, n.y + 0.5);
  }

  drawCore(a, st, L) {
    const ctx = this.ctx;
    const col = this.agentColor(a, st);
    const ap = easeOut(a.appear);
    const r = a.r * ap;
    const busy = st === 'working' ? 2.4 : st === 'thinking' ? 1.5 : 0.3;
    a.spin += 0.032 * busy;

    this.glow(a.x, a.y, r * 7.5, col, st === 'idle' || st === 'done' ? 0.28 : 0.5 + 0.12 * Math.sin(T * 3));
    if ((st === 'working' || st === 'thinking') && T > a.nextRipple) {
      this.shocks.push({ at: a, r0: a.r, r1: a.r * 3.4, t0: T, dur: 1.7, col, w: 1, a: 0.7 });
      a.nextRipple = T + (st === 'working' ? 0.85 : 1.25);
    }

    const g = ctx.createRadialGradient(a.x - r * 0.35, a.y - r * 0.35, r * 0.05, a.x, a.y, Math.max(1, r));
    g.addColorStop(0, rgba('#ffffff', 0.95));
    g.addColorStop(0.3, rgba(col, 0.85));
    g.addColorStop(0.75, rgba(col, 0.22));
    g.addColorStop(1, rgba(col, 0.04));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = rgba('#ffffff', 0.4);
    ctx.lineWidth = 1;
    this.hexPath(a.x, a.y, r * 0.55, a.spin * 0.5);
    ctx.stroke();
    this.arcRing(a.x, a.y, r * 1.3, col, 0.8, 3, 0.6, a.spin, 1.8);
    this.arcRing(a.x, a.y, r * 1.55, col, 0.45, 9, 0.35, -a.spin * 0.7, 1);
    this.arcRing(a.x, a.y, r * 1.82, col, 0.25, 1, 0.72, a.spin * 0.4, 2.2);

    const isMain = a.id === 'main';
    const small = this.compact;
    const ly = a.y + (isMain ? L.rOut + a.r * 0.9 + (small ? 12 : 18) : L.rOut + (small ? 6 : 12));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 9 : isMain ? 12 : 10}px ${DISPLAY}`;
    ctx.fillStyle = rgba('#eaf7ff', 0.95 * ap);
    ctx.fillText(isMain ? (small ? 'CLAUDE' : 'CLAUDE · CORE') : a.kind.toUpperCase(), a.x, ly);
    ctx.font = `500 ${small ? 9 : 10}px ${MONO}`;
    ctx.fillStyle = rgba(col, 0.95 * ap);
    ctx.fillText(STATUS_TEXT[st], a.x, ly + (small ? 11 : 15));
    if (!isMain && a.desc && !small) {
      ctx.fillStyle = rgba('#8fb0d0', 0.85 * ap);
      ctx.fillText(clip(a.desc, 34), a.x, ly + 29);
    }
  }

  drawLabel(a, n, alpha) {
    const ctx = this.ctx;
    const c = catOf(n.cat);
    const text = `${c.code} · ${clip(n.label, this.compact ? 30 : 46)}`;
    const dx = n.x - a.x, dy = n.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    ctx.font = `500 ${this.compact ? 10 : 11}px ${MONO}`;
    const w = ctx.measureText(text).width + 16, h = this.compact ? 18 : 21;
    let x = n.x + ux * 16 + (ux >= 0 ? 0 : -w);
    let y = n.y + uy * 14 - h / 2;
    x = clamp(x, 6, this.W - w - 6);
    y = clamp(y, 6, this.H - h - 6);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(3,10,22,0.88)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(c.color, 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = c.color;
    ctx.fillRect(x, y, 2.5, h);
    ctx.fillStyle = '#e6f4ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 9, y + h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  /* ---------- Particles ---------- */

  travel(from, to, color, count, spread, size, delay) {
    for (let i = 0; i < count; i++) {
      const dur = 0.5 + Math.random() * 0.35;
      this.particles.push({ k: 't', from, to, color, size, dur, t: -(delay / dur) - i * 0.07 - Math.random() * 0.08, bend: (Math.random() - 0.5) * spread });
    }
  }

  burst(at, color, count, speed) {
    const scale = this.compact ? 0.7 : 1;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2, v = speed * scale * (0.35 + Math.random());
      this.particles.push({ k: 's', x: at.x, y: at.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1, decay: 1.1 + Math.random(), color, size: (6 + Math.random() * 7) * scale });
    }
  }

  drawParticles(dt) {
    const ctx = this.ctx;
    const list = this.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.k === 't') {
        p.t += dt / p.dur;
        if (p.t < 0) continue;
        if (p.t >= 1 || p.from.x == null || p.to.x == null) { list.splice(i, 1); continue; }
        const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;
        const x0 = p.from.x, y0 = p.from.y, x1 = p.to.x, y1 = p.to.y;
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const mx = (x0 + x1) / 2 - ((y1 - y0) / len) * p.bend;
        const my = (y0 + y1) / 2 + ((x1 - x0) / len) * p.bend;
        const u = 1 - e;
        this.glow(u * u * x0 + 2 * u * e * mx + e * e * x1, u * u * y0 + 2 * u * e * my + e * e * y1, p.size * 2.2, p.color, 0.95);
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - 2.2 * dt;
        p.vy *= 1 - 2.2 * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0) { list.splice(i, 1); continue; }
        this.glow(p.x, p.y, p.size * 2 * p.life, p.color, p.life);
      }
    }
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      const p = (T - s.t0) / s.dur;
      if (p >= 1) { this.shocks.splice(i, 1); continue; }
      if (p < 0) continue;
      ctx.strokeStyle = rgba(s.col, (1 - p) * s.a);
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.arc(s.at.x, s.at.y, lerp(s.r0, s.r1, easeOut(p)), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* ---------- Effects triggered by the model ---------- */

  fx(kind, a, rec) {
    const parentOf = ag => this.model.agents.get(ag.parent) || this.model.agents.get('main');
    const n = this.compact ? 0.6 : 1;
    switch (kind) {
      case 'launch':
        rec.launchAt = T;
        this.burst(a, catOf(rec.cat).color, Math.round(8 * n), 90);
        break;
      case 'land':
        // Fast tools still get a visible moment in orbit before they settle.
        rec.landAt = Math.max(T, rec.launchAt + 0.9);
        rec.doneAt = rec.landAt;
        this.travel(rec, a, rec.ok === false ? COLORS.error : catOf(rec.cat).color, Math.round(7 * n), 30, 8 * n, rec.landAt - T);
        break;
      case 'spawn':
        this.travel(parentOf(a), a, COLORS.sub, Math.round(14 * n), 80, 11 * n, 0.2);
        this.shocks.push({ at: a, r0: 4, r1: 90 * n, t0: T + 0.6, dur: 1.2, col: COLORS.sub, w: 2, a: 0.9 });
        break;
      case 'report': {
        const col = a.ok ? COLORS.done : COLORS.error;
        this.burst(a, col, Math.round(20 * n), 140);
        this.travel(a, parentOf(a), col, Math.round(14 * n), 70, 10 * n, 0);
        break;
      }
      case 'shock':
        this.shocks.push({ at: a, r0: a.r, r1: a.r * 8, t0: T, dur: 1.5, col: '#e8f8ff', w: 2.5, a: 0.9 });
        this.burst(a, '#e8f8ff', Math.round(16 * n), 160);
        break;
      case 'error':
        this.burst(a, COLORS.error, Math.round(24 * n), 170);
        restart(this.wrap, 'glitch');
        break;
    }
  }

  /* ---------- Frame ---------- */

  frame(dt) {
    const { ctx, W, H, model } = this;
    ctx.clearRect(0, 0, W, H);
    if (W < 10 || H < 10) return;
    this.drawDust();
    const agents = this.layout(dt);
    const status = new Map(agents.map(a => [a, model.statusOf(a)]));
    const lay = new Map(agents.map(a => [a, this.layoutNodes(a, dt)]));

    for (const a of agents) this.drawGuides(a, lay.get(a), status.get(a));
    for (const a of agents) if (a.id !== 'main') this.drawLink(a, status.get(a));
    for (const a of agents) {
      const L = lay.get(a);
      for (const n of L.done) this.drawNode(a, n);
      for (const n of L.run) this.drawNode(a, n);
    }
    for (const a of agents) this.drawCore(a, status.get(a), lay.get(a));
    this.drawParticles(dt);

    const labels = [];
    for (const a of agents) for (const n of lay.get(a).run) labels.push([a, n, 1]);
    const main = agents[0];
    const mainDone = lay.get(main).done;
    const lastDone = mainDone[mainDone.length - 1];
    if (lastDone && T - lastDone.doneAt < 4) labels.push([main, lastDone, 1 - (T - lastDone.doneAt) / 4]);
    labels.sort((p, q) => q[1].ts - p[1].ts).slice(0, this.compact ? 1 : 6).forEach(([a, n, al]) => this.drawLabel(a, n, al));

    if (!model.tools.size && !main.lastAct) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${this.compact ? 10 : 12}px ${DISPLAY}`;
      ctx.fillStyle = rgba(COLORS.main, 0.5 + 0.3 * Math.sin(T * 2));
      ctx.fillText('AWAITING AGENT ACTIVITY', main.x, main.y - main.r * 5.2);
    }
  }
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.15, (now - lastFrame) / 1000);
  lastFrame = now;
  T += dt;
  for (const view of VIEWS) view.frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* =====================================================================
   Activity feed
   ===================================================================== */

class FeedView {
  constructor(el) {
    this.el = el;
    this.showProject = false;
  }

  clear() {
    this.el.replaceChildren();
  }

  add(entry) {
    this.el.prepend(this.render(entry, false));
    while (this.el.children.length > FEED_MAX) this.el.lastElementChild.remove();
  }

  rebuild(entries) {
    const frag = document.createDocumentFragment();
    const recent = entries.slice(-FEED_MAX);
    for (let i = recent.length - 1; i >= 0; i--) frag.appendChild(this.render(recent[i], true));
    this.el.replaceChildren(frag);
  }

  update(rec) {
    const el = rec.card;
    if (!el || !el.isConnected) return;
    this.fillTool(el, rec);
    restart(el, 'flash');
  }

  tick() {
    const now = Date.now();
    for (const el of this.el.querySelectorAll('.dur.live')) el.textContent = fmtDur(now - Number(el.dataset.start));
  }

  head(model, chip, who, ts, extra = '') {
    const proj = this.showProject ? `<span class="proj">${esc(model.project || '—')}</span>` : '';
    const sub = who !== 'MAIN' ? ' sub' : '';
    return `<div class="card-top"><span class="chip">${chip}</span>${proj}<span class="who${sub}">${esc(who)}</span>` +
      `<span class="grow"></span>${extra}<span class="time">${fmtTime(ts)}</span></div>`;
  }

  render(entry, quiet) {
    const el = document.createElement('article');
    el.className = 'card' + (quiet ? '' : ' enter');
    const { ev, model } = entry;
    const who = model.who(ev.agent);
    const isMain = !ev.agent || ev.agent === 'main';
    switch (entry.kind) {
      case 'tool':
        entry.rec.card = el;
        this.fillTool(el, entry.rec);
        el.addEventListener('click', e => {
          if (!e.target.closest('pre')) el.classList.toggle('open');
        });
        break;
      case 'prompt':
        el.classList.add('k-prompt');
        el.style.setProperty('--c', isMain ? '#e8f8ff' : COLORS.sub);
        el.innerHTML = this.head(model, isMain ? '▲ YOU' : '▼ BRIEFING', who, ev.ts) + `<div class="card-body">${esc(ev.text.slice(0, 600))}</div>`;
        break;
      case 'text':
        el.style.setProperty('--c', isMain ? COLORS.main : COLORS.sub);
        el.innerHTML = this.head(model, '◈ SAYS', who, ev.ts) + `<div class="card-body">${esc(ev.text.slice(0, 700))}</div>`;
        break;
      case 'agent':
        el.style.setProperty('--c', COLORS.sub);
        el.innerHTML = this.head(model, '✦ SPAWN', model.who(model.agents.get(ev.agent)?.parent || 'main'), ev.ts) +
          `<div class="card-title">Deployed a ${esc(ev.kind)} agent</div><div class="card-detail">${esc(ev.desc)}</div>`;
        break;
      case 'done':
        el.style.setProperty('--c', ev.ok ? COLORS.done : COLORS.error);
        el.innerHTML = this.head(model, ev.ok ? '✓ REPORT' : '✕ FAILED', who, ev.ts) +
          `<div class="card-title">${ev.ok ? 'Helper agent finished and reported back' : 'Helper agent stopped'}</div>` +
          `<div class="card-detail">${ev.tools} tool calls · ${fmtNum(ev.tokens)} tokens · ${fmtDur(ev.ms)}</div>`;
        break;
      case 'idle': {
        el.classList.add('k-idle');
        const proj = this.showProject ? `${esc(model.project || '—')} · ` : '';
        el.innerHTML = `◆ ${proj}TURN COMPLETE — Claude is waiting for you <span style="float:right;color:var(--muted)">${fmtTime(ev.ts)}</span>`;
        break;
      }
      case 'error':
        el.style.setProperty('--c', COLORS.error);
        el.innerHTML = this.head(model, '⚠ ALERT', who, ev.ts) + `<div class="card-body">${esc(ev.text)}</div>`;
        break;
      case 'notice':
        el.classList.add('k-notice');
        el.innerHTML = this.head(model, '◇ SYSTEM', who, ev.ts) + `<div class="card-body">${esc(ev.text)}</div>`;
        break;
    }
    return el;
  }

  fillTool(el, rec) {
    const c = catOf(rec.cat);
    const running = rec.end == null;
    el.classList.add('k-tool');
    el.classList.toggle('running', running);
    el.classList.toggle('failed', rec.ok === false);
    el.style.setProperty('--c', c.color);
    const dur = running
      ? `<span class="dur live" data-start="${rec.ts}">${fmtDur(Date.now() - rec.ts)}</span>`
      : `<span class="dur">${rec.stale ? '—' : fmtDur(rec.ms ?? 0)}</span>`;
    const status = running ? '<span class="res run">◌ in progress…</span>'
      : rec.stale ? '<span class="res">no result recorded</span>'
      : rec.ok ? `<span class="res ok">✓ ${esc(rec.summary || 'Done')}</span>`
      : `<span class="res bad">✕ ${esc(rec.summary || 'Failed')}</span>`;
    const raw = rec.input === undefined
      ? '<div class="raw-h">Open this session in FOCUS view to see the raw input and output</div>'
      : `<div class="raw-h">TOOL · ${esc(rec.name)} · INPUT</div><pre>${esc(JSON.stringify(rec.input, null, 2))}</pre>` +
        (rec.output ? `<div class="raw-h">OUTPUT</div><pre>${esc(rec.output)}</pre>` : '');
    el.innerHTML =
      this.head(rec.model, `${c.glyph} ${c.code}`, rec.model.who(rec.agent), rec.ts, dur) +
      `<div class="card-title">${esc(rec.label)}</div>` +
      (rec.detail ? `<div class="card-detail">${esc(clip(rec.detail, 200))}</div>` : '') +
      `<div class="card-status">${status}</div><div class="card-raw">${raw}</div>`;
  }
}

/* =====================================================================
   App state
   ===================================================================== */

const App = {
  mode: store.get('ao.mode', 'single') === 'fleet' ? 'fleet' : 'single',
  tileCount: [4, 6, 9].includes(Number(store.get('ao.tiles', '6'))) ? Number(store.get('ao.tiles', '6')) : 6,
  follow: true,
  sessions: [],
  sessionSig: '',
  es: null,
  current: null,        // FOCUS view: the open session key
  single: null,         // FOCUS view: { model, graph }
  tiles: new Map(),     // FLEET view: key -> { key, el, model, graph }
  fleetKeys: [],
};
const feedView = new FeedView($('#feed'));

function sessionFor(key) {
  return App.sessions.find(s => s.key === key);
}

function closeStream() {
  if (App.es) App.es.close();
  App.es = null;
}

function loadHistory(model, data) {
  const s = sessionFor(model.key);
  model.liveFlag = s ? s.live : Boolean(data.session && data.session.live);
  model.silent = true;
  for (const ev of data.events) model.apply(ev);
  model.settle();
  model.silent = false;
}

function setLink(mode, text) {
  $('#link').className = 'link ' + mode;
  $('#linkText').textContent = text;
}

function updateLink() {
  if (App.mode === 'fleet') {
    const live = App.sessions.filter(s => s.live).length;
    setLink(live ? 'live' : 'replay', live ? `${live} LIVE` : 'NONE LIVE');
  } else if (App.current) {
    const live = App.single && App.single.model.live;
    setLink(live ? 'live' : 'replay', live ? 'LIVE' : 'REPLAY');
  }
}

/* =====================================================================
   FOCUS view
   ===================================================================== */

function newSingle(key) {
  if (App.single) App.single.graph.destroy();
  const model = new Model(key);
  const graph = new GraphView($('#graph'), model, { wrap: $('#graphWrap') });
  model.hooks = {
    meta: renderInfo,
    directive: setDirective,
    say,
    feed: entry => feedView.add(entry),
    update: rec => feedView.update(rec),
    fx: (kind, a, rec) => graph.fx(kind, a, rec),
  };
  App.single = { model, graph };
  feedView.clear();
  $('#say').classList.remove('show');
  $('#directiveText').textContent = key ? 'Loading session…' : 'Waiting for a session…';
  return model;
}

function openSession(key) {
  closeStream();
  App.current = key;
  $('#sessionSelect').value = key;
  newSingle(key);
  renderInfo();
  setLink('', 'CONNECTING');
  const es = App.es = new EventSource('/api/stream?key=' + encodeURIComponent(key));
  es.onmessage = msg => {
    const data = JSON.parse(msg.data);
    if (data.kind === 'history') {
      const model = newSingle(key);
      loadHistory(model, data);
      feedView.rebuild(model.recent);
      if ($('#directiveText').textContent === 'Loading session…') $('#directiveText').textContent = 'No prompt yet';
      updateLink();
    } else {
      for (const ev of data.events) App.single.model.apply(ev);
    }
    renderInfo();
    renderPanels();
  };
  es.onerror = () => setLink('down', 'RECONNECTING');
}

function renderInfo() {
  if (App.mode !== 'single' || !App.single) return;
  const m = App.single.model;
  const s = sessionFor(App.current);
  const cwd = m.info.cwd || (s && s.cwd) || '';
  $('#model').textContent = shortModel(m.info.model) || '—';
  $('#projectName').textContent = cwd ? '⌂ ' + projectOf(cwd) : '—';
  $('#sessionTitle').textContent = m.info.title || (s && s.title) || '';
  document.title = m.info.title ? `Agent Overview · ${m.info.title}` : 'Agent Overview';
  const opt = [...$('#sessionSelect').options].find(o => o.value === App.current);
  if (opt && !s && m.info.title) opt.textContent = '○ ' + clip(m.info.title, 80);
}

function setDirective(text, animate) {
  $('#directiveText').textContent = clip(text, 400);
  if (animate) restart($('#directive'), 'flash');
}

let sayTimer = null;
function say(text, animate) {
  const el = $('#sayText');
  const full = clip(text, 340);
  $('#say').classList.add('show');
  clearInterval(sayTimer);
  if (!animate) {
    el.textContent = full;
    return;
  }
  let i = 0;
  sayTimer = setInterval(() => {
    i += 3;
    el.textContent = full.slice(0, i);
    if (i >= full.length) clearInterval(sayTimer);
  }, 16);
}

function renderRoster(m) {
  let html = '';
  for (const a of m.agents.values()) {
    const st = m.statusOf(a);
    const color = st === 'error' ? COLORS.error : st === 'done' ? COLORS.done : a.id === 'main' ? COLORS.main : COLORS.sub;
    const name = a.id === 'main' ? 'CLAUDE · MAIN' : `${a.kind.toUpperCase()} · ${a.id.slice(0, 4)}`;
    let doing = a.desc || (a.id === 'main' ? 'Primary agent' : '');
    if (a.running.size) {
      const r = m.tools.get([...a.running].pop());
      if (r) doing = r.label;
    }
    html += `<li class="ag st-${st}" style="--c:${color}"><span class="ag-dot"></span>` +
      `<div><div class="ag-name">${esc(name)}</div><div class="ag-desc" title="${esc(doing)}">${esc(doing)}</div></div>` +
      `<div class="ag-meta"><b>${a.tools}</b> tools<br><span>${STATUS_TEXT[st].slice(2)}</span></div></li>`;
  }
  const roster = $('#roster');
  if (roster.dataset.sig !== html) {
    roster.innerHTML = html;
    roster.dataset.sig = html;
  }
  $('#agentCount').textContent = m.agents.size;
}

function renderFiles(m) {
  const now = performance.now();
  const files = [...m.files.values()].sort((a, b) => b.last - a.last).slice(0, 60);
  let html = '';
  for (const f of files) {
    const parts = f.file.split(/[\\/]/).filter(Boolean);
    const name = parts.pop() || f.file;
    const dir = parts.slice(-2).join('/');
    const hot = now - f.hot < 2500 ? ' hot' : '';
    const op = f.writes ? '<span class="op w">W</span>' : '<span class="op r">R</span>';
    html += `<li class="file${hot}" title="${esc(f.file)}">${op}<span class="fname">${esc(name)}<small>${esc(dir)}</small></span></li>`;
  }
  if (!html) html = '<li class="empty">No files read or written yet</li>';
  const el = $('#files');
  if (el.dataset.sig !== html) {
    el.innerHTML = html;
    el.dataset.sig = html;
  }
  $('#fileCount').textContent = m.files.size;
}

function renderNow(m) {
  const state = App.current ? m.nowState() : {
    tag: 'OFFLINE', label: 'No Claude Code sessions found',
    sub: 'Start Claude Code in any project and it will appear here', color: COLORS.idle,
  };
  const now = $('#now');
  now.style.setProperty('--now', state.color);
  now.classList.toggle('busy', Boolean(state.busy));
  $('#nowTag').textContent = state.tag;
  $('#nowLabel').textContent = state.label;
  $('#nowSub').textContent = state.sub || '';
  $('#nowTimer').textContent = state.timer || '';
}

/* =====================================================================
   FLEET view
   ===================================================================== */

function pickFleetKeys() {
  const live = App.sessions.filter(s => s.live);
  const rest = App.sessions.filter(s => !s.live);
  return [...live, ...rest].slice(0, App.tileCount).map(s => s.key);
}

function syncFleet(force) {
  const keys = pickFleetKeys();
  const same = keys.length === App.fleetKeys.length && keys.every(k => App.fleetKeys.includes(k));
  if (force || !same) openFleet(keys);
}

function teardownFleet() {
  for (const tile of App.tiles.values()) tile.graph.destroy();
  App.tiles.clear();
  App.fleetKeys = [];
  $('#fleetGrid').replaceChildren();
}

function layoutFleetGrid(n) {
  const cols = n <= 2 ? Math.max(1, n) : n === 3 ? 3 : n === 4 ? 2 : 3;
  const grid = $('#fleetGrid');
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(n / cols))}, minmax(0, 1fr))`;
}

function openFleet(keys) {
  closeStream();
  teardownFleet();
  feedView.clear();
  App.fleetKeys = keys;
  layoutFleetGrid(keys.length);
  if (!keys.length) {
    $('#fleetGrid').innerHTML = '<div class="fleet-empty">NO CLAUDE CODE SESSIONS FOUND</div>';
    return;
  }
  for (const key of keys) createTile(key);
  const es = App.es = new EventSource(`/api/stream?lite=1&keys=${keys.map(encodeURIComponent).join(',')}`);
  es.onmessage = msg => {
    const data = JSON.parse(msg.data);
    const tile = App.tiles.get(data.key);
    if (!tile) return;
    if (data.kind === 'history') {
      resetTileModel(tile);
      loadHistory(tile.model, data);
      feedView.rebuild(mergedRecent());
    } else {
      for (const ev of data.events) tile.model.apply(ev);
    }
    renderTile(tile);
  };
  es.onerror = () => setLink('down', 'RECONNECTING');
}

function createTile(key) {
  const el = document.createElement('article');
  el.className = 'tile panel';
  el.title = 'Click to open this session in FOCUS view';
  el.innerHTML =
    '<header class="tile-head"><span class="tile-live"></span><span class="tile-proj"></span>' +
    '<span class="tile-model"></span><span class="tile-open">⤢</span></header>' +
    '<div class="tile-title"></div><div class="tile-prompt"></div>' +
    '<div class="tile-canvas"><canvas></canvas></div>' +
    '<div class="tile-now"><span class="tile-tag"></span><span class="tile-label"></span><span class="tile-timer"></span></div>' +
    '<div class="tile-stats"></div>';
  el.addEventListener('click', () => focusSession(key));
  $('#fleetGrid').appendChild(el);
  const tile = { key, el, model: null, graph: null };
  resetTileModel(tile);
  App.tiles.set(key, tile);
  renderTile(tile);
}

function resetTileModel(tile) {
  if (tile.graph) tile.graph.destroy();
  const model = new Model(tile.key);
  const graph = new GraphView(tile.el.querySelector('canvas'), model, { compact: true, wrap: tile.el.querySelector('.tile-canvas') });
  model.hooks = {
    feed: entry => feedView.add(entry),
    update: rec => feedView.update(rec),
    fx: (kind, a, rec) => graph.fx(kind, a, rec),
    meta: () => renderTile(tile),
  };
  tile.model = model;
  tile.graph = graph;
}

function mergedRecent() {
  return [...App.tiles.values()].flatMap(t => t.model.recent).sort((a, b) => (a.ev.ts || 0) - (b.ev.ts || 0));
}

function renderTile(tile) {
  const { el, model: m } = tile;
  const s = sessionFor(tile.key);
  if (s) m.liveFlag = s.live;
  const state = m.nowState();
  const q = sel => el.querySelector(sel);
  el.style.setProperty('--c', state.color);
  el.classList.toggle('busy', Boolean(state.busy));
  el.classList.toggle('is-live', m.live);
  q('.tile-live').textContent = m.live ? '● LIVE' : `○ ${m.lastTs ? ago(m.lastTs).toUpperCase() : 'IDLE'}`;
  q('.tile-proj').textContent = m.project || (s && s.project) || '—';
  q('.tile-model').textContent = shortModel(m.info.model);
  q('.tile-title').textContent = m.info.title || (s && s.title) || 'Untitled session';
  q('.tile-prompt').textContent = m.lastPrompt ? `▲ ${clip(m.lastPrompt, 140)}` : '';
  q('.tile-tag').textContent = state.tag;
  q('.tile-label').textContent = state.label;
  q('.tile-timer').textContent = state.timer || '';
  const st = m.stats;
  const html = `<span><b>${fmtNum(st.tools)}</b> tools</span><span><b>${m.agents.size}</b> agents</span>` +
    `<span><b>${m.files.size}</b> files</span><span><b>${fmtNum(st.out)}</b> tokens</span>` +
    (st.errors ? `<span class="err"><b>${st.errors}</b> errors</span>` : '');
  const stats = q('.tile-stats');
  if (stats.dataset.sig !== html) {
    stats.innerHTML = html;
    stats.dataset.sig = html;
  }
}

function renderFleetHeader() {
  const n = App.tiles.size;
  const live = [...App.tiles.values()].filter(t => t.model.live).length;
  $('#directiveText').textContent = n
    ? `Watching ${n} session${n === 1 ? '' : 's'} · ${live} live right now — click any tile to open it in FOCUS view`
    : 'No sessions to show yet';
  $('#projectName').textContent = '';
  $('#sessionTitle').textContent = '';
  $('#model').textContent = 'FLEET';
  $('#fleetNote').textContent = `${App.sessions.filter(s => s.live).length} live · ${App.sessions.length} recent`;
  document.title = 'Agent Overview · Fleet';
}

function focusSession(key) {
  App.follow = false;
  $('#follow').checked = false;
  App.current = key;
  setMode('single');
}

/* =====================================================================
   Shared panels
   ===================================================================== */

function setStat(id, value) {
  const el = document.getElementById(id);
  const text = String(value);
  if (el.textContent === text) return;
  el.textContent = text;
  restart(el, 'bump');
}

function renderStats(models) {
  const agg = { tools: 0, web: 0, out: 0, errors: 0, files: 0, agents: 0, cats: {} };
  for (const m of models) {
    agg.tools += m.stats.tools;
    agg.web += m.stats.web;
    agg.out += m.stats.out;
    agg.errors += m.stats.errors;
    agg.files += m.files.size;
    agg.agents += m.agents.size;
    for (const [k, n] of Object.entries(m.stats.cats)) agg.cats[k] = (agg.cats[k] || 0) + n;
  }
  setStat('stTools', fmtNum(agg.tools));
  setStat('stFiles', agg.files);
  setStat('stWeb', agg.web);
  setStat('stAgents', agg.agents);
  setStat('stTokens', fmtNum(agg.out));
  setStat('stErrors', agg.errors);

  if (App.mode === 'fleet') {
    $('#stTimeK').textContent = 'LIVE SESSIONS';
    setStat('stTime', models.filter(m => m.live).length);
  } else {
    $('#stTimeK').textContent = 'SESSION TIME';
    const m = models[0];
    const anyRunning = m && [...m.agents.values()].some(a => a.running.size);
    const end = m && m.live && anyRunning ? Date.now() : m ? m.lastTs : 0;
    $('#stTime').textContent = m && m.firstTs ? fmtDur(Math.max(0, end - m.firstTs)) : '0s';
  }

  let bar = '', legend = '';
  for (const [key, c] of Object.entries(CATS)) {
    const n = agg.cats[key] || 0;
    if (!n) continue;
    bar += `<i style="flex-grow:${n};background:${c.color};color:${c.color}" title="${c.name}: ${n}"></i>`;
    legend += `<span><i style="background:${c.color}"></i>${c.name} <b>${n}</b></span>`;
  }
  const spec = $('#spectrum');
  if (spec.dataset.sig !== bar) {
    spec.innerHTML = bar;
    spec.dataset.sig = bar;
    $('#specLegend').innerHTML = legend || '<span>No tool calls yet</span>';
  }
}

function renderLegend() {
  $('#legend').innerHTML = Object.values(CATS)
    .map(c => `<span>${c.name} <i style="background:${c.color};box-shadow:0 0 6px ${c.color}"></i></span>`).join('');
}

function renderPanels() {
  if (App.mode === 'fleet') {
    const models = [...App.tiles.values()].map(t => t.model);
    for (const tile of App.tiles.values()) renderTile(tile);
    renderStats(models);
    renderFleetHeader();
    $('#feedCount').textContent = models.reduce((n, m) => n + m.feedTotal, 0);
  } else if (App.single) {
    const m = App.single.model;
    renderRoster(m);
    renderFiles(m);
    renderStats([m]);
    renderNow(m);
    $('#feedCount').textContent = m.feedTotal;
  }
  feedView.tick();
}

/* =====================================================================
   Sessions list & mode switching
   ===================================================================== */

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    App.sessions = await res.json();
  } catch {
    setLink('down', 'SERVER OFFLINE');
    return;
  }
  renderSessionSelect();
  if (App.single) {
    const s = sessionFor(App.single.model.key);
    if (s) App.single.model.liveFlag = s.live;
  }

  if (App.mode === 'fleet') {
    syncFleet(false);
  } else if (App.follow && App.sessions.length) {
    const target = App.sessions.find(s => s.live) || App.sessions[0];
    const cur = sessionFor(App.current);
    const curActive = cur && cur.live && Date.now() - cur.mtime < 8000;
    if (!App.current || (target.key !== App.current && target.live && !curActive)) openSession(target.key);
  }
  updateLink();
}

function renderSessionSelect() {
  const title = App.single ? App.single.model.info.title : '';
  const sig = App.sessions.map(s => `${s.key}|${s.title}|${s.live}`).join('\n') + `|${App.current}|${title}`;
  if (sig === App.sessionSig) return;
  App.sessionSig = sig;
  const sel = $('#sessionSelect');
  let html = App.sessions.map(s => {
    const when = s.live ? 'LIVE' : ago(s.mtime);
    return `<option value="${esc(s.key)}">${s.live ? '● ' : '○ '}${esc(s.project)} — ${esc(clip(s.title, 70))} · ${when}</option>`;
  }).join('');
  // A session opened by link may be older than the recent list.
  if (App.current && !sessionFor(App.current)) {
    html = `<option value="${esc(App.current)}">○ ${esc(clip(title || App.current, 80))}</option>` + html;
  }
  sel.innerHTML = html || '<option value="">No sessions found</option>';
  if (App.current) sel.value = App.current;
}

function applyModeChrome() {
  const fleet = App.mode === 'fleet';
  document.body.classList.toggle('fleet-mode', fleet);
  for (const b of document.querySelectorAll('.modes button')) b.classList.toggle('active', b.dataset.mode === App.mode);
  for (const b of document.querySelectorAll('.count-btn')) b.classList.toggle('active', Number(b.dataset.count) === App.tileCount);
  $('#singleCtl').hidden = fleet;
  $('#fleetCtl').hidden = !fleet;
  $('#directiveTag').textContent = fleet ? 'FLEET VIEW' : 'YOUR DIRECTIVE';
  feedView.showProject = fleet;
}

function setMode(mode) {
  App.mode = mode;
  store.set('ao.mode', mode);
  applyModeChrome();
  closeStream();
  if (mode === 'fleet') {
    if (App.single) App.single.graph.destroy();
    App.single = null;
    syncFleet(true);
  } else {
    teardownFleet();
    const key = App.current || (App.sessions.find(s => s.live) || App.sessions[0] || {}).key;
    if (key) openSession(key);
    else newSingle(null);
  }
  updateLink();
  renderPanels();
}

/* =====================================================================
   Boot
   ===================================================================== */

$('#sessionSelect').addEventListener('change', e => {
  App.follow = false;
  $('#follow').checked = false;
  if (e.target.value) openSession(e.target.value);
});
$('#follow').addEventListener('change', e => {
  App.follow = e.target.checked;
  if (App.follow) refreshSessions();
});
for (const b of document.querySelectorAll('.modes button')) {
  b.addEventListener('click', () => {
    if (b.dataset.mode !== App.mode) setMode(b.dataset.mode);
  });
}
for (const b of document.querySelectorAll('.count-btn')) {
  b.addEventListener('click', () => {
    App.tileCount = Number(b.dataset.count);
    store.set('ao.tiles', String(App.tileCount));
    applyModeChrome();
    syncFleet(false);
    renderPanels();
  });
}

const params = new URLSearchParams(location.search);
const linked = params.get('session');
if (params.get('view') === 'fleet') App.mode = 'fleet';
if (linked) {
  App.mode = 'single';
  App.follow = false;
  $('#follow').checked = false;
}
renderLegend();
applyModeChrome();
if (App.mode === 'single') {
  if (linked) openSession(linked);
  else newSingle(null);
}
renderPanels();
refreshSessions();
setInterval(refreshSessions, 4000);
setInterval(renderPanels, 500);
const tickClock = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); };
tickClock();
setInterval(tickClock, 1000);
