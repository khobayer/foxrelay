// Everything about launching the `claude` CLI and reading its output.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN, log } from './util.mjs';
import { startSpinner, setSpinnerDetail, stopSpinner } from './ui.mjs';

// ---------- finding the executable ----------
// On Windows we avoid cmd.exe because it mangles JSON and quoted arguments.
let LAUNCH = null;
export function resolveClaude(cfg) {
  if (LAUNCH) return LAUNCH;
  if (cfg.claudePath) {
    const p = cfg.claudePath;
    LAUNCH = p.endsWith('.js') ? { cmd: process.execPath, pre: [p] } : { cmd: p, pre: [] };
    return LAUNCH;
  }
  if (!IS_WIN) { LAUNCH = { cmd: 'claude', pre: [] }; return LAUNCH; }
  let hits = [];
  try { hits = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean); } catch { /* not on PATH */ }
  const exe = hits.find((h) => h.toLowerCase().endsWith('.exe'));
  if (exe) { LAUNCH = { cmd: exe, pre: [] }; return LAUNCH; }
  const cmdShim = hits.find((h) => h.toLowerCase().endsWith('.cmd'));
  if (cmdShim) {
    const cli = path.join(path.dirname(cmdShim), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cli)) { LAUNCH = { cmd: process.execPath, pre: [cli] }; return LAUNCH; }
  }
  LAUNCH = { cmd: 'claude', pre: [], shell: true };
  return LAUNCH;
}

function quoteWin(arg) {
  if (arg === '') return '""';
  if (/^[\w\-.,:=/\\@+]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// ---------- running ----------
let CURRENT = null; // the child that is running right now, so Ctrl+C can stop it
export function currentChild() { return CURRENT; }

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// Stops a process by PID if it is still a running claude process. Returns true if it stopped one.
export function killPid(pid) {
  try {
    if (IS_WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      if (!/claude|node/i.test(out)) return false;
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    }
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    if (!/claude|stub-claude/.test(cmd)) return false; // the PID was reused by something else
    try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    return true;
  } catch { return false; } // not running
}

function toolLine(block) {
  const i = block.input || {};
  const detail = i.file_path || i.path || i.command || i.pattern || i.url || i.description || '';
  const short = String(detail).replace(/\s+/g, ' ').slice(0, 110);
  return `${block.name}${short ? '  ' + short : ''}`;
}

// Runs `claude -p` with the prompt on stdin and stream-json output.
// Never throws for model or network errors: it returns { final, stderr, code, timedOut }.
// `final` is the stream's "result" event, or null if the run died before producing one.
// The timeout counts awake time only, so a laptop that sleeps for an hour doesn't trip it.
export function runClaude({ args, prompt, cwd, label, timeoutMinutes, cfg, quiet = false, onSpawn = null, spinner = null }) {
  return new Promise((resolve, reject) => {
    const full = ['-p', '--output-format', 'stream-json', '--verbose', ...args];
    const env = { ...process.env };
    delete env.CLAUDECODE; // don't inherit session variables if run from inside a Claude Code terminal
    delete env.CLAUDE_CODE_SESSION_ID;

    const L = resolveClaude(cfg);
    const opts = { cwd, env, windowsHide: true, detached: !IS_WIN };
    const child = L.shell
      ? spawn(L.cmd, full.map(quoteWin), { ...opts, shell: true })
      : spawn(L.cmd, [...L.pre, ...full], opts);
    CURRENT = child;
    if (onSpawn && child.pid) onSpawn(child.pid);
    if (spinner) startSpinner(spinner);

    let buf = '';
    let stderr = '';
    let final = null;
    let timedOut = false;
    let awakeMs = 0;
    let last = Date.now();
    const limitMs = timeoutMinutes * 60 * 1000;

    const ticker = setInterval(() => {
      const now = Date.now();
      awakeMs += Math.min(now - last, 15000); // a big jump means the machine was asleep; don't count it
      last = now;
      if (awakeMs > limitMs && !timedOut) {
        timedOut = true;
        log(`  [${label}] no result after ${timeoutMinutes} min of awake time, stopping it`);
        killTree(child);
      }
    }, 5000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant' && ev.message?.content && !quiet) {
          for (const b of ev.message.content) {
            if (b.type === 'tool_use' && b.name !== 'StructuredOutput') {
              log(`  [${label}] > ${toolLine(b)}`);
              if (spinner) setSpinnerDetail(toolLine(b).slice(0, 70));
            }
          }
        } else if (ev.type === 'result') {
          final = ev;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { clearInterval(ticker); if (spinner) stopSpinner(); CURRENT = null; reject(e); });
    child.on('close', (code) => {
      clearInterval(ticker);
      if (spinner) stopSpinner();
      if (CURRENT === child) CURRENT = null;
      resolve({ final, stderr, code, timedOut });
    });

    child.stdin.on('error', () => { /* child died early; handled on close */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------- reading failures ----------
export function failureText(r) {
  return [r?.final?.result || '', r?.final?.subtype || '', r?.stderr || ''].join('\n');
}
export const isNoConversation = (t) => /No conversation found/i.test(t);
export const isSessionInUse = (t) => /already in use/i.test(t);
export const looksLikeLimit = (t) => /usage limit|limit reached|limit will reset|rate.?limit|\b429\b|quota|resets? at|resets \d/i.test(t);

// Tries to read when a usage limit resets. Returns a Date or null.
export function parseResetTime(t, now = new Date()) {
  const epoch = t.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

// ---------- transcripts ----------
// Claude Code saves each session as <config>/projects/<folder>/<session-id>.jsonl.
// We read it to know for sure whether an interrupted message actually reached the model.
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function findTranscript(sessionId) {
  const root = path.join(configDir(), 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return { known: false, file: null }; }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return { known: true, file: f };
  }
  return { known: true, file: null };
}

// Returns true / false, or null when we can't tell (transcript layout unknown).
export function transcriptHasUserMessage(sessionId, marker) {
  const t = findTranscript(sessionId);
  if (!t.known) return null;
  if (!t.file) return false;
  let text;
  try { text = fs.readFileSync(t.file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes(marker)) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'user') return true; // "queue-operation" lines don't count: those were never processed
    } catch { /* partial line */ }
  }
  return false;
}

export function sessionExists(sessionId) {
  const t = findTranscript(sessionId);
  if (!t.known) return null;
  return !!t.file;
}
