export function crearSeguimiento({
  registrar,
  alCambiar,
  navegador = navigator,
  documento = document,
  programar = setTimeout,
  cancelar = clearTimeout,
  ahora = Date.now,
}) {
  let activo = false;
  let enCurso = false;
  let generacion = 0;
  let temporizador;
  let bloqueo;
  let pantalla = 'Pantalla sin bloqueo';

  function informar(mensaje = '') {
    alCambiar({ activo, enCurso, pantalla, mensaje });
  }

  function liberarPantalla() {
    const anterior = bloqueo;
    bloqueo = undefined;
    if (anterior && !anterior.released) void anterior.release().catch(() => {});
  }

  function detener(mensaje = 'Registro automatico detenido.') {
    activo = false;
    generacion += 1;
    cancelar(temporizador);
    liberarPantalla();
    pantalla = 'Pantalla sin bloqueo';
    informar(mensaje);
  }

  async function iniciar({ intervalo, mantenerPantalla }) {
    if (activo || enCurso) return;
    if (![5, 10].includes(intervalo)) throw new Error('Elige un intervalo de 5 o 10 segundos.');
    if (documento.visibilityState !== 'visible') throw new Error('Abre la app para iniciar el registro.');
    activo = true;
    const actual = ++generacion;
    const sigueVigente = () => activo && actual === generacion && documento.visibilityState === 'visible';
    pantalla = mantenerPantalla ? 'Solicitando bloqueo de pantalla...' : 'Pantalla sin bloqueo';
    informar('Registro automatico iniciado.');

    if (mantenerPantalla) {
      try {
        if (!navegador.wakeLock) throw new Error('No compatible');
        const solicitado = await navegador.wakeLock.request('screen');
        if (!sigueVigente()) {
          await solicitado.release();
          return;
        }
        bloqueo = solicitado;
        pantalla = 'Pantalla encendida';
        solicitado.addEventListener('release', () => {
          if (bloqueo === solicitado && sigueVigente()) detener('El sistema libero la pantalla. Registro detenido.');
        }, { once: true });
        if (solicitado.released) {
          detener('No se pudo mantener la pantalla encendida. Registro detenido.');
          return;
        }
      } catch {
        if (!sigueVigente()) return;
        pantalla = 'Bloqueo no disponible: la pantalla puede apagarse';
      }
      informar();
    }

    async function registrarSiguiente() {
      if (!sigueVigente()) return;
      const inicio = ahora();
      enCurso = true;
      informar();
      try {
        await registrar(sigueVigente);
      } catch (error) {
        if (sigueVigente()) detener(`Registro detenido: ${error.message || 'no se pudo guardar la ubicacion.'}`);
      } finally {
        enCurso = false;
        informar();
      }
      if (sigueVigente()) {
        temporizador = programar(registrarSiguiente, Math.max(0, intervalo * 1000 - (ahora() - inicio)));
      }
    }
    if (sigueVigente()) await registrarSiguiente();
  }

  return { iniciar, detener };
}