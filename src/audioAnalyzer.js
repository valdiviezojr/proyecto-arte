// Reproduce el audio y lo analiza en vivo con un AnalyserNode.

export class AudioAnalyzer {
  constructor(src, { volumen = 1, suavizado = 0.8 } = {}) {
    this.audio = new Audio();
    this.audio.src = src;
    this.audio.preload = 'auto';
    this.audio.volume = volumen;
    this.smoothing = suavizado;
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.wave = null;
    // Valores normalizados 0–1, suavizados
    this.volume = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.centroid = 0;
  }

  /** Debe llamarse dentro de un gesto del usuario (clic en "Comenzar"). */
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const source = this.ctx.createMediaElementSource(this.audio);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Uint8Array(this.analyser.fftSize);

    await new Promise((resolve, reject) => {
      if (this.audio.readyState >= 3) return resolve();
      const ok = () => { cleanup(); resolve(); };
      const fail = () => {
        cleanup();
        reject(new Error(`No se pudo cargar el audio (${this.audio.src.replace(location.origin, '')}).`));
      };
      const cleanup = () => {
        this.audio.removeEventListener('canplaythrough', ok);
        this.audio.removeEventListener('error', fail);
      };
      this.audio.addEventListener('canplaythrough', ok);
      this.audio.addEventListener('error', fail);
      this.audio.load();
    });
  }

  play() {
    return this.audio.play();
  }

  get currentTime() {
    return this.audio.currentTime;
  }

  update() {
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);

    // Volumen RMS
    let sum = 0;
    for (let i = 0; i < this.wave.length; i++) {
      const v = (this.wave[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.min(1, Math.sqrt(sum / this.wave.length) * 3);

    // Bandas y centroide espectral
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const band = (lo, hi) => {
      const a = Math.max(1, Math.floor(lo / binHz));
      const b = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };
    let num = 0;
    let den = 0;
    for (let i = 1; i < this.freq.length; i++) {
      num += i * this.freq[i];
      den += this.freq[i];
    }
    const centroidHz = den > 0 ? (num / den) * binHz : 0;
    const centroid = Math.min(1, centroidHz / 5000);

    const k = this.smoothing;
    const s = (prev, v) => prev * k + v * (1 - k);
    this.volume = s(this.volume, rms);
    this.bass = s(this.bass, band(20, 250));
    this.mid = s(this.mid, band(250, 2000));
    this.treble = s(this.treble, band(2000, 10000));
    this.centroid = s(this.centroid, centroid);
  }
}
