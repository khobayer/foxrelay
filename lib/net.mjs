// Waiting out internet drops and usage limits.
import fs from 'node:fs';
import { runClaude, failureText, looksLikeLimit, parseResetTime } from './claude.mjs';
import { log, sleep, clock, fmtDuration } from './util.mjs';
import { startSpinner, setSpinnerDetail, stopSpinner } from './ui.mjs';

// true = online, false = offline, null = can't tell (behind a proxy, so we rely on the model probe)
export async function isOnline(cfg) {
  const hook = process.env.RELAY_TEST_OFFLINE_FILE; // used by the test suite only
  if (hook) {
    try {
      const v = fs.readFileSync(hook, 'utf8').trim();
      if (v === 'down') return false;
      const m = v.match(/^down-until:(\d+)$/);
      return !(m && Date.now() < Number(m[1]));
    } catch { return true; }
  }
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return null;
  try {
    await fetch(cfg.recovery.connectivityUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return true; // any HTTP answer at all means the internet works
  } catch {
    return false;
  }
}

// A tiny request to the model. Tells us if it's reachable and not rate limited.
export async function probeModel(cfg, model, cwd) {
  const r = await runClaude({
    args: ['--model', model, '--tools', '', '--disallowedTools', 'mcp__*', '--no-session-persistence'],
    prompt: 'Reply with just: OK',
    cwd,
    label: 'probe',
    timeoutMinutes: cfg.recovery.probeTimeoutSeconds / 60,
    cfg,
    quiet: true,
  }).catch((e) => ({ final: null, stderr: String(e) }));
  const ok = !!r.final && !r.final.is_error;
  const text = failureText(r);
  return { ok, limited: !ok && looksLikeLimit(text), text };
}

// Blocks until the model answers again. Returns { ok, waited }.
// ok=false only if we gave up after maxWaitHours.
export async function waitUntilAvailable({ cfg, model, cwd, onWaitStart }) {
  const R = cfg.recovery;
  const started = Date.now();
  let waited = false;
  let lastState = '';
  let lastNote = 0;

  const note = (state, msg) => {
    const now = Date.now();
    if (!waited) startSpinner('Paused, waiting for Claude to be reachable');
    setSpinnerDetail(state === 'offline' ? 'internet is down' : state === 'limit' ? 'usage limit' : 'retrying');
    if (state !== lastState || now - lastNote > 10 * 60 * 1000) {
      log(`  ${msg}${waited ? `  (waiting ${fmtDuration(now - started)})` : ''}`);
      lastState = state;
      lastNote = now;
    }
  };

  while (true) {
    if (Date.now() - started > R.maxWaitHours * 3600 * 1000) {
      stopSpinner();
      log(`  Gave up after waiting ${R.maxWaitHours}h.`);
      return { ok: false, waited };
    }

    const online = await isOnline(cfg);
    if (online === false) {
      if (!waited && onWaitStart) onWaitStart('offline');
      waited = true;
      note('offline', `Internet is down. Pausing and checking every ${R.netPollSeconds}s. The run will continue by itself.`);
      await sleep(R.netPollSeconds * 1000);
      continue;
    }

    const p = await probeModel(cfg, model, cwd);
    if (p.ok) {
      stopSpinner();
      if (waited) log(`  Connection is back (${clock()}). Continuing where it stopped.`);
      return { ok: true, waited };
    }

    if (!waited && onWaitStart) onWaitStart(p.limited ? 'limit' : 'error');
    waited = true;
    if (p.limited) {
      const reset = parseResetTime(p.text);
      // Check again every limitPollMinutes, even when the reset time is known: the limit can come back
      // early (extra usage turned on, a plan upgrade, a different account). Wake right at the reset if it's sooner.
      let waitMs = R.limitPollMinutes * 60 * 1000;
      if (reset) waitMs = Math.min(waitMs, Math.max(60 * 1000, reset - Date.now() + 60 * 1000));
      note('limit', `Usage limit reached${reset ? `, resets around ${clock(reset)}` : ''}. Checking every ${R.limitPollMinutes} min, continuing by itself.`);
      await sleep(waitMs);
    } else if (online === null) {
      note('unknown', `Model not reachable (maybe the internet is down). Retrying every ${R.netPollSeconds}s.`);
      await sleep(R.netPollSeconds * 1000);
    } else {
      note('error', `Model returned an error, retrying every ${R.otherErrorPollSeconds}s: ${p.text.trim().split('\n')[0].slice(0, 160)}`);
      await sleep(R.otherErrorPollSeconds * 1000);
    }
  }
}
