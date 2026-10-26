import { test, expect } from '@playwright/test';
import { readFile as leerArchivo } from 'node:fs/promises';

async function prepararEditor(pagina) {
  const usuario = { id: '11111111-1111-4111-8111-111111111111', email: 'prueba@example.com', role: 'authenticated', aud: 'authenticated', app_metadata: {}, user_metadata: {} };
  const ruta = { id: '22222222-2222-4222-8222-222222222222', usuario_id: usuario.id, nombre: 'Recorrido original', creado_en: '2026-10-23T10:00:00Z' };
  const puntos = [[4.65, -74.06], [4.65001, -74.06], [4.652, -74.059], [4.65, -74.06]].map(([latitud, longitud], indice) => ({
    id: crypto.randomUUID(), ruta_id: ruta.id, usuario_id: usuario.id, latitud, longitud, precision: 12,
    registrado_en: new Date(Date.parse(ruta.creado_en) + indice * 10000).toISOString(),
  }));
  const datos = { ruta, puntos, versiones: [], fallarGuardado: false, consultasVersion: 0 };
  const imagen = await leerArchivo(new URL('../public/icono-192.png', import.meta.url));
  await pagina.route('https://server.arcgisonline.com/**', solicitud => solicitud.fulfill({ contentType: 'image/png', body: imagen }));
  await pagina.route('https://fonts.googleapis.com/**', solicitud => solicitud.fulfill({ body: '' }));
  await pagina.route('https://*.supabase.co/**', async solicitud => {
    const direccion = new URL(solicitud.request().url());
    const accion = direccion.pathname.split('/').at(-1);
    let respuesta;
    if (accion === 'token') {
      respuesta = {
        access_token: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: usuario.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.prueba`,
        refresh_token: 'prueba', expires_in: 3600, token_type: 'bearer', user: usuario,
      };
    } else if (accion === 'user') respuesta = usuario;
    else if (accion === 'rutas') respuesta = [ruta];
    else if (accion === 'puntos_ruta') respuesta = datos.puntos;
    else if (accion === 'versiones_ruta') respuesta = datos.versiones.map(({ contenido, ...metadatos }) => metadatos);
    else if (accion === 'ver_version_ruta') {
      datos.consultasVersion += 1;
      respuesta = datos.versiones.find(v => v.id === solicitud.request().postDataJSON().version_id).contenido;
    } else if (accion === 'guardar_edicion_ruta') {
      if (datos.fallarGuardado) {
        await solicitud.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '40001', message: 'La ruta cambio en otro dispositivo.' }) });
        return;
      }
      const entrada = solicitud.request().postDataJSON();
      expect(entrada.ids_esperados).toEqual(datos.puntos.map(p => p.id));
      const restaurada = entrada.version_restaurar && datos.versiones.find(v => v.id === entrada.version_restaurar).contenido;
      datos.versiones.push({ id: crypto.randomUUID(), ruta_id: ruta.id, creado_en: new Date().toISOString(), consultada_en: new Date().toISOString(), contenido: structuredClone({ nombre: ruta.nombre, puntos: datos.puntos }) });
      ruta.nombre = restaurada ? restaurada.nombre : entrada.nombre_ruta;
      datos.puntos = (restaurada ? restaurada.puntos : entrada.coordenadas).map((p, indice) => ({
        ...p, id: crypto.randomUUID(), ruta_id: ruta.id, usuario_id: usuario.id,
        precision: restaurada ? p.precision : null,
        registrado_en: restaurada ? p.registrado_en : new Date(Date.now() + indice).toISOString(),
      }));
      respuesta = ruta.id;
    } else throw new Error(`Solicitud inesperada: ${direccion}`);
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify(respuesta) });
  });
  await pagina.goto('/');
  await pagina.getByLabel('Correo electronico').fill(usuario.email);
  await pagina.locator('#auth-form').getByLabel('Contrasena', { exact: true }).fill('contrasena-de-prueba');
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('4');
  return datos;
}

test('edita cualquier punto, cancela, guarda con respaldo y restaura en escritorio y movil', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  const originales = structuredClone(datos.puntos);
  pagina.on('dialog', dialogo => dialogo.accept());
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Editar ruta', exact: true })).toBeVisible();
  await pagina.locator('#map').scrollIntoViewIfNeeded();
  const medio = pagina.locator('.marcador-borrador').nth(2);
  const caja = await medio.boundingBox();
  await pagina.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2);
  await pagina.mouse.down();
  await pagina.mouse.move(caja.x + 40, caja.y + 30, { steps: 5 });
  await pagina.mouse.up();
  await expect(pagina.locator('#lista-borrador li').nth(2)).not.toContainText('4.65200, -74.05900');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  await pagina.getByRole('button', { name: 'Eliminar punto 2', exact: true }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('3');
  await pagina.getByRole('button', { name: 'Eliminar punto 1', exact: true }).click();
  await pagina.getByRole('button', { name: 'Eliminar punto 2', exact: true }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('1');
  await expect(pagina.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeEnabled();
  expect(datos.puntos).toEqual(originales);
  await pagina.getByRole('button', { name: 'Cancelar edicion' }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('4');
  expect(datos.versiones).toHaveLength(0);

  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await pagina.getByRole('button', { name: 'Mover punto 2', exact: true }).click();
  await pagina.getByLabel('latitud del punto 2').fill('4.651');
  await pagina.getByRole('button', { name: 'Aplicar punto 2', exact: true }).click();
  await expect(pagina.locator('#lista-borrador li').nth(1)).toContainText('4.65100');
  await pagina.getByRole('button', { name: 'Eliminar punto 3', exact: true }).click();
  await pagina.getByLabel('Nombre del recorrido').fill('Recorrido editado');
  datos.fallarGuardado = true;
  await pagina.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('otro dispositivo');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('3');
  expect(datos.puntos).toEqual(originales);
  datos.fallarGuardado = false;
  await pagina.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(pagina.locator('#map-title')).toHaveText('Recorrido editado');
  await expect(pagina.locator('#stat-points')).toHaveText('3');
  expect(datos.versiones).toHaveLength(1);
  expect(datos.puntos[1].latitud).toBe(4.651);
  await pagina.getByRole('button', { name: 'Ver respaldos inactivos' }).click();
  await pagina.locator('#lista-respaldos button').click();
  await expect(pagina.locator('#message')).toContainText('plazo de un mes renovado');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  expect(datos.consultasVersion).toBe(1);
  await pagina.getByLabel('Nombre del recorrido').fill('Nombre provisional');
  await expect(pagina.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeVisible();
  await pagina.getByRole('button', { name: 'Cancelar edicion' }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('3');
  await pagina.getByRole('button', { name: 'Ver respaldos inactivos' }).click();
  await pagina.locator('#lista-respaldos button').click();
  await expect(pagina.getByRole('button', { name: 'Restaurar version', exact: true })).toBeVisible();
  await pagina.getByRole('button', { name: 'Restaurar version', exact: true }).click();
  await expect(pagina.locator('#map-title')).toHaveText('Recorrido original');
  expect(datos.puntos.map(({ latitud, longitud, precision, registrado_en }) => ({ latitud, longitud, precision, registrado_en })))
    .toEqual(originales.map(({ latitud, longitud, precision, registrado_en }) => ({ latitud, longitud, precision, registrado_en })));
  expect(datos.versiones).toHaveLength(2);
  expect(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('ajusta solo con consentimiento, conserva el borrador ante fallo y permite revisar antes de guardar', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  const originales = structuredClone(datos.puntos);
  let confirmar = false;
  let consultas = 0;
  let coordenadasConsultadas;
  pagina.on('dialog', dialogo => confirmar ? dialogo.accept() : dialogo.dismiss());
  await pagina.clock.install();
  await pagina.route('https://router.project-osrm.org/**', async solicitud => {
    consultas += 1;
    const direccion = new URL(solicitud.request().url());
    coordenadasConsultadas = direccion.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
    if (consultas === 1) {
      await solicitud.fulfill({ status: 503, body: 'Servicio no disponible' });
      return;
    }
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
      code: 'Ok',
      tracepoints: coordenadasConsultadas.map((_, indice) => ({ matchings_index: 0, waypoint_index: indice })),
      matchings: [{ confidence: 0.91, geometry: { type: 'LineString', coordinates: [
        [-74.06, 4.65], [-74.0595, 4.651], [-74.059, 4.652], [-74.0595, 4.651], [-74.06, 4.65],
      ] } }],
    }) });
  });

  await pagina.getByRole('button', { name: 'Ajustar a calles', exact: true }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  expect(consultas).toBe(0);
  confirmar = true;
  await pagina.getByRole('button', { name: 'Ajustar recorrido a calles', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('HTTP 503');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  expect(datos.puntos).toEqual(originales);
  await pagina.clock.runFor(1200);
  await pagina.getByRole('button', { name: 'Ajustar recorrido a calles', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('Vista previa ajustada');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('5');
  expect(coordenadasConsultadas).toEqual([[-74.06, 4.65], [-74.059, 4.652], [-74.06, 4.65]]);
  expect(datos.puntos).toEqual(originales);
  expect(datos.versiones).toHaveLength(0);
  await pagina.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('5');
  expect(datos.versiones[0].contenido.puntos).toEqual(originales);
  expect(datos.puntos[0].latitud).toBe(datos.puntos[4].latitud);
  expect(datos.puntos.every(p => p.precision === null)).toBe(true);
});

test('traza curvas y esquinas, agrupa consecutivos y guarda la geometria completa solo tras revisar', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  const originales = structuredClone(datos.puntos);
  let confirmar = false;
  let consultas = 0;
  let geometria;
  pagina.on('dialog', dialogo => confirmar ? dialogo.accept() : dialogo.dismiss());
  await pagina.route('https://router.project-osrm.org/**', async solicitud => {
    consultas += 1;
    const direccion = new URL(solicitud.request().url());
    expect(direccion.pathname).toContain('/route/v1/driving/');
    const coordenadas = direccion.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
    expect(coordenadas).toEqual([[-74.06, 4.65], [-74.059, 4.652], [-74.06, 4.65]]);
    const esquina = [-74.0596, 4.651];
    geometria = [coordenadas[0], esquina, coordenadas[1], esquina, coordenadas[2]];
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
      code: 'Ok',
      waypoints: coordenadas.map(location => ({ location })),
      routes: [{ legs: [{}, {}], geometry: { type: 'LineString', coordinates: geometria } }],
    }) });
  });
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  const trazar = pagina.getByRole('button', { name: 'Seguir calles y quitar puntos cercanos', exact: true });
  await trazar.click();
  expect(consultas).toBe(0);
  confirmar = true;
  await trazar.click();
  await expect(pagina.locator('#aviso-trazado-calles')).toContainText('1 puntos cercanos agrupados, 3 puntos de paso y 5 vertices');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('5');
  await expect(pagina.locator('#lista-borrador li').nth(1)).toContainText('4.65100, -74.05960');
  await expect(pagina.locator('#lista-borrador li').nth(3)).toContainText('4.65100, -74.05960');
  expect(datos.puntos).toEqual(originales);
  expect(datos.versiones).toHaveLength(0);
  await pagina.getByRole('button', { name: 'Cancelar edicion', exact: true }).click();
  expect(datos.puntos).toEqual(originales);
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await expect(pagina.locator('#aviso-trazado-calles')).toBeHidden();
  await trazar.click();
  await expect(pagina.locator('#aviso-trazado-calles')).toBeVisible();
  await pagina.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('5');
  expect(datos.versiones).toHaveLength(1);
  expect(datos.versiones[0].contenido.puntos).toEqual(originales);
  expect(datos.puntos.map(p => [p.longitud, p.latitud])).toEqual(geometria);
  expect(datos.puntos.every(p => p.precision === null)).toBe(true);
  await pagina.locator('#refresh').click();
  await expect(pagina.locator('#stat-points')).toHaveText('5');
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await expect(pagina.locator('#lista-borrador li').nth(1)).toContainText('4.65100, -74.05960');
});

for (const tipo of ['fallo', 'cancelacion']) {
  test(`trazar calles conserva todo el borrador ante ${tipo} entre tramos`, async ({ page: pagina }) => {
    const datos = await prepararEditor(pagina);
    datos.puntos = Array.from({ length: 11 }, (_, indice) => ({
      ...datos.puntos[0], id: crypto.randomUUID(), latitud: 4.65 + indice * 0.0002,
    }));
    await pagina.locator('#refresh').click();
    await expect(pagina.locator('#stat-points')).toHaveText('11');
    const originales = structuredClone(datos.puntos);
    pagina.on('dialog', dialogo => dialogo.accept());
    await pagina.clock.install();
    let consultas = 0;
    await pagina.route('https://router.project-osrm.org/**', async solicitud => {
      consultas += 1;
      if (consultas === 2) {
        await solicitud.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'NoRoute' }) });
        return;
      }
      const direccion = new URL(solicitud.request().url());
      const coordenadas = direccion.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
      await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
        code: 'Ok', waypoints: coordenadas.map(location => ({ location })),
        routes: [{ legs: coordenadas.slice(1).map(() => ({})), geometry: { type: 'LineString', coordinates: coordenadas } }],
      }) });
    });
    await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
    await pagina.getByRole('button', { name: 'Seguir calles y quitar puntos cercanos', exact: true }).click();
    await expect(pagina.locator('#message')).toContainText('tramo 1 de 2');
    await expect.poll(() => consultas).toBe(1);
    if (tipo === 'cancelacion') {
      await pagina.getByRole('button', { name: 'Cancelar ajuste', exact: true }).click();
      await expect(pagina.locator('#message')).toContainText('Ajuste cancelado');
      await pagina.clock.runFor(3000);
      expect(consultas).toBe(1);
    } else {
      await pagina.clock.runFor(1200);
      await expect(pagina.locator('#message')).toContainText('HTTP 400, NoRoute');
    }
    await expect(pagina.locator('#aviso-trazado-calles')).toBeHidden();
    await expect(pagina.locator('#cantidad-borrador')).toHaveText('11');
    for (const [indice, punto] of originales.entries()) {
      await expect(pagina.locator('#lista-borrador li').nth(indice)).toContainText(`${punto.latitud.toFixed(5)}, ${punto.longitud.toFixed(5)}`);
    }
    expect(datos.puntos).toEqual(originales);
    expect(datos.versiones).toHaveLength(0);
  });
}

test('tras fallar Match no agrega rodeos de Route ni mezcla el borrador con propuestas anteriores', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  const originales = structuredClone(datos.puntos);
  pagina.on('dialog', dialogo => dialogo.accept());
  await pagina.route('https://router.project-osrm.org/**', async solicitud => {
    const direccion = new URL(solicitud.request().url());
    if (direccion.pathname.includes('/match/')) {
      await solicitud.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({
        code: 'TooBig', message: 'Radius search size is too large for map matching.',
      }) });
      return;
    }
    expect(direccion.pathname).toContain('/route/');
    const coordenadas = direccion.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
    expect(coordenadas).toEqual([[-74.06, 4.65], [-74.059, 4.652], [-74.06, 4.65]]);
    const rodeo = [-74.057, 4.652];
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
      code: 'Ok', waypoints: coordenadas.map(location => ({ location })),
      routes: [{ legs: [{}, {}], geometry: { type: 'LineString', coordinates: [
        coordenadas[0], rodeo, coordenadas[1], coordenadas[2],
      ] } }],
    }) });
  });
  await pagina.getByRole('button', { name: 'Ajustar a calles', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('no es un exceso de puntos');
  await pagina.getByRole('button', { name: 'Seguir calles y quitar puntos cercanos', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('No se agregaron otras calles');
  await expect(pagina.locator('#diagnostico-ajuste')).toContainText('1, 3');
  await expect(pagina.locator('#aviso-trazado-calles')).toBeHidden();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  for (const [indice, punto] of originales.entries()) {
    await expect(pagina.locator('#lista-borrador li').nth(indice)).toContainText(`${punto.latitud.toFixed(5)}, ${punto.longitud.toFixed(5)}`);
  }
  expect(datos.puntos).toEqual(originales);
  expect(datos.versiones).toHaveLength(0);
});

test('acerca puntos con consentimiento, permite cancelar la propuesta y guarda con respaldo al confirmar', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  const originales = structuredClone(datos.puntos);
  let confirmar = false;
  let consultas = 0;
  pagina.on('dialog', dialogo => confirmar ? dialogo.accept() : dialogo.dismiss());
  await pagina.clock.install();
  await pagina.route('https://router.project-osrm.org/**', async solicitud => {
    const direccion = new URL(solicitud.request().url());
    expect(direccion.pathname).toContain('/nearest/v1/driving/');
    const [longitud, latitud] = direccion.pathname.split('/').at(-1).split(',').map(Number);
    consultas += 1;
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
      code: 'Ok', waypoints: [{ location: [longitud + 0.0001, latitud] }],
    }) });
  });
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await pagina.getByRole('button', { name: 'Acercar puntos a calles', exact: true }).click();
  expect(consultas).toBe(0);
  confirmar = true;
  await pagina.getByRole('button', { name: 'Acercar puntos a calles', exact: true }).click();
  for (let indice = 0; indice < 4; indice += 1) {
    await expect.poll(() => consultas).toBe(indice + 1);
    await pagina.clock.runFor(1200);
  }
  await expect(pagina.locator('#aviso-puntos-acercados')).toBeVisible();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
  await expect(pagina.locator('#lista-borrador li').first()).toContainText('-74.05990');
  expect(datos.puntos).toEqual(originales);
  expect(datos.versiones).toHaveLength(0);
  await pagina.getByRole('button', { name: 'Cancelar edicion', exact: true }).click();
  expect(datos.puntos).toEqual(originales);
  await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
  await expect(pagina.locator('#aviso-puntos-acercados')).toBeHidden();
  await pagina.getByRole('button', { name: 'Acercar puntos a calles', exact: true }).click();
  for (let indice = 0; indice < 4; indice += 1) {
    await expect.poll(() => consultas).toBe(indice + 5);
    await pagina.clock.runFor(1200);
  }
  await expect(pagina.locator('#aviso-puntos-acercados')).toBeVisible();
  await pagina.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('4');
  expect(datos.versiones).toHaveLength(1);
  expect(datos.versiones[0].contenido.puntos).toEqual(originales);
  expect(datos.puntos.map(p => p.longitud)).toEqual(originales.map(p => p.longitud + 0.0001));
  expect(datos.puntos.every(p => p.precision === null)).toBe(true);
});

for (const tipo of ['fallo', 'cancelacion']) {
  test(`conserva el borrador completo al acercar puntos ante ${tipo}`, async ({ page: pagina }) => {
    const datos = await prepararEditor(pagina);
    const originales = structuredClone(datos.puntos);
    pagina.on('dialog', dialogo => dialogo.accept());
    await pagina.clock.install();
    let consultas = 0;
    await pagina.route('https://router.project-osrm.org/**', async solicitud => {
      consultas += 1;
      if (consultas === 2) {
        await solicitud.fulfill({ status: 503, body: 'No disponible' });
        return;
      }
      await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
        code: 'Ok', waypoints: [{ location: [originales[0].longitud + 0.0001, originales[0].latitud] }],
      }) });
    });
    await pagina.getByRole('button', { name: 'Editar ruta', exact: true }).click();
    await pagina.getByRole('button', { name: 'Acercar puntos a calles', exact: true }).click();
    await expect(pagina.locator('#message')).toContainText('punto 1 de 4');
    await expect.poll(() => consultas).toBe(1);
    if (tipo === 'cancelacion') {
      await pagina.getByRole('button', { name: 'Cancelar ajuste', exact: true }).click();
      await expect(pagina.locator('#message')).toContainText('Ajuste cancelado');
      await pagina.clock.runFor(3000);
      expect(consultas).toBe(1);
    } else {
      await pagina.clock.runFor(1200);
      await expect(pagina.locator('#message')).toContainText('HTTP 503');
    }
    await expect(pagina.locator('#aviso-puntos-acercados')).toBeHidden();
    await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
    for (const [indice, punto] of originales.entries()) {
      await expect(pagina.locator('#lista-borrador li').nth(indice)).toContainText(`${punto.latitud.toFixed(5)}, ${punto.longitud.toFixed(5)}`);
    }
    expect(datos.puntos).toEqual(originales);
    expect(datos.versiones).toHaveLength(0);
  });
}

for (const tipo of ['omitido', 'separado', 'confianza']) {
  test(`senala un ajuste ${tipo} sin modificar GPS ni guardar, y limpia las marcas al editar`, async ({ page: pagina }) => {
    const datos = await prepararEditor(pagina);
    const originales = structuredClone(datos.puntos);
    pagina.on('dialog', dialogo => dialogo.accept());
    await pagina.route('https://router.project-osrm.org/**', async solicitud => {
      const direccion = new URL(solicitud.request().url());
      const coordenadas = direccion.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
      const respuesta = {
        code: 'Ok',
        tracepoints: coordenadas.map((location, indice) => ({ location, matchings_index: 0, waypoint_index: indice })),
        matchings: [{ confidence: 0.9, geometry: { type: 'LineString', coordinates: coordenadas } }],
      };
      if (tipo === 'omitido') respuesta.tracepoints[1] = null;
      if (tipo === 'separado') {
        respuesta.matchings.push(structuredClone(respuesta.matchings[0]));
        respuesta.tracepoints[2].matchings_index = 1;
      }
      if (tipo === 'confianza') respuesta.matchings[0].confidence = 0.2;
      await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify(respuesta) });
    });
    await pagina.getByRole('button', { name: 'Ajustar a calles', exact: true }).click();
    await expect(pagina.locator('#diagnostico-ajuste')).toBeVisible();
    await expect(pagina.locator('#diagnostico-ajuste')).toContainText('El borrador no ha cambiado');
    const indices = tipo === 'omitido' ? [2] : tipo === 'separado' ? [2, 3] : [0, 2, 3];
    for (const indice of indices) {
      await expect(pagina.locator('#lista-borrador li').nth(indice)).toContainText('Revisar ajuste');
      const marcador = pagina.locator('.marcador-borrador').nth(indice);
      await expect(marcador).toHaveClass(/marcador-revisar/);
      await expect(marcador).toHaveAttribute('title', /Revisar ajuste/);
      await expect(marcador.locator('span')).toHaveCSS('background-color', 'rgb(0, 87, 217)');
      await expect(marcador.locator('span')).toHaveCSS('outline-width', '3px');
      await expect(pagina.locator('#lista-borrador li').nth(indice)).toHaveClass(/punto-revisar/);
    }
    await expect(pagina.locator('#cantidad-borrador')).toHaveText('4');
    expect(datos.puntos).toEqual(originales);
    expect(datos.versiones).toHaveLength(0);
    await pagina.getByRole('button', { name: 'Mover punto 3', exact: true }).click();
    await pagina.getByLabel('latitud del punto 3').fill('4.6521');
    await pagina.getByRole('button', { name: 'Aplicar punto 3', exact: true }).click();
    await expect(pagina.locator('#diagnostico-ajuste')).toBeHidden();
    await expect(pagina.locator('#lista-borrador')).not.toContainText('Revisar ajuste');
    await expect(pagina.locator('.marcador-revisar')).toHaveCount(0);
    await expect(pagina.locator('.punto-revisar')).toHaveCount(0);
    expect(datos.puntos).toEqual(originales);
  });
}

test('ajusta mas de diez puntos con tramos verificados y permite cancelar sin perder el borrador', async ({ page: pagina }) => {
  const datos = await prepararEditor(pagina);
  datos.puntos = Array.from({ length: 14 }, (_, indice) => ({
    ...datos.puntos[0], id: crypto.randomUUID(), latitud: 4.65 + indice * 0.0002,
    registrado_en: new Date(Date.parse(datos.puntos[0].registrado_en) + indice * 5000).toISOString(),
  }));
  await pagina.getByRole('button', { name: 'Actualizar rutas' }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('14');
  pagina.on('dialog', dialogo => dialogo.accept());
  await pagina.clock.install();
  const tamanos = [];
  await pagina.route('https://router.project-osrm.org/**', async solicitud => {
    const coordenadas = new URL(solicitud.request().url()).pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
    tamanos.push(coordenadas.length);
    await solicitud.fulfill({ contentType: 'application/json', body: JSON.stringify({
      code: 'Ok', matchings: [{ confidence: 0.9, geometry: { type: 'LineString', coordinates: coordenadas } }],
      tracepoints: coordenadas.map((location, indice) => ({ location, matchings_index: 0, waypoint_index: indice })),
    }) });
  });
  await pagina.getByRole('button', { name: 'Ajustar a calles', exact: true }).click();
  await expect.poll(() => tamanos.length).toBe(1);
  await pagina.getByRole('button', { name: 'Cancelar ajuste', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('Ajuste cancelado');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('14');
  await pagina.clock.runFor(1500);
  expect(tamanos).toEqual([10]);
  await pagina.getByRole('button', { name: 'Ajustar recorrido a calles', exact: true }).click();
  await expect.poll(() => tamanos.length).toBe(2);
  await pagina.clock.runFor(1500);
  await expect(pagina.locator('#message')).toContainText('Vista previa ajustada');
  expect(tamanos).toEqual([10, 10, 7]);
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('14');
  expect(datos.versiones).toHaveLength(0);
});
