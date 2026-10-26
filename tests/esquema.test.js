import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile as leerArchivo } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const esquema = await leerArchivo(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const usuarioId = '11111111-1111-4111-8111-111111111111';
const otroUsuarioId = '22222222-2222-4222-8222-222222222222';
const rutaId = '33333333-3333-4333-8333-333333333333';

test('guarda rutas manuales en orden y revierte todo si un punto es invalido', async () => {
  const base = await prepararBase();
  try {
    await base.exec(esquema);
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${usuarioId}';`);
    const coordenadas = [{ latitud: 4.65, longitud: -74.06 }, { latitud: 4.66, longitud: -74.05 }];
    const resultado = await base.query('select public.crear_ruta_manual($1, $2::jsonb) as id', ['Paseo manual', JSON.stringify(coordenadas)]);
    assert.ok(resultado.rows[0].id);
    const puntos = (await base.query('select latitud, longitud, precision from public.puntos_ruta order by registrado_en')).rows;
    assert.deepEqual(puntos, coordenadas.map(punto => ({ ...punto, precision: null })));
    for (const invalidas of [[], [coordenadas[0]], [...coordenadas, { latitud: 95, longitud: 0 }], [...coordenadas, { longitud: 0 }]]) {
      await assert.rejects(base.query('select public.crear_ruta_manual($1, $2::jsonb)', ['Invalida', JSON.stringify(invalidas)]));
    }
    assert.equal((await base.query('select * from public.rutas')).rows.length, 1);
    await base.exec(`set request.jwt.claim.sub = '${otroUsuarioId}';`);
    assert.equal((await base.query('select * from public.rutas')).rows.length, 0);
    assert.equal((await base.query('select * from public.puntos_ruta')).rows.length, 0);
    await base.exec('reset role; set role anon;');
    await assert.rejects(base.query('select public.crear_ruta_manual($1, $2::jsonb)', ['No autorizada', JSON.stringify(coordenadas)]));
  } finally { await base.close(); }
});

test('edita atomicamente, protege respaldos, detecta conflictos y restaura los originales', async () => {
  const base = await prepararBase();
  try {
    await base.exec(esquema);
    await base.exec(esquema);
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${usuarioId}';`);
    const originales = [{ latitud: 4.65, longitud: -74.06 }, { latitud: 4.66, longitud: -74.05 }];
    const id = (await base.query('select public.crear_ruta_manual($1, $2::jsonb) as id', ['Original', JSON.stringify(originales)])).rows[0].id;
    await base.exec('reset role; update public.puntos_ruta set precision = 12;');
    const medicionesOriginales = (await base.query('select latitud, longitud, precision, registrado_en from public.puntos_ruta order by registrado_en')).rows;
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${usuarioId}';`);
    const ids = async () => (await base.query('select id from public.puntos_ruta where ruta_id = $1 order by registrado_en, id', [id])).rows.map(p => p.id);
    const esperados = await ids();
    const guardar = (coordenadas, esperados, version = null) => base.query(
      'select public.guardar_edicion_ruta($1, $2, $3::jsonb, $4::uuid[], $5::uuid)',
      [id, 'Editada', JSON.stringify(coordenadas), esperados, version],
    );
    await assert.rejects(guardar([{ latitud: 100, longitud: 0 }], esperados));
    assert.deepEqual(await ids(), esperados);
    assert.equal((await base.query('select id from public.versiones_ruta')).rows.length, 0);
    await assert.rejects(guardar(originales, []), /cambio/);
    await guardar([{ latitud: 4.7, longitud: -74 }], esperados);
    const version = (await base.query('select id from public.versiones_ruta')).rows[0].id;
    await assert.rejects(base.query('select contenido from public.versiones_ruta'));
    await assert.rejects(base.query('delete from public.versiones_ruta'));
    await base.exec('reset role;');
    await base.query("update public.versiones_ruta set consultada_en = now() - interval '2 months' where id = $1", [version]);
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${otroUsuarioId}';`);
    await assert.rejects(base.query('select public.ver_version_ruta($1)', [version]), /acceso/);
    await assert.rejects(guardar(originales, await ids()), /acceso/);
    assert.equal((await base.query('select id from public.versiones_ruta')).rows.length, 0);
    await base.exec(`set request.jwt.claim.sub = '${usuarioId}';`);
    const contenido = (await base.query('select public.ver_version_ruta($1) as contenido', [version])).rows[0].contenido;
    assert.equal(contenido.nombre, 'Original');
    assert.deepEqual(contenido.puntos.map(({ latitud, longitud }) => ({ latitud, longitud })), originales);
    assert.ok(Date.now() - new Date((await base.query('select consultada_en from public.versiones_ruta')).rows[0].consultada_en) < 10000);
    await assert.rejects(guardar(originales, esperados), /cambio/);
    await guardar([], await ids(), version);
    assert.equal((await base.query('select nombre from public.rutas')).rows[0].nombre, 'Original');
    assert.deepEqual((await base.query('select latitud, longitud from public.puntos_ruta order by registrado_en')).rows, originales);
    assert.deepEqual((await base.query('select latitud, longitud, precision, registrado_en from public.puntos_ruta order by registrado_en')).rows, medicionesOriginales);
    assert.equal((await base.query('select id from public.versiones_ruta')).rows.length, 2);
    // La limpieza elimina solo versiones sin consultar; no afecta a la ruta activa.
    await base.exec('reset role;');
    await base.query("update public.versiones_ruta set consultada_en = now() - interval '2 months' where id != $1", [version]);
    await base.exec("delete from public.versiones_ruta where consultada_en < now() - interval '1 month'");
    assert.equal((await base.query('select id from public.versiones_ruta')).rows.length, 1);
    assert.equal((await base.query('select id from public.puntos_ruta')).rows.length, 2);
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${usuarioId}';`);
    await base.query('delete from public.rutas where id = $1', [id]);
    await base.exec('reset role;');
    assert.equal((await base.query('select id from public.versiones_ruta')).rows.length, 0);
  } finally { await base.close(); }
});

async function prepararBase() {
  const base = new PGlite();
  await base.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    insert into auth.users values ('${usuarioId}'), ('${otroUsuarioId}');
  `);
  return base;
}

test('el esquema en espanol se puede ejecutar dos veces y mantiene las rutas privadas', async () => {
  const base = await prepararBase();
  try {
    await base.exec(esquema);
    await base.exec(esquema);
    await base.exec(`
      insert into public.rutas (id, usuario_id, nombre) values ('${rutaId}', '${usuarioId}', 'Mi paseo');
      insert into public.puntos_ruta (ruta_id, usuario_id, latitud, longitud, precision, registrado_en)
        values ('${rutaId}', '${usuarioId}', 4.65, -74.06, 12, now());
      set role authenticated;
      set request.jwt.claim.sub = '${otroUsuarioId}';
    `);
    assert.equal((await base.query('select * from public.rutas')).rows.length, 0);
    assert.equal((await base.query('select * from public.puntos_ruta')).rows.length, 0);
    await assert.rejects(base.query(`insert into public.rutas (usuario_id, nombre) values ('${usuarioId}', 'Ajena')`));
    await assert.rejects(base.query(`insert into public.puntos_ruta (ruta_id, usuario_id, latitud, longitud, precision, registrado_en)
      values ('${rutaId}', '${otroUsuarioId}', 4, -74, 12, now())`));
    await base.exec(`set request.jwt.claim.sub = '${usuarioId}';`);
    assert.equal((await base.query('select nombre from public.rutas')).rows[0].nombre, 'Mi paseo');
    assert.equal((await base.query('select latitud from public.puntos_ruta')).rows[0].latitud, 4.65);
    await base.exec('reset role; set role anon;');
    await assert.rejects(base.query('select * from public.rutas'));
  } finally { await base.close(); }
});

test('migra tablas y columnas inglesas sin perder puntos ni relaciones', async () => {
  const base = await prepararBase();
  try {
    await base.exec(`
      create table public.routes (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
        name text not null,
        created_at timestamptz not null default now(),
        unique (id, user_id)
      );
      create table public.route_points (
        id uuid primary key default gen_random_uuid(),
        route_id uuid not null,
        user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
        latitude double precision not null,
        longitude double precision not null,
        accuracy double precision not null,
        recorded_at timestamptz not null,
        created_at timestamptz not null default now(),
        foreign key (route_id, user_id) references public.routes(id, user_id) on delete cascade
      );
      create index routes_user_created_idx on public.routes(user_id, created_at desc);
      create index route_points_route_time_idx on public.route_points(route_id, recorded_at, id);
      create index route_points_user_idx on public.route_points(user_id);
      alter table public.routes enable row level security;
      create policy routes_read_own on public.routes for select to authenticated using (auth.uid() = user_id);
      insert into public.routes (id, user_id, name) values ('${rutaId}', '${usuarioId}', 'Ruta anterior');
      insert into public.route_points (route_id, user_id, latitude, longitude, accuracy, recorded_at)
        values ('${rutaId}', '${usuarioId}', 4.65, -74.06, 12, '2026-10-23T10:00:00Z');
    `);
    await base.exec(esquema);
    await base.exec(esquema);
    assert.equal((await base.query('select id, nombre from public.rutas')).rows[0].id, rutaId);
    assert.equal((await base.query('select nombre from public.rutas')).rows[0].nombre, 'Ruta anterior');
    const punto = (await base.query('select * from public.puntos_ruta')).rows[0];
    assert.equal(punto.latitud, 4.65);
    assert.equal(punto.usuario_id, usuarioId);
    assert.equal(punto.ruta_id, rutaId);
    assert.equal(punto.registrado_en.toISOString(), '2026-10-23T10:00:00.000Z');
    assert.equal((await base.query("select to_regclass('public.routes') as antigua")).rows[0].antigua, null);
    await base.exec(`set role authenticated; set request.jwt.claim.sub = '${otroUsuarioId}';`);
    assert.equal((await base.query('select * from public.rutas')).rows.length, 0);
    assert.equal((await base.query('select * from public.puntos_ruta')).rows.length, 0);
    await base.exec(`set request.jwt.claim.sub = '${usuarioId}'; delete from public.rutas where id = '${rutaId}'; reset role;`);
    assert.equal((await base.query('select * from public.puntos_ruta')).rows.length, 0);
  } finally { await base.close(); }
});