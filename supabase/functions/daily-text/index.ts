// Mil Palavras — daily-text
//
// Writes one short European Portuguese passage built from the words the
// scheduler says are due for this user today, so revision stops being a list
// of isolated cards and becomes something to read.
//
// The Anthropic key stays server-side. The browser sends only the vocabulary
// it wants used — no progress data, no identifiers beyond the auth token.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=...
//   supabase functions deploy daily-text

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-5";

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
    if (!key) return json({ error: "Text generation not configured" }, 500);

    const body = await req.json().catch(() => ({}));
    const words: string[] = Array.isArray(body.words)
      ? body.words.filter((w: unknown) => typeof w === "string").slice(0, 14)
      : [];
    const level = ["A1", "A2", "B1", "B2"].includes(body.level) ? body.level : "A1";
    if (words.length < 3) return json({ error: "Not enough words to write about" }, 400);

    const prompt =
`Write ONE short passage in EUROPEAN Portuguese (Portugal) at CEFR level ${level}.

It must naturally use as many of these words as it sensibly can:
${words.map((w) => "- " + w).join("\n")}

Hard requirements:
- EUROPEAN Portuguese only. Never Brazilian. Use "estar a + infinitive" (never the gerund
  "-ndo"), enclitic pronouns (chama-se, levanta-se), "tu" for informal you, and European
  vocabulary (comboio, autocarro, casa de banho, pequeno-almoço, telemóvel, telefone).
  Never use: você, a gente (as "we"), ônibus, trem, banheiro, celular, café da manhã, pra.
- 4 to 6 sentences, each a complete thought that stands on its own line.
- Everyday and concrete — someone's morning, a shop, a walk, the weather. Not abstract.
- Level ${level}: keep the grammar and vocabulary appropriate to it.

Return STRICT JSON only, no markdown fence, exactly this shape:
{
  "title": "<short Portuguese title, 2-5 words>",
  "titleE": "<English translation of the title>",
  "lines": [{"pt": "<one sentence>", "en": "<its English translation>"}],
  "gaps": ["<2-4 words taken verbatim from the sentences above, for a fill-in exercise>"],
  "questions": [
    {"q": "<a comprehension question in Portuguese>",
     "qE": "<the same question in English>",
     "options": ["<option>", "<option>", "<option>"],
     "answer": <index of the correct option, 0-based>}
  ]
}
Include 2 questions. Every string in "gaps" must appear exactly as written in one of the
sentences.`;

    /* One retry, with the specific complaint fed back. A single Brazilian
       slip or a gap that isn't verbatim is easy to correct and shouldn't cost
       the user a failed tap — but we still never lower the bar. */
    let passage: any = null, problems: string[] = [], lastNote = "";
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
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt + lastNote }],
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return json({ error: `The writer refused (${res.status}): ${detail}` }, 502);
      }

      const out = await res.json();
      const text = (out?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
      try {
        // Be forgiving about a stray fence; anything else is a genuine failure.
        passage = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      } catch {
        problems = ["the response was not valid JSON"];
        lastNote = "\n\nYour last reply was not valid JSON. Return only the JSON object.";
        continue;
      }
      problems = validate(passage);
      if (!problems.length) break;
      lastNote = "\n\nYour last attempt was rejected for: " + problems.join("; ") +
        "\nFix exactly that and return the JSON again.";
    }
    if (problems.length) return json({ error: "Rejected: " + problems.join("; ") }, 502);

    passage.level = level;
    passage.ai = true;                    // always flagged in the UI
    passage.usedWords = words.filter((w) =>
      passage.lines.some((l: any) => deacc(l.pt).includes(deacc(stripArticle(w)))));

    return json({ passage });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

/* Never trust the model on the one thing the whole app is about. */
const BR = [
  /\bvocê/i,
  // "toda a gente" is standard European Portuguese for "everyone" — only the
  // subject-pronoun use ("a gente vai") is the Brazilian marker. Rejecting the
  // first threw away perfectly good passages.
  /(?<!\btoda\s)\ba gente\b/i,
  /\bônibus\b/i, /\btrem\b/i, /\bbanheiro\b/i,
  /\bcelular\b/i, /café da manhã/i, /\bsuco\b/i, /\bgeladeira\b/i,
  /\b(estou|está|estão|estás|estamos|estava|estavam) \w+ndo\b/i,
  /\bpra(?![a-zà-ÿ])/i,
];

function validate(p: any): string[] {
  const bad: string[] = [];
  if (!p || typeof p !== "object") return ["not an object"];
  if (!p.title || !p.titleE) bad.push("no title");
  if (!Array.isArray(p.lines) || p.lines.length < 3) bad.push("needs at least 3 lines");
  else p.lines.forEach((l: any, i: number) => {
    if (!l?.pt || !l?.en) bad.push(`line ${i} incomplete`);
  });
  const all = (p.lines ?? []).map((l: any) => l?.pt ?? "").join("\n");
  for (const re of BR) if (re.test(all)) bad.push("Brazilian form: " + re.source);
  if (Array.isArray(p.gaps))
    p.gaps.forEach((g: string) => { if (!all.includes(g)) bad.push(`gap not in text: ${g}`); });
  if (Array.isArray(p.questions))
    p.questions.forEach((q: any, i: number) => {
      if (!q?.q || !Array.isArray(q.options) || q.options.length < 2) bad.push(`question ${i} malformed`);
      else if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= q.options.length)
        bad.push(`question ${i} answer out of range`);
    });
  return bad;
}

const deacc = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const stripArticle = (s: string) => s.replace(/^(o|a|os|as|um|uma)\s+/, "");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
