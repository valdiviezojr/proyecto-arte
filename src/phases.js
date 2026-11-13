// Calcula los parámetros visuales según audio.currentTime, con cruces graduales.
//
// Todo se reduce a un número: la cantidad de disonancia `d` (0 = calma, 1 = disonancia
// máxima). Los parámetros se interpolan entre `tipos.calma` y `tipos.disonancia`:
//   - color, tamaño, estela → siguen a `d` directamente (anuncian la tensión)
//   - forma (atracción, dispersión, temblor, ruido…) → siguen a d^exponenteForma,
//     así el rostro se mantiene con tensión media y sólo se rompe en los picos.
import { sampleCurve } from './midiCues.js';

const smoothstep = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Parámetros que deforman el rostro
const SHAPE_KEYS = ['atraccion', 'amortiguacion', 'ruido', 'temblor', 'dispersion', 'velocidadMax'];
// Parámetros de "atmósfera"
const LOOK_KEYS = ['velocidadRuido', 'tamano', 'estela'];
const NUMERIC_KEYS = [...SHAPE_KEYS, ...LOOK_KEYS];

export class Phases {
  constructor(cfg) {
    this.cfg = cfg;
    this.fases = [...cfg.fases].sort((a, b) => a.inicio - b.inicio);
    const toRgb = (t) => ({ ...t, paleta: t.paleta.map(hexToRgb) });
    this.calma = toRgb(cfg.tipos.calma);
    this.disonancia = toRgb(cfg.tipos.disonancia);
    this.paletteSize = Math.max(this.calma.paleta.length, this.disonancia.paleta.length);
    this.current = null; // parámetros suavizados
    this.nombreFase = this.fases[0]?.nombre || '';
    this.mezclaDisonancia = 0; // d (color)
    this.mezclaForma = 0; // d^exponenteForma
    this.tension = null; // curva del MIDI (modo auto)
    this.tensionActual = 0;
    this.modo = 'manual';
  }

  /**
   * Modo auto: la fase de disonancia va desde el primer hasta el último momento
   * en que la curva de tensión supera el umbral.
   * Devuelve un aviso (string) si no se pudo usar el modo auto.
   */
  setTension(tension) {
    if (this.cfg.modoFases !== 'auto') return null;
    if (!tension) return 'Fases en modo manual: no hay MIDI válido para calcularlas.';
    const { umbral } = this.cfg.fasesAuto;
    let a = -1;
    let b = -1;
    tension.curva.forEach((v, i) => {
      if (v > umbral) {
        if (a < 0) a = i;
        b = i;
      }
    });
    if (a < 0) return 'Fases en modo manual: la curva de tensión nunca supera el umbral.';
    const start = a * tension.step;
    const end = (b + 1) * tension.step;
    this.fases = [
      { nombre: 'CALMA', tipo: 'calma', inicio: 0 },
      { nombre: 'DISONANCIA', tipo: 'disonancia', inicio: start },
    ];
    // Si la pieza termina en disonancia no hay calma final
    if (end < (tension.curva.length - 1) * tension.step) {
      this.fases.push({ nombre: 'CALMA', tipo: 'calma', inicio: end });
    }
    this.tension = tension;
    this.modo = 'auto';
    return null;
  }

  /** Cantidad de disonancia (0–1) en el tiempo t. */
  amount(t) {
    // Mezcla por fases: cada cruce EMPIEZA en el `inicio` de la fase y dura
    // `duracionTransicion` (nunca se adelanta a la música).
    const T = Math.max(0.001, this.cfg.duracionTransicion);
    const val = (f) => (f.tipo === 'disonancia' ? 1 : 0);
    let mix = val(this.fases[0]);
    for (let i = 1; i < this.fases.length; i++) {
      const w = smoothstep((t - this.fases[i].inicio) / T);
      if (w <= 0) break;
      mix += (val(this.fases[i]) - mix) * w;
    }
    // Modo auto: dentro de la disonancia, la intensidad sigue a la música
    if (this.tension) {
      const { pisoDisonancia } = this.cfg.fasesAuto;
      const local = sampleCurve(this.tension.curva, this.tension.step, t);
      this.tensionActual = local;
      mix *= pisoDisonancia + (1 - pisoDisonancia) * local;
    }
    return mix;
  }

  /**
   * Parámetros objetivo (sin suavizado temporal) para el tiempo t.
   * `sostener` (0–1): cuánto resiste la forma a la disonancia (la sonrisa sostiene la
   * máscara). Sólo afecta a la forma: el color sigue mostrando la disonancia.
   */
  target(t, sostener = 0) {
    const d = this.amount(t);
    const dForma = Math.pow(d, this.cfg.exponenteForma ?? 1) * (1 - sostener);
    const { calma, disonancia } = this;
    const p = { dis: d, disForma: dForma, paleta: [] };
    for (const k of SHAPE_KEYS) p[k] = calma[k] + (disonancia[k] - calma[k]) * dForma;
    for (const k of LOOK_KEYS) p[k] = calma[k] + (disonancia[k] - calma[k]) * d;
    for (let c = 0; c < this.paletteSize; c++) {
      const a = calma.paleta[c % calma.paleta.length];
      const b = disonancia.paleta[c % disonancia.paleta.length];
      p.paleta[c] = a.map((v, j) => v + (b[j] - v) * d);
    }

    let nombre = this.fases[0].nombre;
    for (const f of this.fases) if (t >= f.inicio) nombre = f.nombre;
    this.nombreFase = nombre;
    return p;
  }

  update(t, sostener = 0) {
    const target = this.target(t, sostener);
    if (!this.current) {
      this.current = target;
    } else {
      const k = this.cfg.suavizadoParametros;
      const c = this.current;
      for (const key of [...NUMERIC_KEYS, 'dis', 'disForma']) c[key] = c[key] * k + target[key] * (1 - k);
      for (let i = 0; i < c.paleta.length; i++) {
        for (let j = 0; j < 3; j++) c.paleta[i][j] = c.paleta[i][j] * k + target.paleta[i][j] * (1 - k);
      }
    }
    this.mezclaDisonancia = this.current.dis;
    this.mezclaForma = this.current.disForma;
    return this.current;
  }
}

export { hexToRgb };
