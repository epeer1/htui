import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Markers ───────────────────────────────────────────────────────

const MARKER_START = '<!-- htui:start -->';
const MARKER_END = '<!-- htui:end -->';

// ─── Renderers ─────────────────────────────────────────────────────

function renderFullInstructions(): string {
  return [
    '# htui — prefer MCP tools for terminal commands',
    '',
    'When you need to run a shell command, prefer htui\'s MCP tools (`htui_exec`, `htui_run`, `htui_tail`, `htui_get`, `htui_search`, `htui_list`, `htui_kill`, `htui_summary`) over `run_in_terminal`. They return structured JSON (stdout, stderr, exitCode, durationMs) with no truncation, support parallel execution via `cardId`, and let you search across the whole session.',
    '',
    'Use `run_in_terminal` only for commands that need interactive input (htui\'s tools are non-interactive).',
    '',
    'If MCP is unavailable, fall back to `htui exec "<command>"` via `run_in_terminal` — it returns the same structured JSON as a single call.',
    '',
  ].join('\n');
}

function renderCopilotInstructions(): string {
  return renderFullInstructions();
}

function renderCopilotPathInstructions(): string {
  return '---\napplyTo: \'**\'\n---\n' + renderFullInstructions();
}

// ─── Layer 3: Target Matrix ────────────────────────────────────────

interface InitFlags {
  pathInstructions: boolean;
}

interface FileWrite {
  filePath: string;
  content: string;
  strategy: 'overwrite' | 'upsert';
  label: string;
}

function getCopilotWrites(flags: InitFlags): FileWrite[] {
  const writes: FileWrite[] = [
    {
      filePath: '.github/copilot-instructions.md',
      content: renderCopilotInstructions(),
      strategy: 'upsert',
      label: 'GitHub Copilot',
    },
  ];
  if (flags.pathInstructions) {
    writes.push({
      filePath: '.github/instructions/htui.instructions.md',
      content: renderCopilotPathInstructions(),
      strategy: 'upsert',
      label: 'Copilot path instructions',
    });
  }
  return writes;
}

// ─── Upsert logic ──────────────────────────────────────────────────

interface ResolveResult {
  content: string;
  action: 'created' | 'updated' | 'appended';
}

function resolveContent(existing: string | null, htuiContent: string): ResolveResult {
  const wrapped = MARKER_START + '\n' + htuiContent + '\n' + MARKER_END;

  if (existing === null) {
    return { content: wrapped, action: 'created' };
  }

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END.length);
    return { content: before + wrapped + after, action: 'updated' };
  }

  return { content: existing + '\n\n' + wrapped, action: 'appended' };
}

// ─── Flag + arg parsing ────────────────────────────────────────────

function parseInitArgs(argv: string[]): { flags: InitFlags; noPrompt: boolean } {
  const flags: InitFlags = { pathInstructions: false };
  let noPrompt = false;

  for (const arg of argv) {
    if (arg === '--path-instructions') {
      flags.pathInstructions = true;
    } else if (arg === '--no-prompt' || arg === '--yes' || arg === '-y') {
      noPrompt = true;
    }
  }

  return { flags, noPrompt };
}

// ─── Write a single file ───────────────────────────────────────────

interface WriteResult {
  label: string;
  filePath: string;
  action: string;
}

function writeFile(targetDir: string, fw: FileWrite): WriteResult {
  const fullPath = path.join(targetDir, fw.filePath);
  const dir = path.dirname(fullPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(fullPath, 'utf-8');
  } catch { /* file doesn't exist */ }

  if (fw.strategy === 'overwrite') {
    if (existing !== null && existing === fw.content) {
      return { label: fw.label, filePath: fw.filePath, action: 'unchanged' };
    }
    fs.writeFileSync(fullPath, fw.content);
    return {
      label: fw.label,
      filePath: fw.filePath,
      action: existing === null ? 'created' : 'updated',
    };
  }

  // upsert
  const resolved = resolveContent(existing, fw.content);
  if (existing !== null && existing === resolved.content) {
    return { label: fw.label, filePath: fw.filePath, action: 'unchanged' };
  }
  fs.writeFileSync(fullPath, resolved.content);
  return {
    label: fw.label,
    filePath: fw.filePath,
    action: resolved.action,
  };
}

// ─── MCP config / package.json / install mode ──────────────────────

export type InstallMode = 'global' | 'local' | 'npx';

export function detectInstallMode(scriptPath: string, workspaceRoot: string): InstallMode {
  const execpath = process.env.npm_execpath;
  if (execpath && execpath.toLowerCase().includes('npx')) {
    return 'npx';
  }
  const localRoot = path.resolve(workspaceRoot, 'node_modules', '@epeer1', 'htui');
  const resolved = path.resolve(scriptPath);
  if (resolved.toLowerCase().startsWith(localRoot.toLowerCase() + path.sep) ||
      resolved.toLowerCase() === localRoot.toLowerCase()) {
    return 'local';
  }
  return 'global';
}

export interface ResolvedHtuiPaths {
  nodePath: string;
  scriptPath: string;
}

// Resolve absolute, symlink-followed paths to the node binary and the htui CLI script.
// Returns null if rawScript is missing (caller should fall back to bare 'htui').
// Defaults to live process values; params allow injection for tests.
export function resolveHtuiAbsolutePaths(
  rawNode: string = process.execPath,
  rawScript: string | undefined = process.argv[1],
  realpath: (p: string) => string = fs.realpathSync,
): ResolvedHtuiPaths | null {
  if (!rawScript) return null;
  const resolveOne = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  const nodePath = resolveOne(rawNode).replace(/\\/g, '/');
  const scriptPath = resolveOne(rawScript).replace(/\\/g, '/');
  return { nodePath, scriptPath };
}

function buildHtuiServerEntry(
  mode: InstallMode,
  paths: ResolvedHtuiPaths | null = null,
): { command: string; args: string[] } {
  switch (mode) {
    case 'global':
      if (paths) {
        return {
          command: paths.nodePath,
          args: [paths.scriptPath, 'mcp', '--workspace', '${workspaceFolder}'],
        };
      }
      // Fallback: argv[1] missing — keep legacy behavior. PATH must be set.
      return { command: 'htui', args: ['mcp', '--workspace', '${workspaceFolder}'] };
    case 'local':
      return {
        command: 'node',
        args: ['node_modules/@epeer1/htui/dist/cli.js', 'mcp', '--workspace', '${workspaceFolder}'],
      };
    case 'npx':
      return {
        command: 'npx',
        args: ['-y', '@epeer1/htui', 'mcp', '--workspace', '${workspaceFolder}'],
      };
  }
}

// Strip JSONC comments (// line and /* block */) while respecting string literals.
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === '\'') {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // consume until newline
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Return indentation string ("  ", "    ", "\t", etc) detected from the first indented line.
function detectIndent(src: string, fallback: string = '  '): string {
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([ \t]+)\S/);
    if (m) return m[1];
  }
  return fallback;
}

export interface WriteMcpJsonResult {
  written: boolean;
  path: string;
  reason?: string;
}

export function writeMcpJson(
  workspaceRoot: string,
  mode: InstallMode,
  paths: ResolvedHtuiPaths | null = resolveHtuiAbsolutePaths(),
): WriteMcpJsonResult {
  const targetDir = path.join(workspaceRoot, '.vscode');
  const target = path.join(targetDir, 'mcp.json');
  const htuiEntry = buildHtuiServerEntry(mode, paths);

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(target, 'utf-8');
  } catch { /* missing */ }

  if (existing === null) {
    fs.mkdirSync(targetDir, { recursive: true });
    const payload = { servers: { htui: htuiEntry } };
    fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n');
    return { written: true, path: target, reason: 'created' };
  }

  // Parse with comments stripped
  let parsed: Record<string, unknown>;
  try {
    const stripped = stripJsonComments(existing);
    parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not an object');
    }
  } catch (err) {
    console.error(`\x1b[31merror\x1b[0m  Could not parse existing .vscode/mcp.json: ${(err as Error).message}`);
    console.error('       Skipping MCP config update. Please fix the file or remove it and re-run `htui init`.');
    return { written: false, path: target, reason: 'parse-error' };
  }

  const indent = detectIndent(existing, '  ');
  const servers = (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers))
    ? parsed.servers as Record<string, unknown>
    : {};
  servers.htui = htuiEntry;
  parsed.servers = servers;

  const trailingNewline = existing.endsWith('\n') ? '\n' : '';
  const newContent = JSON.stringify(parsed, null, indent) + trailingNewline;

  if (newContent === existing) {
    return { written: false, path: target, reason: 'unchanged' };
  }

  fs.writeFileSync(target, newContent);
  return { written: true, path: target, reason: 'updated' };
}

export interface AddWatchScriptResult {
  added: boolean;
  reason?: string;
}

export function addWatchScript(workspaceRoot: string): AddWatchScriptResult {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { added: false, reason: 'no-package-json' };
  }

  const existing = fs.readFileSync(pkgPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not an object');
    }
  } catch (err) {
    console.error(`\x1b[31merror\x1b[0m  Could not parse package.json: ${(err as Error).message}`);
    return { added: false, reason: 'parse-error' };
  }

  const scripts = (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts))
    ? parsed.scripts as Record<string, unknown>
    : {};

  if (typeof scripts['htui:watch'] === 'string') {
    return { added: false, reason: 'exists' };
  }

  scripts['htui:watch'] = 'htui watch';
  parsed.scripts = scripts;

  const indent = detectIndent(existing, '  ');
  const trailingNewline = existing.endsWith('\n') ? '\n' : '';
  const newContent = JSON.stringify(parsed, null, indent) + trailingNewline;

  if (newContent === existing) {
    return { added: false, reason: 'unchanged' };
  }

  fs.writeFileSync(pkgPath, newContent);
  return { added: true };
}

// ─── Public API ────────────────────────────────────────────────────

export async function initAgentInstructions(targetDir: string, argv: string[]): Promise<void> {
  const { flags, noPrompt } = parseInitArgs(argv);

  const allWrites: FileWrite[] = getCopilotWrites(flags);

  const results: WriteResult[] = [];
  for (const fw of allWrites) {
    results.push(writeFile(targetDir, fw));
  }

  // MCP config + package.json script
  const installMode = detectInstallMode(process.argv[1] || '', targetDir);
  const mcpResult = writeMcpJson(targetDir, installMode);
  const watchScriptResult = addWatchScript(targetDir);

  // Per-file status report
  console.log('');
  for (const r of results) {
    let color: string;
    switch (r.action) {
      case 'created':   color = '\x1b[32m'; break; // green
      case 'appended':  color = '\x1b[33m'; break; // yellow
      case 'updated':   color = '\x1b[36m'; break; // cyan
      case 'unchanged': color = '\x1b[2m';  break; // dim
      default:          color = '';
    }
    console.log(`  ${color}${r.action}\x1b[0m  ${r.filePath} \x1b[2m(${r.label})\x1b[0m`);
  }
  {
    const action = mcpResult.written
      ? (mcpResult.reason === 'created' ? 'created' : 'updated')
      : (mcpResult.reason === 'parse-error' ? 'skipped' : 'unchanged');
    const color =
      action === 'created'  ? '\x1b[32m' :
      action === 'updated'  ? '\x1b[36m' :
      action === 'skipped'  ? '\x1b[31m' :
      '\x1b[2m';
    console.log(`  ${color}${action}\x1b[0m  .vscode/mcp.json \x1b[2m(MCP server, mode: ${installMode})\x1b[0m`);
  }
  {
    let action: string;
    if (watchScriptResult.added) {
      action = 'added';
    } else if (watchScriptResult.reason === 'exists') {
      action = 'unchanged';
    } else if (watchScriptResult.reason === 'no-package-json') {
      action = 'skipped';
    } else {
      action = watchScriptResult.reason || 'unchanged';
    }
    const color =
      action === 'added'     ? '\x1b[32m' :
      action === 'skipped'   ? '\x1b[2m'  :
      action === 'unchanged' ? '\x1b[2m'  :
      '\x1b[31m';
    console.log(`  ${color}${action}\x1b[0m  package.json \x1b[2m(htui:watch script)\x1b[0m`);
  }

  // Summary
  console.log('');
  console.log('\x1b[1mhtui installed.\x1b[0m');
  if (mcpResult.written || mcpResult.reason === 'unchanged') {
    console.log(`  MCP server configured in .vscode/mcp.json`);
  }
  console.log(`  Copilot instructions updated`);
  console.log('  Reload VS Code, then run `htui watch` in a terminal to follow agent activity.');

  // Optional interactive prompt
  if (!noPrompt && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await promptYesNo('Start `htui watch` now? [y/N] ');
    if (answer) {
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, [process.argv[1], 'watch'], {
          detached: true,
          stdio: 'ignore',
          cwd: targetDir,
        });
        child.unref();
      } catch (err) {
        console.error(`Failed to start htui watch: ${(err as Error).message}`);
      }
    }
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        const answer = buf.slice(0, nl).trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      }
    };
    process.stdin.on('data', onData);
  });
}

export function printInitHelp(): void {
  console.log(`
htui init — Install htui for GitHub Copilot in VS Code

Usage:
  htui init                          Install (interactive watch prompt)
  htui init --yes                    Install non-interactively
  htui init --help                   Show this help

What it does:
  - Writes .github/copilot-instructions.md
  - Writes .vscode/mcp.json so Copilot can discover htui's MCP tools
  - Adds an "htui:watch" script to package.json (if present)
  - Optionally starts \`htui watch\` in the background (interactive only)

Flags:
  --path-instructions     Also write .github/instructions/htui.instructions.md
  --yes, -y, --no-prompt  Non-interactive (skip the watch prompt)

The instruction file uses <!-- htui:start/end --> markers so re-running
updates in place without touching your existing content.
`);
}