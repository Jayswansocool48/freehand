/*
 * kit.js: a small, tested 2D game engine from Freehand's game kit.
 * Load it before game.js with a plain <script src="kit.js"></script>.
 *
 *   Kit.start({ width, height, init, update, draw })
 *     init(g)      reset everything for a new round (called on every start and restart)
 *     update(g,dt) move things; dt is in seconds. Call Kit.gameOver() (or Kit.gameOver('You win!')) to end the round.
 *     draw(g,ctx)  draw the world. Title and game-over screens are drawn for you.
 *   Kit.down('left')     held this frame         actions: left right up down jump action
 *   Kit.pressed('jump')  pressed this frame only (Space, Up, W, click and tap all count as jump)
 *   Kit.overlap(a, b)    two {x, y, w, h} boxes touch
 *   Kit.sfx('jump')      jump coin hit boom power click
 *   Kit.image('assets/hero.png')  load once; Kit.drawImage(ctx, img, x, y, w, h, fallbackColor)
 *   Kit.addScore(n), Kit.burst(x, y, color), Kit.shake(px), Kit.rand(a, b)
 *   g.pointer            last mouse or touch position {x, y} in game pixels (null until the pointer moves)
 *
 * The state is mirrored to window.__game so play_test can report the score and screen.
 */
(function () {
  'use strict';
  const KEYS = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'jump', KeyZ: 'action', KeyX: 'action', Enter: 'action',
  };
  const held = new Set();
  let fresh = new Set();
  let cfg = null;
  let canvas = null;
  let ctx = null;
  let last = 0;
  let acc = 0;
  let shakeAmt = 0;
  let particles = [];
  let audio = null;
  const STEP = 1 / 60;

  const g = { state: 'title', score: 0, best: 0, time: 0, width: 400, height: 600, pointer: null };

  function loadBest() {
    try { return Number(localStorage.getItem('kit-best:' + document.title)) || 0; } catch (e) { return 0; }
  }
  function saveBest() {
    try { localStorage.setItem('kit-best:' + document.title, String(g.best)); } catch (e) { /* storage blocked */ }
  }

  function press(name) {
    if (!held.has(name)) fresh.add(name);
    held.add(name);
  }

  // One handler per input type, attached once. Starting and restarting go through here only.
  function onStartInput() {
    if (g.state === 'title') { begin(); return true; }
    if (g.state === 'over' && g.time - g.overAt > 0.6) { begin(); return true; }
    return false;
  }

  function attachInput() {
    window.addEventListener('keydown', function (e) {
      const name = KEYS[e.code];
      if (!name) return;
      e.preventDefault();
      if (e.repeat) return;
      if ((name === 'jump' || name === 'action') && onStartInput()) return;
      press(name);
    });
    window.addEventListener('keyup', function (e) {
      const name = KEYS[e.code];
      if (name) held.delete(name);
    });
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      unlockAudio();
      if (onStartInput()) return;
      press('jump');
      const r = canvas.getBoundingClientRect();
      g.pointer = { x: (e.clientX - r.left) * (g.width / r.width), y: (e.clientY - r.top) * (g.height / r.height) };
    });
    canvas.addEventListener('pointermove', function (e) {
      const r = canvas.getBoundingClientRect();
      g.pointer = { x: (e.clientX - r.left) * (g.width / r.width), y: (e.clientY - r.top) * (g.height / r.height) };
    });
    window.addEventListener('pointerup', function () { held.delete('jump'); });
    window.addEventListener('blur', function () { held.clear(); });
  }

  function begin() {
    unlockAudio();
    g.state = 'play';
    g.score = 0;
    g.time = 0;
    particles = [];
    held.clear();
    fresh = new Set();
    cfg.init(g);
    Kit.sfx('click');
  }

  function gameOver(title) {
    if (g.state !== 'play') return;
    g.state = 'over';
    g.overTitle = title || 'Game over';
    g.overAt = g.time;
    if (g.score > g.best) { g.best = g.score; saveBest(); }
    Kit.sfx('hit');
    Kit.shake(8);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    acc += dt;
    while (acc >= STEP) {
      g.time += STEP;
      if (g.state === 'play') cfg.update(g, STEP);
      for (const p of particles) { p.x += p.vx * STEP; p.y += p.vy * STEP; p.vy += 400 * STEP; p.life -= STEP; }
      particles = particles.filter(function (p) { return p.life > 0; });
      fresh.clear();
      acc -= STEP;
    }
    render();
    publish();
    requestAnimationFrame(frame);
  }

  function render() {
    ctx.save();
    ctx.clearRect(0, 0, g.width, g.height);
    if (shakeAmt > 0.3) { ctx.translate(Kit.rand(-shakeAmt, shakeAmt), Kit.rand(-shakeAmt, shakeAmt)); shakeAmt *= 0.88; }
    cfg.draw(g, ctx);
    for (const p of particles) { ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (g.state === 'play') hudText('Score ' + g.score, g.width / 2, 40, 28);
    if (g.state === 'title') screen(cfg.title || document.title, cfg.hint || 'Press Space or click to start');
    if (g.state === 'over') screen(g.overTitle, 'Score ' + g.score + '   Best ' + g.best + '\nPress Space or click to play again');
  }

  function hudText(text, x, y, size) {
    ctx.font = 'bold ' + size + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = Math.max(3, size / 7);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function screen(title, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, g.width, g.height);
    hudText(title, g.width / 2, g.height * 0.4, 40);
    sub.split('\n').forEach(function (line, i) { hudText(line, g.width / 2, g.height * 0.4 + 44 + i * 26, 18); });
  }

  function publish() {
    window.__game = { state: g.state, score: g.score, best: g.best, time: Math.round((g.state === 'over' ? g.overAt : g.time) * 10) / 10 }; // time = how long this round has lasted
    if (cfg.debug) Object.assign(window.__game, cfg.debug(g));
  }

  function fit() {
    const s = Math.min(window.innerWidth / g.width, window.innerHeight / g.height);
    canvas.style.width = Math.floor(g.width * s) + 'px';
    canvas.style.height = Math.floor(g.height * s) + 'px';
  }

  function unlockAudio() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }

  const SOUNDS = {
    jump: [['square', 300, 600, 0.12, 0.15]],
    coin: [['square', 880, 880, 0.06, 0.12], ['square', 1320, 1320, 0.12, 0.12, 0.06]],
    hit: [['sawtooth', 220, 60, 0.3, 0.2]],
    boom: [['noise', 0, 0, 0.4, 0.3]],
    power: [['triangle', 300, 1200, 0.35, 0.18]],
    click: [['sine', 660, 660, 0.05, 0.1]],
  };

  const Kit = {
    start: function (options) {
      cfg = options;
      g.width = options.width || 400;
      g.height = options.height || 600;
      g.best = loadBest();
      canvas = document.querySelector('canvas') || document.body.appendChild(document.createElement('canvas'));
      canvas.width = g.width;
      canvas.height = g.height;
      canvas.style.touchAction = 'none';
      canvas.tabIndex = 0;
      ctx = canvas.getContext('2d');
      attachInput();
      window.addEventListener('resize', fit);
      fit();
      cfg.init(g); // so the title screen has a world behind it
      g.state = 'title';
      requestAnimationFrame(function (t) { last = t; requestAnimationFrame(frame); });
      return g;
    },
    down: function (name) { return held.has(name); },
    pressed: function (name) { return fresh.has(name); },
    gameOver: gameOver,
    addScore: function (n) { g.score += n == null ? 1 : n; },
    overlap: function (a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; },
    clamp: function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    shake: function (px) { shakeAmt = Math.max(shakeAmt, px); },
    burst: function (x, y, color, n) {
      for (let i = 0; i < (n || 14); i++) {
        const a = Math.random() * Math.PI * 2;
        const s = Kit.rand(60, 220);
        particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: 0.6, max: 0.6, color: color || '#fff' });
      }
    },
    image: function (src) {
      const img = new Image();
      img.onerror = function () { console.warn('Image missing, drawing a box instead: ' + src); img.failed = true; };
      img.src = src;
      return img;
    },
    drawImage: function (c, img, x, y, w, h, fallback) {
      if (img && img.complete && img.naturalWidth && !img.failed) { c.imageSmoothingEnabled = false; c.drawImage(img, x, y, w, h); }
      else { c.fillStyle = fallback || '#f0c'; c.fillRect(x, y, w, h); }
    },
    sfx: function (name) {
      if (!audio || audio.state !== 'running') return;
      for (const [type, f1, f2, dur, vol, delay] of SOUNDS[name] || []) {
        const t = audio.currentTime + (delay || 0);
        const gain = audio.createGain();
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        gain.connect(audio.destination);
        let src;
        if (type === 'noise') {
          const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * dur), audio.sampleRate);
          const d = buf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          src = audio.createBufferSource();
          src.buffer = buf;
        } else {
          src = audio.createOscillator();
          src.type = type;
          src.frequency.setValueAtTime(f1, t);
          src.frequency.exponentialRampToValueAtTime(f2, t + dur);
        }
        src.connect(gain);
        src.start(t);
        src.stop(t + dur);
      }
    },
  };
  window.Kit = Kit;
})();
