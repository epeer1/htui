/**
 * Socket path derivation and per-process window id.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export function workspaceHash(workspaceRoot: string): string {
  const normalized = IS_WINDOWS ? workspaceRoot.toLowerCase() : workspaceRoot;
  return crypto
    .createHash('sha1')
    .update(normalized)
    .digest('hex')
    .slice(0, 12);
}

export function socketPath(workspaceRoot: string): string {
  const hash = workspaceHash(workspaceRoot);
  if (IS_WINDOWS) {
    return `\\\\.\\pipe\\htui-${hash}`;
  }

  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    const dir = path.join(xdg, 'htui');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Check writability.
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, `${hash}.sock`);
    } catch {
      /* fall through */
    }
  }
  return `/tmp/htui-${hash}.sock`;
}

let cachedWindowId: string | null = null;
export function windowId(): string {
  if (cachedWindowId === null) {
    cachedWindowId = crypto.randomBytes(4).toString('hex');
  }
  return cachedWindowId;
}
