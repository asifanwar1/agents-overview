#!/usr/bin/env node
'use strict';
// Agent Overview: a live, local dashboard for Claude Code sessions.
// Usage: node server.js [--no-open]     (env: PORT, CLAUDE_CONFIG_DIR)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { listSessions, resolveSession, PROJECTS_DIR } = require('./lib/sessions');
const { SessionWatcher } = require('./lib/watcher');

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const POLL_MS = 400;
const MAX_STREAM_SESSIONS = 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { rel = ''; }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// The fleet view doesn't show raw tool input/output, so it can skip the heaviest fields.
function stripHeavy(ev) {
  if (ev.t !== 'tool' && ev.t !== 'result') return ev;
  const { input, output, ...rest } = ev;
  return rest;
}

// One stream can carry several sessions (?keys=a,b,c), so the fleet view needs a single connection.
function stream(req, res, params) {
  const keys = (params.get('keys') || params.get('key') || '').split(',').filter(Boolean).slice(0, MAX_STREAM_SESSIONS);
  const targets = keys.map(resolveSession).filter(Boolean);
  if (!targets.length) return sendJson(res, 404, { error: 'Unknown session' });
  const pack = params.get('lite') === '1' ? events => events.map(stripHeavy) : events => events;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const watchers = targets.map(session => ({ session, watcher: new SessionWatcher(session.file) }));

  for (const { session, watcher } of watchers) {
    const { key, mtime, live } = session;
    send({ kind: 'history', key, session: { key, mtime, live }, events: pack(watcher.read()) });
  }
  const poll = setInterval(() => {
    for (const { session, watcher } of watchers) {
      try {
        const events = watcher.read();
        if (events.length) send({ kind: 'events', key: session.key, events: pack(events) });
      } catch (err) {
        console.error('watch error:', err.message);
      }
    }
  }, POLL_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(poll);
    clearInterval(heartbeat);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* user can open it manually */ }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/sessions') return sendJson(res, 200, listSessions());
  if (url.pathname === '/api/stream') return stream(req, res, url.searchParams);
  serveStatic(res, url.pathname);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (is the dashboard already running? Try http://localhost:${PORT}).`);
    console.error(process.platform === 'win32'
      ? `To use another port in PowerShell:  $env:PORT=${PORT + 1}; npm start`
      : `To use another port:  PORT=${PORT + 1} npm start`);
  }
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  AGENT//OVERVIEW is live at ${url}`);
  console.log(`  Watching transcripts in ${PROJECTS_DIR}\n  Press Ctrl+C to stop.\n`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
});
