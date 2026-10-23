// =====================================================================
// שאלון היכרות גנרי: אילו פרטים חסרים לסוכן, ואם מותר לשאול עכשיו.
//
// 🧠 חלוקת עבודה: השרת מחליט *אם ומה* לשאול (כלל פשוט ובדיק), והמודל מחליט
//    *איך* לנסח ומתי בשיחה זה טבעי. כך הבוט לא מציק, אבל השאלה נשמעת אנושית.
//    שדה חדש = שורה אחת ב-INTAKE_FIELDS.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

/** תמונת מצב של מה שכבר ידוע, מחושבת מהטבלאות עצמן */
export interface IntakeFacts {
  sex: string | null;
  birth_date: string | null;
  height_cm: number | null;
  training_background: string | null;
  activity_level: string | null;
  injuries_notes: string | null;
  dietary_prefs: Record<string, unknown>;
  cycle_tracking_enabled: boolean;
  has_recent_weight: boolean;
  active_goals: number;
  medications: number;
  conditions: number;
}

export interface IntakeField {
  key: string;
  label: string;     // מה חסר, בשפה של הסוכן
  hint: string;      // למה זה חשוב, כדי שהשאלה תבוא עם סיבה ולא כטופס
  known: (f: IntakeFacts) => boolean;
  applies?: (f: IntakeFacts) => boolean;
}

// הסדר הוא סדר העדיפות: מה שמשפיע הכי הרבה על איכות ההמלצות קודם
export const INTAKE_FIELDS: IntakeField[] = [
  { key: "sex", label: "מגדר", hint: "כדי לפנות בלשון הנכונה ולהתאים טווחי דופק, קלוריות וחלבון",
    known: (f) => f.sex !== null },
  { key: "goals", label: "יעדים", hint: "מה הכי חשוב עכשיו: ירידה במשקל, כושר, שינה, ביצועים, סתם להרגיש טוב",
    known: (f) => f.active_goals > 0 },
  { key: "birth_date", label: "גיל (תאריך לידה, או לפחות שנה)", hint: "דופק מקסימלי, התאוששות וצרכים תזונתיים משתנים עם הגיל",
    known: (f) => f.birth_date !== null },
  { key: "height", label: "גובה", hint: "יחד עם המשקל זה הבסיס לחישוב צריכה קלורית",
    known: (f) => f.height_cm !== null },
  { key: "weight", label: "משקל עדכני", hint: "אין משקל מהחודשיים האחרונים; בלי זה אי אפשר לחשב חלבון ותקציב קלורי",
    known: (f) => f.has_recent_weight },
  { key: "training_background", label: "היסטוריה אימונית", hint: "ממתי מתאמנים, באילו ענפים, ומה הרמה, כדי לבנות עומס נכון",
    known: (f) => f.training_background !== null || f.activity_level !== null },
  { key: "injuries", label: "פציעות או מגבלות", hint: "כדי לא להמליץ על משהו שיכאיב",
    known: (f) => f.injuries_notes !== null },
  { key: "conditions", label: "רקע רפואי (מצבים קיימים או מהעבר)", hint: "למשל תת-פעילות של בלוטת התריס, תנגודת לאינסולין, לחץ דם, ניתוחים",
    known: (f) => f.conditions > 0 },
  { key: "medications", label: "תרופות ותוספים", hint: "חלק מהתרופות משפיעות על דופק, שינה ותיאבון, וחשוב להביא אותן בחשבון",
    known: (f) => f.medications > 0 },
  { key: "diet", label: "העדפות תזונה ואלרגיות", hint: "צמחונות, כשרות, אלרגיות, דברים שלא אוהבים",
    known: (f) => Object.keys(f.dietary_prefs ?? {}).length > 0 },
  { key: "cycle_tracking", label: "האם להפעיל מעקב מחזור", hint: "מאפשר לפרש נכון שינויים בדופק, HRV ומשקל לאורך החודש",
    known: (f) => f.cycle_tracking_enabled, applies: (f) => f.sex === "female" },
];

export const INTAKE_KEYS = INTAKE_FIELDS.map((f) => f.key);

export interface IntakeStatusRow { field: string; status: "asked" | "declined" | "none"; ask_count: number; last_asked_at: string | null }

export const ASK_COOLDOWN_HOURS = 20;  // לכל היותר שאלת היכרות אחת בערך ביום
export const MAX_ASKS_PER_FIELD = 2;   // שאלנו פעמיים ולא קיבלנו תשובה: מרפים

export interface IntakePlan {
  missing: IntakeField[];        // מה עדיין לא ידוע (כדי שהסוכן לא יניח הנחות)
  suggest: IntakeField | null;   // מה מותר לשאול עכשיו, אם בכלל
}

export function planIntake(facts: IntakeFacts, statuses: IntakeStatusRow[], now = new Date()): IntakePlan {
  const byKey = new Map(statuses.map((s) => [s.field, s]));
  const missing = INTAKE_FIELDS.filter((f) =>
    (f.applies?.(facts) ?? true) && !f.known(facts) && byKey.get(f.key)?.status !== "none"
  );

  const lastAsk = Math.max(0, ...statuses.map((s) => (s.last_asked_at ? Date.parse(s.last_asked_at) : 0)));
  const cooling = now.getTime() - lastAsk < ASK_COOLDOWN_HOURS * 3600_000;
  const suggest = cooling ? null : missing.find((f) => {
    const s = byKey.get(f.key);
    return s?.status !== "declined" && (s?.ask_count ?? 0) < MAX_ASKS_PER_FIELD;
  }) ?? null;

  return { missing, suggest };
}

export async function loadIntake(db: SupabaseClient, userId: string, now = new Date()): Promise<IntakePlan> {
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const [profile, weight, goals, meds, conds, statuses] = await Promise.all([
    db.from("profiles").select("sex, birth_date, height_cm, training_background, activity_level, injuries_notes, dietary_prefs, cycle_tracking_enabled").eq("id", userId).single(),
    db.from("health_samples").select("id").eq("user_id", userId).eq("metric", "body_mass").gte("start_at", since).limit(1),
    db.from("goals").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "active"),
    db.from("medications").select("id", { count: "exact", head: true }).eq("user_id", userId),
    db.from("health_conditions").select("id", { count: "exact", head: true }).eq("user_id", userId),
    db.from("intake_status").select("field, status, ask_count, last_asked_at").eq("user_id", userId),
  ]);
  if (profile.error) throw profile.error;
  const facts: IntakeFacts = {
    ...(profile.data as Omit<IntakeFacts, "has_recent_weight" | "active_goals" | "medications" | "conditions">),
    has_recent_weight: (weight.data ?? []).length > 0,
    active_goals: goals.count ?? 0,
    medications: meds.count ?? 0,
    conditions: conds.count ?? 0,
  };
  return planIntake(facts, (statuses.data ?? []) as IntakeStatusRow[], now);
}

/** השורות שנכנסות ל-<context> */
export function intakeContextLines(plan: IntakePlan): string[] {
  const lines = [`פרטים שעדיין לא ידועים: ${plan.missing.length ? plan.missing.map((f) => `${f.label} [${f.key}]`).join(", ") : "אין, הפרופיל מלא"}`];
  lines.push(plan.suggest
    ? `שאלת היכרות מותרת בהודעה הזו (לא חובה): ${plan.suggest.label} [field=${plan.suggest.key}]. למה זה חשוב: ${plan.suggest.hint}`
    : `שאלת היכרות: לא עכשיו (אל תשאל על פרטים חסרים ביוזמתך בהודעה הזו)`);
  return lines;
}
