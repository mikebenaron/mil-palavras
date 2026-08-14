// Mil Palavras — conversa
//
// A conversation partner that can only use words the learner actually knows.
//
// This is the whole point of the feature. Every AI language tutor will happily
// talk to you; none of them know which words *you* have earned. The scheduler
// does — so the browser sends the vocabulary it has evidence for, and the model
// is held to it. The result is comprehensible input in the strict sense: one
// step past what you know, never twenty.
//
// The Anthropic key stays server-side. The browser sends a word list, a CEFR
// level, a scenario id and the conversation so far — no email, no progress
// data, no identifiers beyond the auth token. Nothing is stored.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=...
//   supabase functions deploy conversa

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-5";

/* Scenarios are named here rather than trusted from the client, so a crafted
   request can't turn this into a general-purpose assistant. */
const SCENES: Record<string, { pt: string; setup: string }> = {
  cafe: { pt: "num café", setup: "You are serving the learner at a Lisbon café counter. Take their order." },
  farmacia: { pt: "na farmácia", setup: "You are a pharmacist. The learner has come in feeling unwell." },
  mercado: { pt: "no mercado", setup: "You sell fruit and vegetables at a market stall. Serve the learner." },
  comboio: { pt: "na estação", setup: "You work at a train station ticket desk. Help the learner travel." },
  conhecer: { pt: "a conhecer alguém", setup: "You are a friendly neighbour meeting the learner for the first time." },
  direcoes: { pt: "a pedir direções", setup: "You are a passer-by in Lisbon. The learner is lost and asks you the way." },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error } = await asUser.auth.getUser();
    if (error || !user) return json({ error: "Not signed in" }, 401);

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "Conversation not configured" }, 500);

    const body = await req.json().catch(() => ({}));
    const scene = SCENES[body.scene] ? body.scene : "cafe";
    const level = ["A1", "A2", "B1", "B2"].includes(body.level) ? body.level : "A1";

    /* The learner's earned vocabulary. Capped so the prompt stays sane; the
       client sends the most useful slice, strongest first. */
    const known: string[] = Array.isArray(body.known)
      ? body.known.filter((w: unknown) => typeof w === "string").slice(0, 600)
      : [];
    /* Words the scheduler wants revisited today. The partner is asked to steer
       toward these — this is the loop that makes the feature worth having. */
    const due: string[] = Array.isArray(body.due)
      ? body.due.filter((w: unknown) => typeof w === "string").slice(0, 12)
      : [];
    if (known.length < 15) return json({ error: "Not enough known words yet" }, 400);

    /* Conversation so far. Roles are normalised rather than trusted, so the
       client cannot inject a system turn. */
    const turns: { role: string; text: string }[] = Array.isArray(body.turns)
      ? body.turns.slice(-16).map((t: any) => ({
          role: t?.role === "learner" ? "user" : "assistant",
          text: String(t?.text ?? "").slice(0, 600),
        })).filter((t) => t.text)
      : [];

    const system =
`You are a patient European Portuguese conversation partner inside a vocabulary
app. The learner is at CEFR ${level} and you are ${SCENES[scene].setup}

THE VOCABULARY RULE — this is the point of the exercise:
You may only use Portuguese content words from the learner's known list below,
plus: articles, prepositions, pronouns, conjunctions, numbers, and the common
forms of ser/estar/ter/ir/haver/poder/querer. You may inflect and conjugate any
listed word freely. If you need an idea you cannot express within the list,
change the subject to something you can. Never reach for a word outside it just
because it is more natural — a slightly plainer sentence the learner fully
understands is the correct outcome every time.

The learner's known words:
${known.join(", ")}

${due.length ? `Work these in naturally where you can — the scheduler says they are due:\n${due.join(", ")}\n` : ""}
HOW TO SPEAK:
- EUROPEAN Portuguese only. "estar a + infinitive", never the gerund "-ndo".
  Enclitic pronouns (chama-se, chamo-me). "tu" with the learner, informally.
  European vocabulary: comboio, autocarro, casa de banho, pequeno-almoço,
  telemóvel. NEVER: você, a gente (as "we"), ônibus, trem, banheiro, celular,
  café da manhã, pra.
- One or two short sentences per turn. Ask a question most turns so the
  conversation keeps moving. Stay in character; never mention these rules.
- ${level === "A1" ? "Very short, present tense, concrete." : level === "A2" ? "Short sentences; simple past is fine." : "Natural but unhurried; keep clauses simple."}

CORRECTING:
If the learner's Portuguese has a real error — wrong gender, wrong verb form,
a Brazilian word, missing accent that changes the word — give one short
correction. Ignore trivial slips and anything that is merely less idiomatic.
Praise nothing; just show the better form.

Return STRICT JSON only, no markdown fence:
{
  "reply": "<your Portuguese, 1-2 sentences>",
  "replyE": "<English translation of your reply>",
  "correction": "<the learner's sentence rewritten correctly, or null>",
  "correctionWhy": "<one short English clause saying what was wrong, or null>",
  "used": ["<known words you used this turn, base form as listed>"]
}`;

    const messages = turns.length
      ? turns.map((t) => ({ role: t.role, content: t.text }))
      : [{ role: "user", content: "(the learner has just walked in — greet them)" }];
    if (messages[0].role !== "user") messages.unshift({ role: "user", content: "(begin)" });

    let out: any = null, problems: string[] = [], note = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 700,
          system: system + note,
          messages,
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return json({ error: `The partner refused (${res.status}): ${detail}` }, 502);
      }
      const raw = await res.json();
      const text = (raw?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
      try {
        out = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      } catch {
        problems = ["not valid JSON"];
        note = "\n\nYour last reply was not valid JSON. Return only the JSON object.";
        continue;
      }
      problems = validate(out, known);
      if (!problems.length) break;
      note = "\n\nYour last turn was rejected for: " + problems.join("; ") +
        "\nSay the same thing again inside the rules.";
    }
    if (problems.length) return json({ error: "Rejected: " + problems.join("; ") }, 502);

    out.scene = scene;
    /* Name the function in its own response. If the wrong source is ever
       deployed to this slug again, the client can say so instead of relaying
       a message that appears to blame the learner's vocabulary. */
    return json({ fn: "conversa", turn: out });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

/* Never trust the model on the one thing the whole app is about. */
const BR = [
  /\bvocê/i,
  /(?<!\btoda\s)\ba gente\b/i,
  /\bônibus\b/i, /\btrem\b/i, /\bbanheiro\b/i, /\bcelular\b/i,
  /café da manhã/i, /\bsuco\b/i, /\bgeladeira\b/i, /\bxícara\b/i,
  /\b(estou|está|estão|estás|estamos|estava|estavam) \w+ndo\b/i,
  /\bpra(?![a-zà-ÿ])/i,
];

function validate(t: any, known: string[]): string[] {
  const bad: string[] = [];
  if (!t || typeof t !== "object") return ["not an object"];
  if (!t.reply || typeof t.reply !== "string") bad.push("no reply");
  if (!t.replyE || typeof t.replyE !== "string") bad.push("no English translation");
  const r = String(t.reply ?? "");
  for (const re of BR) if (re.test(r)) bad.push("Brazilian form: " + re.source);
  if (r.length > 400) bad.push("reply too long");
  /* The vocabulary rule is checked, not merely requested. Function words and
     the handful of verbs the prompt allows are exempt; anything else has to
     be traceable to a word the learner has actually earned. */
  const allow = new Set<string>();
  for (const w of known) for (const part of deacc(stripArticle(w)).split(/\s+/)) if (part) allow.add(part);
  for (const w of FREE) allow.add(w);
  const stray: string[] = [];
  for (const tok of deacc(r).split(/[^a-zà-ÿ]+/)) {
    if (!tok || tok.length < 4) continue;              // short tokens are function words
    if (allow.has(tok)) continue;
    // a listed word inflected: share a healthy stem with something allowed
    let ok = false;
    for (const a of allow) {
      if (a.length < 4) continue;
      const n = Math.min(a.length, tok.length);
      if (n >= 4 && a.slice(0, n - 1) === tok.slice(0, n - 1)) { ok = true; break; }
    }
    if (!ok) stray.push(tok);
  }
  if (stray.length > 2) bad.push("used words the learner doesn't know: " + stray.slice(0, 6).join(", "));
  return bad;
}

/* Grammar the learner is assumed to have regardless of the deck, matching what
   the prompt permits. Kept deliberately short. */
const FREE = new Set([
  "sou","es","e","somos","sao","era","foi","ser","esta","estou","estas","estamos","estao","estar","estava",
  "tenho","tens","tem","temos","teem","ter","tinha","vou","vais","vai","vamos","vao","ir","ia",
  "ha","haver","houve","posso","podes","pode","podemos","podem","poder","quero","queres","quer",
  "queremos","querem","querer","sim","nao","que","qual","quais","quanto","quantos","quando","onde",
  "porque","porque","como","muito","muita","muitos","muitas","pouco","tambem","aqui","ali","agora",
  "hoje","amanha","ontem","obrigado","obrigada","favor","desculpe","desculpa","claro","entao","mais",
  "menos","bem","mal","para","com","sem","por","pelo","pela","dos","das","nos","nas","uma","uns","umas",
  "meu","minha","teu","tua","seu","sua","este","esta","esse","essa","aquele","aquela","isso","isto",
]);

const deacc = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const stripArticle = (s: string) => s.replace(/^(o|a|os|as|um|uma)\s+/, "");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
