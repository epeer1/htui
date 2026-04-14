import { spawn, ChildProcess } from 'node:child_process';
import { Card, createCard } from './card.js';

export type CardUpdateCallback = () => void;

/**
 * Run mode: execute commands sequentially, each in its own card.
 */
export async function runCommands(
  commands: string[],
  cards: Card[],
  onUpdate: CardUpdateCallback,
): Promise<void> {
  for (let i = 0; i < commands.length; i++) {
    const card = cards[i];
    card.status = 'active';
    card.startedAt = Date.now();
    onUpdate();

    try {
      const exitCode = await executeCommand(commands[i], card, onUpdate);
      card.exitCode = exitCode;
      card.finishedAt = Date.now();

      if (exitCode === 0) {
        card.status = 'done';
      } else {
        card.status = 'failed';
        // Mark remaining cards as blocked
        for (let j = i + 1; j < cards.length; j++) {
          cards[j].status = 'blocked';
        }
        onUpdate();
        return;
      }
    } catch (err) {
      card.status = 'failed';
      card.finishedAt = Date.now();
      card.lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
      // Mark remaining as blocked
      for (let j = i + 1; j < cards.length; j++) {
        cards[j].status = 'blocked';
      }
      onUpdate();
      return;
    }

    onUpdate();
  }
}

function executeCommand(
  command: string,
  card: Card,
  onUpdate: CardUpdateCallback,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let lineBuffer = '';

    const processData = (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        card.lines.push(line.replace(/\r$/, ''));
        onUpdate();
      }
    };

    child.stdout?.on('data', processData);
    child.stderr?.on('data', processData);

    child.on('close', (code) => {
      // Flush remaining buffer
      if (lineBuffer) {
        card.lines.push(lineBuffer.replace(/\r$/, ''));
        onUpdate();
      }
      resolve(code ?? 1);
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
