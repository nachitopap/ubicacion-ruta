export function ubicacionDesdePosicion(posicion) {
  const { latitude: latitud, longitude: longitud, accuracy: precision } = posicion.coords;
  if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
      !Number.isFinite(longitud) || longitud < -180 || longitud > 180 ||
      !Number.isFinite(precision) || precision < 0 || !Number.isFinite(posicion.timestamp)) {
    throw new Error('El telefono devolvio una ubicacion no valida. Intenta de nuevo.');
  }
  return { latitud, longitud, precision, registrado_en: new Date(posicion.timestamp).toISOString() };
}

export function convertirAGeoJSON(nombre, puntos) {
  const coordenadas = puntos.map(punto => [punto.longitud, punto.latitud]);
  const elementos = puntos.map((punto, indice) => ({
    type: 'Feature',
    properties: { orden: indice + 1, registrado_en: punto.registrado_en, precision: punto.precision },
    geometry: { type: 'Point', coordinates: [punto.longitud, punto.latitud] },
  }));
  if (coordenadas.length > 1) {
    elementos.unshift({ type: 'Feature', properties: { nombre }, geometry: { type: 'LineString', coordinates: coordenadas } });
  }
  return { type: 'FeatureCollection', features: elementos };
}