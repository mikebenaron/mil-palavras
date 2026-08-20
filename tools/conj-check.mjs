/* Spot-check conjugateAll() against hand-written EU-PT paradigms.
 *
 * The conjugation engine derives eleven tenses from three principal parts, so a
 * single wrong rule quietly corrupts thousands of drill cards. This runs the
 * app's own generator against a DOM stub — the same trick tools/audio/drills.mjs
 * uses — and compares the result with paradigms written out by hand.
 *
 *   node tools/conj-check.mjs
 *
 * Add a verb here whenever you touch the engine. If it throws after an
 * index.html refactor, widen the slice or the stub, never reimplement a rule.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
const lines = html.split("\n");
const start = lines.findIndex(l => l.startsWith("function esc(s){"));
const end = lines.findIndex(l => l.trim() === "CARDS = WORDS.concat(DRILLS);");
const src = lines.slice(start, end + 1).join("\n");
const DATA = JSON.parse(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html)[1]);

const el = { classList:{add(){},remove(){},toggle(){},contains:()=>false}, setAttribute(){}, removeAttribute(){},
  getAttribute:()=>null, querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){}, appendChild(){},
  remove(){}, style:{}, children:[], innerHTML:"", isConnected:false };
const stubs = {
  document:{getElementById:()=>el,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},createElement:()=>el,body:el,documentElement:el,hidden:false},
  window:{matchMedia:()=>({matches:false}),addEventListener(){},speechSynthesis:null,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},scrollTo(){},innerWidth:400},
  location:{hostname:"node",search:"",pathname:"/"},
  fetch:()=>Promise.reject(new Error("no network")), caches:undefined };
const saved = new Map();
for (const [k,v] of Object.entries(stubs)) {
  saved.set(k, Object.getOwnPropertyDescriptor(globalThis,k));
  Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});
}
let api;
try {
  api = new Function("DATA",
    "var WORDS=DATA.cards; var CARDS=WORDS; var S=null;\n" + src +
    "\nreturn { conjugateAll:conjugateAll, TENSES:TENSES, CARDS:CARDS, DRILLS:DRILLS };")(DATA);
} finally {
  for (const [k,d] of saved) { if (d) Object.defineProperty(globalThis,k,d); else delete globalThis[k]; }
}
const { conjugateAll } = api;

/* Reference paradigms, written out by hand from EU-PT norms.
   Order: eu, tu, ele, nós, vocês.  Imperative: tu, tu-neg, você, vocês. */
const REF = {
  falar: {
    p:["falo","falas","fala","falamos","falam"],
    t:["falei","falaste","falou","falámos","falaram"],
    im:["falava","falavas","falava","falávamos","falavam"],
    fu:["falarei","falarás","falará","falaremos","falarão"],
    co:["falaria","falarias","falaria","falaríamos","falariam"],
    sp:["fale","fales","fale","falemos","falem"],
    si:["falasse","falasses","falasse","falássemos","falassem"],
    sf:["falar","falares","falar","falarmos","falarem"],
    ip:["falar","falares","falar","falarmos","falarem"],
    mq:["falara","falaras","falara","faláramos","falaram"],
    mp:["fala","não fales","fale","falem"],
    pp:"falado" },
  comer: {
    im:["comia","comias","comia","comíamos","comiam"],
    sp:["coma","comas","coma","comamos","comam"],
    si:["comesse","comesses","comesse","comêssemos","comessem"],
    sf:["comer","comeres","comer","comermos","comerem"],
    mq:["comera","comeras","comera","comêramos","comeram"],
    pp:"comido" },
  partir: {
    im:["partia","partias","partia","partíamos","partiam"],
    si:["partisse","partisses","partisse","partíssemos","partissem"],
    mp:["parte","não partas","parta","partam"],
    pp:"partido" },
  ser: {
    im:["era","eras","era","éramos","eram"],
    fu:["serei","serás","será","seremos","serão"],
    sp:["seja","sejas","seja","sejamos","sejam"],
    si:["fosse","fosses","fosse","fôssemos","fossem"],
    sf:["for","fores","for","formos","forem"],
    mq:["fora","foras","fora","fôramos","foram"],
    mp:["sê","não sejas","seja","sejam"],
    pp:"sido" },
  estar: {
    im:["estava","estavas","estava","estávamos","estavam"],
    sp:["esteja","estejas","esteja","estejamos","estejam"],
    si:["estivesse","estivesses","estivesse","estivéssemos","estivessem"],
    sf:["estiver","estiveres","estiver","estivermos","estiverem"],
    mp:["está","não estejas","esteja","estejam"] },
  ter: {
    im:["tinha","tinhas","tinha","tínhamos","tinham"],
    fu:["terei","terás","terá","teremos","terão"],
    sp:["tenha","tenhas","tenha","tenhamos","tenham"],
    si:["tivesse","tivesses","tivesse","tivéssemos","tivessem"],
    sf:["tiver","tiveres","tiver","tivermos","tiverem"],
    mp:["tem","não tenhas","tenha","tenham"],
    pp:"tido" },
  fazer: {
    fu:["farei","farás","fará","faremos","farão"],
    co:["faria","farias","faria","faríamos","fariam"],
    sp:["faça","faças","faça","façamos","façam"],
    si:["fizesse","fizesses","fizesse","fizéssemos","fizessem"],
    sf:["fizer","fizeres","fizer","fizermos","fizerem"],
    ip:["fazer","fazeres","fazer","fazermos","fazerem"],
    mq:["fizera","fizeras","fizera","fizéramos","fizeram"],
    mp:["faz","não faças","faça","façam"],
    pp:"feito" },
  dizer: {
    fu:["direi","dirás","dirá","diremos","dirão"],
    sp:["diga","digas","diga","digamos","digam"],
    si:["dissesse","dissesses","dissesse","disséssemos","dissessem"],
    sf:["disser","disseres","disser","dissermos","disserem"],
    pp:"dito" },
  trazer: {
    fu:["trarei","trarás","trará","traremos","trarão"],
    sp:["traga","tragas","traga","tragamos","tragam"],
    si:["trouxesse","trouxesses","trouxesse","trouxéssemos","trouxessem"],
    sf:["trouxer","trouxeres","trouxer","trouxermos","trouxerem"] },
  ir: {
    im:["ia","ias","ia","íamos","iam"],
    fu:["irei","irás","irá","iremos","irão"],
    sp:["vá","vás","vá","vamos","vão"],
    si:["fosse","fosses","fosse","fôssemos","fossem"],
    sf:["for","fores","for","formos","forem"],
    mp:["vai","não vás","vá","vão"],
    pp:"ido" },
  ver: {
    sp:["veja","vejas","veja","vejamos","vejam"],
    si:["visse","visses","visse","víssemos","vissem"],
    sf:["vir","vires","vir","virmos","virem"],
    ip:["ver","veres","ver","vermos","verem"],
    mp:["vê","não vejas","veja","vejam"],
    pp:"visto" },
  vir: {
    im:["vinha","vinhas","vinha","vínhamos","vinham"],
    sp:["venha","venhas","venha","venhamos","venham"],
    si:["viesse","viesses","viesse","viéssemos","viessem"],
    sf:["vier","vieres","vier","viermos","vierem"],
    pp:"vindo" },
  dar: {
    im:["dava","davas","dava","dávamos","davam"],
    sp:["dê","dês","dê","demos","deem"],
    si:["desse","desses","desse","déssemos","dessem"],
    sf:["der","deres","der","dermos","derem"],
    mp:["dá","não dês","dê","deem"],
    pp:"dado" },
  poder: {
    si:["pudesse","pudesses","pudesse","pudéssemos","pudessem"],
    sf:["puder","puderes","puder","pudermos","puderem"],
    sp:["possa","possas","possa","possamos","possam"] },
  saber: {
    sp:["saiba","saibas","saiba","saibamos","saibam"],
    si:["soubesse","soubesses","soubesse","soubéssemos","soubessem"],
    sf:["souber","souberes","souber","soubermos","souberem"] },
  querer: {
    sp:["queira","queiras","queira","queiramos","queiram"],
    si:["quisesse","quisesses","quisesse","quiséssemos","quisessem"],
    sf:["quiser","quiseres","quiser","quisermos","quiserem"] },
  "pôr": {
    im:["punha","punhas","punha","púnhamos","punham"],
    fu:["porei","porás","porá","poremos","porão"],
    co:["poria","porias","poria","poríamos","poriam"],
    sp:["ponha","ponhas","ponha","ponhamos","ponham"],
    si:["pusesse","pusesses","pusesse","puséssemos","pusessem"],
    sf:["puser","puseres","puser","pusermos","puserem"],
    ip:["pôr","pores","pôr","pormos","porem"],
    pp:"posto" },
  compor: {
    im:["compunha","compunhas","compunha","compúnhamos","compunham"],
    ip:["compor","compores","compor","compormos","comporem"],
    pp:"composto" },
  manter: {
    im:["mantinha","mantinhas","mantinha","mantínhamos","mantinham"],
    fu:["manterei","manterás","manterá","manteremos","manterão"] },
  sair: {
    si:["saísse","saísses","saísse","saíssemos","saíssem"],
    sf:["sair","saíres","sair","sairmos","saírem"],
    ip:["sair","saíres","sair","sairmos","saírem"],
    sp:["saia","saias","saia","saiamos","saiam"] },
  ler: {
    si:["lesse","lesses","lesse","lêssemos","lessem"],
    sp:["leia","leias","leia","leiamos","leiam"] },
  ficar:  { sp:["fique","fiques","fique","fiquemos","fiquem"] },
  chegar: { sp:["chegue","chegues","chegue","cheguemos","cheguem"] },
  começar:{ sp:["comece","comeces","comece","comecemos","comecem"] },
  dormir: { sp:["durma","durmas","durma","durmamos","durmam"] },
  pedir:  { sp:["peça","peças","peça","peçamos","peçam"] },
  ouvir:  { sp:["ouça","ouças","ouça","ouçamos","ouçam"] },
  /* The hiatus accent belongs to a stem that really ends in a vowel — saído,
     caído, possuído. The u of gu/qu is a silent digraph, not that vowel, so
     these three are plain -ido. They shipped as *seguído for months. */
  seguir: { sp:["siga","sigas","siga","sigamos","sigam"], pp:"seguido" },
  conseguir: { pp:"conseguido" },
  erguer: { pp:"erguido" },
  sair: { pp:"saído" },
  possuir: { pp:"possuído" },
  abrir:  { pp:"aberto" },
  escrever:{ pp:"escrito" },
  descobrir:{ pp:"descoberto" },
  pagar:  { pp:"pago" },
  aceitar:{ pp:"aceite" },
  servir: { im:["servia","servias","servia","servíamos","serviam"],
            sp:["sirva","sirvas","sirva","sirvamos","sirvam"] },
  /* Impersonal: there is no "houveram", so the tenses grown from the eles past
     have a third person and nothing else — but "se houvesse" and "quando
     houver" are among the commonest things anyone says, so they must exist. */
  haver:  { sp:["haja","hajas","haja","hajamos","hajam"],
            si:[null,null,"houvesse",null,null],
            sf:[null,null,"houver",null,null],
            mq:[null,null,"houvera",null,null] },
  /* Defective in person, not in tense: no eu form for the subjunctive to be
     derived from, yet "espero que não aconteça nada" is ordinary Portuguese. */
  acontecer: { sp:[null,null,"aconteça",null,"aconteçam"] },
  /* A boot verb accents the stem only where the stem is stressed. reunimos has
     no accent, and neither does reunamos. */
  reunir: { sp:["reúna","reúnas","reúna","reunamos","reúnam"],
            p:["reúno","reúnes","reúne","reunimos","reúnem"] }
};

/* Tenses that must NOT be generated at all. A verb with no first person has
   nobody to command, and an imperative of acontecer would be nonsense. */
const ABSENT = { acontecer: ["mp"] };

let pass = 0, fail = 0;
const failures = [];
for (const [v, want] of Object.entries(REF)) {
  const got = conjugateAll(v);
  for (const [tid, exp] of Object.entries(want)) {
    const g = got.f[tid];
    const a = JSON.stringify(g), b = JSON.stringify(exp);
    if (a === b) pass++;
    else { fail++; failures.push(`${v} · ${tid}\n     want ${b}\n     got  ${a}`); }
  }
}
for (const [v, tids] of Object.entries(ABSENT)) {
  const got = conjugateAll(v);
  for (const tid of tids) {
    if (got.f[tid] === undefined) pass++;
    else { fail++; failures.push(`${v} · ${tid}\n     want no such tense\n     got  ${JSON.stringify(got.f[tid])}`); }
  }
}
console.log(`checks: ${pass} pass, ${fail} fail`);
if (failures.length) { console.log(""); failures.forEach(f => console.log("  ✗ " + f)); }
process.exitCode = fail ? 1 : 0;
