// Sound, desktop notification and optional phone push. Never throws.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { IS_WIN, IS_MAC } from './util.mjs';
import { soundFile } from './sounds.mjs';

// Debug mode (used by --test-notify): run each notifier in the foreground and print what happened.
let DEBUG = false;
export function setNotifyDebug(v) { DEBUG = !!v; }

function fire(cmd, args) {
  if (DEBUG) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    console.log(`    [check] ${cmd}: exit code ${r.status}${r.error ? `, could not start: ${r.error.message}` : ''}`);
    if (r.stdout && r.stdout.trim()) console.log(`    [check] said: ${r.stdout.trim().slice(0, 600)}`);
    if (r.stderr && r.stderr.trim()) console.log(`    [check] error: ${r.stderr.trim().slice(0, 1500)}`);
    return;
  }
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* no notifier available; the terminal bell still rings */ }
}

const psq = (s) => String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ');

// Which WAV to play: the user's own file from the config, or the relay's generated loud one.
function pickWav(cfg, kind) {
  const custom = kind === 'done' ? cfg?.notify?.doneSoundFile : cfg?.notify?.alertSoundFile;
  if (custom && fs.existsSync(custom)) return custom;
  try { return soundFile(kind); } catch { return null; }
}

export function playSound(kind, cfg = {}) {
  process.stdout.write('\x07'); // terminal bell, works everywhere as a fallback
  const wav = pickWav(cfg, kind);
  const repeat = Math.max(1, Math.min(10, Number(cfg?.notify?.soundRepeat) || 2));
  if (IS_WIN) {
    const fallback = kind === 'done' ? 'C:\\Windows\\Media\\tada.wav' : 'C:\\Windows\\Media\\Alarm01.wav';
    const beeps = kind === 'done'
      ? '[console]::beep(880,200);[console]::beep(1175,200);[console]::beep(1568,350)'
      : '1..3 | % { [console]::beep(1000,300); Start-Sleep -m 150 }';
    fire('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
      `$ErrorActionPreference = 'Stop'; ` +
      `try { $p = New-Object System.Media.SoundPlayer '${psq(wav || fallback)}'; $p.Load(); 1..${repeat} | % { $p.PlaySync() }; 'played ${psq(wav || fallback)} x${repeat}' } ` +
      `catch { 'wav failed: ' + $_.Exception.Message; ` +
      `try { (New-Object System.Media.SoundPlayer '${fallback}').PlaySync(); 'played ${fallback}' } catch { 'system wav failed: ' + $_.Exception.Message; ` +
      `try { ${beeps}; 'played beeps' } catch { 'beep failed: ' + $_.Exception.Message } } }`]);
  } else if (IS_MAC) {
    const f = wav || (kind === 'done' ? '/System/Library/Sounds/Glass.aiff' : '/System/Library/Sounds/Sosumi.aiff');
    fire('sh', ['-c', `for i in $(seq ${repeat}); do afplay "${f}"; done`]);
  } else {
    const f = wav || (kind === 'done'
      ? '/usr/share/sounds/freedesktop/stereo/complete.oga'
      : '/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga');
    fire('sh', ['-c', `for i in $(seq ${repeat}); do paplay "${f}" 2>/dev/null || aplay -q "${f}"; done`]);
  }
}

export function desktopNotification(title, message) {
  if (IS_WIN) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      `$n.ShowBalloonTip(15000, '${psq(title)}', '${psq(message)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
      'Start-Sleep -Seconds 16',
      '$n.Dispose()',
    ].join('; ');
    fire('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-Command', `${script}; 'notification shown'`]);
  } else if (IS_MAC) {
    const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fire('osascript', ['-e', `display notification "${q(message)}" with title "${q(title)}"`]);
  } else {
    fire('notify-send', [title, message]);
  }
}

async function phonePush(cfg, title, message, kind) {
  const url = cfg.notify?.ntfyUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      body: message,
      headers: { Title: title, Priority: kind === 'attention' ? 'high' : 'default', Tags: kind === 'done' ? 'white_check_mark' : 'warning' },
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* phone push is best effort */ }
}

// kind: 'done' | 'attention' | 'info'
export function notify(cfg, kind, title, message) {
  const n = cfg.notify || {};
  if (n.sound !== false && kind !== 'info') playSound(kind, cfg);
  if (n.desktop !== false) desktopNotification(title, message);
  phonePush(cfg, title, message, kind);
}

// Repeats the sound until stop() is called or the time limit passes. Used as the "buzzer".
export function startBuzzer(cfg, kind) {
  const n = cfg.notify || {};
  if (n.sound === false || !n.buzzUntilAck) return () => {};
  const started = Date.now();
  const t = setInterval(() => {
    if (Date.now() - started > (n.buzzMaxMinutes || 30) * 60 * 1000) { clearInterval(t); return; }
    playSound(kind, cfg);
  }, (n.buzzIntervalSeconds || 60) * 1000);
  return () => clearInterval(t);
}
