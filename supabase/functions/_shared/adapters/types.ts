// =====================================================================
// המודל הקנוני (CanonicalBatch)
// כל מתאם (Health Auto Export, אפליקציית iOS עתידית, Garmin, Oura...) מחזיר
// את המבנה הזה בדיוק, וה-RPC ingest_canonical_batch יודע לכתוב רק אותו.
// מקור חדש = מתאם חדש. הדאטהבייס והסוכן לא משתנים.
// כל הזמנים ב-ISO 8601 עם offset, וכל הערכים ביחידות הקנוניות (units.ts).
// =====================================================================

export type CanonicalUnit =
  | "count" | "bpm" | "ms" | "kcal" | "kg" | "m" | "min" | "s" | "%"
  | "m/s" | "degC" | "mL/(kg·min)" | "mmHg" | "count/min" | "W"
  // deno-lint-ignore ban-types
  | (string & {}); // יחידה לא מוכרת נשמרת כמו שהיא, לא נזרקת

export interface CanonicalSample {
  metric: string;           // 'steps' | 'heart_rate' | 'hrv_sdnn' | ... (ראו METRIC_MAP)
  start_at: string;
  end_at?: string;          // אם חסר = נקודה (start_at)
  value: number;            // ממוצע כשיש min/avg/max
  value_min?: number | null;
  value_max?: number | null;
  unit: CanonicalUnit;
  meta?: Record<string, unknown>;
}

export interface CanonicalWorkoutSample {
  metric: string;           // 'heart_rate' | 'heart_rate_recovery' | 'step_count' | ...
  at: string;
  value: number;
  value_min?: number | null;
  value_max?: number | null;
  unit: CanonicalUnit;
}

export interface CanonicalRoutePoint {
  at: string;
  lat: number;
  lon: number;
  altitude_m?: number | null;
  speed_mps?: number | null;
  course_deg?: number | null;
  h_accuracy_m?: number | null;
  v_accuracy_m?: number | null;
}

export interface CanonicalWorkout {
  external_id: string;
  activity_name: string;
  activity_type: string;
  start_at: string;
  end_at: string;
  duration_s?: number | null;
  active_kcal?: number | null;
  total_kcal?: number | null;
  distance_m?: number | null;
  elevation_up_m?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  min_hr?: number | null;
  is_indoor?: boolean | null;
  location?: string | null;
  /** כל שדה סקלרי נוסף שהגיע, מנורמל. לא מאבדים מידע. */
  metrics: Record<string, { value: number; unit: CanonicalUnit } | string | number | boolean>;
  /** האובייקט המקורי בלי מערכים כבדים (הם ב-samples/route) */
  raw: Record<string, unknown>;
  samples: CanonicalWorkoutSample[];
  route: CanonicalRoutePoint[];
}

export interface CanonicalSleep {
  sleep_date: string;       // YYYY-MM-DD, היום שבו התעוררת (לפי ה-timezone של המשתמש)
  in_bed_start?: string | null;
  in_bed_end?: string | null;
  asleep_start?: string | null;
  asleep_end?: string | null;
  total_asleep_min?: number | null;
  in_bed_min?: number | null;
  rem_min?: number | null;
  core_min?: number | null;
  deep_min?: number | null;
  awake_min?: number | null;
  stages?: Array<{ stage: string; start_at: string; end_at: string }> | null;
  meta?: Record<string, unknown>;
}

export interface CanonicalBatch {
  samples: CanonicalSample[];
  workouts: CanonicalWorkout[];
  sleep: CanonicalSleep[];
}

export interface AdapterContext {
  /** ה-timezone של המשתמש, למשל 'Asia/Jerusalem'. קובע לאיזה "יום" שייך לילה */
  timezone: string;
}

export interface AdapterResult {
  batch: CanonicalBatch;
  /** דברים שלא הצלחנו לפרש. לא נכשלים בגללם, אבל שומרים אותם ב-ingest_events.stats */
  warnings: string[];
}
