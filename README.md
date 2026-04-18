<p align="center">
  <br />
  <strong>htui</strong>
  <br />
  <em>Horizontal Terminal UI</em>
  <br />
  <br />
  A structured terminal for AI coding agents — and for you.
  <br />
  <br />

  [![npm version](https://img.shields.io/npm/v/@epeer1/htui.svg)](https://www.npmjs.com/package/@epeer1/htui)
  [![license](https://img.shields.io/npm/l/@epeer1/htui.svg)](https://github.com/epeer1/htui/blob/main/LICENSE)
  [![node](https://img.shields.io/node/v/@epeer1/htui.svg)](https://nodejs.org)
  [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#how-it-works)

</p>

---

htui is a local MCP server that gives your coding agent a real terminal: structured JSON output, parallel runs, and searchable history across the session. It also runs a read-only TUI (`htui watch`) so you can see every command the agent fires, live, in a sidebar terminal. Zero runtime dependencies, one command to install, works with any MCP-capable client.

```
 htui — watch   ~/work/api-server                       ╭ ● connected ╮  3 cards  ▶ follow   agent
────────────────────────────────────────────────────────────────────────────────────────────────
 ╭─ ✔ npm test ──────────────╮ ╭─ ⠹ tsc --noEmit ──────────╮ ╭─ ✘ eslint . ──────────────╮
 │ PASS  src/parser.test.ts  │ │ src/api.ts:42:7           │ │                            │
 │ PASS  src/runner.test.ts  │ │   error TS2345: Argument  │ │ /src/cli.ts                │
 │ PASS  src/store.test.ts   │ │   of type 'string' is not │ │   18:1  error  Unexpected  │
 │                           │ │   assignable to parameter │ │         console statement  │
 │ Tests: 24 passed, 24      │ │   of type 'number'.       │ │                            │
 │ Snapshots: 0 total        │ │                           │ │ ✖ 1 problem (1 error, 0    │
 │ Time:   1.84s             │ │ Found 1 error in 1 file.  │ │   warnings)                │
 │                           │ │                           │ │                            │
 ├───────────────────────────┤ ├───────────────────────────┤ ├────────────────────────────┤
 │ done           1.8s   ⏎ 0 │ │ active        2.1s        │ │ failed         0.4s   ⏎ 1  │
 ╰───────────────────────────╯ ╰───────────────────────────╯ ╰────────────────────────────╯

  ●  ○  ◉                                                                            1–3 / 3
  ← →  move    Enter expand    f follow    /  filter    g/G  jump    q  quit
```

## Why htui

Your agent runs commands in your terminal. You can't see what it ran; it can't reuse what came back; both of you burn tokens parsing walls of ANSI.

- **Structured output the agent can actually use.** `htui_exec` returns `{ stdout[], stderr[], exitCode, durationMs, truncated }` with ANSI stripped, CRLF normalized, progress bars collapsed. No more re-prompting the model to "ignore the spinner frames."
- **Real parallelism.** `htui_run` returns a `cardId` immediately. Fire `npm test`, `tsc --noEmit`, and `eslint .` at once, then `htui_tail` whichever finishes first. Built-in `run_in_terminal` tools block the agent's whole turn on a single command.
- **Search across the whole session.** `htui_search "TS2345"` regex-scans every card the agent has run this session and returns matching lines with cardId + line number. No re-running the suite, no re-reading 4 KB of logs.

## Compatibility

**Works with:** GitHub Copilot Chat · Cursor · Windsurf · Claude Code · Gemini / Antigravity — any MCP client.
**Runs on:** Windows · macOS · Linux · WSL. **Requires:** Node ≥ 18.

## 30-second install

```bash
# Pick one:
npm i -D @epeer1/htui      # project-local (recommended)
npm i -g @epeer1/htui      # global
npx @epeer1/htui init      # zero-install

# Then, from your project root:
npx htui init --yes        # writes .vscode/mcp.json + agent instructions
# Reload VS Code (or restart your agent) to pick up the MCP server.

# Optional: watch what the agent is doing, in any side terminal:
npx htui watch
```

## What you get

### What the agent sees

```json
{
  "ok": true,
  "cardId": "c_8f2a",
  "exitCode": 0,
  "status": "done",
  "durationMs": 1843,
  "stdout": [
    "PASS  src/parser.test.ts",
    "PASS  src/runner.test.ts",
    "Tests: 24 passed, 24 total"
  ],
  "stderr": [],
  "truncated": false,
  "stdoutTotalLines": 18,
  "stderrTotalLines": 0
}
```

### What you see

A new card slides in when the agent starts a command. Status turns green on exit 0, red on non-zero. Press `Enter` on any card to expand its full output.

*Same data. Both audiences happy.*

## The 8 MCP tools

| Tool | Description | When to use |
|---|---|---|
| `htui_exec` | Run a command and wait. Returns `stdout`, `stderr`, `exitCode`, `durationMs`, `cardId`. | Quick one-shot, want the output |
| `htui_run` | Start a command in the background. Returns `cardId` immediately. | Long-running or parallel work |
| `htui_tail` | Block until a card has new output or finishes. | Poll a running command |
| `htui_get` | Fetch card output by `cardId`. Supports `range: [start, end]` and `stream: 'stdout' \| 'stderr' \| 'both'`. | Need everything one card produced |
| `htui_search` | Regex / substring search across cards. | Find an error you saw earlier |
| `htui_list` | List cards with status, title, exit code, duration. | "Which tests have I run?" |
| `htui_kill` | Terminate an active card (`SIGTERM` / `SIGKILL`; Windows uses `taskkill /T /F`). | Cancel a runaway process |
| `htui_summary` | Counts by status plus the 5 most recent cards. | Status check at end of turn |

## CLI commands

| Command | What it does |
|---|---|
| `htui init [agents...]` | Configure MCP, agent instructions, and the watch script. `--yes` / `-y` / `--no-prompt` skips prompts. |
| `htui mcp [--workspace <path>]` | Run as an MCP stdio server. Normally invoked by your agent, not by humans. |
| `htui watch [--workspace <path>]` | Live TUI view of agent terminal activity. |
| `htui exec "<command>"` | Fallback: run a command and print a structured JSON result. |
| `htui --api` | Legacy: interactive JSON-over-stdio API for scripted agents. |

`htui init` auto-detects how `htui` is installed and writes one of these `command` entries into `.vscode/mcp.json`:

```text
Global:  <abs-path-to-node> <abs-path-to-cli.js> mcp --workspace ${workspaceFolder}
Local:   node node_modules/@epeer1/htui/dist/cli.js mcp --workspace ${workspaceFolder}
npx:     npx -y @epeer1/htui mcp --workspace ${workspaceFolder}
```

For global installs, htui resolves both the Node binary and its own CLI script to absolute, symlink-followed paths so the MCP client can spawn it without relying on inherited `PATH` (e.g. when VS Code is launched from Finder or the Dock on macOS). Re-run `htui init` if you switch Node versions.

An existing `.vscode/mcp.json` is merged in place: other MCP servers are preserved, the file's tab/space indent is preserved, and JSONC comments are stripped on parse.

## `htui watch` controls

| Key | Action |
|---|---|
| `←` `→` | Move selection |
| `Enter` | Expand focused card |
| `Esc` | Collapse expanded view |
| `f` | Toggle follow (auto-jump to newest) |
| `g` / `G` | Jump to first / last card |
| `/` | Filter by title; `Esc` clears |
| `q` / `Ctrl-C` | Quit |

## How it works

`htui mcp` runs as a stdio JSON-RPC server. Each command becomes a *card* in an in-process ring buffer (200 cards × 5000 lines each); cards are streamed to any attached `htui watch` client over a per-workspace local socket (named pipe on Windows, Unix domain socket under `$XDG_RUNTIME_DIR` elsewhere). Process trees are killed cleanly via POSIX signals or `taskkill /T /F` on Windows.

## Configuration

- `--workspace <path>` — override the workspace root (otherwise CWD).
- `HTUI_WORKSPACE` — same, as env var. Used by `htui watch` to find the right socket.
- `HTUI_NO_ANIM=1` — disable card slide-in / pulse animations in `htui watch`.

## FAQ / Troubleshooting

- **Agent doesn't see the htui tools.** Reload your editor window after `htui init` so the MCP server is spawned. In VS Code: *Developer: Reload Window*.
- **`htui watch` says "waiting for agent".** The MCP server is started on demand by your client. Open Copilot Chat (or your agent's chat panel) once — that triggers the spawn — and `watch` will connect.
- **Does it work in WSL?** Yes. Run htui inside the WSL distro; it behaves as Linux and uses `$XDG_RUNTIME_DIR` for the socket.
- **Can two devs share one watch session?** No. Sockets are scoped to the local user and workspace by hash; there's no network transport.

## License

MIT — see [LICENSE](LICENSE).
