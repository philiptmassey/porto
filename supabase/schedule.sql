-- Operational setup, separate from the application schema migration.
-- First create porto_origin and porto_cron_secret in Supabase Vault.
-- This script contains no credentials and can be reapplied safely.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists(select 1 from vault.secrets where name = 'porto_origin')
     or not exists(select 1 from vault.secrets where name = 'porto_cron_secret') then
    raise exception 'Configure porto_origin and porto_cron_secret in Vault first';
  end if;
end;
$$;

select cron.schedule(
  'porto-refresh-feeds',
  '*/15 * * * *',
  $job$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'porto_origin') || '/api/cron/refresh',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'porto_cron_secret')),
    timeout_milliseconds := 300000
  );
  $job$
);
