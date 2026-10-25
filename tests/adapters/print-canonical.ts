// מדפיס את ה-CanonicalBatch של fixture, כדי שבדיקת ה-SQL תשתמש בפלט האמיתי של המתאם
// (המתאם נבחר לפי מבנה ה-payload, כמו ב-ingest-healthkit)
import { adaptHealthAutoExport } from "../../supabase/functions/_shared/adapters/health-auto-export.ts";
import { adaptHealthConnect, isHealthConnectPayload } from "../../supabase/functions/_shared/adapters/health-connect.ts";
const [file, tz = "Asia/Jerusalem", cycle = "false"] = Deno.args;
const payload = JSON.parse(Deno.readTextFileSync(file));
const ctx = { timezone: tz, cycleTracking: cycle === "true" };
const { batch } = isHealthConnectPayload(payload) ? adaptHealthConnect(payload, ctx) : adaptHealthAutoExport(payload, ctx);
console.log(JSON.stringify(batch));
