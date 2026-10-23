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
import { json } from "../_shared/http.ts";
import { downloadFile, sendMessage, sendTyping, setWebhook, type TgUpdate, webhookSecret } from "../_shared/telegram.ts";
import { transcribe } from "../_shared/transcribe.ts";
import { buildContext, loadProfile } from "../_shared/agent/context.ts";
import { DEFAULT_MODEL, runAgent } from "../_shared/agent/loop.ts";
import { executeTool } from "../_shared/agent/tools.ts";
import { prepareHistory } from "../_shared/agent/history.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// ANTHROPIC_API_KEY מה-secrets של Supabase. מפתח שלא משויך ל-workspace מחייב גם את
// ה-header של ה-workspace, ולכן אם הוגדר ANTHROPIC_WORKSPACE_ID הוא נשלח בכל בקשה.
const workspaceId = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
const anthropic = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});

const HISTORY_MESSAGES = 16;      // כמה הודעות קודמות נכנסות כהיסטוריה
const HISTORY_HOURS = 72;         // ורק מה-72 שעות האחרונות
const DAILY_MESSAGE_LIMIT = 150;  // הגנה מעלויות: הודעות משתמש ליום

const HELP = `אני המאמן האישי שלך 💪
אפשר לכתוב לי או לשלוח הודעה קולית, למשל:
• איך ישנתי השבוע?
• איך היה אימון השחייה של הבוקר?
• מה המגמה של הדופק במנוחה בחודשיים האחרונים?
• מה כדאי לעשות היום?

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
    await sendMessage(chatId, userId
      ? `מחובר ✅\n\n${HELP}`
      : "הקוד לא תקף או שפג תוקפו (15 דקות). אפשר להנפיק קוד חדש.");
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

  // ---- מה המשתמש אמר: טקסט, הודעה קולית, או משהו שעוד לא נתמך
  let userText = text;
  let inputKind: "text" | "voice" | "photo" = "text";
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
  } else if (msg.photo || msg.document) {
    inputKind = "photo";
    userText = `[המשתמש שלח ${msg.photo ? "תמונה" : "קובץ"}${msg.caption ? ` עם הכיתוב: "${msg.caption}"` : " בלי כיתוב"}. ניתוח תמונות וקבצים (ארוחות, בדיקות דם) עוד לא זמין במערכת.]`;
  }
  if (!userText) return;

  // ---- היסטוריה: הודעות אחרונות מאז ה-/new האחרון
  const history = await loadHistory(db, userId);

  const { data: saved } = await db.from("messages").insert({
    user_id: userId, role: "user", content: userText, input_kind: inputKind, telegram_message_id: msg.message_id,
  }).select("id").single();

  const profile = await loadProfile(db, userId);
  const context = await buildContext(db, profile);
  const typing = setInterval(() => sendTyping(chatId), 4500); // "מקליד..." נעלם אחרי 5 שניות

  try {
    const result = await runAgent({
      client: anthropic,
      history,
      userText: inputKind === "voice" ? `(הודעה קולית, תומללה אוטומטית)\n${userText}` : userText,
      context,
      model: Deno.env.get("COACH_MODEL") ?? DEFAULT_MODEL,
      runTool: (name, input) => executeTool(name, input, { db, userId, timezone: profile.timezone, messageId: saved?.id }),
    });

    const reply = inputKind === "voice" ? `🎙️ "${userText}"\n\n${result.text}` : result.text;
    const tgId = await sendMessage(chatId, reply);
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
