/**
 * IPC client with jittered exponential backoff for watch-process consumers.
 */

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { Decoder, type ServerMsg } from './protocol.js';
import { socketPath as computeSocketPath } from './path.js';

export type ClientState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'disconnected'
  | 'error';

export interface IpcClientOptions {
  workspaceRoot: string;
}

const BASE_DELAY = 100;
const MAX_DELAY = 5000;
const FACTOR = 1.8;
const JITTER = 0.2;
const ERROR_DELAY = 5000;

export class IpcClient extends EventEmitter {
  private readonly workspaceRoot: string;
  private socket: net.Socket | null = null;
  private decoder = new Decoder();
  private retryTimer: NodeJS.Timeout | null = null;
  private nextRetryAt = 0;
  private currentDelay = BASE_DELAY;
  private stopped = false;
  private started = false;
  private _state: ClientState = 'idle';
  private _lastError: Error | null = null;

  constructor(opts: IpcClientOptions) {
    super();
    this.workspaceRoot = opts.workspaceRoot;
  }

  get state(): ClientState {
    return this._state;
  }

  get lastError(): Error | null {
    return this._lastError;
  }

  get nextRetryIn(): number {
    if (this.retryTimer === null) return 0;
    return Math.max(0, this.nextRetryAt - Date.now());
  }

  connect(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.currentDelay = BASE_DELAY;
    this.attempt();
  }

  disconnect(): void {
    this.stopped = true;
    this.started = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.setState('idle');
  }

  forceReconnect(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.currentDelay = BASE_DELAY;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.stopped = false;
    this.started = true;
    this.attempt();
  }

  private setState(s: ClientState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  private attempt(): void {
    if (this.stopped) return;
    this.setState('connecting');
    this.decoder = new Decoder();

    const sockPath = computeSocketPath(this.workspaceRoot);
    const sock = net.connect(sockPath);
    this.socket = sock;

    let settled = false;

    sock.once('connect', () => {
      settled = true;
      this.currentDelay = BASE_DELAY;
      this.setState('connected');
    });

    sock.on('data', (chunk) => {
      try {
        const msgs = this.decoder.push(chunk);
        for (const m of msgs) {
          this.emit('message', m as ServerMsg);
        }
      } catch (err) {
        this._lastError = err as Error;
        this.emit('error', err);
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
      }
    });

    sock.on('error', (err: NodeJS.ErrnoException) => {
      this._lastError = err;
      this.emit('error', err);

      if (!settled) {
        // Pre-connect error.
        if (err.code === 'ENOENT') {
          this.setState('waiting');
          this.scheduleRetry(this.nextBackoff());
        } else if (err.code === 'EACCES' || err.code === 'EPERM') {
          this.setState('error');
          this.scheduleRetry(ERROR_DELAY);
        } else {
          this.setState('error');
          this.scheduleRetry(this.nextBackoff());
        }
      }
      // On post-connect errors, `close` will follow and handle the retry.
    });

    sock.on('close', () => {
      if (this.socket === sock) this.socket = null;
      if (this.stopped) return;
      if (settled) {
        // Was connected; transition to disconnected and retry with fresh backoff.
        this.setState('disconnected');
        this.currentDelay = BASE_DELAY;
        this.scheduleRetry(this.nextBackoff());
      }
      // else: error handler already scheduled retry.
    });
  }

  private nextBackoff(): number {
    const base = Math.min(MAX_DELAY, this.currentDelay);
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const delay = Math.max(0, Math.min(MAX_DELAY, Math.round(base * jitter)));
    this.currentDelay = Math.min(MAX_DELAY, this.currentDelay * FACTOR);
    return delay;
  }

  private scheduleRetry(delay: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attempt();
    }, delay);
  }
}
