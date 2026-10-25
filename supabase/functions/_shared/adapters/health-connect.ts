// =====================================================================
// מתאם: Health Agent Sync (אפליקציית אנדרואיד שלנו, קוראת מ-Health Connect)
//
// 🧠 את הפורמט הזה הגדרנו בעצמנו (schema: "health-agent-android/1"), ולכן הוא פשוט:
//    האפליקציה כבר מסכמת צעדים, מרחק, קלוריות ודופק לפי שעה דרך ה-aggregate API של
//    Health Connect, שמנכה כפילויות בין הטלפון לשעון. כאן רק ממפים לשמות הקנוניים.
//    האפליקציה שולחת כל פעם את 48 השעות האחרונות, וה-upserts בצד השרת דואגים
//    ששליחה חוזרת מעדכנת ולא משכפלת.
// =====================================================================

import { localDate } from "../time.ts";
import type {
  AdapterContext, AdapterResult, CanonicalSample, CanonicalSleep, CanonicalWorkout, CanonicalWorkoutSample,
} from "./types.ts";

export const HC_SCHEMA = "health-agent-android/1";

type Json = Record<string, unknown>;

export class HcAdapterError extends Error {}

export function isHealthConnectPayload(p: unknown): boolean {
  return !!p && typeof p === "object" && (p as Json).schema === HC_SCHEMA;
}

// שדות השעה → מדד קנוני (אותם שמות שהסיכום היומי מכיר)
const HOURLY: Array<[string, string, string]> = [
  ["steps", "steps", "count"],
  ["distance_m", "walking_running_distance", "m"],
  ["active_kcal", "active_energy", "kcal"],
];

// נקודות → מדד קנוני
const POINTS: Record<string, [string, string]> = {
  resting_heart_rate: ["resting_heart_rate", "bpm"],
  hrv_rmssd: ["hrv_rmssd", "ms"],
  weight: ["body_mass", "kg"],
  body_fat: ["body_fat_pct", "%"],
  height: ["height", "m"],
  spo2: ["spo2", "%"],
  respiratory_rate: ["respiratory_rate", "count/min"],
  vo2max: ["vo2max", "mL/(kg·min)"],
};

// סוגי אימון של Health Connect → השמות שכבר בשימוש אצלנו (מ-Health Auto Export), כדי שהסוכן
// יוכל להשוות אימונים בין משתמשות ומקורות. סוג לא מוכר נשמר כ-snake_case של השם.
const EXERCISE_TYPES: Record<string, string> = {
  RUNNING: "outdoor_run", RUNNING_TREADMILL: "indoor_run",
  WALKING: "outdoor_walk", HIKING: "hiking",
  BIKING: "outdoor_cycling", BIKING_STATIONARY: "indoor_cycling",
  SWIMMING_POOL: "pool_swim", SWIMMING_OPEN_WATER: "open_water_swim",
  STRENGTH_TRAINING: "traditional_strength_training", WEIGHTLIFTING: "traditional_strength_training",
  CALISTHENICS: "functional_strength_training", HIGH_INTENSITY_INTERVAL_TRAINING: "high_intensity_interval_training",
  PILATES: "pilates", YOGA: "yoga", ELLIPTICAL: "elliptical", ROWING_MACHINE: "rowing",
  STAIR_CLIMBING_MACHINE: "stair_stepper", DANCING: "dance", STRETCHING: "flexibility",
};

const SLEEP_STAGE: Record<string, "core" | "deep" | "rem" | "awake" | "asleep" | "in_bed"> = {
  light: "core", deep: "deep", rem: "rem", sleeping: "asleep",
  awake: "awake", awake_in_bed: "awake", out_of_bed: "awake", unknown: "in_bed",
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Json[] : []);
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** אותו כלל כמו ב-Health Auto Export: לילה שייך ליום שבו מתעוררים (עם חיתוך ב-12:00) */
function nightOf(wakeIso: string, tz: string): string {
  return localDate(new Date(Date.parse(wakeIso) + 12 * 3600 * 1000).toISOString(), tz);
}

export function adaptHealthConnect(payload: unknown, ctx: AdapterContext): AdapterResult {
  if (!isHealthConnectPayload(payload)) throw new HcAdapterError(`לא payload של ${HC_SCHEMA}`);
  const p = payload as Json;
  const warnings: string[] = [];
  const samples: CanonicalSample[] = [];

  // ---- סיכומים לפי שעה
  for (const h of asArray(p.hourly)) {
    const start = iso(h.start), end = iso(h.end);
    if (!start || !end) {
      warnings.push("hourly: רשומה בלי start/end דולגה");
      continue;
    }
    for (const [key, metric, unit] of HOURLY) {
      if (isNum(h[key]) && h[key] > 0) samples.push({ metric, start_at: start, end_at: end, value: round(h[key] as number), unit });
    }
    if (isNum(h.hr_avg)) {
      samples.push({
        metric: "heart_rate", start_at: start, end_at: end, value: round(h.hr_avg), unit: "bpm",
        value_min: isNum(h.hr_min) ? h.hr_min : null, value_max: isNum(h.hr_max) ? h.hr_max : null,
      });
    }
  }

  // ---- מדידות נקודתיות
  for (const pt of asArray(p.points)) {
    const map = POINTS[String(pt.type)];
    const t = iso(pt.time);
    if (!map || !t || !isNum(pt.value)) {
      warnings.push(`points: ${String(pt.type)} לא מוכר או חסר ערך, דולג`);
      continue;
    }
    samples.push({ metric: map[0], start_at: t, end_at: t, value: round(pt.value as number, 3), unit: map[1], meta: pt.origin ? { origin: pt.origin } : undefined });
  }

  // ---- שינה
  const sleep: CanonicalSleep[] = [];
  for (const s of asArray(p.sleep)) {
    const start = iso(s.start), end = iso(s.end);
    if (!start || !end) {
      warnings.push("sleep: סשן בלי start/end דולג");
      continue;
    }
    const stages = asArray(s.stages)
      .map((st) => ({ stage: SLEEP_STAGE[String(st.stage)], start_at: iso(st.start), end_at: iso(st.end) }))
      .filter((st): st is { stage: NonNullable<typeof st.stage>; start_at: string; end_at: string } => !!st.stage && !!st.start_at && !!st.end_at)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    const min = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
    const sum = (...k: string[]) => round(stages.filter((x) => k.includes(x.stage)).reduce((a, x) => a + min(x.start_at, x.end_at), 0));
    const inBed = round(min(start, end));
    const asleepStages = stages.filter((x) => ["core", "deep", "rem", "asleep"].includes(x.stage));
    // בלי שלבים בכלל: כל הסשן נחשב שינה (חלק מהשעונים כותבים רק התחלה וסוף)
    const total = stages.length ? sum("core", "deep", "rem", "asleep") : inBed;
    sleep.push({
      sleep_date: nightOf(end, ctx.timezone),
      in_bed_start: start, in_bed_end: end,
      asleep_start: asleepStages[0]?.start_at ?? start,
      asleep_end: asleepStages.at(-1)?.end_at ?? end,
      total_asleep_min: total || null,
      in_bed_min: inBed,
      core_min: stages.length ? sum("core", "asleep") : null,
      deep_min: stages.length ? sum("deep") : null,
      rem_min: stages.length ? sum("rem") : null,
      awake_min: stages.length ? sum("awake") : null,
      stages: stages.length ? stages : null,
      meta: { origin: s.origin ?? null, hc_id: s.id ?? null },
    });
  }
  // שני סשנים לאותו לילה (למשל שינה + תנומה שהשתייכה לאותו יום): ה-RPC שומר לילה אחד למקור,
  // ולכן משאירים את הארוך
  const byNight = new Map<string, CanonicalSleep>();
  for (const s of sleep) {
    const prev = byNight.get(s.sleep_date);
    if (!prev || (s.total_asleep_min ?? 0) > (prev.total_asleep_min ?? 0)) byNight.set(s.sleep_date, s);
  }

  // ---- אימונים
  const workouts: CanonicalWorkout[] = [];
  for (const e of asArray(p.exercise)) {
    const start = iso(e.start), end = iso(e.end);
    const typeName = String(e.type_name ?? "OTHER_WORKOUT");
    if (!start || !end) {
      warnings.push(`exercise ${typeName}: בלי start/end, דולג`);
      continue;
    }
    const hrSamples: CanonicalWorkoutSample[] = asArray(e.hr_samples)
      .filter((x) => iso(x.time) && isNum(x.bpm))
      .map((x) => ({ metric: "heart_rate", at: x.time as string, value: x.bpm as number, unit: "bpm" }));
    const duration = round((Date.parse(end) - Date.parse(start)) / 1000);
    workouts.push({
      external_id: String(e.id ?? `${typeName}|${start}|${end}`),
      activity_name: typeof e.title === "string" && e.title ? e.title : typeName,
      activity_type: EXERCISE_TYPES[typeName] ?? snake(typeName),
      start_at: start, end_at: end, duration_s: duration,
      active_kcal: isNum(e.active_kcal) ? round(e.active_kcal) : null,
      total_kcal: isNum(e.total_kcal) ? round(e.total_kcal) : null,
      distance_m: isNum(e.distance_m) ? round(e.distance_m) : null,
      elevation_up_m: isNum(e.elevation_gain_m) ? round(e.elevation_gain_m) : null,
      avg_hr: isNum(e.hr_avg) ? round(e.hr_avg) : null,
      max_hr: isNum(e.hr_max) ? e.hr_max : null,
      min_hr: isNum(e.hr_min) ? e.hr_min : null,
      is_indoor: ["RUNNING_TREADMILL", "BIKING_STATIONARY", "SWIMMING_POOL", "ELLIPTICAL", "ROWING_MACHINE"].includes(typeName) ? true : null,
      location: null,
      metrics: isNum(e.steps) ? { steps: { value: e.steps as number, unit: "count" } } : {},
      raw: { hc_type: typeName, hc_type_code: e.type ?? null, origin: e.origin ?? null, notes: e.notes ?? null },
      samples: hrSamples,
      route: [],
      intervals: [],
    });
    // ל-Health Connect אין "דקות אימון" יומיות כמו לאפל. משך האימונים הוא קירוב טוב
    samples.push({ metric: "exercise_minutes", start_at: start, end_at: end, value: round(duration / 60), unit: "min", meta: { derived_from: "exercise_session" } });
  }

  return { batch: { samples, workouts, sleep: [...byNight.values()] }, warnings: [...new Set(warnings)] };
}
