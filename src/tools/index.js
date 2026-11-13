'use strict';
const fs = require('fs');
const path = require('path');
const { safePath, truncate } = require('../core/util');
const { webSearch, fetchPage } = require('./web');
const { runCommand, runPython } = require('./exec');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

function listDir(root, rel, depth = 2) {
  const base = safePath(root, rel);
  const lines = [];
  const walk = (dir, d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        if (d < depth) walk(full, d + 1, prefix + '  ');
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        lines.push(`${prefix}${e.name} (${size} bytes)`);
      }
      if (lines.length > 300) return;
    }
  };
  walk(base, 1, '');
  return lines.length ? lines.join('\n') : '(empty)';
}

function buildTools() {
  const tools = [
    {
      name: 'web_search',
      icon: 'magnifying-glass',
      description: 'Search the web. Returns titles, URLs and snippets. Follow up with web_fetch on promising URLs.',
      parameters: obj({ query: str('Search query'), max_results: num('1-10, default 6') }, ['query']),
      label: (a) => `Searching: ${a.query}`,
      async run(a, ctx) {
        const r = await webSearch(String(a.query || ''), { settings: ctx.settings, signal: ctx.signal, max: Math.min(10, Number(a.max_results) || 6) });
        return r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
      },
    },
    {
      name: 'web_fetch',
      icon: 'globe',
      description: 'Download a web page and return its readable text (links are shown as (url)). Pages longer than max_chars can be paged with offset.',
      parameters: obj({ url: str('http(s) URL'), max_chars: num('default 8000'), offset: num('character offset, default 0') }, ['url']),
      label: (a) => `Reading ${a.url}`,
      async run(a, ctx) {
        const r = await fetchPage(String(a.url || ''), { signal: ctx.signal, maxChars: Math.min(20000, Number(a.max_chars) || 8000), offset: Number(a.offset) || 0 });
        return `URL: ${r.url}\n\n${r.text}`;
      },
    },
    {
      name: 'browser',
      icon: 'browser',
      description:
        'Control a real browser. Actions: open{url}, snapshot, click{index}, type{index,text,submit?}, press{key}, scroll{direction:"up"|"down",amount?}, back, screenshot{full_page?}, text{offset?,max_chars?}, close. ' +
        'Every action except screenshot/text/close returns the page state with numbered interactive elements; use those numbers as "index". Prefer web_fetch for plain reading; use the browser for pages that need JavaScript, clicks or forms.',
      parameters: obj(
        {
          action: { type: 'string', enum: ['open', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'screenshot', 'text', 'close'] },
          url: str('for open'),
          index: num('element number from the last snapshot'),
          text: str('for type'),
          submit: { type: 'boolean', description: 'press Enter after typing' },
          key: str('for press, e.g. Enter, Escape, PageDown'),
          direction: str('up or down'),
          amount: num('pixels'),
          full_page: { type: 'boolean' },
          offset: num('for text'),
          max_chars: num('for text'),
        },
        ['action']
      ),
      label: (a) => ({ open: `Opening ${a.url}`, click: `Clicking element ${a.index}`, type: `Typing into element ${a.index}`, scroll: `Scrolling ${a.direction || 'down'}`, back: 'Going back', press: `Pressing ${a.key}`, screenshot: 'Taking a screenshot', snapshot: 'Looking at the page', text: 'Reading page text', close: 'Closing browser' }[a.action] || `Browser: ${a.action}`),
      async run(a, ctx) {
        return ctx.browser().act(a);
      },
    },
    {
      name: 'file_list',
      icon: 'folder-open',
      description: 'List files in the workspace (relative paths only).',
      parameters: obj({ path: str('directory, default "."') }),
      label: (a) => `Listing ${a.path || '.'}`,
      async run(a, ctx) { return listDir(ctx.workspace, a.path || '.'); },
    },
    {
      name: 'file_read',
      icon: 'file-text',
      description: 'Read a text file from the workspace.',
      parameters: obj({ path: str('relative path'), max_chars: num('default 12000'), offset: num('default 0') }, ['path']),
      label: (a) => `Reading ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`No such file: ${a.path}`);
        const buf = fs.readFileSync(p);
        if (buf.includes(0)) throw new Error('That looks like a binary file; use the shell or python tool to inspect it.');
        const txt = buf.toString('utf8');
        const off = Number(a.offset) || 0;
        const max = Number(a.max_chars) || 12000;
        return txt.slice(off, off + max) + (txt.length > off + max ? `\n...[${txt.length} chars total; use offset=${off + max}]` : '');
      },
    },
    {
      name: 'file_write',
      icon: 'pencil-simple',
      description: 'Create or overwrite a file in the workspace (parent folders are created). Use this for deliverables: reports, code, CSV, HTML.',
      parameters: obj({ path: str('relative path'), content: str('full file content') }, ['path', 'content']),
      label: (a) => `Writing ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(a.content == null ? '' : a.content), 'utf8');
        ctx.emit('file', { path: path.relative(ctx.workspace, p).replace(/\\/g, '/') });
        return `Wrote ${a.path} (${Buffer.byteLength(String(a.content || ''))} bytes)`;
      },
    },
    {
      name: 'file_edit',
      icon: 'pencil-simple',
      description: 'Replace one exact piece of text in a workspace file. "find" must match exactly once.',
      parameters: obj({ path: str('relative path'), find: str('exact text to replace'), replace: str('replacement text') }, ['path', 'find', 'replace']),
      label: (a) => `Editing ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        if (!fs.existsSync(p)) throw new Error(`No such file: ${a.path}`);
        const txt = fs.readFileSync(p, 'utf8');
        const find = String(a.find);
        const count = find ? txt.split(find).length - 1 : 0;
        if (count !== 1) throw new Error(count === 0 ? '"find" text not found. Read the file again and copy it exactly.' : `"find" matches ${count} times; include more surrounding text so it matches once.`);
        fs.writeFileSync(p, txt.replace(find, () => String(a.replace)), 'utf8');
        ctx.emit('file', { path: path.relative(ctx.workspace, p).replace(/\\/g, '/') });
        return `Edited ${a.path}`;
      },
    },
    {
      name: 'shell',
      icon: 'terminal-window',
      description: `Run a shell command in the workspace folder (${process.platform === 'win32' ? 'Windows cmd.exe' : 'sh'}). Use for installing packages, running scripts, git, downloads. Output is capped; long-running servers will time out.`,
      parameters: obj({ command: str('command line'), timeout_s: num('default 120, max 600') }, ['command']),
      label: (a) => `Running: ${truncate(a.command, 80, false)}`,
      approval: (a) => ({ kind: 'shell', title: 'Run shell command', detail: String(a.command) }),
      async run(a, ctx) {
        const r = await runCommand(String(a.command), { cwd: ctx.workspace, timeoutMs: Math.min(600, Number(a.timeout_s) || 120) * 1000, signal: ctx.signal, onData: (s) => ctx.emit('terminal', { data: s }) });
        return `${r.timedOut ? '[timed out and was killed]\n' : ''}exit code: ${r.code}\n${r.output}`;
      },
    },
    {
      name: 'python',
      icon: 'code',
      description: 'Run a Python 3 script (saved and executed in the workspace). Print results to stdout. Good for data processing, charts (matplotlib if installed), converting files.',
      parameters: obj({ code: str('Python source'), timeout_s: num('default 120, max 600') }, ['code']),
      label: () => 'Running Python',
      approval: (a) => ({ kind: 'python', title: 'Run Python code', detail: String(a.code) }),
      async run(a, ctx) {
        const r = await runPython(String(a.code), { workspace: ctx.workspace, timeoutMs: Math.min(600, Number(a.timeout_s) || 120) * 1000, signal: ctx.signal, onData: (s) => ctx.emit('terminal', { data: s }) });
        return `${r.timedOut ? '[timed out and was killed]\n' : ''}exit code: ${r.code}\n${r.output}`;
      },
    },
    {
      name: 'ask_user',
      icon: 'question',
      description: 'Ask the user a question and wait for the answer. Only when you are truly blocked or a choice is theirs to make (credentials, ambiguous goal). Do not use it for things you can decide or look up.',
      parameters: obj({ question: str('one clear question') }, ['question']),
      label: (a) => `Asking: ${truncate(a.question, 80, false)}`,
      async run(a, ctx) { return `User answered: ${await ctx.ask(String(a.question))}`; },
    },
    {
      name: 'step_done',
      icon: 'check-circle',
      description: 'Mark the current plan step complete (with a one-line result) and move to the next step.',
      parameters: obj({ summary: str('what was accomplished') }, ['summary']),
      control: true,
      label: () => 'Step complete',
      async run() { return 'ok'; },
    },
    {
      name: 'revise_plan',
      icon: 'list-checks',
      description: 'Replace the remaining plan steps if the situation changed. Provide the full new list of remaining steps.',
      parameters: obj({ steps: { type: 'array', items: { type: 'string' }, description: 'remaining steps' } }, ['steps']),
      control: true,
      label: () => 'Updating the plan',
      async run() { return 'ok'; },
    },
    {
      name: 'finish',
      icon: 'flag-checkered',
      description: 'Finish the task. "message" is the final answer shown to the user (Markdown; include key findings, sources as URLs, and what files you created). List deliverable files in "files".',
      parameters: obj({ message: str('final answer in Markdown'), files: { type: 'array', items: { type: 'string' }, description: 'workspace-relative paths of deliverables' } }, ['message']),
      control: true,
      label: () => 'Finishing',
      async run() { return 'ok'; },
    },
  ];
  return tools;
}

module.exports = { buildTools, listDir };
