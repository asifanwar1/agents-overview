'use strict';
// Tails a session transcript plus all of its subagent transcripts.

const fs = require('fs');
const path = require('path');
const { TranscriptParser } = require('./transcript');

class TailedFile {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
  }

  readLines() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0); }
    if (size === this.offset) return [];

    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, this.offset); } finally { fs.closeSync(fd); }
    this.offset = size;

    const data = this.rest.length ? Buffer.concat([this.rest, buf]) : buf;
    const cut = data.lastIndexOf(0x0a);
    if (cut === -1) { this.rest = data; return []; }
    this.rest = Buffer.from(data.subarray(cut + 1));
    return data.subarray(0, cut).toString('utf8').split('\n');
  }
}

class SessionWatcher {
  constructor(mainFile) {
    this.subDir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
    this.files = new Map([['main', new TailedFile(mainFile)]]);
    this.metaSeen = new Set();
    this.parser = new TranscriptParser();
  }

  discover() {
    let names;
    try { names = fs.readdirSync(this.subDir); } catch { return []; }
    const metas = [];
    for (const name of names) {
      const log = /^agent-(.+)\.jsonl$/.exec(name);
      if (log && !this.files.has(log[1])) this.files.set(log[1], new TailedFile(path.join(this.subDir, name)));
      const meta = /^agent-(.+)\.meta\.json$/.exec(name);
      if (meta && !this.metaSeen.has(meta[1])) {
        try {
          metas.push([meta[1], JSON.parse(fs.readFileSync(path.join(this.subDir, name), 'utf8'))]);
          this.metaSeen.add(meta[1]);
        } catch { /* partially written; retry on next poll */ }
      }
    }
    return metas;
  }

  // Returns every new event since the previous call, oldest first.
  read() {
    const metas = this.discover();
    const events = [];
    for (const [agent, file] of this.files) {
      for (const line of file.readLines()) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        this.parser.ingest(rec, agent, events);
      }
    }
    for (const [id, meta] of metas) this.parser.spawn(id, meta, events);
    return events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
}

module.exports = { SessionWatcher };
