import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparConsecutivos, ajustarACalles, acercarPuntosACalles, trazarPorCalles, ErrorAjuste } from '../src/ajuste.js';

const punto = metros => ({ latitud: metros / 6371000 * 180 / Math.PI, longitud: 0 });

test('agrupa solo consecutivos a menos de 10 m y conserva una segunda pasada', () => {
  const puntos = [punto(0), punto(9.9), punto(10.1), punto(30), punto(10.1), punto(0)];
  assert.deepEqual(agruparConsecutivos(puntos), [puntos[0], ...puntos.slice(2)]);
  assert.deepEqual(agruparConsecutivos([punto(0), punto(0)]), [punto(0)]);
  assert.equal(puntos.length, 6);
  assert.deepEqual(agruparConsecutivos([]), []);
});

function resultado(puntos) {
  return {
    code: 'Ok',
    matchings: [{ confidence: 0.9, geometry: { type: 'LineString', coordinates: puntos.map(p => [p.longitud, p.latitud]) } }],
    tracepoints: puntos.map((punto, indice) => ({ matchings_index: 0, waypoint_index: indice, location: [punto.longitud, punto.latitud] })),
  };
}

test('consulta Match en orden, conserva ida y vuelta, usa precision y cache sin modificar originales', async () => {
  const puntos = [0, 20, 40, 20, 0].map((metros, indice) => ({
    ...punto(metros), precision: 12, registrado_en: new Date(100000 + indice * 5000).toISOString(),
  }));
  let consultas = 0;
  const solicitar = async (direccion, opciones) => {
    consultas += 1;
    assert.equal(direccion.pathname, `/match/v1/driving/${puntos.map(p => `${p.longitud},${p.latitud}`).join(';')}`);
    assert.equal(direccion.searchParams.get('timestamps'), '100;105;110;115;120');
    assert.equal(direccion.searchParams.get('radiuses'), '12;12;12;12;12');
    assert.equal(direccion.searchParams.get('gaps'), 'split');
    assert.ok(opciones.signal);
    return { ok: true, json: async () => resultado(puntos) };
  };
  const ajustada = await ajustarACalles(puntos, { solicitar, ahora: () => 10000 });
  assert.deepEqual(ajustada.puntos, puntos.map(({ latitud, longitud }) => ({ latitud, longitud })));
  ajustada.puntos[0].latitud = 99;
  assert.notEqual((await ajustarACalles(puntos, { solicitar, ahora: () => 10001 })).puntos[0].latitud, 99);
  assert.equal(consultas, 1);
  assert.equal(puntos[0].precision, 12);
});

test('no inventa conexiones ni descarta puntos cuando OSRM devuelve huecos, errores o geometria invalida', async () => {
  let reloj = 20000;
  for (const tipo of ['HTTP', 'NoMatch', 'varios', 'omitido', 'confianza', 'geometria']) {
    const puntos = [punto(reloj), punto(reloj + 20)];
    const datos = resultado(puntos);
    if (tipo === 'NoMatch') datos.code = 'NoMatch';
    if (tipo === 'varios') datos.matchings.push(datos.matchings[0]);
    if (tipo === 'omitido') datos.tracepoints[0] = null;
    if (tipo === 'confianza') datos.matchings[0].confidence = 0.1;
    if (tipo === 'geometria') datos.matchings[0].geometry.coordinates[0] = [190, 95];
    await assert.rejects(ajustarACalles(puntos, {
      ahora: () => reloj,
      solicitar: async () => ({ ok: tipo !== 'HTTP', status: 429, json: async () => datos }),
    }));
    reloj += 2000;
  }
  await assert.rejects(ajustarACalles([punto(50000), punto(50020)], {
    ahora: () => reloj - 1999,
    solicitar: () => { throw new Error('No deberia consultar'); },
  }), /Espera/);
  for (const puntos of [[], [punto(0), punto(1)], Array.from({ length: 101 }, (_, indice) => punto(indice * 20))]) {
    await assert.rejects(ajustarACalles(puntos), /entre 2 y 100/);
  }
});

test('explica un HTTP 400 NoMatch con el motivo de OSRM en vez de anunciar una caida', async () => {
  await assert.rejects(ajustarACalles([punto(60000), punto(60020)], {
    ahora: () => 60000,
    solicitar: async () => ({
      ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 'NoMatch', message: 'Could not match the trace.' }),
    }),
  }), /HTTP 400, NoMatch.*No se encontro un recorrido.*Could not match the trace.*borrador no ha cambiado/);
});

test('respeta el limite real de 10 puntos con solapamiento, sin perder el regreso ni consultar en paralelo', async () => {
  const puntos = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 140, 120].map(m => punto(70000 + m));
  const tamanos = [];
  const pausas = [];
  const avances = [];
  const salida = await ajustarACalles(puntos, {
    ahora: () => 70000,
    esperar: async ms => pausas.push(ms),
    alAvanzar: (...avance) => avances.push(avance),
    solicitar: async direccion => {
      const tramo = direccion.pathname.split('/').at(-1).split(';').map(p => {
        const [longitud, latitud] = p.split(',').map(Number);
        return { latitud, longitud };
      });
      tamanos.push(tramo.length);
      return { ok: true, json: async () => resultado(tramo) };
    },
  });
  assert.deepEqual(tamanos, [10, 5]);
  assert.deepEqual(pausas, [1100]);
  assert.deepEqual(avances, [[1, 2], [2, 2]]);
  assert.deepEqual(salida.puntos, puntos);
});

test('no une tramos con un solapamiento distinto y no aplica resultados parciales al cancelar', async () => {
  let consultas = 0;
  const puntos = Array.from({ length: 11 }, (_, i) => punto(80000 + i * 20));
  await assert.rejects(ajustarACalles(puntos, {
    ahora: () => 80000, esperar: async () => {},
    solicitar: async direccion => {
      const tramo = direccion.pathname.split('/').at(-1).split(';').map(p => {
        const [longitud, latitud] = p.split(',').map(Number);
        return { latitud, longitud };
      });
      if (++consultas === 2) tramo[0].longitud += 0.0001;
      return { ok: true, json: async () => resultado(tramo) };
    },
  }), /no coinciden/);
  const controlador = new AbortController();
  let llamadas = 0;
  await assert.rejects(ajustarACalles(puntos, {
    ahora: () => 90000, signal: controlador.signal,
    esperar: async () => controlador.abort(),
    solicitar: async () => {
      llamadas += 1;
      return { ok: true, json: async () => resultado(puntos.slice(0, 10)) };
    },
  }), { name: 'AbortError' });
  assert.equal(llamadas, 1);
  assert.equal(puntos.length, 11);
});

test('tolera el redondeo submetro de los extremos de OSRM y vertices consecutivos identicos sin crear un salto', async () => {
  const puntos = Array.from({ length: 14 }, (_, i) => punto(100000 + i * 20));
  let consultas = 0;
  const salida = await ajustarACalles(puntos, {
    ahora: () => 100000, esperar: async () => {},
    solicitar: async direccion => {
      const tramo = direccion.pathname.split('/').at(-1).split(';').map(p => {
        const [longitud, latitud] = p.split(',').map(Number);
        return { latitud, longitud };
      });
      if (++consultas === 2) tramo[0].latitud += 0.000001;
      const datos = resultado(tramo);
      if (consultas === 1) datos.matchings[0].geometry.coordinates.splice(8, 0, datos.matchings[0].geometry.coordinates[7]);
      return { ok: true, json: async () => datos };
    },
  });
  assert.deepEqual(salida.puntos, puntos);
});

test('identifica puntos originales omitidos tras agrupar y en el segundo tramo sin alterar el recorrido', async () => {
  const puntos = [0, 1, ...Array.from({ length: 13 }, (_, indice) => (indice + 1) * 20)].map(m => punto(110000 + m));
  const originales = structuredClone(puntos);
  let consultas = 0;
  await assert.rejects(ajustarACalles(puntos, {
    ahora: () => 110000, esperar: async () => {},
    solicitar: async direccion => {
      const tramo = direccion.pathname.split('/').at(-1).split(';').map(p => {
        const [longitud, latitud] = p.split(',').map(Number);
        return { latitud, longitud };
      });
      const datos = resultado(tramo);
      if (++consultas === 2) datos.tracepoints[2] = null;
      return { ok: true, json: async () => datos };
    },
  }), error => {
    assert.ok(error instanceof ErrorAjuste);
    assert.deepEqual(error.indices, [10]);
    assert.match(error.message, /no encontro correspondencia/);
    return true;
  });
  assert.equal(consultas, 2);
  assert.deepEqual(puntos, originales);
});

test('distingue separaciones de confianza baja y acepta exactamente el umbral de 0.5', async () => {
  for (const [indice, tipo] of ['separacion', 'baja', 'umbral'].entries()) {
    const reloj = 120000 + indice * 2000;
    const puntos = [0, 20, 40, 60].map(m => punto(reloj + m));
    const datos = resultado(puntos);
    if (tipo === 'separacion') {
      datos.matchings.push(structuredClone(datos.matchings[0]));
      datos.tracepoints[2].matchings_index = 1;
      datos.tracepoints[3].matchings_index = 1;
    } else datos.matchings[0].confidence = tipo === 'baja' ? 0.49 : 0.5;
    const consulta = ajustarACalles(puntos, {
      ahora: () => reloj,
      solicitar: async () => ({ ok: true, json: async () => datos }),
    });
    if (tipo === 'umbral') assert.equal((await consulta).confianza, 0.5);
    else await assert.rejects(consulta, error => {
      assert.ok(error instanceof ErrorAjuste);
      assert.deepEqual(error.indices, tipo === 'separacion' ? [1, 2] : [0, 1, 2, 3]);
      assert.match(error.message, tipo === 'separacion' ? /separo el recorrido en 2 tramos/ : /confianza.*insuficiente/);
      return true;
    });
  }
});

test('no interpreta fechas de guardado manual o editado como horas GPS', async () => {
  const puntos = [0, 20, 40].map((metros, indice) => ({
    ...punto(130000 + metros), precision: indice === 1 ? null : 12,
    registrado_en: new Date(100000 + indice * 5000).toISOString(),
  }));
  await ajustarACalles(puntos, {
    ahora: () => 130000,
    solicitar: async direccion => {
      assert.equal(direccion.searchParams.has('timestamps'), false);
      return { ok: true, json: async () => resultado(puntos) };
    },
  });
});

test('acerca todos los puntos sin agrupar, respeta el orden y el limite compartido con Match', async () => {
  const puntos = [200000, 200001, 200040, 200000].map(m => ({ ...punto(m), precision: 12 }));
  const originales = structuredClone(puntos);
  let reloj = 200000;
  await ajustarACalles([punto(199000), punto(199020)], {
    ahora: () => reloj, solicitar: async () => ({ ok: true, json: async () => resultado([punto(199000), punto(199020)]) }),
  });
  const pausas = [];
  const avances = [];
  let consultas = 0;
  const salida = await acercarPuntosACalles(puntos, {
    ahora: () => reloj,
    esperar: async ms => { pausas.push(ms); reloj += ms; },
    alAvanzar: (...avance) => avances.push(avance),
    solicitar: async direccion => {
      assert.equal(direccion.pathname, `/nearest/v1/driving/0,${puntos[consultas].latitud}`);
      assert.equal(direccion.searchParams.get('radiuses'), '100');
      assert.equal(direccion.searchParams.get('number'), '1');
      const ajustado = punto([200000, 200001, 200040, 200000][consultas++] + 99.99);
      return { ok: true, json: async () => ({ code: 'Ok', waypoints: [{ location: [ajustado.longitud, ajustado.latitud] }] }) };
    },
  });
  assert.deepEqual(pausas, [1100, 1100, 1100, 1100]);
  assert.deepEqual(avances, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.equal(salida.puntos.length, 4);
  assert.deepEqual(salida.puntos[0], salida.puntos[3]);
  assert.ok(Math.abs(salida.desplazamientoMaximo - 99.99) < 0.001);
  assert.deepEqual(Object.keys(salida.puntos[0]).sort(), ['latitud', 'longitud']);
  assert.deepEqual(puntos, originales);
});

test('no aplica acercamientos parciales ante calles lejanas, respuestas invalidas o errores HTTP', async () => {
  for (const [indice, tipo] of ['lejana', 'invalida', 'sin-calle', 'http'].entries()) {
    const puntos = [punto(220000 + indice * 100), punto(220020 + indice * 100)];
    const originales = structuredClone(puntos);
    let consultas = 0;
    await assert.rejects(acercarPuntosACalles(puntos, {
      ahora: () => 220000 + indice * 5000, esperar: async () => {},
      solicitar: async () => {
        consultas += 1;
        const ajustado = consultas === 1 ? puntos[0] : punto(220020 + indice * 100 + 100.01);
        const datos = { code: 'Ok', waypoints: [{ location: [ajustado.longitud, ajustado.latitud] }] };
        if (consultas === 2 && tipo === 'invalida') datos.waypoints[0].location = [190, 95];
        if (consultas === 2 && tipo === 'sin-calle') datos.code = 'NoSegment';
        return {
          ok: consultas === 1 || !['sin-calle', 'http'].includes(tipo), status: tipo === 'http' ? 503 : 400,
          headers: new Headers({ 'content-type': 'application/json' }), json: async () => datos,
        };
      },
    }), error => {
      assert.match(error.message, /borrador no ha cambiado/);
      if (tipo === 'http') assert.match(error.message, /HTTP 503/);
      else {
        assert.ok(error instanceof ErrorAjuste);
        assert.deepEqual(error.indices, [1]);
      }
      if (tipo === 'lejana') assert.match(error.message, /mas de 100 m/);
      return true;
    });
    assert.equal(consultas, 2);
    assert.deepEqual(puntos, originales);
  }
});

test('cancela acercamientos incluso si el transporte devuelve una respuesta tras abortar', async () => {
  const controlador = new AbortController();
  let consultas = 0;
  await assert.rejects(acercarPuntosACalles([punto(250000), punto(250020)], {
    signal: controlador.signal, ahora: () => 250000, esperar: async () => {},
    solicitar: async () => {
      consultas += 1;
      controlador.abort();
      return { ok: true, json: async () => ({ code: 'Ok', waypoints: [{ location: [0, 0] }] }) };
    },
  }), { name: 'AbortError' });
  assert.equal(consultas, 1);
  for (const puntos of [[], [punto(0)], Array.from({ length: 101 }, () => punto(0)), [punto(0), { latitud: NaN, longitud: 0 }]]) {
    await assert.rejects(acercarPuntosACalles(puntos, {
      solicitar: () => assert.fail('No debe consultar con entradas invalidas'),
    }), /borrador no ha cambiado/);
  }
});

function puntosConsultados(direccion) {
  return direccion.pathname.split('/').at(-1).split(';').map(p => {
    const [longitud, latitud] = p.split(',').map(Number);
    return { latitud, longitud };
  });
}

function trazado(puntos, coordenadas = puntos.map(p => [p.longitud, p.latitud])) {
  return {
    code: 'Ok',
    waypoints: puntos.map(p => ({ location: [p.longitud, p.latitud] })),
    routes: [{
      legs: puntos.slice(1).map(() => ({ distance: 20, duration: 2 })),
      geometry: { type: 'LineString', coordinates: coordenadas },
    }],
  };
}

test('traza una esquina sin muestra GPS, agrupa el atasco de puntos y conserva vertices cercanos de la esquina', async () => {
  const puntos = [0, 1, 2, 3, 20].map(m => punto(300000 + m));
  const fin = { ...punto(300040), longitud: 0.0003 };
  puntos.push(fin);
  const originales = structuredClone(puntos);
  const esquina = { ...punto(300020), longitud: 0.0003 };
  const curva = { ...punto(300021), longitud: 0.0003 };
  const esperados = [puntos[0], puntos[4], esquina, curva, fin];
  const salida = await trazarPorCalles(puntos, {
    ahora: () => 300000, esperar: async () => {},
    solicitar: async direccion => {
      assert.match(direccion.pathname, /^\/route\/v1\/driving\//);
      assert.equal(direccion.searchParams.get('overview'), 'full');
      assert.equal(direccion.searchParams.get('geometries'), 'geojson');
      assert.equal(direccion.searchParams.get('continue_straight'), 'false');
      assert.equal(direccion.searchParams.get('radiuses'), '100;100;100');
      assert.equal(direccion.searchParams.has('timestamps'), false);
      const consultados = puntosConsultados(direccion);
      assert.deepEqual(consultados, [puntos[0], puntos[4], fin]);
      const coordenadas = esperados.map(p => [p.longitud, p.latitud]);
      coordenadas.splice(3, 0, coordenadas[2]);
      return { ok: true, json: async () => trazado(consultados, coordenadas) };
    },
  });
  assert.deepEqual(salida, { puntos: esperados, puntosAgrupados: 3, puntosDePaso: 3 });
  assert.deepEqual(puntos, originales);
});

test('conserva el fin cercano, el regreso por una calle y los extremos de cada tramo sin puentes rectos', async () => {
  const puntos = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 160, 140, 120, 121].map(m => punto(310000 + m));
  const tamanos = [];
  const pausas = [];
  const avances = [];
  let reloj = 310000;
  const salida = await trazarPorCalles(puntos, {
    ahora: () => reloj,
    esperar: async ms => { pausas.push(ms); reloj += ms; },
    alAvanzar: (...avance) => avances.push(avance),
    solicitar: async direccion => {
      const consultados = puntosConsultados(direccion);
      tamanos.push(consultados.length);
      return { ok: true, json: async () => trazado(consultados) };
    },
  });
  assert.deepEqual(tamanos, [10, 5]);
  assert.equal(pausas[1], 1100);
  assert.deepEqual(avances, [[1, 2], [2, 2]]);
  assert.deepEqual(salida.puntos, puntos);
  assert.equal(salida.puntosAgrupados, 0);
});

test('rechaza trazados incompletos, lejanos, invalidos, fuera de orden o excesivos sin cambiar originales', async () => {
  for (const [indice, tipo] of ['NoRoute', 'omitido', 'orden', 'invalido', 'lejos', 'extremo', 'grande', 'HTTP'].entries()) {
    const puntos = [0, 20, 40].map(m => punto(320000 + indice * 100 + m));
    const originales = structuredClone(puntos);
    const datos = trazado(puntos);
    if (tipo === 'NoRoute') datos.code = 'NoRoute';
    if (tipo === 'omitido') datos.waypoints.pop();
    if (tipo === 'orden') datos.routes[0].geometry.coordinates.reverse();
    if (tipo === 'invalido') datos.routes[0].geometry.coordinates[1] = [190, 95];
    if (tipo === 'lejos') datos.waypoints[1].location = [0, punto(320020 + indice * 100 + 101).latitud];
    if (tipo === 'extremo') datos.routes[0].geometry.coordinates.unshift([0, puntos[0].latitud - 0.00001]);
    if (tipo === 'grande') datos.routes[0].geometry.coordinates = Array.from({ length: 10001 }, () => [0, puntos[0].latitud]);
    await assert.rejects(trazarPorCalles(puntos, {
      ahora: () => 320000 + indice * 5000, esperar: async () => {},
      solicitar: async () => ({
        ok: tipo !== 'HTTP', status: 503, json: async () => datos,
      }),
    }), /borrador no ha cambiado/);
    assert.deepEqual(puntos, originales);
  }
});

test('rechaza una union de tramos que se ajustaron a lugares distintos', async () => {
  const puntos = Array.from({ length: 11 }, (_, indice) => punto(370000 + indice * 20));
  let consultas = 0;
  await assert.rejects(trazarPorCalles(puntos, {
    ahora: () => 370000, esperar: async () => {},
    solicitar: async direccion => {
      const consultados = puntosConsultados(direccion);
      if (++consultas === 2) consultados[0].longitud += 0.00001;
      return { ok: true, json: async () => trazado(consultados) };
    },
  }), /No se unieron con una linea recta/);
  assert.equal(consultas, 2);
});

test('no consulta trazados invalidos y cancela antes de aplicar resultados parciales', async () => {
  for (const puntos of [[], [punto(0)], [punto(0), punto(0)], [punto(0), { latitud: 91, longitud: 0 }],
    Array.from({ length: 101 }, (_, indice) => punto(indice * 20)),
    Array.from({ length: 10001 }, () => punto(0))]) {
    await assert.rejects(trazarPorCalles(puntos, {
      solicitar: () => assert.fail('No debe consultar'),
    }), /borrador no ha cambiado/);
  }
  const puntos = Array.from({ length: 11 }, (_, indice) => punto(380000 + indice * 20));
  const controlador = new AbortController();
  let consultas = 0;
  await assert.rejects(trazarPorCalles(puntos, {
    ahora: () => 380000, signal: controlador.signal,
    esperar: async () => { if (consultas) controlador.abort(); },
    solicitar: async direccion => {
      consultas += 1;
      return { ok: true, json: async () => trazado(puntosConsultados(direccion)) };
    },
  }), { name: 'AbortError' });
  assert.equal(consultas, 1);
});

test('rechaza vueltas a la manzana por tramo sin confundirlas con una ida y vuelta legitima', async () => {
  const puntos = [0, 30, 60, 30, 0].map(m => punto(400000 + m));
  const originales = structuredClone(puntos);
  for (const [indice, tipo] of ['valido', 'lateral', 'longitud'].entries()) {
    const consulta = trazarPorCalles(puntos, {
      ahora: () => 400000 + indice * 5000, esperar: async () => {},
      solicitar: async direccion => {
        const consultados = puntosConsultados(direccion);
        const datos = trazado(consultados);
        const geometria = datos.routes[0].geometry.coordinates;
        if (tipo === 'lateral') {
          geometria.splice(3, 0, [0.001, puntos[3].latitud]);
        }
        if (tipo === 'longitud') {
          const vueltas = Array.from({ length: 12 }, (_, i) => [0, punto(400040 + (i % 2 ? 10 : 0)).latitud]);
          geometria.splice(3, 0, ...vueltas);
        }
        return { ok: true, json: async () => datos };
      },
    });
    if (tipo === 'valido') assert.deepEqual((await consulta).puntos, puntos);
    else await assert.rejects(consulta, error => {
      assert.ok(error instanceof ErrorAjuste);
      assert.deepEqual(error.indices, [2, 3]);
      assert.match(error.message, /desvio.*No se agregaron otras calles.*borrador no ha cambiado/);
      return true;
    });
  }
  assert.deepEqual(puntos, originales);
});

test('limita el radio Match de precisiones GPS altas y distingue TooBig por radio', async () => {
  const puntos = [0, 20].map(m => ({ ...punto(420000 + m), precision: 150 }));
  await assert.rejects(ajustarACalles(puntos, {
    ahora: () => 420000,
    solicitar: async direccion => {
      assert.equal(direccion.searchParams.get('radiuses'), '25;25');
      return {
        ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ code: 'TooBig', message: 'Radius search size is too large for map matching.' }),
      };
    },
  }), /radio de busqueda.*no es un exceso de puntos/);
});
