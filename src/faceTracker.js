// MediaPipe Face Landmarker, 100% local (WASM + modelo servidos desde /public).
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/models/face_landmarker.task';

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.faces = []; // array de caras; cada cara = array de {x,y,z} normalizados
    this.numFaces = 0;
    // Expresiones de la primera cara (0–1, sin suavizar)
    this.expr = { smile: 0, blinkL: 0, blinkR: 0, jaw: 0 };
  }

  async init() {
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    } catch (err) {
      throw new Error('No se pudo cargar MediaPipe (WASM). Ejecuta `npm install` de nuevo.');
    }
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true, // sonrisa, parpadeo, boca
      minFaceDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch {
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      } catch (err) {
        throw new Error(
          'No se pudo cargar el modelo de rostro (public/models/face_landmarker.task). Ejecuta `npm install`.'
        );
      }
    }
  }

  /** Procesa un frame nuevo del video (si lo hay). */
  update() {
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this.faces = result.faceLandmarks || [];
    this.numFaces = this.faces.length;
    const shapes = result.faceBlendshapes?.[0]?.categories;
    if (shapes) {
      const get = {};
      for (const c of shapes) get[c.categoryName] = c.score;
      this.expr.smile = ((get.mouthSmileLeft || 0) + (get.mouthSmileRight || 0)) / 2;
      this.expr.blinkL = get.eyeBlinkLeft || 0;
      this.expr.blinkR = get.eyeBlinkRight || 0;
      this.expr.jaw = get.jawOpen || 0;
    } else {
      this.expr.smile = this.expr.blinkL = this.expr.blinkR = this.expr.jaw = 0;
    }
  }

  get face() {
    return this.faces[0] || null;
  }

  get videoSize() {
    return { w: this.video.videoWidth || 640, h: this.video.videoHeight || 480 };
  }
}

/** Conexiones (pares de índices) usadas para repartir partículas sobre el rostro. */
export const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;

// Regiones de los contornos (para que ojos y boca reflejen al espectador).
// "Izquierdo/derecho" es del punto de vista de la persona, igual que los blendshapes.
export const REGION = { NINGUNA: 0, OJO_IZQ: 1, OJO_DER: 2, BOCA: 3 };
export const CONTOUR_GROUPS = [
  { region: REGION.BOCA, edges: FaceLandmarker.FACE_LANDMARKS_LIPS },
  { region: REGION.OJO_IZQ, edges: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE },
  { region: REGION.OJO_IZQ, edges: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS },
  { region: REGION.OJO_DER, edges: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE },
  { region: REGION.OJO_DER, edges: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS },
  { region: REGION.NINGUNA, edges: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW },
  { region: REGION.NINGUNA, edges: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW },
  { region: REGION.NINGUNA, edges: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL },
];
