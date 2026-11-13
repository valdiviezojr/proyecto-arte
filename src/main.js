import p5 from 'p5';
import { config } from './config.js';
import { startCamera } from './camera.js';
import { FaceTracker } from './faceTracker.js';
import { AudioAnalyzer } from './audioAnalyzer.js';
import { loadCues, CueScheduler } from './midiCues.js';
import { Phases } from './phases.js';
import { ParticleSystem } from './particles.js';

p5.disableFriendlyErrors = true; // mejor rendimiento

const $ = (id) => document.getElementById(id);
const startEl = $('start');
const startBtn = $('start-btn');
const startStatus = $('start-status');
const hintEl = $('hint');
const messagesEl = $('messages');
const debugEl = $('debug');

const state = {
  audio: null,
  audioOk: false,
  tracker: null,
  cues: { events: [], source: 'ninguno', warnings: [] },
  scheduler: null,
  phases: new Phases(config),
  particles: null,
  debug: config.debugInicial,
  noFaceSince: performance.now(),
  tritonesDisparados: 0,
  fps: 0,
  msParticulas: 0,
  expr: { smile: 0, blinkL: 0, blinkR: 0, jaw: 0 }, // expresiones suavizadas
  breathPhase: 0,
};
if (import.meta.env.DEV) window.__app = state; // acceso desde la consola al desarrollar

function showError(text) {
  console.error(text);
  const el = document.createElement('div');
  el.className = 'msg';
  el.textContent = text;
  messagesEl.appendChild(el);
}

// ------------------------------------------------------------ Arranque ---
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;

  // 1) Audio (el AudioContext debe crearse dentro del clic)
  state.audio = new AudioAnalyzer(config.audio.src, {
    volumen: config.audio.volumen,
    suavizado: config.reactividad.suavizado,
  });
  startStatus.textContent = 'Cargando audio…';
  try {
    await state.audio.init();
    state.audioOk = true;
  } catch (err) {
    showError(err.message);
  }

  // 2) Cámara + detector de rostro
  startStatus.textContent = 'Iniciando cámara…';
  try {
    const video = await startCamera();
    startStatus.textContent = 'Cargando modelo de rostro…';
    const tracker = new FaceTracker(video);
    await tracker.init();
    state.tracker = tracker;
  } catch (err) {
    showError(err.message);
  }

  // 3) Tritonos (cues.json o MIDI)
  startStatus.textContent = 'Analizando tritonos…';
  state.cues = await loadCues(config);
  state.scheduler = new CueScheduler(state.cues.events);
  const avisoFases = state.phases.setTension(state.cues.tension);
  if (avisoFases) state.cues.warnings.push(avisoFases);
  for (const w of state.cues.warnings) {
    console.warn(w);
    if (w.startsWith('MIDI inválido') || w.startsWith('cues.json inválido')) showError(w);
  }

  // 4) Render y reproducción
  startEl.remove();
  new p5(sketch, $('stage'));
  if (state.audioOk) {
    state.audio.play().catch(() => {
      showError('El navegador bloqueó la reproducción: haz clic en la pantalla para iniciar el audio.');
      window.addEventListener('click', () => state.audio.play(), { once: true });
    });
  }
});

// -------------------------------------------------------------- Sketch ---
function sketch(p) {
  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.pixelDensity(1);
    p.background(0);
    state.particles = new ParticleSystem(config, p.width, p.height);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.background(0);
    state.particles.resize(p.width, p.height);
  };

  p.draw = () => {
    const now = performance.now() / 1000;
    const dt = Math.min(3, p.deltaTime / (1000 / 60));
    const t = state.audioOk ? state.audio.currentTime + config.audio.audioOffset : 0;

    // Rostro
    let hasFace = false;
    if (state.tracker) {
      state.tracker.update();
      hasFace = state.particles.setFace(state.tracker.face, state.tracker.videoSize);
    }
    updateHint(hasFace);
    updateExpressions(hasFace, dt);

    // Audio, fase y tritonos. La sonrisa sostiene la forma (no el color).
    if (state.audioOk) state.audio.update();
    const audio = state.audio || { volume: 0, treble: 0, centroid: 0 };
    const sostener = state.expr.smile * config.expresiones.sonrisa.sostenerForma;
    const params = state.phases.update(t, sostener);
    const breath = updateBreath(params, dt);
    for (const _ of state.scheduler.update(t)) {
      state.particles.triggerPulse(now);
      state.tritonesDisparados++;
    }

    const t0 = performance.now();
    state.particles.update(params, audio, hasFace, now, dt, state.expr, breath);
    state.particles.draw(p.drawingContext, params, audio, now, state.expr);
    state.msParticulas = state.msParticulas * 0.9 + (performance.now() - t0) * 0.1;

    state.fps = state.fps * 0.9 + (1000 / Math.max(1, p.deltaTime)) * 0.1;
    if (state.debug) renderDebug(t, audio);
  };
}

/** Suaviza las expresiones detectadas. Sin cara, vuelven a 0. */
function updateExpressions(hasFace, dt) {
  const E = config.expresiones;
  const raw = hasFace ? state.tracker.expr : { smile: 0, blinkL: 0, blinkR: 0, jaw: 0 };
  const S = E.sonrisa;
  const smile = Math.min(1, Math.max(0, (raw.smile - S.minimo) / (S.maximo - S.minimo)));
  const ease = (prev, v, k) => v + (prev - v) * Math.pow(k, dt);
  const e = state.expr;
  e.smile = ease(e.smile, smile, S.suavizado);
  e.blinkL = ease(e.blinkL, raw.blinkL, E.parpadeo.suavizado);
  e.blinkR = ease(e.blinkR, raw.blinkR, E.parpadeo.suavizado);
  e.jaw = ease(e.jaw, raw.jaw, E.boca.suavizado);
}

/** Respiración: escala del rostro al pulso de la pieza (más rápida en la disonancia). */
function updateBreath(params, dt) {
  const B = config.respiracion;
  const bpm = state.cues.tempo;
  const period = bpm ? (60 / bpm) * 4 * B.compases : B.segundosRespaldo;
  const speed = 1 + params.dis * B.aceleracionDisonancia;
  state.breathPhase += ((TWO_PI * dt) / 60 / period) * speed;
  return 1 + B.amplitud * Math.sin(state.breathPhase);
}
const TWO_PI = Math.PI * 2;

function updateHint(hasFace) {
  const now = performance.now();
  if (hasFace) state.noFaceSince = now;
  let text = '';
  if (!state.tracker) text = '';
  else if (!hasFace && now - state.noFaceSince > config.cara.segundosSinCaraParaAviso * 1000) {
    text = 'No se detecta un rostro · acércate a la cámara';
  }
  if (hintEl.textContent !== text && text) hintEl.textContent = text;
  hintEl.classList.toggle('hidden', !text);
}

function renderDebug(t, audio) {
  const next = state.scheduler.next;
  const lines = [
    `fase        ${state.phases.nombreFase}  (color ${(state.phases.mezclaDisonancia * 100).toFixed(0)}% · forma ${(state.phases.mezclaForma * 100).toFixed(0)}%)`,
    `tiempo      ${t.toFixed(2)} s${state.audioOk ? '' : '  (sin audio)'}`,
    `fases       ${state.phases.modo}: ${state.phases.fases.map((f) => `${f.nombre} ${f.inicio.toFixed(1)}s`).join(' → ')}`,
    state.phases.modo === 'auto' ? `tensión     ${state.phases.tensionActual.toFixed(2)}` : null,
    `offset      ${config.audio.audioOffset} s`,
    `fps         ${state.fps.toFixed(0)}  (partículas ${state.msParticulas.toFixed(1)} ms/frame)`,
    `caras       ${state.tracker ? state.tracker.numFaces : 'sin cámara'}`,
    `expresión   sonrisa ${state.expr.smile.toFixed(2)}  parpadeo ${state.expr.blinkL.toFixed(2)}/${state.expr.blinkR.toFixed(2)}  boca ${state.expr.jaw.toFixed(2)}`,
    `respiración ${state.cues.tempo ? `${state.cues.tempo.toFixed(1)} bpm · cada ${config.respiracion.compases} compases` : `${config.respiracion.segundosRespaldo} s`}`,
    `partículas  ${state.particles.n}`,
    `tritonos    ${state.cues.events.length} (fuente: ${state.cues.source}) · disparados ${state.tritonesDisparados}`,
    `próximo     ${next ? next.t.toFixed(2) + ' s' : '—'}`,
    `volumen     ${audio.volume.toFixed(2)}  centroide ${audio.centroid.toFixed(2)}  agudos ${audio.treble.toFixed(2)}`,
  ];
  for (const w of state.cues.warnings) lines.push(`aviso       ${w}`);
  debugEl.textContent = lines.filter(Boolean).join('\n');
}

// ------------------------------------------------------------- Teclado ---
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (key === 'd') {
    state.debug = !state.debug;
    debugEl.classList.toggle('hidden', !state.debug);
  } else if (key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});
debugEl.classList.toggle('hidden', !state.debug);
