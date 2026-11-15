'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Where all app data lives (settings, tasks, workspaces). Override with FREEHAND_HOME. */
function homeDir() {
  if (process.env.FREEHAND_HOME) return process.env.FREEHAND_HOME;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'freehand-agent');
}

/** All providers speak the OpenAI-compatible /chat/completions API. */
const PROVIDER_PRESETS = {
  ollama: {
    label: 'Ollama (local, unlimited)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    needsKey: false,
    envKey: null,
    help: 'Install Ollama, then run: ollama pull qwen3:8b',
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    needsKey: true,
    envKey: 'OPENROUTER_API_KEY',
    help: 'Free key at openrouter.ai/keys. Use models ending in :free.',
  },
  groq: {
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    envKey: 'GROQ_API_KEY',
    help: 'Free key at console.groq.com/keys. Very fast, rate-limited.',
  },
  gemini: {
    label: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    needsKey: true,
    envKey: 'GEMINI_API_KEY',
    help: 'Free key at aistudio.google.com/apikey.',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    needsKey: false,
    envKey: 'CUSTOM_API_KEY',
    help: 'Any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, Together...',
  },
};

function defaultSettings() {
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    providers[id] = { baseUrl: p.baseUrl, model: p.model, apiKey: '', toolMode: 'auto' };
  }
  return {
    active: 'ollama',
    fallback: [], // provider ids tried in order when the active one is rate-limited/unreachable
    providers,
    approval: 'ask', // 'ask' = confirm shell/python commands, 'auto' = run without asking
    effort: 'high', // 'low' | 'medium' | 'high' | 'max': how hard Freehand works on each request
    maxSteps: 40,
    contextChars: 48000,
    browserHeadless: true,
    search: { provider: 'duckduckgo', braveKey: '' },
    // Connectors: other apps' MCP servers (Blender, Figma...) whose tools the agent can use. See src/core/mcp.js.
    connectors: [],
    // font: '' means "use the operating system's UI font"; any installed font name can be typed in.
    ui: { theme: 'system', font: '', monoFont: '', chatFont: 'sans', enterSends: 'enter', reduceMotion: false },
  };
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
  }
  return out;
}

function settingsPath() {
  return path.join(homeDir(), 'settings.json');
}

function loadSettings() {
  const defaults = defaultSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return deepMerge(defaults, raw);
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function getApiKey(settings, providerId) {
  const p = settings.providers[providerId];
  if (p && p.apiKey) return p.apiKey;
  const env = PROVIDER_PRESETS[providerId] && PROVIDER_PRESETS[providerId].envKey;
  return (env && process.env[env]) || '';
}

/** Settings safe to send to the UI: API keys replaced by a boolean. */
function publicSettings(settings) {
  const s = JSON.parse(JSON.stringify(settings));
  for (const id of Object.keys(s.providers)) {
    s.providers[id].hasKey = !!getApiKey(settings, id);
    delete s.providers[id].apiKey;
  }
  s.search.hasBraveKey = !!settings.search.braveKey || !!process.env.BRAVE_API_KEY;
  delete s.search.braveKey;
  // Connector env vars and headers often hold tokens: the page only learns their names.
  s.connectors = (s.connectors || []).map((c) => ({ ...c, env: Object.keys(c.env || {}), headers: Object.keys(c.headers || {}) }));
  return s;
}

/** Merge a UI patch into settings; blank/undefined keys keep the stored key. */
function applyPatch(settings, patch) {
  const next = JSON.parse(JSON.stringify(settings));
  for (const k of ['active', 'approval', 'browserHeadless']) if (patch[k] !== undefined) next[k] = patch[k];
  if (['low', 'medium', 'high', 'max'].includes(patch.effort)) next.effort = patch.effort;
  if (Array.isArray(patch.fallback)) next.fallback = patch.fallback.filter((id) => next.providers[id]);
  if (Number.isFinite(patch.maxSteps)) next.maxSteps = Math.min(200, Math.max(5, Math.floor(patch.maxSteps)));
  if (Number.isFinite(patch.contextChars)) next.contextChars = Math.min(400000, Math.max(8000, Math.floor(patch.contextChars)));
  if (patch.ui) {
    if (['light', 'dark', 'system'].includes(patch.ui.theme)) next.ui.theme = patch.ui.theme;
    if (['sans', 'serif', 'system', 'mono'].includes(patch.ui.chatFont)) next.ui.chatFont = patch.ui.chatFont;
    if (['enter', 'ctrl'].includes(patch.ui.enterSends)) next.ui.enterSends = patch.ui.enterSends;
    if (typeof patch.ui.reduceMotion === 'boolean') next.ui.reduceMotion = patch.ui.reduceMotion;
    for (const f of ['font', 'monoFont']) if (typeof patch.ui[f] === 'string') next.ui[f] = patch.ui[f].replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 60);
  }
  if (patch.providers) {
    for (const [id, p] of Object.entries(patch.providers)) {
      if (!next.providers[id]) continue;
      for (const f of ['baseUrl', 'model', 'toolMode']) if (typeof p[f] === 'string') next.providers[id][f] = p[f].trim();
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) next.providers[id].apiKey = p.apiKey.trim();
      if (p.clearKey) next.providers[id].apiKey = '';
    }
  }
  if (patch.search) {
    if (typeof patch.search.provider === 'string') next.search.provider = patch.search.provider;
    if (typeof patch.search.braveKey === 'string' && patch.search.braveKey.trim()) next.search.braveKey = patch.search.braveKey.trim();
  }
  if (!next.providers[next.active]) next.active = 'ollama';
  return next;
}

module.exports = {
  homeDir,
  PROVIDER_PRESETS,
  defaultSettings,
  loadSettings,
  saveSettings,
  getApiKey,
  publicSettings,
  applyPatch,
};
