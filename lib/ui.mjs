// Live terminal display: colored output, a footer pinned to the bottom of the terminal with the progress bar
// and what is happening right now, and the window title.
// Only draws on a real terminal. Log files and pipes always get plain lines.
// RELAY_PLAIN=1 or NO_COLOR=1 turns colors and the footer style off. RELAY_NO_SPINNER=1 turns all live drawing off.

const TTY = !!process.stdout.isTTY && !process.env.RELAY_NO_SPINNER;
const COLOR = TTY && !process.env.NO_COLOR && !process.env.RELAY_PLAIN;

// ---------------------------------------------------------------- colors
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const orange = sgr('38;5;208');
const tag = sgr('48;5;208;38;5;16;1');
const bold = sgr('1');
const dim = sgr('2');
const gray = sgr('90');
const green = sgr('32');
const yellow = sgr('33');
const red = sgr('31');
const cyan = sgr('36');
const magenta = sgr('35');

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s) => s.replace(ANSI, '').length;

// Cut a colored string to max visible characters without breaking its color codes.
function fit(s, max) {
  if (visibleLength(s) <= max) return s;
  let out = '';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (n >= max - 1) break;
    out += s[i];
    n++;
  }
  return `${out}~${COLOR ? '\x1b[0m' : ''}`;
}

// ---------------------------------------------------------------- glyphs
// Characters that exist in the default Windows console fonts (Consolas, Lucida Console) as well as everywhere else.
const G = COLOR
  ? { full: '█', empty: '░', sep: ' │ ', rule: '─', frames: ['■···', '·■··', '··■·', '···■', '··■·', '·■··'] }
  : { full: '#', empty: '-', sep: '  |  ', rule: '-', frames: ['|', '/', '-', '\\'] };

// [##########----------] 50%
export function bar(done, total, width = 24) {
  if (!total) return `[${'-'.repeat(width)}]`;
  const filled = Math.round((done / total) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function colorBar(done, total, width) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${green(G.full.repeat(filled))}${dim(G.empty.repeat(width - filled))}`;
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function fmtElapsed(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function progressLine({ plan, round, maxRounds, elapsed, current }) {
  const total = plan?.length || 0;
  const done = plan ? plan.filter((m) => m.status === 'done').length : 0;
  const parked = plan ? plan.filter((m) => m.status === 'parked').length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const parts = [
    total ? `${bar(done, total)} ${pct}%  ${done}/${total} milestones${parked ? ` (${parked} parked)` : ''}` : '[planning]',
    current ? `now: ${current}` : '',
    `round ${round}/${maxRounds}`,
    elapsed,
  ].filter(Boolean);
  return { text: `Progress ${parts.join('  |  ')}`, pct, done, total };
}

// ---------------------------------------------------------------- footer
// The footer is redrawn below the output after every printed line, so it always sits at the bottom.
let spin = null; // { label, detail, started }
let frame = 0;
let source = null; // () => { plan, round, maxRounds, elapsedMs, current, phase }
let footerOn = false;
let suspended = false;
let drawn = 0;
let timer = null;

const IDLE = { plan: 'Opus is up next', work: 'Sonnet is up next', blocked: 'Needs you', done: 'Finished' };

function progressFooter() {
  const s = source();
  const plan = s.plan || [];
  const total = plan.length;
  const done = plan.filter((m) => m.status === 'done').length;
  const parked = plan.filter((m) => m.status === 'parked').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const parts = [
    total ? `${colorBar(done, total, 20)} ${bold(`${pct}%`)}  ${done}/${total} milestones${parked ? yellow(` (${parked} parked)`) : ''}` : dim('planning the milestones'),
    s.current ? `now ${cyan(bold(s.current))}` : '',
    `round ${s.round}/${s.maxRounds}`,
    fmtElapsed(s.elapsedMs || 0),
  ].filter(Boolean);
  return `${tag(' FOXRELAY ')} ${parts.join(dim(G.sep))}`;
}

function activityFooter() {
  if (spin) {
    return `  ${orange(G.frames[frame % G.frames.length])} ${bold(spin.label)}  ${dim(fmtClock(Date.now() - spin.started))}${spin.detail ? `  ${gray(spin.detail)}` : ''}`;
  }
  const phase = source ? source().phase : null;
  const text = IDLE[phase] || 'Working';
  const paint = phase === 'blocked' ? yellow : phase === 'done' ? green : dim;
  return `  ${paint(`${G.frames[0].slice(0, 1)} ${text}`)}`;
}

function footerLines() {
  if (suspended) return [];
  if (footerOn && source) return [progressFooter(), activityFooter()];
  if (spin) return [activityFooter().trimStart()];
  return [];
}

function clear() {
  if (!drawn) return;
  let s = '\r\x1b[2K';
  for (let i = 1; i < drawn; i++) s += '\x1b[1A\x1b[2K';
  process.stdout.write(s);
  drawn = 0;
}

function render() {
  if (!TTY) return;
  const cols = Math.max(20, (process.stdout.columns || 100) - 1);
  const lines = footerLines().map((l) => fit(l, cols));
  clear();
  if (!lines.length) return;
  process.stdout.write(lines.join('\n'));
  drawn = lines.length;
}

function ensureTimer() {
  if (timer || !TTY) return;
  timer = setInterval(() => {
    frame++;
    if (spin || footerOn) render();
  }, 250);
  timer.unref();
}

// Turn the pinned footer on for a run. source() is read on every redraw, so the footer is always current.
export function enableFooter(getSource) {
  if (!TTY) return;
  source = getSource;
  footerOn = true;
  ensureTimer();
  render();
  process.stdout.on('resize', render);
  process.on('exit', () => { clear(); });
}

// Remove the footer for good, before printing outside the logger (errors at exit).
export function closeFooter() { footerOn = false; spin = null; clear(); }

// Hide the footer while the user types an answer, and bring it back afterwards.
export function suspendFooter() { suspended = true; clear(); }
export function resumeFooter() { suspended = false; render(); }

export function startSpinner(label) {
  if (!TTY) return;
  spin = { label, detail: '', started: Date.now() };
  ensureTimer();
  render();
}

export function setSpinnerDetail(detail) {
  if (!spin) return;
  spin.detail = detail;
  render();
}

export function stopSpinner() {
  if (!spin) return;
  spin = null;
  render();
}

// Called by the logger around every printed line so the footer never gets mixed into the output.
export function beforeLog() { clear(); }
export function afterLog() { render(); }

export function setTitle(text) {
  if (TTY) process.stdout.write(`\x1b]0;${text}\x07`);
}

// ---------------------------------------------------------------- colored output
// The log file keeps the plain text. Only what the terminal shows is colored, by recognising the line.
function banner(version, rest) {
  const w = 46;
  const row = (s) => `  ${orange('║')} ${s}${' '.repeat(Math.max(0, w - 2 - visibleLength(s)))} ${orange('║')}`;
  return [
    `  ${orange(`╔${'═'.repeat(w)}╗`)}`,
    row(`${tag(' FOXRELAY ')} ${bold(version)}`),
    row(dim('Opus plans and checks. Sonnet builds.')),
    `  ${orange(`╚${'═'.repeat(w)}╝`)}`,
    rest ? `  ${dim(rest.replace(/^:\s*/, ''))}` : '',
  ].filter(Boolean).join('\n');
}

const WHO = { sonnet: cyan, opus: magenta, probe: gray };

export function paint(line) {
  if (!COLOR) return line;
  let m;

  if ((m = line.match(/^(\n?)foxrelay (\d+\.\d+\.\d+)(.*)$/))) return `${m[1]}${banner(m[2], m[3].trim())}`;

  if ((m = line.match(/^(\n?)-- (.+?) -+$/))) {
    const tone = /^Finished/.test(m[2]) ? green : /^(Stopped|The relay needs you|Paused)/i.test(m[2]) ? yellow : orange;
    return `${m[1]}${tone('══')} ${bold(tone(m[2]))} ${dim(G.rule.repeat(Math.max(4, 60 - m[2].length)))}`;
  }

  if ((m = line.match(/^Progress (.*)$/))) {
    return `${dim('Progress')} ${m[1]
      .replace(/\[(#*)(-*)\]/, (_, a, b) => colorBar(a.length, a.length + b.length, a.length + b.length))
      .replace(/(\d+%)/, (p) => bold(p))
      .replace(/now: (\S+)/, (_, x) => `now: ${cyan(bold(x))}`)
      .replace(/ {2}\| {2}/g, dim(G.sep))}`;
  }

  if ((m = line.match(/^(\s*)\[(sonnet|opus|probe)\] > (\S+)(\s*)(.*)$/))) {
    const who = (WHO[m[2]] || gray)(m[2]);
    return `${m[1]}${who} ${dim('>')} ${bold(m[3])}${m[4]}${gray(m[5])}`;
  }

  if (/^\s*(Sonnet run stopped|Opus run stopped|Model returned an error|Gave up|Error|Fatal)/.test(line)) return red(line);
  if (/^\s*(Sonnet finished round|Connection is back|Continuing|Goal finished)/.test(line)) return green(line);
  if (/Internet is down|Usage limit reached|Model not reachable|STUCK|Stopping \(Ctrl\+C\)|Stopped at the|NEEDS YOU|Parked \d+ question/.test(line)) return yellow(line);

  if (/^\n?Opus review:/.test(line)) return line.replace('Opus review:', bold(magenta('Opus review:')));
  if (/^\s*Read this first:/.test(line)) return line.replace('Read this first:', bold('Read this first:'));
  if ((m = line.match(/^(\n?)Plan: (.*)$/))) return `${m[1]}${bold('Plan:')} ${m[2].replace(/next: (\S+)/, (_, x) => `next: ${cyan(bold(x))}`)}`;
  if (/^\s*Decided on its own/.test(line)) return magenta(line);
  if ((m = line.match(/^(\s+)(project|goal|config|planner|limits|run dir|resume)(\s*):(.*)$/))) return `${m[1]}${dim(m[2] + m[3] + ':')}${m[4]}`;

  return line;
}
