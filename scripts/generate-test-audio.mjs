// Genera audio y MIDI de PRUEBA (60 s) mientras llega la pieza real:
//   0–20 s  CALMA       acordes consonantes suaves (sin tritonos)
//   20–40 s DISONANCIA  clusters de semitonos + tritonos marcados + ruido
//   40–60 s CALMA       vuelve a los acordes suaves
// Salida: public/audio/pieza.mid y public/audio/pieza.mp3 (vía ffmpeg; si no hay
// ffmpeg deja pieza.wav y hay que cambiar `config.audio.src`).
//
// Uso: npm run generar-audio-prueba
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tonejsMidi from '@tonejs/midi';

const { Midi } = tonejsMidi;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/audio');
mkdirSync(outDir, { recursive: true });

const SR = 44100;
const DURATION = 60;

// ---------- Partitura (notas MIDI) ----------
// Cada nota: { midi, time, duration, velocity, voice }
const notes = [];
const add = (midi, time, duration, velocity, voice) =>
  notes.push({ midi, time, duration, velocity, voice });

// Calma: progresión sin tritonos (Cmaj7 – Am7 – Fmaj7 – Gsus2), 4 s por acorde.
const calmChords = [
  [48, 55, 64, 71], // C G E B
  [45, 52, 60, 67], // A E C G
  [41, 48, 57, 64], // F C A E
  [43, 50, 55, 57], // G D G A (sus2, sin Fa)
];
function calmSection(start, end) {
  let i = 0;
  for (let t = start; t < end - 0.01; t += 4, i++) {
    for (const m of calmChords[i % calmChords.length]) add(m, t, Math.min(4.2, end - t), 0.45, 'pad');
    // pequeña melodía consonante
    add(72 + [0, 4, 7, 4][i % 4], t + 1, 1.5, 0.35, 'pad');
    add(72 + [7, 9, 5, 2][i % 4], t + 2.5, 1.3, 0.3, 'pad');
  }
}
calmSection(0, 20);
calmSection(40, 60);

// Disonancia: tritonos (pares a 6 semitonos) separados de los clusters.
const tritones = [
  [21.0, 47, 53], // Si–Fa
  [23.5, 48, 54], // Do–Fa#
  [26.0, 59, 65], // Si–Fa (octava arriba)
  [28.5, 52, 58], // Mi–Sib
  [31.0, 47, 53], // Si–Fa
  [33.5, 50, 56], // Re–Lab
  [36.0, 59, 65], // Si–Fa
  [38.0, 47, 53], // Si–Fa
];
for (const [t, a, b] of tritones) {
  add(a, t, 1.0, 0.95, 'harsh');
  add(b, t, 1.0, 0.95, 'harsh');
  add(a + 12, t, 0.8, 0.7, 'harsh');
}
// Clusters de semitonos (Do–Do#–Re): disonantes pero SIN tritono.
// Sólo suenan en los huecos entre tritonos para no crear tritonos accidentales.
for (let t = 20; t < 40; t += 0.25) {
  const busy = tritones.some(([tt]) => t >= tt - 0.3 && t < tt + 1.1);
  if (busy) continue;
  const base = 60 + (Math.floor(t * 4) % 2 ? 0 : 12);
  for (const m of [base, base + 1, base + 2]) add(m, t, 0.18, 0.6, 'harsh');
}

// ---------- MIDI ----------
const midi = new Midi();
midi.header.setTempo(120);
midi.name = 'Sonrisa en Tritono — prueba';
const track = midi.addTrack();
track.name = 'prueba';
for (const n of notes) {
  track.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity });
}
writeFileSync(join(outDir, 'pieza.mid'), Buffer.from(midi.toArray()));

// ---------- Síntesis ----------
const buf = new Float32Array(SR * DURATION);
const freq = (m) => 440 * 2 ** ((m - 69) / 12);

for (const n of notes) {
  const f = freq(n.midi);
  const start = Math.floor(n.time * SR);
  const len = Math.floor(n.duration * SR);
  const harsh = n.voice === 'harsh';
  const attack = harsh ? 0.005 : 0.6;
  const release = harsh ? 0.08 : 1.2;
  const harmonics = harsh ? 8 : 2;
  const amp = n.velocity * (harsh ? 0.07 : 0.06);
  const total = len + Math.floor(release * SR);
  for (let i = 0; i < total; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    let env = Math.min(1, t / attack);
    if (i > len) env *= Math.max(0, 1 - (i - len) / (release * SR));
    if (harsh) env *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 13 * t); // trémolo
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      s += Math.sin(2 * Math.PI * f * h * t + (harsh ? h * 0.3 : 0)) / (harsh ? h : h * h);
    }
    buf[idx] += s * env * amp;
  }
}

// Ruido filtrado en la disonancia (crece hacia el centro de la sección).
let lp = 0;
for (let i = 20 * SR; i < 40 * SR; i++) {
  const t = i / SR;
  const shape = Math.sin(Math.PI * ((t - 20) / 20)); // 0 → 1 → 0
  lp += 0.25 * ((Math.random() * 2 - 1) - lp);
  buf[i] += lp * 0.12 * shape;
}

// Normalizar
let peak = 0;
for (const v of buf) peak = Math.max(peak, Math.abs(v));
const gain = 0.89 / (peak || 1);

// WAV 16-bit mono
const data = Buffer.alloc(buf.length * 2);
for (let i = 0; i < buf.length; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * gain)) * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
const wavPath = join(outDir, 'pieza.wav');
writeFileSync(wavPath, Buffer.concat([header, data]));

try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-b:a', '192k', join(outDir, 'pieza.mp3')]);
  unlinkSync(wavPath);
  console.log('Generados: public/audio/pieza.mp3 y public/audio/pieza.mid');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('ffmpeg no disponible: se generó public/audio/pieza.wav y public/audio/pieza.mid');
  console.log("Cambia config.audio.src a '/audio/pieza.wav' o convierte el wav a mp3.");
}
console.log(`Tritonos en la partitura de prueba: ${tritones.map(([t]) => t).join(', ')} s`);
