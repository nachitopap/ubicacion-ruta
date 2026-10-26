import { createClient as crearCliente } from '@supabase/supabase-js';
import L from 'leaflet';
import { createIcons as crearIconos, Route, LogOut, LogIn, UserPlus, Check, Plus, MapPinPlus, Download, Scan, RefreshCw, Trash2, LockKeyhole, Play, Square, MapPinned, Undo2, Save } from 'lucide';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { ubicacionDesdePosicion, convertirAGeoJSON } from './route.js';
import { crearSeguimiento } from './seguimiento.js';
import { ajustarACalles, acercarPuntosACalles, trazarPorCalles, ErrorAjuste } from './ajuste.js';

const supabase = crearCliente(
  'https://tulxuvqsgdrhnaobgxcp.supabase.co',
  'sb_publishable_RltirWM3ex5B8faZaA0ydg_deIdy4M2',
);
const elemento = identificador => document.getElementById(identificador);
const estado = { usuario: null, rutas: [], puntos: [], rutaId: '', ocupado: false, recuperacion: false, revision: 0 };
function vistaDesdeDireccion() {
  const vista = new URLSearchParams(window.location.search).get('vista');
  return ['captura', 'manual'].includes(vista) ? vista : 'mapa';
}
let vistaActual = vistaDesdeDireccion();
let borrador = [];
let edicion = null;
let revisionBorrador = 0;
let ajusteEnCurso = null;
let diagnosticoAjuste = null;
let revisionAcercada = -1;
let revisionTrazada = -1;
let estadoSeguimiento = { activo: false, enCurso: false, pantalla: 'Pantalla sin bloqueo' };
const seguimiento = crearSeguimiento({
  registrar: async sigueVigente => {
    if (estado.ocupado) throw new Error('Hay otra operacion en curso.');
    estado.ocupado = true;
    actualizarControles();
    try { await registrarUbicacion(sigueVigente); }
    finally { estado.ocupado = false; actualizarControles(); }
  },
  alCambiar: nuevoEstado => {
    estadoSeguimiento = nuevoEstado;
    elemento('estado-seguimiento').textContent = nuevoEstado.activo ? 'Registro activado' : 'Registro desactivado';
    elemento('pantalla-captura').classList.toggle('registrando', nuevoEstado.activo);
    elemento('estado-pantalla').textContent = nuevoEstado.pantalla;
    if (nuevoEstado.mensaje) notificar(nuevoEstado.mensaje);
    actualizarControles();
  },
});
const formatoFecha = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' });
const mapa = L.map('map').setView([15, -60], 3);
const capaMapa = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, USGS, NGA, EPA, NPS',
  crossOrigin: 'anonymous',
  referrerPolicy: 'strict-origin-when-cross-origin',
}).addTo(mapa);
let falloMapa = false;
capaMapa.on('loading', () => { falloMapa = false; });
capaMapa.on('tileerror', () => {
  falloMapa = true;
  elemento('estado-mapa').hidden = false;
});
capaMapa.on('load', () => { elemento('estado-mapa').hidden = !falloMapa; });
elemento('reintentar-mapa').addEventListener('click', () => {
  elemento('estado-mapa').hidden = true;
  capaMapa.redraw();
});
const capaRuta = L.featureGroup().addTo(mapa);
const capaBorrador = L.featureGroup();
const capaOriginal = L.featureGroup();
crearIconos({ icons: { Route, LogOut, LogIn, UserPlus, Check, Plus, MapPinPlus, Download, Scan, RefreshCw, Trash2, LockKeyhole, Play, Square, MapPinned, Undo2, Save } });

function sentidoDelPunto(indice, cantidad) {
  if (cantidad === 1) return 'Inicio y fin del recorrido';
  if (indice === cantidad - 1) return 'Fin del recorrido';
  return `${indice === 0 ? 'Inicio del recorrido. ' : ''}Hacia el punto ${indice + 2}`;
}

function marcadorNumerado(punto, indice, cantidad, color, esBorrador = false, revisar = false) {
  const etiqueta = document.createElement('span');
  etiqueta.textContent = indice + 1;
  etiqueta.style.backgroundColor = color;
  return L.marker([punto.latitud, punto.longitud], {
    icon: L.divIcon({
      className: `marcador-ruta${esBorrador ? ' marcador-borrador' : ''}${revisar ? ' marcador-revisar' : ''}`,
      html: etiqueta,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
    title: `Punto ${indice + 1}. ${sentidoDelPunto(indice, cantidad)}${revisar ? '. Revisar ajuste: correspondencia incierta' : ''}`,
    alt: `Punto ${indice + 1}. ${sentidoDelPunto(indice, cantidad)}${revisar ? '. Revisar ajuste: correspondencia incierta' : ''}`,
    zIndexOffset: revisar ? 1000 : 0,
    keyboard: true,
    interactive: true,
    draggable: esBorrador && !estado.ocupado,
  });
}

function cambiarBorrador() {
  revisionBorrador += 1;
  if (edicion) edicion.version = null;
  mostrarBorrador();
}

function dibujarLineaConFlechas(puntos, capa, color) {
  if (puntos.length < 2) return;
  L.polyline(puntos.map(punto => [punto.latitud, punto.longitud]), { color, weight: 4 }).addTo(capa);
  const proyeccion = mapa.options.crs;
  for (let indice = 0; indice < puntos.length - 1; indice += 1) {
    const inicio = proyeccion.latLngToPoint(L.latLng(puntos[indice].latitud, puntos[indice].longitud), 0);
    const fin = proyeccion.latLngToPoint(L.latLng(puntos[indice + 1].latitud, puntos[indice + 1].longitud), 0);
    if (inicio.equals(fin)) continue;
    // Usar la misma proyeccion que la linea mantiene la flecha alineada al cambiar el zoom.
    const centro = proyeccion.pointToLatLng(inicio.add(fin).divideBy(2), 0);
    const angulo = Math.atan2(fin.y - inicio.y, fin.x - inicio.x) * 180 / Math.PI + 90;
    const flecha = document.createElement('span');
    flecha.className = 'flecha-recorrido';
    flecha.style.backgroundColor = color;
    flecha.style.transform = `rotate(${angulo}deg)`;
    flecha.setAttribute('role', 'img');
    flecha.setAttribute('aria-label', `Del punto ${indice + 1} al punto ${indice + 2}`);
    L.marker(centro, {
      icon: L.divIcon({ className: 'marcador-flecha', html: flecha, iconSize: [24, 24], iconAnchor: [12, 12] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -1000,
      title: `Del punto ${indice + 1} al punto ${indice + 2}`,
    }).addTo(capa);
  }
}

function mostrarBorrador() {
  capaBorrador.clearLayers();
  elemento('lista-borrador').replaceChildren();
  const diagnostico = diagnosticoAjuste?.revision === revisionBorrador ? diagnosticoAjuste : null;
  elemento('aviso-puntos-acercados').hidden = revisionAcercada !== revisionBorrador;
  elemento('aviso-trazado-calles').hidden = revisionTrazada !== revisionBorrador;
  elemento('diagnostico-ajuste').hidden = !diagnostico;
  elemento('diagnostico-ajuste').textContent = diagnostico
    ? `${diagnostico.mensaje} Azul con doble borde = puntos para revisar: ${diagnostico.indices.map(indice => indice + 1).join(', ')}. Rosa = resto del borrador. Las marcas indican incertidumbre, no cambios aplicados ni coordenadas incorrectas.`
    : '';
  dibujarLineaConFlechas(borrador, capaBorrador, '#b13c52');
  borrador.forEach((punto, indice) => {
    const dudoso = diagnostico?.indices.includes(indice);
    const marcador = marcadorNumerado(punto, indice, borrador.length, dudoso ? '#0057d9' : '#b13c52', true, Boolean(dudoso)).addTo(capaBorrador);
    marcador.on('dragend', () => {
      const posicion = marcador.getLatLng().wrap();
      borrador[indice] = { latitud: posicion.lat, longitud: posicion.lng };
      cambiarBorrador();
    });
    const formulario = document.createElement('form');
    for (const [campo, limite] of [['latitud', 90], ['longitud', 180]]) {
      const etiqueta = document.createElement('label');
      etiqueta.textContent = `${campo} del punto ${indice + 1}`;
      const entrada = document.createElement('input');
      entrada.name = campo;
      entrada.type = 'number';
      entrada.step = 'any';
      entrada.min = -limite;
      entrada.max = limite;
      entrada.required = true;
      entrada.value = punto[campo];
      etiqueta.append(entrada);
      formulario.append(etiqueta);
    }
    const aplicar = document.createElement('button');
    aplicar.textContent = `Aplicar punto ${indice + 1}`;
    formulario.append(aplicar);
    formulario.addEventListener('submit', evento => {
      evento.preventDefault();
      if (estado.ocupado) return;
      borrador[indice] = { latitud: Number(formulario.elements.latitud.value), longitud: Number(formulario.elements.longitud.value) };
      cambiarBorrador();
    });
    marcador.bindPopup(formulario);
    const registro = document.createElement('li');
    if (dudoso) registro.classList.add('punto-revisar');
    const detalles = document.createElement('div');
    detalles.textContent = `${indice + 1}. ${punto.latitud.toFixed(5)}, ${punto.longitud.toFixed(5)}`;
    const sentido = document.createElement('small');
    sentido.textContent = sentidoDelPunto(indice, borrador.length);
    if (dudoso) sentido.textContent += '. Revisar ajuste: correspondencia incierta';
    detalles.append(sentido);
    registro.append(detalles);
    const mover = document.createElement('button');
    mover.type = 'button';
    mover.textContent = 'Mover';
    mover.setAttribute('aria-label', `Mover punto ${indice + 1}`);
    mover.addEventListener('click', () => { mapa.panTo(marcador.getLatLng()); marcador.openPopup(); });
    const eliminar = document.createElement('button');
    eliminar.type = 'button';
    eliminar.textContent = 'Eliminar';
    eliminar.setAttribute('aria-label', `Eliminar punto ${indice + 1}`);
    eliminar.addEventListener('click', () => { borrador.splice(indice, 1); cambiarBorrador(); });
    registro.append(mover, eliminar);
    elemento('lista-borrador').append(registro);
  });
  elemento('cantidad-borrador').textContent = borrador.length;
  elemento('titulo-editor').textContent = edicion ? 'Editar ruta' : 'Crear ruta';
  elemento('texto-guardar-ruta').textContent = edicion?.version ? 'Restaurar version' : edicion ? 'Guardar cambios' : 'Guardar ruta';
  elemento('cancelar-edicion').hidden = !edicion;
  elemento('aviso-editor').textContent = edicion
    ? 'Vista previa: rosa = borrador, gris = ruta activa original. Arrastra puntos, pulsa Mover o elimina cualquiera. Guardar conserva la version anterior como respaldo inactivo.'
    : 'Arrastra los puntos para moverlos o eliminalos desde la lista.';
  actualizarControles();
}

function encuadrarBorrador() {
  if (borrador.length === 1) mapa.setView([borrador[0].latitud, borrador[0].longitud], Math.max(12, mapa.getZoom()));
  else if (borrador.length > 1) mapa.fitBounds(capaBorrador.getBounds(), { padding: [35, 35], maxZoom: 17 });
}

mapa.on('click', evento => {
  if (vistaActual !== 'manual' || !estado.usuario || estado.recuperacion || estado.ocupado) return;
  if (borrador.length >= (edicion ? 10000 : 500)) { notificar('Se alcanzo el limite de puntos del borrador.', true); return; }
  const longitud = ((evento.latlng.lng + 180) % 360 + 360) % 360 - 180;
  borrador.push({ latitud: evento.latlng.lat, longitud });
  cambiarBorrador();
});
elemento('deshacer-punto').addEventListener('click', () => { borrador.pop(); cambiarBorrador(); });
elemento('limpiar-borrador').addEventListener('click', () => {
  if (!window.confirm('Borrar todos los puntos del borrador?')) return;
  borrador = [];
  cambiarBorrador();
});
elemento('encuadrar-borrador').addEventListener('click', encuadrarBorrador);
elemento('nombre-ruta-manual').addEventListener('input', () => {
  revisionBorrador += 1;
  if (edicion) {
    edicion.version = null;
    elemento('texto-guardar-ruta').textContent = 'Guardar cambios';
  }
});
elemento('formulario-ruta-manual').addEventListener('submit', evento => {
  evento.preventDefault();
  const nombre = elemento('nombre-ruta-manual').value.trim();
  if (!nombre || borrador.length < (edicion?.version ? 0 : edicion ? 1 : 2) || !estado.usuario) return;
  if (edicion && !window.confirm('Activar esta version y guardar la anterior como respaldo inactivo? El respaldo caduca tras un mes sin consultarlo si la limpieza esta configurada.')) return;
  ejecutar(async () => {
    const rutaId = comprobar(await (edicion
      ? supabase.rpc('guardar_edicion_ruta', {
        ruta_editada: edicion.rutaId, nombre_ruta: nombre, coordenadas: borrador,
        ids_esperados: edicion.ids, version_restaurar: edicion.version,
      })
      : supabase.rpc('crear_ruta_manual', { nombre_ruta: nombre, coordenadas: borrador })));
    const eraEdicion = Boolean(edicion);
    edicion = null;
    revisionBorrador += 1;
    borrador = [];
    elemento('nombre-ruta-manual').value = '';
    mostrarBorrador();
    cambiarVista('mapa');
    await cargarRutas(rutaId);
    notificar(eraEdicion ? 'Ruta actualizada. La version anterior se conservo como respaldo inactivo.' : 'Ruta manual guardada.');
  });
});
function abrirEditor(puntos = estado.puntos, version = null, nombre = null) {
  if (borrador.length && !window.confirm('Descartar el borrador actual para editar esta ruta?')) return false;
  edicion = { rutaId: estado.rutaId, ids: estado.puntos.map(p => p.id), version };
  borrador = puntos.map(p => ({ ...p }));
  revisionBorrador += 1;
  elemento('nombre-ruta-manual').value = nombre ?? estado.rutas.find(ruta => ruta.id === estado.rutaId).nombre;
  capaOriginal.clearLayers();
  L.polyline(estado.puntos.map(p => [p.latitud, p.longitud]), { color: '#65766d', weight: 5, dashArray: '6 8', interactive: false }).addTo(capaOriginal);
  mostrarBorrador();
  cambiarVista('manual');
  return true;
}

async function ajustarBorrador(modo = 'gps') {
  const acercar = modo === 'acercar';
  const trazar = modo === 'trazar';
  const consentimiento = trazar
    ? 'Enviar las coordenadas del borrador al servidor publico de OSRM para trazar por calles? Se agrupan puntos consecutivos a menos de 10 m conservando inicio, fin y segundas pasadas. Se agregan vertices de curvas y esquinas. Se rechazan desvios de mas de 25 m respecto a cada segmento y rodeos excesivos, conservando el borrador completo. El perfil de automovil puede impedir una vuelta en U; no se reemplazara por una vuelta a la manzana. No garantiza la calle correcta. Solo para pruebas no comerciales, sin garantia de disponibilidad. Veras la propuesta antes de guardar.'
    : acercar
    ? 'Enviar las coordenadas al servidor publico de OSRM para acercar cada punto a la calle de automoviles mas cercana (maximo 100 m)? Conserva todos los puntos en su orden, pero podria elegir una calle paralela. No reconstruye curvas entre puntos. Puede tardar alrededor de un segundo por punto. Solo para pruebas no comerciales, sin garantia de disponibilidad. Veras una vista previa y no se guardara nada hasta pulsar Guardar cambios o Guardar ruta.'
    : 'Enviar las coordenadas del borrador al servidor publico de OSRM? Solo para pruebas no comerciales, sin garantia de disponibilidad. Se agrupan puntos consecutivos a menos de 10 m. El ajuste usa calles para automoviles, es una estimacion y no guarda nada hasta que lo confirmes.';
  if (!window.confirm(consentimiento)) return;
  const revision = revisionBorrador;
  ajusteEnCurso = new AbortController();
  actualizarControles();
  let resultado;
  try {
    const ajustar = trazar ? trazarPorCalles : acercar ? acercarPuntosACalles : ajustarACalles;
    resultado = await ajustar(borrador, {
      signal: ajusteEnCurso.signal,
      alAvanzar: (actual, total) => notificar(`Consultando OSRM: ${acercar ? 'punto' : 'tramo'} ${actual} de ${total}. El borrador se conserva hasta completar el ajuste.`),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ajuste cancelado. El borrador no ha cambiado.');
    if (error.name === 'TimeoutError') throw new Error('OSRM tardo demasiado en responder. El borrador no ha cambiado.');
    if (error instanceof ErrorAjuste && revision === revisionBorrador && estado.usuario) {
      diagnosticoAjuste = { revision, indices: error.indices, mensaje: error.message };
      mostrarBorrador();
    }
    throw error;
  } finally {
    ajusteEnCurso = null;
    actualizarControles();
  }
  if (revision !== revisionBorrador || !estado.usuario) throw new Error('El borrador o la sesion cambio. No se aplico el ajuste.');
  if (!edicion && resultado.puntos.length > 500) throw new Error('El ajuste supera los 500 puntos permitidos para una ruta nueva. El borrador no ha cambiado.');
  borrador = resultado.puntos;
  if (acercar) revisionAcercada = revisionBorrador + 1;
  if (trazar) {
    revisionTrazada = revisionBorrador + 1;
    elemento('aviso-trazado-calles').textContent = `Propuesta por calles sin guardar: ${resultado.puntosAgrupados} puntos cercanos agrupados, ${resultado.puntosDePaso} puntos de paso y ${resultado.puntos.length} vertices finales para seguir curvas y esquinas. Rosa = propuesta, gris = original al editar. Se comprobaron los limites de desvio de cada segmento; revisa las calles antes de guardar. No es una reconstruccion GPS garantizada.`;
  }
  cambiarBorrador();
  encuadrarBorrador();
  notificar(trazar
    ? `Vista previa por calles: ${resultado.puntosAgrupados} puntos cercanos agrupados; ${resultado.puntos.length} vertices finales, incluidas curvas y esquinas. Revisa y guarda si estas conforme. No se ha guardado nada.`
    : acercar
    ? `Vista previa: puntos acercados a calles (desplazamiento maximo: ${Math.round(resultado.desplazamientoMaximo)} m). Revisa las calles elegidas y guarda si estas conforme. No se ha guardado nada.`
    : `Vista previa ajustada (confianza OSRM: ${Math.round(resultado.confianza * 100)}%). Revisa, edita y guarda si estas conforme. No representa una medicion GPS.`);
}

elemento('editar-ruta').addEventListener('click', () => abrirEditor());
elemento('ajustar-ruta').addEventListener('click', () => {
  if (abrirEditor()) void ejecutar(ajustarBorrador);
});
elemento('ajustar-borrador').addEventListener('click', () => ejecutar(ajustarBorrador));
elemento('acercar-puntos').addEventListener('click', () => ejecutar(() => ajustarBorrador('acercar')));
elemento('trazar-calles').addEventListener('click', () => ejecutar(() => ajustarBorrador('trazar')));
elemento('cancelar-ajuste').addEventListener('click', () => ajusteEnCurso?.abort());
elemento('cancelar-edicion').addEventListener('click', () => {
  if (!window.confirm('Descartar esta vista previa? La ruta activa no cambiara.')) return;
  edicion = null;
  borrador = [];
  revisionBorrador += 1;
  elemento('nombre-ruta-manual').value = '';
  mostrarBorrador();
  cambiarVista('mapa');
  notificar('Edicion cancelada. La ruta activa no ha cambiado.');
});
elemento('ver-respaldos').addEventListener('click', () => ejecutar(async () => {
  const rutaId = estado.rutaId;
  const revision = estado.revision;
  const versiones = comprobar(await supabase.from('versiones_ruta').select('id,ruta_id,creado_en,consultada_en').eq('ruta_id', estado.rutaId).order('creado_en', { ascending: false }));
  if (revision !== estado.revision || rutaId !== estado.rutaId || !estado.usuario) throw new Error('La sesion o la ruta cambio.');
  elemento('lista-respaldos').replaceChildren();
  for (const version of versiones) {
    const registro = document.createElement('li');
    const abrir = document.createElement('button');
    abrir.textContent = `Ver respaldo del ${formatoFecha.format(new Date(version.creado_en))}`;
    abrir.addEventListener('click', () => ejecutar(async () => {
      const revision = estado.revision;
      const rutaId = estado.rutaId;
      const contenido = comprobar(await supabase.rpc('ver_version_ruta', { version_id: version.id }));
      if (revision !== estado.revision || rutaId !== estado.rutaId || !estado.usuario) throw new Error('La sesion o la ruta cambio.');
      if (abrirEditor(contenido.puntos, version.id, contenido.nombre)) {
        notificar('Respaldo abierto: plazo de un mes renovado. Guarda para restaurarlo o cancela para mantener la ruta activa.');
      }
    }));
    registro.append(abrir);
    elemento('lista-respaldos').append(registro);
  }
  notificar(versiones.length ? 'Selecciona un respaldo para verlo, editarlo o restaurarlo.' : 'Esta ruta no tiene respaldos inactivos.');
}));
window.addEventListener('beforeunload', evento => {
  if (borrador.length || edicion) { evento.preventDefault(); evento.returnValue = ''; }
});

function notificar(texto, esError = false) {
  elemento('message').textContent = texto;
  elemento('message').classList.toggle('error', esError);
}

function mostrarVista() {
  const enCaptura = vistaActual === 'captura';
  const autenticado = Boolean(estado.usuario) && !estado.recuperacion;
  document.body.dataset.vista = vistaActual;
  document.body.classList.toggle('autenticado', autenticado);
  elemento('pantalla-mapa').hidden = enCaptura;
  elemento('pantalla-captura').hidden = !enCaptura || !autenticado;
  elemento('panel-ruta-manual').hidden = vistaActual !== 'manual' || !autenticado;
  elemento('routes-panel').hidden = vistaActual !== 'mapa' || !autenticado;
  const enManual = vistaActual === 'manual' && autenticado;
  if (enManual) {
    mapa.removeLayer(capaRuta);
    if (edicion) capaOriginal.addTo(mapa);
    capaBorrador.addTo(mapa);
    elemento('map-title').textContent = edicion ? 'Vista previa de la edicion' : 'Trazar recorrido';
  } else {
    mapa.removeLayer(capaOriginal);
    mapa.removeLayer(capaBorrador);
    capaRuta.addTo(mapa);
    elemento('map-title').textContent = estado.rutas.find(ruta => ruta.id === estado.rutaId)?.nombre || 'Mi mapa';
  }
  elemento('map').classList.toggle('dibujando-ruta', enManual);
  document.querySelector('.map-summary').hidden = enManual;
  for (const enlace of document.querySelectorAll('[data-vista]')) {
    if (enlace.dataset.vista === vistaActual) enlace.setAttribute('aria-current', 'page');
    else enlace.removeAttribute('aria-current');
  }
  if (!enCaptura) requestAnimationFrame(() => { mapa.invalidateSize(); if (enManual) encuadrarBorrador(); else encuadrarRuta(); });
}

function cambiarVista(vista, guardarHistorial = true) {
  if (edicion && vista === 'captura') {
    notificar('Guarda o cancela la edicion antes de registrar nuevas ubicaciones.', true);
    return;
  }
  if (vista !== 'captura' && estadoSeguimiento.activo) seguimiento.detener('Registro desactivado al salir de Tomar ubicacion.');
  vistaActual = vista;
  if (guardarHistorial) {
    const direccion = new URL(window.location.href);
    direccion.searchParams.set('vista', vista);
    window.history.pushState(null, '', direccion);
  }
  mostrarVista();
}

for (const enlace of document.querySelectorAll('[data-vista]')) enlace.addEventListener('click', evento => {
  if (evento.ctrlKey || evento.metaKey || evento.shiftKey || evento.altKey) return;
  evento.preventDefault();
  cambiarVista(enlace.dataset.vista);
});
window.addEventListener('popstate', () => cambiarVista(vistaDesdeDireccion(), false));

function comprobar(resultado) {
  if (resultado.error) throw resultado.error;
  return resultado.data;
}

function mostrarError(error) {
  console.error(error);
  const mensajes = {
    invalid_credentials: 'Correo o contrasena incorrectos.',
    email_not_confirmed: 'Confirma tu correo antes de entrar.',
    over_email_send_rate_limit: 'Espera unos minutos antes de pedir otro correo.',
    '42P01': 'Faltan las tablas. Ejecuta supabase/schema.sql en el editor SQL de Supabase.',
    PGRST205: 'Faltan las tablas o su acceso por API. Ejecuta supabase/schema.sql en Supabase.',
    '42501': 'No tienes permiso para esta operacion. Revisa el esquema y las politicas de Supabase.',
    PGRST202: 'Falta una funcion de rutas. Ejecuta la version actual de supabase/schema.sql en Supabase.',
  };
  notificar(mensajes[error.code] || error.message || 'No se pudo completar la operacion. Intenta de nuevo.', true);
}

function actualizarControles() {
  document.querySelectorAll('button, input, select').forEach(control => { control.disabled = estado.ocupado; });
  const sinRuta = !estado.rutaId || !estado.usuario;
  elemento('cancelar-ajuste').hidden = !ajusteEnCurso;
  elemento('cancelar-ajuste').disabled = !ajusteEnCurso;
  for (const identificador of ['record', 'delete-route', 'editar-ruta', 'ver-respaldos']) elemento(identificador).disabled = estado.ocupado || sinRuta || estadoSeguimiento.activo || Boolean(edicion);
  elemento('ajustar-ruta').disabled = estado.ocupado || sinRuta || estadoSeguimiento.activo || Boolean(edicion) || estado.puntos.length < 2;
  elemento('ajustar-borrador').disabled = estado.ocupado || !estado.usuario || borrador.length < 2;
  elemento('acercar-puntos').disabled = estado.ocupado || !estado.usuario || borrador.length < 2;
  elemento('trazar-calles').disabled = estado.ocupado || !estado.usuario || borrador.length < 2;
  for (const identificador of ['export', 'fit']) elemento(identificador).disabled = estado.ocupado || sinRuta || !estado.puntos.length;
  elemento('route-select').disabled = estado.ocupado || !estado.rutas.length || estadoSeguimiento.activo || Boolean(edicion);
  elemento('ruta-captura').disabled = estado.ocupado || !estado.rutas.length || estadoSeguimiento.activo || Boolean(edicion);
  for (const control of elemento('route-form').elements) control.disabled = estado.ocupado || estadoSeguimiento.activo || Boolean(edicion);
  for (const control of elemento('formulario-ruta-captura').elements) control.disabled = estado.ocupado || estadoSeguimiento.activo || Boolean(edicion);
  elemento('refresh').disabled = estado.ocupado || estadoSeguimiento.activo || Boolean(edicion);
  elemento('intervalo').disabled = estado.ocupado || estadoSeguimiento.activo;
  elemento('mantener-pantalla').disabled = estado.ocupado || estadoSeguimiento.activo || !navigator.wakeLock || !window.isSecureContext;
  elemento('iniciar-seguimiento').disabled = estado.ocupado || sinRuta || estadoSeguimiento.activo || Boolean(edicion);
  elemento('detener-seguimiento').disabled = !estadoSeguimiento.activo;
  elemento('record').querySelector('span').textContent = estado.ocupado ? 'Procesando...' : 'Registrar ubicacion';
  elemento('guardar-ruta-manual').disabled = estado.ocupado || !estado.usuario || borrador.length < (edicion?.version ? 0 : edicion ? 1 : 2);
  for (const identificador of ['deshacer-punto', 'limpiar-borrador', 'encuadrar-borrador']) elemento(identificador).disabled = estado.ocupado || !borrador.length;
  capaBorrador.eachLayer(capa => {
    if (capa.dragging) {
      if (estado.ocupado) capa.dragging.disable();
      else capa.dragging.enable();
    }
  });
}

async function ejecutar(accion) {
  if (estado.ocupado) return;
  estado.ocupado = true;
  actualizarControles();
  try { await accion(); } catch (error) { mostrarError(error); }
  finally { estado.ocupado = false; actualizarControles(); }
}

function encuadrarRuta() {
  if (estado.puntos.length === 1) mapa.setView([estado.puntos[0].latitud, estado.puntos[0].longitud], 16);
  else if (estado.puntos.length > 1) mapa.fitBounds(capaRuta.getBounds(), { padding: [35, 35], maxZoom: 17 });
}

function mostrarPuntos() {
  capaRuta.clearLayers();
  elemento('point-list').replaceChildren();
  const coordenadas = estado.puntos.map(punto => [punto.latitud, punto.longitud]);
  dibujarLineaConFlechas(estado.puntos, capaRuta, '#147451');
  let distancia = 0;
  estado.puntos.forEach((punto, indice) => {
    const etiqueta = `${indice + 1}. ${formatoFecha.format(new Date(punto.registrado_en))}`;
    const ventana = document.createElement('div');
    ventana.textContent = `${punto.precision === null ? `${etiqueta} | Punto trazado en el mapa` : `${etiqueta} | Precision: ${Math.round(punto.precision)} m`} | ${sentidoDelPunto(indice, estado.puntos.length)}`;
    marcadorNumerado(punto, indice, estado.puntos.length, '#147451')
      .bindPopup(ventana).addTo(capaRuta);
    if (indice > 0) distancia += L.latLng(coordenadas[indice - 1]).distanceTo(coordenadas[indice]);
    const registro = document.createElement('li');
    const numero = document.createElement('span');
    numero.className = 'point-number';
    numero.textContent = indice + 1;
    const detalles = document.createElement('div');
    const titulo = document.createElement('strong');
    titulo.textContent = formatoFecha.format(new Date(punto.registrado_en));
    const subtitulo = document.createElement('small');
    subtitulo.textContent = `${punto.latitud.toFixed(5)}, ${punto.longitud.toFixed(5)} · ${punto.precision === null ? 'Manual' : `${Math.round(punto.precision)} m`}`;
    const sentido = document.createElement('small');
    sentido.textContent = sentidoDelPunto(indice, estado.puntos.length);
    detalles.append(titulo, subtitulo, sentido);
    registro.append(numero, detalles);
    elemento('point-list').append(registro);
  });
  const cantidad = String(estado.puntos.length);
  elemento('point-count').textContent = cantidad;
  elemento('stat-points').textContent = cantidad;
  elemento('puntos-capturados').textContent = cantidad;
  elemento('stat-distance').textContent = distancia >= 1000 ? `${(distancia / 1000).toFixed(2)} km` : `${Math.round(distancia)} m`;
  elemento('stat-time').textContent = estado.puntos.length ? formatoFecha.format(new Date(estado.puntos.at(-1).registrado_en)) : 'Sin registros';
  elemento('map-title').textContent = vistaActual === 'manual' ? (edicion ? 'Vista previa de la edicion' : 'Trazar recorrido') : estado.rutas.find(ruta => ruta.id === estado.rutaId)?.nombre || 'Mi mapa';
  elemento('empty-points').hidden = estado.puntos.length > 0;
  elemento('empty-points').textContent = estado.rutaId ? 'Aun no hay ubicaciones en esta ruta.' : 'Crea una ruta para comenzar.';
  actualizarControles();
}

async function cargarPuntos(limpiar = true) {
  const rutaId = estado.rutaId;
  const revision = estado.revision;
  if (limpiar) {
    elemento('lista-respaldos').replaceChildren();
    estado.puntos = [];
    mostrarPuntos();
  }
  if (!rutaId) return;
  const puntos = [];
  const tamanoPagina = 500;
  for (let desplazamiento = 0; ; desplazamiento += tamanoPagina) {
    const pagina = comprobar(await supabase.from('puntos_ruta').select('*').eq('ruta_id', rutaId)
      .order('registrado_en').order('id').range(desplazamiento, desplazamiento + tamanoPagina - 1));
    if (revision !== estado.revision || rutaId !== estado.rutaId) return;
    puntos.push(...pagina);
    if (pagina.length < tamanoPagina) break;
  }
  if (revision !== estado.revision || rutaId !== estado.rutaId) return;
  estado.puntos = puntos;
  mostrarPuntos();
  encuadrarRuta();
}

async function cargarRutas(identificadorPreferido = estado.rutaId) {
  const usuarioId = estado.usuario?.id;
  const revision = estado.revision;
  if (!usuarioId) return;
  const rutas = comprobar(await supabase.from('rutas').select('*').eq('usuario_id', usuarioId).order('creado_en', { ascending: false }));
  if (revision !== estado.revision || estado.usuario?.id !== usuarioId) return;
  estado.rutas = rutas;
  estado.rutaId = rutas.some(ruta => ruta.id === identificadorPreferido) ? identificadorPreferido : rutas[0]?.id || '';
  const opciones = rutas.map(ruta => new Option(ruta.nombre, ruta.id));
  elemento('route-select').replaceChildren(...(opciones.length ? opciones : [new Option('Sin rutas', '')]));
  elemento('route-select').value = estado.rutaId;
  elemento('ruta-captura').replaceChildren(...(rutas.length ? rutas.map(ruta => new Option(ruta.nombre, ruta.id)) : [new Option('Sin rutas', '')]));
  elemento('ruta-captura').value = estado.rutaId;
  await cargarPuntos();
}

elemento('auth-form').addEventListener('submit', evento => {
  evento.preventDefault();
  const esRegistro = evento.submitter?.value === 'signup';
  const credenciales = { email: elemento('email').value.trim(), password: elemento('password').value };
  ejecutar(async () => {
    comprobar(await (esRegistro ? supabase.auth.signUp({
      ...credenciales,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    }) : supabase.auth.signInWithPassword(credenciales)));
    elemento('password').value = '';
    notificar(esRegistro ? 'Cuenta solicitada. Si se requiere confirmacion, revisa tu correo para activarla.' : 'Sesion iniciada.');
  });
});

elemento('reset-password').addEventListener('click', () => ejecutar(async () => {
  const correo = elemento('email');
  if (!correo.value || !correo.reportValidity()) throw new Error('Escribe primero tu correo electronico.');
  comprobar(await supabase.auth.resetPasswordForEmail(correo.value.trim(), { redirectTo: window.location.origin + window.location.pathname }));
  notificar('Si existe una cuenta con ese correo, recibiras un enlace de recuperacion.');
}));

elemento('recovery-form').addEventListener('submit', evento => {
  evento.preventDefault();
  ejecutar(async () => {
    comprobar(await supabase.auth.updateUser({ password: elemento('new-password').value }));
    elemento('new-password').value = '';
    estado.recuperacion = false;
    elemento('recovery-panel').hidden = true;
    elemento('routes-panel').hidden = false;
    await cargarRutas();
    notificar('Contrasena actualizada.');
  });
});

elemento('logout').addEventListener('click', () => ejecutar(async () => {
  if (estadoSeguimiento.activo) seguimiento.detener();
  comprobar(await supabase.auth.signOut({ scope: 'local' }));
  notificar('Sesion cerrada en este dispositivo.');
}));

elemento('route-form').addEventListener('submit', evento => {
  evento.preventDefault();
  const nombre = elemento('route-name').value.trim();
  if (!nombre) return;
  ejecutar(async () => {
    const ruta = comprobar(await supabase.from('rutas').insert({ nombre, usuario_id: estado.usuario.id }).select().single());
    elemento('route-name').value = '';
    await cargarRutas(ruta.id);
    notificar('Ruta creada.');
  });
});

elemento('route-select').addEventListener('change', evento => {
  estado.rutaId = evento.target.value;
  elemento('ruta-captura').value = estado.rutaId;
  ejecutar(cargarPuntos);
});
elemento('ruta-captura').addEventListener('change', evento => {
  estado.rutaId = evento.target.value;
  elemento('route-select').value = estado.rutaId;
  ejecutar(cargarPuntos);
});
elemento('formulario-ruta-captura').addEventListener('submit', evento => {
  evento.preventDefault();
  const nombre = elemento('nombre-ruta-captura').value.trim();
  if (!nombre) return;
  ejecutar(async () => {
    const ruta = comprobar(await supabase.from('rutas').insert({ nombre, usuario_id: estado.usuario.id }).select().single());
    elemento('nombre-ruta-captura').value = '';
    elemento('nueva-ruta-captura').open = false;
    await cargarRutas(ruta.id);
    notificar('Ruta creada.');
  });
});
elemento('refresh').addEventListener('click', () => ejecutar(async () => { await cargarRutas(); notificar('Rutas actualizadas.'); }));
elemento('fit').addEventListener('click', encuadrarRuta);

async function registrarUbicacion(sigueVigente = () => true) {
  if (!window.isSecureContext) throw new Error('La ubicacion necesita HTTPS. Abre la direccion segura de la app.');
  if (!navigator.geolocation) throw new Error('Este navegador no permite obtener la ubicacion.');
  if (!navigator.onLine) throw new Error('Sin conexion. Conectate a Internet antes de registrar.');
  const rutaId = estado.rutaId;
  const usuarioId = estado.usuario.id;
  notificar('Buscando tu ubicacion...');
  const posicion = await new Promise((resolver, rechazar) => navigator.geolocation.getCurrentPosition(resolver, error => {
    rechazar(new Error({
      1: 'Permiso de ubicacion denegado. Habilitalo en los ajustes del navegador.',
      2: 'No se pudo obtener la ubicacion. Revisa el GPS del telefono.',
      3: 'El GPS tardo demasiado. Intenta de nuevo, preferiblemente al aire libre.',
    }[error.code] || 'No se pudo obtener tu ubicacion.'));
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
  if (!sigueVigente()) return;
  if (estado.usuario?.id !== usuarioId || estado.rutaId !== rutaId) throw new Error('La sesion cambio. Vuelve a entrar.');
  const punto = ubicacionDesdePosicion(posicion);
  comprobar(await supabase.from('puntos_ruta').insert({ ...punto, ruta_id: rutaId, usuario_id: usuarioId }));
  notificar(`Ubicacion guardada. Precision aproximada: ${Math.round(punto.precision)} m.`);
  await cargarPuntos(false);
}

elemento('record').addEventListener('click', () => ejecutar(() => registrarUbicacion()));
elemento('iniciar-seguimiento').addEventListener('click', () => {
  if (!estado.usuario || !estado.rutaId || estado.ocupado) return;
  void seguimiento.iniciar({
    intervalo: Number(elemento('intervalo').value),
    mantenerPantalla: elemento('mantener-pantalla').checked,
  }).catch(mostrarError);
});
elemento('detener-seguimiento').addEventListener('click', () => seguimiento.detener());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && estadoSeguimiento.activo) {
    seguimiento.detener('Registro detenido al salir de la app. Pulsa Activar para continuar.');
  }
});
window.addEventListener('pagehide', () => {
  if (estadoSeguimiento.activo) seguimiento.detener();
});
window.addEventListener('offline', () => {
  if (estadoSeguimiento.activo) seguimiento.detener('Sin conexion. Registro automatico detenido.');
});
if (!navigator.wakeLock || !window.isSecureContext) {
  elemento('mantener-pantalla').checked = false;
  elemento('estado-pantalla').textContent = 'Bloqueo de pantalla no compatible con este navegador';
}

elemento('delete-route').addEventListener('click', () => {
  const ruta = estado.rutas.find(candidata => candidata.id === estado.rutaId);
  if (!ruta || !window.confirm(`Eliminar "${ruta.nombre}" y todos sus puntos? Esta accion no se puede deshacer.`)) return;
  ejecutar(async () => {
    comprobar(await supabase.from('rutas').delete().eq('id', ruta.id));
    await cargarRutas();
    notificar('Ruta eliminada.');
  });
});

elemento('export').addEventListener('click', () => {
  const nombre = estado.rutas.find(ruta => ruta.id === estado.rutaId)?.nombre || 'Ruta';
  const archivo = new Blob([JSON.stringify(convertirAGeoJSON(nombre, estado.puntos), null, 2)], { type: 'application/geo+json' });
  const direccion = URL.createObjectURL(archivo);
  const enlace = document.createElement('a');
  enlace.href = direccion;
  enlace.download = `ruta-${estado.rutaId}.geojson`;
  enlace.click();
  setTimeout(() => URL.revokeObjectURL(direccion), 1000);
  notificar('Ruta exportada. El archivo contiene tus ubicaciones: guardalo de forma privada.');
});

supabase.auth.onAuthStateChange((evento, sesion) => {
  const cambioUsuario = estado.usuario?.id !== sesion?.user?.id;
  if ((cambioUsuario || evento === 'PASSWORD_RECOVERY') && estadoSeguimiento.activo) seguimiento.detener();
  if (cambioUsuario || evento === 'PASSWORD_RECOVERY' || evento === 'INITIAL_SESSION') {
    ajusteEnCurso?.abort();
    edicion = null;
    revisionBorrador += 1;
    capaOriginal.clearLayers();
    mapa.removeLayer(capaOriginal);
    elemento('lista-respaldos').replaceChildren();
  }
  estado.usuario = sesion?.user || null;
  if (evento === 'PASSWORD_RECOVERY') estado.recuperacion = true;
  if (!estado.usuario) estado.recuperacion = false;
  elemento('auth-panel').hidden = Boolean(estado.usuario);
  elemento('routes-panel').hidden = !estado.usuario || estado.recuperacion;
  elemento('recovery-panel').hidden = !estado.recuperacion;
  elemento('logout').hidden = !estado.usuario;
  elemento('account-email').textContent = estado.usuario?.email || 'Mi espacio privado';
  mostrarVista();
  if (cambioUsuario || evento === 'INITIAL_SESSION') {
    estado.revision += 1;
    estado.rutas = [];
    estado.puntos = [];
    estado.rutaId = '';
    borrador = [];
    elemento('nombre-ruta-manual').value = '';
    mostrarBorrador();
    elemento('route-select').replaceChildren(new Option('Sin rutas', ''));
    elemento('ruta-captura').replaceChildren(new Option('Sin rutas', ''));
    mostrarPuntos();
    if (estado.usuario) setTimeout(() => ejecutar(() => cargarRutas()), 0);
    else { mapa.setView([15, -60], 3); notificar('Inicia sesion para acceder a tus rutas.'); }
  }
});
actualizarControles();
mostrarVista();