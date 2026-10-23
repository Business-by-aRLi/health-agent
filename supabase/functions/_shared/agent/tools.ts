// =====================================================================
// הכלים של הסוכן: הגדרות (מה המודל רואה) + מימוש (מה השרת עושה).
//
// 🧠 כלל אבטחה: הסוכן רץ עם service role, שעוקף RLS. לכן user_id **לעולם** לא
//    מגיע מהמודל. הוא נקבע בשרת (מי ששלח את ההודעה) ומוזרק לכל שאילתה.
//    המודל יכול לבקש "האימונים שלי", אבל לא "האימונים של משתמש X".
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { INTAKE_KEYS } from "./intake.ts";
import { localDate } from "../time.ts";

type Tool = Anthropic.Beta.Messages.BetaTool;

const DATE = { type: "string", description: "YYYY-MM-DD (לפי השעון המקומי של המשתמש)" } as const;

// strict: true + additionalProperties: false מבטיחים שהקלט תואם לסכימה בדיוק.
// שדות אופציונליים מוגדרים כ-nullable ועדיין ב-required, כפי ש-strict דורש.
export const TOOLS: Tool[] = [
  {
    name: "get_daily_summaries",
    description:
      "סיכום יומי לטווח תאריכים: צעדים, קלוריות פעילות, דקות אימון, מספר אימונים, דופק במנוחה, HRV, שינה (דקות, עמוקה, REM, יעילות), משקל, ציון התאוששות, מחזור (אם מופעל). עד 120 יום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workouts",
    description:
      "רשימת אימונים בטווח תאריכים, עם סוג, משך, מרחק, קלוריות ודופק. activity_type מסנן לפי סוג מנורמל (outdoor_cycling, pool_swim, pilates, functional_strength_training, outdoor_walk, open_water_swim...), או null לכל הסוגים.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE, activity_type: { type: ["string", "null"] } },
      required: ["from", "to", "activity_type"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workout_detail",
    description:
      "כל הפרטים של אימון אחד: הקפות/ספליטים/מקטעים עם קצב, מהירות ודופק לכל אחד, עקומת דופק (מדוגמת), התאוששות דופק אחרי האימון, מזג אוויר ומדדים נוספים. workout_id מגיע מ-get_workouts.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { workout_id: { type: "string" } },
      required: ["workout_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sleep",
    description: "לילות שינה בטווח תאריכים: שעת הירדמות וקימה, סה\"כ שינה, שלבים (core/deep/REM/ער). התאריך הוא יום ההתעוררות.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_trend",
    description: "מגמה של מדד יומי לאורך זמן, מקובצת לפי יום/שבוע/חודש (ממוצע, מינימום, מקסימום, מספר ימים עם נתון). טוב לשאלות כמו 'איך השתנה ה-HRV שלי בחודשיים האחרונים'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: [
            "steps", "active_kcal", "exercise_min", "distance_m", "workouts_count", "workout_min",
            "resting_hr", "hrv_avg", "walking_hr", "hr_max", "sleep_min", "sleep_deep_min", "sleep_rem_min",
            "sleep_efficiency", "weight_kg", "recovery_score",
          ],
        },
        from: DATE,
        to: DATE,
        bucket: { type: "string", enum: ["day", "week", "month"] },
      },
      required: ["metric", "from", "to", "bucket"],
      additionalProperties: false,
    },
  },
  {
    name: "get_samples",
    description:
      "דגימות גולמיות (בדרך כלל לפי שעה) של מדד שאין בסיכום היומי: respiratory_rate, spo2, vo2max, walking_speed, walking_step_length, walking_asymmetry_percentage, heart_rate (שעתי, עם min/max), body_mass, wrist_temperature_sleep ועוד. עד 500 נקודות.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { metric: { type: "string" }, from: DATE, to: DATE },
      required: ["metric", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description: "שמירת עובדה לטווח ארוך על המשתמש (העדפה, פציעה, לו\"ז, תובנה, התחייבות). משפט אחד, ברור ועצמאי.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["preference", "injury", "schedule", "insight", "commitment", "other"] },
        content: { type: "string" },
      },
      required: ["category", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "ביטול זיכרון שכבר לא נכון (לפי memory_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { memory_id: { type: "integer" } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_profile",
    description: "עדכון פרטי פרופיל. שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        display_name: { type: ["string", "null"] },
        birth_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        sex: { type: ["string", "null"], description: "female | male | other" },
        height_cm: { type: ["number", "null"] },
        activity_level: { type: ["string", "null"] },
        injuries_notes: { type: ["string", "null"], description: "פציעות ומגבלות. \"אין\" כשהמשתמש אמר שאין" },
        training_background: { type: ["string", "null"], description: "היסטוריה אימונית: ענפים, ותק, רמה, הישגים" },
        dietary_notes: { type: ["string", "null"], description: "העדפות תזונה, אלרגיות, כשרות, צמחונות" },
      },
      required: ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes", "training_background", "dietary_notes"],
      additionalProperties: false,
    },
  },
  {
    name: "set_goal",
    description: "יצירת מטרה חדשה, רק אחרי שהמשתמש הסכים לה במפורש.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["weight", "body_fat", "steps", "sleep", "strength", "endurance", "race", "habit", "custom"] },
        title: { type: "string" },
        target_value: { type: ["number", "null"] },
        unit: { type: ["string", "null"] },
        target_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["kind", "title", "target_value", "unit", "target_date"],
      additionalProperties: false,
    },
  },
  {
    name: "update_goal_status",
    description: "שינוי סטטוס של מטרה קיימת (לפי goal_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        status: { type: "string", enum: ["active", "achieved", "paused", "dropped"] },
      },
      required: ["goal_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "set_cycle_tracking",
    description: "הפעלה או כיבוי של מעקב מחזור. אפשרי רק כשבפרופיל sex = female. רק לבקשה מפורשת של המשתמשת.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "intake_update",
    description:
      "עדכון מצב שאלת היכרות. asked: מיד כששאלת על שדה (כדי שהבוט לא ישאל שוב מחר). declined: המשתמש לא רוצה לשתף, ולא שואלים שוב. none: המשתמש ענה שאין (אין תרופות, אין פציעות, אין רקע רפואי). כשהמשתמש משתף את המידע עצמו, שמור אותו בכלי המתאים; אין צורך לסמן.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: INTAKE_KEYS },
        status: { type: "string", enum: ["asked", "declined", "none"] },
      },
      required: ["field", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "log_measurement",
    description: "רישום מדידת גוף שהמשתמש סיפר: משקל (ק\"ג), אחוז שומן, היקף מותניים (ס\"מ). date = היום שבו נמדד, או null להיום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["body_mass", "body_fat_percentage", "waist_circumference"] },
        value: { type: "number" },
        date: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["metric", "value", "date"],
      additionalProperties: false,
    },
  },
  {
    name: "add_medication",
    description: "רישום תרופה או תוסף שהמשתמש נוטל. שדה לא ידוע = null. לא לשאול על כל השדות; מספיק שם, והשאר אם עלה בשיחה.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["medication", "supplement"] },
        name: { type: "string" },
        dose: { type: ["number", "null"] },
        dose_unit: { type: ["string", "null"], description: "mg, mcg, IU, טבליה..." },
        frequency: { type: ["string", "null"], description: "פעם ביום, פעמיים בשבוע..." },
        timing: { type: ["string", "null"], description: "בבוקר על קיבה ריקה, עם ארוחה..." },
        reason: { type: ["string", "null"] },
        started_on: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["kind", "name", "dose", "dose_unit", "frequency", "timing", "reason", "started_on"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_medication",
    description: "סימון שהמשתמש הפסיק תרופה או תוסף (לפי medication_id מתוך <context>). stopped_on = null להיום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { medication_id: { type: "string" }, stopped_on: { type: ["string", "null"], description: "YYYY-MM-DD" } },
      required: ["medication_id", "stopped_on"],
      additionalProperties: false,
    },
  },
  {
    name: "add_health_condition",
    description: "רישום רקע רפואי שהמשתמש שיתף: מצב קיים (active), חשד שעדיין בבירור (suspected), או היסטוריה (resolved: ניתוח, פציעה ישנה, מצב שחלף).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "בעברית, כפי שהמשתמש תיאר" },
        status: { type: "string", enum: ["active", "suspected", "resolved"] },
        diagnosed_on: { type: ["string", "null"], description: "YYYY-MM-DD, או YYYY-01-01 כשידועה רק השנה" },
        notes: { type: ["string", "null"] },
      },
      required: ["name", "status", "diagnosed_on", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_health_condition",
    description: "עדכון סטטוס של רקע רפואי קיים (לפי condition_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        condition_id: { type: "string" },
        status: { type: "string", enum: ["active", "suspected", "resolved"] },
        notes: { type: ["string", "null"] },
      },
      required: ["condition_id", "status", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "log_event",
    description:
      "רישום אירוע ביומן הבריאות: התקף מיגרנה, כאב ראש, מחלה, כאב, סטרס, עייפות חריגה, בחילה, אלרגיה וכל דבר שהמשתמש רוצה לעקוב אחריו. kind הוא slug באנגלית ועקבי לאורך זמן (migraine, headache, illness, injury_pain, stress, low_energy, nausea, allergy, period_pain, poor_mood...). זמנים בשעון המקומי בפורמט YYYY-MM-DD HH:MM; started_at = null לעכשיו; ended_at = null אם עדיין נמשך או לא ידוע.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        label_he: { type: "string", description: "איך המשתמש קרא לזה" },
        started_at: { type: ["string", "null"] },
        ended_at: { type: ["string", "null"] },
        severity: { type: ["integer", "null"], description: "1–10" },
        details: {
          type: "object",
          description: "פרטים מובנים. כל שדה שלא עלה בשיחה = null",
          properties: {
            triggers: { type: ["array", "null"], items: { type: "string" } },
            medication_taken: { type: ["string", "null"] },
            aura: { type: ["boolean", "null"] },
            location: { type: ["string", "null"] },
            symptoms: { type: ["array", "null"], items: { type: "string" } },
          },
          required: ["triggers", "medication_taken", "aura", "location", "symptoms"],
          additionalProperties: false,
        },
        notes: { type: ["string", "null"] },
      },
      required: ["kind", "label_he", "started_at", "ended_at", "severity", "details", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "עדכון אירוע קיים ביומן (לפי event_id מתוך <context> או get_events): שעת סיום, עוצמה, הערות. שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        ended_at: { type: ["string", "null"], description: "YYYY-MM-DD HH:MM מקומי" },
        severity: { type: ["integer", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["event_id", "ended_at", "severity", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "get_events",
    description:
      "אירועים מהיומן בטווח תאריכים (עד 366 יום), עם תמונת מצב לכל אירוע: השינה בלילה שלפניו, HRV, דופק במנוחה, התאוששות ויום מחזור (אם מופעל) ביום האירוע, ופעילות ואימונים ביום שלפניו. כולל סיכום: כמה אירועים, עוצמה ממוצעת, ושינה ממוצעת לפני אירוע לעומת כל הטווח. kind = null לכל הסוגים.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE, kind: { type: ["string", "null"] } },
      required: ["from", "to", "kind"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// מימוש
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: SupabaseClient;
  userId: string;
  timezone: string;
  messageId?: number;
}

type Input = Record<string, unknown>;

export class ToolInputError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** בדיקת טווח תאריכים. strict מבטיח מבנה, אבל לא תוכן ("2026-13-45", טווח הפוך) */
export function dateRange(input: Input, maxDays: number): { from: string; to: string } {
  const from = String(input.from ?? "");
  const to = String(input.to ?? "");
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new ToolInputError("from/to חייבים להיות תאריכים בפורמט YYYY-MM-DD");
  }
  if (from > to) throw new ToolInputError("from מאוחר מ-to");
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > maxDays) throw new ToolInputError(`טווח של עד ${maxDays} ימים. צריך טווח קצר יותר, או get_trend לטווחים ארוכים`);
  return { from, to };
}

/** גבולות היום המקומי ב-UTC, כדי לסנן timestamptz לפי "יום" של המשתמש */
export function localDayBounds(day: string, timeZone: string, endOfDay = false): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1);
  const midnight = d.toISOString().slice(0, 10);
  // ה-offset בחצות המקומית (שעון קיץ משתנה בין ימים, ולכן מחשבים לכל יום בנפרד)
  const guess = Date.parse(`${midnight}T00:00:00Z`);
  const offset = tzOffsetMs(guess, timeZone);
  const utc = guess - offset;
  // תיקון שני: אם חצות נופל ממש על מעבר שעון, ה-offset בנקודה המתוקנת קובע
  return new Date(guess - tzOffsetMs(utc, timeZone)).toISOString();
}

/** כמה ה-timezone מקדים את UTC ברגע נתון (במילישניות). לא תלוי ב-timezone של השרת */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const r1 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);
const r0 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n)));

/** דילול סדרה ל-max נקודות, כדי לא להציף את המודל באלפי דגימות */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]);
}

export async function executeTool(name: string, input: Input, ctx: ToolContext): Promise<unknown> {
  const { db, userId, timezone } = ctx;

  switch (name) {
    case "get_daily_summaries": {
      const { from, to } = dateRange(input, 120);
      const { data, error } = await db.from("daily_summaries")
        .select("day, steps, active_kcal, exercise_min, workouts_count, workout_min, resting_hr, hrv_avg, sleep_min, sleep_deep_min, sleep_rem_min, sleep_efficiency, weight_kg, recovery_score, cycle")
        .eq("user_id", userId).gte("day", from).lte("day", to).order("day");
      if (error) throw error;
      return (data ?? []).map((d) => ({
        day: d.day, steps: r0(d.steps), active_kcal: r0(d.active_kcal), exercise_min: r0(d.exercise_min),
        workouts: d.workouts_count, workout_min: r0(d.workout_min), resting_hr: r0(d.resting_hr), hrv: r1(d.hrv_avg),
        sleep_min: r0(d.sleep_min), deep_min: r0(d.sleep_deep_min), rem_min: r0(d.sleep_rem_min),
        sleep_eff: d.sleep_efficiency, weight_kg: r1(d.weight_kg), recovery: r0(d.recovery_score),
        ...(d.cycle ? { cycle: d.cycle } : {}),
      }));
    }

    case "get_workouts": {
      const { from, to } = dateRange(input, 366);
      let q = db.from("workouts")
        .select("id, activity_name, activity_type, start_at, duration_s, distance_m, active_kcal, avg_hr, max_hr, perceived_effort, notes")
        .eq("user_id", userId)
        .gte("start_at", localDayBounds(from, timezone))
        .lt("start_at", localDayBounds(to, timezone, true))
        .order("start_at")
        .limit(200);
      if (input.activity_type) q = q.eq("activity_type", String(input.activity_type));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((w) => ({
        workout_id: w.id, type: w.activity_type, name: w.activity_name,
        start: new Date(w.start_at).toLocaleString("he-IL", { timeZone: timezone }),
        min: r0(Number(w.duration_s) / 60), distance_m: r0(w.distance_m), kcal: r0(w.active_kcal),
        avg_hr: r0(w.avg_hr), max_hr: r0(w.max_hr), rpe: w.perceived_effort, notes: w.notes,
      }));
    }

    case "get_workout_detail": {
      const id = String(input.workout_id ?? "");
      const { data: w, error } = await db.from("workouts")
        .select("id, activity_name, activity_type, start_at, end_at, duration_s, distance_m, active_kcal, total_kcal, elevation_up_m, avg_hr, max_hr, min_hr, is_indoor, location, metrics, perceived_effort, notes")
        .eq("user_id", userId).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!w) throw new ToolInputError("אימון לא נמצא");

      const [{ data: intervals }, { data: hr }, { data: recovery }] = await Promise.all([
        db.from("workout_intervals")
          .select("kind, idx, active_s, distance_m, speed_mps, pace_s_per_km, active_kcal, avg_hr, max_hr")
          .eq("workout_id", id).eq("user_id", userId).order("kind").order("idx").limit(300),
        db.from("workout_samples").select("at, value, value_max")
          .eq("workout_id", id).eq("user_id", userId).eq("metric", "heart_rate").order("at").limit(2000),
        db.from("workout_samples").select("at, value")
          .eq("workout_id", id).eq("user_id", userId).eq("metric", "heart_rate_recovery").order("at").limit(30),
      ]);
      const start = Date.parse(w.start_at);
      const byKind: Record<string, unknown[]> = {};
      for (const i of intervals ?? []) {
        (byKind[i.kind] ??= []).push({
          n: i.idx, s: r0(i.active_s), m: r1(i.distance_m), pace_s_km: r0(i.pace_s_per_km),
          kmh: i.speed_mps === null ? null : r1(Number(i.speed_mps) * 3.6), kcal: r1(i.active_kcal),
          hr: r0(i.avg_hr), hr_max: r0(i.max_hr),
        });
      }
      return {
        workout_id: w.id, type: w.activity_type, name: w.activity_name,
        start: new Date(w.start_at).toLocaleString("he-IL", { timeZone: timezone }),
        min: r1(Number(w.duration_s) / 60), distance_m: r0(w.distance_m), active_kcal: r0(w.active_kcal),
        total_kcal: r0(w.total_kcal), elevation_up_m: r0(w.elevation_up_m),
        hr: { avg: r0(w.avg_hr), max: r0(w.max_hr), min: r0(w.min_hr) },
        indoor: w.is_indoor, location: w.location, rpe: w.perceived_effort, notes: w.notes,
        metrics: w.metrics,
        intervals: byKind,
        hr_curve: downsample(hr ?? [], 40).map((p) => ({
          min: r1((Date.parse(p.at) - start) / 60000), hr: r0(p.value), max: r0(p.value_max),
        })),
        hr_recovery: (recovery ?? []).map((p) => ({ min_after_start: r1((Date.parse(p.at) - start) / 60000), hr: r0(p.value) })),
      };
    }

    case "get_sleep": {
      const { from, to } = dateRange(input, 120);
      const { data, error } = await db.from("sleep_sessions")
        .select("sleep_date, asleep_start, asleep_end, total_asleep_min, in_bed_min, core_min, deep_min, rem_min, awake_min")
        .eq("user_id", userId).gte("sleep_date", from).lte("sleep_date", to).order("sleep_date");
      if (error) throw error;
      const t = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString("he-IL", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }) : null;
      return (data ?? []).map((s) => ({
        date: s.sleep_date, asleep: t(s.asleep_start), woke: t(s.asleep_end),
        total_min: r0(s.total_asleep_min), in_bed_min: r0(s.in_bed_min),
        core: r0(s.core_min), deep: r0(s.deep_min), rem: r0(s.rem_min), awake: r0(s.awake_min),
      }));
    }

    case "get_trend": {
      const { from, to } = dateRange(input, 730);
      const metric = String(input.metric);
      const bucket = String(input.bucket);
      const allowed = (TOOLS.find((t) => t.name === "get_trend")!.input_schema.properties as Record<string, { enum?: string[] }>).metric.enum!;
      if (!allowed.includes(metric)) throw new ToolInputError("מדד לא נתמך");
      if (!["day", "week", "month"].includes(bucket)) throw new ToolInputError("bucket לא נתמך");
      const { data, error } = await db.from("daily_summaries").select(`day, ${metric}`)
        .eq("user_id", userId).gte("day", from).lte("day", to).not(metric, "is", null).order("day");
      if (error) throw error;
      const groups = new Map<string, number[]>();
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const day = String(row.day);
        const key = bucket === "day" ? day : bucket === "month" ? day.slice(0, 7) : isoWeekStart(day);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(Number(row[metric]));
      }
      return { metric, bucket, points: [...groups.entries()].map(([period, v]) => ({
        period, avg: r1(v.reduce((a, b) => a + b, 0) / v.length), min: r1(Math.min(...v)), max: r1(Math.max(...v)), days: v.length,
      })) };
    }

    case "get_samples": {
      const { from, to } = dateRange(input, 62);
      const metric = String(input.metric);
      const { data, error } = await db.from("health_samples").select("start_at, value, value_min, value_max, unit")
        .eq("user_id", userId).eq("metric", metric)
        .gte("start_at", localDayBounds(from, timezone)).lt("start_at", localDayBounds(to, timezone, true))
        .order("start_at").limit(500);
      if (error) throw error;
      if (!data?.length) return { metric, points: [], note: "אין דגימות למדד הזה בטווח" };
      return {
        metric, unit: data[0].unit,
        points: data.map((p) => ({
          at: new Date(p.start_at).toLocaleString("he-IL", { timeZone: timezone }),
          v: r1(p.value), ...(p.value_min !== null ? { min: r1(p.value_min), max: r1(p.value_max) } : {}),
        })),
      };
    }

    case "remember": {
      const content = String(input.content ?? "").trim();
      if (!content) throw new ToolInputError("content ריק");
      const { data, error } = await db.from("coach_memory")
        .insert({ user_id: userId, category: input.category, content, source_message_id: ctx.messageId ?? null })
        .select("id").single();
      if (error) throw error;
      return { ok: true, memory_id: data.id };
    }

    case "forget": {
      const { data, error } = await db.from("coach_memory").update({ active: false })
        .eq("user_id", userId).eq("id", Number(input.memory_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "update_profile": {
      const patch: Record<string, unknown> = {};
      for (const k of ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes", "training_background"]) {
        if (input[k] !== null && input[k] !== undefined) patch[k] = input[k];
      }
      if (patch.birth_date && !ISO_DATE.test(String(patch.birth_date))) throw new ToolInputError("birth_date בפורמט YYYY-MM-DD");
      if (patch.sex && !["female", "male", "other"].includes(String(patch.sex))) throw new ToolInputError("sex: female | male | other");
      if (input.dietary_notes) patch.dietary_prefs = { notes: input.dietary_notes };
      if (!Object.keys(patch).length) return { ok: true, changed: [] };
      // שינוי sex ממשתמשת עם מעקב מחזור פעיל: מכבים את המעקב, אחרת ה-constraint יחסום
      if (patch.sex && patch.sex !== "female") patch.cycle_tracking_enabled = false;
      const { error } = await db.from("profiles").update(patch).eq("id", userId);
      if (error) throw error;
      return { ok: true, changed: Object.keys(patch) };
    }

    case "set_goal": {
      const { data, error } = await db.from("goals").insert({
        user_id: userId, kind: input.kind, title: input.title, target_value: input.target_value,
        unit: input.unit, target_date: input.target_date,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, goal_id: data.id };
    }

    case "update_goal_status": {
      const { data, error } = await db.from("goals").update({ status: input.status })
        .eq("user_id", userId).eq("id", String(input.goal_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "set_cycle_tracking": {
      const { data: p } = await db.from("profiles").select("sex").eq("id", userId).single();
      if (input.enabled && p?.sex !== "female") {
        throw new ToolInputError("מעקב מחזור זמין רק כשבפרופיל sex = female. צריך קודם לעדכן את הפרופיל (update_profile).");
      }
      const { error } = await db.from("profiles").update({ cycle_tracking_enabled: Boolean(input.enabled) }).eq("id", userId);
      if (error) throw error;
      return {
        ok: true,
        enabled: Boolean(input.enabled),
        next_step: input.enabled
          ? "כדי שנתוני מחזור יגיעו, צריך להוסיף ב-Health Auto Export אוטומציה עם Data Type: Cycle Tracking (ראו מדריך ההגדרה)."
          : null,
      };
    }

    case "intake_update": {
      const field = String(input.field);
      const status = String(input.status);
      if (!INTAKE_KEYS.includes(field)) throw new ToolInputError("field לא מוכר");
      if (!["asked", "declined", "none"].includes(status)) throw new ToolInputError("status לא תקין");
      const { error } = await db.rpc("mark_intake", { p_user_id: userId, p_field: field, p_status: status });
      if (error) throw error;
      return { ok: true };
    }

    case "log_measurement": {
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new ToolInputError("value חייב להיות מספר");
      const day = input.date ? String(input.date) : null;
      if (day && !ISO_DATE.test(day)) throw new ToolInputError("date בפורמט YYYY-MM-DD");
      // מדידה מיום קודם נרשמת בצהריים המקומיים של אותו יום, כדי שתיפול על היום הנכון בסיכום
      const at = day ? new Date(Date.parse(localDayBounds(day, timezone)) + 12 * 3600_000).toISOString() : new Date().toISOString();
      const { error } = await db.rpc("log_manual_measurement", { p_user_id: userId, p_metric: input.metric, p_value: value, p_at: at });
      if (error) {
        if (/out of range|unsupported/.test(error.message ?? "")) throw new ToolInputError("הערך לא סביר למדד הזה. כדאי לוודא עם המשתמש");
        throw error;
      }
      return { ok: true };
    }

    case "add_medication": {
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolInputError("name ריק");
      if (input.started_on && !ISO_DATE.test(String(input.started_on))) throw new ToolInputError("started_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("medications").insert({
        user_id: userId, kind: input.kind, name, dose: input.dose, dose_unit: input.dose_unit,
        frequency: input.frequency, timing: input.timing, reason: input.reason, started_on: input.started_on,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, medication_id: data.id };
    }

    case "stop_medication": {
      const stopped = input.stopped_on ? String(input.stopped_on) : localDate(new Date().toISOString(), timezone);
      if (!ISO_DATE.test(stopped)) throw new ToolInputError("stopped_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("medications").update({ stopped_on: stopped })
        .eq("user_id", userId).eq("id", String(input.medication_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "add_health_condition": {
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolInputError("name ריק");
      if (input.diagnosed_on && !ISO_DATE.test(String(input.diagnosed_on))) throw new ToolInputError("diagnosed_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("health_conditions").insert({
        user_id: userId, name, status: input.status, diagnosed_on: input.diagnosed_on, notes: input.notes,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, condition_id: data.id };
    }

    case "update_health_condition": {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.notes) patch.notes = input.notes;
      const { data, error } = await db.from("health_conditions").update(patch)
        .eq("user_id", userId).eq("id", String(input.condition_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "log_event": {
      const kind = String(input.kind ?? "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(kind)) throw new ToolInputError("kind חייב להיות slug באנגלית (migraine, headache...)");
      const started = input.started_at ? localDateTime(String(input.started_at), timezone) : new Date().toISOString();
      const ended = input.ended_at ? localDateTime(String(input.ended_at), timezone) : null;
      if (ended && ended < started) throw new ToolInputError("ended_at לפני started_at");
      const severity = input.severity === null || input.severity === undefined ? null : Number(input.severity);
      if (severity !== null && !(severity >= 1 && severity <= 10)) throw new ToolInputError("severity בין 1 ל-10");
      const details = Object.fromEntries(Object.entries((input.details ?? {}) as Input).filter(([, v]) => v !== null && v !== undefined));
      const { data, error } = await db.from("health_events").insert({
        user_id: userId, kind, label_he: input.label_he ?? null, started_at: started, ended_at: ended,
        severity, details, notes: input.notes ?? null, source_message_id: ctx.messageId ?? null,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, event_id: data.id };
    }

    case "update_event": {
      const patch: Record<string, unknown> = {};
      if (input.ended_at) patch.ended_at = localDateTime(String(input.ended_at), timezone);
      if (input.severity !== null && input.severity !== undefined) {
        const sv = Number(input.severity);
        if (!(sv >= 1 && sv <= 10)) throw new ToolInputError("severity בין 1 ל-10");
        patch.severity = sv;
      }
      if (input.notes) patch.notes = input.notes;
      if (!Object.keys(patch).length) return { ok: true, changed: [] };
      const { data, error } = await db.from("health_events").update(patch)
        .eq("user_id", userId).eq("id", String(input.event_id)).select("id");
      if (error) {
        if (error.code === "23514") throw new ToolInputError("ended_at לפני תחילת האירוע");
        throw error;
      }
      return { ok: (data ?? []).length > 0, changed: Object.keys(patch) };
    }

    case "get_events": {
      const { from, to } = dateRange(input, 366);
      let q = db.from("health_events")
        .select("id, kind, label_he, started_at, ended_at, severity, details, notes")
        .eq("user_id", userId)
        .gte("started_at", localDayBounds(from, timezone))
        .lt("started_at", localDayBounds(to, timezone, true))
        .order("started_at").limit(300);
      if (input.kind) q = q.eq("kind", String(input.kind).toLowerCase());
      const [{ data: events, error }, { data: days, error: e2 }] = await Promise.all([
        q,
        db.from("daily_summaries")
          .select("day, steps, active_kcal, workouts_count, workout_min, resting_hr, hrv_avg, sleep_min, recovery_score, cycle")
          .eq("user_id", userId).gte("day", addDaysIso(from, -1)).lte("day", to),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      return summarizeEvents(events ?? [], days ?? [], timezone);
    }

    default:
      throw new ToolInputError(`כלי לא מוכר: ${name}`);
  }
}

/** "YYYY-MM-DD HH:MM" בשעון המקומי → ISO ב-UTC */
export function localDateTime(v: string, timeZone: string): string {
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new ToolInputError("זמן בפורמט YYYY-MM-DD HH:MM");
  const [, day, h, min] = m;
  if (+h > 23 || +min > 59) throw new ToolInputError("שעה לא תקינה");
  // offset בשעה עצמה (ולא בחצות), כדי שגם ביום של מעבר שעון התוצאה תהיה נכונה
  const naive = Date.parse(`${day}T${h}:${min}:00Z`);
  const utc = naive - tzOffsetMs(naive - tzOffsetMs(naive, timeZone), timeZone);
  return new Date(utc).toISOString();
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type EventRow = { id: string; kind: string; label_he: string | null; started_at: string; ended_at: string | null; severity: number | null; details: unknown; notes: string | null };
type DayRow = Record<string, unknown> & { day: string };

/** מצמיד לכל אירוע את נתוני היום שלו ושל היום שלפניו, ומחשב סיכום קצר */
export function summarizeEvents(events: EventRow[], days: DayRow[], timeZone: string) {
  const byDay = new Map(days.map((d) => [String(d.day), d]));
  const fmt = (iso: string) => new Date(iso).toLocaleString("he-IL", { timeZone, dateStyle: "short", timeStyle: "short" });
  const avg = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);

  const sleepBefore: number[] = [];
  const list = events.map((e) => {
    const day = localDate(e.started_at, timeZone);
    const today = byDay.get(day);
    const prev = byDay.get(addDaysIso(day, -1));
    if (today?.sleep_min != null) sleepBefore.push(Number(today.sleep_min));
    return {
      event_id: e.id, kind: e.kind, label: e.label_he, start: fmt(e.started_at),
      hours: e.ended_at ? r1((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 3600_000) : null,
      severity: e.severity, details: e.details, notes: e.notes,
      // sleep_min של יום X = הלילה שהסתיים בבוקר X, כלומר הלילה שלפני האירוע
      snapshot: {
        sleep_before_min: r0(today?.sleep_min), hrv: r1(today?.hrv_avg), resting_hr: r0(today?.resting_hr),
        recovery: r0(today?.recovery_score),
        ...(today?.cycle ? { cycle: today.cycle } : {}),
        prev_day: prev ? { steps: r0(prev.steps), active_kcal: r0(prev.active_kcal), workouts: prev.workouts_count, workout_min: r0(prev.workout_min) } : null,
      },
    };
  });

  const allSleep = days.map((d) => d.sleep_min).filter((v) => v != null).map(Number);
  const sev = events.map((e) => e.severity).filter((v): v is number => v != null);
  return {
    count: events.length,
    by_kind: Object.fromEntries([...new Set(events.map((e) => e.kind))].map((k) => [k, events.filter((e) => e.kind === k).length])),
    avg_severity: sev.length ? r1(sev.reduce((a, b) => a + b, 0) / sev.length) : null,
    avg_sleep_before_event_min: avg(sleepBefore),
    nights_measured_before_events: sleepBefore.length,
    avg_sleep_all_nights_min: avg(allSleep),
    events: list,
  };
}

/** תחילת השבוע (יום ראשון, כמקובל בישראל) של תאריך */
export function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
