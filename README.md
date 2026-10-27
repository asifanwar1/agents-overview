# AGENT//OVERVIEW

A live, sci-fi style visualizer for what Claude Code is doing while it works.

![core](https://img.shields.io/badge/deps-none-00e5ff) ![node](https://img.shields.io/badge/node-%E2%89%A518-39ff9f)

## Run

```bash
npm start          # opens http://localhost:4317 in your browser
npm run dev        # same, without auto-opening a browser
PORT=5000 npm start
```

Keep it open in a browser tab next to VS Code / your terminal while you use Claude Code.

There are two views, switched with the buttons at the top:

- **◉ FOCUS** shows one session in full detail. With **AUTO-FOLLOW** on it jumps to whichever session is
  currently active. Pick any past session from the dropdown to replay what happened, or link straight to one
  with `?session=<project-folder>/<session-id>`.
- **▦ FLEET** shows several sessions at once as a grid of live tiles (4, 6 or 9), live sessions first.
  Each tile has its own animated core and current action. The Activity Stream merges all of them, tagged by project.
  Click a tile to open it in FOCUS view. Link straight to it with `?view=fleet`.

## What you're looking at

| Visual | Meaning |
| --- | --- |
| Glowing cyan core | The main Claude agent. Rings spin faster while it works; ripples mean it's thinking. |
| Hexagon nodes on the inner orbit | Tool calls running **right now**, with energy flowing out from the core |
| Hexagon nodes on the outer ring | Recently finished tool calls (older ones fade). A green flash = success, red ✕ = failure |
| Magenta satellite cores | Helper agents (subagents) Claude launched, linked by an energy beam. They turn green when they report back |
| Particles flowing back to a core | A tool's result being returned |
| Purple particles from far away | Web searches / page fetches pulling data in |
| Directive banner | Your latest prompt |
| Transmission box | What Claude last said |
| Bottom center bar | The single most recent action, with a live timer |

Node colours: **cyan** reading · **green** writing/editing · **amber** commands · **violet** web · **magenta** agents · **blue** planning · **teal** connectors (MCP).

Click any card in the Activity Stream to see the raw tool input and output.

## How it works

Claude Code writes every session to `~/.claude/projects/<project>/<session>.jsonl`, with helper agents in
`<session>/subagents/agent-<id>.jsonl`. The Node server tails those files (read-only), turns each record into a
small event, and streams them to the page over Server-Sent Events. Nothing in Claude Code needs to be configured.

```
server.js          HTTP server, session list API, live event stream
lib/sessions.js    finds sessions on disk and their titles
lib/watcher.js     tails a session + its subagent transcripts
lib/transcript.js  turns raw records into plain-language events
public/            the dashboard (canvas graph + panels), no build step
```

The server only listens on `127.0.0.1`, so the dashboard is visible only on your machine.
Set `CLAUDE_CONFIG_DIR` if your Claude data lives somewhere other than `~/.claude`.
