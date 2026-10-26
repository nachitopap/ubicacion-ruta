-- Ejecutar en SQL Editor como administrador, despues de schema.sql.
create extension if not exists pg_cron;

do $$
declare
  tarea bigint;
begin
  for tarea in select jobid from cron.job where jobname = 'eliminar-versiones-rutas-caducadas'
  loop
    perform cron.unschedule(tarea);
  end loop;
  perform cron.schedule(
    'eliminar-versiones-rutas-caducadas',
    '15 3 * * *',
    $tarea$delete from public.versiones_ruta where consultada_en < now() - interval '1 month'$tarea$
  );
end;
$$;
