// Generates the relay's own alert sounds as WAV files at full volume.
// System sounds on many laptops are quiet; these are made to be heard from across the room.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// A soft-clipped square-ish wave: much louder to the ear than a pure sine at the same peak.
function tone(freq, ms, gain = 0.97) {
  const n = Math.floor((RATE * ms) / 1000);
  const out = new Float32Array(n);
  const fade = Math.min(Math.floor(RATE * 0.006), Math.floor(n / 4)); // 6ms fade in/out avoids clicks
  const norm = Math.tanh(5);
  for (let i = 0; i < n; i++) {
    let v = Math.tanh(5 * Math.sin((2 * Math.PI * freq * i) / RATE)) / norm;
    if (i < fade) v *= i / fade;
    if (i > n - fade) v *= (n - i) / fade;
    out[i] = v * gain;
  }
  return out;
}

const silence = (ms) => new Float32Array(Math.floor((RATE * ms) / 1000));

function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// "done": a bright rising chime, played twice
function doneSound() {
  const chime = [tone(1047, 170), silence(40), tone(1319, 170), silence(40), tone(1568, 170), silence(40), tone(2093, 380)];
  return concat([...chime, silence(250), ...chime]);
}

// "attention": an alarm-style buzzer, two-tone, about 2.5 seconds
function alertSound() {
  const parts = [];
  for (let i = 0; i < 8; i++) { parts.push(tone(i % 2 ? 740 : 988, 220)); parts.push(silence(90)); }
  return concat(parts);
}

const VERSION = 'v1';
function soundDir() {
  const preferred = path.join(HERE, '..', 'sounds');
  try { fs.mkdirSync(preferred, { recursive: true }); fs.accessSync(preferred, fs.constants.W_OK); return preferred; } catch { /* read-only install */ }
  const tmp = path.join(os.tmpdir(), 'foxrelay-sounds');
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

// Returns the path of the WAV for this kind, creating it the first time.
export function soundFile(kind) {
  const dir = soundDir();
  const f = path.join(dir, `${kind === 'done' ? 'done' : 'alert'}-${VERSION}.wav`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, toWav(kind === 'done' ? doneSound() : alertSound()));
  return f;
}
