/**
 * IPC wire protocol: newline-delimited JSON frames between the htui server
 * and watch clients. Pure types + encode/decode helpers.
 */

import type { StoreCard, StoreEvent } from '../cards/types.js';

export type ServerMsg =
  | StoreEvent
  | {
      t: 'hello';
      seq: number;
      pid: number;
      version: string;
      workspace: string;
      windowId: string;
    }
  | { t: 'snapshot'; seq: number; cards: StoreCard[] }
  | { t: 'bye'; reason: string };

export type ClientMsg =
  | { t: 'resume'; sinceSeq: number }
  | { t: 'ping' };

export type AnyMsg = ServerMsg | ClientMsg;

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg) + '\n';
}

export class Decoder {
  private buf = '';

  push(chunk: Buffer | string): AnyMsg[] {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: AnyMsg[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as AnyMsg);
      } catch {
        const err = new Error('bad-ipc-frame') as Error & { line?: string };
        err.line = line;
        throw err;
      }
    }
    return out;
  }
}
