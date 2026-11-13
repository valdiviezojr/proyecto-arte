# Sonrisa en Tritono

Prototipo para Arte y Tecnología (UTEC). La cámara detecta el rostro del espectador
(sin mostrar el video) y lo representa con ~4000 partículas que reaccionan a la música;
cada tritono de la pieza dispara un pulso visual.

## Uso

```bash
npm install     # también copia el WASM de MediaPipe y descarga el modelo a /public
npm run dev     # abre http://localhost:5173
```

- **Comenzar**: activa audio y pide permiso de cámara.
- **D**: modo debug (fase, tiempo, FPS, caras, tritonos, próximo tritono, avisos).
- **F**: pantalla completa.

Tras `npm install` todo funciona sin internet (modelo y WASM quedan en `public/`).
Usa Chrome o Edge.

## Cambiar el audio y el MIDI

La pieza actual es `public/sonido-fondo.mpeg` (sonido) + `public/tritono.mid` (sus datos).
Para cambiarla, reemplaza esos archivos o cambia `audio.src` / `audio.midi` en `src/config.js`.
Ambos deben empezar en el segundo 0. El MIDI no suena: de él salen los tritonos y las fases.

Si prefieres marcar los tritonos a mano, crea `public/audio/cues.json`. Si existe, se usa
**en lugar** del MIDI:

```json
[{ "t": 22.5, "tipo": "tritono" }, { "t": 31.0, "tipo": "tritono" }]
```

Audio de prueba (60 s): `npm run generar-audio-prueba` genera `public/audio/pieza.mp3` y
`pieza.mid`; para usarlo apunta `audio.src` y `audio.midi` a esos archivos.

## Fases (calma → disonancia → calma)

Con `modoFases: 'auto'` (por defecto) las fases **se leen del MIDI**: se calcula una curva
de tensión (qué tan disonantes son los intervalos que suenan juntos, ponderado por la
intensidad). La curva sólo reacciona **después** de que suena la disonancia, nunca antes.
La disonancia va desde que la curva supera `fasesAuto.umbral` hasta que vuelve a bajar,
y dentro de ella la intensidad visual sube y baja con la música.
Con la pieza actual: calma 0–14.5 s, disonancia 14.5–64.5 s, calma 64.5–79 s (se ve en el debug).

El **color** sigue la curva lenta (la atmósfera de la sección). La **forma** sigue una curva
rápida (`rotura`): el rostro se rompe mientras suenan los pasajes disonantes y se recompone
~1 s después de que se resuelven.

- El rostro se rompe demasiado / muy poco: sube / baja `rotura.desde` y `rotura.hasta`.
- Se rompe tarde / se recompone muy lento: baja `rotura.ataque` / `rotura.relajacion`.
- El color cambia muy rápido / muy lento: sube / baja `fasesAuto.ataque` y `fasesAuto.relajacion`.
- Disonancia más corta / más larga: sube / baja `fasesAuto.umbral`.
- Para fijar los tiempos a mano: `modoFases: 'manual'` y edita `fases`.

## Interacción: el rostro reacciona a quien lo mira

- **Sonrisa.** En la calma, sonreír ilumina y entibia el rostro. En la disonancia,
  sonreír **sostiene la máscara**: la forma resiste el caos, pero el color sigue mostrando
  la disonancia y la boca tiembla (sonrisa forzada). Si dejas de sonreír, la cara se rompe.
  Idea: el color es lo que sentimos, la forma es lo que mostramos.
- **Parpadeo y boca.** Los ojos de partículas se cierran cuando parpadeas y la boca se
  abre con la tuya.
- **Respiración.** El rostro se expande y contrae sutilmente, una vez cada 2 compases
  del tempo del MIDI; en la disonancia respira más rápido.

Ajustes en `expresiones` y `respiracion` de `src/config.js`. Los más útiles:
`sonrisa.sostenerForma` (cuánto sostiene la sonrisa), `sonrisa.minimo`/`maximo` (calibrar
qué cuenta como sonrisa; mira el valor "sonrisa" en el debug), `respiracion.amplitud`.

## Vida

- **El rostro canta la pieza.** Cada nota del MIDI enciende una franja del rostro según su
  altura: graves en la mandíbula, agudos en la frente (`notas`).
- **Profundidad.** Las zonas cercanas a la cámara (nariz, pómulos) tienen partículas más
  grandes, así el rostro tiene volumen (`profundidad.intensidad`).
- **Polvo de fondo.** Partículas tenues alrededor que respiran con el volumen, se agitan en la
  disonancia y las empuja la onda del tritono (`ambiente`; `cantidad: 0` lo desactiva).

Al terminar la pieza aparece el botón **Repetir**.

## Ajustes (`src/config.js`)

Todos los parámetros están en `src/config.js`. Los más usados:

| Qué | Dónde |
|---|---|
| Fases | `modoFases`, `fasesAuto` (ver arriba) o `fases[].inicio` en modo manual |
| Duración del cruce entre fases | `duracionTransicion` |
| Desfase mp3 ↔ MIDI | `audio.audioOffset`: si los pulsos llegan **tarde**, súbelo (ej. `0.15`); si llegan **antes**, usa negativo |
| Colores, fuerza, ruido, temblor, dispersión | `tipos.calma` y `tipos.disonancia` |
| Número de partículas | `particulas.cantidad` |
| Pulso de tritono | `tritono.intensidad`, `tritono.duracion`, `tritono.destello`… |
| Ventana anti-duplicados | `tritono.ventanaAntiDuplicados` |
| Tamaño/encuadre del rostro | `cara.alturaEnPantalla`, `cara.seguimiento` |

Para calibrar el `audioOffset`: activa el debug (D), mira el "próximo" tritono y compara
con lo que escuchas.

## Estructura

```
src/
  config.js         parámetros
  main.js           arranque, loop, debug, teclado
  camera.js         cámara en <video> oculto
  faceTracker.js    MediaPipe Face Landmarker
  audioAnalyzer.js  reproducción + AnalyserNode (volumen, bandas, centroide)
  midiCues.js       tritonos (cues.json o .mid) y curva de tensión del .mid
  phases.js         fases e interpolación de parámetros
  particles.js      física y dibujo de partículas (p5.js)
  ambient.js        polvo de fondo
scripts/
  setup-mediapipe.mjs      copia WASM + descarga modelo (postinstall)
  generate-test-audio.mjs  audio/MIDI de prueba
```
