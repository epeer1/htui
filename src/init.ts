import * as fs from 'node:fs';
import * as path from 'node:path';

const AGENTS_CONTENT_PATH = path.join(__dirname, '..', 'AGENTS.md');

interface Target {
  name: string;
  path: string;
  wrapFn?: (content: string) => string;
}

const TARGETS: Target[] = [
  {
    name: 'Generic (AGENTS.md)',
    path: 'AGENTS.md',
  },
  {
    name: 'Claude Code (CLAUDE.md)',
    path: 'CLAUDE.md',
    wrapFn: (content) => content, // same format
  },
  {
    name: 'GitHub Copilot',
    path: '.github/copilot-instructions.md',
    wrapFn: (content) => content,
  },
  {
    name: 'Cursor',
    path: '.cursorrules',
    wrapFn: (content) => content,
  },
  {
    name: 'Windsurf',
    path: '.windsurfrules',
    wrapFn: (content) => content,
  },
];

export function initAgentInstructions(targetDir: string, agents?: string[]): void {
  let content: string;
  try {
    content = fs.readFileSync(AGENTS_CONTENT_PATH, 'utf-8');
  } catch {
    // Fallback: if AGENTS.md isn't found relative to dist, try CWD
    const fallback = path.join(process.cwd(), 'node_modules', 'htui', 'AGENTS.md');
    try {
      content = fs.readFileSync(fallback, 'utf-8');
    } catch {
      console.error('Could not find htui AGENTS.md template');
      process.exit(1);
    }
  }

  const targets = agents
    ? TARGETS.filter(t => agents.some(a => t.name.toLowerCase().includes(a.toLowerCase())))
    : TARGETS;

  if (targets.length === 0) {
    console.log('No matching agent targets. Available: ' + TARGETS.map(t => t.name).join(', '));
    return;
  }

  for (const target of targets) {
    const fullPath = path.join(targetDir, target.path);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileContent = target.wrapFn ? target.wrapFn(content) : content;

    if (fs.existsSync(fullPath)) {
      // Append to existing file
      const existing = fs.readFileSync(fullPath, 'utf-8');
      if (existing.includes('htui')) {
        console.log(`  ✓ ${target.name}: ${target.path} (already contains htui instructions)`);
        continue;
      }
      fs.appendFileSync(fullPath, '\n\n' + fileContent);
      console.log(`  ✓ ${target.name}: appended to ${target.path}`);
    } else {
      fs.writeFileSync(fullPath, fileContent);
      console.log(`  ✓ ${target.name}: created ${target.path}`);
    }
  }
}

export function printInitHelp(): void {
  console.log(`
htui init — Install agent instructions for AI coding assistants

Usage:
  htui init                  Install for all agents
  htui init copilot          Install for GitHub Copilot only
  htui init claude           Install for Claude Code only
  htui init cursor           Install for Cursor only
  htui init windsurf         Install for Windsurf only

This creates/appends instruction files that teach AI agents
how to use htui's API mode (htui --api) for structured terminal output.

Files created:
  AGENTS.md                  Generic (works with many agents)
  CLAUDE.md                  Claude Code
  .github/copilot-instructions.md   GitHub Copilot
  .cursorrules               Cursor
  .windsurfrules             Windsurf
`);
}
