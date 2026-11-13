// Calcula los parámetros visuales según audio.currentTime, con cruces graduales.
//
// Todo se reduce a un número: la cantidad de disonancia `d` (0 = calma, 1 = disonancia
// máxima). Los parámetros se interpolan entre `tipos.calma` y `tipos.disonancia`:
//   - color, tamaño, estela → siguen la curva LENTA de tensión (la atmósfera)
//   - forma (atracción, dispersión, temblor, ruido…) → sigue la curva RÁPIDA: el rostro
//     se rompe mientras suenan los pasajes disonantes y se recompone cuando se resuelven.
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
// (la fricción y la velocidad máxima viven en `config.fisica`)
const SHAPE_KEYS = ['atraccion', 'ruido', 'temblor', 'dispersion'];
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
    this.mezclaForma = 0; // cuánto se rompe el rostro
    this.tension = null; // curva del MIDI (modo auto)
    this.tensionActual = 0;
    this.modo = 'manual';
    this.phaseMix = 0;
    this.tensionFuera = 0;
  }

  /**
   * Guarda las curvas del MIDI (intensidad y rotura, en cualquier modo).
   * Modo auto: además, la fase de disonancia va desde el primer hasta el último momento
   * en que la curva de tensión supera el umbral.
   * Devuelve un aviso (string) si no se pudo usar el modo auto.
   */
  setTension(tension) {
    if (tension) this.tension = tension;
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
    const val = (f) => (f.tipo === 'disonancia' ? 1 : 0);
    let mix = val(this.fases[0]);
    for (let i = 1; i < this.fases.length; i++) {
      const T = Math.max(0.001, this.fases[i].transicion ?? this.cfg.duracionTransicion);
      const w = smoothstep((t - this.fases[i].inicio) / T);
      if (w <= 0) break;
      mix += (val(this.fases[i]) - mix) * w;
    }
    this.phaseMix = mix; // sólo por fases, sin la intensidad de la música
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
   * Cuánto se rompe el rostro (0–1) en el tiempo t: sigue a los pasajes disonantes,
   * pero sólo dentro de la fase de disonancia. Fuera de ella, `this.tensionFuera`
   * guarda cuánto deberían temblar.
   */
  shapeAmount(t, d) {
    this.tensionFuera = 0;
    if (!this.tension) return d; // sin MIDI: sigue a las fases
    const { desde, hasta } = this.cfg.rotura;
    const v = sampleCurve(this.tension.forma, this.tension.step, t);
    const tense = smoothstep((v - desde) / Math.max(0.001, hasta - desde));
    this.tensionFuera = tense * (1 - this.phaseMix);
    const piso = this.cfg.rotura.pisoEnDisonancia ?? 0;
    return (piso + (1 - piso) * tense) * this.phaseMix;
  }

  /**
   * Parámetros objetivo (sin suavizado temporal) para el tiempo t.
   * `sostener` (0–1): cuánto resiste la forma a la disonancia (la sonrisa sostiene la
   * máscara). Sólo afecta a la forma: el color sigue mostrando la disonancia.
   */
  target(t, sostener = 0) {
    const d = this.amount(t);
    const dForma = this.shapeAmount(t, d) * (1 - sostener);
    const { calma, disonancia } = this;
    const p = { dis: d, disForma: dForma, paleta: [] };
    for (const k of SHAPE_KEYS) p[k] = calma[k] + (disonancia[k] - calma[k]) * dForma;
    // Pasajes tensos fuera de la disonancia: sólo un temblor leve
    p.temblor += this.tensionFuera * this.cfg.rotura.temblorFuera * (1 - sostener);
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
