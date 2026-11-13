// ============================================================================
//  SONRISA EN TRITONO — todos los parámetros ajustables viven aquí.
//  Tiempos en segundos. Colores en hex.
// ============================================================================

export const config = {
  // ---------------------------------------------------------------- AUDIO ---
  audio: {
    src: '/sonido-fondo.mpeg', // sonido (render de tritono.mid)
    midi: '/tritono.mid', // sólo datos (no suena)
    cues: '/audio/cues.json', // respaldo: si existe, reemplaza la detección MIDI
    // Corrección de desfase mp3 ↔ MIDI. Positivo = los tritonos se disparan antes.
    audioOffset: 0,
    volumen: 1,
  },

  // --------------------------------------------------------------- FASES ---
  // 'manual': las fases empiezan en los segundos de `fases` (recomendado: tú decides
  //           dónde está la parte disonante de la pieza).
  // 'auto':   las fases se calculan del MIDI, donde la curva de tensión cruza `umbral`.
  // En ambos modos, si hay MIDI, dentro de la disonancia la intensidad y la rotura del
  // rostro siguen a la música.
  modoFases: 'manual',
  // Cada fase empieza en `inicio` (s), usa los parámetros de `tipo` y entra en
  // `transicion` (s; si no se indica, `duracionTransicion`).
  fases: [
    { nombre: 'CALMA', tipo: 'calma', inicio: 0 },
    // 43.3 s: entra el sonido fuerte disonante (Fa#, Mi♭–La)
    { nombre: 'DISONANCIA', tipo: 'disonancia', inicio: 43.3, transicion: 1.5 },
    // 59.8 s: vuelve Si♭ y empieza el final
    { nombre: 'CALMA', tipo: 'calma', inicio: 59.8, transicion: 4 },
  ],
  // Duración (s) del cruce gradual entre fases. Empieza en el `inicio` de cada fase.
  duracionTransicion: 4,
  fasesAuto: {
    umbral: 0.45, // 0–1: nivel de tensión que separa calma de disonancia (modo auto)
    ataque: 1.5, // s: qué tan rápido sube la tensión cuando aparece una disonancia
    relajacion: 5, // s: qué tan lento baja cuando la disonancia se resuelve
    pisoDisonancia: 0.6, // 0–1: intensidad mínima del color durante la disonancia
  },
  // ROTURA DEL ROSTRO: sigue a la disonancia de la música casi al instante.
  // Dentro de la fase de disonancia el rostro se rompe con los pasajes disonantes;
  // fuera de ella esos pasajes sólo lo hacen temblar levemente (`temblorFuera`).
  rotura: {
    ataque: 0.2, // s: qué tan rápido se rompe cuando entra la disonancia
    relajacion: 1, // s: qué tan rápido se recompone cuando se resuelve
    desde: 0.3, // 0–1: por debajo de esta tensión el rostro no se rompe nada
    hasta: 0.7, // 0–1: desde esta tensión el rostro se rompe por completo
    temblorFuera: 1.2, // px: temblor de los pasajes tensos fuera de la disonancia
    pisoEnDisonancia: 0.35, // 0–1: rotura mínima durante toda la fase de disonancia
  },
  // Suavizado extra por frame de los parámetros (0 = sin suavizar, 0.99 = muy lento).
  suavizadoParametros: 0.92,

  // Parámetros visuales por tipo de fase (se interpolan entre sí).
  tipos: {
    calma: {
      paleta: ['#00ffa3', '#00c2d8', '#2f6bff', '#7af0ff'],
      atraccion: 0.035, // fuerza del resorte hacia la cara (fricción y vel. máx.: ver `fisica`)
      ruido: 0.12, // fuerza del campo de flujo
      velocidadRuido: 0.15, // qué tan rápido cambia el campo de flujo
      temblor: 0, // sacudida aleatoria (px/frame)
      dispersion: 0, // separa las partículas de la cara (0–1+)
      tamano: 1.6, // px
      estela: 0.22, // 0 = estela infinita, 1 = sin estela
    },
    disonancia: {
      paleta: ['#ff6a00', '#ff2a00', '#ffb000', '#ff004c'],
      atraccion: 0.016,
      ruido: 1.4,
      velocidadRuido: 0.9,
      temblor: 2.2,
      dispersion: 0.55,
      tamano: 2.1,
      estela: 0.35,
    },
  },

  // ----------------------------------------------------------- PARTÍCULAS ---
  particulas: {
    cantidad: 4000,
    proporcionContornos: 0.6, // fracción sobre ojos/labios/cejas/óvalo (resto: malla)
    dispersionLocal: 2.5, // ruido de posición alrededor de cada punto (px)
    // Sin cara: flotan libres y lentas
    libre: { ruido: 0.08, velocidadMax: 0.9, amortiguacion: 0.97 },
    // Velocidad (0–1 por frame) con que aparece/desaparece la atracción a la cara
    suavizadoCara: 0.04,
    // Aspecto: puntos de tamaños variados; una fracción con halo suave y titileo
    tamanoMin: 0.5, // multiplicador de tamaño de las partículas más chicas
    tamanoMax: 2.2, // … y de las más grandes
    fraccionHalo: 0.3, // 0–1: cuántas llevan halo (más = más suave, pero más costoso)
    halo: 3, // radio del halo respecto al núcleo
    opacidad: 0.55, // opacidad base (se suman con brillo aditivo)
    titileo: 0.45, // 0 = brillo constante, 1 = titilan mucho
    velocidadTitileo: 1.2, // ciclos por segundo (aprox.)
  },

  // ------------------------------------------------------------- FÍSICA ---
  // Inspirada en el problema RESTRINGIDO de n cuerpos (ver physics.js):
  //  - grupo ROSTRO: orbita las masas (landmarks) cercanas a su lugar en la cara
  //  - grupo FONDO: flota con atractores libres que derivan por la pantalla
  // En calma las órbitas son estables y la cara se lee; en la disonancia G sube, la
  // fricción baja y aparecen perturbación y repulsión: las órbitas se vuelven caóticas.
  // La disonancia de la física sigue a la "forma" de `phases.js` (fases + rotura + sonrisa).
  fisica: {
    semilla: null, // número = misma simulación cada vez · null = distinta en cada ejecución
    pasoTiempo: 1 / 60, // s por paso fijo de integración (Euler semi-implícito)
    maxSubpasos: 3, // pasos máximos por frame si un frame se atrasa

    // Cuerpos masivos: landmarks del rostro (contorno, ojos, cejas, nariz, boca)
    masas: {
      cantidad: 80, // cuántos landmarks son masas (60–100)
      masaPorLandmark: 1,
      cuerposPorParticula: 4, // cada partícula siente sólo las K masas más cercanas a su lugar
      softening: 14, // px: evita explosiones cuando una partícula pasa muy cerca
      suavizado: 0.5, // 0–0.99: suavizado de la posición de las masas entre frames
    },
    G: { calma: 30, disonancia: 220 }, // constante gravitatoria por fase
    volumenAG: 0.8, // volumen → G (más volumen, más gravedad)
    friccion: { calma: 0.14, disonancia: 0.04 }, // fracción de velocidad que se pierde por paso
    velocidadMax: { calma: 4, disonancia: 16 }, // px/paso (grupo rostro)
    atraccionMinima: 0.02, // resorte mínimo hacia el rostro: la cara no desaparece en el caos
    perturbacion: 1.2, // px/paso²: ruido del grupo rostro en la disonancia
    frecuenciasAPerturbacion: 1.5, // agudos → más perturbación
    // Repulsión parcial intermitente (sólo en la disonancia): cada `intervalo` s, una
    // `fraccion` de las masas repele durante medio intervalo.
    repulsion: { intensidad: 0.8, fraccion: 0.3, intervalo: 0.7 },
    velocidadInicial: 1.5, // px/paso: velocidad tangencial aleatoria al empezar

    // Atractores libres: siempre activos, mueven el fondo (y todo cuando no hay cara)
    atractores: { cantidad: 4, velocidad: 25, G: 2500, softening: 150 },

    // Grupos rostro / fondo
    proporcionRostro: 0.45, // faceRatio: fracción de partículas que forma la cara
    influenciaFondo: 0.05, // backgroundFaceInfluence: cuánto siente el fondo al rostro
    caosFondo: 2, // backgroundChaosFactor: cuánto se agita el fondo en la disonancia
    opacidadFondo: 0.6, // el fondo es más tenue que el rostro (profundidad)
    tamanoFondo: 0.85,
    intercambio: {
      activar: true, // swapEnabled
      intervaloMs: 1500, // swapIntervalMs
      proporcion: 0.02, // swapRate: fracción de partículas que cambia de grupo cada vez
      transicion: 2, // s que tarda una partícula en pasar de un grupo al otro
    },

    // Capa extra de caos: partículas pesadas con gravedad mutua (coste O(n·H))
    pesadas: { activar: false, cantidad: 200, masa: 3, softening: 20 },

    // Tritono: además del impulso radial (ver `tritono`), G cambia de signo un momento
    tritono: { repulsion: 1 }, // 1 = G se invierte por completo en el pico del pulso

    // Calidad adaptativa: si no alcanza los FPS, reduce masas y luego partículas
    calidad: {
      activar: true,
      fpsMinimo: 50,
      msMinimo: 6, // sólo si las partículas cuestan al menos esto (si no, el cuello es otro)
      segundosBajo: 3, // los FPS deben estar bajos tantos segundos seguidos
      masasMinimas: 30,
      particulasMinimas: 1500,
    },
  },

  // ------------------------------------------------------------ VIDA ---
  // El rostro "canta" la pieza: cada nota del MIDI enciende una franja del rostro según
  // su altura (graves en la mandíbula, agudos en la frente).
  notas: {
    intensidad: 0.9, // 0 = desactivado
    duracion: 0.8, // s que tarda en apagarse cada destello
    anchoFranja: 0.08, // alto de la franja iluminada (fracción del rostro)
    vibracion: 0.5, // px: pequeño empujón de las partículas iluminadas
  },
  // Volumen: las zonas del rostro más cercanas a la cámara (nariz, pómulos) se ven más grandes.
  profundidad: {
    intensidad: 0.55, // 0 = rostro plano · 1 = mucho relieve
  },
  // Polvo de fondo: rodea al rostro, respira con el volumen y se agita en la disonancia.
  ambiente: {
    cantidad: 700, // 0 = desactivado
    opacidad: 0.3,
    tamano: 1.3, // px
    velocidad: 0.25,
    agitacionDisonancia: 4, // cuánto más rápido se mueve en la disonancia
    reaccionVolumen: 1.5, // cuánto brilla con el volumen
  },

  // ------------------------------------------------------- EXPRESIONES ---
  // Detectadas con MediaPipe (blendshapes). Valores 0–1.
  expresiones: {
    sonrisa: {
      // La sonrisa se mide en una escala 0–1 entre `minimo` (cara neutra) y `maximo`.
      minimo: 0.15,
      maximo: 0.7,
      suavizado: 0.88, // 0–0.99: qué tan lento sigue a la sonrisa real
      // CALMA: sonreír ilumina y entibia el rostro
      brilloCalma: 0.35, // 0–1: cuánto se tiñe hacia `colorCalma`
      colorCalma: '#ffe2b0',
      tamanoCalma: 0.3, // tamaño extra de las partículas al sonreír
      // DISONANCIA: sonreír sostiene la máscara (la forma resiste, el color no)
      sostenerForma: 0.75, // 0 = la sonrisa no ayuda · 1 = la forma se sostiene por completo
      temblorBoca: 2.5, // px: temblor de la "sonrisa forzada" durante la disonancia
    },
    parpadeo: {
      cierre: 0.9, // cuánto se cierran las partículas de los ojos al parpadear
      suavizado: 0.35,
    },
    boca: {
      apertura: 0.6, // amplifica la apertura de la boca
      anchoSonrisa: 0.15, // ensancha los labios al sonreír
      suavizado: 0.6,
    },
    atraccionRasgos: 2, // ojos y boca siguen al rostro más rápido que el resto
  },

  // -------------------------------------------------------- RESPIRACIÓN ---
  // El rostro se expande y contrae sutilmente, al pulso de la pieza.
  respiracion: {
    amplitud: 0.025, // fracción del tamaño del rostro
    compases: 2, // una respiración cada N compases (4/4) según el tempo del MIDI
    segundosRespaldo: 5, // duración de una respiración si no hay tempo en el MIDI
    aceleracionDisonancia: 1, // en la disonancia respira hasta (1 + esto) veces más rápido
  },

  // ------------------------------------------------- REACTIVIDAD AL AUDIO ---
  reactividad: {
    volumenATamano: 1.6, // volumen → tamaño
    volumenAVelocidad: 1.2, // volumen → velocidad / ruido
    frecuenciaAColor: 0.35, // centroide espectral → desplazamiento en la paleta
    agudosADispersion: 0.6, // agudos → dispersión
    suavizado: 0.8, // suavizado del análisis (0–0.99)
  },

  // ------------------------------------------------------------ TRITONO ---
  tritono: {
    ventanaAntiDuplicados: 0.6, // s: como máximo un evento por ventana
    // s que deben sonar juntas las dos notas. 0.1 ignora las notas de adorno (≈56 ms)
    solapamientoMinimo: 0.1,
    intensidad: 14, // fuerza de la explosión (px/frame)
    duracion: 1.6, // s hasta que el pulso decae
    velocidadOnda: 900, // px/s del anillo expansivo
    grosorOnda: 90, // px
    destello: '#ffffff', // color del destello
    intensidadDestello: 0.85, // 0–1
    fuerzaFuera: 0.35, // 0–1: fuerza del pulso cuando el tritono suena fuera de la disonancia
    distorsion: 3.5, // temblor extra durante el pulso
  },

  // ---------------------------------------------------------------- CARA ---
  cara: {
    alturaEnPantalla: 0.78, // alto del rostro como fracción de la pantalla
    seguimiento: 0.25, // 0 = rostro siempre centrado, 1 = sigue la posición en cámara
    suavizado: 0.85, // suavizado del encuadre (0–0.99)
    espejo: true,
    segundosSinCaraParaAviso: 2.5,
  },

  // --------------------------------------------------------------- DEBUG ---
  debugInicial: false, // tecla D para alternar
};
