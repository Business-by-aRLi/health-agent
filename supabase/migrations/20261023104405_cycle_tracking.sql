-- =====================================================================
-- cycle tracking: מעקב מחזור, רק לפרופיל נשי ובהפעלה מפורשת.
-- כשהמעקב כבוי, המתאם לא קולט נתוני מחזור בכלל, ו-daily_summaries.cycle = null.
-- =====================================================================

alter table public.profiles
  add column cycle_tracking_enabled boolean not null default false,
  -- ה-constraint הוא שכבת ההגנה האחרונה: גם באג בקוד לא יכול להפעיל מעקב למי שלא הגדירה אישה.
  -- 🧠 is not distinct from ולא '=': כש-sex הוא null, הביטוי sex = 'female' הוא null, ו-CHECK
  --    מתייחס ל-null כ"עבר". כך פרופיל בלי מגדר היה יכול להפעיל מעקב. (הבדיקות תפסו את זה.)
  add constraint profiles_cycle_tracking_female
    check (not cycle_tracking_enabled or sex is not distinct from 'female');

alter table public.daily_summaries add column cycle jsonb;

-- ---------------------------------------------------------------------
-- cycle_state: מצב המחזור ביום נתון, מתוך נתוני menstrual_flow.
-- תחילת מחזור = יום עם דימום שלא קדם לו דימום ב-3 הימים הקודמים.
-- הכול הערכה, וכך היא מוצגת לסוכן (phase_est).
-- ---------------------------------------------------------------------
create or replace function public.cycle_state(p_user_id uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with prof as (
    select timezone as tz from public.profiles
     where id = p_user_id and cycle_tracking_enabled
  ),
  flow as (
    select distinct (h.start_at at time zone prof.tz)::date as d
      from public.health_samples h, prof
     where h.user_id = p_user_id
       and h.metric = 'menstrual_flow' and h.value > 0
       and h.start_at <  ((p_day + 1)::timestamp at time zone prof.tz)
       and h.start_at >= ((p_day - 200)::timestamp at time zone prof.tz)
  ),
  starts as (
    select f.d from flow f
     where not exists (select 1 from flow g where g.d between f.d - 3 and f.d - 1)
  ),
  gaps as (
    select d - lag(d) over (order by d) as len from starts
  ),
  s as (
    select (select max(d) from starts)                                  as last_start,
           (select round(avg(len)) from gaps where len between 21 and 40) as avg_len,
           exists (select 1 from flow where d = p_day)                    as flow_today
  )
  select case
    when not exists (select 1 from prof) then null
    else jsonb_build_object(
      'last_period_start', s.last_start,
      'cycle_day',     case when s.last_start is not null and p_day - s.last_start < 60
                            then p_day - s.last_start + 1 end,
      'avg_cycle_len', s.avg_len,
      'flow',          s.flow_today,
      -- ביוץ משוער ביום (אורך ממוצע − 14). בלי היסטוריה מניחים 28.
      'phase_est', case
        when s.last_start is null or p_day - s.last_start >= 60       then null
        when s.flow_today                                              then 'menstrual'
        when p_day - s.last_start + 1 <  coalesce(s.avg_len, 28) - 15  then 'follicular'
        when p_day - s.last_start + 1 <= coalesce(s.avg_len, 28) - 13  then 'ovulatory'
        else 'luteal'
      end)
  end
  from s;
$$;

-- 🧠 trigger ולא שינוי ב-recompute_daily_summary: לוגיקת המחזור נשארת במודול אחד,
--    וכל כתיבה ל-daily_summaries (מכל מקום) מעדכנת אותה אוטומטית.
create or replace function public.daily_summaries_set_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.cycle := public.cycle_state(new.user_id, new.day);
  return new;
end;
$$;

create trigger daily_summaries_cycle
  before insert or update on public.daily_summaries
  for each row execute function public.daily_summaries_set_cycle();

revoke execute on function public.cycle_state(uuid, date) from public, anon, authenticated;
revoke execute on function public.daily_summaries_set_cycle() from public, anon, authenticated;
