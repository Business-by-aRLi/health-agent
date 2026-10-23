-- =====================================================================
-- 0001 · core: profiles + data_sources
-- כל טבלה מחזיקה user_id מהיום הראשון, כדי שריבוי משתמשים לא ידרוש מיגרציה.
-- ה-RLS נכתב באותה מיגרציה שיוצרת את הטבלה: אף רגע אין טבלה בלי הגנה.
-- =====================================================================

-- פונקציה כללית שמעדכנת updated_at בכל update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- profiles: 1:1 עם auth.users
-- ---------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  display_name       text,
  timezone           text not null default 'Asia/Jerusalem',  -- קובע מתי מתחיל "יום"
  locale             text not null default 'he-IL',
  birth_date         date,
  sex                text check (sex in ('female', 'male', 'other')),
  height_cm          numeric(5, 1),
  activity_level     text,
  dietary_prefs      jsonb not null default '{}'::jsonb,
  injuries_notes     text,
  -- הדגשים של המשתמש: משפיע על מה שהסוכן מדגיש, לא על מה שנקלט
  focus_areas        text[] not null default array['sleep', 'steps', 'heart_rate', 'workouts'],
  notification_prefs jsonb not null default jsonb_build_object(
                       'evening_summary_at',   '21:30',
                       'pre_workout_lead_min', 90,
                       'morning_fallback_at',  null,
                       'weekly_review',        jsonb_build_object('dow', 6, 'at', '20:30')
                     ),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- כשנוצר משתמש ב-Auth, נוצר לו פרופיל אוטומטית
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer           -- רץ בהרשאות הבעלים, כי המשתמש החדש עוד לא יכול לכתוב
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- משתמשים שנוצרו לפני המיגרציה הזו (למשל דרך הדשבורד) מקבלים פרופיל עכשיו
insert into public.profiles (id, display_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'display_name', split_part(u.email, '@', 1))
  from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- data_sources: כל חיבור (אפליקציה, שעון, ספק ענן) הוא שורה כאן
-- ---------------------------------------------------------------------
create table public.data_sources (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  provider          text not null check (provider in (
                      'health_auto_export', 'ios_app', 'health_connect',
                      'garmin', 'oura', 'whoop', 'fitbit', 'manual')),
  label             text,
  last_synced_at    timestamptz,
  status            text not null default 'active' check (status in ('active', 'revoked', 'error')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index data_sources_user_idx on public.data_sources (user_id);

create trigger data_sources_updated_at
  before update on public.data_sources
  for each row execute function public.set_updated_at();

alter table public.data_sources enable row level security;

-- המשתמש רואה את המקורות שלו. כתיבה רק דרך service role / פונקציות.
create policy "data_sources: read own" on public.data_sources
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- data_source_secrets: ה-hash של טוקן הקליטה, בטבלה נפרדת.
-- 🧠 למה לא עמודה ב-data_sources? ב-Postgres, revoke על עמודה בודדת לא עובד
--    כשיש grant על כל הטבלה (וב-Supabase יש). טבלה נפרדת עם RLS ובלי אף policy
--    = אף משתמש לא יכול לקרוא אותה, רק service role.
-- ---------------------------------------------------------------------
create table public.data_source_secrets (
  source_id         uuid primary key references public.data_sources (id) on delete cascade,
  ingest_token_hash text not null unique,   -- sha256 hex של הטוקן. הטוקן עצמו לא נשמר
  created_at        timestamptz not null default now()
);

alter table public.data_source_secrets enable row level security;
-- בכוונה אין policies.

-- ---------------------------------------------------------------------
-- הנפקת טוקן קליטה. מחזיר את הטוקן הגלוי פעם אחת בלבד, ושומר רק hash.
-- service role בלבד (מריצים מה-SQL editor או מסקריפט אדמין).
-- ---------------------------------------------------------------------
create or replace function public.create_ingest_source(
  p_user_id  uuid,
  p_provider text default 'health_auto_export',
  p_label    text default null
)
returns table (source_id uuid, ingest_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := 'hk_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id    uuid;
begin
  insert into public.data_sources (user_id, provider, label)
  values (p_user_id, p_provider, p_label)
  returning id into v_id;

  insert into public.data_source_secrets (source_id, ingest_token_hash)
  values (v_id, encode(extensions.digest(v_token, 'sha256'), 'hex'));

  return query select v_id, v_token;
end;
$$;

-- סיבוב טוקן (אם דלף): מנפיק חדש לאותו מקור, הישן מפסיק לעבוד מיד
create or replace function public.rotate_ingest_token(p_source_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := 'hk_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.data_source_secrets (source_id, ingest_token_hash)
  values (p_source_id, encode(extensions.digest(v_token, 'sha256'), 'hex'))
  on conflict (source_id) do update
    set ingest_token_hash = excluded.ingest_token_hash, created_at = now();

  update public.data_sources set status = 'active' where id = p_source_id;
  return v_token;
end;
$$;

revoke execute on function public.create_ingest_source(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rotate_ingest_token(uuid)               from public, anon, authenticated;
grant  execute on function public.create_ingest_source(uuid, text, text) to service_role;
grant  execute on function public.rotate_ingest_token(uuid)               to service_role;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
