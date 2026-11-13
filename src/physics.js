// Física inspirada en el problema RESTRINGIDO de n cuerpos (no n-cuerpos completo):
//
//  - Cuerpos masivos: un subconjunto de landmarks del rostro (contorno, ojos, cejas,
//    nariz, boca). Cada partícula del grupo ROSTRO siente sólo las K masas más cercanas
//    a su lugar en la cara → orbita alrededor de su rasgo, no del centro (si sintiera
//    todas, la suma la arrastraría al centro y el rostro colapsaría). Coste O(n·K).
//  - Atractores libres: unos pocos puntos que derivan lento por la pantalla, siempre
//    activos. Mueven al grupo FONDO (y a todas las partículas cuando no hay cara).
//  - Partículas pesadas (opcional): gravedad mutua O(H²) y todas las sienten O(n·H).
//
//  Fuerza (con softening de Plummer): a = G·m·d / (r² + ε²)^(3/2)
//  Todo en Float32Array; nada se asigna dentro de los bucles por frame.
import { CONTOUR_GROUPS } from './faceTracker.js';

/** Generador pseudoaleatorio con semilla (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nariz (no está en los contornos de MediaPipe): puente, punta, aletas, base.
const NOSE = [1, 2, 4, 5, 6, 19, 94, 168, 195, 197, 98, 327, 129, 358, 49, 279];

const lerp = (a, b, t) => a + (b - a) * t;

export class Physics {
  /**
   * @param cfg       config completo
   * @param n         número de partículas
   * @param homeIdx   Uint16Array: landmark "de origen" de cada partícula (para elegir sus masas)
   */
  constructor(cfg, n, homeIdx, w, h) {
    const F = (this.F = cfg.fisica);
    this.cfg = cfg;
    this.n = n;
    this.nActive = n; // calidad adaptativa puede reducirlo
    this.homeIdx = homeIdx;
    this.seed = F.semilla ?? (Math.random() * 2 ** 31) | 0;
    const rng = (this.rng = mulberry32(this.seed));

    // --- Grupos (asignación fija por índice, con semilla) ---
    this.faceInf = new Float32Array(n); // 0 = fondo · 1 = rostro (se interpola al intercambiar)
    this.groupTarget = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const g = rng() < F.proporcionRostro ? 1 : 0;
      this.groupTarget[i] = g;
      this.faceInf[i] = g;
    }

    // --- Cuerpos masivos: landmarks candidatos mezclados con la semilla ---
    const cand = [...new Set([...CONTOUR_GROUPS.flatMap((g) => g.edges.flatMap((e) => [e.start, e.end])), ...NOSE])];
    for (let i = cand.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [cand[i], cand[j]] = [cand[j], cand[i]];
    }
    const M = Math.min(F.masas.cantidad, cand.length);
    this.massIdx = Uint16Array.from(cand.slice(0, M));
    this.mActive = M;
    this.massX = new Float32Array(M);
    this.massY = new Float32Array(M);
    this.massGm = new Float32Array(M); // G·m·signo de cada masa (por frame)
    this.massReady = false; // las masas toman posición con la primera cara
    const K = (this.K = F.masas.cuerposPorParticula);
    this.nb = new Uint16Array(n * K); // masas que le corresponden a cada partícula
    this.nbReady = false;

    // --- Atractores libres: derivan en curvas de Lissajous lentas ---
    const A = F.atractores.cantidad;
    this.attrX = new Float32Array(A);
    this.attrY = new Float32Array(A);
    this.attrPhase = new Float32Array(A * 4); // fx, fy, φx, φy
    for (let k = 0; k < A; k++) {
      this.attrPhase[k * 4] = 0.6 + rng() * 0.8;
      this.attrPhase[k * 4 + 1] = 0.6 + rng() * 0.8;
      this.attrPhase[k * 4 + 2] = rng() * Math.PI * 2;
      this.attrPhase[k * 4 + 3] = rng() * Math.PI * 2;
    }

    // --- Partículas pesadas (opcional): salen del grupo fondo y no se intercambian ---
    this.isHeavy = new Uint8Array(n);
    const heavy = [];
    if (F.pesadas.activar) {
      for (let i = 0; i < n && heavy.length < F.pesadas.cantidad; i++) {
        if (this.groupTarget[i] === 0) {
          heavy.push(i);
          this.isHeavy[i] = 1;
        }
      }
    }
    this.heavyIdx = Uint16Array.from(heavy);
    this.heavySlot = new Int16Array(n).fill(-1); // partícula → posición en heavyIdx
    heavy.forEach((i, a) => (this.heavySlot[i] = a));
    this.hax = new Float32Array(heavy.length);
    this.hay = new Float32Array(heavy.length);

    // --- Estado por frame ---
    this.G = 0;
    this.friction = 0;
    this.retention = 1;
    this.vmax = 0;
    this.perturb = 0;
    this.gScale = 1; // signo/fuerza de G (el tritono la invierte un momento)
    this.gTotal = 0; // masa total del rostro × G (el fondo lo siente como un solo cuerpo)
    this.swaps = 0;
    this.lastSwap = 0;
    this.nFace = 0;
    this.repSlot = -1;
    // salida de accel()
    this.gx = 0;
    this.gy = 0;
    // calidad adaptativa
    this.quality = { reduced: false, lastChange: 0, lowSince: 0, note: '' };
    this.w = w;
    this.h = h;
  }

  /** Velocidad tangencial inicial aleatoria (con semilla) alrededor del centro. */
  initVelocities(x, y, vx, vy, w, h) {
    const v0 = this.F.velocidadInicial;
    for (let i = 0; i < this.n; i++) {
      const dx = x[i] - w / 2;
      const dy = y[i] - h / 2;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const s = v0 * (0.3 + 0.7 * this.rng()) * (this.rng() < 0.5 ? -1 : 1);
      vx[i] = (-dy / d) * s;
      vy[i] = (dx / d) * s;
    }
  }

  /** Asigna a cada partícula sus K masas más cercanas (con la cara actual). */
  assignNeighbors(lm) {
    const { K, nb, massIdx, homeIdx } = this;
    const M = this.mActive;
    const bestD = new Float32Array(K);
    for (let i = 0; i < this.n; i++) {
      const hx = lm[homeIdx[i] * 2];
      const hy = lm[homeIdx[i] * 2 + 1];
      bestD.fill(Infinity);
      for (let j = 0; j < M; j++) {
        const dx = lm[massIdx[j] * 2] - hx;
        const dy = lm[massIdx[j] * 2 + 1] - hy;
        const d = dx * dx + dy * dy;
        // inserción ordenada en la lista de las K mejores
        if (d >= bestD[K - 1]) continue;
        let k = K - 1;
        while (k > 0 && bestD[k - 1] > d) {
          bestD[k] = bestD[k - 1];
          nb[i * K + k] = nb[i * K + k - 1];
          k--;
        }
        bestD[k] = d;
        nb[i * K + k] = j;
      }
    }
    this.nbReady = true;
  }

  /**
   * Una vez por frame: G, fricción y perturbación según la fase; posiciones de masas
   * y atractores; repulsión intermitente; intercambio de grupos.
   * @param d     cuánto se rompe el rostro (params.disForma: fase × rotura × sonrisa)
   * @param dis   disonancia de la fase (params.dis), para el fondo
   * @param env   envolvente del pulso de tritono (0–1)
   */
  updateFrame(lm, hasFace, fw, now, d, dis, audio, env, dt) {
    const F = this.F;
    const M = this.mActive;

    // Masas: siguen a los landmarks con suavizado
    if (hasFace) {
      const k = this.massReady ? Math.pow(F.masas.suavizado, dt) : 0;
      for (let j = 0; j < M; j++) {
        const li = this.massIdx[j] * 2;
        this.massX[j] = lm[li] + (this.massX[j] - lm[li]) * k;
        this.massY[j] = lm[li + 1] + (this.massY[j] - lm[li + 1]) * k;
      }
      this.massReady = true;
      if (!this.nbReady) this.assignNeighbors(lm);
    }

    // G sube y la fricción baja con la disonancia; el volumen empuja G y la velocidad
    const vol = audio.volume;
    this.G = lerp(F.G.calma, F.G.disonancia, d) * (1 + vol * F.volumenAG);
    this.friction = lerp(F.friccion.calma, F.friccion.disonancia, d);
    this.retention = 1 - this.friction;
    this.vmax = lerp(F.velocidadMax.calma, F.velocidadMax.disonancia, d);
    this.perturb = F.perturbacion * d * (1 + audio.treble * F.frecuenciasAPerturbacion);
    // Tritono: G cambia de signo un momento (repulsión) y vuelve suavemente
    this.gScale = 1 - 2 * env * F.tritono.repulsion;

    // Repulsión parcial intermitente en la disonancia: en cada intervalo, una fracción
    // de las masas repele durante la primera mitad.
    const R = F.repulsion;
    const slot = Math.floor(now / R.intervalo);
    const on = d > 0.01 && now / R.intervalo - slot < 0.5;
    const mGbase = this.G * this.gScale * F.masas.masaPorLandmark;
    const sel = slot * 2654435761; // hash del intervalo → elige masas distintas cada vez
    for (let j = 0; j < M; j++) {
      const rep = on && ((Math.imul(j + 1, 40503) ^ sel) >>> 0) % 1000 < R.fraccion * 1000;
      this.massGm[j] = mGbase * (rep ? 1 - 2 * d * R.intensidad : 1);
    }
    this.gTotal = mGbase * M;

    // Atractores libres
    const A = F.atractores.cantidad;
    const om = (F.atractores.velocidad / Math.max(200, this.w * 0.4)) * (1 + dis * F.caosFondo * 0.5);
    for (let k = 0; k < A; k++) {
      const p = this.attrPhase;
      this.attrX[k] = this.w * (0.5 + 0.4 * Math.sin(now * om * p[k * 4] + p[k * 4 + 2]));
      this.attrY[k] = this.h * (0.5 + 0.4 * Math.sin(now * om * p[k * 4 + 1] + p[k * 4 + 3]));
    }
    this.attrGm = F.atractores.G * this.gScale * (1 + dis * F.caosFondo);

    // Intercambio rostro ↔ fondo (gradual)
    const S = F.intercambio;
    if (S.activar && now * 1000 - this.lastSwap > S.intervaloMs) {
      this.lastSwap = now * 1000;
      const k = Math.max(1, Math.round((S.proporcion * this.nActive) / 2));
      this.swapSome(1, k);
      this.swapSome(0, k);
    }
    const step = Math.min(1, dt / (60 * Math.max(0.05, S.transicion)));
    let nFace = 0;
    for (let i = 0; i < this.nActive; i++) {
      const t = this.groupTarget[i];
      const f = this.faceInf[i];
      if (f !== t) this.faceInf[i] = t ? Math.min(1, f + step) : Math.max(0, f - step);
      nFace += this.faceInf[i] > 0.5 ? 1 : 0;
    }
    this.nFace = nFace;
    this.fw = fw;
  }

  /** Pasa k partículas del grupo `from` al otro (sin tocar las pesadas). */
  swapSome(from, k) {
    for (let tries = 0, done = 0; done < k && tries < k * 20; tries++) {
      const i = (this.rng() * this.nActive) | 0;
      if (this.groupTarget[i] !== from || this.isHeavy[i]) continue;
      this.groupTarget[i] = 1 - from;
      done++;
      this.swaps++;
    }
  }

  /** Una vez por subpaso: gravedad mutua entre las pesadas (O(H²)). */
  updateHeavy(x, y) {
    const H = this.heavyIdx.length;
    if (!H) return;
    const P = this.F.pesadas;
    const e2 = P.softening * P.softening;
    const gm = P.masa * this.G * this.gScale * 0.05;
    this.hax.fill(0);
    this.hay.fill(0);
    for (let a = 0; a < H; a++) {
      const ia = this.heavyIdx[a];
      for (let b = a + 1; b < H; b++) {
        const ib = this.heavyIdx[b];
        const dx = x[ib] - x[ia];
        const dy = y[ib] - y[ia];
        const r2 = dx * dx + dy * dy + e2;
        const inv = gm / (r2 * Math.sqrt(r2));
        this.hax[a] += dx * inv;
        this.hay[a] += dy * inv;
        this.hax[b] -= dx * inv;
        this.hay[b] -= dy * inv;
      }
    }
    this.heavyGm = gm;
  }

  /**
   * Aceleración gravitatoria sobre la partícula i → this.gx, this.gy.
   * @param wi peso "rostro" de la partícula (grupo × cara detectada)
   */
  accel(i, px, py, wi, cx, cy, x, y) {
    const F = this.F;
    let ax = 0;
    let ay = 0;

    // 1) Masas del rostro que le corresponden (grupo rostro)
    if (wi > 0.02 && this.nbReady) {
      const e2 = F.masas.softening * F.masas.softening;
      const K = this.K;
      const base = i * K;
      for (let k = 0; k < K; k++) {
        const j = this.nb[base + k];
        if (j >= this.mActive) continue;
        const dx = this.massX[j] - px;
        const dy = this.massY[j] - py;
        const r2 = dx * dx + dy * dy + e2;
        const inv = (this.massGm[j] * wi) / (r2 * Math.sqrt(r2));
        ax += dx * inv;
        ay += dy * inv;
      }
    }

    // 2) El fondo siente el rostro sólo como un cuerpo, muy débil
    const bw = this.fw * (1 - this.faceInf[i]) * F.influenciaFondo;
    if (bw > 0.0005) {
      const e = F.masas.softening * 4;
      const dx = cx - px;
      const dy = cy - py;
      const r2 = dx * dx + dy * dy + e * e;
      const inv = (this.gTotal * bw) / (r2 * Math.sqrt(r2));
      ax += dx * inv;
      ay += dy * inv;
    }

    // 3) Atractores libres (siempre activos; el rostro casi no los siente)
    const aw = 1 - wi;
    if (aw > 0.02) {
      const e2 = F.atractores.softening * F.atractores.softening;
      const g = this.attrGm * aw;
      for (let k = 0; k < this.attrX.length; k++) {
        const dx = this.attrX[k] - px;
        const dy = this.attrY[k] - py;
        const r2 = dx * dx + dy * dy + e2;
        const inv = g / (r2 * Math.sqrt(r2));
        ax += dx * inv;
        ay += dy * inv;
      }
    }

    // 4) Pesadas (opcional)
    const H = this.heavyIdx.length;
    if (H) {
      if (this.isHeavy[i]) {
        const a = this.heavySlot[i];
        ax += this.hax[a];
        ay += this.hay[a];
      } else {
        const e2 = F.pesadas.softening * F.pesadas.softening;
        const g = this.heavyGm;
        for (let a = 0; a < H; a++) {
          const ih = this.heavyIdx[a];
          const dx = x[ih] - px;
          const dy = y[ih] - py;
          const r2 = dx * dx + dy * dy + e2;
          const inv = g / (r2 * Math.sqrt(r2));
          ax += dx * inv;
          ay += dy * inv;
        }
      }
    }

    this.gx = ax;
    this.gy = ay;
  }

  /**
   * Calidad adaptativa: si los FPS se mantienen bajos (`segundosBajo` seguidos) y las
   * partículas son una parte importante del costo, reduce lo que más cuesta: las masas si
   * la física es la mayor parte, si no las partículas activas (alivian física y dibujo).
   * Las caídas momentáneas (p. ej. al cargar) no cuentan.
   */
  adapt(fps, msParticulas, msFisica, now, lm) {
    const Q = this.F.calidad;
    const q = this.quality;
    if (!Q.activar) return;
    if (fps >= Q.fpsMinimo || msParticulas < Q.msMinimo) {
      q.lowSince = 0;
      return;
    }
    if (!q.lowSince) q.lowSince = now;
    if (now - q.lowSince < Q.segundosBajo) return;
    q.lowSince = now; // vuelve a esperar antes de la siguiente reducción
    this.quality.lastChange = now;
    this.quality.reduced = true;
    const physicsHeavy = msFisica > msParticulas * 0.5;
    if (physicsHeavy && this.mActive > Q.masasMinimas) {
      this.mActive = Math.max(Q.masasMinimas, Math.floor(this.mActive * 0.8));
      this.nbReady = false;
      if (this.massReady) this.assignNeighbors(lm);
      this.quality.note = `masas → ${this.mActive}`;
    } else if (this.nActive > Q.particulasMinimas) {
      this.nActive = Math.max(Q.particulasMinimas, Math.floor(this.nActive * 0.85));
      this.quality.note = `partículas → ${this.nActive}`;
    }
  }
}
