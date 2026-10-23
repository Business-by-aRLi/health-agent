// מדפיס את ה-CanonicalBatch של fixture, כדי שבדיקת ה-SQL תשתמש בפלט האמיתי של המתאם
import { adaptHealthAutoExport } from "../../supabase/functions/_shared/adapters/health-auto-export.ts";
const [file, tz = "Asia/Jerusalem"] = Deno.args;
const { batch } = adaptHealthAutoExport(JSON.parse(Deno.readTextFileSync(file)), { timezone: tz });
console.log(JSON.stringify(batch));
