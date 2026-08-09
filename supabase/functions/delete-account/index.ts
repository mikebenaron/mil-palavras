// Mil Palavras — delete-account
//
// Deletes the *login record* for the signed-in user. The browser can already
// delete the user's own row in `progress` (RLS allows it), but removing an auth
// user requires the service-role key, which must never be shipped to a client.
// So that half lives here.
//
// Deploy:
//   supabase functions deploy delete-account
// The SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are injected by
// Supabase automatically — do not add them to any client file.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return json({ error: "Not signed in" }, 401);
    }

    const url = Deno.env.get("SUPABASE_URL")!;

    // Identify the caller from their own JWT — never trust a user id in the body.
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    // Service role: delete the data row, then the login itself.
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    await admin.from("progress").delete().eq("user_id", user.id);

    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ deleted: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
