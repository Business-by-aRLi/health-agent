import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client: עוקף RLS. משתמשים בו **רק** בצד שרת (Edge Functions),
 * ורק אחרי שאימתנו בעצמנו מי הקורא (טוקן קליטה, secret של טלגרם...).
 * SUPABASE_URL ו-SUPABASE_SERVICE_ROLE_KEY מוזרקים אוטומטית ל-Edge Functions.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
