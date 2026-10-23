-- =====================================================================
-- intake: שאלון היכרות גנרי ולא מחייב.
--
-- 🧠 הטבלה שומרת רק מטא-דאטה על השאלות (נשאל / סירב / "אין"). המידע עצמו
--    נכתב לטבלאות הקיימות (profiles, goals, medications, health_conditions,
--    health_samples), ולכן כל שאר המערכת רואה אותו בלי לדעת על השאלון.
--    'none' = המשתמש ענה במפורש שאין (למשל "לא לוקחת תרופות"), וזו תשובה מלאה.
-- =====================================================================

create table public.intake_status (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  field         text not null,
  status        text not null check (status in ('asked', 'declined', 'none')),
  ask_count     integer not null default 0,
  last_asked_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, field)
);

alter table public.intake_status enable row level security;
create policy "intake_status: read own" on public.intake_status
  for select to authenticated using (user_id = (select auth.uid()));

-- רקע אימוני (ספורט לאורך השנים, ותק, רמה). טקסט חופשי, כמו injuries_notes
alter table public.profiles add column training_background text;

-- ---------------------------------------------------------------------
-- mark_intake: עדכון סטטוס של שדה. 'asked' מגדיל את המונה; סירוב או "אין" נשמרים כמו שהם.
-- ---------------------------------------------------------------------
create or replace function public.mark_intake(p_user_id uuid, p_field text, p_status text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.intake_status as i (user_id, field, status, ask_count, last_asked_at)
  values (p_user_id, p_field, p_status,
          case when p_status = 'asked' then 1 else 0 end,
          case when p_status = 'asked' then now() end)
  on conflict (user_id, field) do update set
    status        = excluded.status,
    ask_count     = i.ask_count + excluded.ask_count,
    last_asked_at = coalesce(excluded.last_asked_at, i.last_asked_at),
    updated_at    = now();
$$;

-- ---------------------------------------------------------------------
-- log_manual_measurement: מדידה שהמשתמש סיפר בשיחה (משקל, אחוז שומן, היקף מותניים).
-- נכתבת ל-health_samples ממקור 'manual', כך שהיא נכנסת לסיכום היומי ולמגמות
-- בדיוק כמו מדידה מהמשקל החכם.
-- ---------------------------------------------------------------------
create or replace function public.log_manual_measurement(
  p_user_id uuid, p_metric text, p_value numeric, p_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source uuid;
  v_unit   text;
  v_tz     text;
begin
  v_unit := case p_metric
    when 'body_mass' then 'kg'
    when 'body_fat_percentage' then '%'
    when 'waist_circumference' then 'cm'
  end;
  if v_unit is null then raise exception 'unsupported metric %', p_metric; end if;
  if p_metric = 'body_mass' and (p_value < 25 or p_value > 350) then raise exception 'weight out of range'; end if;
  if p_metric = 'body_fat_percentage' and (p_value < 2 or p_value > 75) then raise exception 'body fat out of range'; end if;
  if p_metric = 'waist_circumference' and (p_value < 40 or p_value > 250) then raise exception 'waist out of range'; end if;

  select id into v_source from public.data_sources
   where user_id = p_user_id and provider = 'manual' and status = 'active'
   order by created_at limit 1;
  if v_source is null then
    insert into public.data_sources (user_id, provider, label)
    values (p_user_id, 'manual', 'דיווח בשיחה')
    returning id into v_source;
  end if;

  insert into public.health_samples (user_id, source_id, metric, start_at, end_at, value, unit, meta)
  values (p_user_id, v_source, p_metric, p_at, p_at, p_value, v_unit, '{"via": "chat"}'::jsonb)
  on conflict on constraint health_samples_dedupe do update set value = excluded.value;

  select timezone into v_tz from public.profiles where id = p_user_id;
  perform public.recompute_daily_summary(p_user_id, (p_at at time zone v_tz)::date);
end;
$$;

revoke execute on function public.mark_intake(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.mark_intake(uuid, text, text) to service_role;
revoke execute on function public.log_manual_measurement(uuid, text, numeric, timestamptz) from public, anon, authenticated;
grant  execute on function public.log_manual_measurement(uuid, text, numeric, timestamptz) to service_role;
