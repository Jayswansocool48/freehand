'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { homeDir, loadSettings } = require('../core/config');
const { Agent } = require('../core/agent');

const tasksRoot = () => path.join(homeDir(), 'tasks');

class Task {
  constructor(id, meta) {
    this.id = id;
    this.dir = path.join(tasksRoot(), id);
    this.workspace = path.join(this.dir, 'workspace');
    this.title = meta.title || 'New task';
    this.status = meta.status || 'idle';
    this.created = meta.created || Date.now();
    this.updated = meta.updated || this.created;
    this.events = [];
    this.history = [];
    this.subscribers = new Set();
    this.pending = new Map(); // id -> resolve
    this.abort = null;
    fs.mkdirSync(this.workspace, { recursive: true });
  }

  static create() {
    const t = new Task(crypto.randomBytes(6).toString('hex'), {});
    t.saveMeta();
    return t;
  }

  static load(id) {
    const dir = path.join(tasksRoot(), id);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
    const t = new Task(id, meta);
    if (t.status === 'running') t.status = 'stopped'; // app was closed mid-run
    try { t.events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    try { t.history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')); } catch { /* none */ }
    return t;
  }

  saveMeta() {
    this.updated = Date.now();
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify({ title: this.title, status: this.status, created: this.created, updated: this.updated }));
  }

  summary() { return { id: this.id, title: this.title, status: this.status, updated: this.updated }; }

  emit(type, data = {}) {
    const ev = { seq: this.events.length, t: Date.now(), type, ...data };
    this.events.push(ev);
    if (type !== 'terminal') {
      try { fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n'); } catch { /* disk issues should not kill the run */ }
    }
    if (type === 'title') this.title = data.title;
    if (type === 'status') { this.status = data.status; this.saveMeta(); }
    for (const res of this.subscribers) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  prompt(kind, payload) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(4).toString('hex');
      this.pending.set(id, { resolve, reject });
      this.emit(kind, { id, ...payload });
      if (this.abort) this.abort.signal.addEventListener('abort', () => { this.pending.delete(id); reject(new Error('Aborted')); }, { once: true });
    });
  }

  respond(id, value) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.emit('resolved', { id, value: typeof value === 'string' ? value.slice(0, 200) : value });
    p.resolve(value);
    return true;
  }

  /**
   * Cuts the chat back to just before the user message at `seq` and sends `text` in its place
   * (edit), or the same text again (retry). Files the agent already wrote stay in the workspace.
   */
  rewind(seq, text) {
    if (this.status === 'running') throw new Error('Task is already running');
    const ev = this.events[seq];
    if (!ev || ev.type !== 'user') throw new Error('That message cannot be edited');
    let cut = this.history.findIndex((h) => h.role === 'user' && h.turn === seq);
    if (cut < 0) {
      // Tasks from before turns were tagged: match user events to history entries in order.
      let from = 0;
      for (const e of this.events.slice(0, seq + 1)) {
        if (e.type !== 'user') continue;
        const i = this.history.findIndex((h, j) => j >= from && h.role === 'user' && h.content === e.text);
        if (i < 0) { cut = -1; break; }
        cut = i;
        from = i + 1;
      }
      if (cut < 0) throw new Error('Could not find that message in the conversation');
    }
    this.history.length = cut;
    this.events.length = seq;
    fs.writeFileSync(path.join(this.dir, 'history.json'), JSON.stringify(this.history));
    fs.writeFileSync(path.join(this.dir, 'events.jsonl'), this.events.map((e) => JSON.stringify(e) + '\n').join(''));
    this.start(text);
  }

  start(text) {
    if (this.status === 'running') throw new Error('Task is already running');
    const settings = loadSettings();
    this.abort = new AbortController();
    this.emit('user', { text });
    const agent = new Agent({
      settings,
      workspace: this.workspace,
      signal: this.abort.signal,
      history: this.history,
      emit: (type, data) => this.emit(type, data),
      ask: (question) => this.prompt('ask', { question }),
      approve: (req) => this.prompt('approval', req),
    });
    this.status = 'running';
    agent.run(text, this.events.length - 1).finally(() => {
      try { fs.writeFileSync(path.join(this.dir, 'history.json'), JSON.stringify(this.history)); } catch { /* ignore */ }
      this.abort = null;
      this.pending.clear();
    });
  }

  stop() { if (this.abort) this.abort.abort(); }

  remove() {
    this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

class TaskStore {
  constructor() {
    this.tasks = new Map();
    fs.mkdirSync(tasksRoot(), { recursive: true });
    for (const id of fs.readdirSync(tasksRoot())) {
      const t = Task.load(id);
      if (t) this.tasks.set(id, t);
    }
  }
  list() { return [...this.tasks.values()].map((t) => t.summary()).sort((a, b) => b.updated - a.updated); }
  get(id) { return this.tasks.get(id); }
  create() { const t = Task.create(); this.tasks.set(t.id, t); return t; }
  delete(id) { const t = this.tasks.get(id); if (t) { t.remove(); this.tasks.delete(id); } }
}

module.exports = { TaskStore, Task };
