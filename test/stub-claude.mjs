#!/usr/bin/env node
// A fake `claude` CLI for tests. Behaves like `claude -p --output-format stream-json`,
// following a scripted scenario so we can simulate internet drops, usage limits and crashes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = process.env.STUB_DIR;
const CFGDIR = process.env.CLAUDE_CONFIG_DIR;
const OFFLINE = process.env.RELAY_TEST_OFFLINE_FILE;
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const model = val('--model') || '';
const isProbe = args.includes('--no-session-persistence');
const role = isProbe ? 'probe' : model.includes('opus') ? 'opus' : 'sonnet';
const resumeId = val('--resume');
const createId = val('--session-id');
const sid = resumeId || createId;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const offlineNow = () => {
  try {
    const v = fs.readFileSync(OFFLINE, 'utf8').trim();
    if (v === 'down') return true;
    const m = v.match(/^down-until:(\d+)$/);
    return !!(m && Date.now() < Number(m[1]));
  } catch { return false; }
};
const transcript = (id) => path.join(CFGDIR, 'projects', 'p', `${id}.jsonl`);
const record = (id, input) => {
  fs.mkdirSync(path.dirname(transcript(id)), { recursive: true });
  fs.appendFileSync(transcript(id), JSON.stringify({ type: 'user', message: { role: 'user', content: input } }) + '\n');
};
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', main);

function main() {
  fs.appendFileSync(path.join(DIR, 'calls.jsonl'), JSON.stringify({ role, args, input, t: Date.now() }) + '\n');

  if (isProbe) {
    if (offlineNow()) { process.stderr.write('API Error: Connection error (fetch failed)\n'); process.exit(1); }
    const lim = readJson(path.join(DIR, 'limit.json'), { n: 0 });
    if (lim.n > 0) {
      lim.n--; fs.writeFileSync(path.join(DIR, 'limit.json'), JSON.stringify(lim));
      out({ type: 'result', subtype: 'success', is_error: true, result: lim.text || 'Claude AI usage limit reached. Please try again later.', session_id: 'x' });
      process.exit(1);
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'probe' });
    process.exit(0);
  }

  // session semantics, same messages as the real CLI
  if (createId && fs.existsSync(transcript(createId))) {
    process.stderr.write(`Error: Session ID ${createId} is already in use.\n`); process.exit(1);
  }
  if (resumeId && !fs.existsSync(transcript(resumeId))) {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resumeId, result: '' });
    process.exit(1);
  }

  if (offlineNow()) { process.stderr.write('API Error: Connection error (fetch failed)\n'); process.exit(1); }

  // next scripted step for this role
  const scen = readJson(path.join(DIR, 'scenario.json'), {});
  const idxFile = path.join(DIR, `idx-${role}.json`);
  const idx = readJson(idxFile, { i: 0 });
  const step = (scen[role] || [])[idx.i];
  idx.i++; fs.writeFileSync(idxFile, JSON.stringify(idx));
  if (!step) { process.stderr.write(`stub: no scripted step ${idx.i - 1} for ${role}\n`); process.exit(3); }

  if (step.fail === 'network') {
    if (step.record) record(sid, input);
    if (step.offlineSeconds) fs.writeFileSync(OFFLINE, `down-until:${Date.now() + step.offlineSeconds * 1000}`);
    process.stderr.write('API Error: Connection error (fetch failed)\n');
    process.exit(1);
  }
  if (step.fail === 'limit') {
    if (step.record) record(sid, input);
    fs.writeFileSync(path.join(DIR, 'limit.json'), JSON.stringify({ n: step.times || 1, text: step.text }));
    out({ type: 'result', subtype: 'success', is_error: true, result: step.text || 'Claude AI usage limit reached.', session_id: sid });
    process.exit(1);
  }
  if (step.hang) {
    record(sid, input);
    setInterval(() => {}, 1000); // never finishes, like a dev server left running
    return;
  }
  if (step.killRelay) {
    record(sid, input);
    if (step.touch) fs.writeFileSync(path.join(process.cwd(), step.touch), 'half done\n');
    try { process.kill(process.ppid, 'SIGKILL'); } catch { /* ignore */ }
    if (step.linger) { setInterval(() => {}, 1000); return; } // keeps running like an orphaned claude
    process.exit(1);
  }

  record(sid, input);
  if (step.delay) { const until = Date.now() + step.delay; while (Date.now() < until) { /* simulate a slow model */ } }
  if (role === 'opus') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.2, structured_output: step.ok, result: JSON.stringify(step.ok) });
  } else {
    if (step.commitFile) {
      fs.writeFileSync(path.join(process.cwd(), step.commitFile), `${step.commitFile}\n`);
      execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
      execFileSync('git', ['commit', '-qm', `add ${step.commitFile}`], { cwd: process.cwd() });
    }
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: step.commitFile || 'x' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 3, total_cost_usd: 0.05, result: step.ok, permission_denials: step.denials || [] });
  }
  process.exit(0);
}
