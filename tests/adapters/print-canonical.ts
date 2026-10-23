// מדפיס את ה-CanonicalBatch של fixture, כדי שבדיקת ה-SQL תשתמש בפלט האמיתי של המתאם
import { adaptHealthAutoExport } from "../../supabase/functions/_shared/adapters/health-auto-export.ts";
const [file, tz = "Asia/Jerusalem", cycle = "false"] = Deno.args;
const { batch } = adaptHealthAutoExport(JSON.parse(Deno.readTextFileSync(file)), { timezone: tz, cycleTracking: cycle === "true" });
console.log(JSON.stringify(batch));
