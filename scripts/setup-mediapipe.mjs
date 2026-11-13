// Copia los archivos WASM de MediaPipe y descarga el modelo de Face Landmarker
// a /public para que todo funcione 100% local (sin CDN) durante la presentación.
// Se ejecuta automáticamente después de `npm install`.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
const modelDst = join(root, 'public/models/face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('[setup] WASM de MediaPipe copiado a public/mediapipe/wasm');
} else {
  console.warn('[setup] No se encontró @mediapipe/tasks-vision/wasm');
}

if (existsSync(modelDst)) {
  console.log('[setup] Modelo ya presente en public/models/face_landmarker.task');
} else {
  try {
    console.log('[setup] Descargando modelo face_landmarker.task…');
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dirname(modelDst), { recursive: true });
    writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
    console.log('[setup] Modelo guardado en public/models/face_landmarker.task');
  } catch (err) {
    console.warn(`[setup] No se pudo descargar el modelo (${err.message}).`);
    console.warn(`[setup] Descárgalo manualmente desde:\n  ${MODEL_URL}\n  y guárdalo en public/models/face_landmarker.task`);
  }
}
