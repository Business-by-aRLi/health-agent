-- בדיקות: קישור טלגרם, היסטוריה, זיכרון, RLS
\set QUIET on
do $$
declare v_uid uuid := (select id from auth.users where email = 'miri@example.com');
        v_other uuid := (select id from auth.users where email = 'other@example.com');
        v_code text; v_code2 text;
begin
  v_code := public.create_telegram_link_code(v_uid);
  assert v_code ~ '^\d{6}$', 'six digits';

  assert public.redeem_telegram_link_code('000000x', 111, 'x') is null, 'bad code';
  assert public.redeem_telegram_link_code(v_code, 111, 'miri') = v_uid, 'redeem';
  assert (select chat_id from public.telegram_links where user_id = v_uid) = 111, 'linked';
  assert public.redeem_telegram_link_code(v_code, 111, 'miri') is null, 'single use';

  -- קוד שפג תוקפו
  v_code2 := public.create_telegram_link_code(v_uid);
  update public.telegram_link_codes set expires_at = now() - interval '1 minute' where code = v_code2;
  assert public.redeem_telegram_link_code(v_code2, 222, 'miri') is null, 'expired';

  -- chat שכבר שייך למשתמש אחר: מסרבים
  v_code2 := public.create_telegram_link_code(v_other);
  assert public.redeem_telegram_link_code(v_code2, 111, 'other') is null, 'chat owned by someone else';
  assert (select used_at from public.telegram_link_codes where code = v_code2) is null, 'refused code stays unused';

  -- אותו משתמש עובר ל-chat חדש
  v_code2 := public.create_telegram_link_code(v_uid);
  assert public.redeem_telegram_link_code(v_code2, 333, 'miri') = v_uid, 'relink';
  assert (select chat_id from public.telegram_links where user_id = v_uid) = 333, 'moved to new chat';

  insert into public.messages (user_id, role, content) values (v_uid, 'user', 'שלום'), (v_uid, 'assistant', 'היי');
  insert into public.coach_memory (user_id, category, content) values (v_uid, 'preference', 'מתאמנת בבוקר');
  begin
    insert into public.messages (user_id, role, content) values (v_uid, 'system', 'x');
    assert false, 'role check';
  exception when check_violation then null; end;
end $$;

create temp table t_ids as select
  (select id from auth.users where email = 'miri@example.com') as uid,
  (select id from auth.users where email = 'other@example.com') as other;
grant select on t_ids to authenticated;
\o /dev/null
set role authenticated;
select set_config('request.jwt.claim.sub', (select other::text from t_ids), false);
do $$ begin
  assert (select count(*) from public.messages) = 0, 'other: no messages';
  assert (select count(*) from public.coach_memory) = 0, 'other: no memory';
  assert (select count(*) from public.telegram_link_codes) = 0, 'nobody reads link codes';
  begin
    perform public.create_telegram_link_code((select other from t_ids));
    assert false, 'users cannot mint link codes';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', (select uid::text from t_ids), false);
do $$ begin
  assert (select count(*) from public.messages) = 2, 'owner sees messages';
  update public.coach_memory set active = false;
  assert found, 'owner can deactivate memory';
end $$;
reset role;
\o
\echo '  ✓ telegram linking (single-use, expiry, ownership), messages, memory, RLS'
