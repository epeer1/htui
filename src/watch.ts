/**
 * Entry point for `htui watch` mode.
 */

import { Terminal } from './terminal.js';
import { WatchRenderer } from './watch/renderer.js';
import { WatchController } from './watch/controller.js';

export interface RunWatchOpts {
  workspaceRoot: string;
  version: string;
}

export async function runWatch(opts: RunWatchOpts): Promise<void> {
  const terminal = new Terminal();
  const renderer = new WatchRenderer({ terminal });
  const controller = new WatchController({
    workspaceRoot: opts.workspaceRoot,
    terminal,
    renderer,
    packageVersion: opts.version,
  });

  let exited = false;
  const cleanup = (): void => {
    if (exited) return;
    exited = true;
    try {
      renderer.dispose();
    } catch {
      /* ignore */
    }
    try {
      terminal.exit();
    } catch {
      /* ignore */
    }
  };

  const onSigInt = (): void => {
    void controller.stop();
  };
  const onUncaught = (err: unknown): void => {
    cleanup();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  };

  process.on('SIGINT', onSigInt);
  process.on('uncaughtException', onUncaught);

  terminal.enter();
  try {
    await controller.start();
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('uncaughtException', onUncaught);
    cleanup();
  }
}
