import fs from 'node:fs';
import { beforeLog, afterLog, paint } from './ui.mjs';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function clock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function truncateMiddle(text, max) {
  if (!text || text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - max} characters cut here to save tokens; the full text is in the file named below ...]\n\n${text.slice(-half)}`;
}

// Simple logger that prints and keeps a log file, so a person who stepped away can read what happened.
let LOG_FILE = null;
export function setLogFile(p) { LOG_FILE = p; }
export function log(...parts) {
  const line = parts.join(' ');
  beforeLog();
  console.log(paint(line));
  afterLog();
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* logging must never break the run */ }
  }
}

export function hr(title) {
  const line = '-'.repeat(Math.max(4, 64 - title.length));
  log(`\n-- ${title} ${line}`);
}

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Atomic write: write to a temp file, then rename, so a crash never leaves a half-written state file.
export function writeFileAtomic(p, content) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
