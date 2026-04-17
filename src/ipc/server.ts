/**
 * IPC server: binds a socket for the workspace, broadcasts store events
 * to all connected watch clients.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import type { CardStore } from '../cards/store.js';
import type { StoreEvent } from '../cards/types.js';
import { encode, Decoder, type ServerMsg, type ClientMsg } from './protocol.js';
import { socketPath as computeSocketPath, windowId } from './path.js';

const IS_WINDOWS = process.platform === 'win32';
const BACKPRESSURE_LIMIT = 16 * 1024 * 1024; // 16 MB

interface ClientEntry {
  socket: net.Socket;
  decoder: Decoder;
}

export interface IpcServerOptions {
  store: CardStore;
  workspaceRoot: string;
  version: string;
}

export class IpcServer {
  private readonly store: CardStore;
  private readonly workspaceRoot: string;
  private readonly version: string;
  private server: net.Server | null = null;
  private socketPath = '';
  private clients = new Set<ClientEntry>();
  private unsubscribe: (() => void) | null = null;
  private cleanupRegistered = false;
  private cleanupHandler: (() => void) | null = null;
  private _listening = false;

  constructor(opts: IpcServerOptions) {
    this.store = opts.store;
    this.workspaceRoot = opts.workspaceRoot;
    this.version = opts.version;
  }

  get listening(): boolean {
    return this._listening;
  }

  async start(): Promise<{ path: string }> {
    const sockPath = computeSocketPath(this.workspaceRoot);
    this.socketPath = sockPath;

    // Stale-socket handling on Unix.
    if (!IS_WINDOWS && fs.existsSync(sockPath)) {
      const alive = await probeSocket(sockPath);
      if (alive) {
        const err = new Error('address-in-use') as Error & { code?: string };
        err.code = 'EADDRINUSE';
        throw err;
      }
      try {
        fs.unlinkSync(sockPath);
      } catch {
        /* ignore */
      }
    }

    const server = net.createServer((sock) => this.handleClient(sock));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: NodeJS.ErrnoException) => {
        server.off('listening', onOk);
        if (err.code === 'EADDRINUSE') {
          const e = new Error('address-in-use') as Error & { code?: string };
          e.code = 'EADDRINUSE';
          reject(e);
        } else {
          reject(err);
        }
      };
      const onOk = () => {
        server.off('error', onErr);
        resolve();
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(sockPath);
    });

    this._listening = true;

    // Subscribe to store events and broadcast.
    this.unsubscribe = this.store.subscribe((evt) => this.broadcast(evt));

    this.registerCleanup();

    return { path: sockPath };
  }

  async stop(): Promise<void> {
    if (!this._listening && !this.server) return;
    this._listening = false;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Farewell to clients.
    const byeFrame = encode({ t: 'bye', reason: 'shutdown' });
    for (const client of this.clients) {
      try {
        client.socket.write(byeFrame);
      } catch {
        /* ignore */
      }
      try {
        client.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    if (!IS_WINDOWS && this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* ignore */
      }
    }

    if (this.cleanupHandler && this.cleanupRegistered) {
      process.off('beforeExit', this.cleanupHandler);
      process.off('SIGINT', this.cleanupHandler);
      process.off('SIGTERM', this.cleanupHandler);
      this.cleanupRegistered = false;
      this.cleanupHandler = null;
    }
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    const handler = () => {
      void this.stop();
    };
    this.cleanupHandler = handler;
    process.on('beforeExit', handler);
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    this.cleanupRegistered = true;
  }

  private handleClient(socket: net.Socket): void {
    const entry: ClientEntry = { socket, decoder: new Decoder() };
    this.clients.add(entry);

    const snap = this.store.snapshot();
    const hello: ServerMsg = {
      t: 'hello',
      seq: snap.seq,
      pid: process.pid,
      version: this.version,
      workspace: this.workspaceRoot,
      windowId: windowId(),
    };
    const snapshotMsg: ServerMsg = {
      t: 'snapshot',
      seq: snap.seq,
      cards: snap.cards,
    };

    try {
      socket.write(encode(hello));
      socket.write(encode(snapshotMsg));
    } catch {
      /* ignore; close handler will clean up */
    }

    // Wait briefly for an initial resume/ping from the client.
    const resumeTimer = setTimeout(() => {
      // noop; we simply stop waiting.
    }, 500);

    socket.on('data', (chunk) => {
      try {
        const msgs = entry.decoder.push(chunk);
        for (const m of msgs) {
          const cm = m as ClientMsg;
          if (cm.t === 'resume') {
            // v1: snapshot already sent; acknowledge implicitly.
            process.stderr.write(
              `[htui ipc] client requested resume sinceSeq=${cm.sinceSeq}\n`
            );
          }
          // 'ping' ignored in v1.
        }
      } catch {
        // bad frame: drop the client.
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    });

    const onClose = () => {
      clearTimeout(resumeTimer);
      this.clients.delete(entry);
    };
    socket.on('close', onClose);
    socket.on('error', () => {
      // `close` will follow.
    });
  }

  private broadcast(evt: StoreEvent): void {
    const frame = encode(evt);
    for (const client of this.clients) {
      const { socket } = client;
      let ok: boolean;
      try {
        ok = socket.write(frame);
      } catch {
        continue;
      }
      if (!ok && socket.writableLength > BACKPRESSURE_LIMIT) {
        try {
          socket.write(encode({ t: 'bye', reason: 'slow_consumer' }));
        } catch {
          /* ignore */
        }
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        this.clients.delete(client);
      }
    }
  }
}

/** Probe whether something is actually listening on a Unix socket path. */
function probeSocket(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const done = (alive: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(alive);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 200);
  });
}
