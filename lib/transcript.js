'use strict';
// Turns raw Claude Code transcript records into small, UI-friendly events.

const TOOL_CATEGORIES = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read', NotebookRead: 'read',
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'exec', PowerShell: 'exec', BashOutput: 'exec', KillShell: 'exec', Monitor: 'exec', TaskStop: 'exec',
  WebSearch: 'web', WebFetch: 'web', web_search: 'web', web_fetch: 'web',
  Agent: 'agent', Task: 'agent', SendMessage: 'agent', ListAgents: 'agent',
  TodoWrite: 'plan', EnterPlanMode: 'plan', ExitPlanMode: 'plan', AskUserQuestion: 'plan',
  Skill: 'plan', ToolSearch: 'plan', ScheduleWakeup: 'plan',
};

function categorize(name) {
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORIES[name] || 'other';
}

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function clipRaw(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s;
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return clip(url, 40); }
}

function describeTool(name, i) {
  const file = i.file_path || i.notebook_path;
  switch (name) {
    case 'Read': return { label: `Reading ${baseName(file)}`, detail: file, file, op: 'R' };
    case 'Write': {
      const lines = typeof i.content === 'string' ? i.content.split('\n').length : 0;
      return { label: `Creating ${baseName(file)}`, detail: `${file} · ${lines} lines`, file, op: 'W' };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return { label: `Editing ${baseName(file)}`, detail: file, file, op: 'W' };
    case 'Glob': return { label: `Looking for files: ${clip(i.pattern, 50)}`, detail: i.path || '' };
    case 'Grep': return { label: `Searching code for "${clip(i.pattern, 40)}"`, detail: i.path || i.glob || '' };
    case 'LS': return { label: `Listing ${baseName(i.path)}`, detail: i.path };
    case 'Bash':
    case 'PowerShell':
      return {
        label: i.description ? clip(i.description, 90) : `Running: ${clip(i.command, 70)}`,
        detail: clip(i.command, 220) + (i.run_in_background ? '  [background]' : ''),
      };
    case 'BashOutput': return { label: 'Checking a background command' };
    case 'KillShell':
    case 'TaskStop': return { label: 'Stopping a background task' };
    case 'Monitor': return { label: 'Watching a background process', detail: clip(i.description || i.command, 120) };
    case 'WebSearch':
    case 'web_search': return { label: `Searching the web: ${clip(i.query, 70)}`, detail: i.query };
    case 'WebFetch':
    case 'web_fetch': return { label: `Reading web page on ${hostOf(i.url)}`, detail: i.url };
    case 'Agent':
    case 'Task':
      return { label: `Deploying ${i.subagent_type || 'helper'} agent: ${clip(i.description, 60)}`, detail: clip(i.prompt, 220) };
    case 'SendMessage': return { label: `Messaging agent ${clip(i.to, 30)}`, detail: clip(i.message, 160) };
    case 'ListAgents': return { label: 'Checking on other agents' };
    case 'TodoWrite': return { label: 'Updating the task checklist' };
    case 'EnterPlanMode': return { label: 'Switching into planning mode' };
    case 'ExitPlanMode': return { label: 'Presenting a plan for approval' };
    case 'AskUserQuestion': return { label: 'Asking you a question' };
    case 'Skill': return { label: `Loading skill: ${clip(i.skill, 40)}` };
    case 'ToolSearch': return { label: 'Loading extra tools', detail: clip(i.query, 120) };
    case 'ScheduleWakeup': return { label: 'Scheduling a wake-up' };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { label: `${server.replace(/^claude_ai_/, '')} → ${rest.join(' ')}` };
      }
      return { label: name };
  }
}

// Keeps tool inputs small enough to ship to the browser for the "raw" view.
function trimInput(value, depth = 0) {
  if (typeof value === 'string') return clipRaw(value, 600);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => trimInput(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return '{…}';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimInput(v, depth + 1);
    return out;
  }
  return value;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

function summarize(name, text, ok) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!ok) return clip(lines[0] || 'Tool reported an error', 140);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  switch (name) {
    case 'Read': return `${plural(lines.length, 'line')} read`;
    case 'Glob': return /^No files/i.test(text) ? 'No files found' : `${plural(lines.length, 'file')} found`;
    case 'Grep': {
      if (/^No (matches|files)/i.test(text)) return 'No matches';
      const found = /^Found (\d+)/.exec(text);
      return found ? `${plural(Number(found[1]), 'match')}` : `${plural(lines.length, 'result')}`;
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return 'Saved';
    case 'Agent':
    case 'Task': return 'Helper agent reported back';
  }
  return clip(lines[0] || 'Done', 140);
}

function cleanUserText(raw) {
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\[Image: source:.*$/gm, '')
    .trim();
  if (!text) return null;
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return { text: `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim() };
  }
  if (/^\[Request interrupted/.test(text)) return { notice: true, text: 'You interrupted the agent' };
  if (text.startsWith('<')) {
    if (/<local-command-std(out|err)>/.test(text)) return null;
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text);
    if (/<task-notification>/.test(text)) return { notice: true, text: clip(summary ? summary[1] : 'A background task reported back', 300) };
    const stripped = text.replace(/<[^>]+>/g, ' ');
    return stripped.trim() ? { notice: true, text: clip(stripped, 300) } : null;
  }
  return { text: clipRaw(text, 1200) };
}

class TranscriptParser {
  constructor() {
    this.tools = new Map();   // tool_use id -> { name, agent, ts }
    this.usage = new Map();   // message id -> output tokens already counted
    this.ended = new Set();   // message ids that already produced an 'idle' event
    this.model = null;
    this.cwd = null;
    this.title = null;
  }

  ingest(rec, fileAgent, out) {
    const agent = rec.isSidechain && rec.agentId ? rec.agentId : fileAgent;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (!this.cwd && rec.cwd && agent === 'main') {
      this.cwd = rec.cwd;
      out.push({ t: 'meta', cwd: rec.cwd });
    }
    switch (rec.type) {
      case 'ai-title':
      case 'summary': {
        const title = rec.aiTitle || rec.summary;
        if (title && title !== this.title) out.push({ t: 'meta', title: (this.title = title) });
        break;
      }
      case 'system':
        if (rec.subtype === 'api_error') {
          const e = rec.error || {};
          const retry = rec.retryAttempt ? ` (retry ${rec.retryAttempt}/${rec.maxRetries || '?'})` : '';
          out.push({ t: 'error', agent, ts, text: `API error: ${e.formatted || e.message || 'unknown'}${retry}` });
        }
        break;
      case 'user': this.user(rec, agent, ts, out); break;
      case 'assistant': this.assistant(rec, agent, ts, out); break;
    }
  }

  user(rec, agent, ts, out) {
    if (rec.isMeta || !rec.message) return;
    if (rec.isCompactSummary) {
      out.push({ t: 'notice', agent, ts, text: 'Conversation was compacted to free up memory' });
      return;
    }
    const content = rec.message.content;
    const texts = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_result') this.result(b, rec, agent, ts, out);
        else if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'image') texts.push('[image attached]');
      }
    }
    if (!texts.length) return;
    const msg = cleanUserText(texts.join('\n'));
    if (msg) out.push({ t: msg.notice ? 'notice' : 'prompt', agent, ts, text: msg.text });
  }

  result(b, rec, agent, ts, out) {
    const tool = this.tools.get(b.tool_use_id);
    const ok = !b.is_error;
    const text = resultText(b.content);
    out.push({
      t: 'result',
      agent: tool ? tool.agent : agent,
      ts,
      id: b.tool_use_id,
      ok,
      ms: tool && ts && tool.ts ? Math.max(0, ts - tool.ts) : null,
      summary: summarize(tool ? tool.name : '', text, ok),
      output: clipRaw(text, 1200),
    });
    const r = rec.toolUseResult;
    if (r && typeof r === 'object' && r.agentId && /complete|fail|error|kill|cancel|stop/i.test(r.status || '')) {
      out.push({
        t: 'agent_done', agent: r.agentId, ts,
        ok: /complete/i.test(r.status),
        tokens: r.totalTokens || 0, tools: r.totalToolUseCount || 0, ms: r.totalDurationMs || 0,
      });
    }
  }

  assistant(rec, agent, ts, out) {
    const msg = rec.message;
    if (!msg || !Array.isArray(msg.content)) return;
    if (agent === 'main' && msg.model && !msg.model.startsWith('<') && msg.model !== this.model) {
      this.model = msg.model;
      out.push({ t: 'meta', model: msg.model });
    }
    if (msg.usage && msg.id) {
      const prev = this.usage.get(msg.id) || 0;
      const now = msg.usage.output_tokens || 0;
      if (now > prev) {
        this.usage.set(msg.id, now);
        out.push({ t: 'usage', agent, ts, out: now - prev });
      }
    }
    let thought = false;
    for (const b of msg.content) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        if (!thought) out.push({ t: 'think', agent, ts });
        thought = true;
      } else if (b.type === 'text') {
        const text = (b.text || '').trim();
        if (text) out.push({ t: 'text', agent, ts, text: clipRaw(text, 2000) });
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        this.toolUse(b, agent, ts, out);
      }
    }
    const hasTool = msg.content.some(b => b.type === 'tool_use');
    if (msg.stop_reason === 'end_turn' && !hasTool && !this.ended.has(msg.id)) {
      this.ended.add(msg.id);
      out.push({ t: 'idle', agent, ts });
    }
  }

  toolUse(b, agent, ts, out) {
    if (!b.id || this.tools.has(b.id)) return;
    const input = b.input || {};
    this.tools.set(b.id, { name: b.name, agent, ts });
    out.push({
      t: 'tool', agent, ts, id: b.id, name: b.name, cat: categorize(b.name),
      ...describeTool(b.name, input), input: trimInput(input),
    });
  }

  // Called when a subagent's .meta.json is discovered.
  spawn(id, meta, out) {
    const tool = meta.toolUseId && this.tools.get(meta.toolUseId);
    out.push({
      t: 'agent', agent: id, ts: tool ? tool.ts + 1 : 0,
      parent: tool ? tool.agent : 'main', toolId: meta.toolUseId || null,
      kind: meta.agentType || 'helper', desc: meta.description || '',
    });
  }
}

module.exports = { TranscriptParser };
