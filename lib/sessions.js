'use strict';
// Finds Claude Code sessions on disk and extracts a title/project for each.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const LIVE_WINDOW_MS = 45_000;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

const cache = new Map(); // file -> { size, info }

function readSlice(file, start, length) {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function lastJsonString(text, key) {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let match, last = null;
  while ((match = re.exec(text))) last = match[1];
  if (last === null) return null;
  try { return JSON.parse(`"${last}"`); } catch { return last; }
}

function describe(file, size) {
  const hit = cache.get(file);
  if (hit && hit.size === size) return hit.info;
  let head = '', tail = '';
  try {
    head = readSlice(file, 0, Math.min(size, HEAD_BYTES));
    if (size > HEAD_BYTES) tail = readSlice(file, size - TAIL_BYTES, TAIL_BYTES);
  } catch { /* unreadable; fall back to defaults */ }
  const both = head + tail;
  const cwd = lastJsonString(head, 'cwd') || '';
  const title = lastJsonString(both, 'aiTitle') || lastJsonString(both, 'summary')
    || lastJsonString(both, 'lastPrompt') || 'Untitled session';
  const info = {
    title: title.replace(/\s+/g, ' ').slice(0, 120),
    cwd,
    project: cwd.split(/[\\/]/).filter(Boolean).pop() || '',
  };
  cache.set(file, { size, info });
  return info;
}

function listSessions(limit = 60) {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
  const found = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(path.join(PROJECTS_DIR, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(PROJECTS_DIR, dir, name);
      try {
        const st = fs.statSync(file);
        if (st.size > 0) found.push({ dir, id: name.slice(0, -6), file, mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  return found.slice(0, limit).map(s => {
    const info = describe(s.file, s.size);
    return {
      key: `${s.dir}/${s.id}`,
      title: info.title,
      project: info.project || s.dir,
      cwd: info.cwd,
      mtime: s.mtime,
      live: now - s.mtime < LIVE_WINDOW_MS,
    };
  });
}

function resolveSession(key) {
  if (typeof key !== 'string') return null;
  const [dir, id, extra] = key.split('/');
  if (extra !== undefined || !SAFE_NAME.test(dir || '') || !SAFE_NAME.test(id || '')) return null;
  const file = path.join(PROJECTS_DIR, dir, `${id}.jsonl`);
  try {
    const st = fs.statSync(file);
    return { file, key, mtime: st.mtimeMs, live: Date.now() - st.mtimeMs < LIVE_WINDOW_MS };
  } catch {
    return null;
  }
}

module.exports = { listSessions, resolveSession, PROJECTS_DIR };
