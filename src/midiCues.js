// Eventos de tritono: desde cues.json (prioridad) o detectados en el .mid.
import tonejsMidi from '@tonejs/midi';

const { Midi } = tonejsMidi;

/** fetch que trata la respuesta HTML de fallback de Vite como "no existe". */
async function fetchIfExists(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) return null;
  return res;
}

/**
 * Busca pares de notas simultáneas (o solapadas) separadas por 6 semitonos
 * (módulo 12). Devuelve tiempos ordenados sin duplicados dentro de `ventana`.
 */
export function detectTritones(midi, { ventana = 0.6, solapamientoMinimo = 0.03 } = {}) {
  const notes = [];
  for (const track of midi.tracks) {
    if (track.channel === 9) continue; // percusión
    for (const n of track.notes) {
      notes.push({ p: n.midi, start: n.time, end: n.time + n.duration });
    }
  }
  notes.sort((a, b) => a.start - b.start);

  const times = [];
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    for (let j = i + 1; j < notes.length && notes[j].start < a.end; j++) {
      const b = notes[j];
      const overlap = Math.min(a.end, b.end) - b.start;
      if (overlap < solapamientoMinimo) continue;
      if (Math.abs(a.p - b.p) % 12 === 6) times.push(b.start);
    }
  }
  times.sort((x, y) => x - y);

  const events = [];
  let last = -Infinity;
  for (const t of times) {
    if (t - last >= ventana) {
      events.push({ t, tipo: 'tritono' });
      last = t;
    }
  }
  return events;
}

// Rugosidad aproximada de cada intervalo (en semitonos, módulo 12):
// 2ª menor, 7ª mayor y tritono son los más disonantes; unísono, 5ª y 4ª, los más estables.
const ROUGHNESS = [0, 1, 0.6, 0.15, 0.1, 0.05, 0.8, 0, 0.15, 0.1, 0.5, 0.9];
const STEP = 0.1; // s entre muestras de la curva

// Envolvente causal: sólo mira hacia atrás, así la tensión nunca se adelanta a la música.
// Sube con constante `ataque` (s) cuando aparece disonancia y baja con `relajacion` (s).
function envelope(arr, ataque, relajacion) {
  const ka = 1 - Math.exp(-STEP / Math.max(0.01, ataque));
  const kr = 1 - Math.exp(-STEP / Math.max(0.01, relajacion));
  const out = new Float32Array(arr.length);
  let e = 0;
  for (let i = 0; i < arr.length; i++) {
    e += (arr[i] - e) * (arr[i] > e ? ka : kr);
    out[i] = e;
  }
  return out;
}

function normalize(arr) {
  let hi = 0;
  for (const v of arr) if (v > hi) hi = v;
  return arr.map((v) => v / (hi || 1));
}

/**
 * Curvas de tensión de la pieza (0–1), muestreadas cada 0.1 s, a partir de la
 * rugosidad media de los intervalos que suenan juntos × (0.5 + 0.5·intensidad):
 *   - curva: envolvente lenta → fases y color (la atmósfera general)
 *   - forma: envolvente rápida → rotura del rostro (sigue a la música casi al instante)
 */
export function analyzeTension(midi, fasesAuto = {}, rotura = {}) {
  const { ataque = 1.5, relajacion = 5 } = fasesAuto;
  const notes = [];
  for (const track of midi.tracks) {
    if (track.channel === 9) continue;
    for (const n of track.notes) notes.push({ p: n.midi, s: n.time, e: n.time + n.duration, v: n.velocity });
  }
  const n = Math.ceil(midi.duration / STEP) + 1;
  const rough = new Float32Array(n);
  const vel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * STEP;
    const on = notes.filter((x) => x.s <= t && x.e > t);
    let sum = 0;
    let pairs = 0;
    let maxV = 0;
    for (let a = 0; a < on.length; a++) {
      if (on[a].v > maxV) maxV = on[a].v;
      for (let b = a + 1; b < on.length; b++) {
        sum += ROUGHNESS[Math.abs(on[a].p - on[b].p) % 12];
        pairs++;
      }
    }
    rough[i] = pairs ? sum / pairs : 0;
    vel[i] = maxV;
  }
  const raw = rough.map((r, i) => r * (0.5 + 0.5 * vel[i]));
  return {
    step: STEP,
    curva: normalize(envelope(raw, ataque, relajacion)),
    forma: normalize(envelope(raw, rotura.ataque ?? 0.2, rotura.relajacion ?? 1)),
  };
}

/** Lee una curva de tensión en el tiempo t (interpolación lineal). */
export function sampleCurve(curve, step, t) {
  const x = t / step;
  const i = Math.floor(x);
  if (i < 0) return curve[0];
  if (i >= curve.length - 1) return curve[curve.length - 1];
  return curve[i] + (curve[i + 1] - curve[i]) * (x - i);
}

/**
 * Carga los eventos. Devuelve { events, source, warnings[], tension, tempo, notes }.
 * source: 'cues.json' | 'midi' | 'ninguno'
 */
export async function loadCues(cfg) {
  const warnings = [];
  let tension = null;
  let tempo = null; // BPM (para la respiración)
  let notes = []; // { t, p (altura MIDI), v (intensidad), dur } para los destellos

  // MIDI: fuente de tritonos y de la curva de tensión (fases automáticas)
  let midi = null;
  let midiError = null;
  const midiRes = await fetchIfExists(cfg.audio.midi);
  if (midiRes) {
    try {
      midi = new Midi(await midiRes.arrayBuffer());
      tension = analyzeTension(midi, cfg.fasesAuto, cfg.rotura);
      tempo = midi.header.tempos[0]?.bpm || null;
      notes = midi.tracks
        .filter((tr) => tr.channel !== 9)
        .flatMap((tr) => tr.notes.map((n) => ({ t: n.time, p: n.midi, v: n.velocity, dur: n.duration })))
        .sort((a, b) => a.t - b.t);
    } catch (err) {
      midiError = err;
    }
  }

  // 1) Respaldo manual: cues.json
  const cuesRes = await fetchIfExists(cfg.audio.cues);
  if (cuesRes) {
    try {
      const data = await cuesRes.json();
      if (!Array.isArray(data)) throw new Error('no es un array');
      const events = data
        .filter((e) => typeof e?.t === 'number')
        .map((e) => ({ t: e.t, tipo: e.tipo || 'tritono' }))
        .sort((a, b) => a.t - b.t);
      if (midiError) warnings.push(`MIDI inválido (${midiError.message}). Fases en modo manual.`);
      return { events, source: 'cues.json', warnings, tension, tempo, notes };
    } catch (err) {
      warnings.push(`cues.json inválido (${err.message}); se intenta con el MIDI.`);
    }
  }

  // 2) Detección automática en el .mid
  if (midiError) {
    warnings.push(`MIDI inválido (${midiError.message}). Sin pulsos de tritono.`);
    return { events: [], source: 'ninguno', warnings, tension: null, tempo: null, notes: [] };
  }
  if (midi) {
    const events = detectTritones(midi, {
      ventana: cfg.tritono.ventanaAntiDuplicados,
      solapamientoMinimo: cfg.tritono.solapamientoMinimo,
    });
    if (events.length === 0) warnings.push('El MIDI no contiene tritonos.');
    return { events, source: 'midi', warnings, tension, tempo, notes };
  }

  warnings.push('No hay MIDI ni cues.json: la obra sigue sin pulsos de tritono.');
  return { events: [], source: 'ninguno', warnings, tension: null, tempo: null, notes: [] };
}

/**
 * Recorre una lista de eventos { t, … } en orden y avisa cuáles se cruzaron en este
 * frame (se usa para los tritonos y para las notas).
 */
export class CueScheduler {
  constructor(events) {
    this.events = events;
    this.index = 0;
    this.lastTime = -Infinity;
  }

  /** Devuelve los eventos cuyo tiempo se alcanzó desde el frame anterior. */
  update(time) {
    // Si el tiempo retrocede (reinicio), reposicionar el índice.
    if (time < this.lastTime - 0.25) {
      this.index = this.events.findIndex((e) => e.t >= time);
      if (this.index < 0) this.index = this.events.length;
    }
    this.lastTime = time;
    const fired = [];
    while (this.index < this.events.length && this.events[this.index].t <= time) {
      const e = this.events[this.index++];
      if (time - e.t < 0.5) fired.push(e); // ignora eventos muy atrasados (p. ej. tras un salto)
    }
    return fired;
  }

  get next() {
    return this.events[this.index] || null;
  }
}
