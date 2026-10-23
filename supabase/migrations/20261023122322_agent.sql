-- =====================================================================
-- agent: טלגרם, היסטוריית שיחה, זיכרון ארוך טווח
-- =====================================================================

-- ---------------------------------------------------------------------
-- telegram_links: איזה chat בטלגרם שייך לאיזה משתמש. chat אחד = משתמש אחד.
-- ---------------------------------------------------------------------
create table public.telegram_links (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  chat_id    bigint not null unique,
  username   text,
  linked_at  timestamptz not null default now()
);

-- קודי קישור חד-פעמיים: המשתמש שולח לבוט /start <code>
create table public.telegram_link_codes (
  code       text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- מניעת עיבוד כפול: טלגרם שולח שוב update שלא קיבל עליו 200 מהר
create table public.telegram_updates (
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- messages: היסטוריית השיחה. role='marker' = תחילת שיחה חדשה (/new).
-- 🧠 נשמר רק הטקסט של כל תור, לא בלוקי tool_use/thinking. ההיסטוריה נשלחת למודל
--    כטקסט נקי, וכך אפשר לקצר אותה מההתחלה בלי לשבור את בלוקי ה-thinking
--    (שקשורים לשיחה שבה נוצרו). את המידע עצמו הסוכן תמיד שולף מחדש דרך הכלים.
-- ---------------------------------------------------------------------
create table public.messages (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references public.profiles (id) on delete cascade,
  role                text not null check (role in ('user', 'assistant', 'marker')),
  content             text not null,
  input_kind          text check (input_kind in ('text', 'voice', 'photo', 'scheduled')),
  telegram_message_id bigint,
  meta                jsonb not null default '{}'::jsonb,   -- usage, כלים שנקראו, מודל
  created_at          timestamptz not null default now()
);
create index messages_user_time_idx on public.messages (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- coach_memory: מה שהסוכן צריך לזכור לטווח ארוך
-- ---------------------------------------------------------------------
create table public.coach_memory (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  category          text not null check (category in ('preference', 'injury', 'schedule', 'insight', 'commitment', 'other')),
  content           text not null,
  source_message_id bigint references public.messages (id) on delete set null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index coach_memory_user_active_idx on public.coach_memory (user_id) where active;
create trigger coach_memory_updated_at before update on public.coach_memory
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- outbound_notifications: מונע שליחה כפולה של תדריכים יזומים (שלב 7)
-- ---------------------------------------------------------------------
create table public.outbound_notifications (
  user_id             uuid not null references public.profiles (id) on delete cascade,
  kind                text not null check (kind in ('evening_summary', 'pre_workout', 'morning_fallback', 'weekly_review')),
  ref_key             text not null,
  sent_at             timestamptz not null default now(),
  telegram_message_id bigint,
  primary key (user_id, kind, ref_key)
);

-- ---------------------------------------------------------------------
-- RLS: המשתמש קורא את שלו. כתיבה דרך השרת בלבד.
-- telegram_link_codes / telegram_updates: בלי policies בכלל = רק service role.
-- ---------------------------------------------------------------------
alter table public.telegram_links         enable row level security;
alter table public.telegram_link_codes    enable row level security;
alter table public.telegram_updates       enable row level security;
alter table public.messages               enable row level security;
alter table public.coach_memory           enable row level security;
alter table public.outbound_notifications enable row level security;

create policy "telegram_links: read own" on public.telegram_links
  for select to authenticated using (user_id = (select auth.uid()));
create policy "messages: read own" on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy "outbound_notifications: read own" on public.outbound_notifications
  for select to authenticated using (user_id = (select auth.uid()));
-- זיכרון: המשתמש יכול לראות ולכבות ("תשכח את זה") מהדשבורד בעתיד
create policy "coach_memory: owner" on public.coach_memory
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- קוד קישור: 6 ספרות, תקף 15 דקות. service role בלבד (SQL editor).
-- ---------------------------------------------------------------------
create or replace function public.create_telegram_link_code(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile % not found', p_user_id;
  end if;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.telegram_link_codes (code, user_id, expires_at)
      values (v_code, p_user_id, now() + interval '15 minutes');
      exit;
    exception when unique_violation then
      null; -- קוד תפוס, מגרילים שוב
    end;
  end loop;
  return v_code;
end;
$$;

-- מימוש קוד: אטומי. מחזיר user_id, או null אם הקוד לא תקף.
create or replace function public.redeem_telegram_link_code(p_code text, p_chat_id bigint, p_username text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.telegram_link_codes
   where code = p_code and used_at is null and expires_at > now()
   for update;
  if v_user is null then
    return null;
  end if;
  -- chat שכבר מקושר למשתמש *אחר*: מסרבים. ניתוק נעשה ידנית, לא בטעות
  if exists (select 1 from public.telegram_links where chat_id = p_chat_id and user_id <> v_user) then
    return null;
  end if;

  update public.telegram_link_codes set used_at = now() where code = p_code;
  -- משתמש שהיה מקושר ל-chat אחר עובר ל-chat החדש
  insert into public.telegram_links (user_id, chat_id, username)
  values (v_user, p_chat_id, p_username)
  on conflict (user_id) do update set chat_id = excluded.chat_id, username = excluded.username, linked_at = now();
  return v_user;
end;
$$;

revoke execute on function public.create_telegram_link_code(uuid) from public, anon, authenticated;
revoke execute on function public.redeem_telegram_link_code(text, bigint, text) from public, anon, authenticated;
grant  execute on function public.create_telegram_link_code(uuid) to service_role;
grant  execute on function public.redeem_telegram_link_code(text, bigint, text) to service_role;
