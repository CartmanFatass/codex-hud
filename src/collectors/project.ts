/**
 * Project information collector
 * Phase 3: Extended with INSTRUCTIONS.md count, rules count, MCP count
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectInfo, CodexConfig } from '../types.js';
import { getMcpServerCount } from './codex-config.js';
import { getCodexHome } from '../utils/codex-path.js';
import * as os from 'os';

const AGENTS_MD_FILENAMES = [
  'AGENTS.md',
  'agents.md',
  'CODEX.md',
  'codex.md',
];

const INSTRUCTIONS_MD_FILENAMES = [
  'INSTRUCTIONS.md',
  'instructions.md',
];

/**
 * Get the project name from the current directory
 * Tries git remote first, then falls back to folder name
 */
export function getProjectName(cwd: string): string {
  // Just use the folder name
  return path.basename(cwd);
}

/**
 * Count files matching a list of filenames in a directory tree
 * Searches from cwd up to git root or filesystem root
 */
function countFilesInTree(cwd: string, filenames: string[], checkCodexDir: boolean = true): number {
  let count = 0;
  let currentDir = cwd;
  const visited = new Set<string>();
  
  // Walk up the directory tree
  while (currentDir && !visited.has(currentDir)) {
    visited.add(currentDir);
    
    // Check for files in current directory
    for (const filename of filenames) {
      const filePath = path.join(currentDir, filename);
      if (fs.existsSync(filePath)) {
        count++;
        break; // Only count one per directory
      }
    }
    
    // Check in .codex subdirectory too
    if (checkCodexDir) {
      const codexDir = path.join(currentDir, '.codex');
      if (fs.existsSync(codexDir) && fs.statSync(codexDir).isDirectory()) {
        for (const filename of filenames) {
          const filePath = path.join(codexDir, filename);
          if (fs.existsSync(filePath)) {
            count++;
            break;
          }
        }
      }
    }
    
    // Stop at git root or filesystem root
    const gitDir = path.join(currentDir, '.git');
    if (fs.existsSync(gitDir)) {
      break;
    }
    
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parent;
  }
  
  return count;
}

/**
 * Count AGENTS.md files in the directory tree
 * Searches from cwd up to git root or filesystem root
 */
export function countAgentsMdFiles(cwd: string): number {
  return countFilesInTree(cwd, AGENTS_MD_FILENAMES, true);
}

/**
 * Count INSTRUCTIONS.md files in the directory tree
 */
export function countInstructionsMdFiles(cwd: string): number {
  return countFilesInTree(cwd, INSTRUCTIONS_MD_FILENAMES, true);
}

/**
 * Count rule files in .codex/rules directory
 */
export function countRulesFiles(cwd: string): number {
  const rulesDir = path.join(cwd, '.codex', 'rules');
  
  if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) {
    return 0;
  }
  
  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Check if .codex directory exists in cwd
 */
export function hasCodexDir(cwd: string): boolean {
  const codexDir = path.join(cwd, '.codex');
  return fs.existsSync(codexDir) && fs.statSync(codexDir).isDirectory();
}

/**
 * Count configuration files in .codex directory
 * Counts: config.toml, config.json, *.toml, *.json
 */
export function countConfigFiles(cwd: string): number {
  const codexDir = path.join(cwd, '.codex');
  
  if (!fs.existsSync(codexDir) || !fs.statSync(codexDir).isDirectory()) {
    return 0;
  }
  
  try {
    const files = fs.readdirSync(codexDir);
    return files.filter(f => 
      f.endsWith('.toml') || 
      f.endsWith('.json') ||
      f === 'config' ||
      f === 'settings'
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Detect current work mode from environment variables or config
 * Returns 'development', 'production', or 'unknown'
 */
export function detectWorkMode(): 'development' | 'production' | 'unknown' {
  // Check environment variables
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  const codexEnv = process.env.CODEX_ENV?.toLowerCase();
  
  if (codexEnv === 'production' || nodeEnv === 'production') {
    return 'production';
  }
  if (codexEnv === 'development' || nodeEnv === 'development') {
    return 'development';
  }
  
  // Default to development if not specified
  return 'development';
}

/**
 * The folders from cwd up to its repository's root, nearest first. A `.git`
 * counts only with a HEAD inside (or as a worktree's file): an empty `.git`
 * folder in a home directory is not a repository. Without a root, cwd alone.
 */
function repoFolders(cwd: string): string[] {
  const folders: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    folders.push(dir);
    const git = path.join(dir, '.git');
    try {
      if (fs.statSync(git).isFile() || fs.existsSync(path.join(git, 'HEAD'))) return folders;
    } catch { /* no .git here */ }
    if (path.dirname(dir) === dir) return [path.resolve(cwd)];
  }
}

/**
 * Skills Codex can load in cwd, each name once: its home's skills and the
 * bundled `.system` ones, the user's `~/.agents/skills`, and `.agents/skills`
 * and `.codex/skills` from cwd up to the repository root. A skill is a folder
 * with a SKILL.md. Null when no skills folder could be read at all.
 */
export function countSkills(cwd: string, codexHome: string = getCodexHome(), home: string = os.homedir()): number | null {
  const roots = [path.join(codexHome, 'skills'), path.join(codexHome, 'skills', '.system'), path.join(home, '.agents', 'skills'),
    ...repoFolders(cwd).flatMap((dir) => [path.join(dir, '.agents', 'skills'), path.join(dir, '.codex', 'skills')])];
  const names = new Set<string>();
  let read = false;
  for (const root of [...new Set(roots)]) {
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { continue; }
    read = true;
    for (const name of entries) {
      if (!name.startsWith('.') && fs.existsSync(path.join(root, name, 'SKILL.md'))) names.add(name);
    }
  }
  return read ? names.size : null;
}

/**
 * Hook handlers in the hooks.json files Codex reads: its home's and the
 * repository's `.codex/hooks.json`. Each event holds groups and each group its
 * handlers; the handlers are counted. Null when neither file could be read.
 */
export function countHooks(cwd: string, codexHome: string = getCodexHome()): number | null {
  const root = repoFolders(cwd).at(-1) ?? cwd;
  const files = [...new Set([path.join(codexHome, 'hooks.json'), path.join(root, '.codex', 'hooks.json')])];
  let total = 0;
  let read = false;
  for (const file of files) {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    read = true;
    const events = (parsed as { hooks?: unknown })?.hooks;
    if (!events || typeof events !== 'object') continue;
    for (const groups of Object.values(events as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const handlers = (group as { hooks?: unknown })?.hooks;
        if (Array.isArray(handlers)) total += handlers.length;
      }
    }
  }
  return read ? total : null;
}

/**
 * Collect all project information
 * Phase 3: Extended with additional file counts and Codex-specific module status
 */
export function collectProjectInfo(cwd?: string, config?: CodexConfig): ProjectInfo {
  const workDir = cwd || process.cwd();
  
  // Count config files in .codex directory
  const configsCount = countConfigFiles(workDir);
  
  // Detect work mode from environment or config
  const workMode = detectWorkMode();
  
  // Count extensions (MCP servers count as extensions)
  const mcpCount = config ? getMcpServerCount(config) : 0;
  
  return {
    cwd: workDir,
    projectName: getProjectName(workDir),
    agentsMdCount: countAgentsMdFiles(workDir),
    hasCodexDir: hasCodexDir(workDir),
    instructionsMdCount: countInstructionsMdFiles(workDir),
    rulesCount: countRulesFiles(workDir),
    mcpCount,
    configsCount,
    extensionsCount: mcpCount,  // MCP servers are treated as extensions
    skillsCount: countSkills(workDir),
    hooksCount: config?.hooks_enabled === false ? 0 : countHooks(workDir),
    workMode,
  };
}

/**
 * Format project path for display
 * Shortens long paths for terminal display
 */
export function formatProjectPath(cwd: string, maxLength: number = 30): string {
  if (cwd.length <= maxLength) {
    return cwd;
  }
  
  // Try to shorten by using ~ for home directory
  const home = process.env.HOME || '';
  if (home && cwd.startsWith(home)) {
    const shortened = '~' + cwd.slice(home.length);
    if (shortened.length <= maxLength) {
      return shortened;
    }
    // Still too long, truncate from the left
    return '…' + shortened.slice(-(maxLength - 1));
  }
  
  // Truncate from the left
  return '…' + cwd.slice(-(maxLength - 1));
}
