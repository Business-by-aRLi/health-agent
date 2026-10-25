// בדיקות למתאם Health Connect (Health Agent Sync).  הרצה: deno task test
import { assert, assertEquals, assertThrows } from "@std/assert";
import { adaptHealthConnect, HcAdapterError, isHealthConnectPayload } from "../../supabase/functions/_shared/adapters/health-connect.ts";

const fixture = JSON.parse(await Deno.readTextFile(new URL("../fixtures/hc-sample.json", import.meta.url)));
const ctx = { timezone: "Asia/Jerusalem", cycleTracking: false };

Deno.test("hc: זיהוי ה-payload, ודחייה של פורמט אחר", () => {
  assert(isHealthConnectPayload(fixture));
  assert(!isHealthConnectPayload({ data: { metrics: [] } }));
  assertThrows(() => adaptHealthConnect({ data: {} }, ctx), HcAdapterError);
});

Deno.test("hc: סיכומים לפי שעה ונקודות → מדדים קנוניים", () => {
  const { batch, warnings } = adaptHealthConnect(fixture, ctx);
  const m = (name: string) => batch.samples.filter((s) => s.metric === name);
  assertEquals(m("steps").map((s) => s.value), [1234]);          // שעה עם 0 צעדים לא נשמרת
  assertEquals(m("walking_running_distance")[0].value, 905.4);
  assertEquals(m("active_energy")[0].unit, "kcal");
  assertEquals(m("heart_rate")[0], {
    metric: "heart_rate", start_at: "2026-11-03T08:00:00+02:00", end_at: "2026-11-03T09:00:00+02:00",
    value: 88.4, unit: "bpm", value_min: 70, value_max: 131,
  });
  assertEquals(m("resting_heart_rate")[0].value, 57);
  assertEquals(m("hrv_rmssd")[0].unit, "ms");                     // לא מתויג כ-SDNN
  assertEquals(m("body_mass")[0].value, 61.8);
  assert(warnings.some((w) => w.includes("stress_level")));        // סוג לא מוכר → אזהרה, לא כישלון
});

Deno.test("hc: שינה עם שלבים, שיוך ליום ההתעוררות, ותנומה לא דורסת לילה", () => {
  const { batch } = adaptHealthConnect(fixture, ctx);
  // הלילה שייך ל-3.11. התנומה ב-14:30 שייכת ללילה של 4.11 (חיתוך ב-12:00)
  assertEquals(batch.sleep.map((s) => s.sleep_date).sort(), ["2026-11-03", "2026-11-04"]);
  const night = batch.sleep.find((s) => s.sleep_date === "2026-11-03")!;
  assertEquals(night.in_bed_min, 430);           // 23:40 → 06:50
  assertEquals(night.deep_min, 70);
  assertEquals(night.rem_min, 70);
  assertEquals(night.awake_min, 10);
  assertEquals(night.core_min, 280);             // 80 + 200
  assertEquals(night.total_asleep_min, 420);
  const nap = batch.sleep.find((s) => s.sleep_date === "2026-11-04")!;
  assertEquals(nap.total_asleep_min, 30);        // בלי שלבים: כל הסשן
  assertEquals(nap.deep_min, null);
});

Deno.test("hc: אימונים ממופים לשמות הקיימים, ודקות אימון נגזרות מהמשך", () => {
  const { batch } = adaptHealthConnect(fixture, ctx);
  const [run, other] = batch.workouts;
  assertEquals(run.activity_type, "outdoor_run");
  assertEquals(run.activity_name, "RUNNING");     // title ריק → שם הסוג
  assertEquals(run.duration_s, 2100);
  assertEquals([run.distance_m, run.avg_hr, run.max_hr], [5120, 152.3, 176]);
  assertEquals(run.samples.length, 2);
  assertEquals(other.activity_type, "some_new_sport");
  assertEquals(other.external_id, "SOME_NEW_SPORT|2026-11-03T18:00:00+02:00|2026-11-03T18:30:00+02:00");
  assertEquals(batch.samples.filter((s) => s.metric === "exercise_minutes").map((s) => s.value), [35, 30]);
});
