# htui — Agent Instructions

Structured terminal for AI agents. Run commands, get clean JSON output — no ANSI parsing, no interleaving.

## Quick Start

Start htui once per session:
```
node node_modules/htui/dist/cli.js --api
```

Then run commands:
```json
{"cmd": "run", "command": "npm test", "wait": true, "timeout": 30000}
```
→ Returns `card_done` with all output in `lines` array when finished.

## Quick Pattern — Use This for Most Commands

Use `"wait": true` for any command you want to run and get results from. htui buffers all output and returns it in one response when the command finishes.

**Run and wait:**
```json
{"cmd": "run", "command": "npm test", "wait": true, "timeout": 30000}
```
Response:
```json
{"event": "card_done", "card": 0, "status": "done", "exitCode": 0, "duration": "2.1s", "lineCount": 42, "lines": ["PASS src/utils.test.ts", "..."]}
```

**Search across output:**
```json
{"cmd": "search", "pattern": "error|FAIL", "regex": true}
```
Response:
```json
{"event": "search_results", "pattern": "error|FAIL", "matches": [{"card": 0, "lineNumber": 12, "line": "FAIL src/bad.test.ts", "stream": "stderr"}], "totalMatches": 1, "truncated": false}
```

**Get only stderr from a card:**
```json
{"cmd": "get", "card": 0, "stream": "stderr"}
```

## All Commands

| Command | Required Fields | Optional Fields | Description |
|---------|----------------|-----------------|-------------|
| `run` | `command` | `wait`, `timeout`, `cwd`, `env`, `silent`, `tag` | Run a shell command |
| `get` | `card` | `lines`, `stream` | Get output from a card |
| `list` | — | `status` | List all cards |
| `search` | `pattern` | `regex`, `ignoreCase`, `stream`, `cards`, `limit` | Search across card output |
| `kill` | `card` | `signal` | Kill an active command |
| `summary` | — | — | Get counts by status |
| `clear` | — | `killActive` | Kill active + clear all cards |
| `exit` | — | — | Shut down htui |

### Run options detail

- `wait: true` — buffer output, return all lines in `card_done` (recommended)
- `timeout: ms` — kill command after timeout, status becomes `"timeout"`
- `silent: true` — suppress streaming `card_output` events (like `wait` but no lines in response)
- `cwd: "/path"` — working directory for the command
- `env: {"KEY": "val"}` — extra environment variables
- `tag: "build"` — label to identify the card in events

### Get options detail

- `lines: [start, end]` — slice of output lines (0-indexed)
- `stream: "stdout"|"stderr"` — filter by output stream

### Search options detail

- `regex: true` — treat pattern as regex
- `ignoreCase: true` — case-insensitive (default: true)
- `stream: "stdout"|"stderr"` — search only one stream
- `cards: [0, 2]` — search only specific cards
- `limit: 50` — max matches to return (default: 100)

### List options detail

- `status: "active"` or `status: ["done", "failed"]` — filter by card status

## All Events

| Event | Key Fields | When |
|-------|-----------|------|
| `ready` | `version: 2` | htui started |
| `card_created` | `card`, `title`, `status` | Command started |
| `card_output` | `card`, `line`, `stream` | New output line (streaming mode only) |
| `card_done` | `card`, `status`, `exitCode`, `duration`, `lineCount`, `lines?` | Command finished |
| `card_content` | `card`, `lines`, `status`, `exitCode`, `duration` | Response to `get` |
| `card_killed` | `card`, `signal` | Response to `kill` |
| `cards` | `cards[]` | Response to `list` |
| `search_results` | `pattern`, `matches[]`, `totalMatches`, `truncated` | Response to `search` |
| `summary` | `total`, `active`, `done`, `failed`, `killed`, `timeout` | Response to `summary` |
| `cleared` | `killedCards`, `clearedCards` | Response to `clear` |
| `error` | `message` | Invalid command or args |

Card statuses: `active`, `done`, `failed`, `killed`, `timeout`

## Tips

- **Always use `wait: true`** unless you need real-time streaming for long-running processes
- **Set `timeout`** on every `wait` command to avoid hanging (30s for tests, 60s for builds)
- **Use `search`** to find errors/failures instead of scanning all output lines manually
- **Use `get` with `stream: "stderr"`** to isolate error output
- **Cards are numbered 0, 1, 2...** — use `list` if you lose track
- **One htui session per workspace** — start once, reuse for all commands
