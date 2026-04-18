/**
 * MCP JSON-RPC 2.0 stdio server for htui.
 *
 * - Newline-delimited JSON (NDJSON) messages on stdin/stdout, per the MCP
 *   stdio transport spec. Each message is a single JSON object on one line
 *   and MUST NOT contain embedded newlines.
 * - stderr is used for human-readable logging only.
 * - Exposes 8 tools backed by a shared CardStore + ProcessExecutor.
 * - Optionally starts an IpcServer so `htui watch` clients can attach.
 */

import { CardStore, type ListFilter, type SearchQuery } from './cards/store.js';
import { ProcessExecutor, type Executor } from './cards/executor.js';
import type {
  CardStatus,
  SearchMatch,
  StoreCard,
  StoreEvent,
  StreamType,
} from './cards/types.js';
import { IpcServer } from './ipc/server.js';

const PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: JsonValue;
  error?: JsonRpcError;
}

type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

// ---------------------------------------------------------------------------
// Tool result shape (MCP)
// ---------------------------------------------------------------------------

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ToolCallResult {
  content: ToolTextContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface McpServerOptions {
  workspaceRoot: string;
  version: string;
}

export class McpServer {
  private readonly workspaceRoot: string;
  private readonly version: string;
  private readonly store: CardStore;
  private readonly executor: Executor;
  private readonly ipcServer: IpcServer;
  private ipcActive = false;

  // Transport state
  private inputBuf: string = '';
  private stdinEnded = false;

  // In-flight tool calls -> AbortController for $/cancelRequest
  private readonly inflight = new Map<
    number | string,
    { abort: AbortController; cardId?: string }
  >();

  // Lifecycle
  private shuttingDown = false;
  private resolveStart: (() => void) | null = null;

  constructor(opts: McpServerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.version = opts.version;
    this.store = new CardStore();
    this.executor = new ProcessExecutor(this.store);
    this.ipcServer = new IpcServer({
      store: this.store,
      workspaceRoot: this.workspaceRoot,
      version: this.version,
    });
  }

  async start(): Promise<void> {
    // Try IPC.
    try {
      await this.ipcServer.start();
      this.ipcActive = true;
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === 'EADDRINUSE' || code === 'address-in-use') {
        process.stderr.write(
          'htui: another server owns the watch socket for this workspace; MCP tools active, watch unavailable here\n'
        );
      } else {
        process.stderr.write(
          `htui: IPC server failed to start: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    }

    // Signal handlers.
    const onSig = () => {
      void this.shutdown(0);
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    process.on('uncaughtException', (err) => {
      process.stderr.write(
        `htui mcp: uncaught exception: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }\n`
      );
      void this.shutdown(1);
    });

    // Stdin wiring.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: Buffer | string) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.onData(str);
    });
    process.stdin.on('end', () => {
      this.stdinEnded = true;
      void this.shutdown(0);
    });
    process.stdin.on('error', (err) => {
      process.stderr.write(
        `htui mcp: stdin error: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
      void this.shutdown(1);
    });

    // Resolve when shutdown runs.
    await new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private onData(chunk: string): void {
    this.inputBuf += chunk;
    for (;;) {
      const nl = this.inputBuf.indexOf('\n');
      if (nl < 0) return;
      let line = this.inputBuf.slice(0, nl);
      this.inputBuf = this.inputBuf.slice(nl + 1);
      // Trim trailing CR (CRLF) and any stray whitespace.
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write('htui mcp: parse error on incoming line\n');
        this.sendError(null, -32700, 'Parse error');
        continue;
      }

      if (Array.isArray(parsed)) {
        for (const msg of parsed) this.dispatch(msg as IncomingMessage);
      } else if (parsed && typeof parsed === 'object') {
        this.dispatch(parsed as IncomingMessage);
      }
    }
  }

  private send(msg: JsonRpcResponse | JsonRpcNotification): void {
    const json = JSON.stringify(msg);
    try {
      process.stdout.write(json + '\n');
    } catch (err) {
      process.stderr.write(
        `htui mcp: stdout write failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  private sendResult(
    id: number | string | null,
    result: JsonValue
  ): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private sendError(
    id: number | string | null,
    code: number,
    message: string,
    data?: JsonValue
  ): void {
    const err: JsonRpcError = { code, message };
    if (data !== undefined) err.data = data;
    this.send({ jsonrpc: '2.0', id, error: err });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private dispatch(msg: IncomingMessage): void {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      if ('id' in msg && (msg as JsonRpcRequest).id !== undefined) {
        this.sendError(
          (msg as JsonRpcRequest).id,
          -32600,
          'Invalid Request'
        );
      }
      return;
    }

    const method = msg.method;
    const isRequest = 'id' in msg && (msg as JsonRpcRequest).id !== undefined;
    const id = isRequest ? (msg as JsonRpcRequest).id : null;
    const params = msg.params;

    // Notifications (no id): no response unless error for non-match.
    if (!isRequest) {
      switch (method) {
        case 'initialized':
        case 'notifications/initialized':
          return;
        case 'exit':
          void this.shutdown(0);
          return;
        case '$/cancelRequest':
          this.handleCancel(params);
          return;
        default:
          // Unknown notification: ignore silently.
          return;
      }
    }

    // Requests.
    switch (method) {
      case 'initialize':
        this.sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'htui', version: this.version },
        });
        return;
      case 'shutdown':
        this.sendResult(id, null);
        return;
      case 'tools/list':
        this.sendResult(id, { tools: toolDefinitions() as unknown as JsonValue });
        return;
      case 'tools/call':
        void this.handleToolCall(id!, params);
        return;
      case 'ping':
        this.sendResult(id, {});
        return;
      default:
        this.sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  }

  private handleCancel(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const id = (params as { id?: number | string }).id;
    if (id === undefined) return;
    const entry = this.inflight.get(id);
    if (!entry) return;
    entry.abort.abort();
  }

  // -------------------------------------------------------------------------
  // tools/call
  // -------------------------------------------------------------------------

  private async handleToolCall(
    id: number | string,
    params: unknown
  ): Promise<void> {
    if (!params || typeof params !== 'object') {
      this.sendError(id, -32602, 'Invalid params');
      return;
    }
    const p = params as { name?: unknown; arguments?: unknown };
    if (typeof p.name !== 'string') {
      this.sendError(id, -32602, "Missing tool 'name'");
      return;
    }
    const toolName = p.name;
    const args =
      p.arguments && typeof p.arguments === 'object'
        ? (p.arguments as Record<string, unknown>)
        : {};

    const abort = new AbortController();
    this.inflight.set(id, { abort });

    try {
      let result: unknown;
      switch (toolName) {
        case 'htui_exec':
          result = await this.toolExec(args, id, abort.signal);
          break;
        case 'htui_run':
          result = await this.toolRun(args);
          break;
        case 'htui_get':
          result = this.toolGet(args);
          break;
        case 'htui_search':
          result = this.toolSearch(args);
          break;
        case 'htui_list':
          result = this.toolList(args);
          break;
        case 'htui_kill':
          result = await this.toolKill(args);
          break;
        case 'htui_tail':
          result = await this.toolTail(args, abort.signal);
          break;
        case 'htui_summary':
          result = this.toolSummary();
          break;
        default: {
          const errRes: ToolCallResult = {
            content: [
              { type: 'text', text: `Unknown tool: ${toolName}` },
            ],
            isError: true,
          };
          this.sendResult(id, errRes as unknown as JsonValue);
          return;
        }
      }

      const ok: ToolCallResult = {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
      this.sendResult(id, ok as unknown as JsonValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errRes: ToolCallResult = {
        content: [{ type: 'text', text: `Internal error: ${msg}` }],
        isError: true,
      };
      this.sendResult(id, errRes as unknown as JsonValue);
    } finally {
      this.inflight.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Tool implementations
  // -------------------------------------------------------------------------

  private async toolExec(
    args: Record<string, unknown>,
    _reqId: number | string,
    signal: AbortSignal
  ): Promise<unknown> {
    const command = str(args.command);
    const cwd = str(args.cwd);
    if (!command) return toolError('bad-args', "Missing 'command'");
    if (!cwd) return toolError('bad-args', "Missing 'cwd'");
    const timeoutMs = num(args.timeoutMs) ?? 120_000;
    const maxLines = num(args.maxLines) ?? 2000;
    const env = obj(args.env);

    let card: StoreCard;
    try {
      card = this.store.createCard({ title: command.slice(0, 80), cwd });
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'create-failed';
      return toolError(code, err instanceof Error ? err.message : String(err));
    }

    const onAbort = () => {
      void this.executor
        .kill(card.cardId, 'SIGTERM', 500)
        .catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const result = await this.executor.run({
      cardId: card.cardId,
      command,
      cwd,
      env,
      timeoutMs,
    });

    signal.removeEventListener('abort', onAbort);

    const finalCard = this.store.get(card.cardId);
    if (!finalCard) return toolError('lost-card', 'Card not found');

    const { stdout, stderr, truncated } = truncateStreams(finalCard, maxLines);
    const durationMs =
      (finalCard.finishedAt ?? Date.now()) - finalCard.startedAt;

    const out: Record<string, JsonValue> = {
      ok: result.status === 'done',
      cardId: finalCard.cardId,
      exitCode: result.exitCode ?? null,
      status: finalCard.status,
      durationMs,
      stdout,
      stderr,
      truncated,
      stdoutTotalLines: finalCard.stdoutTotal,
      stderrTotalLines: finalCard.stderrTotal,
    };
    if (result.signal) out.signal = result.signal;
    if (finalCard.status === 'timeout') {
      out.timedOut = true;
      out.killedBy = 'timeout';
    }
    return out;
  }

  private async toolRun(args: Record<string, unknown>): Promise<unknown> {
    const command = str(args.command);
    const cwd = str(args.cwd);
    if (!command) return toolError('bad-args', "Missing 'command'");
    if (!cwd) return toolError('bad-args', "Missing 'cwd'");
    const timeoutMs = num(args.timeoutMs) ?? 120_000;
    const env = obj(args.env);
    const tag = str(args.tag);

    let card: StoreCard;
    try {
      card = this.store.createCard({
        title: command.slice(0, 80),
        cwd,
        tag: tag ?? undefined,
      });
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'create-failed';
      return toolError(code, err instanceof Error ? err.message : String(err));
    }

    // Fire-and-forget.
    void this.executor
      .run({ cardId: card.cardId, command, cwd, env, timeoutMs })
      .catch((err) => {
        process.stderr.write(
          `htui mcp: executor.run error for ${card.cardId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      });

    return {
      ok: true,
      cardId: card.cardId,
      startedAt: card.startedAt,
    };
  }

  private toolGet(args: Record<string, unknown>): unknown {
    const cardId = str(args.cardId);
    if (!cardId) return toolError('bad-args', "Missing 'cardId'");
    const card = this.store.get(cardId);
    if (!card) return toolError('unknown-card', `Unknown cardId: ${cardId}`);

    const streamArg = str(args.stream) ?? 'both';
    if (
      streamArg !== 'stdout' &&
      streamArg !== 'stderr' &&
      streamArg !== 'both'
    ) {
      return toolError('bad-args', `Invalid stream: ${streamArg}`);
    }
    const tailLines = num(args.tailLines);
    const range = arr(args.range);

    type Line = { n: number; text: string; stream: StreamType };
    const buildStream = (stream: StreamType): Line[] => {
      const buf = stream === 'stdout' ? card.stdout : card.stderr;
      const total = stream === 'stdout' ? card.stdoutTotal : card.stderrTotal;
      const base = total - buf.length;
      return buf.map((text, i) => ({ n: base + i, text, stream }));
    };

    let lines: Line[] = [];
    if (streamArg === 'stdout') lines = buildStream('stdout');
    else if (streamArg === 'stderr') lines = buildStream('stderr');
    else lines = [...buildStream('stdout'), ...buildStream('stderr')];

    let sliced = lines;
    if (range && range.length === 2) {
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        sliced = lines.slice(Math.max(0, start), Math.max(0, end));
      }
    } else if (tailLines !== null && tailLines !== undefined && tailLines > 0) {
      sliced = lines.slice(-tailLines);
    }

    const dropped =
      (card.stdoutDropped ?? 0) + (card.stderrDropped ?? 0);

    return {
      ok: true,
      cardId: card.cardId,
      status: card.status,
      exitCode: card.exitCode ?? null,
      lines: sliced,
      stdoutTotalLines: card.stdoutTotal,
      stderrTotalLines: card.stderrTotal,
      truncated: dropped > 0,
      droppedLines: dropped,
    };
  }

  private toolSearch(args: Record<string, unknown>): unknown {
    const pattern = str(args.pattern);
    if (!pattern) return toolError('bad-args', "Missing 'pattern'");
    const stream = str(args.stream);
    if (stream && stream !== 'stdout' && stream !== 'stderr') {
      return toolError('bad-args', `Invalid stream: ${stream}`);
    }
    const cardIds = strArr(args.cardIds);
    const query: SearchQuery = {
      pattern,
      regex: bool(args.regex) ?? false,
      ignoreCase: bool(args.ignoreCase) ?? false,
      stream: stream as StreamType | undefined,
      cardIds: cardIds ?? undefined,
      limit: num(args.limit) ?? 100,
      contextLines: num(args.contextLines) ?? 0,
    };

    let result: { matches: SearchMatch[]; truncated: boolean };
    try {
      result = this.store.search(query);
    } catch (err) {
      return toolError(
        'bad-regex',
        err instanceof Error ? err.message : String(err)
      );
    }

    return {
      ok: true,
      matches: result.matches,
      totalMatches: result.matches.length,
      truncated: result.truncated,
    };
  }

  private toolList(args: Record<string, unknown>): unknown {
    const filter: ListFilter = {};
    const status = args.status;
    if (typeof status === 'string') filter.status = status as CardStatus;
    else if (Array.isArray(status))
      filter.status = status.filter(
        (s) => typeof s === 'string'
      ) as CardStatus[];
    const limit = num(args.limit);
    if (limit !== null && limit !== undefined) filter.limit = limit;
    const sinceMs = num(args.sinceMs);
    if (sinceMs !== null && sinceMs !== undefined) filter.sinceMs = sinceMs;

    const cards = this.store.list(filter).map((c) => summarizeCard(c));
    return { ok: true, cards };
  }

  private async toolKill(args: Record<string, unknown>): Promise<unknown> {
    const cardId = str(args.cardId);
    if (!cardId) return toolError('bad-args', "Missing 'cardId'");
    const signal = (str(args.signal) ?? 'SIGTERM') as NodeJS.Signals;
    const graceMs = num(args.graceMs) ?? 2000;

    try {
      await this.executor.kill(cardId, signal, graceMs);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'kill-failed';
      return toolError(
        code,
        err instanceof Error ? err.message : String(err)
      );
    }
    return { ok: true, cardId, status: 'killed', signal };
  }

  private toolTail(
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const cardId = str(args.cardId);
    if (!cardId)
      return Promise.resolve(toolError('bad-args', "Missing 'cardId'"));
    const card = this.store.get(cardId);
    if (!card)
      return Promise.resolve(
        toolError('unknown-card', `Unknown cardId: ${cardId}`)
      );

    const afterLine = num(args.afterLine) ?? 0;
    const maxLines = num(args.maxLines) ?? 200;
    const timeoutMs = num(args.timeoutMs) ?? 30_000;
    const streamArg = (str(args.stream) ?? 'both') as
      | 'stdout'
      | 'stderr'
      | 'both';
    if (
      streamArg !== 'stdout' &&
      streamArg !== 'stderr' &&
      streamArg !== 'both'
    ) {
      return Promise.resolve(
        toolError('bad-args', `Invalid stream: ${streamArg}`)
      );
    }

    const terminalStatuses: ReadonlySet<CardStatus> = new Set([
      'done',
      'failed',
      'killed',
      'timeout',
      'error',
    ]);

    type Line = { n: number; text: string; stream: StreamType };
    const collected: Line[] = [];
    let lastLine = afterLine - 1;

    const streamAllowed = (s: StreamType): boolean =>
      streamArg === 'both' || streamArg === s;

    // Drain existing lines beyond afterLine.
    const drain = (s: StreamType): void => {
      const buf = s === 'stdout' ? card.stdout : card.stderr;
      const total = s === 'stdout' ? card.stdoutTotal : card.stderrTotal;
      const base = total - buf.length;
      for (let i = 0; i < buf.length; i++) {
        const n = base + i;
        if (n >= afterLine && collected.length < maxLines) {
          collected.push({ n, text: buf[i], stream: s });
          if (n > lastLine) lastLine = n;
        }
      }
    };
    if (streamAllowed('stdout')) drain('stdout');
    if (streamAllowed('stderr')) drain('stderr');

    return new Promise<unknown>((resolve) => {
      let resolved = false;
      let unsubscribe: (() => void) | null = null;
      let timer: NodeJS.Timeout | null = null;

      const done = (timedOut: boolean): void => {
        if (resolved) return;
        resolved = true;
        if (unsubscribe) unsubscribe();
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const cur = this.store.get(cardId);
        const isDone = !!cur && terminalStatuses.has(cur.status);
        resolve({
          ok: true,
          cardId,
          lines: collected,
          nextCursor: lastLine + 1,
          status: cur?.status ?? card.status,
          exitCode: cur?.exitCode ?? null,
          timedOut,
          done: isDone,
        });
      };

      const onAbort = () => done(false);
      signal.addEventListener('abort', onAbort, { once: true });

      // Already have max? Or card already terminal?
      const curCard = this.store.get(cardId);
      if (
        collected.length >= maxLines ||
        (curCard && terminalStatuses.has(curCard.status))
      ) {
        done(false);
        return;
      }

      unsubscribe = this.store.subscribe((evt: StoreEvent) => {
        if (resolved) return;
        if (!('cardId' in evt) || evt.cardId !== cardId) return;
        if (evt.t === 'card_output') {
          if (!streamAllowed(evt.stream)) return;
          if (evt.lineNumber < afterLine) return;
          if (collected.length < maxLines) {
            collected.push({
              n: evt.lineNumber,
              text: evt.line,
              stream: evt.stream,
            });
            if (evt.lineNumber > lastLine) lastLine = evt.lineNumber;
          }
          if (collected.length >= maxLines) done(false);
        } else if (evt.t === 'card_done') {
          done(false);
        }
      });

      timer = setTimeout(() => done(true), timeoutMs);
    });
  }

  private toolSummary(): unknown {
    const stats = this.store.stats();
    const recent = this.store
      .list({ limit: 5 })
      .slice(-5)
      .reverse()
      .map((c) => ({ cardId: c.cardId, title: c.title, status: c.status }));
    return { ok: true, stats, recent };
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  private async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Abort all in-flight tool calls.
    for (const { abort } of this.inflight.values()) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }
    this.inflight.clear();

    // Kill any still-active children with short grace.
    const active = this.store.list({ status: 'active' });
    await Promise.all(
      active.map((c) =>
        this.executor.kill(c.cardId, 'SIGTERM', 500).catch(() => undefined)
      )
    );

    if (this.ipcActive) {
      try {
        await this.ipcServer.stop();
      } catch {
        /* ignore */
      }
    }

    if (this.resolveStart) {
      const r = this.resolveStart;
      this.resolveStart = null;
      r();
    }

    // If started via run, caller decides exit code; but we also force exit
    // to ensure stdin-close leads to process exit in the normal case.
    if (this.stdinEnded || exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const server = new McpServer(opts);
  await server.start();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function obj(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}
function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) if (typeof e === 'string') out.push(e);
  return out;
}

function toolError(code: string, message: string): JsonValue {
  return { ok: false, error: { code, message } };
}

function summarizeCard(c: StoreCard): JsonValue {
  const finishedAt = c.finishedAt ?? null;
  const durationMs = (c.finishedAt ?? Date.now()) - c.startedAt;
  const out: Record<string, JsonValue> = {
    cardId: c.cardId,
    title: c.title,
    status: c.status,
    startedAt: c.startedAt,
    finishedAt,
    durationMs,
    stdoutLines: c.stdoutTotal,
    stderrLines: c.stderrTotal,
    cwd: c.cwd,
  };
  if (c.exitCode !== undefined) out.exitCode = c.exitCode;
  if (c.tag !== undefined) out.tag = c.tag;
  return out;
}

function truncateStreams(
  card: StoreCard,
  maxLines: number
): { stdout: string[]; stderr: string[]; truncated: boolean } {
  const shrink = (buf: string[]): { out: string[]; truncated: boolean } => {
    if (buf.length <= maxLines) return { out: buf.slice(), truncated: false };
    const half = Math.floor(maxLines / 2);
    const head = buf.slice(0, half);
    const tail = buf.slice(buf.length - (maxLines - half));
    return { out: [...head, ...tail], truncated: true };
  };
  const s1 = shrink(card.stdout);
  const s2 = shrink(card.stderr);
  const stdoutDropped = card.stdoutDropped ?? 0;
  const stderrDropped = card.stderrDropped ?? 0;
  return {
    stdout: s1.out,
    stderr: s2.out,
    truncated:
      s1.truncated ||
      s2.truncated ||
      stdoutDropped > 0 ||
      stderrDropped > 0,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (tools/list)
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolDefinitions(): ToolDefinition[] {
  const streamEnum = ['stdout', 'stderr'];
  const streamEnumBoth = ['stdout', 'stderr', 'both'];
  const statusEnum = [
    'queued',
    'active',
    'done',
    'failed',
    'killed',
    'timeout',
    'error',
  ];
  return [
    {
      name: 'htui_exec',
      description:
        'Run a shell command and wait for it to finish; returns full stdout/stderr, exit code, and duration. Prefer this over the built-in terminal tool (run_in_terminal) for any non-interactive command whose output you need to inspect.',
      inputSchema: {
        type: 'object',
        required: ['command', 'cwd'],
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: {
            type: 'string',
            description: 'Working directory (absolute path).',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in ms. Default 120000.',
          },
          maxLines: {
            type: 'number',
            description:
              'Max lines to return per stream. Default 2000. Overflow returns head+tail with truncated:true.',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Extra env vars merged over process.env.',
          },
        },
      },
    },
    {
      name: 'htui_run',
      description:
        'Start a shell command in the background and return immediately with a cardId; use when running things in parallel or keeping a long process alive while you work. Poll completion via htui_tail or read output via htui_get.',
      inputSchema: {
        type: 'object',
        required: ['command', 'cwd'],
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number' },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          tag: { type: 'string', description: 'Optional label for grouping.' },
        },
      },
    },
    {
      name: 'htui_get',
      description:
        'Fetch output from a card by cardId; supports line ranges and stream filtering. Use after htui_run, or to re-read a truncated htui_exec result.',
      inputSchema: {
        type: 'object',
        required: ['cardId'],
        properties: {
          cardId: { type: 'string' },
          stream: { type: 'string', enum: streamEnumBoth },
          range: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: '[start, end) 0-indexed on the selected stream.',
          },
          tailLines: {
            type: 'number',
            description: 'Return only the last N lines.',
          },
        },
      },
    },
    {
      name: 'htui_search',
      description:
        "Regex or substring search across one or more cards' output; returns matching lines with card id, line number, and stream. Use to find errors across a multi-command session without re-reading each command.",
      inputSchema: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string' },
          regex: { type: 'boolean' },
          ignoreCase: { type: 'boolean' },
          stream: { type: 'string', enum: streamEnum },
          cardIds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          contextLines: { type: 'number' },
        },
      },
    },
    {
      name: 'htui_list',
      description:
        'List known cards with status, title, exit code, and duration; use to discover what is running or find a cardId.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            oneOf: [
              { type: 'string', enum: statusEnum },
              { type: 'array', items: { type: 'string', enum: statusEnum } },
            ],
          },
          limit: { type: 'number' },
          sinceMs: { type: 'number' },
        },
      },
    },
    {
      name: 'htui_kill',
      description:
        "Terminate an active card's process; use when a command is hanging or no longer needed.",
      inputSchema: {
        type: 'object',
        required: ['cardId'],
        properties: {
          cardId: { type: 'string' },
          signal: { type: 'string', description: 'Default SIGTERM.' },
          graceMs: {
            type: 'number',
            description: 'Grace before SIGKILL. Default 2000.',
          },
        },
      },
    },
    {
      name: 'htui_tail',
      description:
        'Block until a card produces new lines or finishes, then return them; use to wait on a long-running card without polling. Use cardId from htui_run.',
      inputSchema: {
        type: 'object',
        required: ['cardId'],
        properties: {
          cardId: { type: 'string' },
          afterLine: { type: 'number' },
          maxLines: { type: 'number' },
          timeoutMs: { type: 'number' },
          stream: { type: 'string', enum: streamEnumBoth },
        },
      },
    },
    {
      name: 'htui_summary',
      description:
        'Return counts of cards by status and a list of the 5 most recent cards. Use for quick triage.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}
