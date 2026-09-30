// Live terminal display: a spinner line while Claude works, a progress bar, and the window title.
// Only draws on a real terminal. Log files and pipes get plain lines.

const TTY = !!process.stdout.isTTY && !process.env.RELAY_NO_SPINNER;
const FRAMES = ['|', '/', '-', '\\'];

let spin = null; // { label, detail, started, frame, timer }

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function draw() {
  if (!spin) return;
  const cols = (process.stdout.columns || 100) - 1;
  const line = `${FRAMES[spin.frame % FRAMES.length]} ${spin.label}  ${fmtClock(Date.now() - spin.started)}${spin.detail ? `  ${spin.detail}` : ''}`;
  process.stdout.write(`\r\x1b[K${line.length > cols ? line.slice(0, cols - 1) + '~' : line}`);
}

export function startSpinner(label) {
  if (!TTY) return;
  stopSpinner();
  spin = { label, detail: '', started: Date.now(), frame: 0, timer: null };
  spin.timer = setInterval(() => { spin.frame++; draw(); }, 250);
  draw();
}

export function setSpinnerDetail(detail) {
  if (!spin) return;
  spin.detail = detail;
  draw();
}

export function stopSpinner() {
  if (!spin) return;
  clearInterval(spin.timer);
  spin = null;
  process.stdout.write('\r\x1b[K');
}

// Called by the logger around every printed line so the spinner never gets mixed into the output.
export function beforeLog() { if (spin) process.stdout.write('\r\x1b[K'); }
export function afterLog() { if (spin) draw(); }

export function setTitle(text) {
  if (TTY) process.stdout.write(`\x1b]0;${text}\x07`);
}

// [##########----------] 50%
export function bar(done, total, width = 24) {
  if (!total) return `[${'-'.repeat(width)}]`;
  const filled = Math.round((done / total) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
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
