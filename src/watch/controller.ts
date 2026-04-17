/**
 * Controller for `htui watch` mode.
 *
 * Owns the `WatchState`, wires the IpcClient, handles keyboard input, and
 * schedules coalesced re-renders + animation ticks.
 */

import { Terminal, Keys } from '../terminal.js';
import { IpcClient, type ClientState } from '../ipc/client.js';
import type { ServerMsg } from '../ipc/protocol.js';
import type { StoreCard, CardStatus } from '../cards/types.js';
import {
  WatchRenderer,
  type WatchState,
  type DisplayCard,
  type ConnState,
} from './renderer.js';

export interface WatchControllerOpts {
  workspaceRoot: string;
  terminal: Terminal;
  renderer: WatchRenderer;
  packageVersion: string;
}

const SPINNER_MS = 80;
const NEW_CARD_MS = 200;
const PULSE_MS = 600;
const PULSE_STEP = 150;
const TOAST_SLOW_MS = 4000;
const TOAST_SESSION_MS = 4000;
const TOAST_RECONNECT_MS = 500;
const RETRY_COUNTDOWN_MS = 100;

export class WatchController {
  private readonly terminal: Terminal;
  private readonly renderer: WatchRenderer;
  private readonly client: IpcClient;

  private state: WatchState;
  private lastWindowId: string | null = null;
  private helloReceived = false;
  private dirty = false;
  private renderScheduled = false;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private timers: Set<NodeJS.Timeout> = new Set();
  private stopped = false;
  private resolveStart: (() => void) | null = null;
  private readonly noAnim: boolean;

  constructor(opts: WatchControllerOpts) {
    this.terminal = opts.terminal;
    this.renderer = opts.renderer;
    this.noAnim =
      process.env.HTUI_NO_ANIM === '1' || !process.stdout.isTTY;

    this.client = new IpcClient({ workspaceRoot: opts.workspaceRoot });

    this.state = {
      conn: 'connecting',
      connectedWorkspace: null,
      cards: [],
      selectedCardIdx: -1,
      expandedCardIdx: null,
      autoFollow: true,
      filter: { open: false, buf: '', committed: null },
      scrollOffset: 0,
      nextRetryInMs: null,
      permissionDenied: false,
      slowConsumerToastUntil: null,
      sessionChangedToastUntil: null,
      reconnectToastUntil: null,
      spinnerFrame: 0,
      anim: { newCards: new Map(), pulses: new Map(), fade: null },
      now: Date.now(),
    };
  }

  async start(): Promise<void> {
    this.terminal.onKey((key) => this.handleKey(key));
    this.terminal.onResize(() => this.scheduleRender());

    this.client.on('state', (s: ClientState) => this.onClientState(s));
    this.client.on('message', (m: ServerMsg) => this.onClientMessage(m));
    this.client.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        this.state.permissionDenied = true;
        this.scheduleRender();
      }
    });

    this.client.connect();
    this.startSpinner();
    this.startRetryCountdown();
    this.scheduleRender();

    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.client.disconnect();
    if (this.resolveStart) {
      const r = this.resolveStart;
      this.resolveStart = null;
      r();
    }
  }

  // ─── Client events ────────────────────────────────────────────────────

  private onClientState(s: ClientState): void {
    let next: ConnState;
    switch (s) {
      case 'idle':
      case 'connecting':
        next = this.helloReceived ? 'reconnecting' : 'connecting';
        break;
      case 'connected':
        next = this.helloReceived ? 'connected' : 'connecting';
        break;
      case 'waiting':
        next = 'waiting';
        break;
      case 'disconnected':
        next = this.helloReceived ? 'reconnecting' : 'disconnected';
        this.helloReceived = false;
        this.triggerFade(-1);
        break;
      case 'error':
        next = 'waiting';
        break;
    }
    this.state.conn = next;
    this.scheduleRender();
  }

  private onClientMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello': {
        this.state.connectedWorkspace = msg.workspace;
        if (this.lastWindowId !== null && this.lastWindowId !== msg.windowId) {
          this.state.sessionChangedToastUntil = Date.now() + TOAST_SESSION_MS;
          this.scheduleAt(TOAST_SESSION_MS);
        }
        this.lastWindowId = msg.windowId;
        this.helloReceived = true;
        this.state.conn = 'connected';
        this.triggerFade(1);
        break;
      }
      case 'snapshot': {
        const now = Date.now();
        this.state.cards = msg.cards.map((c) => this.storeCardToDisplay(c, now));
        // If autoFollow, select last card.
        if (this.state.cards.length > 0) {
          this.state.selectedCardIdx = this.state.autoFollow
            ? this.state.cards.length - 1
            : Math.min(this.state.selectedCardIdx, this.state.cards.length - 1);
          if (this.state.selectedCardIdx < 0) this.state.selectedCardIdx = this.state.cards.length - 1;
        } else {
          this.state.selectedCardIdx = -1;
        }
        break;
      }
      case 'card_created': {
        const card: DisplayCard = {
          cardId: msg.cardId,
          title: msg.title,
          status: msg.status,
          startedAt: msg.startedAt,
          cwd: msg.cwd,
          tag: msg.tag,
          lines: [],
          stdoutTotal: 0,
          stderrTotal: 0,
          scrollOffset: 0,
          createdAtLocal: Date.now(),
        };
        const wasAtEnd = this.state.selectedCardIdx === this.state.cards.length - 1;
        this.state.cards.push(card);
        if (!this.noAnim) {
          this.state.anim.newCards.set(card.cardId, Date.now() + NEW_CARD_MS);
          this.scheduleAt(NEW_CARD_MS + 10);
        }
        if (this.state.autoFollow || wasAtEnd || this.state.selectedCardIdx < 0) {
          this.state.selectedCardIdx = this.state.cards.length - 1;
        }
        break;
      }
      case 'card_output': {
        const c = this.findCard(msg.cardId);
        if (c) {
          c.lines.push({ text: msg.line, stream: msg.stream });
          if (msg.stream === 'stdout') c.stdoutTotal++;
          else c.stderrTotal++;
        }
        break;
      }
      case 'card_status': {
        const c = this.findCard(msg.cardId);
        if (c) {
          c.status = msg.status;
          c.exitCode = msg.exitCode;
          c.signal = msg.signal;
        }
        break;
      }
      case 'card_done': {
        const c = this.findCard(msg.cardId);
        if (c) {
          const wasActive = c.status === 'active';
          c.status = msg.status;
          c.exitCode = msg.exitCode;
          c.finishedAt = c.startedAt + msg.durationMs;
          c.stdoutTotal = msg.totalLines.stdout;
          c.stderrTotal = msg.totalLines.stderr;
          if (wasActive && !this.noAnim) {
            this.state.anim.pulses.set(c.cardId, { start: Date.now(), status: c.status });
            for (let i = 1; i <= 4; i++) this.scheduleAt(PULSE_STEP * i + 5);
          }
        }
        break;
      }
      case 'dropped': {
        const c = this.findCard(msg.cardId);
        if (c) {
          if (msg.stream === 'stdout') {
            c.stdoutDropped = (c.stdoutDropped ?? 0) + msg.count;
          } else {
            c.stderrDropped = (c.stderrDropped ?? 0) + msg.count;
          }
        }
        break;
      }
      case 'bye': {
        if (msg.reason === 'slow_consumer') {
          this.state.slowConsumerToastUntil = Date.now() + TOAST_SLOW_MS;
          this.scheduleAt(TOAST_SLOW_MS + 5);
        }
        // IpcClient's socket close will drive the state change.
        break;
      }
    }
    this.scheduleRender();
  }

  private findCard(cardId: string): DisplayCard | undefined {
    return this.state.cards.find((c) => c.cardId === cardId);
  }

  private storeCardToDisplay(c: StoreCard, now: number): DisplayCard {
    const lines: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    for (const l of c.stdout) lines.push({ text: l, stream: 'stdout' });
    for (const l of c.stderr) lines.push({ text: l, stream: 'stderr' });
    return {
      cardId: c.cardId,
      title: c.title,
      status: c.status,
      exitCode: c.exitCode,
      signal: c.signal,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      cwd: c.cwd,
      tag: c.tag,
      lines,
      stdoutTotal: c.stdoutTotal,
      stderrTotal: c.stderrTotal,
      stdoutDropped: c.stdoutDropped,
      stderrDropped: c.stderrDropped,
      scrollOffset: 0,
      createdAtLocal: now,
    };
  }

  // ─── Keys ─────────────────────────────────────────────────────────────

  private handleKey(key: string): void {
    // Always-on quit.
    if (key === Keys.CTRL_C) {
      void this.stop();
      return;
    }

    // Filter prompt capture.
    if (this.state.filter.open) {
      if (key === Keys.ESCAPE) {
        this.state.filter.open = false;
        this.state.filter.buf = '';
        this.state.filter.committed = null;
      } else if (key === Keys.ENTER) {
        this.state.filter.committed = this.state.filter.buf;
        this.state.filter.open = false;
      } else if (key === Keys.BACKSPACE || key === Keys.BACKSPACE_ALT) {
        this.state.filter.buf = this.state.filter.buf.slice(0, -1);
      } else if (key.length === 1 && key >= ' ' && key <= '~') {
        this.state.filter.buf += key;
      }
      this.scheduleRender();
      return;
    }

    switch (key) {
      case 'q':
      case 'Q':
        void this.stop();
        return;
      case Keys.LEFT:
        this.state.autoFollow = false;
        if (this.state.selectedCardIdx > 0) this.state.selectedCardIdx--;
        break;
      case Keys.RIGHT:
        if (this.state.selectedCardIdx < this.state.cards.length - 1) {
          this.state.selectedCardIdx++;
        }
        break;
      case Keys.UP:
        if (this.state.expandedCardIdx !== null) {
          const c = this.state.cards[this.state.expandedCardIdx];
          if (c && c.scrollOffset > 0) c.scrollOffset--;
        }
        break;
      case Keys.DOWN:
        if (this.state.expandedCardIdx !== null) {
          const c = this.state.cards[this.state.expandedCardIdx];
          if (c) c.scrollOffset++;
        }
        break;
      case Keys.ENTER:
        if (this.state.selectedCardIdx >= 0) {
          this.state.expandedCardIdx = this.state.selectedCardIdx;
        }
        break;
      case Keys.ESCAPE:
        this.state.expandedCardIdx = null;
        break;
      case 'f':
      case 'F':
        this.state.autoFollow = !this.state.autoFollow;
        if (this.state.autoFollow && this.state.cards.length > 0) {
          this.state.selectedCardIdx = this.state.cards.length - 1;
        }
        break;
      case 'g':
        if (this.state.expandedCardIdx !== null) {
          const c = this.state.cards[this.state.expandedCardIdx];
          if (c) c.scrollOffset = 0;
        } else if (this.state.cards.length > 0) {
          this.state.selectedCardIdx = 0;
          this.state.autoFollow = false;
        }
        break;
      case 'G':
        if (this.state.expandedCardIdx !== null) {
          const c = this.state.cards[this.state.expandedCardIdx];
          if (c) c.scrollOffset = Math.max(0, c.lines.length);
        } else if (this.state.cards.length > 0) {
          this.state.selectedCardIdx = this.state.cards.length - 1;
          this.state.autoFollow = true;
        }
        break;
      case '/':
        this.state.filter.open = true;
        this.state.filter.buf = this.state.filter.committed ?? '';
        break;
      case 'r':
      case 'R':
        if (this.state.conn === 'connected') {
          this.state.reconnectToastUntil = Date.now() + TOAST_RECONNECT_MS;
          this.scheduleAt(TOAST_RECONNECT_MS + 5);
        } else {
          this.client.forceReconnect();
        }
        break;
    }
    this.scheduleRender();
  }

  // ─── Animation / scheduling ───────────────────────────────────────────

  private triggerFade(dir: 1 | -1): void {
    if (this.noAnim) return;
    this.state.anim.fade = { dir, start: Date.now() };
    for (let i = 1; i <= 4; i++) this.scheduleAt(i * 80 + 5);
    // Clear fade marker after ~400ms.
    const t = setTimeout(() => {
      this.state.anim.fade = null;
      this.timers.delete(t);
      this.scheduleRender();
    }, 400);
    this.timers.add(t);
  }

  private startSpinner(): void {
    if (this.noAnim) return;
    this.spinnerTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.hasActiveCard()) return;
      this.state.spinnerFrame = (this.state.spinnerFrame + 1) % 10;
      this.scheduleRender();
    }, SPINNER_MS);
  }

  private hasActiveCard(): boolean {
    for (const c of this.state.cards) if (c.status === 'active') return true;
    return false;
  }

  private startRetryCountdown(): void {
    this.retryTimer = setInterval(() => {
      if (this.stopped) return;
      const r = this.client.nextRetryIn;
      this.state.nextRetryInMs = r > 0 ? r : null;
      if (this.state.conn === 'waiting' || this.state.conn === 'connecting' || this.state.conn === 'disconnected') {
        this.scheduleRender();
      }
      // Clear expired toasts.
      const now = Date.now();
      let changed = false;
      if (this.state.slowConsumerToastUntil && now >= this.state.slowConsumerToastUntil) {
        this.state.slowConsumerToastUntil = null; changed = true;
      }
      if (this.state.sessionChangedToastUntil && now >= this.state.sessionChangedToastUntil) {
        this.state.sessionChangedToastUntil = null; changed = true;
      }
      if (this.state.reconnectToastUntil && now >= this.state.reconnectToastUntil) {
        this.state.reconnectToastUntil = null; changed = true;
      }
      // Clean expired new-card animations.
      for (const [id, until] of this.state.anim.newCards) {
        if (now >= until) { this.state.anim.newCards.delete(id); changed = true; }
      }
      for (const [id, p] of this.state.anim.pulses) {
        if (now - p.start >= PULSE_MS) { this.state.anim.pulses.delete(id); changed = true; }
      }
      if (changed) this.scheduleRender();
    }, RETRY_COUNTDOWN_MS);
  }

  private scheduleAt(ms: number): void {
    if (this.noAnim) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.scheduleRender();
    }, ms);
    this.timers.add(t);
  }

  private scheduleRender(): void {
    this.dirty = true;
    if (this.renderScheduled || this.stopped) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      if (!this.dirty || this.stopped) return;
      this.dirty = false;
      this.state.now = Date.now();
      try {
        this.renderer.render(this.state);
      } catch {
        /* swallow render errors */
      }
    });
  }
}
