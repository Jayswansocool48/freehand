/* Freehand UI. No framework, no build step. Icons are Phosphor (regular), inlined from /icons.
   Layout follows Hatch: sidebar with recents, home greeting, one composer box, full-page settings. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const shell = window.freehandShell || null;
  const store = {
    get(k) { try { return localStorage.getItem('fh.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('fh.' + k, v); } catch { /* private window */ } },
  };

  const state = {
    tasks: [], current: null, es: null, settings: null, presets: {}, info: null, running: false,
    view: 'home', section: 'general',
    tools: new Map(),   // tool call id -> frame
    frames: [],         // one per tool call: what the Computer panel can show
    sel: -1, live: true, panelOpen: false, panelTab: 'live',
    plan: [], lastSeq: -1, lastUser: null, // lastUser: the newest user event, which retry re-runs
    hidden: new Set(),  // tasks deleted but still undoable
    playPath: null, playNonce: 0, // what the Play tab runs: a page/game, or a 3D model in the viewer
    attach: [], draft: null,      // files attached in the composer; draft = task made to hold them before the first message
  };

  /* ---------- API ---------- */
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { method: opts.method || 'GET', headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error || m; } catch { /* ignore */ } throw new Error(m); }
    return res.json();
  }

  /* ---------- Icons ---------- */
  const iconCache = new Map();
  function icon(name) {
    if (!iconCache.has(name)) iconCache.set(name, fetch(`icons/${name}.svg`).then((r) => (r.ok ? r.text() : '')).catch(() => ''));
    return iconCache.get(name);
  }
  function setIcon(node, name) { icon(name).then((h) => { node.innerHTML = h; }); return node; }
  const ic = (name, cls = 'ic') => setIcon(el('span', cls), name);
  function hydrateIcons(root = document) { $$('[data-icon]', root).forEach((n) => { if (!n.firstChild) setIcon(n, n.dataset.icon); }); }

  /* ---------- Toasts (undo instead of confirm dialogs) ---------- */
  function toast(text, opts = {}) {
    const t = el('div', 'toast' + (opts.error ? ' error' : ''));
    t.setAttribute('role', opts.error ? 'alert' : 'status');
    t.append(el('span', 'grow', esc(text)));
    const close = () => { clearTimeout(timer); t.remove(); };
    if (opts.undo) {
      const b = el('button', 'btn', 'Undo'); b.type = 'button';
      b.addEventListener('click', () => { close(); opts.undo(); });
      t.append(b);
    }
    $('#toasts').append(t);
    const timer = setTimeout(() => { t.remove(); if (opts.done) opts.done(); }, opts.ms || (opts.undo ? 5000 : 2400));
    return close;
  }

  /* ---------- Appearance ---------- */
  const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim();
  const dark = matchMedia('(prefers-color-scheme: dark)');
  function applyAppearance(ui) {
    const root = document.documentElement;
    const theme = ui.theme === 'light' || ui.theme === 'dark' ? ui.theme : dark.matches ? 'dark' : 'light';
    root.dataset.theme = theme;
    root.dataset.font = ui.chatFont || 'sans';
    root.dataset.motion = ui.reduceMotion ? 'reduce' : '';
    const f = clean(ui.font), m = clean(ui.monoFont);
    if (f) root.style.setProperty('--sans', `"${f}", "IBM Plex Sans Variable", system-ui, sans-serif`); else root.style.removeProperty('--sans');
    if (m) root.style.setProperty('--mono', `"${m}", "IBM Plex Mono", ui-monospace, monospace`); else root.style.removeProperty('--mono');
    // Keep the native window buttons (min / max / close) matching the app, since there is no OS title bar.
    requestAnimationFrame(() => {
      const cs = getComputedStyle(root);
      if (shell) shell.setChrome({ color: cs.getPropertyValue('--background').trim(), symbolColor: cs.getPropertyValue('--foreground').trim() });
    });
  }
  dark.addEventListener('change', () => { if (state.settings) applyAppearance(state.settings.ui); });

  async function patchSettings(patch, msg = 'Saved') {
    try {
      const r = await api('/settings', { method: 'PUT', body: patch });
      takeSettings(r);
      if (msg) toast(msg);
    } catch (e) { toast(e.message, { error: true }); }
  }
  function takeSettings(r) {
    state.settings = r.settings; state.presets = r.presets;
    applyAppearance(r.settings.ui);
    renderModelChip();
  }
  async function loadSettings() { takeSettings(await api('/settings')); }
  const activeProvider = () => state.settings.providers[state.settings.active];
  const providerName = (id) => (state.presets[id] ? state.presets[id].label.replace(/\s*\(.*\)$/, '') : id);

  /* ---------- Menus ---------- */
  let openMenu = null;
  function closeMenus() {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.button.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  function toggleMenu(button, menu, fill) {
    const was = openMenu && openMenu.menu === menu;
    closeMenus();
    if (was) return;
    menu.innerHTML = '';
    fill(menu);
    menu.hidden = false;
    // Composer menus share one element; line it up with the button that opened it.
    if (menu.id === 'model-pop') menu.style.left = button.offsetLeft + 'px';
    button.setAttribute('aria-expanded', 'true');
    openMenu = { button, menu };
    const first = $('.menu-item, input', menu);
    if (first) first.focus();
  }
  function menuItem(iconName, label, sub, onClick, opts = {}) {
    const b = el('button', 'menu-item' + (opts.danger ? ' danger' : ''));
    b.type = 'button';
    b.setAttribute('role', opts.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (opts.checked !== undefined) b.setAttribute('aria-checked', String(opts.checked));
    if (iconName) b.append(ic(iconName));
    const g = el('span', 'grow'); g.append(document.createTextNode(label));
    if (sub) g.append(el('small', '', esc(sub)));
    b.append(g);
    if (opts.keys) b.append(el('kbd', 'kbd', esc(opts.keys)));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (!opts.keepOpen) closeMenus(); onClick(); });
    return b;
  }

  /* ---------- Views ---------- */
  function showView(v) {
    state.view = v;
    $('#view-home').hidden = v !== 'home';
    $('#view-task').hidden = v !== 'task';
    $('#view-settings').hidden = v !== 'settings';
    // One composer, moved to whichever screen is showing.
    const slot = v === 'home' ? '#composer-home-slot' : v === 'task' ? '#composer-task-slot' : null;
    if (slot && $('#composer').parentElement !== $(slot)) $(slot).append($('#composer'));
    if (v !== 'task') setPanel(false);
    $('#new-task').setAttribute('aria-current', v === 'home' ? 'page' : 'false');
    renderTasks();
    if (v === 'home') renderHomeRecent();
  }
  function setSidebar(collapsed) {
    $('#app').classList.toggle('collapsed', collapsed);
    $('#toggle-sidebar').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    store.set('collapsed', collapsed ? '1' : '0');
  }
  function setPanel(open) {
    state.panelOpen = open;
    $('#app').classList.toggle('panel-open', open);
    $('#toggle-computer').setAttribute('aria-pressed', String(open));
  }

  /* ---------- Sidebar and recents ---------- */
  async function loadTasks() { state.tasks = (await api('/tasks')).tasks; renderTasks(); if (state.view === 'home') renderHomeRecent(); }
  const visibleTasks = () => state.tasks.filter((t) => !state.hidden.has(t.id));
  function renderTasks() {
    const box = $('#task-list');
    box.innerHTML = '';
    const list = visibleTasks();
    if (!list.length) box.append(el('div', 'empty-list', 'Your tasks show up here.'));
    for (const t of list) {
      const b = el('button', 'nav-item recent');
      b.setAttribute('aria-current', state.view === 'task' && state.current === t.id ? 'page' : 'false');
      b.title = t.title;
      b.append(el('span', 'dot ' + t.status), el('span', '', esc(t.title)));
      const del = setIcon(el('span', 'del'), 'trash');
      del.title = 'Delete task';
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', `Delete ${t.title}`);
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(t); });
      b.append(del);
      b.addEventListener('click', () => openTask(t.id));
      box.append(b);
    }
  }
  function renderHomeRecent() {
    const list = visibleTasks().slice(0, 5);
    $('#home-recent').hidden = !list.length;
    const box = $('#home-recent-list');
    box.innerHTML = '';
    for (const t of list) {
      const r = el('button', 'list-row'); r.type = 'button';
      r.append(ic(t.status === 'error' ? 'warning' : t.status === 'done' ? 'check-circle' : 'chat-circle-text'), el('b', '', esc(t.title)), el('small', '', ago(t.updated)));
      r.addEventListener('click', () => openTask(t.id));
      box.append(r);
    }
  }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  }
  function deleteTask(t) {
    state.hidden.add(t.id);
    if (state.current === t.id) newTask();
    renderTasks(); renderHomeRecent();
    toast(`Deleted "${t.title}"`, {
      undo: () => { state.hidden.delete(t.id); renderTasks(); renderHomeRecent(); },
      done: () => api('/tasks/' + t.id, { method: 'DELETE' }).then(() => { state.hidden.delete(t.id); loadTasks(); }).catch((e) => toast(e.message, { error: true })),
    });
  }

  /* ---------- Task view ---------- */
  function resetView() {
    if (state.es) { state.es.close(); state.es = null; }
    state.tools.clear(); state.frames = []; state.sel = -1; state.live = true; state.plan = []; state.lastSeq = -1; state.lastUser = null;
    $('#timeline').innerHTML = '';
    renderProgress();
    renderPanel();
    setStatus('idle');
  }
  function newTask() {
    state.current = null;
    state.attach = []; renderAttachments();
    resetView();
    showView('home');
    $('#input').focus();
  }
  function openTask(id) {
    if (state.current !== id) { state.attach = []; renderAttachments(); state.playPath = null; }
    state.current = id;
    resetView();
    showView('task');
    const t = state.tasks.find((x) => x.id === id);
    $('#task-title-text').textContent = t ? t.title : 'Task';
    const es = new EventSource(`/api/tasks/${id}/events`);
    state.es = es;
    es.onmessage = (m) => { const ev = JSON.parse(m.data); if (ev.seq <= state.lastSeq) return; state.lastSeq = ev.seq; handle(ev); };
    $('#input').focus();
  }
  function setStatus(s) {
    state.running = s === 'running';
    const pill = $('#status-pill');
    pill.hidden = s === 'idle';
    pill.className = 'pill ' + s;
    pill.textContent = { running: 'Working', done: 'Done', error: 'Error', stopped: 'Stopped' }[s] || '';
    $('#stop').hidden = !state.running;
    document.body.classList.toggle('busy', state.running);
    $('#send').hidden = state.running;
    updateSend();
    $('#input').placeholder = state.running ? 'Answer Freehand\'s questions here, or press stop' : state.current ? 'Reply or ask for a follow-up' : 'Describe a task';
    setWorking(state.running);
    renderProgress();
  }

  const thread = () => $('#thread');
  const nearBottom = () => { const t = thread(); return t.scrollHeight - t.scrollTop - t.clientHeight < 200; };
  function add(node, cls = '') {
    const tl = $('#timeline');
    const near = nearBottom();
    const working = $('.working', tl);
    if (node.classList.contains('step')) {
      // Consecutive tool calls group into one tidy activity block.
      let group = working ? working.previousElementSibling : tl.lastElementChild;
      if (!group || !group.classList.contains('activity')) { group = el('div', 'activity item'); tl.insertBefore(group, working); }
      group.append(node);
    } else {
      node.classList.add('item');
      if (cls) node.classList.add(cls);
      tl.insertBefore(node, working);
    }
    if (near) thread().scrollTop = thread().scrollHeight;
    return node;
  }
  function setWorking(on) {
    const tl = $('#timeline');
    const cur = $('.working', tl);
    if (on && !cur) { const w = el('div', 'working item'); w.append(ic('spinner-gap'), el('span', '', 'Working')); tl.append(w); }
    if (!on && cur) cur.remove();
  }

  /* ---------- Frames (what the Computer panel replays) ---------- */
  const KIND = { play_test: 'game', make_model: 'model', model_info: 'model', browser: 'browser', shell: 'terminal', python: 'terminal', file_write: 'editor', file_edit: 'editor', file_read: 'editor', file_list: 'editor', web_search: 'search', web_fetch: 'search' };
  const KIND_NAME = { game: 'the game tester', model: 'the model maker', browser: 'the browser', terminal: 'the terminal', editor: 'the editor', search: 'search', text: 'a tool' };

  function addFrame(ev) {
    const frame = { id: ev.id, name: ev.name, label: ev.label, icon: ev.icon, args: ev.args || {}, kind: KIND[ev.name] || 'text', status: 'running', output: '', live: '', shot: null, row: null };
    state.frames.push(frame);
    state.tools.set(ev.id, frame);
    return frame;
  }
  function selectFrame(i) {
    state.sel = Math.max(0, Math.min(state.frames.length - 1, i));
    state.live = state.sel === state.frames.length - 1; // viewing the newest step = following live
    for (const f of state.frames) if (f.row) f.row.classList.toggle('sel', f === state.frames[state.sel]);
    renderPanel();
  }
  function renderPanel() {
    const body = $('#cp-body');
    const tl = $('#cp-timeline');
    $$('.cp-tab').forEach((t) => t.setAttribute('aria-checked', String(t.dataset.cp === state.panelTab)));
    if (state.panelTab === 'play') { tl.hidden = true; return renderPlay(); }
    delete body.dataset.play;
    if (state.panelTab === 'files') { tl.hidden = true; $('#cp-status').textContent = ''; return renderFiles(); }
    tl.hidden = false;
    const n = state.frames.length;
    const slider = $('#cp-slider');
    slider.max = String(Math.max(0, n - 1)); slider.value = String(Math.max(0, state.sel)); slider.disabled = n < 2;
    $('#cp-prev').disabled = state.sel <= 0; $('#cp-next').disabled = state.sel >= n - 1;
    $('#cp-live').hidden = state.live || n === 0;
    body.innerHTML = '';
    const status = $('#cp-status');
    status.innerHTML = '';
    if (!n || state.sel < 0) {
      body.append(el('div', 'cp-empty', 'Browser pages, terminals and files show up here while Freehand works.'));
      return;
    }
    const f = state.frames[state.sel];
    const running = f.status === 'running';
    if (running) status.append(el('span', 'live-dot'));
    status.append(document.createTextNode(`${running ? 'Using' : 'Used'} ${KIND_NAME[f.kind]}  ·  step ${state.sel + 1} of ${n}`));
    const out = f.output || f.live;
    if (f.kind === 'game' || f.kind === 'model') {
      const target = f.kind === 'game' ? (f.args.path || 'index.html') : f.args.path || '';
      const bar = el('div', 'cp-bar'); bar.append(ic(f.kind === 'game' ? 'game-controller' : 'cube'), el('span', 'grow', esc(target)));
      if (target && !running) {
        const go = el('button', 'btn', f.kind === 'game' ? 'Play it yourself' : 'View in 3D'); go.type = 'button';
        go.addEventListener('click', () => openPlay(target));
        bar.append(go);
      }
      body.append(bar);
      if (f.shot) { const img = el('img', 'cp-shot'); img.alt = 'Screenshot of the game'; img.src = fileUrl(f.shot); body.append(img); }
      body.append(preBlock(out || (f.kind === 'game' ? 'Starting the game' : 'Working'), 'cp-pre'));
    } else if (f.kind === 'browser') {
      const url = (out.match(/^URL: (.*)$/m) || [])[1] || f.args.url || '';
      const bar = el('div', 'cp-bar'); bar.append(ic('globe'), document.createTextNode(url || f.label));
      body.append(bar);
      if (f.shot) { const img = el('img', 'cp-shot'); img.alt = 'Browser screenshot'; img.src = `/api/tasks/${state.current}/file?path=${encodeURIComponent(f.shot)}`; body.append(img); }
      else body.append(preBlock(out || 'Starting the browser', 'cp-pre'));
    } else if (f.kind === 'terminal') {
      const cmd = f.name === 'python' ? f.args.code : f.args.command;
      const pre = el('pre', 'cp-pre cp-term');
      pre.append(el('span', 'cmd', f.name === 'python' ? 'python3 script.py\n' : '$ ' + esc(cmd || '') + '\n'));
      if (f.name === 'python') pre.append(document.createTextNode('\n' + (cmd || '') + '\n\n--- output ---\n'));
      pre.append(document.createTextNode(out || (running ? '...' : '')));
      body.append(pre);
    } else if (f.kind === 'editor') {
      const bar = el('div', 'cp-bar'); bar.append(ic('file-code'), document.createTextNode(f.args.path || '.'));
      body.append(bar);
      const text = f.args.content != null ? String(f.args.content) : f.name === 'file_edit' ? `- ${f.args.find}\n+ ${f.args.replace}\n\n${out}` : out;
      body.append(preBlock(text || '...', 'cp-pre'));
    } else {
      const bar = el('div', 'cp-bar'); bar.append(ic(f.icon || 'globe'), document.createTextNode(f.label));
      body.append(bar, preBlock(out || 'Working', 'cp-pre'));
    }
    body.scrollTop = f.kind === 'terminal' ? body.scrollHeight : 0;
  }
  const preBlock = (text, cls) => { const p = el('pre', cls); p.textContent = text; return p; };

  /** The task's files as [{ rel, name, depth, isDir }], from the server's indented listing. */
  async function fileTree() {
    if (!state.current) return [];
    const { tree } = await api(`/tasks/${state.current}/files`).catch(() => ({ tree: '' }));
    const lines = tree && tree !== '(empty)' ? tree.split('\n') : [];
    const stack = [];
    return lines.map((line) => {
      const depth = line.match(/^ */)[0].length / 2;
      const name = line.trim().replace(/ \(\d+ bytes\)$/, '');
      stack.length = depth;
      const isDir = name.endsWith('/');
      stack[depth] = isDir ? name.slice(0, -1) : null;
      return { depth, isDir, name: name.replace(/\/$/, ''), rel: [...stack.slice(0, depth).filter(Boolean), name.replace(/\/$/, '')].join('/') };
    });
  }
  const isPage = (f) => /\.html?$/i.test(f);
  const isModel = (f) => /\.(glb|gltf|obj|fbx|stl)$/i.test(f);

  async function renderFiles() {
    const body = $('#cp-body');
    const files = await fileTree();
    if (state.panelTab !== 'files') return;
    body.innerHTML = '';
    if (!state.current) return body.append(el('div', 'cp-empty', 'Files appear here.'));
    if (!files.length) return body.append(el('div', 'cp-empty', 'Files Freehand makes, and files you attach, appear here.'));
    const ul = el('ul', 'files-list');
    for (const f of files) {
      const li = el('li', f.isDir ? 'dir' : '');
      li.style.paddingLeft = 10 + f.depth * 16 + 'px';
      li.append(ic(f.isDir ? 'folder-open' : isModel(f.name) ? 'cube' : isPage(f.name) ? 'game-controller' : 'file-text'), el('span', 'nm', esc(f.name)));
      if (!f.isDir) {
        if (isPage(f.name) || isModel(f.name)) {
          const play = el('button', 'btn btn-quiet', isModel(f.name) ? 'View' : 'Play'); play.type = 'button';
          play.addEventListener('click', (e) => { e.stopPropagation(); openPlay(f.rel); });
          li.append(play);
        }
        const dl = el('a'); dl.href = fileUrl(f.rel, true); dl.title = 'Download'; dl.setAttribute('aria-label', `Download ${f.name}`); dl.append(ic('download'));
        dl.addEventListener('click', (e) => e.stopPropagation());
        li.append(dl);
        li.addEventListener('click', () => (isModel(f.name) ? openPlay(f.rel) : previewFile(f.rel)));
      }
      ul.append(li);
    }
    body.append(ul);
  }

  /* ---------- Play tab: runs what Freehand built, on a separate origin, sandboxed ---------- */
  function openPlay(rel) {
    state.playPath = rel;
    state.playNonce++;
    if (state.view !== 'task' && state.current) openTask(state.current);
    setPanel(true);
    state.panelTab = 'play';
    renderPanel();
  }
  // Redraws overlap while Freehand writes files; only the newest may draw, or each adds its own player.
  let playGen = 0;
  async function renderPlay() {
    const gen = ++playGen;
    const body = $('#cp-body');
    const status = $('#cp-status');
    const files = (await fileTree()).filter((f) => !f.isDir && (isPage(f.name) || isModel(f.name))).map((f) => f.rel);
    if (state.panelTab !== 'play' || gen !== playGen) return;
    if (!state.playPath || !files.includes(state.playPath)) state.playPath = files.find((f) => /(^|\/)index\.html?$/i.test(f)) || files.find(isPage) || files[0] || null;
    const key = `${state.current}|${state.playPath}|${state.playNonce}`;
    if (body.dataset.play === key && body.querySelector('iframe')) return; // keep the running game
    body.dataset.play = key;
    body.innerHTML = '';
    status.innerHTML = '';
    if (!state.current || !state.playPath) {
      body.append(el('div', 'cp-empty', 'Games, pages and 3D models Freehand builds run here, so you can play them without leaving the app. Ask for a game, or attach a model with the paperclip.'));
      return;
    }
    const { url } = await api(`/tasks/${state.current}/preview?path=${encodeURIComponent(state.playPath)}`).catch(() => ({ url: '' }));
    if (state.panelTab !== 'play' || body.dataset.play !== key || gen !== playGen) return;
    body.innerHTML = '';
    const bar = el('div', 'cp-bar play-bar');
    const pick = el('select'); pick.setAttribute('aria-label', 'What to play');
    for (const f of files) { const o = el('option', '', esc(f)); o.value = f; pick.append(o); }
    pick.value = state.playPath;
    pick.addEventListener('change', () => { state.playPath = pick.value; state.playNonce++; renderPanel(); });
    const btn = (name, label, fn) => { const b = el('button', 'icon-btn'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.append(ic(name)); b.addEventListener('click', fn); return b; };
    const frame = el('iframe', 'cp-frame');
    frame.title = state.playPath;
    // A different origin from the app, so allow-same-origin only gives the game its own storage, not ours.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals');
    frame.setAttribute('allow', 'fullscreen; autoplay; gamepad; accelerometer; gyroscope');
    frame.allowFullscreen = true;
    bar.append(pick,
      btn('arrow-clockwise', 'Restart', () => { state.playNonce++; renderPanel(); }),
      btn('arrows-out', 'Full screen', () => frame.requestFullscreen && frame.requestFullscreen().catch(() => {})),
      btn('arrow-square-out', 'Open in your browser', () => url && window.open(url, '_blank')));
    body.append(bar, frame);
    frame.src = url;
    frame.addEventListener('load', () => { try { frame.focus(); } catch { /* cross-origin */ } });
    status.textContent = isModel(state.playPath) ? 'Drag to turn the model, scroll to zoom.' : 'Click the game to give it your keyboard and mouse.';
  }
  const fileUrl = (rel, download) => `/api/tasks/${state.current}/file?path=${encodeURIComponent(rel)}${download ? '&download=1' : ''}`;
  async function previewFile(rel) {
    const body = $('#cp-body');
    const res = await fetch(fileUrl(rel));
    body.innerHTML = '';
    const bar = el('div', 'cp-bar'); const back = el('button', 'btn btn-quiet', 'Back'); back.type = 'button'; back.addEventListener('click', renderFiles);
    bar.append(back, document.createTextNode(rel));
    body.append(bar);
    if ((res.headers.get('content-type') || '').startsWith('image/')) { const img = el('img', 'cp-shot'); img.src = fileUrl(rel); img.alt = rel; body.append(img); }
    else body.append(preBlock((await res.text()).slice(0, 60000), 'cp-pre'));
  }

  /* ---------- Plan progress ---------- */
  function renderProgress() {
    const steps = state.plan;
    $('#progress').hidden = !steps.length;
    if (!steps.length) return;
    const done = steps.filter((s) => s.status === 'done').length;
    const active = steps.find((s) => s.status === 'active');
    const finished = done === steps.length;
    const icn = $('#progress-icon');
    icn.className = finished ? 'done' : state.running ? 'spin' : '';
    setIcon(icn, finished ? 'check-circle' : 'spinner-gap');
    $('#progress-cur').textContent = finished ? 'Every step is done' : active ? active.text : steps[0].text;
    $('#progress-count').textContent = `${done} / ${steps.length}`;
    const list = $('#progress-list');
    list.innerHTML = '';
    for (const s of steps) {
      const li = el('li', s.status);
      li.append(ic(s.status === 'done' ? 'check-circle' : s.status === 'active' ? 'spinner-gap' : 'circle'), el('span', '', esc(s.text)));
      list.append(li);
    }
  }

  /* ---------- Agent events ---------- */
  function handle(ev) {
    switch (ev.type) {
      case 'status': setStatus(ev.status); loadTasks(); if (ev.status !== 'running' && state.panelTab === 'files') renderPanel(); break;
      case 'title': $('#task-title-text').textContent = ev.title; loadTasks(); break;
      case 'user': state.lastUser = ev; add(userMessage(ev)); break;
      case 'plan': state.plan = ev.steps; renderProgress(); break;
      case 'thought': add(el('div', 'msg-ai thought', esc(ev.text))); break;
      case 'step_note': if (ev.text) { const n = el('div', 'note ok'); n.append(ic('check-circle'), el('span', '', esc(ev.text))); add(n); } break;
      case 'notice': { const n = el('div', 'note'); n.append(ic('warning'), el('span', '', esc(ev.text))); add(n); break; }
      case 'tool': {
        const f = addFrame(ev);
        const row = el('button', 'step running');
        row.type = 'button';
        row.title = 'Show this step on Freehand\'s computer';
        row.append(ic(ev.icon || 'code'), el('span', 'lbl', esc(ev.label)), setIcon(el('span', 'state ic'), 'spinner-gap'));
        row.addEventListener('click', () => { setPanel(true); state.panelTab = 'live'; selectFrame(state.frames.indexOf(f)); });
        f.row = row;
        add(row);
        if (state.frames.length === 1 && innerWidth > 1000) setPanel(true); // opens once per task; stays shut if you close it
        if (state.live) selectFrame(state.frames.length - 1); else renderPanel();
        break;
      }
      case 'terminal': { const f = [...state.frames].reverse().find((x) => x.kind === 'terminal' && x.status === 'running'); if (f) { f.live = (f.live + ev.data).slice(-20000); if (state.frames[state.sel] === f) renderPanel(); } break; }
      case 'shot': { const f = [...state.frames].reverse().find((x) => (x.kind === 'browser' || x.kind === 'game') && x.status === 'running'); if (f) { f.shot = ev.path; if (state.frames[state.sel] === f) renderPanel(); } break; }
      case 'tool_result': {
        const f = state.tools.get(ev.id);
        if (!f) break;
        f.status = ev.ok ? 'ok' : 'fail'; f.output = ev.preview;
        f.row.classList.remove('running'); f.row.classList.add(ev.ok ? 'ok' : 'fail');
        setIcon($('.state', f.row), ev.ok ? 'check' : 'warning');
        if (state.frames[state.sel] === f) renderPanel();
        break;
      }
      case 'file': if (state.panelTab === 'files') renderPanel(); break;
      case 'play': state.playPath = ev.path; state.playNonce++; if (state.panelTab === 'play') renderPanel(); break;
      case 'model': if (!state.playPath || isModel(state.playPath)) { state.playPath = ev.path; state.playNonce++; if (state.panelTab === 'play') renderPanel(); } break;
      case 'approval': add(approvalCard(ev)); break;
      case 'ask': add(askCard(ev)); break;
      case 'resolved': { const c = document.querySelector(`[data-pid="${ev.id}"]`); if (c) { c.classList.add('resolved'); $$('button,input', c).forEach((b) => (b.disabled = true)); } break; }
      case 'final': add(finalBlock(ev)); break;
      case 'error': { const turn = state.lastUser; const box = el('div', 'error-turn'); box.append(el('div', 'error-box', esc(ev.message)), msgActions({ retry: turn })); add(box); break; }
    }
  }

  function approvalCard(ev) {
    const c = el('div', 'card approval');
    c.dataset.pid = ev.id;
    const head = el('div', 'card-head'); head.append(ic('shield-check'), el('span', '', esc(ev.title) + ': allow this?'));
    const pre = el('pre'); pre.textContent = ev.detail;
    const act = el('div', 'actions');
    const ok = el('button', 'btn btn-primary', 'Allow'); ok.type = 'button';
    const no = el('button', 'btn', 'Deny'); no.type = 'button';
    ok.addEventListener('click', () => respond(ev.id, true));
    no.addEventListener('click', () => respond(ev.id, false));
    act.append(ok, no);
    c.append(head, pre, act);
    return c;
  }
  function askCard(ev) {
    const c = el('div', 'card');
    c.dataset.pid = ev.id;
    const head = el('div', 'card-head'); head.append(ic('question'), el('span', '', 'Freehand has a question'));
    c.append(head, el('div', 'md', renderMarkdown(ev.question)));
    const act = el('div', 'actions');
    const inp = el('input'); inp.placeholder = 'Your answer'; inp.setAttribute('aria-label', 'Your answer');
    const go = el('button', 'btn btn-primary', 'Reply'); go.type = 'button';
    const send = () => { if (inp.value.trim()) respond(ev.id, inp.value.trim()); };
    go.addEventListener('click', send);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    act.append(inp, go);
    c.append(act);
    setTimeout(() => inp.focus(), 50);
    return c;
  }
  function respond(id, value) { return api(`/tasks/${state.current}/respond`, { method: 'POST', body: { id, value } }).catch((e) => toast(e.message, { error: true })); }

  function fileKind(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { glb: '3D model', gltf: '3D model', obj: '3D model', fbx: '3D model', stl: '3D model', md: 'Markdown', txt: 'Text', csv: 'CSV', json: 'JSON', html: 'Web page or game', py: 'Python', js: 'JavaScript', png: 'Image', jpg: 'Image', svg: 'SVG' }[ext] || ext.toUpperCase() || 'File';
  }
  /* Sources, shown the way Claude shows them: site chips in the text and a list under the answer. */
  const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const siteName = (u) => { const h = siteOf(u).split('.'); return h.length > 1 ? h[h.length - 2] : h[0]; };
  function siteIcon(u) {
    const img = el('img', 'site-icon');
    img.alt = ''; img.width = img.height = 14; img.loading = 'lazy';
    img.src = `/api/favicon?domain=${encodeURIComponent(siteOf(u))}`;
    img.addEventListener('error', () => img.replaceWith(ic('globe', 'ic site-icon')), { once: true });
    return img;
  }
  function citeLinks(body, sources) {
    const known = new Map(sources.map((x) => [x.url, x]));
    for (const a of body.querySelectorAll('a[href]')) {
      const src = known.get(a.getAttribute('href'));
      if (!src) continue;
      a.className = 'cite';
      a.title = src.title || siteOf(src.url);
      a.textContent = '';
      a.append(siteIcon(src.url), document.createTextNode(siteName(src.url)));
    }
  }
  function sourcesBlock(sources) {
    const d = el('details', 'sources');
    const sum = el('summary');
    const stack = el('span', 'icon-stack');
    for (const x of sources.slice(0, 4)) stack.append(siteIcon(x.url));
    sum.append(stack, document.createTextNode(`${sources.length} source${sources.length === 1 ? '' : 's'}`));
    const list = el('ol', 'source-list');
    for (const x of sources) {
      const li = el('li');
      const a = el('a'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const txt = el('span', 'grow'); txt.append(el('b', '', esc(x.title || siteOf(x.url))), el('small', '', esc(siteOf(x.url))));
      a.append(siteIcon(x.url), txt);
      li.append(a);
      list.append(li);
    }
    d.append(sum, list);
    return d;
  }

  function finalBlock(ev) {
    const c = el('div', 'final');
    const page = (ev.files || []).find(isPage);
    if (page) { state.playPath = page; state.playNonce++; if (state.panelTab === 'play') renderPanel(); }
    const body = el('div', 'msg-ai md', renderMarkdown(ev.message));
    c.append(body);
    if (ev.sources && ev.sources.length) { citeLinks(body, ev.sources); c.append(sourcesBlock(ev.sources)); }
    if (ev.files && ev.files.length) {
      const box = el('div', 'files');
      for (const f of ev.files) {
        if (isPage(f) || isModel(f)) {
          const card = el('div', 'made-file');
          const txt = el('span', 'grow'); txt.append(el('b', '', esc(f)), el('small', '', fileKind(f)));
          const play = el('button', 'btn btn-primary', isModel(f) ? 'View' : 'Play'); play.type = 'button';
          play.addEventListener('click', () => openPlay(f));
          const dl = el('a', 'icon-btn'); dl.href = fileUrl(f, true); dl.title = 'Download'; dl.setAttribute('aria-label', `Download ${f}`); dl.append(ic('download'));
          card.append(ic(isModel(f) ? 'cube' : 'game-controller'), txt, play, dl);
          box.append(card);
          continue;
        }
        const a = el('a', 'made-file');
        a.href = fileUrl(f, true);
        const txt = el('span', ''); txt.append(el('b', '', esc(f)), el('small', '', fileKind(f) + ' · Download'));
        a.append(ic(/\.(py|js|html|json)$/.test(f) ? 'file-code' : 'file-text'), txt);
        box.append(a);
      }
      c.append(box);
    }
    const done = el('div', 'done-row'); done.append(ic('check-circle'), document.createTextNode('Task done'));
    const foot = el('div', 'final-foot'); foot.append(done, msgActions({ copy: ev.message, retry: state.lastUser }));
    c.append(foot);
    return c;
  }

  /* ---------- Message actions: copy, edit, retry ---------- */
  function actionBtn(iconName, label, onClick, cls = '') {
    const b = el('button', 'icon-btn ' + cls); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.append(ic(iconName));
    b.addEventListener('click', onClick);
    return b;
  }
  // copy: text to copy; retry: the user event to run again; edit: the user event to edit in place.
  function msgActions({ copy, retry, edit, bubble }) {
    const row = el('div', 'msg-actions');
    if (copy !== undefined) {
      const b = actionBtn('copy', 'Copy', async () => {
        try { await navigator.clipboard.writeText(copy); } catch { return toast('Could not copy', { error: true }); }
        setIcon(b, 'check');
        setTimeout(() => setIcon(b, 'copy'), 1200);
      });
      row.append(b);
    }
    if (edit) row.append(actionBtn('pencil-simple', 'Edit', () => editMessage(edit, bubble, row), 'needs-idle'));
    if (retry) row.append(actionBtn('arrow-clockwise', 'Retry', () => rewind(retry.seq, retry.text), 'needs-idle'));
    return row;
  }
  function userMessage(ev) {
    const wrap = el('div', 'user-turn');
    const bubble = el('div', 'msg-user', esc(ev.text));
    wrap.append(bubble, msgActions({ copy: ev.text, edit: ev, retry: ev, bubble }));
    return wrap;
  }
  function editMessage(ev, bubble, row) {
    const box = el('div', 'msg-edit');
    const ta = el('textarea'); ta.value = ev.text; ta.rows = Math.min(10, ev.text.split('\n').length + 1); ta.setAttribute('aria-label', 'Edit message');
    const bar = el('div', 'msg-edit-bar');
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    const send = el('button', 'btn btn-primary', 'Send'); send.type = 'button';
    bar.append(cancel, send);
    box.append(ta, bar);
    bubble.hidden = true; row.hidden = true;
    bubble.after(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const close = () => { box.remove(); bubble.hidden = false; row.hidden = false; };
    const go = () => { const t = ta.value.trim(); if (!t) return; close(); rewind(ev.seq, t); };
    cancel.addEventListener('click', close);
    send.addEventListener('click', go);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter' && !e.isComposing) {
        const ctrlMode = state.settings && state.settings.ui.enterSends === 'ctrl';
        if (ctrlMode ? e.ctrlKey || e.metaKey : !e.shiftKey) { e.preventDefault(); go(); }
      }
    });
  }
  // Cuts the chat back to the message at `seq` and runs `text` from there; the timeline is replayed.
  async function rewind(seq, text) {
    if (state.running || !state.current) return;
    const id = state.current;
    try {
      await api(`/tasks/${id}/rewind`, { method: 'POST', body: { seq, text } });
      openTask(id);
    } catch (e) { toast(e.message, { error: true }); }
  }

  /* ---------- Composer ---------- */
  async function submit(text) {
    text = text.trim();
    if (!text || state.running) return;
    if (state.attach.some((a) => !a.path)) return toast('Wait for the files to finish uploading');
    if (state.attach.length) text += `\n\nAttached files (in the workspace): ${state.attach.map((a) => a.path).join(', ')}`;
    $('#input').value = '';
    state.attach = [];
    renderAttachments();
    autosize();
    try {
      if (!state.current && state.draft) {
        const id = state.draft;
        state.draft = null;
        await api(`/tasks/${id}/message`, { method: 'POST', body: { text } });
        await loadTasks();
        openTask(id);
      } else if (!state.current) {
        const t = await api('/tasks', { method: 'POST', body: { text } });
        await loadTasks();
        openTask(t.id);
      } else {
        await api(`/tasks/${state.current}/message`, { method: 'POST', body: { text } });
      }
    } catch (e) { toast(e.message, { error: true }); }
  }
  /* ---------- Attachments: models, images, sounds the agent can use ---------- */
  async function attachFiles(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    try {
      const id = state.current || state.draft || (state.draft = (await api('/tasks', { method: 'POST', body: {} })).id);
      for (const file of files) {
        const item = { name: file.name, path: null };
        state.attach.push(item);
        renderAttachments();
        try {
          const res = await fetch(`/api/tasks/${id}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || res.statusText);
          item.path = j.path;
          if (isModel(j.path)) { state.playPath = j.path; state.playNonce++; }
        } catch (e) {
          state.attach = state.attach.filter((a) => a !== item);
          toast(`Could not attach ${file.name}: ${e.message}`, { error: true });
        }
        renderAttachments();
      }
      if (state.panelTab === 'files' || state.panelTab === 'play') renderPanel();
    } catch (e) { toast(e.message, { error: true }); }
  }
  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    box.hidden = !state.attach.length;
    for (const a of state.attach) {
      const chip = el('span', 'attach-chip' + (a.path ? '' : ' uploading'));
      chip.append(ic(isModel(a.name) ? 'cube' : 'file'), el('span', 'nm', esc(a.name)));
      if (!a.path) chip.append(el('small', '', 'Uploading'));
      else {
        if (isModel(a.path) && state.current) {
          const v = el('button', 'icon-btn'); v.type = 'button'; v.title = 'View model'; v.setAttribute('aria-label', `View ${a.name}`); v.append(ic('cube'));
          v.addEventListener('click', () => openPlay(a.path));
          chip.append(v);
        }
        const x = el('button', 'icon-btn'); x.type = 'button'; x.title = 'Remove from this message'; x.setAttribute('aria-label', `Remove ${a.name}`); x.append(ic('x'));
        x.addEventListener('click', () => { state.attach = state.attach.filter((b) => b !== a); renderAttachments(); });
        chip.append(x);
      }
      box.append(chip);
    }
  }

  /* Slash commands from Claude plugins: typing "/" lists them above the message box. */
  let commands = null;
  let slash = { items: [], sel: 0 };
  async function slashMenu() {
    const v = $('#input').value;
    const m = /^\/([\w:.-]*)$/.exec(v);
    const menu = $('#slash-pop');
    if (!m) { menu.hidden = true; slash.items = []; return; }
    if (!commands) commands = (await api('/commands').catch(() => ({ commands: [] }))).commands;
    const q = m[1].toLowerCase();
    slash.items = commands.filter((c) => c.name.toLowerCase().includes(q.split(':').pop())).slice(0, 8);
    slash.sel = 0;
    menu.innerHTML = '';
    if (!slash.items.length) { menu.hidden = true; return; }
    menu.append(el('div', 'menu-label', 'Commands from your Claude plugins'));
    slash.items.forEach((c, i) => {
      const it = menuItem(null, '/' + c.name, c.description || c.plugin, () => pickSlash(i));
      it.tabIndex = -1;
      it.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the message box
      menu.append(it);
    });
    markSlash();
    menu.hidden = false;
  }
  function markSlash() { $$('#slash-pop .menu-item').forEach((it, i) => it.toggleAttribute('data-active', i === slash.sel)); }
  function pickSlash(i) {
    const c = slash.items[i];
    if (!c) return;
    const input = $('#input');
    input.value = `/${c.name} `;
    $('#slash-pop').hidden = true; slash.items = [];
    autosize(); input.focus();
  }
  function slashKey(e) {
    if (!slash.items.length || $('#slash-pop').hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slash.sel = (slash.sel + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length; markSlash(); return true; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSlash(slash.sel); return true; }
    if (e.key === 'Escape') { $('#slash-pop').hidden = true; slash.items = []; return true; }
    return false;
  }

  function updateSend() { $('#send').disabled = !$('#input').value.trim(); }
  function autosize() { updateSend(); const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(240, i.scrollHeight) + 'px'; }

  function renderModelChip() {
    const s = state.settings;
    if (!s) return;
    const a = activeProvider();
    const chip = $('#model-chip');
    chip.innerHTML = '';
    chip.append(ic(s.active === 'ollama' ? 'cpu' : 'globe'), el('span', '', esc(a.model || 'Choose a model')), ic('caret-down'));
    $('#profile-model').textContent = `${a.model || 'No model'} · ${providerName(s.active)}`;
    const effort = $('#effort-chip');
    effort.innerHTML = '';
    effort.append(ic('gauge'), el('span', '', esc(effortLabel(s.effort))), ic('caret-down'));
    const safety = $('#safety-chip');
    const ask = s.approval === 'ask';
    safety.innerHTML = '';
    safety.classList.toggle('warn', !ask);
    safety.append(ic(ask ? 'shield-check' : 'warning'), el('span', '', ask ? 'Ask first' : 'Auto-run'));
  }
  function fillModelMenu(menu) {
    const s = state.settings;
    menu.append(el('div', 'menu-label', 'Provider'));
    for (const id of Object.keys(s.providers)) {
      const p = s.providers[id];
      menu.append(menuItem(id === 'ollama' ? 'cpu' : 'globe', providerName(id), p.model || 'No model set', () => patchSettings({ active: id }, `Using ${providerName(id)}`), { checked: id === s.active }));
    }
    menu.append(el('div', 'menu-sep'));
    const box = el('div', 'menu-field');
    const a = activeProvider();
    const input = el('input'); input.value = a.model; input.placeholder = 'Model name'; input.setAttribute('list', 'pop-models'); input.setAttribute('aria-label', 'Model name');
    const dl = el('datalist'); dl.id = 'pop-models';
    const load = el('button', 'btn', 'List'); load.type = 'button'; load.title = 'List the models this provider offers';
    const hint = el('div', 'hint', 'Type a model name, or press List.');
    const save = () => { const v = input.value.trim(); if (v && v !== a.model) patchSettings({ providers: { [s.active]: { model: v } } }, `Model set to ${v}`); };
    load.addEventListener('click', async (e) => {
      e.stopPropagation();
      load.disabled = true;
      const r = await api('/models?provider=' + s.active).catch((err) => ({ models: [], error: err.message }));
      dl.innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
      hint.textContent = r.error ? r.error : `${r.models.length} models. Click the box to pick one.`;
      load.disabled = false; input.focus();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); closeMenus(); } });
    const row = el('div', 'row'); row.append(input, load);
    box.append(el('div', 'menu-label', 'Model for ' + esc(providerName(s.active))), row, dl, hint);
    menu.append(box, el('div', 'menu-sep'));
    menu.append(menuItem('gear', 'Provider settings', 'Addresses, API keys, fallbacks', () => openSettings('models')));
  }
  const EFFORTS = [
    ['low', 'Low', 'Fastest. Short plans, one source, few checks'],
    ['medium', 'Medium', 'Quick, with a second source for key facts'],
    ['high', 'High', 'The default. Checks sources and tests what it makes'],
    ['max', 'Max', 'Slowest. Confirms everything and reviews its work'],
  ];
  const effortLabel = (v) => (EFFORTS.find((e) => e[0] === v) || EFFORTS[2])[1];
  function fillEffortMenu(menu) {
    menu.append(el('div', 'menu-label', 'Effort'));
    for (const [v, l, sub] of EFFORTS) menu.append(menuItem(null, l, sub, () => patchSettings({ effort: v }, `Effort: ${l}`), { checked: state.settings.effort === v }));
  }
  function fillSafetyMenu(menu) {
    const s = state.settings;
    menu.append(menuItem('shield-check', 'Ask me first', 'Freehand shows each shell or Python command and waits for Allow', () => patchSettings({ approval: 'ask' }), { checked: s.approval === 'ask' }));
    menu.append(menuItem('warning', 'Run without asking', 'Faster, but a wrong command runs before you see it', () => patchSettings({ approval: 'auto' }), { checked: s.approval === 'auto' }));
  }

  /* ---------- Settings page ---------- */
  const SECTIONS = [
    ['general', 'General', 'user-circle'],
    ['models', 'Models', 'cpu'],
    ['capabilities', 'Capabilities', 'puzzle-piece'],
    ['connectors', 'Connectors', 'plugs-connected'],
    ['plugins', 'Plugins', 'puzzle-piece'],
    ['memory', 'Memory', 'brain'],
    ['shortcuts', 'Shortcuts', 'keyboard'],
    ['about', 'About', 'info'],
  ];
  async function openSettings(section) {
    if (section) state.section = section;
    closeMenus();
    await loadSettings().catch(() => {});
    if (!state.info) state.info = await api('/info').catch(() => null);
    showView('settings');
    renderSettings();
  }
  function closeSettings() { if (state.current) openTask(state.current); else newTask(); }
  function renderSettings() {
    const nav = $('#settings-nav');
    nav.innerHTML = '';
    for (const [id, label, iconName] of SECTIONS) {
      const b = el('button'); b.type = 'button';
      b.setAttribute('aria-current', state.section === id ? 'page' : 'false');
      b.append(ic(iconName), document.createTextNode(label));
      b.addEventListener('click', () => { state.section = id; renderSettings(); });
      nav.append(b);
    }
    const body = $('#settings-body');
    body.innerHTML = '';
    ({ general: settingsGeneral, models: settingsModels, capabilities: settingsCapabilities, connectors: settingsConnectors, plugins: settingsPlugins, memory: settingsMemory, shortcuts: settingsShortcuts, about: settingsAbout })[state.section](body);
  }

  const section = (title, hint) => { const s = el('section'); s.append(el('h2', '', esc(title))); if (hint) s.append(el('p', 'hint', esc(hint))); return s; };
  function settingRow(title, about, control, full) {
    const r = el('div', 'setting' + (full ? ' setting-full' : ''));
    const t = el('div'); t.append(el('b', '', esc(title))); if (about) t.append(el('p', '', esc(about)));
    r.append(t);
    if (control) { const c = el('div', 'stack-sm'); [].concat(control).forEach((x) => c.append(x)); r.append(c); }
    return r;
  }
  function segmented(label, options, value, onChange) {
    const g = el('div', 'segmented'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
    for (const [v, t] of options) {
      const b = el('button', '', esc(t)); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(v === value));
      b.addEventListener('click', () => { $$('button', g).forEach((x) => x.setAttribute('aria-checked', String(x === b))); onChange(v); });
      g.append(b);
    }
    return g;
  }
  function toggleRow(title, about, checked, onChange) {
    const r = el('div', 'toggle-row');
    const t = el('div'); t.append(el('b', '', esc(title))); if (about) t.append(el('p', '', esc(about)));
    const sw = el('button', 'switch', '<span></span>'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(checked)); sw.setAttribute('aria-label', title);
    sw.addEventListener('click', () => { const v = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(v)); onChange(v); });
    r.append(t, sw);
    return r;
  }
  /** A text field that saves when you leave it. */
  function textField(label, value, placeholder, onSave, type = 'text') {
    const i = el('input'); i.type = type; i.value = value || ''; i.placeholder = placeholder || ''; i.setAttribute('aria-label', label); i.spellcheck = false; i.autocomplete = 'off';
    i.addEventListener('change', () => { if (i.value.trim() !== (value || '')) { value = i.value.trim(); onSave(value); } });
    return i;
  }
  /** A key the page can set but never read back. */
  function keyField(label, saved, onSave, onRemove) {
    const wrap = [];
    const i = el('input'); i.type = 'password'; i.autocomplete = 'off'; i.setAttribute('aria-label', label);
    i.placeholder = saved ? 'Saved. Paste a new key to replace it' : 'Paste your key';
    const row = el('div', 'row');
    const save = el('button', 'btn', 'Save key'); save.type = 'button'; save.disabled = true;
    i.addEventListener('input', () => { save.disabled = !i.value.trim(); });
    save.addEventListener('click', () => { onSave(i.value.trim()); i.value = ''; save.disabled = true; });
    row.append(save);
    if (saved && onRemove) { const rm = el('button', 'btn btn-quiet', 'Remove'); rm.type = 'button'; rm.addEventListener('click', onRemove); row.append(rm); }
    wrap.push(i, row);
    return wrap;
  }

  function settingsGeneral(body) {
    const ui = state.settings.ui;
    const look = section('Appearance');
    const themes = el('div', 'themes'); themes.setAttribute('role', 'radiogroup'); themes.setAttribute('aria-label', 'Color mode');
    for (const [v, label] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match system']]) {
      const b = el('button', 'theme-opt'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(ui.theme === v));
      const sw = el('span', 'theme-swatch sw-' + v); if (v !== 'system') sw.append(el('i'), el('em', '', '<span></span><span></span><span></span>'));
      b.append(sw, document.createTextNode(label));
      b.addEventListener('click', () => { $$('.theme-opt', themes).forEach((x) => x.setAttribute('aria-checked', String(x === b))); patchSettings({ ui: { theme: v } }); });
      themes.append(b);
    }
    look.append(settingRow('Color mode', null, themes, true));
    look.append(settingRow('Chat font', 'The font for messages.', segmented('Chat font', [['sans', 'Default'], ['serif', 'Serif'], ['system', 'System'], ['mono', 'Mono']], ui.chatFont || 'sans', (v) => patchSettings({ ui: { chatFont: v } }))));
    look.append(settingRow('Interface font', 'Leave empty for IBM Plex Sans. To use another, type its name as your font list shows it.', textField('Interface font', ui.font, 'IBM Plex Sans', (v) => patchSettings({ ui: { font: v } }))));
    look.append(settingRow('Code font', 'For terminals, files and code.', textField('Code font', ui.monoFont, 'IBM Plex Mono', (v) => patchSettings({ ui: { monoFont: v } }))));
    look.append(toggleRow('Reduce motion', 'Turns off springs and other movement in Freehand.', !!ui.reduceMotion, (v) => patchSettings({ ui: { reduceMotion: v } })));
    const typing = section('Typing');
    const hint = el('p', 'hint', ui.enterSends === 'ctrl' ? 'Enter starts a new line.' : 'Shift Enter starts a new line.');
    typing.append(settingRow('Send messages with', null, [segmented('Send messages with', [['enter', 'Enter'], ['ctrl', 'Ctrl Enter']], ui.enterSends || 'enter', (v) => { hint.textContent = v === 'ctrl' ? 'Enter starts a new line.' : 'Shift Enter starts a new line.'; patchSettings({ ui: { enterSends: v } }); }), hint]));
    body.append(look, typing);
  }

  function settingsModels(body) {
    const s = state.settings;
    const ids = Object.keys(s.providers);
    const top = section('Model', 'Freehand sends every request to the active provider. When it hits a rate limit or can\'t connect, it tries the fallbacks in order.');
    const active = el('select'); active.setAttribute('aria-label', 'Active provider');
    for (const id of ids) { const o = el('option', '', esc(state.presets[id].label)); o.value = id; active.append(o); }
    active.value = s.active;
    active.addEventListener('change', () => patchSettings({ active: active.value }, `Using ${providerName(active.value)}`).then(renderSettings));
    top.append(settingRow('Active provider', null, active));
    const fb = el('div', 'stack-sm');
    for (const id of ids.filter((x) => x !== s.active)) {
      fb.append(toggleRow(providerName(id), s.providers[id].model || 'No model set', s.fallback.includes(id), (v) => {
        const next = state.settings.fallback.filter((x) => x !== id);
        if (v) next.push(id);
        patchSettings({ fallback: next });
      }));
    }
    top.append(settingRow('Fallbacks', 'Used only when the active provider fails.', null, true), fb);
    body.append(top);
    body.append(localModels());

    const list = section('Providers', 'Ollama runs models on this computer and nothing leaves it. The others send your task and Freehand\'s tool results to that company. Their free tiers have rate limits.');
    for (const id of ids) {
      const p = s.providers[id], pre = state.presets[id];
      const d = el('details', 'provider');
      if (id === s.active) d.open = true;
      const sum = el('summary');
      const g = el('span', 'grow'); g.append(el('b', '', esc(pre.label)), el('small', '', esc(p.model || 'No model set')));
      const tag = el('span', 'tag');
      if (id === s.active) { tag.dataset.tone = 'ok'; tag.append(el('span', 'dot'), document.createTextNode('Active')); }
      else if (pre.needsKey && !p.hasKey) tag.textContent = 'Needs a key';
      else if (p.hasKey) tag.textContent = 'Key saved';
      sum.append(ic(id === 'ollama' ? 'cpu' : 'globe'), g, tag);
      const b = el('div', 'provider-body');
      b.append(el('p', 'hint', esc(pre.help)));
      b.append(settingRow('Address', null, textField('Address', p.baseUrl, pre.baseUrl || 'https://example.com/v1', (v) => patchSettings({ providers: { [id]: { baseUrl: v } } }))));
      const model = textField('Model', p.model, pre.model || 'model name', (v) => patchSettings({ providers: { [id]: { model: v } } }));
      const dl = el('datalist'); dl.id = 'models-' + id; model.setAttribute('list', dl.id);
      const listBtn = el('button', 'btn', 'List models'); listBtn.type = 'button';
      const listHint = el('p', 'hint');
      listBtn.addEventListener('click', async () => {
        listBtn.disabled = true;
        const r = await api('/models?provider=' + id).catch((e) => ({ models: [], error: e.message }));
        dl.innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
        listHint.textContent = r.error ? r.error : `${r.models.length} models. Click the box to pick one.`;
        listBtn.disabled = false;
      });
      b.append(settingRow('Model', null, [model, dl, listBtn, listHint]));
      if (id !== 'ollama' || p.hasKey) {
        b.append(settingRow('API key', pre.needsKey ? 'Required.' : 'Optional.', keyField(`${pre.label} API key`, p.hasKey,
          (v) => patchSettings({ providers: { [id]: { apiKey: v } } }, 'Key saved').then(renderSettings),
          () => patchSettings({ providers: { [id]: { clearKey: true } } }, 'Key removed').then(renderSettings))));
      }
      const mode = el('select'); mode.setAttribute('aria-label', 'Tool calling');
      for (const [v, t] of [['auto', 'Automatic'], ['native', 'Native tool calls'], ['json', 'JSON replies (small local models)']]) { const o = el('option', '', t); o.value = v; mode.append(o); }
      mode.value = p.toolMode;
      mode.addEventListener('change', () => patchSettings({ providers: { [id]: { toolMode: mode.value } } }));
      b.append(settingRow('Tool calling', 'How the model asks for tools. Automatic picks per model.', mode));
      d.append(sum, b);
      list.append(d);
    }
    body.append(list);
  }

  /* Local AI models: Ollama downloads, your own .gguf files, and Freehand's own model. */
  const gb = (n) => (n ? `${(n / 1024 ** 3).toFixed(1)} GB` : '');
  function localModels() {
    const sec = section('Local AI models', 'Models in Ollama run on this computer. Download one, bring your own .gguf file, or build Freehand\'s own model.');
    const box = el('div', 'stack-sm');
    sec.append(box);
    const load = async () => {
      box.innerHTML = '';
      box.append(el('p', 'hint', 'Checking Ollama'));
      const st = await api('/ollama').catch((e) => ({ running: false, error: e.message, models: [] }));
      box.innerHTML = '';
      if (!st.running) {
        const retry = el('button', 'btn', 'Check again'); retry.type = 'button'; retry.addEventListener('click', load);
        box.append(el('p', 'hint', esc(`Ollama is not running (${st.error || 'no answer'}). Install it from ollama.com and start it, then check again.`)), retry);
        return;
      }
      const cur = state.settings.active === 'ollama' ? state.settings.providers.ollama.model : '';
      const use = (name) => patchSettings({ active: 'ollama', providers: { ollama: { model: name } } }, `Using ${name}`).then(renderSettings);

      // Freehand's own model
      const own = el('div', 'own-model');
      const head = el('div', 'own-head');
      const t = el('span', 'grow'); t.append(el('b', '', esc(st.freehandName)), el('small', '', st.freehand ? 'Installed' : 'Not built yet'));
      head.append(ic('lightning'), t);
      own.append(head, el('p', 'hint', 'Freehand\'s own model. It is tuned to build games, make 3D models with make_model, use the models you attach, and play-test its work until it runs. It is built on a model you choose. Small models fit small graphics cards.'));
      const base = el('select'); base.setAttribute('aria-label', 'Base model');
      for (const b of st.recommended || []) { const o = el('option', '', esc(b + (st.bases.includes(b) ? '' : '  (downloads first)'))); o.value = b; base.append(o); }
      if (st.bases[0]) base.value = st.bases[0];
      const make = el('button', 'btn btn-primary', st.freehand ? 'Rebuild' : 'Build it'); make.type = 'button';
      const prog = el('div', 'job'); prog.hidden = true;
      make.addEventListener('click', async () => {
        make.disabled = true;
        const ok = await runJob('/ollama/freehand', { base: base.value }, prog);
        make.disabled = false;
        if (ok) { toast(`${st.freehandName} is ready`); await use(st.freehandName); }
      });
      const row = el('div', 'row-actions'); row.append(base, make);
      if (st.freehand && cur.replace(/:latest$/, '') !== st.freehandName) { const u = el('button', 'btn', 'Use it'); u.type = 'button'; u.addEventListener('click', () => use(st.freehandName)); row.append(u); }
      own.append(row, prog);
      box.append(own);

      // Installed models
      const list = el('div', 'list model-list');
      for (const m of st.models) {
        const r = el('div', 'model-row');
        const g = el('span', 'grow'); g.append(el('b', '', esc(m.name)), el('small', '', esc([m.params, m.family, gb(m.size)].filter(Boolean).join(' · '))));
        r.append(ic('cpu'), g);
        if (/embed|bert/i.test(`${m.name} ${m.family}`)) r.append(el('span', 'tag', 'Embeddings only'));
        else if (cur === m.name || cur === m.name.replace(/:latest$/, '')) { const tag = el('span', 'tag'); tag.dataset.tone = 'ok'; tag.append(el('span', 'dot'), document.createTextNode('In use')); r.append(tag); }
        else { const u = el('button', 'btn', 'Use'); u.type = 'button'; u.addEventListener('click', () => use(m.name)); r.append(u); }
        list.append(r);
      }
      box.append(settingRow('On this computer', st.models.length ? `${st.models.length} models in Ollama ${st.version || ''}.` : 'No models yet.', null, true), list);

      // Download
      const name = textField('Model to download', '', 'qwen3:8b', () => {});
      const dl = el('button', 'btn', 'Download'); dl.type = 'button';
      const dlProg = el('div', 'job'); dlProg.hidden = true;
      dl.addEventListener('click', async () => {
        const v = name.value.trim();
        if (!v) return name.focus();
        dl.disabled = true;
        const ok = await runJob('/ollama/pull', { model: v }, dlProg);
        dl.disabled = false;
        if (ok) { toast(`Downloaded ${v}`); load(); }
      });
      box.append(settingRow('Download a model', 'Any name from ollama.com/library, like qwen3:8b or qwen2.5-coder:7b.', [name, dl, dlProg]));

      // Import a .gguf
      const file = el('input'); file.type = 'file'; file.accept = '.gguf'; file.hidden = true;
      const pickFile = el('button', 'btn', 'Choose a .gguf file'); pickFile.type = 'button';
      pickFile.addEventListener('click', () => file.click());
      const nm = textField('Name for the model', '', 'my-model', () => {});
      file.addEventListener('change', () => {
        if (!file.files[0]) return;
        pickFile.textContent = file.files[0].name;
        if (!nm.value) nm.value = file.files[0].name.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      });
      const imp = el('button', 'btn', 'Import'); imp.type = 'button';
      const impProg = el('div', 'job'); impProg.hidden = true;
      imp.addEventListener('click', async () => {
        if (!file.files[0]) return file.click();
        if (!nm.value.trim()) return nm.focus();
        imp.disabled = true;
        const ok = await runJob(`/ollama/import?name=${encodeURIComponent(nm.value.trim())}`, file.files[0], impProg);
        imp.disabled = false;
        if (ok) { toast(`Imported ${nm.value.trim()}`); load(); }
      });
      box.append(settingRow('Bring your own model', 'A .gguf file you downloaded or trained. Freehand copies it into Ollama.', [file, pickFile, nm, imp, impProg]));
    };
    load();
    return sec;
  }

  /** Runs a long Ollama job and shows its progress. body is JSON, or a File to upload. Resolves true on success. */
  async function runJob(path, body, box) {
    box.hidden = false;
    box.innerHTML = '';
    const label = el('span', 'grow', 'Starting');
    const bar = el('progress'); bar.max = 1; bar.removeAttribute('value');
    box.append(bar, label);
    try {
      const isFile = body instanceof Blob;
      const res = await fetch('/api' + path, { method: 'POST', headers: isFile ? {} : { 'content-type': 'application/json' }, body: isFile ? body : JSON.stringify(body) });
      if (!res.ok || !res.body) { let m = res.statusText; try { m = (await res.json()).error || m; } catch { /* not JSON */ } throw new Error(m); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', ok = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          if (j.done) ok = true;
          if (j.total && j.completed != null) { bar.value = j.completed / j.total; label.textContent = `${j.status || 'Working'}: ${gb(j.completed)} of ${gb(j.total)}`; }
          else if (j.status) { bar.removeAttribute('value'); label.textContent = j.status === 'success' ? 'Done' : j.status; }
        }
      }
      bar.value = 1;
      label.textContent = 'Done';
      return ok;
    } catch (e) {
      label.textContent = e.message;
      box.classList.add('fail');
      return false;
    }
  }

  function settingsCapabilities(body) {
    const s = state.settings;
    const eff = section('Effort', 'How hard Freehand works on each task. Higher effort makes longer plans, checks more sources and reviews its work, and takes longer. You can also change it from the box you type in.');
    const effHint = el('p', 'hint', (EFFORTS.find((e) => e[0] === s.effort) || EFFORTS[2])[2] + '.');
    eff.append(settingRow('Effort', null, [segmented('Effort', EFFORTS.map(([v, l]) => [v, l]), s.effort, (v) => { effHint.textContent = EFFORTS.find((e) => e[0] === v)[2] + '.'; patchSettings({ effort: v }, `Effort: ${effortLabel(v)}`); }), effHint]));
    body.append(eff);
    const safety = section('Safety', 'Freehand runs shell commands and Python on this computer.');
    safety.append(settingRow('Shell and Python commands', null, [
      segmented('Shell and Python commands', [['ask', 'Ask me first'], ['auto', 'Run without asking']], s.approval, (v) => patchSettings({ approval: v }).then(renderSettings)),
      el('p', 'hint', s.approval === 'ask' ? 'Each command waits for you to press Allow.' : 'Commands run as soon as the model writes them, including ones a web page talked it into.'),
    ]));
    const steps = el('input'); steps.type = 'number'; steps.min = '5'; steps.max = '200'; steps.value = s.maxSteps; steps.setAttribute('aria-label', 'Steps between progress checks');
    steps.addEventListener('change', () => patchSettings({ maxSteps: Number(steps.value) }));
    safety.append(settingRow('Steps between progress checks', 'After this many tool steps Freehand checks its progress. It keeps going by itself while it is still writing files or finishing plan steps, and stops only when a whole stretch changed nothing. From 5 to 200, at High effort. Low uses 40% of it, Medium 70%, Max 250%.', steps));

    const web = section('Web search', 'For the web_search tool. Search words go to the provider you pick.');
    let braveRow;
    web.append(settingRow('Provider', null, segmented('Search provider', [['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave']], s.search.provider, (v) => { braveRow.hidden = v !== 'brave'; patchSettings({ search: { provider: v } }); })));
    braveRow = settingRow('Brave Search key', 'Free tier at api.search.brave.com. Gives steadier results than DuckDuckGo.', keyField('Brave Search key', s.search.hasBraveKey, (v) => patchSettings({ search: { braveKey: v } }, 'Key saved').then(renderSettings)));
    braveRow.hidden = s.search.provider !== 'brave';
    web.append(braveRow);

    const browser = section('Browser');
    browser.append(toggleRow('Show the browser window', 'Off keeps it hidden. Freehand\'s computer panel still shows screenshots.', !s.browserHeadless, (v) => patchSettings({ browserHeadless: !v })));
    body.append(safety, web, browser);
  }

  /* Connectors: other apps' MCP servers whose tools Freehand can use (Blender, Figma...). */
  function appLogo(c) {
    const box = el('span', 'app-logo');
    const site = c.site || (c.url && !/127\.0\.0\.1|localhost/.test(c.url) ? new URL(c.url).hostname.replace(/^(mcp|api)\./, '') : '');
    if (!site) { box.append(ic('plug')); return box; }
    box.append(siteIcon(`https://${site}`));
    return box;
  }
  function fillToolsMenu(menu) {
    const list = (state.settings.connectors || []);
    menu.append(el('div', 'menu-label', 'Connectors'));
    if (!list.length) menu.append(el('div', 'menu-hint', 'No apps connected yet.'));
    for (const c of list) {
      menu.append(menuItem(null, c.name, c.enabled === false ? 'Off for every task' : 'Freehand can use it', async () => {
        try { await api('/connectors/' + c.id, { method: 'PUT', body: { enabled: c.enabled === false } }); await loadSettings(); toast(`${c.name} ${c.enabled === false ? 'on' : 'off'}`); }
        catch (e) { toast(e.message, { error: true }); }
      }, { checked: c.enabled !== false }));
    }
    menu.append(menuItem('plus', 'Add connectors', 'Linear, Notion, GitHub, Blender and more', () => openSettings('connectors')));
  }
  function connectorTag(c) {
    const tag = el('span', 'tag');
    const st = c.status || {};
    if (c.enabled === false) tag.textContent = 'Off';
    else if (st.state === 'connected') { tag.dataset.tone = 'ok'; tag.append(el('span', 'dot'), document.createTextNode(`${st.tools.length - (c.disabledTools || []).filter((n) => st.tools.some((t) => t.name === n)).length} tools`)); }
    else if (st.state === 'error' && st.needsSignIn) { tag.dataset.tone = 'bad'; tag.textContent = 'Needs sign-in'; }
    else if (st.state === 'error') { tag.dataset.tone = 'bad'; tag.textContent = 'Can\'t connect'; }
    else if (st.state === 'signing-in') tag.textContent = 'Signing in';
    else if (st.state === 'connecting') tag.textContent = 'Connecting';
    else tag.textContent = 'Connects when a task starts';
    return tag;
  }
  function settingsConnectors(body) {
    const intro = section('Connectors', 'Connect other apps so Freehand can use them: Blender to build 3D scenes and models, Figma to read your designs, Linear and Notion for your notes and to-dos. Any app with an MCP server works.');
    const box = el('div', 'stack-sm');
    intro.append(box);
    const own = section('Add your own', 'For any other app with an MCP server. Its instructions give either a command to run or an address.');
    body.append(intro, own);
    let open = new Set();
    const call = async (path, opts, msg) => {
      try { const r = await api('/connectors' + path, opts); if (msg) toast(msg); return r; }
      catch (e) { toast(e.message, { error: true }); return null; }
    };
    const draw = (r) => {
      if (!r) return;
      box.innerHTML = '';
      const have = new Set(r.connectors.map((c) => c.id));
      for (const p of r.presets.filter((x) => !have.has(x.id))) {
        const row = el('div', 'own-model');
        const head = el('div', 'own-head');
        const t = el('span', 'grow'); t.append(el('b', '', esc(p.name)), el('small', '', esc(p.help.split(/(?<=\.)\s/)[0])));
        const add = el('button', 'btn btn-primary', 'Connect'); add.type = 'button';
        let tok = null;
        if (p.token) { tok = el('input'); tok.type = 'password'; tok.autocomplete = 'off'; tok.placeholder = 'Access token'; tok.setAttribute('aria-label', `${p.name} access token`); }
        add.addEventListener('click', async () => {
          if (tok && !tok.value.trim()) return tok.focus();
          add.disabled = true;
          const x = await call('', { method: 'POST', body: { name: p.name, type: p.type, command: p.command, url: p.url, site: p.site, token: tok ? tok.value.trim() : undefined } });
          if (!x) { add.disabled = false; return; }
          open.add(x.added[0]); draw(x);
          if (p.signIn) signIn(x.added[0], p.name); else test(x.added[0]);
        });
        head.append(appLogo(p), t, add);
        row.append(head);
        if (tok) { tok.classList.add('token-input'); row.append(tok); }
        if (p.help.split(/(?<=\.)\s/).length > 1) row.append(el('p', 'hint', esc(p.help.split(/(?<=\.)\s/).slice(1).join(' '))));
        box.append(row);
      }
      const local = state.settings.active === 'ollama';
      const total = r.connectors.filter((c) => c.enabled !== false).reduce((n, c) => n + (c.status.tools || []).filter((t) => !(c.disabledTools || []).includes(t.name)).length, 0);
      if (local && total > 12) box.append(el('p', 'hint', esc(`${total} connector tools are on. Small local models pick tools better when fewer are on: open a connector and turn off the tools you don't need.`)));
      for (const c of r.connectors) {
        const d = el('details', 'provider');
        d.open = open.has(c.id);
        d.addEventListener('toggle', () => { if (d.open) open.add(c.id); else open.delete(c.id); });
        const sum = el('summary');
        const g = el('span', 'grow'); g.append(el('b', '', esc(c.name)), el('small', '', esc(c.type === 'url' ? c.url : c.command)));
        sum.append(appLogo({ ...c, site: c.site || (r.presets.find((x) => x.id === c.id) || {}).site }), g, connectorTag(c));
        const b = el('div', 'provider-body');
        const st = c.status || {};
        const put = (patch, msg) => call('/' + c.id, { method: 'PUT', body: patch }, msg).then(draw);
        b.append(toggleRow('On', 'Freehand can use this app\'s tools in every task.', c.enabled !== false, (v) => put({ enabled: v }, v ? `${c.name} on` : `${c.name} off`)));
        b.append(toggleRow('Run without asking', 'Off: Freehand asks before each action that changes something in the app. Actions that only read never ask.', !!c.trust, (v) => put({ trust: v })));
        const testBtn = el('button', 'btn', st.state === 'connected' ? 'Reconnect' : 'Connect and test'); testBtn.type = 'button';
        testBtn.addEventListener('click', () => test(c.id));
        const info = st.state === 'error' ? el('p', 'hint error-text', esc(st.error)) : el('p', 'hint', esc(st.state === 'signing-in' ? 'Finish signing in in your browser.' : st.state === 'connected' ? `Connected${st.server ? ` to ${st.server}` : ''}${c.signedIn ? ', signed in' : ''}.` : 'Not connected yet.'));
        const signBtns = [];
        if (c.type === 'url' && (c.signedIn || st.needsSignIn)) {
          const sb = el('button', c.signedIn ? 'btn btn-quiet' : 'btn btn-primary', c.signedIn ? 'Sign out' : 'Sign in'); sb.type = 'button';
          sb.addEventListener('click', () => (c.signedIn ? call(`/${c.id}/signout`, { method: 'POST' }, `Signed out of ${c.name}`).then(draw) : signIn(c.id, c.name)));
          signBtns.push(sb);
        }
        const extra = [c.env && c.env.length ? `Settings: ${c.env.join(', ')}` : '', c.headers && c.headers.length ? `Headers: ${c.headers.join(', ')}` : ''].filter(Boolean).join(' · ');
        b.append(settingRow('Connection', extra || null, [...signBtns, testBtn, info]));
        if ((st.tools || []).length) {
          const list = el('div', 'stack-sm');
          for (const t of st.tools) {
            list.append(toggleRow(t.name.replace(/_/g, ' '), t.description.split(/(?<=\.)\s/)[0].slice(0, 160), !(c.disabledTools || []).includes(t.name), (v) => {
              const next = (c.disabledTools || []).filter((n) => n !== t.name);
              if (!v) next.push(t.name);
              c.disabledTools = next;
              put({ disabledTools: next });
            }));
          }
          b.append(settingRow('Tools', 'Turn off the ones Freehand should not use.', null, true), list);
        }
        const rm = el('button', 'btn btn-quiet', 'Remove'); rm.type = 'button';
        rm.addEventListener('click', () => call('/' + c.id, { method: 'DELETE' }, `${c.name} removed`).then(draw));
        const actions = el('div', 'row-actions'); actions.append(rm);
        b.append(actions);
        d.append(sum, b);
        box.append(d);
      }
      if (!r.connectors.length) box.append(el('p', 'hint', 'No connectors yet.'));
    };
    const signIn = async (id, label) => {
      toast(`Opening the ${label} sign-in page in your browser`);
      const pending = call('');
      pending.then((r) => r && draw({ ...r, connectors: r.connectors.map((c) => (c.id === id ? { ...c, status: { ...c.status, state: 'signing-in' } } : c)) }));
      const r = await call(`/${id}/signin`, { method: 'POST' });
      draw(r);
      const c = r && r.connectors.find((x) => x.id === id);
      if (r && r.error) toast(`${label}: ${r.error}`, { error: true });
      else if (c && c.status.state === 'connected') toast(`${label} connected: ${c.status.tools.length} tools`);
      else if (c) toast(`${label}: ${c.status.error || 'could not connect'}`, { error: true });
    };
    const test = async (id) => {
      const r = await call(`/${id}/test`, { method: 'POST' });
      draw(r);
      const c = r && r.connectors.find((x) => x.id === id);
      if (c && c.status.state === 'connected') toast(`${c.name} connected: ${c.status.tools.length} tools`);
      else if (c) toast(`${c.name}: ${c.status.error || 'could not connect'}`, { error: true });
    };

    // Add your own: a command or an address, or a pasted config.
    let kind = 'command';
    const name = textField('Name', '', 'Name, like Blender', () => {});
    const cmd = textField('Command', '', 'npx -y some-mcp-server', () => {});
    const url = textField('Address', '', 'http://127.0.0.1:3845/mcp', () => {}); url.hidden = true;
    const token = el('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = 'Sign-in token, if the app gives one'; token.setAttribute('aria-label', 'Sign-in token'); token.hidden = true;
    const kinds = segmented('Connector type', [['command', 'Command'], ['url', 'Address']], kind, (v) => { kind = v; cmd.hidden = v !== 'command'; url.hidden = token.hidden = v !== 'url'; });
    const add = el('button', 'btn btn-primary', 'Add'); add.type = 'button';
    add.addEventListener('click', async () => {
      const body = { name: name.value.trim(), type: kind, command: cmd.value.trim(), url: url.value.trim(), token: token.value.trim() };
      if (!body.name) return name.focus();
      const r = await call('', { method: 'POST', body }, `${body.name} added`);
      if (r) { name.value = cmd.value = url.value = token.value = ''; open.add(r.added[0]); draw(r); test(r.added[0]); }
    });
    own.append(settingRow('Connector', 'A command starts a program on this computer. An address connects to an app that is already running.', [kinds, name, cmd, url, token, add]));
    const paste = el('textarea'); paste.rows = 5; paste.spellcheck = false; paste.setAttribute('aria-label', 'Connector config');
    paste.placeholder = '{ "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"] } } }';
    const imp = el('button', 'btn', 'Add from config'); imp.type = 'button';
    imp.addEventListener('click', async () => {
      if (!paste.value.trim()) return paste.focus();
      const r = await call('', { method: 'POST', body: { import: paste.value } });
      if (r) { paste.value = ''; toast(`Added ${r.added.length} connector${r.added.length === 1 ? '' : 's'}`); r.added.forEach((id) => open.add(id)); draw(r); r.added.forEach(test); }
    });
    own.append(settingRow('Paste a config', 'Apps often show their setup as JSON for Claude or Cursor. Paste it here as it is.', [paste, imp]));

    box.append(el('p', 'hint', 'Loading'));
    call('').then(draw);
  }

  /* Memory: the user's instructions for every task, and facts Freehand was asked to remember. */
  function settingsMemory(body) {
    const m = { on: true, instructions: '', facts: [], ...(state.settings.memory || {}) };
    const sec = section('Memory', 'What Freehand knows about you in every task, like Claude\'s memory and Manus\'s knowledge. It saves a fact when you say "remember" or tell it a lasting preference.');
    body.append(sec);
    sec.append(toggleRow('Use memory', 'Off: tasks start without your instructions or saved facts, and nothing new is saved.', m.on !== false, (v) => patchSettings({ memory: { on: v } }).then(renderSettings)));
    const ins = el('textarea'); ins.rows = 5; ins.value = m.instructions || ''; ins.placeholder = 'For example: I make PS1-style horror games in Godot. Keep answers short.'; ins.setAttribute('aria-label', 'Your instructions');
    let t = null;
    ins.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => patchSettings({ memory: { instructions: ins.value } }), 600); });
    sec.append(settingRow('Your instructions', 'Freehand follows these in every task.', [ins]));
    const list = el('div', 'stack-sm');
    if (!m.facts.length) list.append(el('p', 'hint', 'Nothing saved yet.'));
    for (const f of m.facts.slice().reverse()) {
      const row = el('div', 'fact-row');
      const x = el('button', 'icon-btn'); x.type = 'button'; x.title = 'Forget this'; x.setAttribute('aria-label', `Forget: ${f.text}`); x.append(ic('x'));
      x.addEventListener('click', () => patchSettings({ memory: { forget: f.id } }, 'Forgotten').then(renderSettings));
      row.append(el('span', 'grow', esc(f.text)), x);
      list.append(row);
    }
    sec.append(settingRow('Saved facts', `${m.facts.length} saved`, null, true), list);
    if (m.facts.length) {
      const all = el('button', 'btn btn-quiet', 'Forget everything'); all.type = 'button';
      all.addEventListener('click', () => { if (confirm('Forget every saved fact?')) patchSettings({ memory: { forgetAll: true } }, 'Memory cleared').then(renderSettings); });
      const a = el('div', 'row-actions'); a.append(all); sec.append(a);
    }
  }

  /* Plugins: Claude Code plugins and skills (skills, slash commands, MCP servers), the same files Claude uses. */
  function settingsPlugins(body) {
    const intro = section('Plugins', 'Freehand uses your Claude plugins and skills: skills give it expert instructions for a kind of task, commands run as /name in the message box, and a plugin\'s apps can be added as connectors.');
    const box = el('div', 'stack-sm');
    intro.append(box);
    const add = section('Add a plugin', 'From a GitHub repository that holds a Claude plugin (skills, commands or an .mcp.json).');
    body.append(intro, add);
    const call = async (path, opts, msg) => {
      try { const r = await api('/plugins' + path, opts); if (msg) toast(msg); return r; }
      catch (e) { toast(e.message, { error: true }); return null; }
    };
    let open = new Set();
    const draw = (r) => {
      if (!r) return;
      box.innerHTML = '';
      if (!r.plugins.length) box.append(el('p', 'hint', 'No plugins found. Plugins you install in Claude Code with /plugin, and skills in ~/.claude/skills, show up here.'));
      for (const p of r.plugins) {
        const d = el('details', 'provider');
        d.open = open.has(p.id);
        d.addEventListener('toggle', () => { if (d.open) open.add(p.id); else open.delete(p.id); });
        const sum = el('summary');
        const g = el('span', 'grow');
        const bits = [p.skills.length && `${p.skills.length} skill${p.skills.length === 1 ? '' : 's'}`, p.commands.length && `${p.commands.length} command${p.commands.length === 1 ? '' : 's'}`, p.mcp.length && `${p.mcp.length} app${p.mcp.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
        g.append(el('b', '', esc(p.name)), el('small', '', esc([p.source === 'claude' ? 'From Claude Code' : 'Added from GitHub', bits].filter(Boolean).join(' · '))));
        const tag = el('span', 'tag', p.on ? 'On' : 'Off');
        if (p.on) tag.dataset.tone = 'ok';
        sum.append(el('span', 'app-logo', ''), g, tag);
        sum.firstChild.append(ic('puzzle-piece'));
        const b = el('div', 'provider-body');
        if (p.description) b.append(el('p', 'hint', esc(p.description)));
        b.append(toggleRow('On', 'Freehand can use this plugin\'s skills and commands.', p.on, (v) => call('/' + encodeURIComponent(p.id), { method: 'PUT', body: { on: v } }, `${p.name} ${v ? 'on' : 'off'}`).then(draw)));
        if (p.skills.length) {
          const list = el('ul', 'plain-list');
          for (const k of p.skills) { const li = el('li'); li.append(el('b', '', esc(k.name)), el('small', '', esc(k.description))); list.append(li); }
          b.append(settingRow('Skills', 'Freehand loads one when a task matches it.', null, true), list);
        }
        if (p.commands.length) {
          const list = el('ul', 'plain-list');
          for (const c of p.commands) { const li = el('li'); li.append(el('b', '', esc('/' + c.name)), el('small', '', esc(c.description))); list.append(li); }
          b.append(settingRow('Commands', 'Type them in the message box.', null, true), list);
        }
        if (p.mcp.length) {
          const btns = p.mcp.map((m) => {
            const x = el('button', 'btn', `Add ${m.name} as a connector`); x.type = 'button';
            x.addEventListener('click', async () => {
              try { await api('/connectors', { method: 'POST', body: m }); toast(`${m.name} added to Connectors`); x.disabled = true; } catch (e) { toast(e.message, { error: true }); }
            });
            return x;
          });
          b.append(settingRow('Apps', 'MCP servers this plugin brings. Add them to use their tools.', btns));
        }
        if (p.hooks) b.append(el('p', 'hint', 'This plugin also has hooks. Those only run inside Claude Code.'));
        if (p.source === 'github') {
          const rm = el('button', 'btn btn-quiet', 'Remove'); rm.type = 'button';
          rm.addEventListener('click', () => call('/' + encodeURIComponent(p.id), { method: 'DELETE' }, `${p.name} removed`).then(draw));
          const actions = el('div', 'row-actions'); actions.append(rm); b.append(actions);
        }
        d.append(sum, b);
        box.append(d);
      }
    };
    const repo = textField('GitHub repository', '', 'owner/repo', () => {});
    const go = el('button', 'btn btn-primary', 'Add'); go.type = 'button';
    go.addEventListener('click', async () => {
      if (!repo.value.trim()) return repo.focus();
      go.disabled = true; go.textContent = 'Downloading';
      const r = await call('', { method: 'POST', body: { github: repo.value.trim() } });
      go.disabled = false; go.textContent = 'Add';
      if (r) { toast('Plugin added'); repo.value = ''; open.add(r.added); draw(r); }
    });
    add.append(settingRow('Repository', null, [repo, go]));
    box.append(el('p', 'hint', 'Loading'));
    call('').then(draw);
  }

  const SHORTCUTS = [
    ['Search tasks and actions', ['Ctrl', 'K']],
    ['New task', ['Ctrl', 'N']],
    ['Settings', ['Ctrl', ',']],
    ['Collapse the sidebar', ['Ctrl', 'B']],
    ['Show Freehand\'s computer', ['Ctrl', 'Shift', 'C']],
    ['New line in a message', ['Shift', 'Enter']],
    ['Close a menu or Settings', ['Esc']],
  ];
  function settingsShortcuts(body) {
    const s = section('Keyboard shortcuts');
    const g = el('div', 'shortcut-list');
    for (const [label, keys] of SHORTCUTS) {
      const k = el('span'); keys.forEach((x) => k.append(el('kbd', 'kbd', esc(x))));
      g.append(el('span', '', esc(label)), k);
    }
    s.append(g);
    body.append(s);
  }

  function settingsAbout(body) {
    const info = state.info || {};
    const s = section('Freehand');
    s.append(settingRow('Version', null, el('p', 'mono', esc(info.version || ''))));
    s.append(settingRow('Updates', 'The desktop app checks GitHub every 6 hours, downloads in the background and asks before restarting.'));
    const folder = el('p', 'code-block', esc(info.dataDir || ''));
    const btns = [folder];
    if (shell && shell.openData) { const b = el('button', 'btn'); b.type = 'button'; b.append(ic('folder-open'), document.createTextNode('Open folder')); b.addEventListener('click', () => shell.openData()); btns.push(b); }
    s.append(settingRow('Your data', 'Settings, API keys and every task\'s files. Keys sit in settings.json, readable only by your account.', btns));
    body.append(s);
    if (shell && shell.uninstall) {
      const u = section('Uninstall');
      const b = el('button', 'btn btn-danger'); b.type = 'button'; b.append(ic('trash'), document.createTextNode('Uninstall Freehand'));
      b.addEventListener('click', () => shell.uninstall());
      u.append(settingRow('Remove Freehand', 'Deletes the app, its menu entry, and all your tasks and settings. Ollama and its models stay.', b));
      body.append(u);
    }
    const l = section('Licenses');
    l.append(el('p', 'hint', 'Fonts: IBM Plex and Fraunces, SIL Open Font License. Icons: Phosphor, MIT.'));
    body.append(l);
  }

  /* ---------- Command menu ---------- */
  let cmdItems = [], cmdSel = 0;
  function openCmdk() {
    closeMenus();
    $('#cmdk').hidden = false;
    const i = $('#cmdk-input'); i.value = ''; renderCmdk(); i.focus();
  }
  function closeCmdk() { $('#cmdk').hidden = true; }
  function renderCmdk() {
    const q = $('#cmdk-input').value.trim().toLowerCase();
    const actions = [
      ['plus', 'New task', 'Ctrl N', newTask],
      ['gear', 'Settings', 'Ctrl ,', () => openSettings('general')],
      ['cpu', 'Change model', '', () => openSettings('models')],
      ...EFFORTS.map(([v, l]) => ['gauge', `Effort: ${l}`, '', () => patchSettings({ effort: v }, `Effort: ${l}`)]),
      ['desktop', 'Show Freehand\'s computer', 'Ctrl Shift C', () => { if (state.current) { if (state.view !== 'task') openTask(state.current); setPanel(true); renderPanel(); } }],
      [document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 'Switch light and dark', '', toggleTheme],
      ['keyboard', 'Keyboard shortcuts', '', () => openSettings('shortcuts')],
    ].filter(([, l]) => !q || l.toLowerCase().includes(q));
    const tasks = visibleTasks().filter((t) => !q || t.title.toLowerCase().includes(q)).slice(0, 30);
    const list = $('#cmdk-list');
    list.innerHTML = '';
    cmdItems = [];
    const push = (node, run) => { node.setAttribute('role', 'option'); cmdItems.push({ node, run }); list.append(node); };
    if (actions.length) list.append(el('div', 'menu-label', 'Actions'));
    for (const [i, l, k, run] of actions) push(menuItem(i, l, '', () => { closeCmdk(); run(); }, { keys: k || undefined }), run);
    if (tasks.length) list.append(el('div', 'menu-label', 'Tasks'));
    for (const t of tasks) push(menuItem('chat-circle-text', t.title, ago(t.updated), () => { closeCmdk(); openTask(t.id); }), () => openTask(t.id));
    if (!cmdItems.length) list.append(el('div', 'cmdk-empty', 'Nothing matches.'));
    cmdSel = 0; markCmd();
  }
  function markCmd() { cmdItems.forEach((c, i) => { if (i === cmdSel) { c.node.dataset.active = ''; c.node.scrollIntoView({ block: 'nearest' }); } else delete c.node.dataset.active; }); }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    patchSettings({ ui: { theme: next } }, null);
  }

  /* ---------- Wire up ---------- */
  const STARTERS = [
    { icon: 'game-controller', label: 'Make a game', text: 'Make a small 3D browser game where [the player does something]. Make the models it needs, play-test it, and let me play it' },
    { icon: 'magnifying-glass', label: 'Research', text: 'Research [topic] across several reliable sources and write a short report with links as report.md' },
    { icon: 'code', label: 'Write code', text: 'Write a small Python script that [does something], run it to test it, and explain how to use it' },
    { icon: 'browser', label: 'Browse the web', text: 'Open [website] in the browser, tell me what the page says, and save a screenshot' },
    { icon: 'file-code', label: 'Build a page', text: 'Build a single-page HTML site for [idea] and save it as index.html' },
  ];

  function fillProfileMenu(menu) {
    const theme = state.settings ? state.settings.ui.theme : 'system';
    menu.append(menuItem('gear', 'Settings', '', () => openSettings('general'), { keys: 'Ctrl ,' }));
    menu.append(menuItem('keyboard', 'Keyboard shortcuts', '', () => openSettings('shortcuts')));
    menu.append(el('div', 'menu-sep'), el('div', 'menu-label', 'Color mode'));
    for (const [v, l, i] of [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match system', 'desktop']]) {
      menu.append(menuItem(i, l, '', () => patchSettings({ ui: { theme: v } }, null), { checked: theme === v }));
    }
    menu.append(el('div', 'menu-sep'));
    menu.append(menuItem('info', 'About Freehand', '', () => openSettings('about')));
  }
  function fillTitleMenu(menu) {
    const t = state.tasks.find((x) => x.id === state.current);
    menu.append(menuItem('desktop', 'Show Freehand\'s computer', '', () => { setPanel(true); renderPanel(); }, { keys: 'Ctrl Shift C' }));
    menu.append(menuItem('folder-open', 'Show files', '', () => { setPanel(true); state.panelTab = 'files'; renderPanel(); }));
    if (t) menu.append(el('div', 'menu-sep'), menuItem('trash', 'Delete task', '', () => deleteTask(t), { danger: true }));
  }

  function init() {
    $('#composer-home-slot').append(document.importNode($('#composer-tpl').content, true));
    hydrateIcons();
    for (const s of STARTERS) {
      const b = el('button', 'chip'); b.type = 'button';
      b.append(ic(s.icon), document.createTextNode(s.label));
      b.addEventListener('click', () => {
        const i = $('#input'); i.value = s.text; autosize(); i.focus();
        const a = s.text.indexOf('['), z = s.text.indexOf(']');
        if (a >= 0 && z > a) i.setSelectionRange(a, z + 1);
      });
      $('#home-chips').append(b);
    }
    $('#new-task').addEventListener('click', newTask);
    $('#open-search').addEventListener('click', openCmdk);
    $('#toggle-sidebar').addEventListener('click', () => setSidebar(!$('#app').classList.contains('collapsed')));
    $('#profile-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#profile-btn'), $('#profile-menu'), fillProfileMenu); });
    $('#task-title').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#task-title'), $('#title-menu'), fillTitleMenu); });
    $('#model-chip').addEventListener('click', (e) => { e.stopPropagation(); if (state.settings) toggleMenu($('#model-chip'), $('#model-pop'), fillModelMenu); });
    $('#effort-chip').addEventListener('click', (e) => { e.stopPropagation(); if (state.settings) toggleMenu($('#effort-chip'), $('#model-pop'), fillEffortMenu); });
    $('#safety-chip').addEventListener('click', (e) => { e.stopPropagation(); if (state.settings) toggleMenu($('#safety-chip'), $('#model-pop'), fillSafetyMenu); });
    $('#tools-chip').addEventListener('click', (e) => { e.stopPropagation(); if (state.settings) toggleMenu($('#tools-chip'), $('#model-pop'), fillToolsMenu); });
    document.addEventListener('click', (e) => { if (openMenu && !e.target.closest('.menu')) closeMenus(); });
    $('#settings-close').addEventListener('click', closeSettings);

    $('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit($('#input').value); });
    $('#input').addEventListener('keydown', (e) => {
      if (slashKey(e)) return;
      if (e.key !== 'Enter' || e.isComposing) return;
      const ctrlMode = state.settings && state.settings.ui.enterSends === 'ctrl';
      if (ctrlMode ? e.ctrlKey || e.metaKey : !e.shiftKey) { e.preventDefault(); submit($('#input').value); }
    });
    $('#input').addEventListener('input', () => { autosize(); slashMenu(); });
    $('#attach').addEventListener('click', () => $('#attach-input').click());
    $('#attach-input').addEventListener('change', (e) => { attachFiles(e.target.files); e.target.value = ''; });
    $('#input').addEventListener('paste', (e) => { if (e.clipboardData && e.clipboardData.files.length) { e.preventDefault(); attachFiles(e.clipboardData.files); } });
    $('#main').addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#main').classList.add('drop'); } });
    $('#main').addEventListener('dragleave', (e) => { if (!$('#main').contains(e.relatedTarget)) $('#main').classList.remove('drop'); });
    $('#main').addEventListener('drop', (e) => { $('#main').classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length && state.view !== 'settings') { e.preventDefault(); attachFiles(e.dataTransfer.files); } });
    $('#stop').addEventListener('click', () => state.current && api(`/tasks/${state.current}/stop`, { method: 'POST' }));
    $('#thread').addEventListener('scroll', () => { $('#jump').hidden = nearBottom(); });
    $('#jump').addEventListener('click', () => { thread().scrollTop = thread().scrollHeight; });

    $('#toggle-computer').addEventListener('click', () => { setPanel(!state.panelOpen); renderPanel(); });
    $('#cp-close').addEventListener('click', () => setPanel(false));
    $$('.cp-tab').forEach((t) => t.addEventListener('click', () => { state.panelTab = t.dataset.cp; renderPanel(); }));
    $('#cp-slider').addEventListener('input', (e) => selectFrame(Number(e.target.value)));
    $('#cp-prev').addEventListener('click', () => selectFrame(state.sel - 1));
    $('#cp-next').addEventListener('click', () => selectFrame(state.sel + 1));
    $('#cp-live').addEventListener('click', () => selectFrame(state.frames.length - 1));
    $('#progress-toggle').addEventListener('click', () => {
      const list = $('#progress-list');
      list.hidden = !list.hidden;
      $('#progress-toggle').setAttribute('aria-expanded', String(!list.hidden));
    });

    $('#cmdk').addEventListener('click', (e) => { if (e.target.id === 'cmdk') closeCmdk(); });
    $('#cmdk-input').addEventListener('input', renderCmdk);
    $('#cmdk-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdSel = Math.min(cmdItems.length - 1, cmdSel + 1); markCmd(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdSel = Math.max(0, cmdSel - 1); markCmd(); }
      else if (e.key === 'Enter' && cmdItems[cmdSel]) { e.preventDefault(); cmdItems[cmdSel].node.click(); }
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (!$('#cmdk').hidden) return closeCmdk();
        if (openMenu) return closeMenus();
        if (state.view === 'settings') return closeSettings();
        return;
      }
      if (!mod) return;
      if (k === 'k') { e.preventDefault(); if ($('#cmdk').hidden) openCmdk(); else closeCmdk(); }
      else if (k === 'n') { e.preventDefault(); closeCmdk(); newTask(); }
      else if (k === ',') { e.preventDefault(); openSettings(); }
      else if (k === 'b') { e.preventDefault(); setSidebar(!$('#app').classList.contains('collapsed')); }
      else if (k === 'c' && e.shiftKey && state.current) { e.preventDefault(); if (state.view !== 'task') openTask(state.current); setPanel(!state.panelOpen); renderPanel(); }
    });

    setSidebar(store.get('collapsed') === '1');
    loadSettings().catch(() => {});
    loadTasks().catch(() => {});
    showView('home');
    setStatus('idle');
    renderPanel();
    $('#input').focus();
  }
  init();
})();
