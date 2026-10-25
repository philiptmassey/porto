-- Run against a local Supabase database after applying the initial migration.
-- Exercises both users through the authenticated role; all changes roll back.
begin;

create temporary table porto_rls_context (
  user_a uuid not null,
  user_b uuid not null,
  source_a uuid not null,
  source_b uuid not null,
  item_a uuid not null,
  item_b uuid not null
);

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  source_a uuid := gen_random_uuid();
  source_b uuid := gen_random_uuid();
  item_a uuid := gen_random_uuid();
  item_b uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
  values
    (user_a, 'authenticated', 'authenticated', user_a::text || '@porto-rls.invalid', '', now()),
    (user_b, 'authenticated', 'authenticated', user_b::text || '@porto-rls.invalid', '', now());

  insert into public.sources (id, user_id, url, title)
  values
    (source_a, user_a, 'https://a.example/feed.xml', 'A feed'),
    (source_b, user_b, 'https://b.example/feed.xml', 'B feed');
  insert into public.item_state (id, user_id, source_id, item_key, title, url)
  values
    (item_a, user_a, source_a, 'a-item', 'A item', 'https://a.example/1'),
    (item_b, user_b, source_b, 'b-item', 'B item', 'https://b.example/1');
  insert into pg_temp.porto_rls_context values (user_a, user_b, source_a, source_b, item_a, item_b);
end;
$$;

grant select on pg_temp.porto_rls_context to authenticated;
select set_config('request.jwt.claim.sub', (select user_a::text from pg_temp.porto_rls_context), true);
set local role authenticated;

do $$
declare
  own_sources integer;
  own_items integer;
  changed integer;
  other_delete_count integer;
begin
  select count(*) into own_sources from public.sources;
  select count(*) into own_items from public.item_state;
  if own_sources <> 1 or own_items <> 1 then
    raise exception 'user A can read other users source or item rows';
  end if;

  select public.mark_items_seen(array[
    (select item_a from pg_temp.porto_rls_context),
    (select item_b from pg_temp.porto_rls_context)
  ]) into changed;
  if changed <> 1 then raise exception 'seen RPC did not restrict updates to user A'; end if;
  select public.mark_items_seen(array[(select item_a from pg_temp.porto_rls_context)]) into changed;
  if changed <> 0 then raise exception 'seen RPC was not idempotent'; end if;
  select public.undo_items_seen(array[
    (select item_a from pg_temp.porto_rls_context),
    (select item_b from pg_temp.porto_rls_context)
  ]) into changed;
  if changed <> 1 then raise exception 'undo RPC did not restore only user A item'; end if;

  delete from public.sources
  where id = (select source_b from pg_temp.porto_rls_context);
  get diagnostics other_delete_count = row_count;
  if other_delete_count <> 0 then raise exception 'user A deleted another user source'; end if;

  begin
    update public.item_state
    set user_id = (select user_b from pg_temp.porto_rls_context)
    where id = (select item_a from pg_temp.porto_rls_context);
    raise exception 'user A changed item ownership';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', (select user_b::text from pg_temp.porto_rls_context), true);
set local role authenticated;

do $$
declare
  own_sources integer;
  own_items integer;
begin
  select count(*) into own_sources from public.sources;
  select count(*) into own_items from public.item_state;
  if own_sources <> 1 or own_items <> 1 then
    raise exception 'user B can read other users source or item rows';
  end if;
end;
$$;

reset role;
rollback;
