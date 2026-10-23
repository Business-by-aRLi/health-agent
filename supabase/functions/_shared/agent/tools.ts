// =====================================================================
// הכלים של הסוכן: הגדרות (מה המודל רואה) + מימוש (מה השרת עושה).
//
// 🧠 כלל אבטחה: הסוכן רץ עם service role, שעוקף RLS. לכן user_id **לעולם** לא
//    מגיע מהמודל. הוא נקבע בשרת (מי ששלח את ההודעה) ומוזרק לכל שאילתה.
//    המודל יכול לבקש "האימונים שלי", אבל לא "האימונים של משתמש X".
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

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
        injuries_notes: { type: ["string", "null"] },
        dietary_notes: { type: ["string", "null"], description: "העדפות תזונה, אלרגיות, כשרות, צמחונות" },
      },
      required: ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes", "dietary_notes"],
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
      for (const k of ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes"]) {
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

    default:
      throw new ToolInputError(`כלי לא מוכר: ${name}`);
  }
}

/** תחילת השבוע (יום ראשון, כמקובל בישראל) של תאריך */
export function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
