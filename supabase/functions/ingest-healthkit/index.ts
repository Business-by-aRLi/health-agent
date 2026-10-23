// =====================================================================
// POST /functions/v1/ingest-healthkit
// מקבל JSON מ-Health Auto Export (REST API automation) וכותב למודל הקנוני.
//
// Auth: Authorization: Bearer <ingest_token>  (לא JWT של Supabase!)
//   הטוקן מונפק ב-create_ingest_source() ונשמר אצלנו רק כ-hash.
//   לכן הפונקציה נפרסת עם verify_jwt = false, ומאמתת בעצמה.
//
// זרימה: auth → ingest_events (raw) → adapter → RPC אחד בטרנזקציה → stats
// =====================================================================

import { adaptHealthAutoExport, AdapterError } from "../_shared/adapters/health-auto-export.ts";
import { bearerToken, error, json, sha256Hex } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

// payload גדול מזה = כנראה backfill של הרבה זמן בבת אחת. עדיף לפצל (ראו docs/setup)
const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method !== "POST") return error(405, "method_not_allowed", "רק POST");

  // ---- 1. אימות
  const token = bearerToken(req);
  if (!token) return error(401, "missing_token", "חסר Authorization: Bearer <token>");

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return error(413, "payload_too_large", "ה-payload גדול מדי. כדאי לפצל את הייצוא לטווחי תאריכים קצרים יותר");

  const db = serviceClient();
  const hash = await sha256Hex(token);

  const { data: secret, error: secretErr } = await db
    .from("data_source_secrets")
    .select("source_id")
    .eq("ingest_token_hash", hash)
    .maybeSingle();
  if (secretErr) return error(500, "db_error", "שגיאה בבדיקת הטוקן");
  if (!secret) return error(401, "invalid_token", "טוקן לא תקין");

  const { data: source } = await db
    .from("data_sources")
    .select("id, user_id, status, profiles!inner(timezone)")
    .eq("id", secret.source_id)
    .single();
  if (!source || source.status !== "active") return error(401, "source_inactive", "המקור בוטל");
  const timezone = (source.profiles as unknown as { timezone: string }).timezone;

  // ---- 2. קריאת הגוף
  const text = await req.text();
  if (text.length > MAX_BYTES) return error(413, "payload_too_large", "ה-payload גדול מדי");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return error(400, "invalid_json", "הגוף אינו JSON תקין");
  }

  // ---- 3. שמירה גולמית לפני כל עיבוד: אם המתאם ייכשל, המידע לא אבד
  const { data: event, error: eventErr } = await db
    .from("ingest_events")
    .insert({ user_id: source.user_id, source_id: source.id, payload })
    .select("id")
    .single();
  if (eventErr || !event) return error(500, "db_error", "שמירת ה-payload נכשלה");

  const fail = async (status: number, code: string, message: string) => {
    await db.from("ingest_events")
      .update({ status: "failed", error: `${code}: ${message}`, processed_at: new Date().toISOString() })
      .eq("id", event.id);
    return error(status, code, message, { event_id: event.id });
  };

  // ---- 4. המרה למודל הקנוני
  let adapted;
  try {
    adapted = adaptHealthAutoExport(payload, { timezone });
  } catch (e) {
    if (e instanceof AdapterError) return await fail(422, "unrecognized_format", e.message);
    return await fail(500, "adapter_crash", String(e));
  }

  // ---- 5. כתיבה אטומית
  const { data: stats, error: rpcErr } = await db.rpc("ingest_canonical_batch", {
    p_source_id: source.id,
    p_batch: adapted.batch,
  });
  if (rpcErr) {
    console.error("ingest_canonical_batch failed", { event_id: event.id, rpcErr });
    return await fail(500, "write_failed", rpcErr.message);
  }

  const result = { ...stats, warnings: adapted.warnings };
  await db.from("ingest_events")
    .update({ status: "processed", stats: result, processed_at: new Date().toISOString() })
    .eq("id", event.id);

  return json({ ok: true, event_id: event.id, ...result });
});
