// =====================================================================
// POST /functions/v1/ingest-healthkit
// מקבל JSON מ-Health Auto Export (iPhone) או מ-Health Agent Sync (אנדרואיד, Health Connect)
// וכותב למודל הקנוני. המתאם נבחר לפי מבנה ה-payload.
//
// Auth: Authorization: Bearer <ingest_token>  (לא JWT של Supabase!)
//   הטוקן מונפק ב-create_ingest_source() ונשמר אצלנו רק כ-hash.
//   לכן הפונקציה נפרסת עם verify_jwt = false, ומאמתת בעצמה.
//
// זרימה: auth → ingest_events (raw) → adapter → RPC אחד בטרנזקציה → stats
//
// POST /functions/v1/ingest-healthkit/replay   (תחזוקה)
// מריץ מחדש payloads שמורים מ-ingest_events דרך המתאם העדכני. משתמשים בזה אחרי תיקון
// במתאם, כדי שהתיקון יחול גם על מידע שכבר נקלט. בזכות ה-upserts זה אידמפוטנטי.
// Auth: header x-replay-secret = REPLAY_SECRET (Edge Function secret). בלי secret מוגדר → 404.
// Body: { "event_ids": [1, 2, 3] }  או  { "all": true }
// =====================================================================

import { adaptHealthAutoExport, AdapterError } from "../_shared/adapters/health-auto-export.ts";
import { adaptHealthConnect, HcAdapterError, isHealthConnectPayload } from "../_shared/adapters/health-connect.ts";
import { bearerToken, error, json, sha256Hex } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

type Profile = { timezone: string; cycle_tracking_enabled: boolean };

// payload גדול מזה = כנראה backfill של הרבה זמן בבת אחת. עדיף לפצל (ראו docs/setup)
const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method !== "POST") return error(405, "method_not_allowed", "רק POST");
  if (new URL(req.url).pathname.endsWith("/replay")) return await replay(req);

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
    .select("id, user_id, status, profiles!inner(timezone, cycle_tracking_enabled)")
    .eq("id", secret.source_id)
    .single();
  if (!source || source.status !== "active") return error(401, "source_inactive", "המקור בוטל");
  const profile = source.profiles as unknown as Profile;

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

  const r = await processEvent(db, event.id, source.id, profile, payload);
  return r.ok ? json({ ok: true, event_id: event.id, ...r.result }) : error(r.status, r.code, r.message, { event_id: event.id });
});

// ---------------------------------------------------------------------------
// המרה + כתיבה + עדכון סטטוס. משותף לקליטה רגילה ול-replay.
// ---------------------------------------------------------------------------
type ProcessResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

async function processEvent(
  db: SupabaseClient, eventId: number, sourceId: string, profile: Profile, payload: unknown,
): Promise<ProcessResult> {
  const fail = async (status: number, code: string, message: string): Promise<ProcessResult> => {
    await db.from("ingest_events")
      .update({ status: "failed", error: `${code}: ${message}`, processed_at: new Date().toISOString() })
      .eq("id", eventId);
    return { ok: false, status, code, message };
  };

  // ---- 4. המרה למודל הקנוני
  let adapted;
  try {
    const ctx = { timezone: profile.timezone, cycleTracking: profile.cycle_tracking_enabled };
    adapted = isHealthConnectPayload(payload) ? adaptHealthConnect(payload, ctx) : adaptHealthAutoExport(payload, ctx);
  } catch (e) {
    if (e instanceof AdapterError || e instanceof HcAdapterError) return await fail(422, "unrecognized_format", e.message);
    return await fail(500, "adapter_crash", String(e));
  }

  // ---- 5. כתיבה אטומית
  const { data: stats, error: rpcErr } = await db.rpc("ingest_canonical_batch", {
    p_source_id: sourceId,
    p_batch: adapted.batch,
  });
  if (rpcErr) {
    console.error("ingest_canonical_batch failed", { event_id: eventId, rpcErr });
    return await fail(500, "write_failed", rpcErr.message);
  }

  const result = { ...stats, warnings: adapted.warnings };
  await db.from("ingest_events")
    .update({ status: "processed", error: null, stats: result, processed_at: new Date().toISOString() })
    .eq("id", eventId);
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// replay: הרצה מחדש של payloads שמורים
// ---------------------------------------------------------------------------
async function replay(req: Request): Promise<Response> {
  const secret = Deno.env.get("REPLAY_SECRET");
  if (!secret) return error(404, "not_found", "לא נמצא");
  // משווים hash-ים ולא מחרוזות, כדי שזמן ההשוואה לא ידליף כמה תווים נכונים (timing attack)
  const given = req.headers.get("x-replay-secret") ?? "";
  if ((await sha256Hex(given)) !== (await sha256Hex(secret))) return error(401, "invalid_secret", "לא מורשה");

  let body: { event_ids?: number[]; all?: boolean };
  try {
    body = await req.json();
  } catch {
    return error(400, "invalid_json", "הגוף אינו JSON תקין");
  }

  const db = serviceClient();
  let q = db.from("ingest_events")
    .select("id, source_id, payload, data_sources!inner(status, profiles!inner(timezone, cycle_tracking_enabled))")
    .order("id")
    .limit(500);
  if (body.event_ids?.length) q = q.in("id", body.event_ids);
  else if (!body.all) return error(400, "missing_target", "צריך event_ids או all: true");

  const { data: events, error: qErr } = await q;
  if (qErr) return error(500, "db_error", qErr.message);

  const results = [];
  for (const ev of events ?? []) {
    const src = ev.data_sources as unknown as { status: string; profiles: Profile };
    if (src.status !== "active") {
      results.push({ event_id: ev.id, ok: false, code: "source_inactive" });
      continue;
    }
    const r = await processEvent(db, ev.id, ev.source_id, src.profiles, ev.payload);
    results.push(r.ok ? { event_id: ev.id, ok: true, ...r.result } : { event_id: ev.id, ...r });
  }
  return json({ ok: results.every((r) => r.ok), replayed: results.length, results });
}
