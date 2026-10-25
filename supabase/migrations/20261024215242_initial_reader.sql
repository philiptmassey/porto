-- Porto feed subscriptions and durable unread/seen item state.
-- Apply with the Supabase SQL editor or generate a migration with the Supabase CLI.

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  title text,
  folder text,
  site_url text,
  etag text,
  last_modified text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_full_fetch_at timestamptz,
  error text,
  refresh_lock_token uuid,
  refresh_lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sources_user_url_unique unique (user_id, url),
  constraint sources_id_user_unique unique (id, user_id),
  constraint sources_http_url check (url ~* '^https?://')
);

create index if not exists sources_due_idx
  on public.sources (last_checked_at, refresh_lock_expires_at);

create table if not exists public.item_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  item_key text not null,
  title text,
  url text,
  summary text,
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  seen_at timestamptz,
  last_present_at timestamptz not null default now(),
  constraint item_state_source_owner_fk foreign key (source_id, user_id)
    references public.sources (id, user_id) on delete cascade,
  constraint item_state_source_item_unique unique (user_id, source_id, item_key)
);

create index if not exists item_state_unread_idx
  on public.item_state (user_id, discovered_at desc) where seen_at is null;
create index if not exists item_state_seen_prune_idx
  on public.item_state (last_present_at) where seen_at is not null;

alter table public.sources enable row level security;
alter table public.item_state enable row level security;

drop policy if exists sources_select_own on public.sources;
create policy sources_select_own on public.sources
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists sources_insert_own on public.sources;
create policy sources_insert_own on public.sources
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists sources_update_own on public.sources;
create policy sources_update_own on public.sources
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists sources_delete_own on public.sources;
create policy sources_delete_own on public.sources
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists item_state_select_own on public.item_state;
create policy item_state_select_own on public.item_state
  for select to authenticated using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.sources s
      where s.id = item_state.source_id and s.user_id = (select auth.uid())
    )
  );
drop policy if exists item_state_update_own on public.item_state;
create policy item_state_update_own on public.item_state
  for update to authenticated using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.sources s
      where s.id = item_state.source_id and s.user_id = (select auth.uid())
    )
  ) with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.sources s
      where s.id = item_state.source_id and s.user_id = (select auth.uid())
    )
  );

revoke all on public.sources, public.item_state from public, anon, authenticated;
grant select, delete on public.sources to authenticated;
grant select on public.item_state to authenticated;
grant update (seen_at) on public.item_state to authenticated;
grant all on public.sources, public.item_state to service_role;

-- RPCs are SECURITY INVOKER and callable only by trusted server code using
-- the service role. The server authenticates users before passing user ids.
create or replace function public.claim_due_sources(
  p_user_id uuid default null,
  p_force boolean default false,
  p_limit integer default 200,
  p_source_id uuid default null,
  p_exclude_ids uuid[] default array[]::uuid[]
)
returns table (
  id uuid,
  user_id uuid,
  url text,
  etag text,
  last_modified text,
  refresh_token uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select s.id
    from public.sources s
    where (p_user_id is null or s.user_id = p_user_id)
      and (p_source_id is null or s.id = p_source_id)
      and not (s.id = any(coalesce(p_exclude_ids, array[]::uuid[])))
      and (s.refresh_lock_expires_at is null or s.refresh_lock_expires_at < now())
      and (p_force or s.last_checked_at is null or s.last_checked_at < now() - interval '5 minutes')
    order by s.last_checked_at nulls first, s.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 200), 200))
  ), claimed as (
    update public.sources s
    set refresh_lock_token = gen_random_uuid(),
        refresh_lock_expires_at = now() + interval '10 minutes',
        last_checked_at = now()
    from candidates c
    where s.id = c.id
    returning s.id, s.user_id, s.url, s.etag, s.last_modified, s.refresh_lock_token
  )
  select claimed.id, claimed.user_id, claimed.url, claimed.etag,
         claimed.last_modified, claimed.refresh_lock_token
  from claimed;
end;
$$;

create or replace function public.finish_source_refresh(
  p_user_id uuid,
  p_source_id uuid,
  p_refresh_token uuid,
  p_not_modified boolean,
  p_title text default null,
  p_site_url text default null,
  p_etag text default null,
  p_last_modified text default null,
  p_error text default null,
  p_items jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_last_full_fetch_at timestamptz;
begin
  select s.last_full_fetch_at into source_last_full_fetch_at
  from public.sources s
  where s.id = p_source_id
    and s.user_id = p_user_id
    and s.refresh_lock_token = p_refresh_token
  for update;

  if not found then
    return false;
  end if;

  if p_error is not null then
    update public.sources
    set error = left(p_error, 2000),
        refresh_lock_token = null,
        refresh_lock_expires_at = null
    where id = p_source_id and user_id = p_user_id;
    update public.item_state i
    set title = null, url = null, summary = null, published_at = null
    where i.user_id = p_user_id
      and i.source_id = p_source_id
      and i.seen_at < now() - interval '1 day'
      and (i.title is not null or i.url is not null or i.summary is not null or i.published_at is not null);
    return true;
  end if;

  update public.sources
  set title = coalesce(nullif(p_title, ''), title),
      site_url = coalesce(nullif(p_site_url, ''), site_url),
      etag = coalesce(p_etag, etag),
      last_modified = coalesce(p_last_modified, last_modified),
      last_success_at = now(),
      last_full_fetch_at = case when p_not_modified then last_full_fetch_at else now() end,
      error = null,
      refresh_lock_token = null,
      refresh_lock_expires_at = null
  where id = p_source_id and user_id = p_user_id;

  if not p_not_modified then
    insert into public.item_state (
      user_id, source_id, item_key, title, url, summary, published_at,
      discovered_at, seen_at, last_present_at
    )
    select p_user_id, p_source_id, incoming.item_key,
           incoming.title, incoming.url, incoming.summary,
           incoming.published_at::timestamptz, now(), null, now()
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as incoming(
      item_key text, title text, url text, summary text, published_at text
    )
    where nullif(incoming.item_key, '') is not null
    on conflict (user_id, source_id, item_key) do update
    set title = case when item_state.seen_at is null then excluded.title else item_state.title end,
        url = case when item_state.seen_at is null then excluded.url else item_state.url end,
        summary = case when item_state.seen_at is null then excluded.summary else item_state.summary end,
        published_at = case when item_state.seen_at is null then excluded.published_at else item_state.published_at end,
        last_present_at = now();

    -- Only successful full responses reach this branch. Unread rows are durable;
    -- seen fingerprints are retained for 30 days after they last appear.
    delete from public.item_state i
    where i.user_id = p_user_id
      and i.source_id = p_source_id
      and i.seen_at is not null
      and i.last_present_at < now() - interval '30 days';
  elsif source_last_full_fetch_at is not null then
    -- A 304 confirms that the last successful snapshot is still current.
    -- Renew only rows known to have appeared in that snapshot; retained absent
    -- fingerprints remain absent and can be pruned by a later full response.
    update public.item_state i
    set last_present_at = now()
    where i.user_id = p_user_id
      and i.source_id = p_source_id
      and i.last_present_at >= source_last_full_fetch_at;
  end if;

  -- Undo requires the display metadata for one day. Keep the item fingerprint
  -- and seen timestamp after that window so a still-present item stays handled.
  update public.item_state i
  set title = null, url = null, summary = null, published_at = null
  where i.user_id = p_user_id
    and i.source_id = p_source_id
    and i.seen_at < now() - interval '1 day'
    and (i.title is not null or i.url is not null or i.summary is not null or i.published_at is not null);

  return true;
end;
$$;

create or replace function public.mark_items_seen(p_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  if coalesce(cardinality(p_ids), 0) > 5000 then
    raise exception 'At most 5000 item ids may be handled at once' using errcode = '22023';
  end if;
  update public.item_state
  set seen_at = now()
  where id = any(coalesce(p_ids, array[]::uuid[]))
    and user_id = (select auth.uid())
    and seen_at is null;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.undo_items_seen(p_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  if coalesce(cardinality(p_ids), 0) > 5000 then
    raise exception 'At most 5000 item ids may be handled at once' using errcode = '22023';
  end if;
  update public.item_state
  set seen_at = null
  where id = any(coalesce(p_ids, array[]::uuid[]))
    and user_id = (select auth.uid())
    and seen_at >= now() - interval '1 day';
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.claim_due_sources(uuid, boolean, integer, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.finish_source_refresh(uuid, uuid, uuid, boolean, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.mark_items_seen(uuid[]) from public, anon, authenticated;
revoke all on function public.undo_items_seen(uuid[]) from public, anon, authenticated;
grant execute on function public.claim_due_sources(uuid, boolean, integer, uuid, uuid[]) to service_role;
grant execute on function public.finish_source_refresh(uuid, uuid, uuid, boolean, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.mark_items_seen(uuid[]) to authenticated;
grant execute on function public.undo_items_seen(uuid[]) to authenticated;
