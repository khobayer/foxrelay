#!/usr/bin/env node
// foxrelay v2
// Opus plans and checks, Claude Code (Sonnet) builds, in a loop, unattended.
// Survives internet drops, usage limits, laptop sleep and crashes (resume with --resume-run).
// Zero dependencies. Needs Node 18+ and the `claude` CLI logged in.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { log, hr, setLogFile, stamp, fmtDuration, truncateMiddle, readJson, writeFileAtomic, sleep } from './lib/util.mjs';
import {
  runClaude, killTree, killPid, currentChild, failureText, isNoConversation, isSessionInUse,
  transcriptHasUserMessage, sessionExists,
} from './lib/claude.mjs';
import { waitUntilAvailable } from './lib/net.mjs';
import { notify, startBuzzer, setNotifyDebug } from './lib/notify.mjs';
import { progressLine, setTitle, stopSpinner } from './lib/ui.mjs';
import * as G from './lib/git.mjs';
import { PLANNER_SCHEMA, PLANNER_SYSTEM, WORKER_SYSTEM } from './lib/prompts.mjs';

export const VERSION = '2.2.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- config
const DEFAULTS = {
  plannerModel: 'claude-opus-5-5',
  workerModel: 'claude-sonnet-5-5',
  plannerEffort: 'high',
  plannerReviewEffort: 'medium',
  workerEffort: null,
  plannerTools: 'Read,Glob,Grep',
  workerPermissionMode: 'acceptEdits',
  workerAllowedTools: ["Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)", "Bash(yarn *)", "Bash(node *)", "Bash(nx *)", "Bash(ls *)", "Bash(grep *)", "Bash(find *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(sort *)", "Bash(sed -n *)", "Bash(timeout *)", "Bash(which *)", "Bash(cd *)", "Bash(pwd*)", "Bash(echo *)", "Bash(mkdir *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git add *)", "Bash(git commit *)"],
  // Safe by default: used even when a project config leaves the key out.
  workerDeniedTools: ["Bash(git push*)", "Bash(git tag*)", "Bash(git reset --hard*)", "Bash(git clean*)", "Bash(ssh *)", "Bash(scp *)", "Bash(rm -rf*)", "Bash(npx prisma migrate reset*)", "Bash(npx prisma db push*)", "Bash(docker compose down*)", "Bash(cat .env*)", "Read(./.env)", "Read(./.env.local)", "Read(./.env.production*)"],
  workerDisableHooks: false,
  workerKeepSession: true,
  freshSessionPerMilestone: true,
  plannerMaxCallsPerSession: 20,
  maxRounds: 100,
  maxHours: null,
  workerMaxTurns: null,
  timeoutMinutes: 60,
  maxReportChars: 15000,
  stuck: { warnAfter: 3, parkAfter: 5, blockAfter: 7 },
  rulesFile: 'rules.md',
  hideAttribution: true,
  claudePath: null,
  recovery: {
    connectivityUrl: 'https://api.anthropic.com',
    netPollSeconds: 15,
    limitPollMinutes: 10,
    otherErrorPollSeconds: 60,
    probeTimeoutSeconds: 120,
    maxWaitHours: 12,
  },
  notify: { sound: true, soundRepeat: 2, doneSoundFile: null, alertSoundFile: null, desktop: true, buzzUntilAck: true, buzzIntervalSeconds: 60, buzzMaxMinutes: 30, ntfyUrl: null },
  roles: {},
};

function loadConfig(file) {
  const p = file ? path.resolve(file) : path.join(HERE, 'relay.config.json');
  let user = {};
  if (fs.existsSync(p)) user = readJson(p);
  else if (file) throw new Error(`Config not found: ${p}`);
  const cfg = { ...DEFAULTS, ...user };
  for (const k of ['recovery', 'notify', 'stuck']) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  cfg.roles = user.roles || {};
  cfg._path = p;
  cfg._dir = path.dirname(p);
  return cfg;
}

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { cmd: 'start', project: process.cwd(), goal: null, goalFile: null, rounds: null, hours: null, confirm: false, config: null, resumeRun: null, resumeLast: false, messageFile: null, rollback: null, toRound: null, yes: false, testNotify: false, runArg: null };
  argv = [...argv];
  // Subcommands: relay init | relay status [run] | relay resume [run] | relay start
  if (['init', 'status', 'resume', 'start'].includes(argv[0])) {
    a.cmd = argv.shift();
    if ((a.cmd === 'status' || a.cmd === 'resume') && argv[0] && !argv[0].startsWith('-')) a.runArg = argv.shift();
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--project' || k === '-p') a.project = next();
    else if (k === '--goal' || k === '-g') a.goal = next();
    else if (k === '--goal-file' || k === '-f') a.goalFile = next();
    else if (k === '--rounds' || k === '-r') a.rounds = Number(next());
    else if (k === '--hours') a.hours = Number(next());
    else if (k === '--confirm') a.confirm = true;
    else if (k === '--auto') a.confirm = false; // v1 flag, auto is now the default
    else if (k === '--config' || k === '-c') a.config = next();
    else if (k === '--resume-run') a.resumeRun = next();
    else if (k === '--resume-last') a.resumeLast = true;
    else if (k === '--status') a.cmd = 'status';
    else if (k === '--message-file' || k === '-m') a.messageFile = next();
    else if (k === '--rollback') a.rollback = next();
    else if (k === '--to-round') a.toRound = Number(next());
    else if (k === '--yes' || k === '-y') a.yes = true;
    else if (k === '--test-notify') a.testNotify = true;
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
    else if (k === '--version' || k === '-v') { console.log(`foxrelay ${VERSION}`); process.exit(0); }
    else { console.error(`Unknown option: ${k}`); printHelp(); process.exit(1); }
  }
  return a;
}

function printHelp() {
  console.log(`
foxrelay ${VERSION}  (Opus plans and checks, Sonnet builds, unattended)

First time in a project:
  relay init                      creates docs/relay/ (config, rules, goal) and ignores .relay/
                                  then write your goal in docs/relay/goal.md

Run it (from the project folder):
  relay                           uses docs/relay/goal.md and docs/relay/relay.config.json
  relay --goal-file PRD.md        or give the goal yourself
  relay --goal "what to build"

Watch it (from any terminal, even while it runs):
  relay status                    progress of the latest run in this project

Continue (after a crash, Ctrl+C, a closed terminal, "needs you" or the round limit):
  relay resume                    the latest run in this project
  relay resume --rounds 40        with a higher round limit
  relay resume -m message.md      send the planner a message first (answers, corrections)

Undo:
  relay --rollback <run-folder> --to-round <n>

Options:
  -p, --project <dir>     Project folder (default: current folder)
  -g, --goal <text>       Goal text
  -f, --goal-file <file>  Goal from a file (PRD, spec, task list)
  -r, --rounds <n>        Max engineer rounds (default 100)
      --hours <n>         Stop after this many hours of work
      --confirm           Ask before every engineer run (default: fully automatic)
  -c, --config <file>     Config file (default: docs/relay/relay.config.json, else the one next to relay.mjs)
  -m, --message-file <f>  With resume: a message for the planner, any length
      --resume-run <dir>  Resume a specific run folder
      --test-notify       Play the sounds and show a notification, to check they work
  -v, --version
`);
}

// ---------------------------------------------------------------- run state
let S = null;   // run state, saved to state.json after every step
let CFG = null;

const runPath = (name) => path.join(S.runDir, name);
function save() {
  S.heartbeat = Date.now();
  S.relayPid = process.pid;
  writeFileAtomic(runPath('state.json'), JSON.stringify(S, null, 2));
}

// Saves every 30s even while Claude is busy, so "relay status" can tell a live run from a dead one.
function startHeartbeat() {
  setInterval(() => { try { save(); } catch { /* ignore */ } }, 30 * 1000).unref();
}

function showProgress() {
  const p = progressLine({ plan: S.planList, round: S.round, maxRounds: S.maxRounds, elapsed: fmtDuration(S.elapsedMs), current: S.lastPlan?.current_milestone });
  log(p.text);
  setTitle(`relay ${p.total ? `${p.pct}%` : 'planning'}${S.lastPlan?.current_milestone ? ` ${S.lastPlan.current_milestone}` : ''} - ${path.basename(S.project)}`);
}
const pad = (n) => String(n).padStart(3, '0');

function writeSystemFiles() {
  const rulesPath = path.resolve(CFG._dir, CFG.rulesFile);
  const rules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8').trim() : '';
  const rulesBlock = rules ? `\n\n# Project rules (apply to all work)\n\n${rules}` : '';
  fs.writeFileSync(runPath('_planner-system.md'), PLANNER_SYSTEM + rulesBlock);
  fs.writeFileSync(runPath('_worker-system.md'), WORKER_SYSTEM + rulesBlock);
  for (const [role, rc] of Object.entries(CFG.roles)) {
    let extra = '';
    if (rc.systemPromptFile) {
      const f = path.resolve(CFG._dir, rc.systemPromptFile);
      if (fs.existsSync(f)) extra = `\n\n# Your role for this task: ${role}\n\n${fs.readFileSync(f, 'utf8').trim()}`;
    }
    fs.writeFileSync(runPath(`_worker-system-${role}.md`), WORKER_SYSTEM + extra + rulesBlock);
  }
  // deny wins over allow in Claude Code, so workerDeniedTools is a hard block even for commands an allow rule would match
  const settings = { permissions: { allow: CFG.workerAllowedTools || [], deny: CFG.workerDeniedTools || [] } };
  if (CFG.hideAttribution) settings.attribution = { commit: '', pr: '' };
  // Hooks from your own Claude Code setup (for example a command-rewriting hook like rtk) can change
  // commands after the relay's allow/deny rules were written for them. Turning them off keeps the rules exact.
  if (CFG.workerDisableHooks) settings.disableAllHooks = true;
  fs.writeFileSync(runPath('_worker-settings.json'), JSON.stringify(settings, null, 2));
}

function tickClock() {
  const now = Date.now();
  S.elapsedMs += Math.min(now - (S.lastTick || now), 5 * 60 * 1000);
  S.lastTick = now;
}

function header() {
  const m = S.lastPlan?.current_milestone ? `${S.lastPlan.current_milestone} · ` : '';
  return `${m}round ${S.round}/${S.maxRounds} · ${fmtDuration(S.elapsedMs)}`;
}

// ---------------------------------------------------------------- docs the humans and the planner read
function writeDocs() {
  const plan = S.planList || [];
  const planMd = [
    '# Plan', '',
    `Goal: see goal.md. Current milestone: ${S.lastPlan?.current_milestone || '-'} (${S.lastPlan?.role || '-'}). Engineer rounds: ${S.round}.`, '',
    '| Id | Status | Milestone | Note |', '|---|---|---|---|',
    ...plan.map((m) => `| ${m.id} | ${m.status} | ${String(m.title).replace(/\|/g, '/')} | ${String(m.note || '').replace(/\|/g, '/')} |`),
  ].join('\n');
  fs.writeFileSync(runPath('PLAN.md'), planMd + '\n');

  const dec = ['# Decisions the planner made on its own', '', ...S.decisions.map((d) => `- (round ${d.round}) ${d.text}`)];
  fs.writeFileSync(runPath('DECISIONS.md'), dec.join('\n') + '\n');

  const qs = ['# Questions for the human', ''];
  for (const q of S.questions) {
    qs.push(`- Q${q.id} [${q.status}]${q.milestone ? ` (${q.milestone})` : ''}: ${q.question}`);
    if (q.default_taken) qs.push(`  - Meanwhile: ${q.default_taken}`);
    if (q.answer) qs.push(`  - Answer: ${q.answer}`);
  }
  fs.writeFileSync(runPath('QUESTIONS.md'), qs.join('\n') + '\n');

  const cp = ['# Checkpoints (git HEAD before each engineer round)', '',
    `Undo back to the state before round N:  node "${SELF}" --rollback "${S.runDir}" --to-round N`, '',
    ...S.checkpoints.map((c) => `- Round ${c.round} (${c.milestone || '-'}): ${c.head || '(no git)'}${c.dirty ? '  (had uncommitted changes)' : ''}`)];
  fs.writeFileSync(runPath('CHECKPOINTS.md'), cp.join('\n') + '\n');
}

function writeSummary() {
  const plan = S.planList || [];
  const open = S.questions.filter((q) => q.status === 'open');
  const commits = G.commitsSince(S.project, S.baseHead);
  const stat = G.diffStatSince(S.project, S.baseHead);
  const goalFirst = fs.readFileSync(runPath('goal.md'), 'utf8').trim().split('\n')[0].slice(0, 200);
  const lines = [
    '# Relay summary', '',
    `- Goal: ${goalFirst} (full text in goal.md)`,
    `- Result: ${S.endReason || S.phase}`,
    `- Started: ${new Date(S.createdAt).toLocaleString()}   Finished: ${new Date().toLocaleString()}`,
    `- Work time: ${fmtDuration(S.elapsedMs)}   Engineer rounds: ${S.round}   Reported usage: $${S.totalCost.toFixed(2)} (usage on a Max plan, not a bill)`,
    '',
    '## What the planner says', '', S.lastPlan?.summary_for_human || S.lastPlan?.review || '(no summary)', '',
    '## Milestones', '', '| Id | Status | Milestone |', '|---|---|---|',
    ...plan.map((m) => `| ${m.id} | ${m.status} | ${m.title} |`), '',
    `## Open questions (${open.length})`, '',
    ...(open.length ? open.map((q) => `- Q${q.id}${q.milestone ? ` (${q.milestone})` : ''}: ${q.question}${q.default_taken ? `\n  - Meanwhile: ${q.default_taken}` : ''}`) : ['None.']), '',
    '## Decisions made on its own', '',
    ...(S.decisions.length ? S.decisions.map((d) => `- (round ${d.round}) ${d.text}`) : ['None recorded.']), '',
    '## Commits in this run', '', '```', commits || '(none)', '```', '',
    '## Files changed', '', '```', stat || '(none)', '```', '',
    '## Next steps', '',
    '- Run the app and check it yourself, then push.',
    open.length ? `- Answer the open questions and continue:  node "${SELF}" --resume-run "${S.runDir}"` : null,
    `- Undo a bad round:  node "${SELF}" --rollback "${S.runDir}" --to-round N   (see CHECKPOINTS.md)`,
    `- Keep working with the engineer by hand:  claude --resume ${S.worker.id}`,
    `- Ask the planner about the run:  claude --resume ${S.planner.id}`,
  ].filter((l) => l !== null);
  fs.writeFileSync(runPath('SUMMARY.md'), lines.join('\n') + '\n');
}

// The PID of the claude process we started, saved so a resume after a hard crash can stop a leftover one.
function trackChild(pid) {
  S.childPid = pid || null;
  save();
}

function stopLeftoverChild() {
  if (!S.childPid) return;
  if (killPid(S.childPid)) log(`  Stopped a leftover Claude process from before the crash (pid ${S.childPid}).`);
  S.childPid = null;
}

// ---------------------------------------------------------------- asking the human
// Asks one question. Lines that arrive within a moment of each other (a paste) count as ONE answer,
// so a multi-line paste can't spill into the next question.
function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    let timer = null;
    rl.on('SIGINT', () => { rl.close(); process.emit('SIGINT'); });
    rl.on('line', (line) => {
      lines.push(line);
      clearTimeout(timer);
      timer = setTimeout(() => { rl.close(); resolve(lines.join('\n').trim()); }, 300);
    });
    rl.setPrompt(q);
    rl.prompt();
  });
}

// ---------------------------------------------------------------- planner
function sessionMode(sess) {
  const e = sessionExists(sess.id);
  if (e === true) return 'resume';
  if (e === false) return 'create';
  return sess.attempted ? 'resume' : 'create';
}

function contextPack() {
  return [
    '[Context] You are the PLANNER, continuing an unattended run that already has history.',
    'Earlier planner sessions were closed to keep context small, so read these files first:',
    `- Goal: ${runPath('goal.md')}`,
    `- Milestone plan: ${runPath('PLAN.md')}`,
    `- Decisions so far: ${runPath('DECISIONS.md')}`,
    `- Questions for the human: ${runPath('QUESTIONS.md')}`,
    `Engineer rounds so far: ${S.round}.`,
  ].join('\n');
}

function queuePlanner(body) {
  S.msgSeq++;
  let fresh = S.planner.calls === 0 && !S.planner.attempted;
  if (S.rotatePlanner) {
    S.planner = { id: randomUUID(), attempted: false, calls: 0 };
    S.rotatePlanner = false;
    fresh = true;
    body = `${contextPack()}\n\n${body}`;
    log('  (planner starts a fresh session to keep context small)');
  }
  S.pending = { seq: S.msgSeq, body, effort: fresh ? CFG.plannerEffort : CFG.plannerReviewEffort, attempted: false };
  S.phase = 'plan';
}

function parsePlanner(final) {
  let o = final.structured_output;
  if (!o) { try { o = JSON.parse(final.result); } catch { return null; } }
  if (!o || !['CONTINUE', 'DONE', 'BLOCKED'].includes(o.status)) return null;
  return {
    review: o.review || '',
    status: o.status,
    progress: o.progress || 'advanced',
    plan: Array.isArray(o.plan) ? o.plan : (S.planList || []),
    current_milestone: o.current_milestone || '',
    role: o.role || 'general',
    prompt: (o.prompt || '').trim(),
    new_decisions: Array.isArray(o.new_decisions) ? o.new_decisions : [],
    new_questions: Array.isArray(o.new_questions) ? o.new_questions : [],
    closed_questions: Array.isArray(o.closed_questions) ? o.closed_questions : [],
    summary_for_human: o.summary_for_human || '',
  };
}

async function callPlanner() {
  const p = S.pending;
  const marker = `[relay-msg ${p.seq}]`;
  let formatRetry = null;
  let formatRetries = 0;
  let hardErrors = 0;
  let sessionFixes = 0;

  hr(`Opus planning  [${header()}]`);
  showProgress();
  while (true) {
    let text;
    if (formatRetry) {
      text = formatRetry;
    } else if (!p.attempted) {
      text = `${marker}\n${p.body}`;
    } else {
      // We sent this before and it was interrupted. Did it reach the model?
      const seen = transcriptHasUserMessage(S.planner.id, marker);
      if (seen === true) text = `[relay-msg ${p.seq} retry] The connection dropped before your reply to ${marker} arrived. Answer ${marker} now, in the required structured format.`;
      else if (seen === false) text = `${marker}\n${p.body}`;
      else text = `[relay-msg ${p.seq} retry] The connection dropped. If ${marker} is visible above, answer it and ignore the copy below. Copy:\n\n${marker}\n${p.body}`;
    }

    const mode = sessionMode(S.planner);
    const args = [
      '--model', CFG.plannerModel,
      '--tools', CFG.plannerTools,
      '--disallowedTools', 'mcp__*',
      '--json-schema', JSON.stringify(PLANNER_SCHEMA),
      '--append-system-prompt-file', runPath('_planner-system.md'),
      mode === 'resume' ? '--resume' : '--session-id', S.planner.id,
    ];
    if (p.effort) args.push('--effort', p.effort);

    p.attempted = true;
    S.planner.attempted = true;
    save();
    fs.writeFileSync(runPath(`${pad(S.round)}-to-opus-${p.seq}.md`), text);

    const r = await runClaude({ args, prompt: text, cwd: S.project, label: 'opus', timeoutMinutes: CFG.timeoutMinutes, cfg: CFG, onSpawn: trackChild, spinner: 'Opus reviewing and planning' });
    trackChild(null);
    S.totalCost += r.final?.total_cost_usd || 0;

    if (r.final && !r.final.is_error) {
      S.planner.calls++;
      const parsed = parsePlanner(r.final);
      fs.writeFileSync(runPath(`${pad(S.round)}-opus-${p.seq}.json`), JSON.stringify(r.final.structured_output ?? r.final.result, null, 2));
      if (parsed) return parsed;
      if (++formatRetries <= 2) {
        log('  Opus reply was not in the required format, asking it to send it again');
        formatRetry = 'Your last reply did not match the required structured output. Send it again in that format.';
        continue;
      }
      return { status: 'BLOCKED', review: 'The planner kept replying in the wrong format.', summary_for_human: 'The planner kept replying in the wrong format. Check the latest -opus-*.json file in the run folder.', plan: S.planList || [], new_decisions: [], new_questions: [], closed_questions: [], progress: 'no_progress', current_milestone: S.lastPlan?.current_milestone || '', role: 'general', prompt: '' };
    }
    formatRetry = null;

    const t = failureText(r);
    if (isNoConversation(t) && ++sessionFixes <= 3) { S.planner.attempted = false; p.attempted = false; continue; }
    if (isSessionInUse(t) && ++sessionFixes <= 3) { S.planner.attempted = true; continue; }

    log(`  Opus call failed: ${t.trim().split('\n')[0].slice(0, 200) || `exit code ${r.code}`}`);
    const w = await waitUntilAvailable({
      cfg: CFG, model: CFG.plannerModel, cwd: S.project,
      onWaitStart: (why) => notify(CFG, 'info', 'Relay paused', why === 'offline' ? 'Internet is down. It will continue by itself.' : 'Waiting for Claude to be available again.'),
    });
    if (!w.ok) return null;
    if (!w.waited && ++hardErrors >= 3) {
      return { status: 'BLOCKED', review: `Opus keeps failing: ${t.slice(-1500)}`, summary_for_human: `The planner call keeps failing even though Claude is reachable. Last error:\n${t.slice(-1500)}`, plan: S.planList || [], new_decisions: [], new_questions: [], closed_questions: [], progress: 'no_progress', current_milestone: S.lastPlan?.current_milestone || '', role: 'general', prompt: '' };
    }
  }
}

function applyPlan(res) {
  const prevMilestone = S.lastPlan?.current_milestone;
  S.lastPlan = res;
  S.planList = res.plan;
  for (const d of res.new_decisions) S.decisions.push({ round: S.round, text: String(d).replace(/^(\s*\(round \d+\)\s*)+/i, '') });
  for (const id of res.closed_questions) {
    const q = S.questions.find((x) => x.id === Number(String(id).replace(/\D/g, '')));
    if (q && q.status === 'open') { q.status = 'closed'; q.answer = q.answer || 'closed by the planner (no longer needed)'; }
  }
  for (const q of res.new_questions) {
    if (!q?.question) continue;
    S.questions.push({ id: S.questions.length + 1, question: q.question, milestone: q.milestone || '', default_taken: q.default_taken || '', status: 'open', round: S.round });
  }

  if (res.progress === 'no_progress') {
    if (S.stuck.milestone === res.current_milestone) S.stuck.count++;
    else S.stuck = { milestone: res.current_milestone, count: 1 };
  } else {
    S.stuck = { milestone: res.current_milestone, count: 0 };
  }

  if (prevMilestone && res.current_milestone && res.current_milestone !== prevMilestone && CFG.freshSessionPerMilestone) {
    S.rotatePlanner = true;
    S.rotateWorker = true;
  }
  if (S.planner.calls >= CFG.plannerMaxCallsPerSession) S.rotatePlanner = true;

  writeDocs();

  if (res.review) log(`\nOpus review:\n${res.review}`);
  const done = res.plan.filter((m) => m.status === 'done').length;
  log(`\nPlan: ${done}/${res.plan.length} milestones done` + (res.current_milestone ? `, next: ${res.current_milestone} (${res.role})` : ''));
  if (res.new_decisions.length) log(`Decided on its own: ${res.new_decisions.length} (see DECISIONS.md)`);
  if (res.new_questions.length) log(`Parked ${res.new_questions.length} question(s) for you (see QUESTIONS.md), continuing with other work`);
}

async function phasePlan() {
  const res = await callPlanner();
  if (!res) {
    S.phase = 'blocked';
    S.blockReason = `Claude was unreachable for more than ${CFG.recovery.maxWaitHours} hours.`;
    return;
  }
  applyPlan(res);

  if (res.status === 'CONTINUE' && S.finalizing) {
    S.phase = 'done';
    S.endReason = S.finalizing;
    return;
  }
  if (res.status === 'DONE') { S.phase = 'done'; S.endReason = 'Goal finished (planner verified)'; return; }
  if (res.status === 'BLOCKED') { S.phase = 'blocked'; S.blockReason = res.summary_for_human || res.review; return; }

  // CONTINUE
  if (S.stuck.count >= CFG.stuck.blockAfter) {
    S.phase = 'blocked';
    S.blockReason = `Milestone ${S.stuck.milestone} made no progress for ${S.stuck.count} rounds.`;
    return;
  }
  if (!res.prompt) {
    queuePlanner('Your status was CONTINUE but the prompt was empty. Reply again with the full prompt for the engineer.');
    return;
  }
  S.taskSeq++;
  S.pendingWork = { seq: S.taskSeq, prompt: res.prompt, milestone: res.current_milestone, role: res.role, attempted: false, checkpointed: false };
  S.phase = 'work';
}

// ---------------------------------------------------------------- worker
function continueMessage(marker, prompt, includeCopy) {
  let t = `[relay-continue] Your work on ${marker} was interrupted (connection drop or the relay stopped). Do NOT start over.\n` +
    `1. Run git status and git log -5, and look at the files you were editing, to see what is already done.\n` +
    `2. Finish only what is left of ${marker}.\n` +
    `3. Before repeating anything that isn't safe to run twice (commits, migrations, seeds, installs), confirm it didn't already happen.\n` +
    `4. End with the usual report, covering the whole task.`;
  if (includeCopy) t += `\n\nIf you cannot see ${marker} above, it never reached you and nothing was done yet. In that case do it from the start. Here it is:\n\n${marker}\n${prompt}`;
  return t;
}

async function phaseWork() {
  const w = S.pendingWork;

  if (S.confirm && !w.attempted) {
    hr(`Prompt for Sonnet  [${header()}]`);
    log(w.prompt);
    const c = (await ask('\n[Enter] run   [a] run + stop asking   [f] feedback to Opus   [s] stop (resume later)  > ')).toLowerCase();
    if (c === 's') { save(); log(`\nStopped. Resume with:\n  node "${SELF}" --resume-run "${S.runDir}"`); process.exit(0); }
    if (c === 'a') S.confirm = false;
    if (c === 'f') {
      const fb = await ask('Feedback for Opus: ');
      queuePlanner(`HUMAN FEEDBACK on your last prompt (it was NOT sent to the engineer):\n${fb}\n\nRevise and reply in the required format.`);
      S.pendingWork = null;
      return;
    }
  }

  const roleCfg = CFG.roles[w.role] || null;
  const roleKey = roleCfg ? w.role : null;
  if (!w.attempted) {
    const needFresh = !S.worker.attempted ? false
      : (S.rotateWorker || !CFG.workerKeepSession || S.worker.roleKey !== roleKey);
    if (needFresh) {
      S.worker = { id: randomUUID(), attempted: false, milestone: w.milestone, roleKey };
      log('  (engineer starts a fresh session for this milestone)');
    }
    S.rotateWorker = false;
    S.worker.milestone = w.milestone;
    S.worker.roleKey = roleKey;
  }

  if (!w.checkpointed) {
    S.checkpoints.push({ round: S.round + 1, head: G.head(S.project), milestone: w.milestone, dirty: G.isDirty(S.project) });
    w.checkpointed = true;
    writeDocs();
    save();
  }

  const n = S.round + 1;
  fs.writeFileSync(runPath(`${pad(n)}-prompt.md`), w.prompt);
  hr(`Sonnet working (${w.role})  [${header()}]`);
  showProgress();
  if (!S.confirm) {
    const lines = w.prompt.split('\n');
    log(lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n  ... (${lines.length - 8} more lines in ${pad(n)}-prompt.md)` : ''));
    log('');
  }

  const marker = `[relay-task ${w.seq}]`;
  const started = Date.now();
  let hard = 0;
  let sessionFixes = 0;
  let result = null;

  while (!result) {
    let text;
    if (!w.attempted) {
      text = `${marker}\n${w.prompt}`;
    } else {
      const seen = transcriptHasUserMessage(S.worker.id, marker);
      if (seen === true) text = continueMessage(marker, w.prompt, false);
      else if (seen === false) text = `${marker}\n${w.prompt}`; // never reached the model, so nothing was done
      else text = continueMessage(marker, w.prompt, true);
      if (seen !== false) log('  Continuing the interrupted task (not starting over)');
    }

    const mode = sessionMode(S.worker);
    const sysFile = roleKey ? runPath(`_worker-system-${roleKey}.md`) : runPath('_worker-system.md');
    const args = [
      '--model', roleCfg?.model || CFG.workerModel,
      '--permission-mode', CFG.workerPermissionMode,
      '--settings', runPath('_worker-settings.json'),
      '--append-system-prompt-file', sysFile,
    ];
    args.push(mode === 'resume' ? '--resume' : '--session-id', S.worker.id);
    if (roleCfg?.effort || CFG.workerEffort) args.push('--effort', roleCfg?.effort || CFG.workerEffort);
    if (CFG.workerMaxTurns) args.push('--max-turns', String(CFG.workerMaxTurns));

    w.attempted = true;
    S.worker.attempted = true;
    save();

    const r = await runClaude({ args, prompt: text, cwd: S.project, label: 'sonnet', timeoutMinutes: CFG.timeoutMinutes, cfg: CFG, onSpawn: trackChild, spinner: `Sonnet working on ${w.milestone || 'the task'}` });
    trackChild(null);
    S.totalCost += r.final?.total_cost_usd || 0;

    if (r.final && !r.final.is_error) { result = { r, report: r.final.result || '(empty report)' }; break; }

    const t = failureText(r);
    if (isNoConversation(t) && ++sessionFixes <= 3) { S.worker.attempted = false; w.attempted = false; continue; }
    if (isSessionInUse(t) && ++sessionFixes <= 3) { S.worker.attempted = true; continue; }
    if (r.timedOut) { result = { r, report: `ENGINEER RUN TIMED OUT after ${CFG.timeoutMinutes} min of work. A command may have hung (a server or watcher?). Partial work may be in the files.\n\n${r.final?.result || ''}` }; break; }
    if (r.final?.subtype === 'error_max_turns') { result = { r, report: `ENGINEER HIT THE TURN LIMIT before finishing.\n\n${r.final.result || ''}` }; break; }

    log(`  Sonnet run stopped: ${t.trim().split('\n')[0].slice(0, 200) || `exit code ${r.code}`}`);
    const wait = await waitUntilAvailable({
      cfg: CFG, model: roleCfg?.model || CFG.workerModel, cwd: S.project,
      onWaitStart: (why) => notify(CFG, 'info', 'Relay paused', why === 'offline' ? 'Internet is down. It will continue by itself.' : 'Waiting for Claude to be available again.'),
    });
    if (!wait.ok) {
      S.phase = 'blocked';
      S.blockReason = `Claude was unreachable for more than ${CFG.recovery.maxWaitHours} hours during round ${n}.`;
      return;
    }
    if (!wait.waited && ++hard >= 2) { result = { r, report: `ENGINEER RUN FAILED (Claude is reachable, so this is not a connection problem):\n${t.slice(-3000)}` }; break; }
  }

  // ---- round finished
  const secs = Math.round((Date.now() - started) / 1000);
  const denials = (result.r.final?.permission_denials || [])
    .map((d) => `- ${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 200)}`).join('\n');
  const reportFile = runPath(`${pad(n)}-report.md`);
  fs.writeFileSync(reportFile, result.report);
  S.round = n;
  S.history.push({ round: n, milestone: w.milestone, role: w.role, seconds: secs, turns: result.r.final?.num_turns ?? null, error: !!result.r.final?.is_error });
  log(`\n  Sonnet finished round ${n} in ${fmtDuration(secs * 1000)}${result.r.final?.num_turns ? `, ${result.r.final.num_turns} turns` : ''}`);
  S.pendingWork = null;

  const cp = S.checkpoints.find((c) => c.round === n);
  let notices = '';
  if (S.stuck.count >= CFG.stuck.parkAfter) {
    notices += `\nSTUCK: milestone ${S.stuck.milestone} has made no progress for ${S.stuck.count} rounds. Park it now: mark it parked, add a question explaining what blocks it, and move on to other milestones. If nothing else is left, reply BLOCKED.\n`;
  } else if (S.stuck.count >= CFG.stuck.warnAfter) {
    notices += `\nSTUCK WARNING: milestone ${S.stuck.milestone} has made no progress for ${S.stuck.count} rounds. Try one clearly different approach now.\n`;
  }
  if (S.round >= S.maxRounds) S.finalizing = `Stopped at the round limit (${S.maxRounds})`;
  else if (S.maxHours && S.elapsedMs >= S.maxHours * 3600 * 1000) S.finalizing = `Stopped at the time limit (${S.maxHours}h)`;
  if (S.finalizing) {
    notices += `\nLIMIT: ${S.finalizing}. This was the last round. Review it, set status DONE, keep unfinished milestones as todo, and explain what is left in summary_for_human.\n`;
  }

  queuePlanner(
    `ENGINEER REPORT for round ${n} (milestone ${w.milestone}, ${w.role}):\n\n${truncateMiddle(result.report, CFG.maxReportChars)}\n\n(full report: ${reportFile})\n\n` +
    (denials ? `PERMISSION DENIALS (commands the engineer was not allowed to run):\n${denials}\n\n` : '') +
    `GIT SNAPSHOT:\n${G.snapshot(S.project, cp?.head)}\n` + notices +
    `\nReview and send the next step.`,
  );
}

// ---------------------------------------------------------------- blocked / done
async function answerQuestions(open) {
  const answers = [];
  log('\n(Enter skips one question. Type "skip all" to skip the rest.)');
  for (const q of open) {
    const a = await ask(`\nQ${q.id}${q.milestone ? ` (${q.milestone})` : ''}: ${q.question}\n  your answer > `);
    if (a.toLowerCase() === 'skip all') break;
    if (a) { q.status = 'answered'; q.answer = a; answers.push(`Q${q.id}: ${q.question}\nAnswer: ${a}`); }
  }
  return answers;
}

async function phaseBlocked() {
  const open = S.questions.filter((q) => q.status === 'open');
  hr('The relay needs you');
  log(S.blockReason || 'The planner cannot continue without you.');
  if (open.length) log(`\nOpen questions (${open.length}), also in QUESTIONS.md:`);
  for (const q of open) log(`  Q${q.id}: ${q.question}`);
  writeSummary();
  notify(CFG, 'attention', 'Relay needs you', (S.blockReason || 'Open questions').slice(0, 200));

  if (!process.stdin.isTTY) {
    save();
    log(`\nAnswer later and continue with:\n  node "${SELF}" --resume-run "${S.runDir}"`);
    process.exit(2);
  }
  const stopBuzz = startBuzzer(CFG, 'attention');
  let answers = [];
  let guidance = '';
  try {
    if (open.length) answers = await answerQuestions(open);
    guidance = await ask('\nAnything else for the planner? (Enter to skip, "stop" to stop and resume later) > ');
  } finally { stopBuzz(); }

  if (guidance.toLowerCase() === 'stop' || (!answers.length && !guidance)) {
    writeDocs();
    save();
    log(`\nStopped. Continue later with:\n  node "${SELF}" --resume-run "${S.runDir}"`);
    process.exit(0);
  }
  writeDocs();
  S.blockReason = null;
  S.stuck = { milestone: S.stuck.milestone, count: 0 };
  queuePlanner(`HUMAN ANSWERS:\n${answers.join('\n\n') || '(none)'}${guidance ? `\n\nHUMAN GUIDANCE:\n${guidance}` : ''}\n\nContinue the work. Unpark milestones that these answers unblock.`);
}

async function phaseDone() {
  writeSummary();
  save();
  const open = S.questions.filter((q) => q.status === 'open');
  hr('Finished');
  showProgress();
  log(`  ${S.endReason}`);
  log(`  ${S.round} rounds, ${fmtDuration(S.elapsedMs)} of work, reported usage $${S.totalCost.toFixed(2)}`);
  if (open.length) log(`  ${open.length} open question(s) for you`);
  log(`\n  Read this first: ${runPath('SUMMARY.md')}`);
  notify(CFG, 'done', 'Relay finished', `${S.endReason}. ${S.round} rounds.${open.length ? ` ${open.length} question(s) for you.` : ''}`);

  if (!process.stdin.isTTY) return 'exit';
  const stopBuzz = startBuzzer(CFG, 'done');
  let c = '';
  try {
    c = (await ask(open.length ? '\n[Enter] finish   [a] answer the open questions and keep going  > ' : '\nPress Enter to finish  > ')).toLowerCase();
  } finally { stopBuzz(); }
  if (c === 'a' && open.length) {
    const answers = await answerQuestions(open);
    if (answers.length) {
      writeDocs();
      S.finalizing = null;
      S.endReason = null;
      queuePlanner(`HUMAN ANSWERS to the parked questions:\n${answers.join('\n\n')}\n\nContinue: finish the milestones these answers unblock.`);
      return 'continue';
    }
  }
  return 'exit';
}

// ---------------------------------------------------------------- main loop
async function loop() {
  while (true) {
    tickClock();
    save();
    if (S.phase === 'plan') await phasePlan();
    else if (S.phase === 'work') await phaseWork();
    else if (S.phase === 'blocked') await phaseBlocked();
    else if (S.phase === 'done') {
      const next = await phaseDone();
      save();
      if (next === 'exit') return;
    } else throw new Error(`Unknown phase ${S.phase}`);
  }
}

function installSignalHandlers() {
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    stopSpinner();
    log('\nStopping (Ctrl+C). Saving state...');
    killTree(currentChild());
    try { tickClock(); save(); } catch { /* best effort */ }
    log(`Resume later with:\n  node "${SELF}" --resume-run "${S.runDir}"`);
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop); // terminal window closed
}

async function startNew(args) {
  const project = path.resolve(args.project);
  if (!fs.existsSync(project)) throw new Error(`Project folder not found: ${project}`);
  CFG = loadConfig(args.config || projectConfig(project));
  let goal = args.goal;
  let goalFrom = args.goal ? '--goal' : null;
  const goalFile = args.goalFile || (!args.goal && fs.existsSync(path.join(project, 'docs', 'relay', 'goal.md')) ? path.join(project, 'docs', 'relay', 'goal.md') : null);
  if (goalFile) { goal = fs.readFileSync(path.resolve(goalFile), 'utf8'); goalFrom = goalFile; }
  if (!goal || !goal.trim()) {
    throw new Error('No goal. Write it in docs/relay/goal.md (run "relay init" to create it), or pass --goal-file / --goal.');
  }
  if (/\[(FILL IN|WRITE HERE)/i.test(goal)) throw new Error(`The goal still has placeholders to fill in: ${goalFrom}`);

  const runDir = path.join(project, '.relay', stamp());
  fs.mkdirSync(runDir, { recursive: true });
  S = {
    v: 2, runDir, project, configPath: CFG._path, createdAt: Date.now(), elapsedMs: 0, lastTick: Date.now(),
    maxRounds: args.rounds || CFG.maxRounds, maxHours: args.hours || CFG.maxHours, confirm: args.confirm,
    phase: 'plan', round: 0, msgSeq: 0, taskSeq: 0, totalCost: 0,
    baseHead: G.head(project),
    planner: { id: randomUUID(), attempted: false, calls: 0 },
    worker: { id: randomUUID(), attempted: false, milestone: null, roleKey: null },
    rotatePlanner: false, rotateWorker: false,
    pending: null, pendingWork: null, lastPlan: null, planList: [],
    decisions: [], questions: [], checkpoints: [], history: [],
    stuck: { milestone: null, count: 0 }, finalizing: null, blockReason: null, endReason: null,
  };
  setLogFile(runPath('relay.log'));
  fs.writeFileSync(runPath('goal.md'), goal);
  writeSystemFiles();
  writeDocs();

  log(`foxrelay ${VERSION}`);
  log(`  project : ${project}`);
  log(`  goal    : ${goalFrom}`);
  log(`  config  : ${CFG._path}`);
  log(`  planner : ${CFG.plannerModel}   engineer: ${CFG.workerModel}`);
  log(`  limits  : ${S.maxRounds} rounds${S.maxHours ? `, ${S.maxHours}h` : ''}   mode: ${S.confirm ? 'confirm each round' : 'fully automatic'}`);
  log(`  run dir : ${runDir}`);
  if (!G.isRepo(project)) log('  WARNING: not a git repository. Checkpoints and rollback are off.');
  else if (G.isDirty(project)) log('  WARNING: the project has uncommitted changes. Commit them first so you can tell your changes from the relay\'s.');
  log(`  resume  : node "${SELF}" --resume-run "${runDir}"`);

  const inline = goal.length <= 8000 ? `\n\n${goal.trim()}` : '\n\n(The goal is long. Read the file.)';
  queuePlanner(
    `GOAL (saved at ${runPath('goal.md')}):${inline}\n\n` +
    'The project is the current working directory. Look around as much as you need, then build the milestone plan and write the first prompt for the engineer.\n' +
    `The relay keeps PLAN.md, DECISIONS.md and QUESTIONS.md in ${runDir}; you can read them any time.`,
  );
  save();
  installSignalHandlers();
  startHeartbeat();
  await loop();
}

// ---------------------------------------------------------------- helpers for several projects
function projectConfig(project) {
  const p = path.join(project, 'docs', 'relay', 'relay.config.json');
  return fs.existsSync(p) ? p : null;
}

function findLatestRun(project) {
  const dir = path.join(path.resolve(project), '.relay');
  if (!fs.existsSync(dir)) return null;
  const runs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'state.json'))).sort();
  return runs.length ? path.join(dir, runs[runs.length - 1]) : null;
}

function resolveRun(args) {
  const r = args.resumeRun || args.runArg || findLatestRun(args.project);
  if (!r) throw new Error(`No relay run found in ${path.join(path.resolve(args.project), '.relay')}. Start one with "relay" from the project folder.`);
  return path.resolve(r);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function isRunning(st) {
  return pidAlive(st.relayPid) && Date.now() - (st.heartbeat || 0) < 90 * 1000;
}

async function initProject(args) {
  const project = path.resolve(args.project);
  const dir = path.join(project, 'docs', 'relay');
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  const copyIfMissing = (from, to) => { if (!fs.existsSync(to)) { fs.copyFileSync(from, to); made.push(to); } };
  copyIfMissing(path.join(HERE, 'relay.config.json'), path.join(dir, 'relay.config.json'));
  copyIfMissing(path.join(HERE, 'rules.md'), path.join(dir, 'rules.md'));
  const goal = path.join(dir, 'goal.md');
  if (!fs.existsSync(goal)) {
    fs.writeFileSync(goal, [
      '[WRITE HERE] One sentence: what should be finished at the end of this run.',
      '',
      'Read docs/relay/PRD.md first. (Optional: put your PRD or spec there, or point to your own docs.)',
      '',
      'Done means:',
      '- [WRITE HERE] concrete, checkable conditions, e.g. "npm test and npm run build pass"',
      '',
      "Don't touch:",
      '- [WRITE HERE] folders, modules or files that must not change',
      '',
      'Park a question instead of deciding: new dependencies, schema changes to existing tables, anything that deletes data.',
      '',
    ].join('\n'));
    made.push(goal);
  }
  const gi = path.join(project, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\.relay\/?\s*$/m.test(giText)) {
    fs.appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}.relay/\n`);
    made.push(`${gi} (added .relay/)`);
  }
  console.log(made.length ? `Created:\n${made.map((m) => `  ${m}`).join('\n')}` : 'Everything already exists. Nothing changed.');
  console.log(`
Next:
  1. Write the goal in docs/relay/goal.md (replace every [WRITE HERE]).
  2. Check docs/relay/rules.md and the allow/deny lists in docs/relay/relay.config.json for this project.
  3. Commit (git add docs/relay .gitignore), then run:  relay
`);
}

async function status(args) {
  const runDir = resolveRun(args);
  const st = readJson(path.join(runDir, 'state.json'));
  const running = isRunning(st);
  const ago = (t) => (t ? fmtDuration(Date.now() - t) : '?');
  const phaseText = {
    plan: 'planner is reviewing and planning',
    work: `engineer is working on ${st.pendingWork?.milestone || '?'} (${st.pendingWork?.role || '?'})`,
    blocked: 'NEEDS YOU: open questions or a blocker',
    done: `finished: ${st.endReason || ''}`,
  }[st.phase] || st.phase;
  const p = progressLine({ plan: st.planList, round: st.round, maxRounds: st.maxRounds, elapsed: fmtDuration(st.elapsedMs || 0), current: st.lastPlan?.current_milestone });
  const open = (st.questions || []).filter((q) => q.status === 'open').length;
  console.log(`foxrelay status  ${runDir}`);
  console.log(`  State    : ${st.phase === 'done' ? 'finished' : running ? `RUNNING (last sign of life ${ago(st.heartbeat)} ago)` : `NOT RUNNING (stopped ${ago(st.heartbeat)} ago)`}`);
  console.log(`  Doing    : ${phaseText}`);
  console.log(`  ${p.text}`);
  console.log(`  Usage    : $${(st.totalCost || 0).toFixed(2)} reported (usage on a Max plan, not a bill)`);
  console.log(`  Questions: ${open} open${open ? ' (see QUESTIONS.md)' : ''}`);
  const logFile = path.join(runDir, 'relay.log');
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-6);
    console.log(`  Last log lines:\n${lines.map((l) => `    ${l.slice(0, 150)}`).join('\n')}`);
  }
  if (!running && st.phase !== 'done') console.log(`\n  Continue with:  node "${SELF}" --resume-run "${runDir}"`);
  if (st.phase === 'done') console.log(`\n  Read: ${path.join(runDir, 'SUMMARY.md')}`);
}

async function resumeRun(args) {
  const runDir = resolveRun(args);
  const sp = path.join(runDir, 'state.json');
  if (!fs.existsSync(sp)) throw new Error(`No state.json in ${runDir}`);
  S = readJson(sp);
  if (isRunning(S)) {
    const running = S;
    S = null;
    throw new Error(`This run is already running in another terminal (pid ${running.relayPid}). Watch it with "relay status". Starting it twice would make two engineers edit the same files.`);
  }
  S.runDir = runDir;
  CFG = loadConfig(args.config || (fs.existsSync(S.configPath || '') ? S.configPath : null));
  if (args.rounds) S.maxRounds = args.rounds;
  if (args.hours) S.maxHours = args.hours;
  if (args.confirm) S.confirm = true;
  S.lastTick = Date.now(); // time while the relay was down doesn't count
  setLogFile(runPath('relay.log'));
  writeSystemFiles();

  log(`\nfoxrelay ${VERSION}: resuming ${runDir}`);
  stopLeftoverChild();
  log(`  phase: ${S.phase}, rounds done: ${S.round}${S.pendingWork?.attempted && !args.messageFile ? ', an engineer task was interrupted and will continue (not restart)' : ''}`);

  // A message from the human (corrections, new answers, guidance), read from a file so it can be any length.
  if (args.messageFile) {
    const text = fs.readFileSync(path.resolve(args.messageFile), 'utf8').trim();
    if (!text) throw new Error(`Message file is empty: ${args.messageFile}`);
    let note = '';
    if (S.phase === 'work' && S.pendingWork) {
      note = S.pendingWork.attempted
        ? `\n\nThe engineer's current task (milestone ${S.pendingWork.milestone}) was stopped part way so you could read this first. Check git status and the files, then give the engineer a fresh prompt that fits this message.`
        : '\n\nYour last prompt was NOT sent to the engineer. Rewrite it if this message changes anything.';
      S.pendingWork = null;
    }
    const closed = S.questions.filter((q) => q.status === 'open');
    for (const q of closed) { q.status = 'answered'; q.answer = `answered in ${path.basename(args.messageFile)}`; }
    writeDocs();
    S.blockReason = null;
    S.finalizing = null;
    S.endReason = null;
    S.stuck = { milestone: S.stuck?.milestone || null, count: 0 };
    queuePlanner(`HUMAN MESSAGE (this replaces any earlier answer it mentions):\n\n${text}${note}\n\nUpdate the plan and continue.`);
    save();
    log(`  Your message from ${args.messageFile} goes to the planner first.`);
  }
  // A run that stopped at its round or time limit can go on: raise the limit with --rounds or --hours.
  const limitStop = S.phase === 'done' && /round limit|time limit/.test(S.endReason || '');
  if (limitStop && !args.messageFile) {
    const moreRounds = args.rounds && args.rounds > S.round;
    const moreHours = args.hours && S.elapsedMs < args.hours * 3600 * 1000;
    if (moreRounds || moreHours) {
      S.finalizing = null;
      S.endReason = null;
      queuePlanner(`The human raised the limit (now ${S.maxRounds} rounds${S.maxHours ? `, ${S.maxHours}h` : ''}). Continue with the remaining milestones in PLAN.md.`);
      save();
      log(`  Continuing: limit raised to ${S.maxRounds} rounds${S.maxHours ? `, ${S.maxHours}h` : ''}.`);
    } else {
      log(`  This run stopped at its limit (${S.round} rounds). To keep going, raise it, for example:\n  node "${SELF}" --resume-run "${runDir}" --rounds ${S.round + 20}`);
      return;
    }
  }
  if (S.phase === 'done') {
    const open = S.questions.filter((q) => q.status === 'open');
    if (!open.length) { log('  This run already finished. Nothing to do. See SUMMARY.md.'); return; }
  }
  installSignalHandlers();
  startHeartbeat();
  await loop();
}

async function rollback(args) {
  const runDir = path.resolve(args.rollback);
  S = readJson(path.join(runDir, 'state.json'));
  S.runDir = runDir;
  CFG = loadConfig(args.config || (fs.existsSync(S.configPath || '') ? S.configPath : null));
  setLogFile(runPath('relay.log'));
  const n = args.toRound;
  const cp = S.checkpoints.find((c) => c.round === n);
  if (!n || !cp || !cp.head) {
    console.log('Pick a round with --to-round. Available checkpoints:');
    for (const c of S.checkpoints) console.log(`  round ${c.round} (${c.milestone || '-'}): ${c.head || 'no git'}`);
    process.exit(1);
  }
  log(`Rolling back ${S.project} to the state before round ${n}: ${cp.head}`);
  log(G.git(S.project, ['log', '--oneline', `${cp.head}..HEAD`]) ? `These commits will be removed from the branch (still recoverable with git reflog):\n${G.git(S.project, ['log', '--oneline', `${cp.head}..HEAD`])}` : 'No commits after that point.');
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error('Add --yes to confirm.');
    const a = (await ask('Type "yes" to continue > ')).toLowerCase();
    if (a !== 'yes') { log('Cancelled.'); return; }
  }
  if (G.isDirty(S.project)) {
    G.git(S.project, ['stash', 'push', '-u', '-m', `relay rollback backup ${stamp()}`]);
    log('Uncommitted changes were saved with git stash (see: git stash list).');
  }
  if (G.git(S.project, ['reset', '--hard', cp.head]) === null) throw new Error('git reset failed');
  S.checkpoints = S.checkpoints.filter((c) => c.round < n);
  S.round = n - 1;
  S.pendingWork = null;
  S.finalizing = null;
  S.endReason = null;
  S.rotatePlanner = true;
  S.rotateWorker = true;
  S.stuck = { milestone: null, count: 0 };
  queuePlanner(`The human rolled the project back to the state before round ${n} (commit ${cp.head.slice(0, 8)}). Everything the engineer did from round ${n} on is gone. Re-check the project, update the plan, and continue.`);
  writeDocs();
  save();
  log(`Done. Continue the run with:\n  node "${SELF}" --resume-run "${runDir}"`);
}

async function testNotify(args) {
  CFG = loadConfig(args.config);
  setNotifyDebug(true); // run each step in the foreground and show its result
  console.log(`Platform: ${process.platform}. Sound on: ${CFG.notify.sound !== false}. Notifications on: ${CFG.notify.desktop !== false}.`);
  console.log('\n1) "done" sound and a notification (the notification stays about 15 seconds)...');
  notify(CFG, 'done', 'Relay test', 'This is what "finished" sounds like.');
  console.log('\n2) "needs you" sound...');
  notify(CFG, 'attention', 'Relay test', 'This is what "needs you" sounds like.');
  await sleep(500);
  console.log(CFG.notify.ntfyUrl ? `Also sent a phone push to ${CFG.notify.ntfyUrl}` : 'No ntfyUrl set, so no phone push.');
}

// ---------------------------------------------------------------- entry
const args = parseArgs(process.argv.slice(2));
const main = args.testNotify ? testNotify
  : args.cmd === 'init' ? initProject
  : args.cmd === 'status' ? status
  : args.rollback ? rollback
  : (args.cmd === 'resume' || args.resumeRun || args.resumeLast) ? resumeRun
  : startNew;
main(args).then(() => process.exit(0)).catch((e) => {
  stopSpinner();
  console.error(`\nError: ${e.message}`);
  if (S?.runDir) {
    try { save(); } catch { /* ignore */ }
    console.error(`State saved. After fixing the problem, continue with:\n  node "${SELF}" --resume-run "${S.runDir}"`);
  }
  process.exit(1);
});
