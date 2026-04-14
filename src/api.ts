import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import { Card, createCard, cardDuration, cardStatusIcon } from './card.js';

/**
 * API mode: machine-readable JSONL interface for AI agents.
 * No TUI, no alternate screen. Communication via stdin/stdout JSON Lines.
 *
 * Agent sends commands on stdin (one JSON per line):
 *   {"cmd": "run", "command": "npm test"}
 *   {"cmd": "list"}
 *   {"cmd": "get", "card": 0}
 *   {"cmd": "get", "card": 0, "lines": [0, 10]}
 *   {"cmd": "kill", "card": 0}
 *   {"cmd": "search", "pattern": "error", "regex": true}
 *   {"cmd": "clear"}
 *   {"cmd": "summary"}
 *   {"cmd": "exit"}
 *
 * htui responds with events on stdout (one JSON per line):
 *   {"event": "ready", "version": 2}
 *   {"event": "card_created", "card": 0, "title": "npm test", "status": "active"}
 *   {"event": "card_output", "card": 0, "line": "PASS utils.test.ts", "stream": "stdout"}
 *   {"event": "card_done", "card": 0, "status": "done", "exitCode": 0, "duration": "2.1s"}
 *   {"event": "cards", "cards": [{...}]}
 *   {"event": "card_content", "card": 0, "lines": [...], "status": "done", "duration": "2.1s"}
 *   {"event": "card_killed", "card": 0, "signal": "SIGTERM"}
 *   {"event": "search_results", "pattern": "error", "matches": [...]}
 *   {"event": "cleared", "killedCards": 0, "clearedCards": 3}
 *   {"event": "summary", "total": 5, "active": 1, "done": 3, "failed": 1}
 *   {"event": "error", "message": "..."}
 */
export class ApiMode {
  private cards: Card[] = [];
  private activeChildren: Map<number, ChildProcess> = new Map();
  private timeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private cardOptions: Map<number, any> = new Map();
  private defaultCwd: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd || process.cwd();
  }

  async start(): Promise<void> {
    this.emit({ event: 'ready', version: 2 });

    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on('line', (line) => {
      this.handleLine(line);
    });

    rl.on('close', () => {
      this.cleanup();
      process.exit(0);
    });

    // Keep alive
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        this.cleanup();
        resolve();
      });
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit({ event: 'error', message: `Invalid JSON: ${line}` });
      return;
    }

    switch (msg.cmd) {
      case 'run':
        this.handleRun(msg);
        break;
      case 'list':
        this.handleList(msg);
        break;
      case 'get':
        this.handleGet(msg.card, msg.lines, msg.stream);
        break;
      case 'kill':
        this.handleKill(msg);
        break;
      case 'search':
        this.handleSearch(msg);
        break;
      case 'clear':
        this.handleClear(msg);
        break;
      case 'summary':
        this.handleSummary();
        break;
      case 'exit':
        this.cleanup();
        process.exit(0);
        break;
      default:
        this.emit({ event: 'error', message: `Unknown command: ${msg.cmd}` });
    }
  }

  private handleRun(msg: any): void {
    const command = msg.command;
    if (!command) {
      this.emit({ event: 'error', message: 'Missing "command" field', cmd: 'run' });
      return;
    }

    const cardIndex = this.cards.length;
    const card = createCard(command, 'active');
    card.startedAt = Date.now();
    if (msg.cwd) card.cwd = msg.cwd;
    this.cards.push(card);

    // Store run options for this card
    this.cardOptions.set(cardIndex, {
      silent: msg.silent || false,
      wait: msg.wait || false,
      tag: msg.tag,
    });

    this.emit({
      event: 'card_created',
      card: cardIndex,
      title: command,
      status: 'active',
      ...(msg.tag ? { tag: msg.tag } : {}),
      ...(msg.cwd ? { cwd: msg.cwd } : {}),
    });

    const cwd = msg.cwd || this.defaultCwd;
    const env = msg.env ? { ...process.env, ...msg.env } : process.env;

    // Validate cwd exists
    if (msg.cwd && !fs.existsSync(msg.cwd)) {
      card.status = 'failed';
      card.finishedAt = Date.now();
      card.exitCode = 1;
      card.lines.push(`Error: directory does not exist: ${msg.cwd}`);
      card.taggedLines.push({ text: `Error: directory does not exist: ${msg.cwd}`, stream: 'stderr' });
      this.emit({
        event: 'card_done',
        card: cardIndex,
        status: 'failed',
        exitCode: 1,
        duration: cardDuration(card),
        lineCount: 1,
        ...(msg.tag ? { tag: msg.tag } : {}),
        ...(msg.wait ? { lines: card.lines } : {}),
      });
      return;
    }

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });

    this.activeChildren.set(cardIndex, child);

    // Timeout handling
    if (msg.timeout && msg.timeout > 0) {
      const timer = setTimeout(() => {
        this.timeouts.delete(cardIndex);
        card.status = 'timeout';
        child.kill();
      }, msg.timeout);
      this.timeouts.set(cardIndex, timer);
    }

    const options = this.cardOptions.get(cardIndex)!;
    const shouldStream = !options.silent && !options.wait;

    // Process stdout
    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const cleanLine = line.replace(/\r$/, '');
        card.lines.push(cleanLine);
        card.taggedLines.push({ text: cleanLine, stream: 'stdout' });
        if (shouldStream) {
          this.emit({
            event: 'card_output',
            card: cardIndex,
            line: cleanLine,
            stream: 'stdout',
            ...(options.tag ? { tag: options.tag } : {}),
          });
        }
      }
    });

    // Process stderr
    let stderrBuffer = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const cleanLine = line.replace(/\r$/, '');
        card.lines.push(cleanLine);
        card.taggedLines.push({ text: cleanLine, stream: 'stderr' });
        if (shouldStream) {
          this.emit({
            event: 'card_output',
            card: cardIndex,
            line: cleanLine,
            stream: 'stderr',
            ...(options.tag ? { tag: options.tag } : {}),
          });
        }
      }
    });

    child.on('close', (code, signal) => {
      // Flush remaining buffers
      if (stdoutBuffer) {
        const cleanLine = stdoutBuffer.replace(/\r$/, '');
        card.lines.push(cleanLine);
        card.taggedLines.push({ text: cleanLine, stream: 'stdout' });
        if (shouldStream) {
          this.emit({ event: 'card_output', card: cardIndex, line: cleanLine, stream: 'stdout', ...(options.tag ? { tag: options.tag } : {}) });
        }
      }
      if (stderrBuffer) {
        const cleanLine = stderrBuffer.replace(/\r$/, '');
        card.lines.push(cleanLine);
        card.taggedLines.push({ text: cleanLine, stream: 'stderr' });
        if (shouldStream) {
          this.emit({ event: 'card_output', card: cardIndex, line: cleanLine, stream: 'stderr', ...(options.tag ? { tag: options.tag } : {}) });
        }
      }

      // Clear timeout if set
      const timer = this.timeouts.get(cardIndex);
      if (timer) {
        clearTimeout(timer);
        this.timeouts.delete(cardIndex);
      }

      card.finishedAt = Date.now();
      this.activeChildren.delete(cardIndex);

      // Set status (don't override if already set to 'timeout' or 'killed')
      if (card.status === 'active') {
        card.exitCode = code ?? 1;
        card.status = code === 0 ? 'done' : 'failed';
      } else if (card.status === 'timeout') {
        card.exitCode = code ?? 1;
      } else if (card.status === 'killed') {
        card.exitCode = code ?? 1;
      }

      if (signal) card.signal = signal;

      const doneEvent: Record<string, unknown> = {
        event: 'card_done',
        card: cardIndex,
        status: card.status,
        exitCode: card.exitCode,
        duration: cardDuration(card),
        lineCount: card.lines.length,
      };
      if (options.tag) doneEvent.tag = options.tag;
      if (options.wait) doneEvent.lines = card.lines;

      this.emit(doneEvent);
      this.cardOptions.delete(cardIndex);
    });
  }

  private handleKill(msg: any): void {
    const cardIndex = msg.card;
    if (cardIndex == null || cardIndex < 0 || cardIndex >= this.cards.length) {
      this.emit({ event: 'error', message: `Invalid card index: ${cardIndex}`, cmd: 'kill' });
      return;
    }

    const child = this.activeChildren.get(cardIndex);
    if (!child) {
      this.emit({ event: 'error', message: `Card ${cardIndex} is not active`, cmd: 'kill' });
      return;
    }

    const signal = msg.signal || 'SIGTERM';
    this.cards[cardIndex].status = 'killed';
    this.cards[cardIndex].signal = signal;
    child.kill(signal);

    this.emit({ event: 'card_killed', card: cardIndex, signal });
  }

  private handleSearch(msg: any): void {
    const pattern = msg.pattern;
    if (!pattern) {
      this.emit({ event: 'error', message: 'Missing "pattern" field', cmd: 'search' });
      return;
    }

    let matcher: (text: string) => boolean;
    if (msg.regex) {
      try {
        const flags = msg.ignoreCase !== false ? 'i' : '';
        const re = new RegExp(pattern, flags);
        matcher = (text) => re.test(text);
      } catch (e: any) {
        this.emit({ event: 'error', message: `Invalid regex: ${e.message}`, cmd: 'search' });
        return;
      }
    } else {
      const searchStr = msg.ignoreCase !== false ? pattern.toLowerCase() : pattern;
      matcher = msg.ignoreCase !== false
        ? (text) => text.toLowerCase().includes(searchStr)
        : (text) => text.includes(pattern);
    }

    const limit = msg.limit || 100;
    const cardFilter = msg.cards ? new Set(msg.cards as number[]) : null;
    const streamFilter = msg.stream || null;

    const matches: any[] = [];

    for (let ci = 0; ci < this.cards.length; ci++) {
      if (cardFilter && !cardFilter.has(ci)) continue;

      const card = this.cards[ci];
      for (let li = 0; li < card.taggedLines.length; li++) {
        const tagged = card.taggedLines[li];
        if (streamFilter && tagged.stream !== streamFilter) continue;
        if (matcher(tagged.text)) {
          matches.push({
            card: ci,
            title: card.title,
            lineNumber: li,
            line: tagged.text,
            stream: tagged.stream,
          });
          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }

    this.emit({
      event: 'search_results',
      pattern,
      matches,
      totalMatches: matches.length,
      truncated: matches.length >= limit,
    });
  }

  private handleClear(msg: any): void {
    const killActive = msg.killActive !== false; // default true
    let killedCount = 0;

    if (killActive) {
      for (const [cardIdx, child] of this.activeChildren) {
        this.cards[cardIdx].status = 'killed';
        this.cards[cardIdx].finishedAt = Date.now();
        child.kill();
        killedCount++;
      }
    }

    const clearedCount = this.cards.length;
    this.cards = [];
    this.activeChildren.clear();
    this.cardOptions.clear();
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();

    this.emit({ event: 'cleared', killedCards: killedCount, clearedCards: clearedCount });
  }

  private handleSummary(): void {
    const counts: Record<string, number> = {
      total: this.cards.length,
      active: 0, done: 0, failed: 0, killed: 0, timeout: 0, queued: 0, blocked: 0,
    };
    for (const card of this.cards) {
      counts[card.status] = (counts[card.status] || 0) + 1;
    }
    this.emit({ event: 'summary', ...counts });
  }

  private handleList(msg?: any): void {
    let filteredCards = this.cards.map((card, i) => ({ card: i, ...card }));

    if (msg?.status) {
      const statuses = Array.isArray(msg.status) ? msg.status : [msg.status];
      filteredCards = filteredCards.filter(c => statuses.includes(c.status));
    }

    this.emit({
      event: 'cards',
      cards: filteredCards.map(c => ({
        card: c.card,
        title: c.title,
        status: c.status,
        exitCode: c.exitCode,
        duration: cardDuration(c as any),
        lineCount: c.lines.length,
      })),
    });
  }

  private handleGet(cardIndex: number, lineRange?: [number, number], stream?: string): void {
    if (cardIndex == null || cardIndex < 0 || cardIndex >= this.cards.length) {
      this.emit({ event: 'error', message: `Invalid card index: ${cardIndex}`, cmd: 'get' });
      return;
    }

    const card = this.cards[cardIndex];
    let lines: string[];

    if (stream) {
      // Filter by stream
      lines = card.taggedLines
        .filter(tl => tl.stream === stream)
        .map(tl => tl.text);
    } else {
      lines = card.lines;
    }

    if (lineRange && Array.isArray(lineRange) && lineRange.length === 2) {
      lines = lines.slice(lineRange[0], lineRange[1]);
    }

    this.emit({
      event: 'card_content',
      card: cardIndex,
      title: card.title,
      status: card.status,
      exitCode: card.exitCode,
      duration: cardDuration(card),
      lineCount: lines.length,
      lines,
    });
  }

  private cleanup(): void {
    for (const [, child] of this.activeChildren) {
      child.kill();
    }
    this.activeChildren.clear();
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
  }

  private emit(data: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(data) + '\n');
  }
}
