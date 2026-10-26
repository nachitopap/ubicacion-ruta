import { test, expect } from '@playwright/test';
import { readFile as leerArchivo } from 'node:fs/promises';

async function comprobarFlechas(pagina) {
  await expect.poll(() => pagina.evaluate(() => {
    const marcadores = [...document.querySelectorAll('.marcador-ruta')];
    return [...document.querySelectorAll('.flecha-recorrido')].every(flecha => {
      const numeros = flecha.getAttribute('aria-label').match(/\d+/g).map(Number);
      const inicio = marcadores[numeros[0] - 1].getBoundingClientRect();
      const fin = marcadores[numeros[1] - 1].getBoundingClientRect();
      const esperado = Math.atan2(fin.y - inicio.y, fin.x - inicio.x) * 180 / Math.PI + 90;
      const actual = Number(flecha.style.transform.match(/rotate\(([^)]+)deg\)/)[1]);
      const diferencia = ((actual - esperado + 540) % 360) - 180;
      const centro = flecha.parentElement.getBoundingClientRect();
      return Math.abs(diferencia) < 2 &&
        Math.abs(centro.x - (inicio.x + fin.x) / 2 - 2) < 2 &&
        Math.abs(centro.y - (inicio.y + fin.y) / 2 - 2) < 2;
    });
  })).toBe(true);
}

test('el registro solicita volver a la app al confirmar el correo', async ({ page: pagina }) => {
  let direccionRetorno;
  await pagina.route('https://*.supabase.co/auth/v1/signup**', async solicitud => {
    direccionRetorno = new URL(solicitud.request().url()).searchParams.get('redirect_to');
    await solicitud.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: '11111111-1111-4111-8111-111111111111', email: 'prueba@example.com' }, session: null }),
    });
  });
  await pagina.goto('/');
  await pagina.getByLabel('Correo electronico').fill('prueba@example.com');
  await pagina.locator('#auth-form').getByLabel('Contrasena', { exact: true }).fill('contrasena-solo-de-prueba');
  await pagina.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('Cuenta solicitada');
  expect(direccionRetorno).toBe(new URL(pagina.url()).origin + '/');
  await expect(pagina.getByRole('heading', { name: 'Tus recorridos' })).toBeVisible();
});

test('crear ruta requiere sesion y no permite marcar como visitante', async ({ page: pagina }) => {
  await pagina.goto('/?vista=manual');
  await expect(pagina.getByRole('heading', { name: 'Tus recorridos' })).toBeVisible();
  await expect(pagina.locator('#panel-ruta-manual')).toBeHidden();
  await pagina.locator('#map').click({ position: { x: 140, y: 150 } });
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('0');
});

test('acceso, mapa y controles sin sesion en escritorio y movil', async ({ page: pagina }, informacionPrueba) => {
  const errores = [];
  const respuestasMapa = [];
  pagina.on('pageerror', error => errores.push(error.message));
  pagina.on('response', respuesta => {
    if (respuesta.url().startsWith('https://server.arcgisonline.com/')) respuestasMapa.push(respuesta.status());
  });
  await pagina.goto('/');
  await expect(pagina.getByRole('heading', { name: 'Tus recorridos' })).toBeVisible();
  await expect(pagina.locator('#message')).toContainText('Inicia sesion');
  await expect(pagina.locator('#record')).toBeHidden();
  await pagina.locator('#map').scrollIntoViewIfNeeded();
  await expect.poll(() => pagina.locator('.leaflet-tile-loaded').count(), { timeout: 30000 }).toBeGreaterThan(0);
  expect(respuestasMapa.length).toBeGreaterThan(0);
  expect(respuestasMapa.every(estado => estado === 200)).toBe(true);
  await expect(pagina.locator('.leaflet-tile-pane img').first()).toHaveAttribute('src', /server\.arcgisonline\.com/);
  await expect(pagina.locator('.leaflet-control-attribution')).toContainText('Esri');
  await expect.poll(() => pagina.evaluate(() => {
    const lienzo = document.createElement('canvas');
    lienzo.width = lienzo.height = 32;
    const contexto = lienzo.getContext('2d');
    let pixelesAgua = 0;
    for (const imagen of document.querySelectorAll('.leaflet-tile-loaded')) {
      contexto.clearRect(0, 0, 32, 32);
      contexto.drawImage(imagen, 0, 0, 32, 32);
      const pixeles = contexto.getImageData(0, 0, 32, 32).data;
      for (let indice = 0; indice < pixeles.length; indice += 4) {
        if (pixeles[indice + 2] > pixeles[indice] + 15 && pixeles[indice + 1] > pixeles[indice] + 5) pixelesAgua += 1;
      }
    }
    return pixelesAgua;
  }), { timeout: 30000 }).toBeGreaterThan(100);
  await expect(pagina.locator('#estado-mapa')).toBeHidden();
  expect(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await pagina.screenshot({ path: informacionPrueba.outputPath('mapa.png'), fullPage: true });
  expect(errores).toEqual([]);
});

test('avisa si falla el proveedor y permite reintentar sin tocar las rutas', async ({ page: pagina }) => {
  const proveedor = 'https://server.arcgisonline.com/**';
  await pagina.route(proveedor, solicitud => solicitud.fulfill({ status: 403, body: 'No disponible' }));
  await pagina.goto('/');
  await expect(pagina.locator('#estado-mapa')).toBeVisible();
  await expect(pagina.locator('#estado-mapa')).toContainText('No se pudo cargar el mapa');
  await pagina.unroute(proveedor);
  await pagina.getByRole('button', { name: 'Reintentar mapa' }).click();
  await expect.poll(() => pagina.locator('.leaflet-tile-loaded').count(), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(pagina.locator('#estado-mapa')).toBeHidden();
});

test('registro manual y automatico, bloqueo de pantalla, exportacion y cierre de sesion', async ({ page: pagina, context: contexto }, informacionPrueba) => {
  await pagina.addInitScript(() => {
    window.pruebaPantalla = { solicitudes: 0, liberaciones: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request: async tipo => {
        if (tipo !== 'screen') throw new Error('Tipo de bloqueo incorrecto');
        window.pruebaPantalla.solicitudes += 1;
        const bloqueo = new EventTarget();
        bloqueo.released = false;
        bloqueo.release = async () => {
          bloqueo.released = true;
          window.pruebaPantalla.liberaciones += 1;
          bloqueo.dispatchEvent(new Event('release'));
        };
        return bloqueo;
      },
    } });
  });
  const usuarioId = '11111111-1111-4111-8111-111111111111';
  const rutaId = '22222222-2222-4222-8222-222222222222';
  const usuario = { id: usuarioId, aud: 'authenticated', role: 'authenticated', email: 'prueba@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const rutas = [];
  const puntos = [];
  let fallarGuardadoManual = true;
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: usuarioId, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url'),
    'test-signature',
  ].join('.');
  await pagina.route('https://*.supabase.co/**', async solicitud => {
    const direccion = new URL(solicitud.request().url());
    const metodo = solicitud.request().method();
    let respuesta = null;
    if (direccion.pathname.endsWith('/token')) respuesta = { access_token: token, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer', user: usuario };
    else if (direccion.pathname.endsWith('/user')) respuesta = usuario;
    else if (direccion.pathname.endsWith('/rpc/crear_ruta_manual')) {
      if (fallarGuardadoManual) {
        fallarGuardadoManual = false;
        await solicitud.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'Fallo simulado al guardar' }) });
        return;
      }
      const datos = solicitud.request().postDataJSON();
      const identificador = crypto.randomUUID();
      const instante = Date.now();
      rutas.push({ id: identificador, usuario_id: usuarioId, nombre: datos.nombre_ruta, creado_en: new Date(instante).toISOString() });
      puntos.push(...datos.coordenadas.map((punto, indice) => ({
        ...punto, id: crypto.randomUUID(), ruta_id: identificador, usuario_id: usuarioId,
        precision: null, registrado_en: new Date(instante + indice).toISOString(),
      })));
      respuesta = identificador;
    }
    else if (direccion.pathname.endsWith('/rutas')) {
      if (metodo === 'POST') {
        const ruta = { id: rutas.length ? crypto.randomUUID() : rutaId, ...solicitud.request().postDataJSON(), creado_en: new Date().toISOString() };
        rutas.push(ruta);
        respuesta = ruta;
      } else respuesta = rutas;
    } else if (direccion.pathname.endsWith('/puntos_ruta')) {
      if (metodo === 'POST') puntos.push({ id: crypto.randomUUID(), ...solicitud.request().postDataJSON() });
      else respuesta = puntos.filter(punto => `eq.${punto.ruta_id}` === direccion.searchParams.get('ruta_id'));
    }
    await solicitud.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(respuesta) });
  });
  await contexto.grantPermissions(['geolocation']);
  await contexto.setGeolocation({ latitude: 4.65, longitude: -74.06, accuracy: 12 });
  await pagina.clock.install();
  await pagina.goto('/?vista=captura');
  await expect(pagina.locator('#pantalla-mapa')).toBeHidden();
  await pagina.getByLabel('Correo electronico').fill(usuario.email);
  await pagina.locator('#auth-form').getByLabel('Contrasena', { exact: true }).fill('solo-contrasena-de-prueba');
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Tomar ubicacion', exact: true })).toBeVisible();
  await pagina.locator('#nueva-ruta-captura summary').click();
  await pagina.getByLabel('Nombre de la ruta').fill('Paseo de prueba');
  await pagina.getByRole('button', { name: 'Crear ruta desde el telefono' }).click();
  await expect(pagina.locator('#message')).toHaveText('Ruta creada.');
  await pagina.getByRole('link', { name: 'Mapa', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Cuaderno de rutas' })).toBeVisible();
  await expect(pagina.getByRole('button', { name: 'Registrar ubicacion' })).toBeHidden();
  await pagina.getByRole('link', { name: 'Tomar ubicacion', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Tomar ubicacion', exact: true })).toBeVisible();
  await expect(pagina.locator('#pantalla-mapa')).toBeHidden();
  await pagina.getByRole('button', { name: 'Registrar ubicacion' }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('1');
  expect(puntos[0]).toMatchObject({ latitud: 4.65, longitud: -74.06, usuario_id: usuarioId, ruta_id: rutaId });
  await contexto.setGeolocation({ latitude: 4.66, longitude: -74.05, accuracy: 14 });
  await pagina.getByRole('button', { name: 'Registrar ubicacion' }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('2');
  await expect(pagina.locator('#puntos-capturados')).toHaveText('2');
  await pagina.getByRole('link', { name: 'Mapa', exact: true }).click();
  await expect(pagina.locator('.marcador-ruta')).toHaveText(['1', '2']);
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(1);
  await expect(pagina.getByRole('img', { name: 'Del punto 1 al punto 2', exact: true })).toBeVisible();
  await expect(pagina.locator('#point-list li').first()).toContainText('Inicio del recorrido. Hacia el punto 2');
  await expect(pagina.locator('#point-list li').last()).toContainText('Fin del recorrido');
  await comprobarFlechas(pagina);
  await pagina.locator('.marcador-ruta').first().click();
  await expect(pagina.locator('.leaflet-popup-content')).toContainText('Inicio del recorrido. Hacia el punto 2');
  await pagina.locator('.leaflet-popup-close-button').click();
  await pagina.locator('.leaflet-control-zoom-in').click();
  await comprobarFlechas(pagina);
  const eventoDescarga = pagina.waitForEvent('download');
  await pagina.getByRole('button', { name: 'Exportar', exact: true }).click();
  const descarga = await eventoDescarga;
  const exportado = JSON.parse(await leerArchivo(await descarga.path(), 'utf8'));
  expect(exportado.features[0].geometry.coordinates).toEqual([[-74.06, 4.65], [-74.05, 4.66]]);
  await pagina.screenshot({ path: informacionPrueba.outputPath('ruta.png'), fullPage: true });
  expect(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await pagina.getByRole('link', { name: 'Tomar ubicacion', exact: true }).click();
  await pagina.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('3');
  await expect(pagina.locator('#estado-pantalla')).toHaveText('Pantalla encendida');
  await expect(pagina.getByRole('button', { name: 'Desactivar', exact: true })).toBeEnabled();
  await expect(pagina.getByLabel('Ruta para registrar')).toBeDisabled();
  await pagina.clock.runFor(10000);
  await expect(pagina.locator('#stat-points')).toHaveText('4');
  await pagina.getByRole('button', { name: 'Desactivar', exact: true }).click();
  await expect.poll(() => pagina.evaluate(() => window.pruebaPantalla.liberaciones)).toBe(1);
  await pagina.clock.runFor(20000);
  await expect(pagina.locator('#stat-points')).toHaveText('4');
  await pagina.getByLabel('Intervalo', { exact: true }).selectOption('5');
  await pagina.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(pagina.locator('#stat-points')).toHaveText('5');
  await pagina.clock.runFor(5000);
  await expect(pagina.locator('#stat-points')).toHaveText('6');
  await pagina.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(pagina.locator('#estado-seguimiento')).toHaveText('Registro desactivado');
  await expect.poll(() => pagina.evaluate(() => window.pruebaPantalla.liberaciones)).toBe(2);
  await pagina.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pagina.clock.runFor(10000);
  await expect(pagina.locator('#stat-points')).toHaveText('6');
  await expect(pagina.locator('#puntos-capturados')).toHaveText('6');
  await pagina.screenshot({ path: informacionPrueba.outputPath('seguimiento.png'), fullPage: true });
  await pagina.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(pagina.locator('#puntos-capturados')).toHaveText('7');
  await pagina.screenshot({ path: informacionPrueba.outputPath('captura-activa.png'), fullPage: true });
  await pagina.getByRole('link', { name: 'Mapa', exact: true }).click();
  await expect.poll(() => pagina.evaluate(() => window.pruebaPantalla.liberaciones)).toBe(3);
  await expect(pagina.locator('#pantalla-captura')).toBeHidden();
  await expect(pagina.locator('#map')).toBeVisible();
  await pagina.goBack();
  await expect(pagina.getByRole('heading', { name: 'Tomar ubicacion', exact: true })).toBeVisible();
  await expect(pagina.getByRole('button', { name: 'Desactivar', exact: true })).toBeDisabled();
  await pagina.clock.runFor(10000);
  await expect(pagina.locator('#puntos-capturados')).toHaveText('7');
  expect(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await contexto.clearPermissions();
  await pagina.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (_alObtenerPosicion, alFallar) => alFallar({ code: 1 });
  });
  await pagina.getByRole('button', { name: 'Registrar ubicacion' }).click();
  await expect(pagina.locator('#message')).toContainText('Permiso de ubicacion denegado');
  expect(puntos).toHaveLength(7);
  await pagina.locator('#nueva-ruta-captura summary').click();
  await pagina.getByLabel('Nombre de la ruta').fill('Segunda ruta');
  await pagina.getByRole('button', { name: 'Crear ruta desde el telefono' }).click();
  await expect(pagina.locator('#puntos-capturados')).toHaveText('0');
  await expect(pagina.locator('.marcador-ruta')).toHaveCount(0);
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(0);
  await pagina.getByLabel('Ruta para registrar').selectOption(rutaId);
  await expect(pagina.locator('#puntos-capturados')).toHaveText('7');
  await expect(pagina.locator('.marcador-ruta')).toHaveCount(7);
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(1);
  await pagina.getByRole('link', { name: 'Crear ruta', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Crear ruta', exact: true })).toBeVisible();
  await expect(pagina.locator('#guardar-ruta-manual')).toBeDisabled();
  await pagina.getByLabel('Nombre del recorrido').fill('Ruta dibujada en PC');
  const dimensiones = await pagina.locator('#map').boundingBox();
  await pagina.locator('#map').click({ position: { x: dimensiones.width * 0.3, y: dimensiones.height * 0.35 } });
  await pagina.locator('#map').click({ position: { x: dimensiones.width * 0.55, y: dimensiones.height * 0.6 } });
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('2');
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(1);
  await comprobarFlechas(pagina);
  await pagina.getByRole('button', { name: 'Deshacer ultimo punto' }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('1');
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(0);
  await expect(pagina.locator('#lista-borrador')).toContainText('Inicio y fin del recorrido');
  await expect(pagina.locator('#guardar-ruta-manual')).toBeDisabled();
  await pagina.locator('#map').click({ position: { x: dimensiones.width * 0.55, y: dimensiones.height * 0.6 } });
  await pagina.locator('#map').click({ position: { x: dimensiones.width * 0.75, y: dimensiones.height * 0.4 } });
  await expect(pagina.locator('.marcador-borrador')).toHaveCount(3);
  await expect(pagina.locator('.marcador-borrador')).toHaveText(['1', '2', '3']);
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(2);
  await comprobarFlechas(pagina);
  await pagina.screenshot({ path: informacionPrueba.outputPath('ruta-manual.png'), fullPage: true });
  await pagina.getByRole('link', { name: 'Mapa', exact: true }).click();
  await expect(pagina.locator('.marcador-borrador')).toHaveCount(0);
  await pagina.getByRole('link', { name: 'Crear ruta', exact: true }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('3');
  await pagina.getByRole('button', { name: 'Guardar ruta', exact: true }).click();
  await expect(pagina.locator('#message')).toContainText('Fallo simulado al guardar');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('3');
  await pagina.getByRole('button', { name: 'Guardar ruta', exact: true }).click();
  await expect(pagina.locator('#message')).toHaveText('Ruta manual guardada.');
  await expect(pagina.locator('#map-title')).toHaveText('Ruta dibujada en PC');
  await expect(pagina.locator('.marcador-ruta')).toHaveText(['1', '2', '3']);
  await expect(pagina.locator('.flecha-recorrido')).toHaveCount(2);
  await comprobarFlechas(pagina);
  await expect(pagina.locator('#stat-points')).toHaveText('3');
  await expect(pagina.locator('#point-list')).toContainText('Manual');
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('0');
  expect(puntos.filter(punto => punto.precision === null)).toHaveLength(3);
  await pagina.getByRole('link', { name: 'Crear ruta', exact: true }).click();
  await pagina.locator('#map').click({ position: { x: dimensiones.width * 0.45, y: dimensiones.height * 0.45 } });
  pagina.once('dialog', dialogo => dialogo.accept());
  await pagina.getByRole('button', { name: 'Borrar todos los puntos' }).click();
  await expect(pagina.locator('#cantidad-borrador')).toHaveText('0');
  await pagina.getByRole('button', { name: 'Cerrar sesion', exact: true }).click();
  await expect(pagina.getByRole('heading', { name: 'Tus recorridos' })).toBeVisible();
  await expect(pagina.locator('#stat-points')).toHaveText('0');
});