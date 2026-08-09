// Mil Palavras — speech-token
//
// Mints a short-lived (10 minute) Azure Speech authorization token for a
// signed-in user, so pronunciation assessment can run in the browser without
// the subscription key ever leaving the server.
//
// Deploy:
//   supabase secrets set AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=uksouth
//   supabase functions deploy speech-token
//
// The key is set as a Supabase secret — it must never appear in any file the
// browser can fetch.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // Only signed-in users — otherwise this is an open proxy to a paid service.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error } = await asUser.auth.getUser();
    if (error || !user) return json({ error: "Not signed in" }, 401);

    const key = Deno.env.get("AZURE_SPEECH_KEY");
    const region = Deno.env.get("AZURE_SPEECH_REGION");
    if (!key || !region) return json({ error: "Speech not configured" }, 500);

    const res = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" } },
    );
    if (!res.ok) {
      return json({ error: `Azure refused the token request (${res.status})` }, 502);
    }

    // Tokens are valid for 10 minutes; the client refreshes as needed.
    return json({ token: await res.text(), region, expiresInSeconds: 540 });
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
