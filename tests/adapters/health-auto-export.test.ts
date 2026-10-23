// בדיקות למתאם Health Auto Export.  הרצה: deno task test
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { adaptHealthAutoExport, AdapterError, snake } from "../../supabase/functions/_shared/adapters/health-auto-export.ts";
import { parseHaeDate } from "../../supabase/functions/_shared/time.ts";
import { normalize } from "../../supabase/functions/_shared/units.ts";

const ctx = { timezone: "Asia/Jerusalem", cycleTracking: false };
const load = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

Deno.test("parseHaeDate: פורמט HAE → ISO עם offset", () => {
  assertEquals(parseHaeDate("2026-10-22 07:15:00 +0300"), "2026-10-22T07:15:00+03:00");
  assertEquals(parseHaeDate("2026-10-22T07:15:00Z"), "2026-10-22T07:15:00Z");
  assertEquals(parseHaeDate("not a date"), null);
  assertEquals(parseHaeDate(undefined), null);
});

Deno.test("normalize: המרות יחידות", () => {
  assertAlmostEquals(normalize(1255.2, "kJ").value, 300, 0.01);
  assertEquals(normalize(1255.2, "kJ").unit, "kcal");
  assertEquals(normalize(6.42, "km"), { value: 6420, unit: "m" });
  assertAlmostEquals(normalize(150, "lb").value, 68.04, 0.01);
  assertEquals(normalize(72, "count/min"), { value: 72, unit: "bpm" });
  assertEquals(normalize(7.5, "hr"), { value: 450, unit: "min" });
  assertEquals(normalize(3, "furlongs"), { value: 3, unit: "furlongs" }); // לא מוכר = לא נזרק
});

Deno.test("snake: שמות אימונים ושדות", () => {
  assertEquals(snake("Outdoor Run"), "outdoor_run");
  assertEquals(snake("heartRateRecovery"), "heart_rate_recovery");
  assertEquals(snake("ריצה בחוץ"), "ריצה_בחוץ");
});

Deno.test("metrics: מיפוי, יחידות, min/avg/max ומדדים לא מוכרים", () => {
  const { batch, warnings } = adaptHealthAutoExport(load("hae-sample.json"), ctx);
  const by = (m: string) => batch.samples.filter((s) => s.metric === m);

  assertEquals(by("steps").length, 4); // הכפילות מטופלת ב-DB (distinct on + unique)
  assertEquals(by("steps")[0].unit, "count");

  const hr = by("heart_rate")[0];
  assertEquals([hr.value, hr.value_min, hr.value_max, hr.unit], [72.4, 58, 141, "bpm"]);

  assertAlmostEquals(by("active_energy")[0].value, 300, 0.01);
  assertEquals(by("active_energy")[0].unit, "kcal");
  assertEquals(by("hrv_sdnn").length, 2);
  assertEquals(by("resting_heart_rate")[0].value, 56);
  assertEquals(by("body_mass")[0].value, 64.3);

  // לחץ דם: אין qty, אז כל שדה מספרי הופך למדד
  assertEquals(by("blood_pressure_systolic")[0].value, 112);
  assertEquals(by("blood_pressure_diastolic")[0].value, 71);

  // מדד שלא מכירים נשמר בשם המקורי, לא נזרק
  assertEquals(by("some_future_metric")[0].unit, "furlongs");
  assertEquals(warnings, []);
});

Deno.test("sleep: פורמט מצטבר (Aggregate)", () => {
  const { batch } = adaptHealthAutoExport(load("hae-sample.json"), ctx);
  assertEquals(batch.sleep.length, 1);
  const s = batch.sleep[0];
  assertEquals(s.sleep_date, "2026-10-22"); // יום ההתעוררות
  assertEquals(s.total_asleep_min, 423);
  assertEquals(s.deep_min, 69);
  assertEquals(s.rem_min, 120);
  assertEquals(s.in_bed_min, 456);
  assertEquals(s.asleep_start, "2026-10-21T23:20:00+03:00");
});

Deno.test("sleep: פורמט מקטעים מקובץ ללילה אחד, גם מקטע שנגמר לפני חצות", () => {
  const { batch } = adaptHealthAutoExport(load("hae-sleep-segments.json"), ctx);
  assertEquals(batch.sleep.length, 1);
  const s = batch.sleep[0];
  assertEquals(s.sleep_date, "2026-10-22");
  assertEquals(s.total_asleep_min, 405); // 90 + 60 + 45 + 210
  assertEquals(s.awake_min, 15);
  assertEquals(s.core_min, 300);
  assertEquals(s.stages?.length, 5);
  assertEquals(s.in_bed_min, 420); // אין In Bed → מתחילת המקטע הראשון עד הסוף
});

Deno.test("workouts: כל הפרטים הפנימיים נשמרים", () => {
  const { batch } = adaptHealthAutoExport(load("hae-sample.json"), ctx);
  assertEquals(batch.workouts.length, 2);
  const run = batch.workouts[0];

  assertEquals(run.activity_type, "outdoor_run");
  assertEquals(run.distance_m, 6420);
  assertEquals(run.active_kcal, 412.5);
  assertEquals([run.min_hr, run.avg_hr, run.max_hr], [96, 148, 171]);
  assertEquals(run.is_indoor, false);
  assertEquals(run.duration_s, 2550);

  // שדות סקלריים נוספים → metrics, מנורמלים
  assertEquals(run.metrics.temperature, { value: 22.5, unit: "degC" });
  assertEquals(run.metrics.humidity, { value: 61, unit: "%" });
  assert("intensity" in run.metrics);

  // סדרות זמן
  const metrics = new Set(run.samples.map((s) => s.metric));
  assertEquals([...metrics].sort(), ["heart_rate", "heart_rate_recovery", "step_count", "walking_and_running_distance"]);
  assertEquals(run.samples.filter((s) => s.metric === "heart_rate").length, 3);
  assertEquals(run.samples.find((s) => s.metric === "walking_and_running_distance")?.value, 151);

  // מסלול
  assertEquals(run.route.length, 2);
  assertEquals(run.route[0], {
    at: "2026-10-22T07:10:00+03:00", lat: 32.0853, lon: 34.7818, altitude_m: 12.1,
    speed_mps: 2.6, course_deg: 180.5, h_accuracy_m: 4.2, v_accuracy_m: 3.1,
  });

  // raw לא מכיל את המערכים הכבדים, אבל כן את כל השאר
  assert(!("route" in run.raw) && !("heartRateData" in run.raw));
  assertEquals(run.raw.name, "Outdoor Run");

  const strength = batch.workouts[1];
  assertEquals(strength.activity_type, "traditional_strength_training");
  assertEquals([strength.avg_hr, strength.max_hr], [118, 152]);
  assertEquals(strength.is_indoor, true);
});

Deno.test("payload לא מוכר זורק AdapterError (→ 422)", () => {
  assertThrows(() => adaptHealthAutoExport({ foo: 1 }, ctx), AdapterError);
});

Deno.test("payload ריק תקין = batch ריק", () => {
  const { batch } = adaptHealthAutoExport({ data: { metrics: [], workouts: [] } }, ctx);
  assertEquals(batch, { samples: [], workouts: [], sleep: [] });
});

Deno.test("מחזור: כשהמעקב כבוי, נתוני מחזור לא נקלטים בכלל", () => {
  const { batch, warnings } = adaptHealthAutoExport(load("hae-cycle.json"), { ...ctx, cycleTracking: false });
  assertEquals(batch.samples.map((s) => s.metric), ["steps"]);
  assertEquals(warnings, ["מעקב מחזור כבוי: 17 נקודות מחזור לא נקלטו"]);
});

Deno.test("מחזור: כשהמעקב מופעל, ערכים קטגוריאליים מקודדים והטקסט נשמר", () => {
  const { batch, warnings } = adaptHealthAutoExport(load("hae-cycle.json"), { ...ctx, cycleTracking: true });
  const flow = batch.samples.filter((s) => s.metric === "menstrual_flow");
  assertEquals(flow.length, 15);
  assertEquals([flow[0].value, flow[0].unit, flow[0].meta?.category], [2, "category", "Medium"]);
  assertEquals(flow[1].value, 3); // Heavy
  assertEquals(flow.at(-1)?.value, 0); // None
  const mucus = batch.samples.find((s) => s.metric === "cervical_mucus_quality");
  assertEquals([mucus?.value, mucus?.meta?.category], [3, "Creamy"]);
  assertEquals(batch.samples.find((s) => s.metric === "basal_body_temperature")?.unit, "degC");
  assertEquals(warnings, []);
});

Deno.test("ערך קטגוריאלי לא מוכר נשמר כ-1 עם הטקסט, לא נזרק", () => {
  const { batch } = adaptHealthAutoExport({
    data: { metrics: [{ name: "handwashing", units: "", data: [{ date: "2026-10-22 08:00:00 +0300", value: "Complete" }] }] },
  }, ctx);
  assertEquals(batch.samples[0].value, 1);
  assertEquals(batch.samples[0].meta?.category, "Complete");
});
