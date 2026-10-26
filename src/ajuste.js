export function agruparConsecutivos(puntos, metros = 10) {
  const conservados = [];
  for (const punto of puntos) {
    const anterior = conservados.at(-1);
    if (!anterior || distanciaMetros(anterior, punto) >= metros) conservados.push({ ...punto });
  }
  return conservados;
}

function distanciaMetros(a, b) {
  const radianes = Math.PI / 180;
  const latitud = (b.latitud - a.latitud) * radianes;
  const longitud = (b.longitud - a.longitud) * radianes;
  const seno = Math.sin(latitud / 2) ** 2 +
    Math.cos(a.latitud * radianes) * Math.cos(b.latitud * radianes) * Math.sin(longitud / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, seno)));
}

let ultimaConsulta = -Infinity;
const cache = new Map();

function esperarConsulta(milisegundos, signal) {
  return new Promise((resolver, rechazar) => {
    const terminar = () => { signal?.removeEventListener('abort', abortar); resolver(); };
    const temporizador = setTimeout(terminar, milisegundos);
    function abortar() { clearTimeout(temporizador); rechazar(signal.reason); }
    signal?.addEventListener('abort', abortar, { once: true });
    if (signal?.aborted) abortar();
  });
}

export class ErrorAjuste extends Error {
  constructor(mensaje, puntos) {
    super(`${mensaje} El borrador no ha cambiado.`);
    this.name = 'ErrorAjuste';
    this.indices = puntos.map(punto => punto.indiceOriginal);
  }
}

export async function ajustarACalles(puntos, {
  solicitar = fetch, ahora = Date.now, signal,
  esperar = esperarConsulta,
  alAvanzar = () => {},
} = {}) {
  const agrupados = agruparConsecutivos(puntos.map((punto, indiceOriginal) => ({ ...punto, indiceOriginal })));
  if (agrupados.length < 2 || agrupados.length > 100) {
    throw new Error('El ajuste admite entre 2 y 100 puntos despues de agrupar a 10 metros. Edita el borrador o usa un servidor propio para recorridos mayores.');
  }
  const clave = JSON.stringify(agrupados.map(({ latitud, longitud, precision, registrado_en }) => [latitud, longitud, precision, registrado_en]));
  signal?.throwIfAborted();
  if (cache.has(clave)) return structuredClone(cache.get(clave));
  if (ahora() - ultimaConsulta < 1100) throw new Error('Espera un momento antes de volver a consultar OSRM.');
  const tramos = [];
  for (let inicio = 0; ; inicio += 7) {
    tramos.push(agrupados.slice(inicio, inicio + 10));
    if (inicio + 10 >= agrupados.length) break;
  }
  let anterior;
  let inicioAnterior = 0;
  let coordenadas = [];
  let confianza = 1;
  for (const [indice, tramo] of tramos.entries()) {
    signal?.throwIfAborted();
    if (indice) await esperar(Math.max(0, 1100 - (ahora() - ultimaConsulta)), signal);
    signal?.throwIfAborted();
    alAvanzar(indice + 1, tramos.length);
    const ajustado = await consultarTramo(tramo, solicitar, ahora, signal);
    signal?.throwIfAborted();
    if (tramos.length > 1) ajustado.indices = localizarPuntos(ajustado);
    if (anterior) {
      if (!coincidenTramos(anterior, ajustado)) {
        throw new ErrorAjuste('Los tramos ajustados no coinciden en su zona compartida. Revisa los puntos senalados; no se unieron para evitar una conexion falsa.', tramo.slice(0, 3));
      }
      // Unir en el punto central exacto evita depender del redondeo de extremos de OSRM.
      coordenadas.push(...anterior.coordenadas.slice(inicioAnterior, anterior.indices.at(-2) + 1));
      inicioAnterior = ajustado.indices[1] + 1;
    }
    if (indice === tramos.length - 1) coordenadas.push(...ajustado.coordenadas.slice(inicioAnterior));
    if (coordenadas.length > 10000) throw new Error('El ajuste supera los 10000 vertices. El borrador no ha cambiado.');
    confianza = Math.min(confianza, ajustado.confianza);
    anterior = ajustado;
  }
  const unicas = coordenadas.filter((p, indice) => !indice || p[0] !== coordenadas[indice - 1][0] || p[1] !== coordenadas[indice - 1][1]);
  const resultado = { puntos: unicas.map(([longitud, latitud]) => ({ latitud, longitud })), confianza };
  if (cache.size >= 20) cache.delete(cache.keys().next().value);
  cache.set(clave, resultado);
  return structuredClone(resultado);
}

export async function acercarPuntosACalles(puntos, {
  solicitar = fetch, ahora = Date.now, signal, esperar = esperarConsulta, alAvanzar = () => {},
} = {}) {
  if (puntos.length < 2 || puntos.length > 100) {
    throw new Error('Acercar a calles admite entre 2 y 100 puntos, sin agruparlos. El borrador no ha cambiado.');
  }
  if (puntos.some(p => !Number.isFinite(p.latitud) || Math.abs(p.latitud) > 90 ||
      !Number.isFinite(p.longitud) || Math.abs(p.longitud) > 180)) {
    throw new Error('Hay coordenadas no validas. El borrador no ha cambiado.');
  }
  const ajustados = [];
  let desplazamientoMaximo = 0;
  for (const [indiceOriginal, punto] of puntos.entries()) {
    signal?.throwIfAborted();
    await esperar(Math.max(0, 1100 - (ahora() - ultimaConsulta)), signal);
    signal?.throwIfAborted();
    alAvanzar(indiceOriginal + 1, puntos.length);
    const direccion = new URL(`https://router.project-osrm.org/nearest/v1/driving/${punto.longitud},${punto.latitud}`);
    direccion.searchParams.set('number', '1');
    direccion.searchParams.set('radiuses', '100');
    ultimaConsulta = ahora();
    const limite = AbortSignal.timeout(20000);
    const respuesta = await solicitar(direccion, {
      signal: signal ? AbortSignal.any([signal, limite]) : limite,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    signal?.throwIfAborted();
    if (!respuesta.ok) {
      if (respuesta.headers?.get('content-type')?.includes('json')) {
        const detalle = await respuesta.json();
        if (detalle?.code === 'NoSegment') {
          throw new ErrorAjuste('No se encontro una calle para automoviles a menos de 100 m del punto senalado.', [{ indiceOriginal }]);
        }
      }
      throw new Error(`OSRM (HTTP ${respuesta.status}) no pudo acercar el punto ${indiceOriginal + 1}. El borrador no ha cambiado.`);
    }
    const datos = await respuesta.json();
    signal?.throwIfAborted();
    const coordenadas = datos.waypoints?.[0]?.location;
    if (datos.code !== 'Ok' || !Array.isArray(coordenadas) ||
        !Number.isFinite(coordenadas[0]) || Math.abs(coordenadas[0]) > 180 ||
        !Number.isFinite(coordenadas[1]) || Math.abs(coordenadas[1]) > 90) {
      throw new ErrorAjuste('OSRM no devolvio una calle cercana valida para el punto senalado.', [{ indiceOriginal }]);
    }
    const ajustado = { longitud: coordenadas[0], latitud: coordenadas[1] };
    const distancia = distanciaMetros(punto, ajustado);
    if (distancia > 100) {
      throw new ErrorAjuste('La calle encontrada esta a mas de 100 m del punto senalado. No se aplico un desplazamiento tan grande.', [{ indiceOriginal }]);
    }
    desplazamientoMaximo = Math.max(desplazamientoMaximo, distancia);
    ajustados.push(ajustado);
  }
  return { puntos: ajustados, desplazamientoMaximo };
}

export async function trazarPorCalles(puntos, {
  solicitar = fetch, ahora = Date.now, signal, esperar = esperarConsulta, alAvanzar = () => {},
} = {}) {
  if (puntos.length < 2 || puntos.length > 10000 || puntos.some(p =>
    !Number.isFinite(p.latitud) || Math.abs(p.latitud) > 90 ||
    !Number.isFinite(p.longitud) || Math.abs(p.longitud) > 180)) {
    throw new Error('El trazado requiere entre 2 y 10000 puntos con coordenadas validas. El borrador no ha cambiado.');
  }
  const indexados = puntos.map((punto, indiceOriginal) => ({ ...punto, indiceOriginal }));
  const agrupados = agruparConsecutivos(indexados);
  const ultimo = indexados.at(-1);
  if (ultimo.latitud !== agrupados.at(-1).latitud || ultimo.longitud !== agrupados.at(-1).longitud) {
    agrupados.push(ultimo);
  }
  if (agrupados.length < 2 || agrupados.length > 100) {
    throw new Error('El trazado admite entre 2 y 100 puntos despues de agrupar a 10 metros conservando inicio y fin. El borrador no ha cambiado.');
  }
  const coordenadas = [];
  const total = Math.ceil((agrupados.length - 1) / 9);
  for (let inicio = 0; inicio < agrupados.length - 1; inicio += 9) {
    signal?.throwIfAborted();
    await esperar(Math.max(0, 1100 - (ahora() - ultimaConsulta)), signal);
    signal?.throwIfAborted();
    alAvanzar(inicio / 9 + 1, total);
    const tramo = agrupados.slice(inicio, inicio + 10);
    const direccion = new URL(`https://router.project-osrm.org/route/v1/driving/${tramo.map(p => `${p.longitud},${p.latitud}`).join(';')}`);
    direccion.searchParams.set('geometries', 'geojson');
    direccion.searchParams.set('overview', 'full');
    direccion.searchParams.set('alternatives', 'false');
    direccion.searchParams.set('steps', 'false');
    direccion.searchParams.set('continue_straight', 'false');
    direccion.searchParams.set('radiuses', tramo.map(() => 100).join(';'));
    ultimaConsulta = ahora();
    const limite = AbortSignal.timeout(20000);
    const respuesta = await solicitar(direccion, {
      signal: signal ? AbortSignal.any([signal, limite]) : limite,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    signal?.throwIfAborted();
    if (!respuesta.ok) {
      let detalle = null;
      if (respuesta.headers?.get('content-type')?.includes('json')) detalle = await respuesta.json();
      const motivo = detalle?.code === 'NoRoute' ? 'No hay un camino por calles que conecte estos puntos.'
        : detalle?.code === 'NoSegment' ? 'No hay una calle para automoviles a menos de 100 m de algun punto.'
          : 'El servicio rechazo el trazado por calles.';
      throw new ErrorAjuste(`OSRM (HTTP ${respuesta.status}${detalle?.code ? `, ${detalle.code}` : ''}): ${motivo}`, tramo);
    }
    const datos = await respuesta.json();
    signal?.throwIfAborted();
    const recorrido = datos.routes?.[0];
    const geometria = recorrido?.geometry?.coordinates;
    if (datos.code !== 'Ok' || datos.routes?.length !== 1 ||
        !Array.isArray(datos.waypoints) || datos.waypoints.length !== tramo.length ||
        !Array.isArray(recorrido?.legs) || recorrido.legs.length !== tramo.length - 1 ||
        recorrido.geometry?.type !== 'LineString' || !Array.isArray(geometria) ||
        geometria.length < 2 || geometria.length > 10000 ||
        geometria.some(p => !coordenadaValida(p)) ||
        datos.waypoints.some((p, indice) => !coordenadaValida(p?.location) ||
          distanciaMetros(tramo[indice], { longitud: p.location[0], latitud: p.location[1] }) > 100)) {
      throw new ErrorAjuste('OSRM no devolvio un trazado completo y valido dentro de 100 m de los puntos.', tramo);
    }
    // Validar cada paso, no la ruta global: una vuelta en U no debe ocultar un rodeo.
    const indices = localizarPuntos({ tracepoints: datos.waypoints, coordenadas: geometria });
    for (let indice = 0; indice < tramo.length - 1; indice += 1) {
      const inicioPaso = tramo[indice];
      const finPaso = tramo[indice + 1];
      const paso = geometria.slice(indices[indice], indices[indice + 1] + 1);
      let longitudPaso = 0;
      for (let vertice = 0; vertice < paso.length; vertice += 1) {
        if (vertice) longitudPaso += distanciaMetros(
          { longitud: paso[vertice - 1][0], latitud: paso[vertice - 1][1] },
          { longitud: paso[vertice][0], latitud: paso[vertice][1] },
        );
      }
      if (paso.some(punto => distanciaAlSegmento(punto, inicioPaso, finPaso) > 25) ||
          longitudPaso > 2 * distanciaMetros(inicioPaso, finPaso) + 30) {
        throw new ErrorAjuste(
          `OSRM propone un desvio entre los puntos ${inicioPaso.indiceOriginal + 1} y ${finPaso.indiceOriginal + 1}. No se agregaron otras calles. El perfil de automovil puede impedir la vuelta en U o el sentido de tu recorrido; revisa esos puntos o usa Acercar puntos a calles.`,
          [inicioPaso, finPaso],
        );
      }
    }
    if (JSON.stringify(geometria[0]) !== JSON.stringify(datos.waypoints[0].location) ||
        JSON.stringify(geometria.at(-1)) !== JSON.stringify(datos.waypoints.at(-1).location)) {
      throw new ErrorAjuste('Los extremos del trazado no coinciden con los puntos de paso.', tramo);
    }
    if (coordenadas.length && JSON.stringify(coordenadas.at(-1)) !== JSON.stringify(geometria[0])) {
      throw new ErrorAjuste('Los tramos eligieron calles distintas en su punto compartido. No se unieron con una linea recta.', tramo.slice(0, 1));
    }
    for (const coordenada of geometria) {
      const anterior = coordenadas.at(-1);
      if (!anterior || coordenada[0] !== anterior[0] || coordenada[1] !== anterior[1]) coordenadas.push(coordenada);
    }
    if (coordenadas.length > 10000) throw new Error('El trazado supera los 10000 vertices. El borrador no ha cambiado.');
  }
  if (coordenadas.length < 2) {
    throw new Error('Los puntos se ajustan a una misma ubicacion; no hay un recorrido que trazar. El borrador no ha cambiado.');
  }
  return {
    puntos: coordenadas.map(([longitud, latitud]) => ({ latitud, longitud })),
    puntosAgrupados: puntos.length - agrupados.length,
    puntosDePaso: agrupados.length,
  };
}

function coordenadaValida(punto) {
  return Array.isArray(punto) && punto.length === 2 &&
    Number.isFinite(punto[0]) && Math.abs(punto[0]) <= 180 &&
    Number.isFinite(punto[1]) && Math.abs(punto[1]) <= 90;
}

function distanciaAlSegmento([longitud, latitud], inicio, fin) {
  const escala = Math.PI / 180 * 6371000;
  const horizontal = escala * Math.cos((inicio.latitud + fin.latitud) / 2 * Math.PI / 180);
  const x = (longitud - inicio.longitud) * horizontal;
  const y = (latitud - inicio.latitud) * escala;
  const dx = (fin.longitud - inicio.longitud) * horizontal;
  const dy = (fin.latitud - inicio.latitud) * escala;
  const proporcion = dx || dy ? Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(x - proporcion * dx, y - proporcion * dy);
}

function coincidenTramos(anterior, actual) {
  const previos = anterior.tracepoints.slice(-3);
  const actuales = actual.tracepoints.slice(0, 3);
  if (JSON.stringify(previos[1].location) !== JSON.stringify(actuales[1].location)) return false;
  const convertir = ([longitud, latitud]) => ({ latitud, longitud });
  if (previos.some((p, indice) => distanciaMetros(convertir(p.location), convertir(actuales[indice].location)) > 1)) return false;
  function interior(geometria) {
    const unicos = geometria.filter((p, indice) => !indice || JSON.stringify(p) !== JSON.stringify(geometria[indice - 1]));
    const inicio = convertir(unicos[0]);
    const fin = convertir(unicos.at(-1));
    while (unicos.length && distanciaMetros(inicio, convertir(unicos[0])) <= 1) unicos.shift();
    while (unicos.length && distanciaMetros(fin, convertir(unicos.at(-1))) <= 1) unicos.pop();
    return unicos;
  }
  const a = interior(anterior.coordenadas.slice(anterior.indices.at(-3)));
  const b = interior(actual.coordenadas.slice(0, actual.indices[2] + 1));
  return a.length > 0 && JSON.stringify(a) === JSON.stringify(b);
}

function localizarPuntos(tramo) {
  let posicion = 0;
  return tramo.tracepoints.map(punto => {
    while (posicion < tramo.coordenadas.length &&
      JSON.stringify(tramo.coordenadas[posicion]) !== JSON.stringify(punto.location)) posicion += 1;
    if (posicion === tramo.coordenadas.length) throw new Error('OSRM no permite verificar el orden de los tramos. El borrador no ha cambiado.');
    return posicion;
  });
}

async function consultarTramo(agrupados, solicitar, ahora, signal) {
  const direccion = new URL(`https://router.project-osrm.org/match/v1/driving/${agrupados.map(p => `${p.longitud},${p.latitud}`).join(';')}`);
  direccion.searchParams.set('geometries', 'geojson');
  direccion.searchParams.set('overview', 'full');
  direccion.searchParams.set('gaps', 'split');
  direccion.searchParams.set('tidy', 'false');
  direccion.searchParams.set('radiuses', agrupados.map(p => Math.max(5, Math.min(25, p.precision ?? 25))).join(';'));
  const tiempos = agrupados.map(p => Math.floor(Date.parse(p.registrado_en) / 1000));
  if (agrupados.every(punto => Number.isFinite(punto.precision) && punto.precision >= 0) &&
      tiempos.every((tiempo, indice) => Number.isFinite(tiempo) && (!indice || tiempo > tiempos[indice - 1]))) {
    direccion.searchParams.set('timestamps', tiempos.join(';'));
  }
  ultimaConsulta = ahora();
  const limite = AbortSignal.timeout(20000);
  const respuesta = await solicitar(direccion, { signal: signal ? AbortSignal.any([signal, limite]) : limite, referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!respuesta.ok) {
    let detalle = null;
    if (respuesta.headers?.get('content-type')?.includes('json')) detalle = await respuesta.json();
    const motivos = {
      NoMatch: 'No se encontro un recorrido por calles para estos puntos. Pueden estar lejos de una calle apta para automoviles o demasiado separados.',
      NoSegment: 'Uno o mas puntos no tienen una calle apta para automoviles dentro del radio de precision GPS.',
      TooBig: detalle?.message?.includes('Radius search size')
        ? 'El radio de busqueda supera el limite del servidor de pruebas; no es un exceso de puntos.'
        : 'La consulta supera los limites del servidor de pruebas.',
      InvalidQuery: 'OSRM rechazo los parametros de la consulta.',
      InvalidValue: 'OSRM rechazo un valor de la consulta.',
      InvalidOptions: 'OSRM rechazo las opciones de la consulta.',
    };
    const motivo = motivos[detalle?.code] || 'El servicio rechazo la solicitud.';
    const mensaje = typeof detalle?.message === 'string' ? ` Detalle: ${detalle.message}` : '';
    if (detalle?.code === 'NoMatch' || detalle?.code === 'NoSegment') {
      throw new ErrorAjuste(`OSRM (HTTP ${respuesta.status}, ${detalle.code}): ${motivo}${mensaje} Revisa el tramo senalado; OSRM no identifica el punto exacto del fallo.`, agrupados);
    }
    throw new Error(`OSRM (HTTP ${respuesta.status}${detalle?.code ? `, ${detalle.code}` : ''}): ${motivo}${mensaje} El borrador no ha cambiado.`);
  }
  const datos = await respuesta.json();
  const recorrido = datos.matchings?.[0];
  if (datos.code !== 'Ok' || !Array.isArray(datos.tracepoints) || datos.tracepoints.length !== agrupados.length ||
      !Array.isArray(datos.matchings) || !datos.matchings.length) {
    throw new ErrorAjuste('OSRM no devolvio una correspondencia completa y verificable. Revisa el tramo senalado.', agrupados);
  }
  const omitidos = agrupados.filter((_, indice) => !datos.tracepoints[indice]);
  if (omitidos.length) {
    throw new ErrorAjuste('OSRM no encontro correspondencia para los puntos senalados. Pueden estar fuera de una calle para automoviles o tener error GPS. Usa Mover para revisarlos; no se eliminaron automaticamente.', omitidos);
  }
  if (datos.matchings.length !== 1) {
    const limites = agrupados.filter((_, indice) =>
      (indice > 0 && datos.tracepoints[indice - 1].matchings_index !== datos.tracepoints[indice].matchings_index) ||
      (indice < agrupados.length - 1 && datos.tracepoints[indice + 1].matchings_index !== datos.tracepoints[indice].matchings_index));
    throw new ErrorAjuste(`OSRM separo el recorrido en ${datos.matchings.length} tramos. Revisa los puntos junto a las separaciones; no se inventaron conexiones entre ellos.`, limites.length ? limites : agrupados);
  }
  if (datos.tracepoints.some((punto, indice) => punto.matchings_index !== 0 || punto.waypoint_index !== indice)) {
    throw new ErrorAjuste('OSRM no permite verificar el orden de los puntos del tramo senalado.', agrupados);
  }
  if (!Number.isFinite(recorrido?.confidence) || recorrido.confidence < 0.5) {
    const detalle = Number.isFinite(recorrido?.confidence) ? ` (${Math.round(recorrido.confidence * 100)}%; minimo 50%)` : '';
    throw new ErrorAjuste(`La confianza de OSRM es insuficiente${detalle}. El tramo senalado es dudoso; no se forzo el ajuste ni se calculo una ruta alternativa.`, agrupados);
  }
  const coordenadas = recorrido.geometry?.coordinates;
  if (recorrido.geometry?.type !== 'LineString' || !Array.isArray(coordenadas) ||
      coordenadas.length < 2 || coordenadas.length > 10000 ||
      coordenadas.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || Math.abs(p[0]) > 180 || !Number.isFinite(p[1]) || Math.abs(p[1]) > 90)) {
    throw new Error('OSRM devolvio una geometria no valida o demasiado grande. El borrador no ha cambiado.');
  }
  return { coordenadas, confianza: recorrido.confidence, tracepoints: datos.tracepoints };
}
