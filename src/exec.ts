import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface ExecOptions {
  command: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  status: 'done' | 'failed' | 'timeout' | 'error';
  durationMs: number;
  duration: string;
  stdout: string[];
  stderr: string[];
  output: string[];
  lineCount: number;
  command: string;
  signal?: string;
  error?: string;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildResult(
  partial: Omit<ExecResult, 'ok' | 'lineCount' | 'durationMs' | 'duration'> & { durationMs: number },
): ExecResult {
  return {
    ...partial,
    ok: partial.status === 'done',
    duration: formatDuration(partial.durationMs),
    lineCount: partial.output.length,
  };
}

export function execCommand(options: ExecOptions): Promise<never> {
  const cwd = options.cwd || process.cwd();

  // Validate cwd exists
  if (options.cwd && !fs.existsSync(options.cwd)) {
    const result = buildResult({
      exitCode: 1,
      status: 'error',
      durationMs: 0,
      stdout: [],
      stderr: [],
      output: [],
      command: options.command,
      error: `Directory does not exist: ${options.cwd}`,
    });
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  const startTime = Date.now();

  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : '/bin/sh';
  const shellFlag = isWindows ? '/c' : '-c';

  const env = options.env ? { ...process.env, ...options.env } : process.env;

  const child = spawn(shell, [shellFlag, options.command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env,
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const output: string[] = [];
  let timedOut = false;

  // Timeout handling
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout && options.timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeout);
  }

  // Process stdout
  let stdoutBuffer = '';
  child.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const clean = line.replace(/\r$/, '');
      stdoutLines.push(clean);
      output.push(clean);
    }
  });

  // Process stderr
  let stderrBuffer = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const clean = line.replace(/\r$/, '');
      stderrLines.push(clean);
      output.push(clean);
    }
  });

  return new Promise<never>((_, reject) => {
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);

      // Flush remaining buffers
      if (stdoutBuffer) {
        const clean = stdoutBuffer.replace(/\r$/, '');
        stdoutLines.push(clean);
        output.push(clean);
      }
      if (stderrBuffer) {
        const clean = stderrBuffer.replace(/\r$/, '');
        stderrLines.push(clean);
        output.push(clean);
      }

      const durationMs = Date.now() - startTime;
      let status: ExecResult['status'];
      if (timedOut) {
        status = 'timeout';
      } else if (code === 0) {
        status = 'done';
      } else {
        status = 'failed';
      }

      const result = buildResult({
        exitCode: code ?? 1,
        status,
        durationMs,
        stdout: stdoutLines,
        stderr: stderrLines,
        output,
        command: options.command,
        ...(signal ? { signal } : {}),
      });

      console.log(JSON.stringify(result));
      process.exit(result.ok ? 0 : code ?? 1);
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const result = buildResult({
        exitCode: 1,
        status: 'error',
        durationMs,
        stdout: stdoutLines,
        stderr: stderrLines,
        output,
        command: options.command,
        error: err.message,
      });
      console.log(JSON.stringify(result));
      process.exit(1);
    });
  });
}
