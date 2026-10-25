-- =====================================================================
-- onboarding: היכרות ראשונית שהבוט מציע ביוזמתו למשתמש חדש.
-- המצב נשמר בפרופיל. כל הפרטים עצמם ממשיכים להירשם בטבלאות הרגילות.
-- =====================================================================

alter table public.profiles
  add column onboarding_status text check (onboarding_status in ('offered', 'in_progress', 'snoozed', 'declined', 'done')),
  add column onboarding_updated_at timestamptz;

-- 'answered': שדה שאין לו עמודה שאפשר לבדוק (שם), והמשתמש כבר ענה עליו
alter table public.intake_status drop constraint intake_status_status_check;
alter table public.intake_status add constraint intake_status_status_check
  check (status in ('asked', 'declined', 'none', 'answered'));

alter table public.outbound_notifications drop constraint outbound_notifications_kind_check;
alter table public.outbound_notifications add constraint outbound_notifications_kind_check
  check (kind in ('evening_summary', 'pre_workout', 'morning_fallback', 'weekly_review', 'meal_reminder', 'workout_followup', 'onboarding'));
