import { execFileSync } from 'node:child_process';

export function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 }).trim();
  } catch { return null; }
}

export const isRepo = (cwd) => git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
export const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);
export const isDirty = (cwd) => !!git(cwd, ['status', '--porcelain']);

// Short snapshot for the planner: status, what changed since `since`, last commits.
export function snapshot(cwd, since) {
  if (!isRepo(cwd)) return '(not a git repository)';
  const status = git(cwd, ['status', '--short']) || '(clean)';
  const range = since ? [since] : ['HEAD'];
  const stat = git(cwd, ['diff', ...range, '--stat']) || '(no changes)';
  const log = git(cwd, ['log', '--oneline', '-8']) || '(no commits)';
  return `git status --short:\n${status}\n\nchanged since the start of this round (git diff --stat):\n${stat}\n\nlast commits:\n${log}`;
}

export function commitsSince(cwd, base) {
  if (!base || !isRepo(cwd)) return '';
  return git(cwd, ['log', '--oneline', `${base}..HEAD`]) || '';
}

export function diffStatSince(cwd, base) {
  if (!base || !isRepo(cwd)) return '';
  return git(cwd, ['diff', base, '--stat']) || '';
}
