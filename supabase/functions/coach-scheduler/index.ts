// =====================================================================
// POST /functions/v1/coach-scheduler   ← pg_cron קורא לכאן כל 10 דקות
//
// Auth: header x-scheduler-secret, שנבדק מול הסוד ב-Vault (RPC scheduler_secret_ok).
// verify_jwt = false, כי pg_cron לא מחזיק JWT, והאימות נעשה כאן.
//
// 🧠 לכל משתמש מחושב "מה מגיע עכשיו" (planReminders, קוד טהור). כל תזכורת "נתפסת"
//    ב-outbound_notifications לפני השליחה, כך שגם שתי ריצות במקביל לא ישלחו פעמיים.
//    רק אז הסוכן מנסח הודעה קצרה לפי הנתונים, ואם הוא נכשל נשלח טקסט קבוע.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../_shared/supabase.ts";
import { anthropicClient } from "../_shared/anthropic.ts";
import { json } from "../_shared/http.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { localDate } from "../_shared/time.ts";
import { buildContext, loadProfile } from "../_shared/agent/context.ts";
import { runAgent, SCHEDULER_MODEL } from "../_shared/agent/loop.ts";
import { executeTool, localDayBounds } from "../_shared/agent/tools.ts";
import { prepareHistory } from "../_shared/agent/history.ts";
import { loadIntake } from "../_shared/agent/intake.ts";
import { planOnboarding } from "../_shared/agent/onboarding.ts";
import { type DueReminder, mergePrefs, type PlannedSession, planReminders } from "../_shared/agent/reminders.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const anthropic = anthropicClient();
const SLOT_HE = { breakfast: "ארוחת בוקר", lunch: "ארוחת צהריים", dinner: "ארוחת ערב" } as const;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const db = serviceClient();
  const { data: ok } = await db.rpc("scheduler_secret_ok", { p_secret: req.headers.get("x-scheduler-secret") ?? "" });
  if (!ok) return json({ ok: false }, 401);

  // עונים מיד, וממשיכים ברקע: ניסוח עם המודל יכול לקחת כמה שניות לכל משתמש
  EdgeRuntime.waitUntil(runAll(db, new Date()).catch((e) => console.error("scheduler failed", e)));
  return json({ ok: true }, 202);
});

async function runAll(db: SupabaseClient, now: Date) {
  const { data: links, error } = await db.from("telegram_links").select("user_id, chat_id");
  if (error) throw error;
  for (const l of links ?? []) {
    try {
      await runUser(db, l.user_id as string, Number(l.chat_id), now);
    } catch (e) {
      console.error("scheduler user failed", l.user_id, e);
    }
  }
}

async function runUser(db: SupabaseClient, userId: string, chatId: number, now: Date) {
  const { data: p, error } = await db.from("profiles").select("timezone, notification_prefs, onboarding_status, onboarding_updated_at, display_name").eq("id", userId).single();
  if (error) throw error;
  const tz = p.timezone as string;
  const np = (p.notification_prefs ?? {}) as Record<string, unknown>;
  const prefs = mergePrefs({ pre_workout_lead_min: np.pre_workout_lead_min, ...((np.reminders ?? {}) as object) });
  const today = localDate(now.toISOString(), tz);
  const dayStart = localDayBounds(today, tz);
  const dayEnd = localDayBounds(today, tz, true);

  const [meals, recentMeals, plan, sent, lastMsg, sessions, workouts] = await Promise.all([
    db.from("meals").select("eaten_at").eq("user_id", userId).gte("eaten_at", dayStart).lt("eaten_at", dayEnd),
    db.from("meals").select("id", { count: "exact", head: true }).eq("user_id", userId)
      .gte("eaten_at", new Date(now.getTime() - 3 * 86_400_000).toISOString()),
    db.from("nutrition_plans").select("id").eq("user_id", userId).eq("status", "active").maybeSingle(),
    db.from("outbound_notifications").select("kind, ref_key, sent_at").eq("user_id", userId)
      .gte("sent_at", new Date(now.getTime() - 36 * 3600_000).toISOString()),
    db.from("messages").select("created_at").eq("user_id", userId).eq("role", "user").order("id", { ascending: false }).limit(1).maybeSingle(),
    db.from("planned_sessions").select("id, planned_date, planned_start, duration_min, title, activity_type, status")
      .eq("user_id", userId).eq("planned_date", today).eq("status", "planned"),
    db.from("workouts").select("id, start_at, activity_type").eq("user_id", userId).gte("start_at", dayStart).lt("start_at", dayEnd),
  ]);

  const sentRows = sent.data ?? [];
  const { due, autoDone } = planReminders({
    now, timezone: tz, prefs,
    mealTrackingActive: (recentMeals.count ?? 0) > 0 || !!plan.data,
    mealsToday: (meals.data ?? []).map((m) => m.eaten_at as string),
    sent: new Set(sentRows.map((r) => `${r.kind}:${r.ref_key}`)),
    mealRemindersToday: sentRows.filter((r) => r.kind === "meal_reminder" && String(r.ref_key).startsWith(today)).length,
    lastUserMessageAt: (lastMsg.data?.created_at as string | undefined) ?? null,
    lastProactiveAt: sentRows.reduce<string | null>((m, r) => (!m || Date.parse(r.sent_at as string) > Date.parse(m) ? r.sent_at as string : m), null),
    sessions: (sessions.data ?? []) as PlannedSession[],
    workouts: (workouts.data ?? []) as Array<{ id: string; start_at: string; activity_type: string }>,
  });

  for (const d of autoDone) {
    await db.from("planned_sessions").update({ status: "done", workout_id: d.workout_id })
      .eq("user_id", userId).eq("id", d.session_id).eq("status", "planned");
  }
  for (const r of due) await deliver(db, userId, chatId, r, now, (p.display_name ?? null) as string | null);
  if (due.length) return; // הודעה יזומה אחת בכל ריצה מספיקה
  await maybeOnboard(db, userId, chatId, now, {
    timezone: tz, prefs, lastUserMessageAt: (lastMsg.data?.created_at as string | undefined) ?? null,
    status: (p.onboarding_status ?? null) as string | null, updatedAt: (p.onboarding_updated_at ?? null) as string | null,
  });
}

// הצעת היכרות ביוזמה: טקסט קבוע עם כפתורים (לא המודל), לכל היותר פעם אחת לכל סוג פנייה
async function maybeOnboard(
  db: SupabaseClient, userId: string, chatId: number, now: Date,
  a: { timezone: string; prefs: ReturnType<typeof mergePrefs>; lastUserMessageAt: string | null; status: string | null; updatedAt: string | null },
) {
  if (a.status === "done" || a.status === "declined") return;
  const [intake, sent] = await Promise.all([
    loadIntake(db, userId, now),
    db.from("outbound_notifications").select("ref_key").eq("user_id", userId).eq("kind", "onboarding"),
  ]);
  const o = planOnboarding({
    now, timezone: a.timezone, prefs: a.prefs, status: intake.onboarding, statusUpdatedAt: a.updatedAt,
    missingCount: intake.missing.length, lastUserMessageAt: a.lastUserMessageAt,
    sent: new Set((sent.data ?? []).map((r) => r.ref_key as string)),
  });
  if (!o) return;
  const { data: claimed } = await db.from("outbound_notifications")
    .upsert({ user_id: userId, kind: "onboarding", ref_key: o.ref }, { onConflict: "user_id,kind,ref_key", ignoreDuplicates: true })
    .select("ref_key");
  if (!claimed?.length) return;
  const tgId = await sendMessage(chatId, o.text, o.keyboard);
  await Promise.all([
    db.from("outbound_notifications").update({ telegram_message_id: tgId }).eq("user_id", userId).eq("kind", "onboarding").eq("ref_key", o.ref),
    db.from("messages").insert({ user_id: userId, role: "assistant", content: o.text, telegram_message_id: tgId, meta: { proactive: "onboarding", ref_key: o.ref } }),
    // ה"שעון" של התזכורת הבאה מתחיל מההצעה הראשונה; nudge-ים לא מאפסים אותו
    a.status === null
      ? db.from("profiles").update({ onboarding_status: "offered", onboarding_updated_at: now.toISOString() }).eq("id", userId)
      : Promise.resolve(),
  ]);
}

async function deliver(db: SupabaseClient, userId: string, chatId: number, r: DueReminder, now: Date, name: string | null) {
  // תפיסה לפני שליחה: אם השורה כבר קיימת, ריצה אחרת כבר שלחה את זה
  const { data: claimed } = await db.from("outbound_notifications")
    .upsert({ user_id: userId, kind: r.kind, ref_key: r.ref_key }, { onConflict: "user_id,kind,ref_key", ignoreDuplicates: true })
    .select("ref_key");
  if (!claimed?.length) return;

  let text = fallbackText(r, name);
  try {
    text = await compose(db, userId, r, now) || text;
  } catch (e) {
    console.error("compose failed, sending fallback", r.kind, e);
  }
  const tgId = await sendMessage(chatId, text);
  await Promise.all([
    db.from("outbound_notifications").update({ telegram_message_id: tgId }).eq("user_id", userId).eq("kind", r.kind).eq("ref_key", r.ref_key),
    db.from("messages").insert({ user_id: userId, role: "assistant", content: text, telegram_message_id: tgId, meta: { proactive: r.kind, ref_key: r.ref_key } }),
  ]);
}

function trigger(r: DueReminder): string {
  const head = "[הודעה יזומה של המערכת, לא נכתבה על ידי המשתמש]";
  if (r.kind === "daily_checkin") {
    return `${head} המשתמש לא כתב ולא תיעד כלום היום. כתוב הודעת "מה שלומך" קצרה וחמה (משפט או שניים): פנייה בשם אם הוא ידוע ("היי <שם>"), שאלה איך עובר היום, ואמירה שאתה כאן אם צריך משהו. מותר לשלב פרט אחד אישי מה-<context> אם הוא בולט (למשל לילה קצר, אימון מתוכנן), אבל בלי ניתוח ובלי תזכורות. בלי לחץ ובלי אשמה.`;
  }
  if (r.kind === "meal_reminder") {
    const slot = SLOT_HE[r.info.slot as keyof typeof SLOT_HE];
    return `${head} עד עכשיו לא נרשמה ${slot} היום. כתוב תזכורת קצרה ועדינה לתעד אותה בתמונה, בהודעה קולית או במילים. אם מתאים, אפשר לשאול בעדינות אם בכלל יצא לאכול. בלי אשמה ובלי לחץ.`;
  }
  const s = r.info.session as PlannedSession;
  const when = `${s.planned_start ? String(s.planned_start).slice(0, 5) : "היום"}${s.duration_min ? `, ${s.duration_min} דקות` : ""}`;
  if (r.kind === "pre_workout") {
    return `${head} תדריך לפני אימון: "${s.title}" (${s.activity_type}, ${when}). כתוב תדריך קצר: מצב ההתאוששות היום לפי השינה, HRV ודופק במנוחה מול הבסיס האישי, האם להתאים עצימות, ודבר מעשי אחד (שתייה, אוכל לפני, חימום).`;
  }
  return `${head} האימון המתוכנן "${s.title}" (${when}) עבר, והשעון לא רשם אימון. שאל בקצרה ובחום אם הוא התקיים. אם כן, אפשר לספר איך היה. אם לא, להציע להזיז אותו, בלי אשמה.`;
}

function fallbackText(r: DueReminder, name: string | null): string {
  if (r.kind === "daily_checkin") return `היי${name ? ` ${name}` : ""} 👋 מה שלומך היום? אני כאן אם צריך משהו.`;
  if (r.kind === "meal_reminder") {
    return `עוד לא רשמנו ${SLOT_HE[r.info.slot as keyof typeof SLOT_HE]} היום. אם יצא לאכול, אפשר לשלוח תמונה או לכתוב במילים מה היה 🙂`;
  }
  const s = r.info.session as PlannedSession;
  if (r.kind === "pre_workout") return `תזכורת: ${s.title}${s.planned_start ? ` ב-${String(s.planned_start).slice(0, 5)}` : ""}. לשתות מים לפני, ובהצלחה 💪`;
  return `איך היה "${s.title}"? השעון לא רשם אימון. אם הוא לא קרה, אפשר להזיז אותו ליום אחר.`;
}

async function compose(db: SupabaseClient, userId: string, r: DueReminder, now: Date): Promise<string> {
  const profile = await loadProfile(db, userId);
  const since = new Date(now.getTime() - 72 * 3600_000).toISOString();
  const { data } = await db.from("messages").select("role, content").eq("user_id", userId).gte("created_at", since)
    .order("id", { ascending: false }).limit(17);
  const result = await runAgent({
    client: anthropic,
    history: prepareHistory(data ?? []),
    userText: trigger(r),
    context: await buildContext(db, profile, now),
    model: Deno.env.get("SCHEDULER_MODEL") ?? SCHEDULER_MODEL,
    effort: "low",
    runTool: (name, input) => executeTool(name, input, { db, userId, timezone: profile.timezone }),
  });
  return result.stopReason === "refusal" ? "" : result.text;
}
