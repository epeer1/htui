/**
 * Process executor that owns `child_process.spawn` and integrates with
 * a `CardStore`. Spawns shell commands, streams output line-by-line into
 * the store, and handles timeouts, kills, and cross-platform termination.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { CardStore } from './store.js';
import { normalizeLine, splitBuffered } from './ansi.js';
import type { CardStatus, StreamType } from './types.js';

export interface Executor {
  run(opts: {
    cardId: string;
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number | null;
    signal: string | null;
    status: CardStatus;
  }>;

  kill(
    cardId: string,
    signal?: NodeJS.Signals,
    graceMs?: number
  ): Promise<void>;
}

interface ActiveEntry {
  child: ChildProcess;
  timedOut: boolean;
  timeoutTimer?: NodeJS.Timeout;
  killEscalationTimer?: NodeJS.Timeout;
  closeWaiters: Array<() => void>;
}

const IS_WINDOWS = process.platform === 'win32';

export class ProcessExecutor implements Executor {
  private readonly active = new Map<string, ActiveEntry>();

  constructor(private readonly store: CardStore) {}

  run(opts: {
    cardId: string;
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number | null;
    signal: string | null;
    status: CardStatus;
  }> {
    const { cardId, command, cwd, env, timeoutMs } = opts;

    return new Promise((resolve) => {
      // Validate cwd.
      if (!fs.existsSync(cwd)) {
        this.store.appendLine(
          cardId,
          'stderr',
          `Error: directory does not exist: ${cwd}`
        );
        this.store.setStatus(cardId, 'error');
        resolve({ exitCode: null, signal: null, status: 'error' });
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd,
          env: env ? { ...process.env, ...env } : process.env,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.appendLine(cardId, 'stderr', `Error: ${msg}`);
        this.store.setStatus(cardId, 'error');
        resolve({ exitCode: null, signal: null, status: 'error' });
        return;
      }

      const entry: ActiveEntry = {
        child,
        timedOut: false,
        closeWaiters: [],
      };
      this.active.set(cardId, entry);

      let spawnErrored = false;
      let settled = false;

      // Per-stream line buffering.
      const buffers: Record<StreamType, string> = { stdout: '', stderr: '' };

      const onData = (stream: StreamType) => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const { lines, remainder } = splitBuffered(buffers[stream], text);
        buffers[stream] = remainder;
        for (const raw of lines) {
          this.store.appendLine(cardId, stream, normalizeLine(raw));
        }
      };

      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));

      // Timeout handling.
      if (timeoutMs && timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          entry.timedOut = true;
          this.store.setStatus(cardId, 'timeout');
          if (IS_WINDOWS) {
            // On Windows, child.kill() only kills cmd.exe and leaves
            // grandchildren (e.g. ping) orphaned. Use taskkill /T /F
            // unconditionally to terminate the whole tree immediately.
            if (child.pid !== undefined) {
              try {
                spawn('taskkill', [
                  '/pid',
                  String(child.pid),
                  '/T',
                  '/F',
                ]);
              } catch {
                try {
                  child.kill();
                } catch {
                  /* ignore */
                }
              }
            } else {
              try {
                child.kill();
              } catch {
                /* ignore */
              }
            }
          } else {
            try {
              child.kill('SIGTERM');
            } catch {
              /* ignore */
            }
            entry.killEscalationTimer = setTimeout(() => {
              if (!child.killed && child.exitCode === null) {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* ignore */
                }
              }
            }, 2000);
          }
        }, timeoutMs);
      }

      const cleanup = () => {
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        if (entry.killEscalationTimer) clearTimeout(entry.killEscalationTimer);
        this.active.delete(cardId);
        for (const w of entry.closeWaiters) {
          try {
            w();
          } catch {
            /* ignore */
          }
        }
        entry.closeWaiters.length = 0;
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        spawnErrored = true;
        this.store.appendLine(cardId, 'stderr', `Error: ${err.message}`);
        this.store.setStatus(cardId, 'error');
        cleanup();
        resolve({ exitCode: null, signal: null, status: 'error' });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;

        // Flush remainders.
        for (const stream of ['stdout', 'stderr'] as StreamType[]) {
          if (buffers[stream].length > 0) {
            this.store.appendLine(
              cardId,
              stream,
              normalizeLine(buffers[stream])
            );
            buffers[stream] = '';
          }
        }

        cleanup();

        if (spawnErrored) return;

        const card = this.store.get(cardId);
        const currentStatus = card?.status;
        const sigStr = signal ?? undefined;

        let finalStatus: CardStatus;
        if (currentStatus === 'timeout' || currentStatus === 'killed') {
          finalStatus = currentStatus;
          this.store.setStatus(cardId, currentStatus, code ?? 1, sigStr);
        } else if (currentStatus === 'error') {
          finalStatus = 'error';
        } else {
          finalStatus = code === 0 ? 'done' : 'failed';
          this.store.setStatus(cardId, finalStatus, code ?? 1, sigStr);
        }

        resolve({
          exitCode: code,
          signal: signal ?? null,
          status: finalStatus,
        });
      });
    });
  }

  kill(
    cardId: string,
    signal: NodeJS.Signals = 'SIGTERM',
    graceMs = 2000
  ): Promise<void> {
    const entry = this.active.get(cardId);
    if (!entry) {
      const err = new Error('card-not-active') as Error & { code?: string };
      err.code = 'card-not-active';
      return Promise.reject(err);
    }

    this.store.setStatus(cardId, 'killed', undefined, signal);

    const { child } = entry;

    const sendSignal = (sig: NodeJS.Signals | 'FORCE'): void => {
      try {
        if (IS_WINDOWS) {
          if (sig === 'SIGKILL' || sig === 'FORCE') {
            if (child.pid !== undefined) {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
              return;
            }
          }
          child.kill();
        } else {
          child.kill(sig === 'FORCE' ? 'SIGKILL' : sig);
        }
      } catch {
        /* ignore */
      }
    };

    sendSignal(signal);

    return new Promise<void>((resolve) => {
      let resolved = false;
      const hardTimer = setTimeout(() => {
        finish();
      }, graceMs * 2);

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (entry.killEscalationTimer) clearTimeout(entry.killEscalationTimer);
        clearTimeout(hardTimer);
        resolve();
      };

      entry.closeWaiters.push(finish);

      // Escalate to SIGKILL/taskkill /F after grace period.
      if (entry.killEscalationTimer) clearTimeout(entry.killEscalationTimer);
      entry.killEscalationTimer = setTimeout(() => {
        if (IS_WINDOWS) {
          // On Windows, child.killed / exitCode reflect cmd.exe, not
          // descendants. Force-terminate the tree unconditionally.
          sendSignal('FORCE');
        } else if (!child.killed && child.exitCode === null) {
          sendSignal('FORCE');
        }
      }, graceMs);
    });
  }
}

export function createExecutor(store: CardStore): Executor {
  return new ProcessExecutor(store);
}
