/**
 * Matrix-style Profile Stream - main.js
 *
 * README
 * - Single-file vanilla JS driving a canvas-based Matrix rain plus DOM-rendered
 *   animated profile capsules. No dependencies.
 * - Key configs are exposed on the `CONFIG` object and bound to UI controls.
 * - Generators are light-weight arrays with weighted picks; tweak them in
 *   `ProfileFactory` below.
 *
 * Controls
 * - Density: scales number of columns and per-column glyph density.
 * - Speed: scales baseline drip speed across columns.
 * - Capsule Rate: scales spawn frequency for profile capsules.
 * - Glow: intensifies neon blur. Also affected by CSS variable `--glow`.
 * - Show Code/Hex: toggles code-noise in rain and availability of hex capsules.
 * - Screenshot: combines canvas + visible capsules into a PNG download.
 * - Theme: Green (default), Cyan, Magenta.
 * - FPS: tiny meter top-left.
 *
 * Structure
 * - initCanvas()/resizeCanvas()
 * - MatrixRain class (offscreen glyph sheet, update/draw with glow layers)
 * - ProfileFactory (plausible fake profile fields; biased risk)
 * - CapsuleManager (spawn/type/hold/dissolve; DOM pooling; sparkline)
 * - UI bindings and RAF ticker
 */

// ---------------------------- Utilities ----------------------------------
const rand = (min, max) => Math.random() * (max - min) + min;
const randi = (min, max) => Math.floor(rand(min, max));
const choice = arr => arr[randi(0, arr.length)];

function weightedChoice(pairs) {
  // pairs: [value, weight]
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [v, w] of pairs) {
    if ((roll -= w) <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function formatMoneyUSD(n) {
  const sign = n < 0 ? '-' : '';
  const x = Math.abs(Math.round(n));
  return `${sign}$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function nowMs() { return performance.now(); }

// ---------------------------- Config -------------------------------------
const CONFIG = {
  densityScale: 1.0, // 0.2..2.0
  speedScale: 1.0,   // 0.5..3.0
  capsuleRateScale: 1.0, // 0.3..2.0 (higher = more)
  glowIntensity: 0.6, // 0..1
  showCode: true,
  allowHexCapsules: true,
  maxCapsules: 12,
  theme: 'green',
  showFps: false,
};

// Apply theme class to body
function applyTheme(theme) {
  document.body.classList.remove('theme-green', 'theme-cyan', 'theme-magenta');
  const cls = theme === 'cyan' ? 'theme-cyan' : theme === 'magenta' ? 'theme-magenta' : 'theme-green';
  document.body.classList.add(cls);
}

// ---------------------------- Canvas setup -------------------------------
const canvas = document.getElementById('rain');
const ctx = canvas.getContext('2d');

function initCanvas() { resizeCanvas(); }

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const { innerWidth: w, innerHeight: h } = window;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizeCanvas);

// ---------------------------- Matrix Rain --------------------------------
class MatrixRain {
  constructor(ctx) {
    this.ctx = ctx;
    this.columns = [];
    this.glyphSize = 16; // device-independent pixels
    this.columnCount = 0;
    this.characters = this.buildGlyphSet();
    this.sheet = this.buildGlyphSheet();
    this.resetColumns();
  }

  buildGlyphSet() {
    const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const punct = '!@#$%^&*()_+-=[]{};:\",./<>?';
    const kana = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
    return (latin + digits + punct + kana).split('');
  }

  buildGlyphSheet() {
    // prerender characters to an offscreen canvas rows x cols grid
    const size = this.glyphSize;
    const cols = 32; // per row
    const rows = Math.ceil(this.characters.length / cols);
    const off = document.createElement('canvas');
    off.width = cols * size;
    off.height = rows * size;
    const c = off.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, off.width, off.height);
    c.font = `${size - 2}px ui-monospace, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < this.characters.length; i++) {
      const ch = this.characters[i];
      const x = (i % cols) * size + size / 2;
      const y = Math.floor(i / cols) * size + size / 2;
      c.fillStyle = '#0f0';
      c.shadowBlur = 8;
      c.shadowColor = '#0f0';
      c.fillText(ch, x, y);
    }
    return { canvas: off, cols, size };
  }

  resetColumns() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    const density = 0.7 * CONFIG.densityScale; // base density
    const numCols = Math.max(8, Math.floor((w / size) * density));
    this.columnCount = numCols;
    this.columns.length = 0;
    for (let i = 0; i < numCols; i++) {
      this.columns.push(this.spawnColumn(i, h));
    }
  }

  spawnColumn(index, screenH) {
    const size = this.glyphSize;
    const x = Math.floor(index * (canvas.clientWidth / this.columnCount));
    return {
      x,
      y: randi(-screenH, 0),
      speed: rand(60, 180) * CONFIG.speedScale, // px per second
      streamLength: randi(10, 40),
      glyphIndices: Array.from({ length: 60 }, () => randi(0, this.characters.length)),
      drift: rand(-0.2, 0.2),
    };
  }

  update(dt) {
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    const speedScale = CONFIG.speedScale;
    // Occasionally rebuild columns when density changes or window resized
    const desiredCols = Math.max(8, Math.floor((canvas.clientWidth / size) * 0.7 * CONFIG.densityScale));
    if (desiredCols !== this.columnCount) {
      this.resetColumns();
      return;
    }
    for (const col of this.columns) {
      col.y += col.speed * speedScale * dt;
      if (col.y - col.streamLength * size > h + 20) {
        // recycle column
        Object.assign(col, this.spawnColumn(Math.random() * this.columnCount, h));
      }
      // mutate glyphs lightly
      if (Math.random() < 0.2) {
        const idx = randi(0, col.glyphIndices.length);
        col.glyphIndices[idx] = randi(0, this.characters.length);
      }
    }
  }

  draw() {
    const { ctx } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    // trail fade
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,0.18)`;
    ctx.fillRect(0, 0, w, h);

    // glow layers: paint dim layer then bright heads
    const glow = clamp(CONFIG.glowIntensity, 0, 1);
    const baseAlpha = 0.65;
    const headAlpha = 0.95;

    // precompute sheet
    const { canvas: sheet, cols, size: cell } = this.sheet;

    for (const col of this.columns) {
      let y = col.y;
      for (let i = 0; i < col.streamLength; i++) {
        const gi = col.glyphIndices[(i + (col.glyphIndices.length - (i % col.glyphIndices.length))) % col.glyphIndices.length];
        const sx = (gi % cols) * cell;
        const sy = Math.floor(gi / cols) * cell;
        const isHead = i === 0;

        ctx.globalAlpha = isHead ? headAlpha : baseAlpha * (1 - i / col.streamLength);
        // colorize via composite
        ctx.save();
        ctx.shadowBlur = 8 + glow * 14;
        ctx.shadowColor = getActiveColor();
        ctx.drawImage(sheet, sx, sy, cell, cell, col.x, y - i * size, size, size);
        ctx.restore();
      }
    }

    // optional code noise overlay
    if (CONFIG.showCode && Math.random() < 0.06) {
      ctx.globalAlpha = 0.9;
      ctx.font = `12px ui-monospace, monospace`;
      ctx.fillStyle = getActiveColor();
      const snippets = [
        "if(risk_score>70){alert('!')}",
        "SELECT * FROM agents WHERE mood='flow'",
        "for(let a of actors){a.tick()}",
        "while(load<1.0){optimize()}",
        "pub fn assess(r:u8)->u8{r^42}",
      ];
      ctx.fillText(choice(snippets), randi(0, w - 240), randi(0, h));
    }
  }
}

function getActiveColor() {
  const body = getComputedStyle(document.body);
  return body.getPropertyValue('--active').trim() || '#00ff66';
}

// ---------------------------- Profile Factory -----------------------------
const ProfileFactory = (() => {
  const firstNames = ['Ava','Mia','Liam','Noah','Emma','Oliver','Lucas','Amelia','Ethan','Sofia','Zoe','Kai','Nina','Leo','Isla','Maya','Ezra','Ivy','Mila','Aria','Theo','Luna','Finn','Mason','Iris'];
  const lastNames = ['Kim','Lee','Nguyen','Patel','Garcia','Chen','Smith','Khan','Mori','Silva','Rossi','Santos','Brown','Martin','Lopez','Wilson','Dubois','Kowalski'];
  const genders = ['female','male','non-binary'];
  const industries = ['Finance','Healthcare','Tech','Education','Retail','Energy','Gaming','Media','Gov','Aerospace'];
  const jobs = ['Engineer','Designer','Data Scientist','Analyst','PM','Researcher','Nurse','Teacher','Marketer','Artist','Security','Pilot'];
  const relationship = ['single','dating','married','complicated'];
  const education = ['HS','Associate','BSc','MSc','PhD'];
  const emotional = [
    ['focused', 3], ['stressed', 2], ['curious', 3], ['flow', 2],
    ['burnout', 1], ['optimistic', 2], ['calm', 2], ['distracted', 1]
  ];
  const cities = ['New York','Berlin','Tokyo','Seoul','Toronto','Paris','Madrid','Sydney','Sao Paulo','Nairobi','Dublin','Singapore'];

  function makeId() {
    return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4);
  }

  function sampleIncome(industry) {
    const base = {
      Tech: [80000, 220000], Finance: [70000, 250000], Healthcare: [50000, 180000],
      Education: [35000, 120000], Retail: [30000, 90000], Energy: [60000, 200000],
      Gaming: [45000, 150000], Media: [40000, 140000], Gov: [40000, 120000], Aerospace: [70000, 210000]
    }[industry] || [40000, 120000];
    return Math.round(rand(base[0], base[1]) / 1000) * 1000;
  }

  function riskFromIncomeAndMood(income, mood) {
    let r = rand(10, 90);
    if (income > 150000) r -= 10;
    if (income < 40000) r += 10;
    const moodBias = {
      burnout: +15, stressed: +10, distracted: +8, focused: -5, calm: -5, flow: -8, optimistic: -3, curious: 0
    };
    r += moodBias[mood] || 0;
    return clamp(Math.round(r), 0, 100);
  }

  function interestsSet() {
    const pool = ['climbing','reading','ai','music','crypto','gardening','photography','biking','chess','vr','cooking','yoga','travel','gaming'];
    const n = randi(2, 6);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  function generate() {
    const ind = choice(industries);
    const job = choice(jobs);
    const mood = weightedChoice(emotional);
    const age = randi(18, 70);
    const inc = sampleIncome(ind);
    const risk = riskFromIncomeAndMood(inc, mood);
    const profile = {
      id: makeId(),
      name: `${choice(firstNames)} ${choice(lastNames)}`,
      age,
      gender: choice(genders),
      job_title: job,
      industry: ind,
      income_usd: inc,
      education: choice(education),
      location_city: choice(cities),
      relationship_status: choice(relationship),
      emotional_state: mood,
      activity: choice(['browsing','coding','commuting','meeting','streaming','learning','exercising','shopping']),
      interests: interestsSet(),
      risk_score: risk,
      last_active: new Date(Date.now() - randi(0, 3600 * 1000)).toISOString(),
    };
    return profile;
  }

  return { generate };
})();

// ---------------------------- Capsule Manager -----------------------------
class CapsuleManager {
  constructor(container) {
    this.container = container;
    this.pool = [];
    this.active = new Set();
    this.spawnAccumulator = 0;
  }

  tick(dt) {
    // spawn logic
    const baseRate = 1.0; // per second baseline
    const rate = baseRate * CONFIG.capsuleRateScale;
    this.spawnAccumulator += dt * rate;
    if (this.spawnAccumulator >= rand(0.6, 1.4)) {
      this.spawnAccumulator = 0;
      if (this.active.size < CONFIG.maxCapsules) this.spawnRandom();
    }
  }

  spawnRandom() {
    const profile = ProfileFactory.generate();
    const mode = this.pickMode();
    const node = this.getNode();
    node.className = `capsule ${mode}`;
    node.style.opacity = '0';
    node.innerHTML = '';
    node.style.left = `${randi(10, Math.max(20, window.innerWidth - 360))}px`;
    node.style.top = `${randi(10, Math.max(20, window.innerHeight - 160))}px`;
    const hdr = document.createElement('div');
    hdr.className = 'hdr';
    hdr.textContent = 'PROFILE_STREAM';
    const content = document.createElement('div');
    const spark = Math.random() < 0.1 ? document.createElement('div') : null;
    if (spark) spark.className = 'spark';
    node.appendChild(hdr);
    node.appendChild(content);
    if (spark) node.appendChild(spark);
    this.container.appendChild(node);
    this.active.add(node);

    // Build text by mode
    let text = '';
    if (mode === 'json') {
      text = JSON.stringify(profile, null, 2);
    } else if (mode === 'inline') {
      text = [
        `id=${profile.id}`,
        `age=${profile.age}`,
        `job=${profile.job_title}`,
        `emotional=${profile.emotional_state}`,
        `income=${formatMoneyUSD(profile.income_usd)}`,
        `risk=${profile.risk_score}`
      ].join(' | ');
    } else {
      // hex mode - fake serialize to bytes
      const raw = JSON.stringify(profile);
      const bytes = Array.from(raw).map(ch => ch.charCodeAt(0) & 0xff);
      text = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    }

    // Optional sparkline of risk score history
    if (node.querySelector('.spark')) {
      const line = this.makeSparkline(profile.risk_score);
      node.querySelector('.spark').textContent = `risk_ticks ${line}`;
    }

    // Typewriter
    this.typeText(content, text, rand(0.04, 0.08), () => {
      // Highlight some fields briefly
      this.pulseHighlights(content);
      node.style.opacity = '1';
      // hold then dissolve
      setTimeout(() => this.dissolve(node), randi(2000, 4000));
    });
  }

  pickMode() {
    const modes = ['json', 'inline'];
    if (CONFIG.allowHexCapsules) modes.push('hex');
    return choice(modes);
  }

  getNode() {
    const n = this.pool.pop();
    return n || document.createElement('div');
  }

  releaseNode(node) {
    node.remove();
    this.pool.push(node);
  }

  typeText(container, fullText, secondsPerChar, done) {
    container.textContent = '';
    const chars = Array.from(fullText);
    let i = 0;
    const step = () => {
      const take = Math.max(1, Math.floor(0.016 / secondsPerChar));
      for (let k = 0; k < take && i < chars.length; k++, i++) {
        container.textContent += chars[i];
      }
      if (i < chars.length) {
        this.typeTimer = setTimeout(step, secondsPerChar * 1000);
      } else {
        done && done();
      }
    };
    step();
  }

  pulseHighlights(container) {
    const words = ['age', 'job', 'emotional', 'income', 'risk'];
    if (container.childNodes.length === 0) {
      // Simple effect: temporarily increase opacity via parent
      const original = container.parentElement.style.filter || '';
      container.parentElement.style.filter = 'brightness(1.5)';
      setTimeout(() => (container.parentElement.style.filter = original), 300);
      return;
    }
    // If richer markup existed, we'd add spans. Keeping lightweight.
  }

  dissolve(node) {
    // pixel scatter effect simulated by CSS opacity + translate jitter via JS
    const start = nowMs();
    const duration = 500;
    const x0 = parseFloat(node.style.left);
    const y0 = parseFloat(node.style.top);
    const jitter = () => {
      const t = (nowMs() - start) / duration;
      if (t >= 1) {
        this.active.delete(node);
        this.releaseNode(node);
        return;
      }
      const fade = 1 - t;
      node.style.opacity = String(fade);
      node.style.transform = `translate3d(${(Math.random()-0.5)*6}px, ${(Math.random()-0.5)*6}px, 0)`;
      requestAnimationFrame(jitter);
    };
    requestAnimationFrame(jitter);
  }

  makeSparkline(seed) {
    // generate 10 values around seed
    const arr = Array.from({ length: 10 }, (_, i) => clamp(Math.round(seed + (Math.random() - 0.5) * 20), 0, 100));
    const blocks = '▁▂▃▄▅▆▇█';
    return arr.map(v => blocks[Math.floor(v / 12.5)]).join('');
  }
}

// ---------------------------- UI Bindings ---------------------------------
const UI = (() => {
  function bind() {
    const qs = id => document.getElementById(id);
    qs('density').addEventListener('input', e => { CONFIG.densityScale = parseFloat(e.target.value); rain.resetColumns(); });
    qs('speed').addEventListener('input', e => { CONFIG.speedScale = parseFloat(e.target.value); });
    qs('capsuleRate').addEventListener('input', e => { CONFIG.capsuleRateScale = parseFloat(e.target.value); });
    qs('glow').addEventListener('input', e => {
      CONFIG.glowIntensity = parseFloat(e.target.value);
      document.documentElement.style.setProperty('--glow', CONFIG.glowIntensity.toString());
    });
    qs('showCode').addEventListener('change', e => { CONFIG.showCode = e.target.checked; });
    qs('showHex').addEventListener('change', e => { CONFIG.allowHexCapsules = e.target.checked; });
    qs('theme').addEventListener('change', e => { CONFIG.theme = e.target.value; applyTheme(CONFIG.theme); });
    qs('showFps').addEventListener('change', e => { CONFIG.showFps = e.target.checked; fpsEl.style.opacity = CONFIG.showFps ? '0.9' : '0'; });
    qs('btnShot').addEventListener('click', screenshot);

    // URL params presets
    try {
      const params = new URLSearchParams(location.search);
      if (params.has('dense')) qs('density').value = '1.6';
      if (params.has('fast')) qs('speed').value = '2.0';
      if (params.has('dense')) qs('density').dispatchEvent(new Event('input'));
      if (params.has('fast')) qs('speed').dispatchEvent(new Event('input'));
    } catch {}
  }
  return { bind };
})();

// ---------------------------- Screenshot ----------------------------------
function screenshot() {
  // Compose canvas + DOM capsules onto an offscreen canvas
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const c = out.getContext('2d');
  // paint main canvas
  c.drawImage(canvas, 0, 0, w, h);
  // draw capsules as text
  const capsules = Array.from(document.querySelectorAll('#capsules .capsule'));
  const color = getActiveColor();
  c.fillStyle = color;
  c.strokeStyle = color;
  c.shadowColor = color;
  for (const node of capsules) {
    const rect = node.getBoundingClientRect();
    const left = rect.left; const top = rect.top;
    const text = node.innerText;
    c.globalAlpha = parseFloat(node.style.opacity || '1');
    c.strokeRect(left, top, rect.width, rect.height);
    c.font = '12px ui-monospace, monospace';
    const lines = text.split('\n');
    let y = top + 10;
    for (const ln of lines) { y += 14; c.fillText(ln, left + 6, y); }
  }
  const url = out.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = `profile_stream_${Date.now()}.png`; a.click();
}

// ---------------------------- Ticker --------------------------------------
const fpsEl = document.getElementById('fps');
let last = nowMs();
let fpsAcc = 0, fpsCount = 0;
const rain = new MatrixRain(ctx);
const capsules = new CapsuleManager(document.getElementById('capsules'));

function tick() {
  const t = nowMs();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;

  rain.update(dt);
  rain.draw();
  capsules.tick(dt);

  // FPS meter
  fpsAcc += dt; fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    if (CONFIG.showFps) fpsEl.textContent = `${fps} fps`;
    fpsAcc = 0; fpsCount = 0;
  }

  requestAnimationFrame(tick);
}

// ---------------------------- Bootstrap -----------------------------------
applyTheme(CONFIG.theme);
initCanvas();
UI.bind();
requestAnimationFrame(tick);


