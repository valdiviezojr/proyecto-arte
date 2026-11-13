// Sistema de partículas: física en arrays tipados + dibujo por lotes de color
// sobre el canvas 2D de p5 (drawingContext) para sostener ~4000 partículas.
// La mayoría se dibuja como puntos simples (barato); una fracción, las más grandes,
// lleva halo suave y titileo (sprite de gradiente radial), que es lo que más se ve.
import { CONTOUR_GROUPS, REGION, TESSELATION } from './faceTracker.js';
import { hexToRgb } from './phases.js';

const TAU = Math.PI * 2;
const COLOR_BUCKETS = 32;
const NUM_LANDMARKS = 478;
const SPRITE = 32; // px del sprite de cada color

// Aristas de los contornos con su región (ojos/boca/resto)
const CONTOUR_EDGES = CONTOUR_GROUPS.flatMap((g) => g.edges.map((e) => ({ ...e, region: g.region })));
// Landmarks de cada región, para calcular su centro en cada frame
const regionLandmarks = (region) => [
  ...new Set(CONTOUR_EDGES.filter((e) => e.region === region).flatMap((e) => [e.start, e.end])),
];
const REGION_LANDMARKS = {
  [REGION.OJO_IZQ]: regionLandmarks(REGION.OJO_IZQ),
  [REGION.OJO_DER]: regionLandmarks(REGION.OJO_DER),
  [REGION.BOCA]: regionLandmarks(REGION.BOCA),
};

export class ParticleSystem {
  constructor(cfg, width, height) {
    this.cfg = cfg;
    this.resize(width, height);
    const n = (this.n = cfg.particulas.cantidad);

    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.edgeA = new Uint16Array(n);
    this.edgeB = new Uint16Array(n);
    this.u = new Float32Array(n);
    this.ox = new Float32Array(n);
    this.oy = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.colorT = new Float32Array(n);
    this.region = new Uint8Array(n);
    this.sizeMul = new Float32Array(n);
    this.twinkleRate = new Float32Array(n);
    this.halo = new Uint8Array(n); // 1 = se dibuja con halo
    this.bucket = new Uint16Array(n);
    this.order = new Uint16Array(n);

    // Cada partícula vive en un punto de una arista de la malla del rostro.
    const P = cfg.particulas;
    for (let i = 0; i < n; i++) {
      const list = Math.random() < P.proporcionContornos ? CONTOUR_EDGES : TESSELATION;
      const e = list[(Math.random() * list.length) | 0];
      this.edgeA[i] = e.start;
      this.edgeB[i] = e.end;
      this.region[i] = e.region || REGION.NINGUNA;
      // Puntos simples: tamaños chicos variados. Con halo: los más grandes.
      this.halo[i] = Math.random() < P.fraccionHalo ? 1 : 0;
      const sz = this.halo[i] ? 0.35 + 0.65 * Math.random() ** 2 : 0.5 * Math.random() ** 2;
      this.sizeMul[i] = P.tamanoMin + (P.tamanoMax - P.tamanoMin) * sz;
      this.twinkleRate[i] = 0.5 + Math.random();
      this.u[i] = Math.random();
      const a = Math.random() * TAU;
      const r = Math.random() * cfg.particulas.dispersionLocal;
      this.ox[i] = Math.cos(a) * r;
      this.oy[i] = Math.sin(a) * r;
      this.seed[i] = Math.random();
      this.colorT[i] = Math.random();
      this.x[i] = Math.random() * this.w;
      this.y[i] = Math.random() * this.h;
    }

    this.lm = new Float32Array(NUM_LANDMARKS * 2); // landmarks proyectados a pantalla
    this.faceWeight = 0; // 0 = libre, 1 = pegadas al rostro
    this.frame = null; // encuadre suavizado del rostro
    this.center = { x: this.w / 2, y: this.h / 2 };
    this.flowTime = 0;
    this.pulse = { active: false, start: 0, env: 0, flash: 0 };
    this.flash = hexToRgb(cfg.tritono.destello);
    this.smileColor = hexToRgb(cfg.expresiones.sonrisa.colorCalma);
    // Centros (en pantalla) de ojos y boca
    this.regionCenter = {
      [REGION.OJO_IZQ]: { x: 0, y: 0 },
      [REGION.OJO_DER]: { x: 0, y: 0 },
      [REGION.BOCA]: { x: 0, y: 0 },
    };
    // Un sprite (punto con halo) por color
    this.bucketColors = Array.from({ length: COLOR_BUCKETS }, () => 'rgb(0,0,0)');
    this.sprites = Array.from({ length: COLOR_BUCKETS }, () => {
      const c = document.createElement('canvas');
      c.width = c.height = SPRITE;
      return c;
    });
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  /** Proyecta los landmarks normalizados de la cámara al espacio de pantalla. */
  setFace(landmarks, videoSize) {
    if (!landmarks) return false;
    const { w: vw, h: vh } = videoSize;
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const f = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hPx: Math.max(1, (maxY - minY) * vh) };
    const k = this.cfg.cara.suavizado;
    if (!this.frame) this.frame = f;
    else {
      this.frame.cx = this.frame.cx * k + f.cx * (1 - k);
      this.frame.cy = this.frame.cy * k + f.cy * (1 - k);
      this.frame.hPx = this.frame.hPx * k + f.hPx * (1 - k);
    }
    const { cx, cy, hPx } = this.frame;
    const mirror = this.cfg.cara.espejo ? -1 : 1;
    const follow = this.cfg.cara.seguimiento;
    const scale = (this.cfg.cara.alturaEnPantalla * this.h) / hPx;
    const camX = this.cfg.cara.espejo ? 1 - cx : cx;
    const sx = this.w / 2 + (camX - 0.5) * this.w * follow;
    const sy = this.h / 2 + (cy - 0.5) * this.h * follow;
    const count = Math.min(NUM_LANDMARKS, landmarks.length);
    for (let i = 0; i < count; i++) {
      this.lm[i * 2] = sx + (landmarks[i].x - cx) * vw * scale * mirror;
      this.lm[i * 2 + 1] = sy + (landmarks[i].y - cy) * vh * scale;
    }
    this.center.x = sx;
    this.center.y = sy;
    for (const [region, idx] of Object.entries(REGION_LANDMARKS)) {
      let ax = 0;
      let ay = 0;
      for (const i of idx) {
        ax += this.lm[i * 2];
        ay += this.lm[i * 2 + 1];
      }
      this.regionCenter[region].x = ax / idx.length;
      this.regionCenter[region].y = ay / idx.length;
    }
    return true;
  }

  /** Dispara el pulso de tritono: explosión radial + onda + destello. */
  triggerPulse(now) {
    const c = this.cfg.tritono;
    this.pulse.active = true;
    this.pulse.start = now;
    const { x: cx, y: cy } = this.center;
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - cx;
      const dy = this.y[i] - cy;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const f = (c.intensidad * (0.4 + this.seed[i] * 0.9)) / (1 + d / 450);
      this.vx[i] += (dx / d) * f;
      this.vy[i] += (dy / d) * f;
    }
  }

  /**
   * @param params  parámetros de fase interpolados (phases.js)
   * @param audio   { volume, treble, centroid }
   * @param hasFace si hay rostro detectado este frame
   * @param now     segundos (performance.now()/1000)
   * @param dt      factor de tiempo (1 = 60 fps)
   * @param expr    expresiones suavizadas { smile, blinkL, blinkR, jaw } (0–1)
   * @param breath  escala de respiración del rostro (≈1)
   */
  update(params, audio, hasFace, now, dt, expr, breath = 1) {
    const cfg = this.cfg;
    const R = cfg.reactividad;
    const free = cfg.particulas.libre;

    // Atracción a la cara: aparece/desaparece suavemente
    const fk = 1 - Math.pow(1 - cfg.particulas.suavizadoCara, dt);
    this.faceWeight += ((hasFace ? 1 : 0) - this.faceWeight) * fk;
    const fw = this.faceWeight;
    if (fw < 0.01) {
      this.center.x += (this.w / 2 - this.center.x) * 0.02;
      this.center.y += (this.h / 2 - this.center.y) * 0.02;
    }

    // Envolvente del pulso
    const P = cfg.tritono;
    let env = 0;
    let flash = 0;
    let ringR = -1;
    if (this.pulse.active) {
      const el = now - this.pulse.start;
      if (el >= P.duracion) this.pulse.active = false;
      else {
        env = Math.pow(1 - el / P.duracion, 2);
        flash = Math.pow(1 - el / P.duracion, 6); // el destello decae más rápido
        ringR = el * P.velocidadOnda;
      }
    }
    this.pulse.env = env;
    this.pulse.flash = flash;

    // Parámetros efectivos (fase × audio × cara/libre)
    const vol = audio.volume;
    const energy = 1 + vol * R.volumenAVelocidad;
    const lerp = (a, b, t) => a + (b - a) * t;
    const freeBoost = 1 + params.disForma * 2;
    const attr = params.atraccion * fw;
    const damp = Math.pow(lerp(free.amortiguacion, params.amortiguacion, fw), dt);
    const noiseF = lerp(free.ruido * freeBoost, params.ruido, fw) * energy;
    const vmax = lerp(free.velocidadMax * freeBoost, params.velocidadMax, fw) * energy;
    const jitter = (params.temblor * fw + env * P.distorsion) * Math.sqrt(dt);
    const disp = params.dispersion + audio.treble * R.agudosADispersion * params.disForma;
    const distortScale = (1 + env * 0.25) * breath;
    // Expresiones: ojos y boca reflejan al espectador
    const E = cfg.expresiones;
    const eyeL = 1 - expr.blinkL * E.parpadeo.cierre;
    const eyeR = 1 - expr.blinkR * E.parpadeo.cierre;
    const mouthW = 1 + expr.smile * E.boca.anchoSonrisa;
    const mouthH = 1 + expr.jaw * E.boca.apertura;
    const attrRasgos = attr * E.atraccionRasgos;
    // "Sonrisa forzada": la boca tiembla si sonríes durante la disonancia
    const mouthJitter = expr.smile * params.dis * E.sonrisa.temblorBoca * fw * Math.sqrt(dt);
    const RC = this.regionCenter;
    this.flowTime += params.velocidadRuido * energy * dt * 0.016;
    const ft = this.flowTime;

    const { x, y, vx, vy, lm, edgeA, edgeB, u, ox, oy, seed, region } = this;
    const cx = this.center.x;
    const cy = this.center.y;
    const w = this.w;
    const h = this.h;
    const ringW = P.grosorOnda;
    const ringF = P.intensidad * 0.12 * env;

    for (let i = 0; i < this.n; i++) {
      let ax = 0;
      let ay = 0;
      const px = x[i];
      const py = y[i];
      const s = seed[i];

      if (attr > 0) {
        const a = edgeA[i] * 2;
        const b = edgeB[i] * 2;
        const t = u[i];
        let tx = lm[a] + (lm[b] - lm[a]) * t + ox[i];
        let ty = lm[a + 1] + (lm[b + 1] - lm[a + 1]) * t + oy[i];
        const r = region[i];
        if (r === REGION.OJO_IZQ) {
          ty = RC[r].y + (ty - RC[r].y) * eyeL; // parpadeo
        } else if (r === REGION.OJO_DER) {
          ty = RC[r].y + (ty - RC[r].y) * eyeR;
        } else if (r === REGION.BOCA) {
          tx = RC[r].x + (tx - RC[r].x) * mouthW; // sonrisa
          ty = RC[r].y + (ty - RC[r].y) * mouthH; // boca abierta
        }
        // Dispersión: empuja el objetivo hacia afuera del centro del rostro
        // (también aplica la respiración y la distorsión del pulso)
        const k = distortScale * (1 + disp * (0.3 + s * 1.4));
        tx = cx + (tx - cx) * k + ox[i] * disp * 25;
        ty = cy + (ty - cy) * k + oy[i] * disp * 25;
        const at = r === REGION.NINGUNA ? attr : attrRasgos;
        ax += (tx - px) * at;
        ay += (ty - py) * at;
        if (r === REGION.BOCA && mouthJitter > 0) {
          ax += (Math.random() - 0.5) * 2 * mouthJitter;
          ay += (Math.random() - 0.5) * 2 * mouthJitter;
        }
      }

      // Campo de flujo (ruido barato con senos)
      const ang =
        (Math.sin(px * 0.0031 + ft * 1.3 + s * 2.0) +
          Math.sin(py * 0.0037 - ft * 0.9) +
          Math.sin((px + py) * 0.0017 + ft * 0.5)) * Math.PI;
      ax += Math.cos(ang) * noiseF;
      ay += Math.sin(ang) * noiseF;

      if (jitter > 0) {
        ax += (Math.random() - 0.5) * 2 * jitter;
        ay += (Math.random() - 0.5) * 2 * jitter;
      }

      // Onda expansiva del tritono
      if (ringR >= 0) {
        const dx = px - cx;
        const dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const off = Math.abs(d - ringR);
        if (off < ringW) {
          const f = ringF * (1 - off / ringW);
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
      }

      let nvx = vx[i] * damp + ax * dt;
      let nvy = vy[i] * damp + ay * dt;
      const sp = Math.sqrt(nvx * nvx + nvy * nvy);
      // Permite superar vmax justo tras la explosión (env alto)
      const lim = vmax + env * P.intensidad * 1.5;
      if (sp > lim) {
        nvx = (nvx / sp) * lim;
        nvy = (nvy / sp) * lim;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      let nx = px + nvx * dt;
      let ny = py + nvy * dt;
      // Sin cara: si sale de la pantalla reaparece en un punto al azar
      // (envolver los bordes atrapaba partículas en la costura del campo de flujo)
      if (fw < 0.5 && (nx < 0 || nx > w || ny < 0 || ny > h)) {
        nx = Math.random() * w;
        ny = Math.random() * h;
        vx[i] *= 0.2;
        vy[i] *= 0.2;
      }
      x[i] = nx;
      y[i] = ny;
    }
  }

  /** Redibuja el sprite (punto + halo) de un color. */
  paintSprite(canvas, r, g, b) {
    const c = canvas.getContext('2d');
    const h = SPRITE / 2;
    c.clearRect(0, 0, SPRITE, SPRITE);
    const grad = c.createRadialGradient(h, h, 0, h, h, h);
    // núcleo un poco más claro que el color, halo que se desvanece
    const lr = Math.round(r + (255 - r) * 0.35);
    const lg = Math.round(g + (255 - g) * 0.35);
    const lb = Math.round(b + (255 - b) * 0.35);
    grad.addColorStop(0, `rgba(${lr},${lg},${lb},1)`);
    grad.addColorStop(0.18, `rgba(${r},${g},${b},0.9)`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.22)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = grad;
    c.fillRect(0, 0, SPRITE, SPRITE);
  }

  draw(ctx, params, audio, now, expr) {
    const R = this.cfg.reactividad;
    const P = this.cfg.tritono;
    const PA = this.cfg.particulas;
    const S = this.cfg.expresiones.sonrisa;
    const env = this.pulse.env;

    // Fondo con estela
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, params.estela + env * 0.15)})`;
    ctx.fillRect(0, 0, this.w, this.h);

    // Colores por lote: paleta interpolada + desplazamiento por frecuencia
    // + calidez de la sonrisa (sólo en la calma) + destello del tritono
    const pal = params.paleta;
    const nc = pal.length;
    const shift = audio.centroid * R.frecuenciaAColor;
    const flashK = Math.min(1, this.pulse.flash * P.intensidadDestello);
    const calm = 1 - params.dis;
    const smileK = expr.smile * S.brilloCalma * calm * this.faceWeight;
    for (let b = 0; b < COLOR_BUCKETS; b++) {
      const pos = ((b + 0.5) / COLOR_BUCKETS) * nc;
      const i0 = Math.floor(pos) % nc;
      const i1 = (i0 + 1) % nc;
      const f = pos - Math.floor(pos);
      const c = [0, 1, 2].map((j) => {
        let v = pal[i0][j] + (pal[i1][j] - pal[i0][j]) * f;
        v += (this.smileColor[j] - v) * smileK;
        return Math.round(v + (this.flash[j] - v) * flashK);
      });
      this.paintSprite(this.sprites[b], c[0], c[1], c[2]);
      this.bucketColors[b] = `rgb(${c[0]},${c[1]},${c[2]})`;
    }

    // Agrupar partículas por color (counting sort)
    const counts = new Uint32Array(COLOR_BUCKETS + 1);
    for (let i = 0; i < this.n; i++) {
      let t = this.colorT[i] + shift;
      t -= Math.floor(t);
      const b = Math.min(COLOR_BUCKETS - 1, (t * COLOR_BUCKETS) | 0);
      this.bucket[i] = b;
      counts[b + 1]++;
    }
    for (let b = 0; b < COLOR_BUCKETS; b++) counts[b + 1] += counts[b];
    const starts = counts.slice();
    for (let i = 0; i < this.n; i++) this.order[starts[this.bucket[i]]++] = i;

    const size =
      params.tamano *
      (1 + audio.volume * R.volumenATamano) *
      (1 + env * 0.6) *
      (1 + expr.smile * S.tamanoCalma * calm * this.faceWeight);
    const tw = PA.titileo * 0.5;
    const twSpeed = PA.velocidadTitileo * TAU * now;
    ctx.globalCompositeOperation = 'lighter';
    for (let b = 0; b < COLOR_BUCKETS; b++) {
      const from = counts[b];
      const to = counts[b + 1];
      if (from === to) continue;
      // Puntos simples (en un solo trazo por color)
      ctx.globalAlpha = Math.min(1, PA.opacidad * 1.4);
      ctx.fillStyle = this.bucketColors[b];
      ctx.beginPath();
      for (let k = from; k < to; k++) {
        const i = this.order[k];
        if (this.halo[i]) continue;
        const d = size * this.sizeMul[i];
        ctx.rect(this.x[i] - d / 2, this.y[i] - d / 2, d, d);
      }
      ctx.fill();
      // Partículas con halo y titileo
      const sprite = this.sprites[b];
      for (let k = from; k < to; k++) {
        const i = this.order[k];
        if (!this.halo[i]) continue;
        const d = size * this.sizeMul[i] * PA.halo;
        ctx.globalAlpha =
          PA.opacidad * (1 - tw + tw * Math.sin(twSpeed * this.twinkleRate[i] + this.seed[i] * TAU));
        ctx.drawImage(sprite, this.x[i] - d / 2, this.y[i] - d / 2, d, d);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
