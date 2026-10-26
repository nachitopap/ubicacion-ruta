import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearSeguimiento } from '../src/seguimiento.js';

function prepararSeguimiento(registrar = async () => {}) {
  const estados = [];
  const tareas = new Map();
  const documento = { visibilityState: 'visible' };
  const bloqueo = new EventTarget();
  bloqueo.released = false;
  bloqueo.release = async () => { bloqueo.released = true; bloqueo.dispatchEvent(new Event('release')); };
  const navegador = { wakeLock: { request: async tipo => { assert.equal(tipo, 'screen'); return bloqueo; } } };
  const seguimiento = crearSeguimiento({
    registrar, documento, navegador,
    alCambiar: estado => estados.push(estado),
    programar: (accion, demora) => { tareas.set(accion, demora); return accion; },
    cancelar: identificador => tareas.delete(identificador),
    ahora: () => 0,
  });
  return { seguimiento, estados, tareas, documento, bloqueo, navegador };
}

test('registra al iniciar, programa el intervalo y libera pantalla al detener', async () => {
  for (const intervalo of [5, 10]) {
    let registros = 0;
    const prueba = prepararSeguimiento(async () => { registros += 1; });
    await prueba.seguimiento.iniciar({ intervalo, mantenerPantalla: true });
    assert.equal(registros, 1);
    assert.equal(prueba.estados.at(-1).pantalla, 'Pantalla encendida');
    assert.deepEqual([...prueba.tareas.values()], [intervalo * 1000]);
    prueba.seguimiento.detener();
    assert.equal(prueba.bloqueo.released, true);
    assert.equal(prueba.tareas.size, 0);
    assert.equal(prueba.estados.at(-1).activo, false);
  }
});

test('no superpone registros y descarta una posicion pendiente al detener', async () => {
  let completar;
  let esVigente;
  const prueba = prepararSeguimiento(vigente => {
    esVigente = vigente;
    return new Promise(resolver => { completar = resolver; });
  });
  const inicio = prueba.seguimiento.iniciar({ intervalo: 5, mantenerPantalla: false });
  assert.equal(prueba.tareas.size, 0);
  assert.equal(prueba.estados.at(-1).enCurso, true);
  prueba.seguimiento.detener();
  assert.equal(esVigente(), false);
  completar();
  await inicio;
  assert.equal(prueba.tareas.size, 0);
});

test('permiso de pantalla denegado no impide guardar y muestra advertencia', async () => {
  const prueba = prepararSeguimiento();
  prueba.navegador.wakeLock.request = async () => { throw new Error('Denegado'); };
  await prueba.seguimiento.iniciar({ intervalo: 10, mantenerPantalla: true });
  assert.equal(prueba.estados.at(-1).activo, true);
  assert.match(prueba.estados.at(-1).pantalla, /no disponible/);
});

test('liberacion del bloqueo por Android detiene el registro', async () => {
  const prueba = prepararSeguimiento();
  await prueba.seguimiento.iniciar({ intervalo: 5, mantenerPantalla: true });
  await prueba.bloqueo.release();
  assert.equal(prueba.estados.at(-1).activo, false);
  assert.equal(prueba.tareas.size, 0);
});

test('libera un bloqueo concedido despues de detener y no registra', async () => {
  let conceder;
  let registros = 0;
  const prueba = prepararSeguimiento(async () => { registros += 1; });
  prueba.navegador.wakeLock.request = () => new Promise(resolver => { conceder = resolver; });
  const inicio = prueba.seguimiento.iniciar({ intervalo: 5, mantenerPantalla: true });
  prueba.seguimiento.detener();
  conceder(prueba.bloqueo);
  await inicio;
  assert.equal(prueba.bloqueo.released, true);
  assert.equal(registros, 0);
});

test('un error de guardado detiene el registro y libera pantalla', async () => {
  const prueba = prepararSeguimiento(async () => { throw new Error('Sin conexion'); });
  await prueba.seguimiento.iniciar({ intervalo: 5, mantenerPantalla: true });
  assert.equal(prueba.estados.at(-1).activo, false);
  assert.equal(prueba.bloqueo.released, true);
  assert.ok(prueba.estados.some(estado => estado.mensaje.includes('Sin conexion')));
});