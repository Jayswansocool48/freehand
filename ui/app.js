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
    plan: [], lastSeq: -1,
    hidden: new Set(),  // tasks deleted but still undoable
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
    state.tools.clear(); state.frames = []; state.sel = -1; state.live = true; state.plan = []; state.lastSeq = -1;
    $('#timeline').innerHTML = '';
    renderProgress();
    renderPanel();
    setStatus('idle');
  }
  function newTask() {
    state.current = null;
    resetView();
    showView('home');
    $('#input').focus();
  }
  function openTask(id) {
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
  const KIND = { browser: 'browser', shell: 'terminal', python: 'terminal', file_write: 'editor', file_edit: 'editor', file_read: 'editor', file_list: 'editor', web_search: 'search', web_fetch: 'search' };
  const KIND_NAME = { browser: 'the browser', terminal: 'the terminal', editor: 'the editor', search: 'search', text: 'a tool' };

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
    if (f.kind === 'browser') {
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

  async function renderFiles() {
    const body = $('#cp-body');
    body.innerHTML = '';
    if (!state.current) return body.append(el('div', 'cp-empty', 'Files appear here.'));
    const { tree } = await api(`/tasks/${state.current}/files`).catch(() => ({ tree: '' }));
    const lines = tree && tree !== '(empty)' ? tree.split('\n') : [];
    if (!lines.length) return body.append(el('div', 'cp-empty', 'Files Freehand makes appear here.'));
    const ul = el('ul', 'files-list');
    const stack = [];
    for (const line of lines) {
      const depth = line.match(/^ */)[0].length / 2;
      const name = line.trim().replace(/ \(\d+ bytes\)$/, '');
      stack.length = depth;
      const isDir = name.endsWith('/');
      stack[depth] = isDir ? name.slice(0, -1) : null;
      const li = el('li', isDir ? 'dir' : '');
      li.style.paddingLeft = 10 + depth * 16 + 'px';
      li.append(ic(isDir ? 'folder-open' : 'file-text'), el('span', 'nm', esc(name.replace(/\/$/, ''))));
      if (!isDir) {
        const rel = [...stack.slice(0, depth).filter(Boolean), name].join('/');
        const dl = el('a'); dl.href = fileUrl(rel, true); dl.title = 'Download'; dl.setAttribute('aria-label', `Download ${name}`); dl.append(ic('download'));
        dl.addEventListener('click', (e) => e.stopPropagation());
        li.append(dl);
        li.addEventListener('click', () => previewFile(rel));
      }
      ul.append(li);
    }
    body.append(ul);
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
      case 'user': add(el('div', 'msg-user', esc(ev.text))); break;
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
      case 'shot': { const f = [...state.frames].reverse().find((x) => x.kind === 'browser' && x.status === 'running'); if (f) { f.shot = ev.path; if (state.frames[state.sel] === f) renderPanel(); } break; }
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
      case 'approval': add(approvalCard(ev)); break;
      case 'ask': add(askCard(ev)); break;
      case 'resolved': { const c = document.querySelector(`[data-pid="${ev.id}"]`); if (c) { c.classList.add('resolved'); $$('button,input', c).forEach((b) => (b.disabled = true)); } break; }
      case 'final': add(finalBlock(ev)); break;
      case 'error': add(el('div', 'error-box', esc(ev.message))); break;
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
    return { md: 'Markdown', txt: 'Text', csv: 'CSV', json: 'JSON', html: 'HTML', py: 'Python', js: 'JavaScript', png: 'Image', jpg: 'Image', svg: 'SVG' }[ext] || ext.toUpperCase() || 'File';
  }
  function finalBlock(ev) {
    const c = el('div', 'final');
    c.append(el('div', 'msg-ai md', renderMarkdown(ev.message)));
    if (ev.files && ev.files.length) {
      const box = el('div', 'files');
      for (const f of ev.files) {
        const a = el('a', 'made-file');
        a.href = fileUrl(f, true);
        const txt = el('span', ''); txt.append(el('b', '', esc(f)), el('small', '', fileKind(f) + ' · Download'));
        a.append(ic(/\.(py|js|html|json)$/.test(f) ? 'file-code' : 'file-text'), txt);
        box.append(a);
      }
      c.append(box);
    }
    const done = el('div', 'done-row'); done.append(ic('check-circle'), document.createTextNode('Task done'));
    c.append(done);
    return c;
  }

  /* ---------- Composer ---------- */
  async function submit(text) {
    text = text.trim();
    if (!text || state.running) return;
    $('#input').value = '';
    autosize();
    try {
      if (!state.current) {
        const t = await api('/tasks', { method: 'POST', body: { text } });
        await loadTasks();
        openTask(t.id);
      } else {
        await api(`/tasks/${state.current}/message`, { method: 'POST', body: { text } });
      }
    } catch (e) { toast(e.message, { error: true }); }
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
    ({ general: settingsGeneral, models: settingsModels, capabilities: settingsCapabilities, shortcuts: settingsShortcuts, about: settingsAbout })[state.section](body);
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
    const steps = el('input'); steps.type = 'number'; steps.min = '5'; steps.max = '200'; steps.value = s.maxSteps; steps.setAttribute('aria-label', 'Most tool steps per request');
    steps.addEventListener('change', () => patchSettings({ maxSteps: Number(steps.value) }));
    safety.append(settingRow('Most tool steps per request', 'Stops a task that loops. From 5 to 200, at High effort. Low uses 40% of it, Medium 70%, Max 250%.', steps));

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
    document.addEventListener('click', (e) => { if (openMenu && !e.target.closest('.menu')) closeMenus(); });
    $('#settings-close').addEventListener('click', closeSettings);

    $('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit($('#input').value); });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const ctrlMode = state.settings && state.settings.ui.enterSends === 'ctrl';
      if (ctrlMode ? e.ctrlKey || e.metaKey : !e.shiftKey) { e.preventDefault(); submit($('#input').value); }
    });
    $('#input').addEventListener('input', autosize);
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
