/* Freehand UI. No framework, no build step. Icons are Phosphor (regular), inlined from /icons. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => escapeHtml(String(s == null ? '' : s));

  const state = {
    tasks: [], current: null, es: null, settings: null, presets: {}, running: false,
    tools: new Map(),   // tool call id -> frame
    frames: [],         // one per tool call: what the Computer panel can show
    sel: -1, live: true, panelOpen: false, panelTab: 'live',
    plan: [], lastSeq: -1,
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

  /* ---------- Appearance ---------- */
  const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim();
  function applyAppearance(ui) {
    const root = document.documentElement;
    const theme = ui.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : ui.theme || 'light';
    root.dataset.theme = theme;
    const f = clean(ui.font), m = clean(ui.monoFont);
    // "" = use the operating system's UI font (system-ui follows the Windows/GNOME/KDE font).
    if (f) root.style.setProperty('--font-sans', `"${f}", system-ui, 'Segoe UI', sans-serif`); else root.style.removeProperty('--font-sans');
    if (m) root.style.setProperty('--font-mono', `"${m}", ui-monospace, Consolas, monospace`); else root.style.removeProperty('--font-mono');
    setIcon($('#toggle-theme'), theme === 'dark' ? 'sun' : 'moon');
    // Keep the native window buttons (min / max / close) matching the app, since there is no OS title bar.
    requestAnimationFrame(() => {
      const cs = getComputedStyle(root);
      if (window.freehandShell) window.freehandShell.setChrome({ color: cs.getPropertyValue('--background').trim(), symbolColor: cs.getPropertyValue('--foreground').trim() });
    });
  }

  /* ---------- Sidebar ---------- */
  async function loadTasks() { state.tasks = (await api('/tasks')).tasks; renderTasks(); }
  function renderTasks() {
    const box = $('#task-list');
    box.innerHTML = '';
    const q = ($('#task-search').value || '').trim().toLowerCase();
    const list = state.tasks.filter((t) => !q || t.title.toLowerCase().includes(q));
    if (!list.length) box.append(el('div', 'empty-list', q ? 'No matches.' : 'Your tasks will show up here.'));
    for (const t of list) {
      const b = el('button', 'task-item' + (state.current === t.id ? ' active' : ''));
      b.append(el('span', 'dot ' + t.status), el('span', 't', esc(t.title)));
      const del = setIcon(el('span', 'del'), 'x');
      del.title = 'Delete task';
      del.addEventListener('click', async (e) => { e.stopPropagation(); if (confirm(`Delete "${t.title}" and its files?`)) { await api('/tasks/' + t.id, { method: 'DELETE' }); if (state.current === t.id) newTask(); loadTasks(); } });
      b.append(del);
      b.addEventListener('click', () => { openTask(t.id); if (innerWidth < 1000) setSidebar(false); });
      box.append(b);
    }
  }

  /* ---------- View state ---------- */
  function setHome(isHome) {
    $('#main').classList.toggle('home', isHome);
    if (isHome) setPanel(false);
  }
  function setSidebar(open) {
    state.sidebar = open;
    $('#app').classList.toggle('sidebar-closed', !open);
    $('#open-sidebar').hidden = open;
  }
  function setPanel(open) {
    state.panelOpen = open;
    $('#app').classList.toggle('panel-open', open);
    $('#app').classList.toggle('panel-closed', !open);
  }

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
    setHome(true);
    $('#task-title').textContent = 'New task';
    renderTasks();
    $('#input').focus();
  }

  function openTask(id) {
    state.current = id;
    resetView();
    setHome(false);
    renderTasks();
    const t = state.tasks.find((x) => x.id === id);
    $('#task-title').textContent = t ? t.title : 'Task';
    const es = new EventSource(`/api/tasks/${id}/events`);
    state.es = es;
    es.onmessage = (m) => { const ev = JSON.parse(m.data); if (ev.seq <= state.lastSeq) return; state.lastSeq = ev.seq; handle(ev); };
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
    $('#input').placeholder = state.running ? 'Freehand is working. Answer its questions here, or press stop.' : state.current ? 'Reply or give a follow-up...' : 'Describe a task...';
    renderProgress();
  }

  const timeline = () => $('#timeline');
  function add(node, cls = '') {
    const tl = timeline();
    const near = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 200;
    if (node.classList.contains('step-pill')) {
      // consecutive tool calls are grouped into one tidy activity block
      let group = tl.lastElementChild;
      if (!group || !group.classList.contains('activity')) { group = el('div', 'activity item'); tl.append(group); }
      group.append(node);
      if (near) tl.scrollTop = tl.scrollHeight;
      return node;
    }
    node.classList.add('item');
    if (cls) node.classList.add(cls);
    tl.append(node);
    if (near) tl.scrollTop = tl.scrollHeight;
    return node;
  }

  /* ---------- Frames (what the Computer panel replays) ---------- */
  const KIND = { browser: 'browser', shell: 'terminal', python: 'terminal', file_write: 'editor', file_edit: 'editor', file_read: 'editor', file_list: 'editor', web_search: 'search', web_fetch: 'search' };
  const KIND_NAME = { browser: 'the Browser', terminal: 'the Terminal', editor: 'the Editor', search: 'Search', text: 'a tool' };

  function addFrame(ev) {
    const frame = { id: ev.id, name: ev.name, label: ev.label, icon: ev.icon, args: ev.args || {}, kind: KIND[ev.name] || 'text', status: 'running', output: '', live: '', shot: null, pill: null };
    state.frames.push(frame);
    state.tools.set(ev.id, frame);
    return frame;
  }
  function selectFrame(i) {
    state.sel = Math.max(0, Math.min(state.frames.length - 1, i));
    state.live = state.sel === state.frames.length - 1; // viewing the newest step = following live
    for (const f of state.frames) if (f.pill) f.pill.classList.toggle('sel', f === state.frames[state.sel]);
    renderPanel();
  }

  function renderPanel() {
    const body = $('#cp-body');
    const tl = $('#cp-timeline');
    $$('.cp-tab').forEach((t) => t.classList.toggle('active', t.dataset.cp === state.panelTab));
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
      body.append(el('div', 'cp-empty', 'Freehand\'s screen: browser views, terminals and files show up here as it works.'));
      return;
    }
    const f = state.frames[state.sel];
    const running = f.status === 'running';
    if (running) status.append(el('span', 'live-dot'));
    status.append(document.createTextNode(`${running ? 'Freehand is using' : 'Freehand used'} ${KIND_NAME[f.kind]}  ·  ${state.sel + 1} / ${n}`));
    const out = f.output || f.live;
    if (f.kind === 'browser') {
      const url = (out.match(/^URL: (.*)$/m) || [])[1] || f.args.url || '';
      const bar = el('div', 'cp-bar'); bar.append(ic('globe'), document.createTextNode(url || f.label));
      body.append(bar);
      if (f.shot) { const img = el('img', 'cp-shot'); img.alt = 'Browser screenshot'; img.src = `/api/tasks/${state.current}/file?path=${encodeURIComponent(f.shot)}`; body.append(img); }
      else body.append(preBlock(out || 'Starting the browser...', 'cp-pre'));
    } else if (f.kind === 'terminal') {
      const cmd = f.name === 'python' ? f.args.code : f.args.command;
      const pre = el('pre', 'cp-pre cp-term');
      pre.append(el('span', 'cmd', f.name === 'python' ? 'python3 script.py\n' : '$ ' + esc(cmd || '') + '\n'));
      if (f.name === 'python') pre.append(document.createTextNode('\n' + (cmd || '') + '\n\n--- output ---\n'));
      pre.append(document.createTextNode(out || (running ? '...' : '')));
      body.append(pre);
    } else if (f.kind === 'editor') {
      const path = f.args.path || '.';
      const bar = el('div', 'cp-bar'); bar.append(ic('file-code'), document.createTextNode(path));
      body.append(bar);
      let text = f.args.content != null ? String(f.args.content) : f.name === 'file_edit' ? `- ${f.args.find}\n+ ${f.args.replace}\n\n${out}` : out;
      body.append(preBlock(text || '...', 'cp-pre'));
    } else {
      const bar = el('div', 'cp-bar'); bar.append(ic(f.icon || 'globe'), document.createTextNode(f.label));
      body.append(bar, preBlock(out || 'Working...', 'cp-pre'));
    }
    body.scrollTop = f.kind === 'terminal' ? body.scrollHeight : 0;
  }
  const preBlock = (text, cls) => { const p = el('pre', cls); p.textContent = text; return p; };

  /* ---------- Files tab ---------- */
  async function renderFiles() {
    const body = $('#cp-body');
    body.innerHTML = '';
    if (!state.current) return body.append(el('div', 'cp-empty', 'Files appear here.'));
    const { tree } = await api(`/tasks/${state.current}/files`).catch(() => ({ tree: '' }));
    const lines = tree && tree !== '(empty)' ? tree.split('\n') : [];
    if (!lines.length) return body.append(el('div', 'cp-empty', 'Files Freehand creates appear here.'));
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
        const dl = el('a'); dl.href = `/api/tasks/${state.current}/file?path=${encodeURIComponent(rel)}&download=1`; dl.title = 'Download'; dl.append(ic('download'));
        dl.addEventListener('click', (e) => e.stopPropagation());
        li.append(dl);
        li.addEventListener('click', () => previewFile(rel));
      }
      ul.append(li);
    }
    body.append(ul);
  }
  async function previewFile(rel) {
    const body = $('#cp-body');
    const res = await fetch(`/api/tasks/${state.current}/file?path=${encodeURIComponent(rel)}`);
    body.innerHTML = '';
    const bar = el('div', 'cp-bar'); const back = el('button', 'btn btn-sm btn-ghost', 'Back'); back.type = 'button'; back.addEventListener('click', renderFiles);
    bar.append(back, document.createTextNode(rel));
    body.append(bar);
    if ((res.headers.get('content-type') || '').startsWith('image/')) { const img = el('img', 'cp-shot'); img.src = `/api/tasks/${state.current}/file?path=${encodeURIComponent(rel)}`; img.alt = rel; body.append(img); }
    else body.append(preBlock((await res.text()).slice(0, 60000), 'cp-pre'));
  }

  /* ---------- Progress bar ---------- */
  function renderProgress() {
    const bar = $('#progress');
    const steps = state.plan;
    bar.hidden = !steps.length;
    if (!steps.length) return;
    const done = steps.filter((s) => s.status === 'done').length;
    const active = steps.find((s) => s.status === 'active');
    const finished = done === steps.length;
    const icn = $('#progress-icon');
    icn.className = finished ? 'done' : state.running ? 'spin' : '';
    setIcon(icn, finished ? 'check-circle' : 'spinner-gap');
    $('#progress-cur').textContent = finished ? 'All steps complete' : active ? active.text : steps[0].text;
    $('#progress-count').textContent = `${done} / ${steps.length}`;
    const list = $('#progress-list');
    list.innerHTML = '';
    for (const s of steps) {
      const li = el('li', s.status);
      li.append(ic(s.status === 'done' ? 'check-circle' : s.status === 'active' ? 'spinner-gap' : 'circle'), el('span', '', esc(s.text)));
      list.append(li);
    }
  }

  /* ---------- Event handling ---------- */
  function handle(ev) {
    switch (ev.type) {
      case 'status': setStatus(ev.status); loadTasks(); if (ev.status !== 'running' && state.panelTab === 'files') renderPanel(); break;
      case 'title': $('#task-title').textContent = ev.title; loadTasks(); break;
      case 'user': add(el('div', 'bubble', esc(ev.text)), 'row-user'); break;
      case 'plan': state.plan = ev.steps; renderProgress(); break;
      case 'thought': add(el('div', 'agent-text thought', esc(ev.text))); break;
      case 'step_note': if (ev.text) { const n = el('div', 'note ok'); n.append(ic('check-circle'), el('span', '', esc(ev.text))); add(n); } break;
      case 'notice': { const n = el('div', 'note'); n.append(ic('warning'), el('span', '', esc(ev.text))); add(n); break; }
      case 'tool': {
        const f = addFrame(ev);
        const pill = el('button', 'step-pill running');
        pill.type = 'button';
        pill.append(ic(ev.icon || 'code'), el('span', 'lbl', esc(ev.label)), setIcon(el('span', 'state'), 'spinner-gap'));
        pill.addEventListener('click', () => { setPanel(true); selectFrame(state.frames.indexOf(f)); });
        f.pill = pill;
        add(pill);
        if (state.frames.length === 1) setPanel(true); // open once per task; stays closed if you close it
        if (state.live) selectFrame(state.frames.length - 1); else renderPanel();
        break;
      }
      case 'terminal': { const f = [...state.frames].reverse().find((x) => x.kind === 'terminal' && x.status === 'running'); if (f) { f.live = (f.live + ev.data).slice(-20000); if (state.frames[state.sel] === f) renderPanel(); } break; }
      case 'shot': { const f = [...state.frames].reverse().find((x) => x.kind === 'browser' && x.status === 'running'); if (f) { f.shot = ev.path; if (state.frames[state.sel] === f) renderPanel(); } break; }
      case 'tool_result': {
        const f = state.tools.get(ev.id);
        if (!f) break;
        f.status = ev.ok ? 'ok' : 'fail'; f.output = ev.preview;
        f.pill.classList.remove('running'); f.pill.classList.add(ev.ok ? 'ok' : 'fail');
        setIcon($('.state', f.pill), ev.ok ? 'check-circle' : 'warning');
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
    const head = el('div', 'card-head'); head.append(ic('warning'), el('span', '', esc(ev.title) + ': Freehand is asking for permission'));
    const pre = el('pre'); pre.textContent = ev.detail;
    const act = el('div', 'actions');
    const ok = el('button', 'btn btn-primary', 'Allow'); ok.type = 'button';
    const no = el('button', 'btn btn-outline', 'Deny'); no.type = 'button';
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
    c.append(head, el('div', 'q', esc(ev.question)));
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
  function respond(id, value) { return api(`/tasks/${state.current}/respond`, { method: 'POST', body: { id, value } }); }

  function fileKind(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { md: 'Markdown', txt: 'Text', csv: 'CSV', json: 'JSON', html: 'HTML', py: 'Python', js: 'JavaScript', png: 'Image', jpg: 'Image', svg: 'SVG' }[ext] || ext.toUpperCase() || 'File';
  }
  function finalBlock(ev) {
    const c = el('div', 'final');
    c.append(el('div', 'agent-text md', renderMarkdown(ev.message)));
    if (ev.files && ev.files.length) {
      const grid = el('div', 'file-cards');
      for (const f of ev.files) {
        const a = el('a', 'file-card');
        a.href = `/api/tasks/${state.current}/file?path=${encodeURIComponent(f)}&download=1`;
        const box = el('span', 'file-ico'); setIcon(box, /\.(py|js|html|json)$/.test(f) ? 'file-code' : 'file-text');
        const txt = el('span', ''); txt.append(el('div', 'nm', esc(f)), el('div', 'sub', fileKind(f) + ' · Download'));
        a.append(box, txt);
        grid.append(a);
      }
      c.append(grid);
    }
    const done = el('div', 'done-row'); done.append(ic('check-circle'), document.createTextNode('Task completed'));
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
    } catch (e) { add(el('div', 'error-box', esc(e.message))); }
  }
  function updateSend() { $('#send').classList.toggle('idle', !$('#input').value.trim()); }
  function autosize() { updateSend(); const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(220, i.scrollHeight) + 'px'; }

  /* ---------- Settings ---------- */
  async function loadSettings() {
    const r = await api('/settings');
    state.settings = r.settings; state.presets = r.presets;
    const a = r.settings.providers[r.settings.active];
    const chip = $('#model-chip');
    chip.innerHTML = '';
    chip.append(el('span', 'mname', esc(a.model || 'Choose a model')), el('span', 'mprov', esc(state.presets[r.settings.active].label)), ic('caret-down'));
    applyAppearance(r.settings.ui);
  }

  /* ---------- Model picker ---------- */
  function closePop() { $('#model-pop').hidden = true; $('#model-chip').setAttribute('aria-expanded', 'false'); }
  async function openPop() {
    if (!state.settings) await loadSettings();
    const pop = $('#model-pop'), s = state.settings;
    pop.innerHTML = '';
    for (const id of Object.keys(s.providers)) {
      const p = s.providers[id], b = el('button', 'pop-item'); b.type = 'button';
      const n = el('span', 'pn'); n.append(el('b', '', esc(state.presets[id].label)), el('span', '', esc(p.model || 'no model set')));
      const ck = el('span', 'ck'); if (id === s.active) setIcon(ck, 'check');
      b.append(n, ck);
      b.addEventListener('click', async () => { await api('/settings', { method: 'PUT', body: { active: id } }); await loadSettings(); openPop(); });
      pop.append(b);
    }
    pop.append(el('div', 'pop-sep'));
    const a = s.providers[s.active];
    const box = el('div', 'pop-model');
    const input = el('input'); input.value = a.model; input.placeholder = 'model name'; input.setAttribute('list', 'pop-models'); input.setAttribute('aria-label', 'Model name');
    const dl = el('datalist'); dl.id = 'pop-models';
    const load = el('button', 'btn btn-outline btn-sm', 'Load'); load.type = 'button';
    const save = async () => { if (input.value.trim() && input.value.trim() !== a.model) { await api('/settings', { method: 'PUT', body: { providers: { [s.active]: { model: input.value } } } }); await loadSettings(); } };
    const hint = el('div', 'hint', 'Type a model name, or press Load to list what this provider offers.');
    load.addEventListener('click', async () => {
      load.textContent = '...';
      const r = await api('/models?provider=' + s.active).catch((e) => ({ models: [], error: e.message }));
      dl.innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
      hint.textContent = r.error ? r.error : `${r.models.length} models found. Click the box to pick one.`;
      load.textContent = 'Load'; input.focus();
    });
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save().then(closePop); } });
    const row = el('div', 'mrow'); row.append(input, load);
    box.append(el('label', '', 'Model for ' + esc(state.presets[s.active].label)), row, dl, hint);
    pop.append(box, el('div', 'pop-sep'));
    const more = el('button', 'pop-item'); more.type = 'button';
    const mn = el('span', 'pn'); mn.append(el('b', '', 'Provider settings...'), el('span', '', 'Server address, API keys, add your own app'));
    more.append(mn); more.addEventListener('click', () => { closePop(); openSettings(); });
    pop.append(more);
    pop.hidden = false;
    $('#model-chip').setAttribute('aria-expanded', 'true');
  }

  const field = (label, input) => { const f = el('div', 'field'); f.append(el('label', '', label), input); return f; };
  const selectOf = (options, value) => { const s = el('select'); for (const [v, t] of options) { const o = el('option', '', esc(t)); o.value = v; s.append(o); } s.value = value; return s; };

  async function openSettings() {
    await loadSettings();
    const s = state.settings;
    const body = $('#settings-body');
    body.innerHTML = '';
    const ids = Object.keys(s.providers);

    const look = el('div', 'pcard');
    look.append(el('h3', '', '<span>Appearance</span>'), el('div', 'help', 'Leave the font blank to use your computer\'s own UI font. To use a specific one, type its exact name as it appears in your installed fonts (for example Segoe UI Variable, Cascadia Code, Comic Sans MS).'));
    const theme = selectOf([['light', 'Light'], ['dark', 'Dark'], ['system', 'Match my system']], s.ui.theme); theme.id = 'f-theme';
    const font = el('input'); font.id = 'f-font'; font.value = s.ui.font; font.placeholder = 'System default';
    const mono = el('input'); mono.id = 'f-mono'; mono.value = s.ui.monoFont; mono.placeholder = 'System default (Cascadia Mono / Consolas)';
    const r0 = el('div', 'row'); r0.append(field('Theme', theme), field('Font', font));
    look.append(r0, field('Code font', mono));
    // live preview while typing
    const preview = () => applyAppearance({ theme: theme.value, font: font.value, monoFont: mono.value });
    [theme, font, mono].forEach((x) => x.addEventListener('input', preview));
    body.append(look);

    const top = el('div', 'row');
    const active = selectOf(ids.map((id) => [id, state.presets[id].label]), s.active); active.id = 'f-active';
    top.append(field('Active model provider', active));
    const appr = selectOf([['ask', 'Ask me before running commands'], ['auto', 'Run commands automatically']], s.approval); appr.id = 'f-approval';
    top.append(field('Shell and Python safety', appr));
    body.append(top);

    const fb = el('div', 'field');
    fb.append(el('label', '', 'Fallback providers (used when the active one is rate-limited)'));
    const fbBox = el('div', 'seg');
    for (const id of ids) {
      const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.value = id; c.checked = s.fallback.includes(id); c.className = 'fb';
      l.append(c, document.createTextNode(id)); fbBox.append(l);
    }
    fb.append(fbBox); body.append(fb);

    for (const id of ids) {
      const p = s.providers[id], pre = state.presets[id];
      const card = el('div', 'pcard'); card.dataset.pid = id;
      card.append(el('h3', '', `<span>${esc(pre.label)}</span><span class="muted">${p.hasKey ? 'key saved' : pre.needsKey ? 'key needed' : ''}</span>`));
      card.append(el('div', 'help', esc(pre.help)));
      const url = el('input'); url.value = p.baseUrl; url.className = 'p-url';
      const model = el('input'); model.value = p.model; model.className = 'p-model'; model.setAttribute('list', 'models-' + id);
      const dl = el('datalist'); dl.id = 'models-' + id;
      const key = el('input'); key.type = 'password'; key.placeholder = p.hasKey ? '(unchanged)' : pre.needsKey ? 'paste API key' : 'optional'; key.className = 'p-key'; key.autocomplete = 'off';
      const mode = selectOf([['auto', 'Tool calling: automatic'], ['native', 'Native tool calling'], ['json', 'JSON mode (for small local models)']], p.toolMode); mode.className = 'p-mode';
      const r1 = el('div', 'row'); r1.append(field('Base URL', url), field('Model', model));
      const r2 = el('div', 'row'); r2.append(field('API key', key), field('Tool mode', mode));
      const fetchBtn = el('button', 'btn btn-outline', 'Load available models'); fetchBtn.type = 'button';
      fetchBtn.addEventListener('click', async () => {
        fetchBtn.textContent = 'Loading...';
        const r = await api('/models?provider=' + id);
        dl.innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
        fetchBtn.textContent = r.error ? r.error : `${r.models.length} models loaded (click the Model box to pick)`;
      });
      card.append(r1, dl, r2, fetchBtn);
      body.append(card);
    }

    const sr = el('div', 'pcard');
    sr.append(el('h3', '', '<span>Web search</span>'), el('div', 'help', 'DuckDuckGo (no key) with Bing as backup. Optionally add a free Brave Search API key for steadier results.'));
    const sp = selectOf([['duckduckgo', 'DuckDuckGo + Bing (no key)'], ['brave', 'Brave Search API (key)']], s.search.provider); sp.id = 'f-search';
    const bk = el('input'); bk.type = 'password'; bk.id = 'f-brave'; bk.placeholder = s.search.hasBraveKey ? '(unchanged)' : 'Brave API key (optional)';
    const r3 = el('div', 'row'); r3.append(field('Search provider', sp), field('Brave key', bk)); sr.append(r3);
    body.append(sr);

    const lim = el('div', 'row');
    const ms = el('input'); ms.type = 'number'; ms.id = 'f-steps'; ms.value = s.maxSteps;
    const hl = selectOf([['true', 'Hidden (headless)'], ['false', 'Visible window']], String(s.browserHeadless)); hl.id = 'f-headless';
    lim.append(field('Max tool steps per request', ms), field('Browser window', hl));
    body.append(lim);

    $('#settings-msg').textContent = '';
    hydrateIcons($('#settings'));
    $('#settings').showModal();
  }

  async function saveSettings() {
    const patch = { providers: {}, search: {}, ui: {} };
    patch.active = $('#f-active').value;
    patch.approval = $('#f-approval').value;
    patch.fallback = $$('.fb').filter((c) => c.checked).map((c) => c.value);
    patch.maxSteps = Number($('#f-steps').value);
    patch.browserHeadless = $('#f-headless').value === 'true';
    patch.search.provider = $('#f-search').value;
    patch.search.braveKey = $('#f-brave').value;
    patch.ui = { theme: $('#f-theme').value, font: $('#f-font').value, monoFont: $('#f-mono').value };
    for (const card of $$('.pcard[data-pid]')) {
      patch.providers[card.dataset.pid] = { baseUrl: $('.p-url', card).value, model: $('.p-model', card).value, apiKey: $('.p-key', card).value, toolMode: $('.p-mode', card).value };
    }
    await api('/settings', { method: 'PUT', body: patch });
    await loadSettings();
    $('#settings-msg').textContent = 'Saved.';
    setTimeout(() => $('#settings').close(), 500);
  }

  /* ---------- Wire up ---------- */
  const STARTERS = [
    { icon: 'magnifying-glass', label: 'Research', text: 'Research [topic] across several reliable sources and write a short report with links as report.md' },
    { icon: 'code', label: 'Write code', text: 'Write a small Python script that [does something], run it to test it, and explain how to use it' },
    { icon: 'browser', label: 'Browse the web', text: 'Open [website] in the browser, tell me what the page says, and save a screenshot' },
    { icon: 'file-code', label: 'Build a page', text: 'Build a single-page HTML site for [idea] and save it as index.html' },
  ];

  function init() {
    hydrateIcons();
    for (const s of STARTERS) {
      const b = el('button', 'home-chip'); b.type = 'button';
      b.append(ic(s.icon), document.createTextNode(s.label));
      b.addEventListener('click', () => {
        const i = $('#input'); i.value = s.text; autosize(); i.focus();
        const a = s.text.indexOf('['), z = s.text.indexOf(']');
        if (a >= 0 && z > a) i.setSelectionRange(a, z + 1);
      });
      $('#home-chips').append(b);
    }
    $('#new-task').addEventListener('click', () => { newTask(); if (innerWidth < 1000) setSidebar(false); });
    $('#open-settings').addEventListener('click', openSettings);
    $('#model-chip').addEventListener('click', (e) => { e.stopPropagation(); if ($('#model-pop').hidden) openPop(); else closePop(); });
    document.addEventListener('click', (e) => { if (!$('#model-pop').hidden && !e.target.closest('#model-pop')) closePop(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
    $('#close-sidebar').addEventListener('click', () => setSidebar(false));
    $('#open-sidebar').addEventListener('click', () => setSidebar(true));
    $('#task-search').addEventListener('input', renderTasks);
    setSidebar(innerWidth >= 1000);
    $('#save-settings').addEventListener('click', () => saveSettings().catch((e) => { $('#settings-msg').textContent = e.message; }));
    $('#settings').addEventListener('close', () => { if (state.settings) applyAppearance(state.settings.ui); });
    $('#toggle-theme').addEventListener('click', async () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyAppearance({ ...state.settings.ui, theme: next });
      state.settings.ui.theme = next;
      api('/settings', { method: 'PUT', body: { ui: { theme: next } } }).catch(() => {});
    });
    $('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit($('#input').value); });
    $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit($('#input').value); } });
    $('#input').addEventListener('input', autosize);
    $('#stop').addEventListener('click', () => state.current && api(`/tasks/${state.current}/stop`, { method: 'POST' }));
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newTask(); } });

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

    loadSettings().catch(() => {});
    loadTasks().catch(() => {});
    setHome(true);
    setStatus('idle');
    renderPanel();
  }
  init();
})();
