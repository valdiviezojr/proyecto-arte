// Polvo de fondo: una capa tenue de partículas alrededor del rostro.
// Tres planos de profundidad (lejos = más chicas, lentas y tenues) para dar sensación
// de espacio. Respira con el volumen, se agita en la disonancia y la onda del tritono
// también lo empuja.

const LAYERS = [
  { size: 0.6, speed: 0.5, alpha: 0.5 },
  { size: 1, speed: 1, alpha: 0.8 },
  { size: 1.6, speed: 1.6, alpha: 1 },
];

export class AmbientDust {
  constructor(cfg, width, height) {
    this.cfg = cfg;
    this.w = width;
    this.h = height;
    const n = (this.n = cfg.ambiente.cantidad);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.layer = new Uint8Array(n);
    this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = Math.random() * width;
      this.y[i] = Math.random() * height;
      this.layer[i] = (Math.random() * LAYERS.length) | 0;
      this.seed[i] = Math.random();
    }
    this.time = 0;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  /**
   * @param params parámetros de fase (usa `dis` y `paleta`)
   * @param pulse  { env, ringR, cx, cy } del tritono
   */
  update(params, audio, pulse, dt) {
    const A = this.cfg.ambiente;
    const agit = 1 + params.dis * A.agitacionDisonancia;
    this.time += dt * 0.004 * agit;
    const t = this.time;
    const { x, y, vx, vy, layer, seed, w, h } = this;
    const ringW = this.cfg.tritono.grosorOnda * 1.5;
    for (let i = 0; i < this.n; i++) {
      const L = LAYERS[layer[i]];
      const ang =
        (Math.sin(x[i] * 0.002 + t + seed[i] * 6) + Math.cos(y[i] * 0.0025 - t * 0.8)) * Math.PI;
      const sp = A.velocidad * L.speed * agit;
      vx[i] = vx[i] * 0.95 + Math.cos(ang) * sp * 0.05;
      vy[i] = vy[i] * 0.95 + Math.sin(ang) * sp * 0.05;
      // La onda del tritono también empuja el polvo
      if (pulse.ringR >= 0) {
        const dx = x[i] - pulse.cx;
        const dy = y[i] - pulse.cy;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const off = Math.abs(d - pulse.ringR);
        if (off < ringW) {
          const f = pulse.env * 1.2 * L.speed * (1 - off / ringW);
          vx[i] += (dx / d) * f;
          vy[i] += (dy / d) * f;
        }
      }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      if (x[i] < -5) x[i] += w + 10;
      else if (x[i] > w + 5) x[i] -= w + 10;
      if (y[i] < -5) y[i] += h + 10;
      else if (y[i] > h + 5) y[i] -= h + 10;
    }
  }

  draw(ctx, params, audio) {
    const A = this.cfg.ambiente;
    if (!this.n) return;
    const pal = params.paleta;
    const glow = A.opacidad * (0.6 + audio.volume * A.reaccionVolumen);
    ctx.globalCompositeOperation = 'lighter';
    for (let l = 0; l < LAYERS.length; l++) {
      const L = LAYERS[l];
      const c = pal[l % pal.length];
      ctx.globalAlpha = Math.min(1, glow * L.alpha);
      ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
      const s = A.tamano * L.size;
      ctx.beginPath();
      for (let i = 0; i < this.n; i++) {
        if (this.layer[i] !== l) continue;
        ctx.rect(this.x[i] - s / 2, this.y[i] - s / 2, s, s);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
