'use strict';
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

/*
 * Sign-in for web connectors (Linear, Notion, Figma...), the way Claude does it: MCP's OAuth flow.
 * Find the app's sign-in server from the connector address, register Freehand with it, open the
 * sign-in page in the browser, catch the answer on a local address, and trade it for tokens.
 * Tokens are refreshed when they run out, so the user signs in once.
 */

const CALLBACK_PORT = 33418;
const SIGN_IN_TIMEOUT = 4 * 60 * 1000;

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** The "resource_metadata" address a 401 answer points to, if any. */
async function challenge(mcpUrl) {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'freehand', version: '1' } } }),
      signal: AbortSignal.timeout(15000),
    });
    const h = res.headers.get('www-authenticate') || '';
    const m = /resource_metadata="([^"]+)"/.exec(h);
    const scope = /scope="([^"]+)"/.exec(h);
    return { status: res.status, metadata: m && m[1], scope: scope && scope[1] };
  } catch { return { status: 0 }; }
}

/** Well-known addresses for an issuer, with its path inserted the way RFC 8414 says, then the older forms. */
function wellKnown(base, name) {
  const u = new URL(base);
  const p = u.pathname.replace(/\/$/, '');
  return [...new Set([`${u.origin}/.well-known/${name}${p}`, `${u.origin}${p}/.well-known/${name}`, `${u.origin}/.well-known/${name}`])];
}

/** Finds how to sign in to the connector at mcpUrl: { resource, scope, server } or null when it needs no sign-in. */
async function discover(mcpUrl) {
  const c = await challenge(mcpUrl);
  if (c.status !== 401 && c.status !== 403) return null;
  let prm = c.metadata ? await getJson(c.metadata) : null;
  for (const u of prm ? [] : wellKnown(mcpUrl, 'oauth-protected-resource')) if ((prm = await getJson(u))) break;
  const issuer = (prm && prm.authorization_servers && prm.authorization_servers[0]) || new URL(mcpUrl).origin;
  let server = null;
  for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    server = await getJson(u);
    if (server && server.authorization_endpoint && server.token_endpoint) break;
    server = null;
  }
  if (!server) throw new Error('This app asks for a sign-in, but it does not say where to sign in. If it gives you a token, add the connector again with the token.');
  const scopes = c.scope || (prm && prm.scopes_supported && prm.scopes_supported.join(' ')) || '';
  return { resource: (prm && prm.resource) || mcpUrl, scope: scopes, server };
}

/** Opens a page in the user's browser. */
function openInBrowser(url) {
  if (process.versions.electron) {
    try { require('electron').shell.openExternal(url); return; } catch { /* not in the main process */ }
  }
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}

/** Listens on the local callback address until the sign-in page sends the user back. */
function waitForCallback(state, signal) {
  return new Promise((resolve, reject) => {
    const done = (err, val) => { clearTimeout(timer); server.close(); if (err) reject(err); else resolve(val); };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      const why = u.searchParams.get('error_description') || u.searchParams.get('error') || 'The sign-in did not finish.';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Freehand</title><body style="font:16px system-ui;padding:3rem;background:#111;color:#eee"><h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1><p>${ok ? 'You can close this tab and go back to Freehand.' : why.replace(/[<>&]/g, '')}</p>`);
      if (ok) done(null, u.searchParams.get('code'));
      else done(new Error(why));
    });
    server.on('error', (e) => done(e.code === 'EADDRINUSE' ? new Error(`Port ${CALLBACK_PORT} is busy, so the sign-in cannot come back to Freehand. Close whatever uses it and try again.`) : e));
    server.listen(CALLBACK_PORT, '127.0.0.1');
    const timer = setTimeout(() => done(new Error('The sign-in was not finished within 4 minutes.')), SIGN_IN_TIMEOUT);
    if (signal) signal.addEventListener('abort', () => done(new Error('Sign-in cancelled')), { once: true });
  });
}

async function tokenRequest(endpoint, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || !j.access_token) throw new Error(`The app did not give a token: ${(j && (j.error_description || j.error)) || `HTTP ${res.status}`}`);
  return j;
}

const withExpiry = (auth, t) => ({
  ...auth,
  access_token: t.access_token,
  refresh_token: t.refresh_token || auth.refresh_token,
  expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : 0,
});

/** Runs the whole sign-in for the connector at mcpUrl. Returns the saved sign-in, or null if it needs none. */
async function signIn(mcpUrl, { open = openInBrowser, signal } = {}) {
  const found = await discover(mcpUrl);
  if (!found) return null;
  const { server, resource, scope } = found;
  const redirect = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  if (!server.registration_endpoint) {
    throw new Error('This app does not let new apps register for sign-in. Make a personal access token in the app and add the connector again with it.');
  }
  const regRes = await fetch(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: 'Freehand', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
    signal: AbortSignal.timeout(20000),
  });
  const reg = await regRes.json().catch(() => ({}));
  if (!regRes.ok || !reg.client_id) throw new Error(`The app would not register Freehand for sign-in: ${reg.error_description || reg.error || `HTTP ${regRes.status}`}`);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const auth = new URL(server.authorization_endpoint);
  const q = {
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state, resource,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(scope ? { scope } : {}),
  };
  for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
  const waiting = waitForCallback(state, signal);
  open(auth.toString());
  const code = await waiting;
  const t = await tokenRequest(server.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: reg.client_id, resource,
    ...(reg.client_secret ? { client_secret: reg.client_secret } : {}),
  });
  return withExpiry({ client_id: reg.client_id, client_secret: reg.client_secret || '', token_endpoint: server.token_endpoint, resource }, t);
}

/** A fresh token from the refresh token. Throws when the user has to sign in again. */
async function refresh(auth) {
  if (!auth || !auth.refresh_token) throw new Error('The sign-in has run out. Sign in again in Settings, Connectors.');
  const t = await tokenRequest(auth.token_endpoint, {
    grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id, resource: auth.resource,
    ...(auth.client_secret ? { client_secret: auth.client_secret } : {}),
  });
  return withExpiry(auth, t);
}

/** True when the token is gone or runs out within a minute. */
const expired = (auth) => !!(auth && auth.expires_at && auth.expires_at - Date.now() < 60000);

module.exports = { signIn, refresh, discover, expired, wellKnown, CALLBACK_PORT };
