// Scenario tests for the relay using the fake claude CLI. Run: node test/run-tests.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'relay.mjs');
const STUB = path.join(HERE, 'stub-claude.mjs');
const CONFIG = path.join(HERE, 'test.config.json');

function setup(name, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`));
  const project = path.join(root, 'project');
  const stubDir = path.join(root, 'stub');
  const bin = path.join(root, 'bin');
  for (const d of [project, stubDir, bin, path.join(root, 'cfg')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${STUB}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, 'scenario.json'), JSON.stringify(scenario));
  const g = (...a) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(project, '.gitignore'), '.relay/\n');
  fs.writeFileSync(path.join(project, 'README.md'), 'demo\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_DIR: stubDir,
    CLAUDE_CONFIG_DIR: path.join(root, 'cfg'),
    RELAY_TEST_OFFLINE_FILE: path.join(stubDir, 'offline'),
  };
  delete env.HTTPS_PROXY; delete env.https_proxy;
  return { root, project, stubDir, env };
}

function relay(ctx, extraArgs, timeoutMs = 60000, config = CONFIG) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [RELAY, '--config', config, ...extraArgs], { cwd: ctx.project, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out }); });
  });
}

const calls = (ctx, role) => fs.readFileSync(path.join(ctx.stubDir, 'calls.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).filter((c) => !role || c.role === role);
const argOf = (c, k) => { const i = c.args.indexOf(k); return i >= 0 ? c.args[i + 1] : null; };
const runDirOf = (ctx) => { const d = path.join(ctx.project, '.relay'); return path.join(d, fs.readdirSync(d)[0]); };
const state = (ctx) => JSON.parse(fs.readFileSync(path.join(runDirOf(ctx), 'state.json'), 'utf8'));

const M = (s1, s2 = 'todo') => [{ id: 'M1', title: 'Setup', status: s1 }, { id: 'M2', title: 'Feature', status: s2 }];
const P = (cur, status = 'CONTINUE', extra = {}) => ({
  review: 'looks fine', status, progress: 'advanced', plan: M(cur === 'M1' ? 'doing' : 'done', cur === 'M2' ? 'doing' : status === 'DONE' ? 'done' : 'todo'),
  current_milestone: cur, role: 'backend', prompt: status === 'CONTINUE' ? `Build step for ${cur}` : '', new_decisions: [], new_questions: [],
  summary_for_human: status === 'CONTINUE' ? '' : 'Summary for you', ...extra,
});
const W = (file) => ({ ok: `## Report\n- Done: added ${file}`, commitFile: file });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------
test('happy path: milestones, fresh sessions per milestone, summary, checkpoints', async () => {
  const ctx = setup('happy', {
    opus: [{ ok: P('M1') }, { ok: P('M2', 'CONTINUE', { new_decisions: ['(round 1) Used Express because it is already installed'] }) }, { ok: P('M2', 'DONE') }],
    sonnet: [W('a.txt'), W('b.txt')],
  });
  const r = await relay(ctx, ['--goal', 'Build it']);
  assert.equal(r.code, 0, r.out);
  const o = calls(ctx, 'opus');
  const s = calls(ctx, 'sonnet');
  assert.equal(o.length, 3);
  assert.equal(s.length, 2);
  assert.ok(o[0].input.includes('[relay-msg 1]') && o[0].input.includes('Build it'));
  assert.equal(argOf(o[0], '--effort'), 'high');
  assert.equal(argOf(o[1], '--effort'), 'medium', 'routine review uses lower effort');
  // milestone changed M1 -> M2 after the 2nd planner reply: engineer gets a fresh session, planner too on its next call
  assert.notEqual(argOf(s[0], '--session-id'), argOf(s[1], '--session-id'), 'fresh engineer session for new milestone');
  assert.ok(argOf(o[2], '--session-id'), 'planner started a fresh session');
  assert.ok(o[2].input.includes('[Context]') && o[2].input.includes('PLAN.md'), 'fresh planner gets the context pack');
  const dir = runDirOf(ctx);
  const sum = fs.readFileSync(path.join(dir, 'SUMMARY.md'), 'utf8');
  assert.ok(sum.includes('Goal finished') && sum.includes('add b.txt') && sum.includes('Used Express'));
  assert.ok(sum.includes('\n\n## Milestones\n\n'), 'summary keeps blank lines');
  assert.equal(state(ctx).checkpoints.length, 2);
  assert.ok(fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8').includes('(round 1) Used Express'));
  assert.ok(!fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8').includes('(round 1) (round 1)'), 'no double prefix');
});

test('internet drops before Sonnet got the task: resend the full task, fresh session', async () => {
  const ctx = setup('net1', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ fail: 'network', record: false, offlineSeconds: 3 }, W('a.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('Internet is down'), 'announced the pause');
  assert.ok(r.out.includes('Connection is back'), 'announced the resume');
  const s = calls(ctx, 'sonnet');
  assert.equal(s.length, 2);
  assert.ok(s[1].input.startsWith('[relay-task 1]'), 'full task, because it never reached the model');
  assert.ok(argOf(s[1], '--session-id'), 'session never existed, so create it');
});

test('internet drops while Sonnet was working: continue, never resend the task', async () => {
  const ctx = setup('net2', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ fail: 'network', record: true, offlineSeconds: 3 }, W('a.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  const s = calls(ctx, 'sonnet');
  assert.equal(s.length, 2);
  assert.ok(s[1].input.startsWith('[relay-continue]'), 'continue message');
  assert.ok(!s[1].input.includes('Build step for M1'), 'the task text was NOT sent again');
  assert.equal(argOf(s[1], '--resume'), argOf(s[0], '--session-id'), 'same session resumed');
});

test('internet drops while Opus was answering: short retry, no duplicate report', async () => {
  const ctx = setup('net3', {
    opus: [{ ok: P('M1') }, { fail: 'network', record: true, offlineSeconds: 2 }, { ok: P('M1', 'DONE') }],
    sonnet: [W('a.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  const o = calls(ctx, 'opus');
  assert.equal(o.length, 3);
  assert.ok(o[2].input.includes('retry') && !o[2].input.includes('ENGINEER REPORT'), 'short retry only');
});

test('usage limit: waits and continues by itself', async () => {
  const ctx = setup('limit', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ fail: 'limit', times: 2, record: true }, W('a.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('Usage limit reached'), r.out);
  const probes = calls(ctx, 'probe');
  assert.ok(probes.length >= 3, 'probed until the limit cleared');
  assert.ok(calls(ctx, 'sonnet')[1].input.startsWith('[relay-continue]'));
});

test('relay killed mid-task (crash / closed terminal): --resume-run continues the task', async () => {
  const ctx = setup('crash', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ killRelay: true, touch: 'half.txt' }, W('a.txt')],
  });
  const r1 = await relay(ctx, ['--goal', 'x']);
  assert.equal(r1.signal, 'SIGKILL', 'relay was killed');
  const st = state(ctx);
  assert.equal(st.phase, 'work');
  assert.equal(st.pendingWork.attempted, true);
  const r2 = await relay(ctx, ['--resume-run', runDirOf(ctx)]);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(r2.out.includes('will continue (not restart)'));
  const s = calls(ctx, 'sonnet');
  assert.equal(s.length, 2);
  assert.ok(s[1].input.startsWith('[relay-continue]') && !s[1].input.includes('Build step for M1'));
  assert.equal(argOf(s[1], '--resume'), argOf(s[0], '--session-id'));
  assert.equal(calls(ctx, 'opus').length, 2, 'planner was not asked twice for the same step');
});

test('hard crash leaves Claude running: resume stops the leftover first', async () => {
  const ctx = setup('orphan', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ killRelay: true, linger: true }, W('a.txt')],
  });
  const r1 = await relay(ctx, ['--goal', 'x']);
  assert.equal(r1.signal, 'SIGKILL');
  const alive = () => execFileSync('sh', ['-c', `ps -eo args | grep "[s]tub-claude.mjs" | grep -c "${ctx.root.split('/').pop()}" || true`], { encoding: 'utf8' }).trim();
  const pid = state(ctx).childPid;
  assert.ok(pid, 'child pid was saved');
  assert.ok(execFileSync('sh', ['-c', `ps -p ${pid} -o args= || true`], { encoding: 'utf8' }).includes('stub-claude'), 'orphan is running');
  const r2 = await relay(ctx, ['--resume-run', runDirOf(ctx)]);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(r2.out.includes('Stopped a leftover Claude process'), r2.out);
  const after = execFileSync('sh', ['-c', `ps -p ${pid} -o args= || true`], { encoding: 'utf8' }).trim();
  assert.ok(after === '' || after.includes('<defunct>'), `orphan is gone (got: ${after})`);
  void alive;
});

test('parked questions: keeps working, lists them in the summary', async () => {
  const ctx = setup('park', {
    opus: [
      { ok: P('M1', 'CONTINUE', { new_questions: [{ question: 'Which SMS provider should we pay for?', milestone: 'M2', default_taken: 'Using a stub sender' }] }) },
      { ok: P('M1', 'DONE') },
    ],
    sonnet: [W('a.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('Parked 1 question'));
  const sum = fs.readFileSync(path.join(runDirOf(ctx), 'SUMMARY.md'), 'utf8');
  assert.ok(sum.includes('Which SMS provider') && sum.includes('Using a stub sender'));
});

test('stuck detection: warns, asks to park, then stops', async () => {
  const stuck = { ...P('M1'), progress: 'no_progress' };
  const ctx = setup('stuck', {
    opus: Array.from({ length: 8 }, () => ({ ok: stuck })),
    sonnet: Array.from({ length: 8 }, (_, i) => ({ ok: `## Report\n- still failing ${i}` })),
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 2, `exits with "needs you" when not interactive\n${r.out}`);
  const o = calls(ctx, 'opus');
  assert.ok(o.some((c) => c.input.includes('STUCK WARNING')), 'warned');
  assert.ok(o.some((c) => c.input.includes('Park it now')), 'asked to park');
  assert.ok(r.out.includes('made no progress'));
  assert.equal(state(ctx).phase, 'blocked');
});

test('round limit: planner is told it is the last round, run ends cleanly', async () => {
  const ctx = setup('limitrounds', {
    opus: [{ ok: P('M1') }, { ok: P('M1') }, { ok: P('M1', 'CONTINUE') }],
    sonnet: [W('a.txt'), W('b.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x', '--rounds', '2']);
  assert.equal(r.code, 0, r.out);
  const o = calls(ctx, 'opus');
  assert.ok(o[2].input.includes('LIMIT:'));
  assert.ok(fs.readFileSync(path.join(runDirOf(ctx), 'SUMMARY.md'), 'utf8').includes('round limit'));
  assert.equal(calls(ctx, 'sonnet').length, 2, 'no work after the limit');
});

test('a run stopped at the round limit continues with a higher --rounds', async () => {
  const ctx = setup('extend', {
    opus: [{ ok: P('M1') }, { ok: P('M1') }, { ok: P('M1', 'CONTINUE') }, { ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [W('a.txt'), W('b.txt'), W('c.txt')],
  });
  const r1 = await relay(ctx, ['--goal', 'x', '--rounds', '2']);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(state(ctx).phase, 'done');
  const r2 = await relay(ctx, ['--resume-run', runDirOf(ctx)]);
  assert.ok(r2.out.includes('--rounds 22'), 'tells you how to raise the limit');
  const r3 = await relay(ctx, ['--resume-run', runDirOf(ctx), '--rounds', '10']);
  assert.equal(r3.code, 0, r3.out);
  assert.ok(r3.out.includes('limit raised to 10'));
  assert.equal(calls(ctx, 'sonnet').length, 3, 'did more work after raising the limit');
  assert.ok(fs.readFileSync(path.join(runDirOf(ctx), 'SUMMARY.md'), 'utf8').includes('Goal finished'));
});

test('rollback: resets git to before round N and queues the planner', async () => {
  const ctx = setup('rollback', {
    opus: [{ ok: P('M1') }, { ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [W('a.txt'), W('b.txt')],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  const before = state(ctx).checkpoints.find((c) => c.round === 2).head;
  const rb = await relay(ctx, ['--rollback', runDirOf(ctx), '--to-round', '2', '--yes']);
  assert.equal(rb.code, 0, rb.out);
  const headNow = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.project, encoding: 'utf8' }).trim();
  assert.equal(headNow, before);
  assert.ok(!fs.existsSync(path.join(ctx.project, 'b.txt')) && fs.existsSync(path.join(ctx.project, 'a.txt')));
  const st = state(ctx);
  assert.equal(st.round, 1);
  assert.equal(st.phase, 'plan');
  assert.ok(st.pending.body.includes('rolled the project back'));
});

test('denied tools are written to the engineer settings', async () => {
  const ctx = setup('deny', { opus: [{ ok: P('M1', 'DONE') }], sonnet: [] });
  const cfg = path.join(ctx.root, 'deny.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), rulesFile: path.join(HERE, '..', 'rules.md'), workerAllowedTools: ['Bash(npm *)'], workerDeniedTools: ['Bash(git push*)', 'Read(./.env)'], workerDisableHooks: true }));
  const r = await relay(ctx, ['--goal', 'x'], 60000, cfg);
  assert.equal(r.code, 0, r.out);
  const st = JSON.parse(fs.readFileSync(path.join(runDirOf(ctx), '_worker-settings.json'), 'utf8'));
  assert.deepEqual(st.permissions.deny, ['Bash(git push*)', 'Read(./.env)']);
  assert.deepEqual(st.permissions.allow, ['Bash(npm *)']);
  assert.equal(st.disableAllHooks, true, 'hooks switched off for the engineer');
});

test('--message-file: stops the pending task and sends the message to the planner first', async () => {
  const ctx = setup('msg', {
    opus: [{ ok: P('M1') }, { ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ killRelay: true }, W('a.txt')],
  });
  const r1 = await relay(ctx, ['--goal', 'x']);
  assert.equal(r1.signal, 'SIGKILL');
  const msg = path.join(ctx.root, 'fix.md');
  fs.writeFileSync(msg, 'Q4 answer: use port 20333.\nQ5 answer: no.\nQ6 answer: yes, keep it.');
  const r2 = await relay(ctx, ['--resume-run', runDirOf(ctx), '--message-file', msg]);
  assert.equal(r2.code, 0, r2.out);
  const o = calls(ctx, 'opus');
  assert.ok(o[1].input.includes('HUMAN MESSAGE') && o[1].input.includes('Q5 answer: no.') && o[1].input.includes('Q6 answer'), 'whole multi-line message reached the planner');
  assert.ok(o[1].input.includes('stopped part way'), 'planner told the task was interrupted');
  const s = calls(ctx, 'sonnet');
  assert.ok(s[1].input.startsWith('[relay-task 2]'), 'engineer got the NEW prompt, not a continue of the old one');
});

test('old questions are not asked again: message file and planner both close them', async () => {
  const ctx = setup('closeq', {
    opus: [
      { ok: P('M1', 'CONTINUE', { new_questions: [{ question: 'Old one A?' }, { question: 'Old one B?' }, { question: 'Old one C?' }] }) },
      { ok: P('M1', 'CONTINUE', { closed_questions: [3] }) },
      { ok: P('M1', 'DONE') },
    ],
    sonnet: [W('a.txt'), { killRelay: true }, W('b.txt')],
  });
  const r1 = await relay(ctx, ['--goal', 'x']);
  assert.equal(r1.signal, 'SIGKILL');
  let st = state(ctx);
  assert.equal(st.questions.find((q) => q.id === 3).status, 'closed', 'planner closed Q3');
  const msg = path.join(ctx.root, 'answers.md');
  fs.writeFileSync(msg, 'Q1: yes. Q2: no.');
  const r2 = await relay(ctx, ['--resume-run', runDirOf(ctx), '--message-file', msg]);
  assert.equal(r2.code, 0, r2.out);
  st = state(ctx);
  assert.equal(st.questions.filter((q) => q.status === 'open').length, 0, 'no open questions left');
  assert.ok(fs.readFileSync(path.join(runDirOf(ctx), 'SUMMARY.md'), 'utf8').includes('Open questions (0)'));
});

test('relay init + plain "relay": config and goal come from docs/relay', async () => {
  const ctx = setup('init', { opus: [{ ok: P('M1', 'DONE') }], sonnet: [] });
  const r0 = await new Promise((resolve) => {
    const c = spawn(process.execPath, [RELAY, 'init'], { cwd: ctx.project, env: ctx.env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(r0.code, 0, r0.out);
  for (const f of ['relay.config.json', 'rules.md', 'goal.md']) assert.ok(fs.existsSync(path.join(ctx.project, 'docs', 'relay', f)), f);
  assert.ok(fs.readFileSync(path.join(ctx.project, '.gitignore'), 'utf8').match(/^\.relay\/$/m));
  // placeholders are refused
  const cfgPath = path.join(ctx.project, 'docs', 'relay', 'relay.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), rulesFile: 'rules.md' }));
  const bare = (extra = []) => new Promise((resolve) => {
    const c = spawn(process.execPath, [RELAY, ...extra], { cwd: ctx.project, env: ctx.env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  const r1 = await bare();
  assert.equal(r1.code, 1);
  assert.ok(r1.out.includes('placeholders'), r1.out);
  fs.writeFileSync(path.join(ctx.project, 'docs', 'relay', 'goal.md'), 'Build the thing.\nDone means: tests pass.');
  const r2 = await bare();
  assert.equal(r2.code, 0, r2.out);
  assert.ok(r2.out.includes(path.join('docs', 'relay', 'goal.md')) && r2.out.includes(path.join('docs', 'relay', 'relay.config.json')), r2.out);
  assert.ok(calls(ctx, 'opus')[0].input.includes('Build the thing.'));
});

test('status and resume find the latest run; a running run cannot be started twice', async () => {
  const ctx = setup('status', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ hang: true }, W('a.txt')],
  });
  const cfg = path.join(ctx.root, 'long.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), rulesFile: path.join(HERE, '..', 'rules.md'), timeoutMinutes: 5 }));
  const run = spawn(process.execPath, [RELAY, '--config', cfg, '--goal', 'x'], { cwd: ctx.project, env: ctx.env, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(fs.existsSync(path.join(ctx.stubDir, 'calls.jsonl')) && calls(ctx, 'sonnet').length); i++) await new Promise((r) => setTimeout(r, 200));
  const cmd = (a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [RELAY, ...a], { cwd: ctx.project, env: ctx.env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  const s1 = await cmd(['status']);
  assert.ok(s1.out.includes('RUNNING') && s1.out.includes('engineer is working on M1'), s1.out);
  const dup = await cmd(['resume']);
  assert.equal(dup.code, 1);
  assert.ok(dup.out.includes('already running'), dup.out);
  run.kill('SIGKILL');
  execFileSync('sh', ['-c', 'pkill -f "^node [^ ]*stub-claude.mjs" || true']);
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await cmd(['status']);
  assert.ok(s2.out.includes('NOT RUNNING') && s2.out.includes('Continue with'), s2.out);
  const r = await cmd(['resume', '--config', cfg]);
  assert.equal(r.code, 0, r.out);
  assert.ok(calls(ctx, 'sonnet')[1].input.startsWith('[relay-continue]'), 'resumed the hung task');
  const s3 = await cmd(['status']);
  assert.ok(s3.out.includes('State    : finished') && s3.out.includes('Progress ['), s3.out);
});

test('permission denials are passed to the planner', async () => {
  const ctx = setup('denials', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ ok: '## Report', denials: [{ tool_name: 'Bash', tool_input: { command: 'docker compose up' } }] }],
  });
  const r = await relay(ctx, ['--goal', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.ok(calls(ctx, 'opus')[1].input.includes('docker compose up'));
});

test('hung command: stopped after the timeout, planner is told, run goes on', async () => {
  const ctx = setup('hang', {
    opus: [{ ok: P('M1') }, { ok: P('M1', 'DONE') }],
    sonnet: [{ hang: true }],
  });
  const cfg = path.join(ctx.root, 'hang.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), rulesFile: path.join(HERE, '..', 'rules.md'), timeoutMinutes: 0.1 }));
  const r = await relay(ctx, ['--goal', 'x'], 60000, cfg);
  assert.equal(r.code, 0, r.out);
  assert.ok(calls(ctx, 'opus')[1].input.includes('TIMED OUT'));
  const leftovers = execFileSync('sh', ['-c', 'ps -eo args | grep -E "^node [^ ]*[s]tub-claude.mjs" || true'], { encoding: 'utf8' }).trim();
  assert.equal(leftovers, '', 'the hung process was killed');
});

test('interactive: "needs you" asks the question, answer goes to the planner', async () => {
  const ctx = setup('tty', {
    opus: [
      { ok: { ...P('M1', 'BLOCKED'), new_questions: [{ question: 'Postgres or MySQL?', milestone: 'M1' }] } },
      { ok: P('M1') },
      { ok: P('M1', 'DONE') },
    ],
    sonnet: [W('a.txt')],
  });
  // run inside a pseudo-terminal and type the answers
  const py = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
out = b''
answers = [(b'your answer >', b'Postgres\\rwith pgvector\\r'), (b'Anything else', b'\\r'), (b'Press Enter to finish', b'\\r')]
deadline = time.time() + 40
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        out += chunk
        if answers and answers[0][0] in out:
            os.write(fd, answers[0][1]); out = out.replace(answers[0][0], b'<answered>', 1); answers.pop(0)
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf8', 'replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const r = await new Promise((resolve) => {
    const c = spawn('python3', ['-c', py, process.execPath, RELAY, '--config', CONFIG, '--goal', 'x'], { cwd: ctx.project, env: ctx.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 0, r.out);
  const o = calls(ctx, 'opus');
  assert.ok(o[1].input.includes('HUMAN ANSWERS') && o[1].input.includes('Postgres'), 'answer reached the planner');
  assert.ok(o[1].input.includes('Postgres\nwith pgvector'), 'a two-line paste stayed one answer');
  assert.ok(fs.readFileSync(path.join(runDirOf(ctx), 'QUESTIONS.md'), 'utf8').includes('Answer: Postgres'));
});

// ------------------------------------------------------------------
let pass = 0;
let fail = 0;
for (const t of tests) {
  const t0 = Date.now();
  try {
    await t.fn();
    pass++;
    console.log(`PASS  ${t.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${t.name}\n      ${String(e.message).split('\n').slice(0, 30).join('\n      ')}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
