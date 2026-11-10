// =====================================================================
// POST /functions/v1/telegram-webhook         ← טלגרם שולח לכאן כל הודעה
// POST /functions/v1/telegram-webhook/setup   ← רישום ה-webhook בטלגרם (פעם אחת, אידמפוטנטי)
//
// Auth: טלגרם שולח header X-Telegram-Bot-Api-Secret-Token עם הערך שרשמנו ב-setup.
// verify_jwt = false (טלגרם לא שולח JWT), והאימות נעשה כאן.
//
// 🧠 טלגרם מצפה ל-200 תוך שניות, ואחרת שולח את ההודעה שוב. הסוכן יכול לחשוב
//    עשרות שניות, ולכן מחזירים 200 מיד וממשיכים לעבוד ברקע (EdgeRuntime.waitUntil).
//    update_id נשמר בטבלה, כך ש-update כפול לא יעובד פעמיים.
// =====================================================================

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../_shared/supabase.ts";
import { anthropicClient } from "../_shared/anthropic.ts";
import { json } from "../_shared/http.ts";
import { answerCallback, clearKeyboard, downloadFile, sendMessage, sendTyping, setWebhook, type TgUpdate, webhookSecret } from "../_shared/telegram.ts";
import { localDate } from "../_shared/time.ts";
import { transcribe } from "../_shared/transcribe.ts";
import { buildContext, loadProfile } from "../_shared/agent/context.ts";
import { DEFAULT_MODEL, runAgent } from "../_shared/agent/loop.ts";
import { executeTool } from "../_shared/agent/tools.ts";
import { prepareHistory } from "../_shared/agent/history.ts";
import { OFFER_TEXT, onboardingKeyboard } from "../_shared/agent/onboarding.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const anthropic = anthropicClient();

const HISTORY_MESSAGES = 16;      // כמה הודעות קודמות נכנסות כהיסטוריה
const HISTORY_HOURS = 72;         // ורק מה-72 שעות האחרונות
const DAILY_MESSAGE_LIMIT = 150;  // הגנה מעלויות: הודעות משתמש ליום

const HELP = `אני המאמן האישי שלך 💪
אפשר לכתוב לי או לשלוח הודעה קולית, למשל:
• איך ישנתי השבוע?
• איך היה אימון השחייה של הבוקר?
• מה המגמה של הדופק במנוחה בחודשיים האחרונים?
• מה כדאי לעשות היום?
• 📸 תמונה של הארוחה (או תיאור במילים), ואני מעריך קלוריות וחלבון מול התוכנית שלך
• היה לי התקף מיגרנה הבוקר, עוצמה 6 (אני רושם ביומן ומחפש דפוסים)

/new: מתחילים שיחה חדשה (הזיכרון לטווח ארוך נשמר)`;

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;

  if (path.endsWith("/setup")) {
    // רושם את ה-webhook עם הכתובת הקבועה של הפונקציה וה-secret הנגזר.
    // אידמפוטנטי ולא חושף כלום, ולכן לא צריך הגנה נוספת.
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-webhook`;
    await setWebhook(url, await webhookSecret());
    return json({ ok: true, webhook: url });
  }

  if (req.method !== "POST") return json({ ok: false }, 405);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret())) {
    return json({ ok: false }, 401);
  }

  const update = (await req.json()) as TgUpdate;
  const db = serviceClient();

  // מניעת כפילויות: אם ה-update כבר נקלט, לא מעבדים שוב
  const { data: fresh } = await db.from("telegram_updates")
    .upsert({ update_id: update.update_id }, { onConflict: "update_id", ignoreDuplicates: true })
    .select("update_id");
  if (!fresh?.length) return json({ ok: true, duplicate: true });

  EdgeRuntime.waitUntil(handleUpdate(db, update).catch((e) => console.error("handleUpdate failed", e)));
  return json({ ok: true });
});

async function handleUpdate(db: SupabaseClient, update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(db, update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();

  // ---- קישור: /start <קוד>
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      await sendMessage(chatId, "שלום! זה בוט פרטי. כדי להתחבר שלחו: /start ואחריו קוד הקישור שקיבלתם.");
      return;
    }
    const { data: userId } = await db.rpc("redeem_telegram_link_code", {
      p_code: code, p_chat_id: chatId, p_username: msg.from?.username ?? null,
    });
    if (!userId) {
      await sendMessage(chatId, "הקוד לא תקף או שפג תוקפו (15 דקות). אפשר להנפיק קוד חדש.");
      return;
    }
    await sendMessage(chatId, `מחובר ✅\n\n${HELP}`);
    // משתמש חדש: מציעים מיד היכרות קצרה. מי שכבר עבר אותה (חיבור מחדש מטלפון אחר) לא מקבל שוב
    const { data: p } = await db.from("profiles").select("onboarding_status").eq("id", userId).single();
    if (!p?.onboarding_status || p.onboarding_status === "snoozed" || p.onboarding_status === "offered") {
      const tgId = await sendMessage(chatId, OFFER_TEXT, onboardingKeyboard("offer"));
      await Promise.all([
        db.from("profiles").update({ onboarding_status: "offered", onboarding_updated_at: new Date().toISOString() }).eq("id", userId),
        db.from("outbound_notifications").upsert({ user_id: userId, kind: "onboarding", ref_key: "offer", telegram_message_id: tgId }, { onConflict: "user_id,kind,ref_key", ignoreDuplicates: true }),
        db.from("messages").insert({ user_id: userId, role: "assistant", content: OFFER_TEXT, telegram_message_id: tgId, meta: { proactive: "onboarding" } }),
      ]);
    }
    return;
  }

  const { data: link } = await db.from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
  if (!link) {
    await sendMessage(chatId, "הצ'אט הזה לא מחובר. כדי להתחבר שלחו: /start ואחריו קוד הקישור.");
    return;
  }
  const userId = link.user_id as string;

  if (text === "/help") {
    await sendMessage(chatId, HELP);
    return;
  }
  if (text === "/new") {
    await db.from("messages").insert({ user_id: userId, role: "marker", content: "new conversation" });
    await sendMessage(chatId, "התחלנו שיחה חדשה. מה על הפרק?");
    return;
  }

  // ---- הגנת עלויות
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("role", "user").gte("created_at", since);
  if ((count ?? 0) >= DAILY_MESSAGE_LIMIT) {
    await sendMessage(chatId, "הגענו למגבלת ההודעות היומית. נמשיך מחר 🙏");
    return;
  }

  await sendTyping(chatId);
  const profile = await loadProfile(db, userId);

  // ---- מה המשתמש אמר: טקסט, הודעה קולית, תמונה, או קובץ שעוד לא נתמך
  let userText = text;
  let inputKind: "text" | "voice" | "photo" = "text";
  let image: { media_type: ImageType; data: string } | null = null;
  let mediaPath: string | null = null;
  const voice = msg.voice ?? msg.audio;
  if (voice) {
    inputKind = "voice";
    try {
      const file = await downloadFile(voice.file_id);
      userText = await transcribe(file.bytes, file.path.split("/").pop() ?? "voice.ogg");
    } catch (e) {
      console.error("transcription failed", e);
      await sendMessage(chatId, "לא הצלחתי לתמלל את ההודעה הקולית. אפשר לנסות שוב או לכתוב?");
      return;
    }
    if (!userText) {
      await sendMessage(chatId, "לא שמעתי כלום בהקלטה 🙂");
      return;
    }
  } else if (msg.photo || (msg.document && IMAGE_TYPES.includes(msg.document.mime_type as ImageType))) {
    inputKind = "photo";
    // טלגרם שולח כמה גדלים של אותה תמונה, מהקטן לגדול. לוקחים את הגדול ביותר שעדיין מתחת למגבלה
    const fileId = msg.photo
      ? (msg.photo.filter((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES).at(-1) ?? msg.photo[0]).file_id
      : msg.document!.file_id;
    try {
      const file = await downloadFile(fileId);
      if (file.bytes.length > MAX_IMAGE_BYTES) {
        await sendMessage(chatId, "התמונה גדולה מדי. אפשר לשלוח אותה שוב כתמונה רגילה (לא כקובץ)?");
        return;
      }
      const mediaType = msg.document?.mime_type as ImageType | undefined ?? guessImageType(file.path);
      image = { media_type: mediaType, data: toBase64(file.bytes) };
      mediaPath = await storeMedia(db, userId, profile.timezone, msg.message_id, file.bytes, mediaType);
    } catch (e) {
      console.error("photo download failed", e);
      await sendMessage(chatId, "לא הצלחתי לפתוח את התמונה. אפשר לנסות לשלוח שוב?");
      return;
    }
    userText = msg.caption ? msg.caption : "(נשלחה תמונה בלי כיתוב)";
  } else if (msg.document) {
    userText = `[המשתמש שלח קובץ${msg.document.file_name ? ` בשם "${msg.document.file_name}"` : ""}${msg.caption ? ` עם הכיתוב: "${msg.caption}"` : ""}. קריאת קבצים (למשל בדיקות דם ב-PDF) עוד לא זמינה במערכת; תמונה של ארוחה כן נתמכת.]`;
  }
  if (!userText) return;

  // ---- היסטוריה: הודעות אחרונות מאז ה-/new האחרון
  const history = await loadHistory(db, userId);

  const { data: saved } = await db.from("messages").insert({
    user_id: userId, role: "user", content: inputKind === "photo" ? `[תמונה] ${userText}` : userText,
    input_kind: inputKind, telegram_message_id: msg.message_id, media_path: mediaPath,
  }).select("id").single();

  await agentTurn(db, {
    userId, chatId, profile, history,
    userText: inputKind === "voice" ? `(הודעה קולית, תומללה אוטומטית)\n${userText}` : userText,
    echo: inputKind === "voice" ? `🎙️ "${userText}"\n\n` : "",
    images: image ? [image] : undefined,
    savedId: saved?.id, mediaPath, inputKind,
  });
}

type Profile = Awaited<ReturnType<typeof loadProfile>>;

/**
 * תור אחד של הסוכן: הקשר → מודל + כלים → תשובה בטלגרם → שמירה בהיסטוריה.
 * משותף להודעה רגילה ולכפתור "בואו נכיר", שבו userText הוא הוראה יזומה של המערכת.
 */
async function agentTurn(db: SupabaseClient, a: {
  userId: string; chatId: number; profile: Profile; history: Awaited<ReturnType<typeof loadHistory>>;
  userText: string; echo?: string; images?: Array<{ media_type: ImageType; data: string }>;
  savedId?: number; mediaPath?: string | null; inputKind?: "text" | "voice" | "photo";
}): Promise<void> {
  const { userId, chatId, profile } = a;
  const context = await buildContext(db, profile);
  const typing = setInterval(() => sendTyping(chatId), 4500); // "מקליד..." נעלם אחרי 5 שניות
  const effects: { proposedPlanId?: string } = {};

  try {
    const result = await runAgent({
      client: anthropic,
      history: a.history,
      userText: a.userText,
      images: a.images,
      context,
      model: Deno.env.get("COACH_MODEL") ?? DEFAULT_MODEL,
      runTool: (name, input) => executeTool(name, input, {
        db, userId, timezone: profile.timezone, messageId: a.savedId, mediaPath: a.mediaPath ?? null, inputKind: a.inputKind ?? "text", effects,
      }),
    });

    // הצעת תוכנית תזונה: הכפתור הוא הדרך היחידה להפעיל אותה, והמודל לא יכול ללחוץ עליו
    const keyboard = effects.proposedPlanId
      ? [[{ text: "✅ לאשר את התוכנית", callback_data: `plan:approve:${effects.proposedPlanId}` },
          { text: "לא עכשיו", callback_data: `plan:reject:${effects.proposedPlanId}` }]]
      : undefined;
    const tgId = await sendMessage(chatId, `${a.echo ?? ""}${result.text}`, keyboard);
    await db.from("messages").insert({
      user_id: userId, role: "assistant", content: result.text, telegram_message_id: tgId,
      meta: { model: result.model, usage: result.usage, tools: result.toolCalls, iterations: result.iterations, stop: result.stopReason },
    });
  } catch (e) {
    console.error("agent failed", e);
    const reason = e instanceof Anthropic.RateLimitError
      ? "יש עומס רגעי. נסו שוב בעוד דקה."
      : e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError
      ? "יש בעיה במפתח ה-API של Claude. צריך לבדוק את ה-secret ב-Supabase."
      : e instanceof Anthropic.BadRequestError
      ? "יש בעיית הגדרה בחיבור ל-Claude (הפרטים בלוגים של הפונקציה)."
      : "משהו השתבש אצלי. נסו שוב בעוד רגע.";
    await sendMessage(chatId, reason);
  } finally {
    clearInterval(typing);
  }
}

async function loadHistory(db: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - HISTORY_HOURS * 3600 * 1000).toISOString();
  const { data } = await db.from("messages").select("role, content")
    .eq("user_id", userId).gte("created_at", since)
    .order("id", { ascending: false }).limit(HISTORY_MESSAGES + 1);
  return prepareHistory(data ?? []);
}

// ---------------------------------------------------------------------------
// כפתורים (callback_query): כרגע אישור או דחייה של תוכנית תזונה
// ---------------------------------------------------------------------------
async function handleCallback(db: SupabaseClient, cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
  const chatId = cb.message?.chat.id;
  // רק בצ'אט פרטי, ורק מי שהצ'אט שלו (בצ'אט פרטי ה-chat id שווה ל-user id של טלגרם)
  if (!chatId || cb.message?.chat.type !== "private" || cb.from.id !== chatId) return answerCallback(cb.id);
  const { data: link } = await db.from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
  if (!link) return answerCallback(cb.id, "הצ'אט לא מחובר");
  const userId = link.user_id as string;

  if (cb.data === "onb:start" || cb.data === "onb:later") return handleOnboardingCallback(db, cb, userId, chatId);

  const m = (cb.data ?? "").match(/^plan:(approve|reject):([0-9a-f-]{36})$/);
  if (!m) return answerCallback(cb.id);
  const [, action, planId] = m;

  const { error } = await db.rpc(action === "approve" ? "activate_nutrition_plan" : "reject_nutrition_plan", { p_user_id: userId, p_plan_id: planId });
  if (error) {
    console.error("plan callback failed", error);
    await answerCallback(cb.id, /floor/.test(error.message) ? "התוכנית מתחת לרצפת הקלוריות הבטוחה" : "לא הצלחתי לעדכן את התוכנית");
    return;
  }
  await answerCallback(cb.id);
  await clearKeyboard(chatId, cb.message!.message_id);
  const text = action === "approve"
    ? "התוכנית הופעלה ✅ מעכשיו כל ארוחה תיבדק מולה."
    : "בסדר, התוכנית לא הופעלה. אפשר להמשיך לדבר עליה ולשנות.";
  const tgId = await sendMessage(chatId, text);
  // נרשם בהיסטוריה, כדי שהסוכן יידע בהודעה הבאה מה קרה
  await db.from("messages").insert([
    { user_id: userId, role: "user", content: action === "approve" ? "[לחצתי על אישור התוכנית]" : "[לחצתי על 'לא עכשיו' לתוכנית]", input_kind: "text" },
    { user_id: userId, role: "assistant", content: text, telegram_message_id: tgId },
  ]);
}

// ---------------------------------------------------------------------------
// כפתורי ההיכרות: "בואו נכיר" מתחיל שיחת היכרות עם הסוכן, "אחר כך" דוחה ליום
// ---------------------------------------------------------------------------
async function handleOnboardingCallback(
  db: SupabaseClient, cb: NonNullable<TgUpdate["callback_query"]>, userId: string, chatId: number,
): Promise<void> {
  await answerCallback(cb.id);
  await clearKeyboard(chatId, cb.message!.message_id);
  const start = cb.data === "onb:start";
  await db.from("profiles").update({ onboarding_status: start ? "in_progress" : "snoozed", onboarding_updated_at: new Date().toISOString() }).eq("id", userId);

  if (!start) {
    const text = "בכיף 🙂 אזכיר מחר. ובינתיים אפשר לשאול אותי כל דבר, או לשלוח תמונה של ארוחה.";
    const tgId = await sendMessage(chatId, text);
    await db.from("messages").insert([
      { user_id: userId, role: "user", content: "[לחצתי 'אחר כך' על ההיכרות]", input_kind: "text" },
      { user_id: userId, role: "assistant", content: text, telegram_message_id: tgId },
    ]);
    return;
  }

  await sendTyping(chatId);
  const [profile, history] = await Promise.all([loadProfile(db, userId), loadHistory(db, userId)]);
  const { data: saved } = await db.from("messages")
    .insert({ user_id: userId, role: "user", content: "[לחצתי 'בואו נכיר']", input_kind: "text" }).select("id").single();
  await agentTurn(db, {
    userId, chatId, profile, history, savedId: saved?.id,
    userText: "[הודעה יזומה של המערכת, לא נכתבה על ידי המשתמש] המשתמש לחץ \"בואו נכיר\". פתח את ההיכרות: משפט חם אחד על מה שנעשה (כמה שאלות קצרות, אפשר לדלג על כל אחת), ומיד השאלה הראשונה מתוך ה-<context>.",
  });
}

// ---------------------------------------------------------------------------
// תמונות
// ---------------------------------------------------------------------------
type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
const IMAGE_TYPES: ImageType[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // מגבלת ה-API לתמונה ב-base64

function guessImageType(path: string): ImageType {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** שומר את התמונה ב-Storage הפרטי: {user_id}/{יום מקומי}/{message_id}.{ext}. כישלון לא עוצר את השיחה */
async function storeMedia(db: SupabaseClient, userId: string, tz: string, messageId: number, bytes: Uint8Array, type: ImageType): Promise<string | null> {
  const path = `${userId}/${localDate(new Date().toISOString(), tz)}/${messageId}.${type.split("/")[1].replace("jpeg", "jpg")}`;
  const { error } = await db.storage.from("user-media").upload(path, bytes, { contentType: type, upsert: true });
  if (error) {
    console.error("storage upload failed", error);
    return null;
  }
  return path;
}
