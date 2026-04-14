#!/usr/bin/env node

import { App, AppOptions } from './app.js';
import { ChunkOptions } from './chunker.js';
import { ApiMode } from './api.js';
import { initAgentInstructions, printInitHelp } from './init.js';

function printUsage(): void {
  console.log(`
htui — Horizontal Terminal UI

Usage:
  htui                            Interactive shell — type commands, output flows as cards
  htui run "cmd1" "cmd2" ...     Run commands as horizontal cards
  htui wrap "command"             Run a command with paged output (works everywhere)
  command | htui                  Pipe output into horizontal pages
  command | htui --chunk-by time --interval 5s
  htui --api                      Machine-readable JSONL mode for AI agents
  htui --api --api-cwd /path      API mode with custom working directory

Options:
  --chunk-by <mode>     Chunking mode: page-fill (default), time, blank
  --interval <duration> Interval for time-based chunking (e.g. 5s, 1m)
  --api                 API mode: JSONL on stdin/stdout for programmatic control
  --api-cwd <path>      Set default working directory for API mode commands
  --help                Show this help message
  --version             Show version

Navigation (TUI modes):
  ← →      Scroll between cards
  Enter     Expand selected card full-screen
  Esc       Back to card view
  f         Toggle auto-follow
  q         Quit

API mode commands (JSON on stdin):
  {"cmd": "run", "command": "..."}     Run a command, output streams as events
  {"cmd": "list"}                       List all cards with status
  {"cmd": "get", "card": 0}            Get full content of a card
  {"cmd": "kill", "card": 0}           Kill an active command
  {"cmd": "search", "pattern": "..."}  Search across card output
  {"cmd": "clear"}                      Clear all cards
  {"cmd": "summary"}                    Get status summary counts
  {"cmd": "exit"}                       Exit htui
`);
}

function parseInterval(str: string): number {
  const match = str.match(/^(\d+)(ms|s|m)$/);
  if (!match) {
    console.error(`Invalid interval: ${str}. Use format like 5s, 1000ms, or 1m`);
    process.exit(1);
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60000;
    default: return value * 1000;
  }
}

function parseArgs(argv: string[]): AppOptions {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log('htui 0.1.0');
    process.exit(0);
  }

  // Run mode: htui run "cmd1" "cmd2" ...
  if (args[0] === 'run') {
    const commands = args.slice(1).filter(a => !a.startsWith('--'));
    if (commands.length === 0) {
      console.error('Error: htui run requires at least one command');
      console.error('Usage: htui run "cmd1" "cmd2" ...');
      process.exit(1);
    }
    return {
      mode: 'run',
      commands,
    };
  }

  // Wrap mode: htui wrap "command" [options]
  if (args[0] === 'wrap') {
    const wrapCommand = args[1];
    if (!wrapCommand || wrapCommand.startsWith('--')) {
      console.error('Error: htui wrap requires a command');
      console.error('Usage: htui wrap "command"');
      process.exit(1);
    }

    let chunkMode: ChunkOptions['mode'] = 'page-fill';
    let interval: number | undefined;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--chunk-by' && args[i + 1]) {
        const mode = args[i + 1];
        if (mode === 'time' || mode === 'blank' || mode === 'page-fill') {
          chunkMode = mode;
        } else {
          console.error(`Unknown chunk mode: ${mode}. Use: page-fill, time, blank`);
          process.exit(1);
        }
        i++;
      } else if (args[i] === '--interval' && args[i + 1]) {
        interval = parseInterval(args[i + 1]);
        i++;
      }
    }

    if (chunkMode === 'time' && !interval) {
      interval = 5000;
    }

    return {
      mode: 'wrap',
      wrapCommand,
      chunkOptions: {
        mode: chunkMode,
        interval,
      },
    };
  }

  // Pipe mode: command | htui [options]
  let chunkMode: ChunkOptions['mode'] = 'page-fill';
  let interval: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chunk-by' && args[i + 1]) {
      const mode = args[i + 1];
      if (mode === 'time' || mode === 'blank' || mode === 'page-fill') {
        chunkMode = mode;
      } else {
        console.error(`Unknown chunk mode: ${mode}. Use: page-fill, time, blank`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--interval' && args[i + 1]) {
      interval = parseInterval(args[i + 1]);
      i++;
    }
  }

  if (chunkMode === 'time' && !interval) {
    interval = 5000; // default 5s
  }

  return {
    mode: 'pipe',
    chunkOptions: {
      mode: chunkMode,
      interval,
    },
  };
}

async function main(): Promise<void> {
  // Init command: install agent instructions
  if (process.argv[2] === 'init') {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      printInitHelp();
      return;
    }
    const agents = process.argv.slice(3).filter(a => !a.startsWith('-'));
    await initAgentInstructions(process.cwd(), agents.length > 0 ? agents : undefined);
    return;
  }

  // API mode: machine-readable JSONL for AI agents
  if (process.argv.includes('--api')) {
    const cwdIdx = process.argv.indexOf('--api-cwd');
    const apiCwd = cwdIdx >= 0 && process.argv[cwdIdx + 1] ? process.argv[cwdIdx + 1] : undefined;
    const api = new ApiMode(apiCwd);
    await api.start();
    return;
  }

  const options = parseArgs(process.argv);

  // If pipe mode but stdin is TTY (no pipe), launch interactive shell mode
  if (options.mode === 'pipe' && process.stdin.isTTY) {
    options.mode = 'shell';
  }

  const app = new App(options);
  await app.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
