-- Run against a local Supabase database after applying the initial migration.
-- The transaction rolls back all fixture rows when the assertions pass.
begin;

do $$
declare
  test_user uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  test_source uuid := gen_random_uuid();
  first_claim record;
  second_claim record;
  seen_before timestamptz;
  old_full_fetch timestamptz;
  accepted boolean;
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
  values
    (test_user, 'authenticated', 'authenticated', test_user::text || '@porto-test.invalid', '', now()),
    (other_user, 'authenticated', 'authenticated', other_user::text || '@porto-test.invalid', '', now());

  insert into public.sources (id, user_id, url, last_full_fetch_at)
  values (test_source, test_user, 'https://example.com/feed.xml', now() - interval '2 days');

  -- Composite ownership FK blocks attaching another user's source to an item.
  begin
    insert into public.item_state (user_id, source_id, item_key, title)
    values (other_user, test_source, 'cross-owner', 'Must be rejected');
    raise exception 'cross-owner item reference was accepted';
  exception when foreign_key_violation then
    null;
  end;

  if has_function_privilege('authenticated', 'public.claim_due_sources(uuid,boolean,integer,uuid,uuid[])', 'EXECUTE') then
    raise exception 'authenticated role can claim refresh leases';
  end if;
  if not has_function_privilege('service_role', 'public.claim_due_sources(uuid,boolean,integer,uuid,uuid[])', 'EXECUTE') then
    raise exception 'service role cannot claim refresh leases';
  end if;
  if has_function_privilege('anon', 'public.mark_items_seen(uuid[])', 'EXECUTE') then
    raise exception 'unauthenticated role can change seen state';
  end if;

  -- An active lease permits one claimant and a later lease invalidates stale work.
  select * into first_claim
  from public.claim_due_sources(test_user, true, 1, test_source);
  if first_claim.id is null then raise exception 'first refresh claim was not granted'; end if;

  select * into second_claim
  from public.claim_due_sources(test_user, true, 1, test_source);
  if second_claim.id is not null then raise exception 'active refresh lease was claimed twice'; end if;

  update public.sources set refresh_lock_expires_at = now() - interval '1 second'
  where id = test_source;
  select * into second_claim
  from public.claim_due_sources(test_user, true, 1, test_source);
  if second_claim.id is null or second_claim.refresh_token = first_claim.refresh_token then
    raise exception 'expired lease was not replaced';
  end if;

  accepted := public.finish_source_refresh(
    test_user, test_source, first_claim.refresh_token, false,
    p_items => '[{"item_key":"stable-item","title":"First title","url":"https://example.com/1"}]'::jsonb
  );
  if accepted then raise exception 'stale refresh completion was accepted'; end if;

  accepted := public.finish_source_refresh(
    test_user, test_source, second_claim.refresh_token, false,
    p_items => '[{"item_key":"stable-item","title":"First title","url":"https://example.com/1"}]'::jsonb
  );
  if not accepted then raise exception 'current refresh completion was rejected'; end if;

  update public.item_state set seen_at = now() - interval '2 hours'
  where source_id = test_source and item_key = 'stable-item';
  select seen_at into seen_before from public.item_state
  where source_id = test_source and item_key = 'stable-item';

  select * into first_claim from public.claim_due_sources(test_user, true, 1, test_source);
  perform public.finish_source_refresh(
    test_user, test_source, first_claim.refresh_token, false,
    p_items => '[{"item_key":"stable-item","title":"Changed title","url":"https://example.com/1"}]'::jsonb
  );
  if (select seen_at from public.item_state where source_id = test_source and item_key = 'stable-item') <> seen_before then
    raise exception 'ingestion reset seen state';
  end if;
  select last_full_fetch_at into old_full_fetch from public.sources where id = test_source;

  insert into public.item_state (user_id, source_id, item_key, title, url, seen_at, last_present_at)
  values
    (test_user, test_source, 'old-seen', 'Old item', 'https://example.com/old', now() - interval '3 days', now() - interval '31 days'),
    (test_user, test_source, 'durable-unread', 'Unread item', 'https://example.com/unread', null, now() - interval '31 days');

  -- Failures and 304 responses do not prune old fingerprints or advance full-fetch time.
  select * into first_claim from public.claim_due_sources(test_user, true, 1, test_source);
  perform public.finish_source_refresh(
    test_user, test_source, first_claim.refresh_token, false, p_error => 'temporary failure'
  );
  if not exists (select 1 from public.item_state where source_id = test_source and item_key = 'old-seen') then
    raise exception 'failed fetch pruned a seen fingerprint';
  end if;

  -- now() is fixed for this entire transaction. Age the current snapshot
  -- together with its item so renewal has a distinguishable timestamp.
  update public.sources set last_full_fetch_at = now() - interval '1 second'
  where id = test_source;
  update public.item_state set last_present_at = now() - interval '1 second'
  where source_id = test_source and item_key = 'stable-item';
  select last_full_fetch_at into old_full_fetch from public.sources where id = test_source;
  select * into first_claim from public.claim_due_sources(test_user, true, 1, test_source);
  select last_present_at into seen_before from public.item_state
  where source_id = test_source and item_key = 'stable-item';
  perform public.finish_source_refresh(test_user, test_source, first_claim.refresh_token, true, p_items => '[]'::jsonb);
  if not exists (select 1 from public.item_state where source_id = test_source and item_key = 'old-seen') then
    raise exception '304 response pruned a seen fingerprint';
  end if;
  if (select last_full_fetch_at from public.sources where id = test_source) <> old_full_fetch then
    raise exception '304 response advanced last_full_fetch_at';
  end if;
  if (select last_present_at from public.item_state where source_id = test_source and item_key = 'stable-item') <= seen_before then
    raise exception '304 did not renew presence for the current full snapshot';
  end if;

  -- A successful full fetch prunes only old seen rows; unread rows are durable.
  select * into first_claim from public.claim_due_sources(test_user, true, 1, test_source);
  perform public.finish_source_refresh(test_user, test_source, first_claim.refresh_token, false, p_items => '[]'::jsonb);
  if exists (select 1 from public.item_state where source_id = test_source and item_key = 'old-seen') then
    raise exception 'successful full fetch retained an absent seen row beyond 30 days';
  end if;
  if not exists (select 1 from public.item_state where source_id = test_source and item_key = 'durable-unread') then
    raise exception 'successful full fetch pruned unread state';
  end if;
end;
$$;

rollback;
