-- =====================================================================
-- health_events: יומן בריאות גנרי. כל דבר שהמשתמש רוצה לתעד כדי לראות דפוסים:
-- התקפי מיגרנה, כאבי ראש, מחלות, כאבים, סטרס, עייפות חריגה...
--
-- 🧠 kind הוא text ולא enum, כמו metric ב-health_samples: סוג אירוע חדש נשמר
--    מיד, בלי מיגרציה. הסוכן משתמש ב-slug באנגלית (migraine) כדי שהקיבוץ יהיה עקבי,
--    ו-label_he שומר את מה שהמשתמש אמר.
-- =====================================================================

create table public.health_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  kind              text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  label_he          text,
  started_at        timestamptz not null,
  ended_at          timestamptz,
  severity          smallint check (severity between 1 and 10),
  details           jsonb not null default '{}'::jsonb,   -- טריגרים, תרופה שנלקחה, אאורה, מיקום...
  notes             text,
  source_message_id bigint references public.messages (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint health_events_range check (ended_at is null or ended_at >= started_at)
);
create index health_events_user_kind_idx on public.health_events (user_id, kind, started_at desc);
create index health_events_user_time_idx on public.health_events (user_id, started_at desc);

create trigger health_events_updated_at before update on public.health_events
  for each row execute function public.set_updated_at();

alter table public.health_events enable row level security;
create policy "health_events: owner" on public.health_events
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
