begin;

do $$
declare
  cambio record;
begin
  for cambio in select * from (values
    ('routes', 'rutas'),
    ('route_points', 'puntos_ruta')
  ) as tablas(anterior, nuevo)
  loop
    if to_regclass(format('public.%I', cambio.anterior)) is not null then
      if to_regclass(format('public.%I', cambio.nuevo)) is not null then
        raise exception 'Existen las tablas % y %. Revisa los datos antes de continuar.', cambio.anterior, cambio.nuevo;
      end if;
      execute format('alter table public.%I rename to %I', cambio.anterior, cambio.nuevo);
    end if;
  end loop;

  for cambio in select * from (values
    ('rutas', 'user_id', 'usuario_id'),
    ('rutas', 'name', 'nombre'),
    ('rutas', 'created_at', 'creado_en'),
    ('puntos_ruta', 'route_id', 'ruta_id'),
    ('puntos_ruta', 'user_id', 'usuario_id'),
    ('puntos_ruta', 'latitude', 'latitud'),
    ('puntos_ruta', 'longitude', 'longitud'),
    ('puntos_ruta', 'accuracy', 'precision'),
    ('puntos_ruta', 'recorded_at', 'registrado_en'),
    ('puntos_ruta', 'created_at', 'creado_en')
  ) as columnas(tabla, anterior, nuevo)
  loop
    if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = cambio.tabla and column_name = cambio.anterior) then
      execute format('alter table public.%I rename column %I to %I', cambio.tabla, cambio.anterior, cambio.nuevo);
    end if;
  end loop;

  for cambio in select * from (values
    ('routes_user_created_idx', 'rutas_usuario_creacion_idx'),
    ('route_points_route_time_idx', 'puntos_ruta_fecha_idx'),
    ('route_points_user_idx', 'puntos_ruta_usuario_idx')
  ) as indices(anterior, nuevo)
  loop
    if to_regclass(format('public.%I', cambio.anterior)) is not null then
      execute format('alter index public.%I rename to %I', cambio.anterior, cambio.nuevo);
    end if;
  end loop;
end;
$$;

create table if not exists public.rutas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nombre text not null check (char_length(trim(nombre)) between 1 and 100),
  creado_en timestamptz not null default now(),
  unique (id, usuario_id)
);

create table if not exists public.puntos_ruta (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid not null,
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  latitud double precision not null check (latitud between -90 and 90),
  longitud double precision not null check (longitud between -180 and 180),
  precision double precision not null check (precision >= 0 and precision < 'Infinity'::double precision),
  registrado_en timestamptz not null,
  creado_en timestamptz not null default now(),
  foreign key (ruta_id, usuario_id) references public.rutas(id, usuario_id) on delete cascade
);

create index if not exists rutas_usuario_creacion_idx on public.rutas(usuario_id, creado_en desc);
alter table public.puntos_ruta alter column precision drop not null;
create index if not exists puntos_ruta_fecha_idx on public.puntos_ruta(ruta_id, registrado_en, id);
create index if not exists puntos_ruta_usuario_idx on public.puntos_ruta(usuario_id);

alter table public.rutas enable row level security;
alter table public.puntos_ruta enable row level security;

revoke all on public.rutas, public.puntos_ruta from anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, delete on public.rutas to authenticated;
grant select, insert on public.puntos_ruta to authenticated;

drop policy if exists routes_read_own on public.rutas;
drop policy if exists routes_insert_own on public.rutas;
drop policy if exists routes_delete_own on public.rutas;
drop policy if exists points_read_own on public.puntos_ruta;
drop policy if exists points_insert_own on public.puntos_ruta;

drop policy if exists rutas_leer_propias on public.rutas;
create policy rutas_leer_propias on public.rutas for select to authenticated using ((select auth.uid()) = usuario_id);
drop policy if exists rutas_insertar_propias on public.rutas;
create policy rutas_insertar_propias on public.rutas for insert to authenticated with check ((select auth.uid()) = usuario_id);
drop policy if exists rutas_eliminar_propias on public.rutas;
create policy rutas_eliminar_propias on public.rutas for delete to authenticated using ((select auth.uid()) = usuario_id);

drop policy if exists puntos_leer_propios on public.puntos_ruta;
create policy puntos_leer_propios on public.puntos_ruta for select to authenticated using ((select auth.uid()) = usuario_id);
drop policy if exists puntos_insertar_propios on public.puntos_ruta;
create policy puntos_insertar_propios on public.puntos_ruta for insert to authenticated with check ((select auth.uid()) = usuario_id);

create or replace function public.crear_ruta_manual(nombre_ruta text, coordenadas jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  nueva_ruta uuid;
  instante timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception 'Inicia sesion para guardar una ruta.' using errcode = '42501';
  end if;
  if nombre_ruta is null or char_length(trim(nombre_ruta)) not between 1 and 100 then
    raise exception 'Escribe un nombre de entre 1 y 100 caracteres.';
  end if;
  if jsonb_typeof(coordenadas) is distinct from 'array' then
    raise exception 'Las coordenadas deben ser una lista de puntos.';
  end if;
  if jsonb_array_length(coordenadas) not between 2 and 500 then
    raise exception 'La ruta debe tener entre 2 y 500 puntos.';
  end if;

  insert into public.rutas (nombre, usuario_id)
    values (trim(nombre_ruta), auth.uid()) returning id into nueva_ruta;
  insert into public.puntos_ruta (ruta_id, usuario_id, latitud, longitud, precision, registrado_en)
    select nueva_ruta, auth.uid(), (punto->>'latitud')::double precision,
      (punto->>'longitud')::double precision, null,
      instante + (orden - 1) * interval '1 millisecond'
    from jsonb_array_elements(coordenadas) with ordinality as puntos(punto, orden);
  return nueva_ruta;
end;
$$;

revoke all on function public.crear_ruta_manual(text, jsonb) from public, anon;
grant execute on function public.crear_ruta_manual(text, jsonb) to authenticated;

create table if not exists public.versiones_ruta (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid not null,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  contenido jsonb not null,
  creado_en timestamptz not null default now(),
  consultada_en timestamptz not null default now(),
  foreign key (ruta_id, usuario_id) references public.rutas(id, usuario_id) on delete cascade
);
create index if not exists versiones_ruta_caducidad_idx on public.versiones_ruta(consultada_en);
create index if not exists versiones_ruta_historial_idx on public.versiones_ruta(ruta_id, creado_en desc);
alter table public.versiones_ruta enable row level security;
revoke all on public.versiones_ruta from public, anon, authenticated;
grant select (id, ruta_id, creado_en, consultada_en) on public.versiones_ruta to authenticated;
drop policy if exists versiones_leer_propias on public.versiones_ruta;
create policy versiones_leer_propias on public.versiones_ruta for select to authenticated
  using ((select auth.uid()) = usuario_id);

create or replace function public.ver_version_ruta(version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  contenido_version jsonb;
begin
  update public.versiones_ruta set consultada_en = clock_timestamp()
    where id = version_id and usuario_id = auth.uid()
    returning contenido into contenido_version;
  if not found then
    raise exception 'El respaldo no existe o no tienes acceso.' using errcode = '42501';
  end if;
  return contenido_version;
end;
$$;

create or replace function public.guardar_edicion_ruta(
  ruta_editada uuid, nombre_ruta text, coordenadas jsonb, ids_esperados uuid[],
  version_restaurar uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ruta public.rutas;
  ids_actuales uuid[];
  anteriores jsonb;
  nuevos jsonb;
  respaldo jsonb;
  instante timestamptz := clock_timestamp();
begin
  select * into ruta from public.rutas
    where id = ruta_editada and usuario_id = auth.uid() for update;
  if not found then
    raise exception 'La ruta no existe o no tienes acceso.' using errcode = '42501';
  end if;
  select coalesce(array_agg(id order by registrado_en, id), '{}'::uuid[]),
    coalesce(jsonb_agg(jsonb_build_object('latitud', latitud, 'longitud', longitud,
      'precision', precision, 'registrado_en', registrado_en) order by registrado_en, id), '[]'::jsonb)
    into ids_actuales, anteriores from public.puntos_ruta where ruta_id = ruta.id;
  if ids_esperados is distinct from ids_actuales then
    raise exception 'La ruta cambio en otro dispositivo. Cancela y actualiza antes de editar.' using errcode = '40001';
  end if;
  if version_restaurar is not null then
    update public.versiones_ruta set consultada_en = instante
      where id = version_restaurar and ruta_id = ruta.id and usuario_id = auth.uid()
      returning contenido into respaldo;
    if not found then
      raise exception 'El respaldo ya no esta disponible.' using errcode = '42501';
    end if;
    nombre_ruta := respaldo->>'nombre';
    nuevos := respaldo->'puntos';
  else
    if jsonb_typeof(coordenadas) is distinct from 'array' then
      raise exception 'Las coordenadas deben ser una lista.';
    end if;
    if jsonb_array_length(coordenadas) not between 1 and 10000 then
      raise exception 'La ruta editada debe tener entre 1 y 10000 puntos.';
    end if;
    select jsonb_agg(jsonb_build_object('latitud', punto->'latitud', 'longitud', punto->'longitud',
      'precision', null, 'registrado_en', instante + (orden - 1) * interval '1 millisecond') order by orden)
      into nuevos from jsonb_array_elements(coordenadas) with ordinality as puntos(punto, orden);
  end if;
  if nombre_ruta is null or char_length(trim(nombre_ruta)) not between 1 and 100 then
    raise exception 'Escribe un nombre de entre 1 y 100 caracteres.';
  end if;
  insert into public.versiones_ruta (ruta_id, usuario_id, contenido)
    values (ruta.id, auth.uid(), jsonb_build_object('nombre', ruta.nombre, 'puntos', anteriores));
  update public.rutas set nombre = trim(nombre_ruta) where id = ruta.id;
  delete from public.puntos_ruta where ruta_id = ruta.id;
  insert into public.puntos_ruta (ruta_id, usuario_id, latitud, longitud, precision, registrado_en)
    select ruta.id, auth.uid(), (punto->>'latitud')::double precision,
      (punto->>'longitud')::double precision, (punto->>'precision')::double precision,
      (punto->>'registrado_en')::timestamptz
    from jsonb_array_elements(nuevos) as puntos(punto);
  return ruta.id;
end;
$$;

-- Serializa capturas GPS y ediciones de la misma ruta para no perder registros concurrentes.
create or replace function public.bloquear_ruta_al_insertar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform id from public.rutas where id = new.ruta_id and usuario_id = auth.uid() for update;
  return new;
end;
$$;
drop trigger if exists puntos_bloquear_ruta on public.puntos_ruta;
create trigger puntos_bloquear_ruta before insert on public.puntos_ruta
  for each row execute function public.bloquear_ruta_al_insertar();

revoke all on function public.bloquear_ruta_al_insertar() from public, anon, authenticated;
revoke all on function public.ver_version_ruta(uuid) from public, anon;
revoke all on function public.guardar_edicion_ruta(uuid, text, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.ver_version_ruta(uuid) to authenticated;
grant execute on function public.guardar_edicion_ruta(uuid, text, jsonb, uuid[], uuid) to authenticated;

notify pgrst, 'reload schema';
commit;