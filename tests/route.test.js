import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ubicacionDesdePosicion, convertirAGeoJSON } from '../src/route.js';

test('exporta puntos trazados sin atribuirles precision GPS', () => {
  const puntos = [{ latitud: 4.65, longitud: -74.06, precision: null, registrado_en: '2026-10-23T10:00:00Z' }];
  const exportado = convertirAGeoJSON('Ruta manual', puntos);
  assert.equal(exportado.features[0].properties.precision, null);
  assert.deepEqual(exportado.features[0].geometry.coordinates, [-74.06, 4.65]);
});

test('conserva coordenadas, precision y hora del telefono', () => {
  assert.deepEqual(ubicacionDesdePosicion({ coords: { latitude: 0, longitude: -74, accuracy: 15 }, timestamp: 0 }), {
    latitud: 0, longitud: -74, precision: 15, registrado_en: '1970-01-01T00:00:00.000Z',
  });
});

test('rechaza ubicaciones invalidas antes de guardarlas', () => {
  for (const coordenadas of [
    { latitude: 91, longitude: 0, accuracy: 1 },
    { latitude: 0, longitude: -181, accuracy: 1 },
    { latitude: NaN, longitude: 0, accuracy: 1 },
    { latitude: 0, longitude: 0, accuracy: -1 },
  ]) {
    assert.throws(() => ubicacionDesdePosicion({ coords: coordenadas, timestamp: 0 }));
  }
});

test('exporta puntos ordenados y linea en formato GeoJSON longitud-latitud', () => {
  const puntos = [
    { latitud: 4, longitud: -74, precision: 8, registrado_en: '2026-10-23T10:00:00Z' },
    { latitud: 5, longitud: -73, precision: 9, registrado_en: '2026-10-23T11:00:00Z' },
  ];
  const exportado = convertirAGeoJSON('Paseo', puntos);
  assert.equal(exportado.features.length, 3);
  assert.deepEqual(exportado.features[0].geometry.coordinates, [[-74, 4], [-73, 5]]);
  assert.equal(exportado.features[2].properties.registrado_en, puntos[1].registrado_en);
  assert.equal(convertirAGeoJSON('Vacia', []).features.length, 0);
  assert.equal(convertirAGeoJSON('Un punto', puntos.slice(0, 1)).features.length, 1);
});