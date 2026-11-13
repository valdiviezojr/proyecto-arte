// Cámara web en un <video> oculto: sólo se usa para obtener landmarks.

export async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador no permite acceder a la cámara (¿falta HTTPS o localhost?).');
  }
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    video.remove();
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      throw new Error('Permiso de cámara denegado. Habilítalo en el navegador y recarga la página.');
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      throw new Error('No se encontró ninguna cámara.');
    }
    if (err.name === 'NotReadableError') {
      throw new Error('La cámara está siendo usada por otra aplicación.');
    }
    throw new Error(`No se pudo iniciar la cámara: ${err.message}`);
  }

  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  }
  return video;
}
