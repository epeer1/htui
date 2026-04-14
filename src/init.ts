import * as fs from 'node:fs';
import * as path from 'node:path';
import { multiSelect } from './select.js';

// ─── Markers ───────────────────────────────────────────────────────

const MARKER_START = '<!-- htui:start -->';
const MARKER_END = '<!-- htui:end -->';

// ─── Layer 1: Instruction Model ────────────────────────────────────

interface QuickPatternExample {
  title: string;
  request: string;
  response?: string;
}

interface CommandEntry {
  name: string;
  requiredFields: string;
  optionalFields: string;
  description: string;
}

interface CommandDetail {
  heading: string;
  items: string[];
}

interface EventEntry {
  event: string;
  keyFields: string;
  when: string;
}

interface InstructionModel {
  summary: string;
  startupCommand: string;
  quickStartRequest: string;
  quickStartNote: string;
  quickPatternIntro: string;
  quickPatternExamples: QuickPatternExample[];
  commands: CommandEntry[];
  commandDetails: CommandDetail[];
  events: EventEntry[];
  cardStatuses: string[];
  tips: string[];
}

function buildInstructionModel(): InstructionModel {
  return {
    summary: 'Structured terminal for AI agents. Run commands, get clean JSON output \u2014 no ANSI parsing, no interleaving.',
    startupCommand: 'node node_modules/htui/dist/cli.js --api',
    quickStartRequest: '{"cmd": "run", "command": "npm test", "wait": true, "timeout": 30000}',
    quickStartNote: '\u2192 Returns `card_done` with all output in `lines` array when finished.',
    quickPatternIntro: 'Use `"wait": true` for any command you want to run and get results from. htui buffers all output and returns it in one response when the command finishes.',
    quickPatternExamples: [
      {
        title: 'Run and wait:',
        request: '{"cmd": "run", "command": "npm test", "wait": true, "timeout": 30000}',
        response: '{"event": "card_done", "card": 0, "status": "done", "exitCode": 0, "duration": "2.1s", "lineCount": 42, "lines": ["PASS src/utils.test.ts", "..."]}',
      },
      {
        title: 'Search across output:',
        request: '{"cmd": "search", "pattern": "error|FAIL", "regex": true}',
        response: '{"event": "search_results", "pattern": "error|FAIL", "matches": [{"card": 0, "lineNumber": 12, "line": "FAIL src/bad.test.ts", "stream": "stderr"}], "totalMatches": 1, "truncated": false}',
      },
      {
        title: 'Get only stderr from a card:',
        request: '{"cmd": "get", "card": 0, "stream": "stderr"}',
      },
    ],
    commands: [
      { name: 'run', requiredFields: '`command`', optionalFields: '`wait`, `timeout`, `cwd`, `env`, `silent`, `tag`', description: 'Run a shell command' },
      { name: 'get', requiredFields: '`card`', optionalFields: '`lines`, `stream`', description: 'Get output from a card' },
      { name: 'list', requiredFields: '\u2014', optionalFields: '`status`', description: 'List all cards' },
      { name: 'search', requiredFields: '`pattern`', optionalFields: '`regex`, `ignoreCase`, `stream`, `cards`, `limit`', description: 'Search across card output' },
      { name: 'kill', requiredFields: '`card`', optionalFields: '`signal`', description: 'Kill an active command' },
      { name: 'summary', requiredFields: '\u2014', optionalFields: '\u2014', description: 'Get counts by status' },
      { name: 'clear', requiredFields: '\u2014', optionalFields: '`killActive`', description: 'Kill active + clear all cards' },
      { name: 'exit', requiredFields: '\u2014', optionalFields: '\u2014', description: 'Shut down htui' },
    ],
    commandDetails: [
      {
        heading: 'Run options detail',
        items: [
          '`wait: true` \u2014 buffer output, return all lines in `card_done` (recommended)',
          '`timeout: ms` \u2014 kill command after timeout, status becomes `"timeout"`',
          '`silent: true` \u2014 suppress streaming `card_output` events (like `wait` but no lines in response)',
          '`cwd: "/path"` \u2014 working directory for the command',
          '`env: {"KEY": "val"}` \u2014 extra environment variables',
          '`tag: "build"` \u2014 label to identify the card in events',
        ],
      },
      {
        heading: 'Get options detail',
        items: [
          '`lines: [start, end]` \u2014 slice of output lines (0-indexed)',
          '`stream: "stdout"|"stderr"` \u2014 filter by output stream',
        ],
      },
      {
        heading: 'Search options detail',
        items: [
          '`regex: true` \u2014 treat pattern as regex',
          '`ignoreCase: true` \u2014 case-insensitive (default: true)',
          '`stream: "stdout"|"stderr"` \u2014 search only one stream',
          '`cards: [0, 2]` \u2014 search only specific cards',
          '`limit: 50` \u2014 max matches to return (default: 100)',
        ],
      },
      {
        heading: 'List options detail',
        items: [
          '`status: "active"` or `status: ["done", "failed"]` \u2014 filter by card status',
        ],
      },
    ],
    events: [
      { event: 'ready', keyFields: '`version: 2`', when: 'htui started' },
      { event: 'card_created', keyFields: '`card`, `title`, `status`', when: 'Command started' },
      { event: 'card_output', keyFields: '`card`, `line`, `stream`', when: 'New output line (streaming mode only)' },
      { event: 'card_done', keyFields: '`card`, `status`, `exitCode`, `duration`, `lineCount`, `lines?`', when: 'Command finished' },
      { event: 'card_content', keyFields: '`card`, `lines`, `status`, `exitCode`, `duration`', when: 'Response to `get`' },
      { event: 'card_killed', keyFields: '`card`, `signal`', when: 'Response to `kill`' },
      { event: 'cards', keyFields: '`cards[]`', when: 'Response to `list`' },
      { event: 'search_results', keyFields: '`pattern`, `matches[]`, `totalMatches`, `truncated`', when: 'Response to `search`' },
      { event: 'summary', keyFields: '`total`, `active`, `done`, `failed`, `killed`, `timeout`', when: 'Response to `summary`' },
      { event: 'cleared', keyFields: '`killedCards`, `clearedCards`', when: 'Response to `clear`' },
      { event: 'error', keyFields: '`message`', when: 'Invalid command or args' },
    ],
    cardStatuses: ['active', 'done', 'failed', 'killed', 'timeout'],
    tips: [
      '**Always use `wait: true`** unless you need real-time streaming for long-running processes',
      '**Set `timeout`** on every `wait` command to avoid hanging (30s for tests, 60s for builds)',
      '**Use `search`** to find errors/failures instead of scanning all output lines manually',
      '**Use `get` with `stream: "stderr"`** to isolate error output',
      '**Cards are numbered 0, 1, 2...** \u2014 use `list` if you lose track',
      '**One htui session per workspace** \u2014 start once, reuse for all commands',
    ],
  };
}

// ─── Layer 2: Renderers ────────────────────────────────────────────

function renderAgentsMd(model: InstructionModel): string {
  const lines: string[] = [];

  lines.push('# htui \u2014 Agent Instructions');
  lines.push('');
  lines.push(model.summary);
  lines.push('');

  // Quick Start
  lines.push('## Quick Start');
  lines.push('');
  lines.push('Start htui once per session:');
  lines.push('```');
  lines.push(model.startupCommand);
  lines.push('```');
  lines.push('');
  lines.push('Then run commands:');
  lines.push('```json');
  lines.push(model.quickStartRequest);
  lines.push('```');
  lines.push(model.quickStartNote);
  lines.push('');

  // Quick Pattern
  lines.push('## Quick Pattern \u2014 Use This for Most Commands');
  lines.push('');
  lines.push(model.quickPatternIntro);
  lines.push('');
  for (const ex of model.quickPatternExamples) {
    lines.push(`**${ex.title}**`);
    lines.push('```json');
    lines.push(ex.request);
    lines.push('```');
    if (ex.response) {
      lines.push('Response:');
      lines.push('```json');
      lines.push(ex.response);
      lines.push('```');
    }
    lines.push('');
  }

  // All Commands table
  lines.push('## All Commands');
  lines.push('');
  lines.push('| Command | Required Fields | Optional Fields | Description |');
  lines.push('|---------|----------------|-----------------|-------------|');
  for (const cmd of model.commands) {
    lines.push(`| \`${cmd.name}\` | ${cmd.requiredFields} | ${cmd.optionalFields} | ${cmd.description} |`);
  }
  lines.push('');

  // Command details
  for (const detail of model.commandDetails) {
    lines.push(`### ${detail.heading}`);
    lines.push('');
    for (const item of detail.items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // All Events table
  lines.push('## All Events');
  lines.push('');
  lines.push('| Event | Key Fields | When |');
  lines.push('|-------|-----------|------|');
  for (const ev of model.events) {
    lines.push(`| \`${ev.event}\` | ${ev.keyFields} | ${ev.when} |`);
  }
  lines.push('');

  lines.push(`Card statuses: ${model.cardStatuses.map(s => `\`${s}\``).join(', ')}`);
  lines.push('');

  // Tips
  lines.push('## Tips');
  lines.push('');
  for (const tip of model.tips) {
    lines.push(`- ${tip}`);
  }
  lines.push('');

  return lines.join('\n');
}

function renderShim(model: InstructionModel): string {
  const lines: string[] = [];

  lines.push('# htui \u2014 Terminal Commands');
  lines.push('');
  lines.push('This repo uses [htui](https://github.com/epeer1/htui) (`htui --api`) for structured terminal access. All terminal commands should go through htui\'s JSON protocol instead of running shell commands directly.');
  lines.push('');
  lines.push('## Start htui');
  lines.push('');
  lines.push('```');
  lines.push(model.startupCommand);
  lines.push('```');
  lines.push('');
  lines.push('## Run a command');
  lines.push('');
  lines.push('```json');
  lines.push(model.quickStartRequest);
  lines.push('```');
  lines.push('');
  lines.push('Returns structured JSON with exit code, duration, and all output lines.');
  lines.push('');
  lines.push('## Full protocol');
  lines.push('');
  lines.push('See [AGENTS.md](./AGENTS.md) for all commands, events, and options.');
  lines.push('');

  return lines.join('\n');
}

function renderCopilotInstructions(model: InstructionModel): string {
  return renderShim(model);
}

function renderCopilotPathInstructions(model: InstructionModel): string {
  return '---\napplyTo: \'**\'\n---\n' + renderShim(model);
}

function renderClaudeMd(model: InstructionModel): string {
  return renderShim(model);
}

function renderCursorRule(model: InstructionModel): string {
  return '---\ndescription: Use htui --api for all terminal commands in this repo\nglobs: \nalwaysApply: true\n---\n' + renderShim(model);
}

function renderCursorRulesLegacy(model: InstructionModel): string {
  return renderShim(model);
}

function renderWindsurfRules(model: InstructionModel): string {
  return renderShim(model);
}

function renderGeminiMd(model: InstructionModel): string {
  return renderShim(model);
}

function renderAntigravitySkill(model: InstructionModel): string {
  const lines: string[] = [];

  lines.push('# htui');
  lines.push('');
  lines.push(model.summary);
  lines.push('');
  lines.push('## Start htui');
  lines.push('');
  lines.push('```');
  lines.push(model.startupCommand);
  lines.push('```');
  lines.push('');
  lines.push('## Quick start');
  lines.push('');
  lines.push('```json');
  lines.push(model.quickStartRequest);
  lines.push('```');
  lines.push(model.quickStartNote);
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  for (const cmd of model.commands) {
    lines.push(`- **${cmd.name}** \u2014 ${cmd.description}`);
  }
  lines.push('');
  lines.push('See AGENTS.md for full event protocol and options.');
  lines.push('');

  return lines.join('\n');
}

// ─── Layer 3: Target Matrix ────────────────────────────────────────

type AgentId = 'copilot' | 'claude' | 'cursor' | 'windsurf' | 'antigravity';

interface InitFlags {
  legacy: boolean;
  skill: boolean;
  pathInstructions: boolean;
}

interface FileWrite {
  filePath: string;
  content: string;
  strategy: 'overwrite' | 'upsert';
  label: string;
}

interface AgentTarget {
  id: AgentId;
  label: string;
  getWrites: (model: InstructionModel, flags: InitFlags) => FileWrite[];
}

const AGENT_TARGETS: AgentTarget[] = [
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    getWrites(model, flags) {
      const writes: FileWrite[] = [
        {
          filePath: '.github/copilot-instructions.md',
          content: renderCopilotInstructions(model),
          strategy: 'upsert',
          label: 'GitHub Copilot',
        },
      ];
      if (flags.pathInstructions) {
        writes.push({
          filePath: '.github/instructions/htui.instructions.md',
          content: renderCopilotPathInstructions(model),
          strategy: 'upsert',
          label: 'Copilot path instructions',
        });
      }
      return writes;
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    getWrites(model) {
      return [{
        filePath: 'CLAUDE.md',
        content: renderClaudeMd(model),
        strategy: 'upsert',
        label: 'Claude Code',
      }];
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    getWrites(model, flags) {
      if (flags.legacy) {
        return [{
          filePath: '.cursorrules',
          content: renderCursorRulesLegacy(model),
          strategy: 'upsert',
          label: 'Cursor (legacy)',
        }];
      }
      return [{
        filePath: '.cursor/rules/htui.mdc',
        content: renderCursorRule(model),
        strategy: 'overwrite',
        label: 'Cursor',
      }];
    },
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    getWrites(model) {
      return [{
        filePath: '.windsurfrules',
        content: renderWindsurfRules(model),
        strategy: 'upsert',
        label: 'Windsurf',
      }];
    },
  },
  {
    id: 'antigravity',
    label: 'Antigravity (Gemini)',
    getWrites(model, flags) {
      const writes: FileWrite[] = [
        {
          filePath: 'GEMINI.md',
          content: renderGeminiMd(model),
          strategy: 'upsert',
          label: 'Antigravity (Gemini)',
        },
      ];
      if (flags.skill) {
        writes.push({
          filePath: 'skills/htui/SKILL.md',
          content: renderAntigravitySkill(model),
          strategy: 'overwrite',
          label: 'Antigravity skill',
        });
      }
      return writes;
    },
  },
];

const VALID_IDS: AgentId[] = AGENT_TARGETS.map(t => t.id);

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

function parseInitArgs(argv: string[]): { agents: string[]; flags: InitFlags } {
  const flags: InitFlags = { legacy: false, skill: false, pathInstructions: false };
  const agents: string[] = [];

  for (const arg of argv) {
    if (arg === '--legacy') {
      flags.legacy = true;
    } else if (arg === '--skill') {
      flags.skill = true;
    } else if (arg === '--path-instructions') {
      flags.pathInstructions = true;
    } else if (!arg.startsWith('-')) {
      agents.push(arg);
    }
  }

  return { agents, flags };
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
    fs.writeFileSync(fullPath, fw.content);
    return {
      label: fw.label,
      filePath: fw.filePath,
      action: existing === null ? 'created' : 'updated',
    };
  }

  // upsert
  const resolved = resolveContent(existing, fw.content);
  fs.writeFileSync(fullPath, resolved.content);
  return {
    label: fw.label,
    filePath: fw.filePath,
    action: resolved.action,
  };
}

// ─── Public API ────────────────────────────────────────────────────

export async function initAgentInstructions(targetDir: string, argv: string[]): Promise<void> {
  const { agents, flags } = parseInitArgs(argv);

  let selectedIds: AgentId[];

  if (agents.length > 0) {
    const unknown = agents.filter(a => !VALID_IDS.includes(a as AgentId));
    if (unknown.length > 0) {
      console.error(`Unknown agent(s): ${unknown.join(', ')}`);
      console.error(`Valid agents: ${VALID_IDS.join(', ')}`);
      return;
    }
    selectedIds = agents as AgentId[];
  } else {
    const result = await multiSelect(
      'Select agents to install for: (Space to toggle, Enter to confirm)',
      AGENT_TARGETS.map(t => ({ label: t.label, value: t.id, checked: true })),
    );
    if (result.aborted) {
      console.log('Cancelled.');
      return;
    }
    selectedIds = result.selected as AgentId[];
  }

  if (selectedIds.length === 0) {
    console.log('No agents selected.');
    return;
  }

  const model = buildInstructionModel();

  // Always write AGENTS.md (overwrite, no markers)
  const allWrites: FileWrite[] = [
    {
      filePath: 'AGENTS.md',
      content: renderAgentsMd(model),
      strategy: 'overwrite',
      label: 'AGENTS.md',
    },
  ];

  // Collect writes for selected agents
  for (const target of AGENT_TARGETS) {
    if (selectedIds.includes(target.id)) {
      allWrites.push(...target.getWrites(model, flags));
    }
  }

  // Execute writes
  const results: WriteResult[] = [];
  for (const fw of allWrites) {
    results.push(writeFile(targetDir, fw));
  }

  // Print status report
  console.log('');
  for (const r of results) {
    let color: string;
    switch (r.action) {
      case 'created':  color = '\x1b[32m'; break; // green
      case 'appended': color = '\x1b[33m'; break; // yellow
      case 'updated':  color = '\x1b[36m'; break; // cyan
      default:         color = '';
    }
    console.log(`  ${color}${r.action}\x1b[0m  ${r.filePath} \x1b[2m(${r.label})\x1b[0m`);
  }

  console.log('\n\x1b[1mDone!\x1b[0m Your AI agents will now use htui --api for terminal commands.');
}

export function printInitHelp(): void {
  console.log(`
htui init \u2014 Install agent instructions for AI coding assistants

Usage:
  htui init                          Interactive prompt to select agents
  htui init copilot claude           Install for specific agents
  htui init --help                   Show this help

Agents:
  copilot        GitHub Copilot      \u2192 .github/copilot-instructions.md
  claude         Claude Code         \u2192 CLAUDE.md
  cursor         Cursor              \u2192 .cursor/rules/htui.mdc
  windsurf       Windsurf            \u2192 .windsurfrules
  antigravity    Antigravity/Gemini  \u2192 GEMINI.md

Flags:
  --legacy              Cursor: write .cursorrules instead of .cursor/rules/htui.mdc
  --skill               Antigravity: also write skills/htui/SKILL.md
  --path-instructions   Copilot: also write .github/instructions/htui.instructions.md

AGENTS.md is always created/updated as the canonical instruction file.
Agent-specific files get htui instructions wrapped in <!-- htui:start/end -->
markers so they can be updated in place on subsequent runs.
`);
}