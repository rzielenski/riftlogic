/* Rift Logic engine: parser, interpreter, calculator and fight simulator.
 * Pure JavaScript, no DOM. Used by the web page and by tools/rl.js.
 *   const RL = createRiftLogic(KB, CALC);  const res = RL.run(sourceText);
 */
function createRiftLogic(KB, CALC){
"use strict";
const ITEMS = CALC.items, ITEMKEYS = Object.keys(ITEMS);
const CLASSES = ["Assassin","Fighter","Mage","Marksman","Support","Tank"];
const SLOTS = ["P","Q","W","E","R"];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g,"");
/* bySource(…, "name") matching (item 26): exact by default — the hit label (case, spaces and punctuation ignored) is the name,
   or the name plus an instance count or a qualifier in brackets: " 3/6" (R storm 3/6), " hit 2/3", " (×2)", " (3 bolts)". So "R" is
   Viktor's R hit only, not "R storm k/6", and "R storm" is all six strikes; "Pix" is "Pix (3 bolts)"; "Plasma" isn't "Plasma rupture".
   prefix: true restores the old prefix match ("R" = every label starting with R). */
const srcBase = w => String(w).replace(/ \([^()]*\)$/,"").replace(/ hit \d+\/\d+$/,"").replace(/ \d+\/\d+$/,"");
const srcHint = (hits, want, n) => { if (n) return ""; const o=[...new Set(hits.map(h=>srcBase(h.what)).filter(w=>norm(w).startsWith(want)))]; return o.length ? ` (labels starting with it: ${o.join(", ")}; name one, or add prefix: true)` : ""; };
const srcMatch = (what, want, prefix) => prefix ? norm(what).startsWith(want) : norm(what)===want || norm(srcBase(what))===want;
const IDX = Object.create(null);   // no prototype: a name like “Constructor” must not find Object.prototype.constructor
const own = (o, k) => o!=null && Object.prototype.hasOwnProperty.call(o, k);
for (const [id,c] of Object.entries(KB.champs)) { IDX[norm(id)] = id; IDX[norm(c.name)] = id; }
IDX["wukong"] = "MonkeyKing";
const TAGS = new Set(); for (const c of Object.values(KB.champs)) for (const s of Object.values(c.slots)) for (const t of Object.keys(s.tags)) TAGS.add(t);
/* Practice Tool target dummy. Game file Characters/PracticeTool_TargetDummy (patch 16.19, data/raw/practicetool_targetdummy_16.19.bin.json):
   baseHP 1000, baseArmor 0, no baseMR (0), no per-level stats, move speed 370, range 175 (melee), AS 0.658, unitTagsString "Champion".
   Wiki "Practice Tool" § Dummy (data/raw/wiki_practice_tool_2026-09-23.txt): same numbers, gameplay radius 65, "stands in as a champion for
   all intents and purposes", can't go below 1 health, restores to full after 3 s without damage, immune to Grievous Wounds; the cheats add
   100 BONUS health or 10 BONUS armor AND magic resist per click. Added to private copies of KB/CALC (not to champions() or name lookup). */
const DUMMY_ID = "PracticeToolTargetDummy", DUMMY_RESET = 3;
KB = {...KB, champs:{...KB.champs, [DUMMY_ID]:{name:"Target Dummy", classes:[], dummy:true, slots:{},
  stats:{range:175, ms:370, melee:1, attack:0, defense:0, magic:0, difficulty:0, hp:1000, armor:0, mr:0, ad:0}}}};
CALC = {...CALC, champs:{...CALC.champs, [DUMMY_ID]:{base:{hp:1000,hpg:0,mp:0,mpg:0,ad:0,adg:0,armor:0,armorg:0,mr:0,mrg:0,as:0.658,asg:0,asr:0.658,ms:370,range:175,critmult:2,adaptive:"physical"}}}};
const dummyKey = c => c.dummy ? `{${c.dummy.hp},${c.dummy.armor},${c.dummy.mr}}` : "";
/* Combo library: data/combos.json (sequences from champion guides, with source links), put into KB.combos by src/kb_export.py.
   KB.combos = {ChampId: [{name, steps, recasts?, use, notes, src}]}; x.combos lists the names, x.combo("name") gives the Combo. */
const COMBO_LIB = KB.combos || {};
/* practice-tool gameplay radius: 65, up to +100% size from bonus health, capped at 10,000 health = 130 (wiki). Linear growth is an assumption. */
const dummyRadius = c => 65*(1 + Math.min(1, Math.max(0, c.dummy.hp-1000)/9000));
const fmt = x => typeof x!=="number" ? String(x) : Number.isNaN(x) ? "n/a" : !Number.isFinite(x) ? (x>0 ? "infinity" : "-infinity") : Math.abs(x) >= 100 ? (Math.round(x*10)/10).toString() : (Math.round(x*100)/100).toString();
const fmtc = x => (Math.round(x*1000)/1000).toString();
/* "did you mean …?" — closest name by case-insensitive match or edit distance ≤ 2 */
function suggest(word, options){
  const w = String(word).toLowerCase();
  const exact = options.find(o => String(o).toLowerCase() === w); if (exact) return exact;
  const dist = (a, b) => { const m = Array.from({length: a.length + 1}, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    return m[a.length][b.length]; };
  let best = null, bd = 3; for (const o of options){ const d = dist(w, String(o).toLowerCase()); if (d < bd){ bd = d; best = o; } }
  return best;
}
const hint = (word, options) => { const s = suggest(word, options); return s ? ` Did you mean “${s}”?` : ""; };
// named arguments a function doesn't know used to be ignored silently (canDodge(…, react: 0.2) ran with no reaction time)
function checkNamed(named, allowed, fn){ for (const k of Object.keys(named||{})) if (!allowed.includes(k)) throw new Error(`${fn} has no option “${k}:”.${hint(k, allowed)} Its options: ${allowed.map(x=>x+":").join(", ")}`); }
class LangError extends Error { constructor(msg, line){ super(msg); this.line=line; } }

function findItem(tok){
  const n = norm(tok);
  if (own(ITEMS, n)) return n;
  let c = ITEMKEYS.filter(k => k.startsWith(n));
  if (c.length > 1) { const done = c.filter(k => ITEMS[k].complete); if (done.length === 1) c = done; }
  if (c.length === 1) return c[0];
  if (c.length > 1) throw new Error(`“${tok}” matches several items: ${c.slice(0,6).map(k=>ITEMS[k].name).join(", ")}${c.length>6?"…":""}. Type more of the name.`);
  const s = ITEMKEYS.filter(k => k.includes(n));
  if (s.length === 1) return s[0];
  if (s.length > 1) throw new Error(`“${tok}” matches several items: ${s.slice(0,6).map(k=>ITEMS[k].name).join(", ")}. Type more of the name.`);
  return null;
}


/* ================= lexer ================= */
const KEYWORDS = new Set(["if","else","for","while","return","break","continue","true","false","rule","prove","forall"]);
const TYPES = new Set(["auto","int","double","float","bool","string","void","Champion","Item","ItemSet","TeamComp","Ability","List","Rune","Fight","Fights","Combo","ComboResult","Dummy","Summoner"]);
function lex(text){
  const toks=[]; let i=0, line=1;
  const push=(type,value,start)=>toks.push({type,value,line,start,end:i});
  while (i<text.length){
    const c=text[i];
    if (c==="\n"){ line++; i++; continue; }
    if (/\s/.test(c)){ i++; continue; }
    if (c==="/" && text[i+1]==="/"){ while(i<text.length && text[i]!=="\n") i++; continue; }
    if (c==="/" && text[i+1]==="*"){ i+=2; while(i<text.length && !(text[i]==="*"&&text[i+1]==="/")){ if(text[i]==="\n") line++; i++; } i+=2; continue; }
    const start=i;
    if (/[0-9]/.test(c) || (c==="." && /[0-9]/.test(text[i+1]))){
      const m=/^(\d*\.?\d+(?:[eE][-+]?\d+)?)(%?)/.exec(text.slice(i)); i+=m[0].length;
      push("num", m[2] ? parseFloat(m[1])/100 : parseFloat(m[1]), start); continue;
    }
    if (/[A-Za-z_]/.test(c)){
      const m=/^[A-Za-z_]\w*/.exec(text.slice(i)); i+=m[0].length;
      push(KEYWORDS.has(m[0])?"kw":"id", m[0], start); continue;
    }
    if (c==='"'){
      let j=i+1, s=""; while(j<text.length && text[j]!=='"'){ if(text[j]==="\\"&&j+1<text.length){ s+=text[j+1]; j+=2; } else s+=text[j++]; }
      if (j>=text.length) throw new LangError("a string is missing its closing quote", line);
      i=j+1; push("str", s, start); continue;
    }
    const two=text.slice(i,i+2);
    if (["==","!=","<=",">=","&&","||","+=","-=","*=","/=","++","--","->","::"].includes(two)){ i+=2; push("op",two,start); continue; }
    if ("+-*/%<>=!.,;:(){}[]&".includes(c)){ i++; push("op",c,start); continue; }
    throw new LangError(`unexpected character “${c}”`, line);
  }
  toks.push({type:"eof", value:"", line, start:text.length, end:text.length});
  return toks;
}

/* ================= parser ================= */
function parse(text){
  const T = lex(text); let p=0;
  const peek=(k=0)=>T[p+k], next=()=>T[p++];
  const is=(v,k=0)=>{ const t=T[p+k]; return t && (t.type==="op"||t.type==="kw") && t.value===v; };
  const expect=(v)=>{ const t=next(); if(!((t.type==="op"||t.type==="kw")&&t.value===v)) throw new LangError(`expected “${v}” but found “${t.value||"end of program"}”`, t.line); return t; };
  const ident=()=>{ const t=next(); if(t.type!=="id") throw new LangError(`expected a name but found “${t.value||"end of program"}”`, t.line); return t.value; };
  const srcOf=(a,b)=>text.slice(T[a].start, T[b-1].end).replace(/\s+/g," ").trim();
  const isTypeAt=(k)=>{ const t=T[p+k]; return t && t.type==="id" && TYPES.has(t.value); };
  function declAhead(){ // Type [&] name
    if (!isTypeAt(0)) return false;
    let k=1; if (is("&",k)) k++;
    return T[p+k] && T[p+k].type==="id";
  }
  function program(){
    const body=[];
    while (peek().type!=="eof") body.push(topLevel());
    return body;
  }
  function topLevel(){
    if (is("rule")) return ruleDecl();
    if (declAhead()){
      // function definition: Type name ( ... ) {
      const save=p; next(); if(is("&")) next(); const nameTok=peek(); next();
      if (is("(")){
        let depth=0, k=p; do { const t=T[k]; if(t.value==="(") depth++; if(t.value===")") depth--; k++; } while(depth>0 && T[k].type!=="eof");
        if (T[k] && T[k].value==="{"){ p=save; return funcDecl(); }
      }
      p=save;
    }
    return statement();
  }
  function params(){
    expect("("); const ps=[];
    while (!is(")")){
      if (!isTypeAt(0)) throw new LangError(`a parameter needs a type, like “Champion x”`, peek().line);
      const type=next().value; let ref=false; if(is("&")){ next(); ref=true; }
      ps.push({type, name:ident(), ref});
      if (!is(")")) expect(",");
    }
    expect(")"); return ps;
  }
  function funcDecl(){
    const line=peek().line; const type=next().value; if(is("&")) next(); const name=ident();
    return {k:"func", name, type, params:params(), body:block(), line};
  }
  function ruleDecl(){
    const line=next().line; const name=ident(); const ps=params();
    expect("->"); let neg=false; if (is("!")){ next(); neg=true; }
    const pred=ident(); expect("("); const args=[];
    while(!is(")")){ args.push(ident()); if(!is(")")) expect(","); }
    expect(")");
    let strength=1; if (is("[")){ next(); const t=next(); if(t.type!=="num") throw new LangError("rule strength must be a number, like [2]", t.line); strength=t.value; expect("]"); }
    for (const a of args) if (!ps.some(q=>q.name===a)) throw new LangError(`rule ${name}: “${a}” is not one of its parameters`, line);
    return {k:"rule", name, params:ps, neg, pred, args, strength, body:block(), line};
  }
  function block(){ expect("{"); const body=[]; while(!is("}")){ if(peek().type==="eof") throw new LangError("a “{” is never closed", peek().line); body.push(statement()); } expect("}"); return {k:"block", body}; }
  function varDecl(requireSemi=true){
    const line=peek().line; const type=next().value; let ref=false; if(is("&")){ next(); ref=true; }
    const decls=[];
    do {
      const name=ident(); let init=null;
      if (is("=")){ next(); init=expr(); }
      else if (is("{")) init=initList();
      else if (is("(")){ const a=p; next(); const args=[]; while(!is(")")){ args.push(expr()); if(!is(")")) expect(","); } expect(")"); init={k:"ctor", type, args, line, src:srcOf(a,p)}; }
      decls.push({name, init});
    } while (is(",") && next());
    if (requireSemi) expect(";");
    return {k:"var", type, ref, decls, line};
  }
  function statement(){
    const t=peek(), line=t.line;
    if (is("{")) return block();
    if (is(";")){ next(); return {k:"empty"}; }
    if (is("if")){ next(); expect("("); const c=expr(); expect(")"); const a=statement(); let b=null; if(is("else")){ next(); b=statement(); } return {k:"if", c, a, b, line}; }
    if (is("while")){ next(); expect("("); const c=expr(); expect(")"); return {k:"while", c, body:statement(), line}; }
    if (is("for")){
      next(); expect("(");
      if (declAhead()){
        const save=p; const type=next().value; let ref=false; if(is("&")){ next(); ref=true; } const name=ident();
        if (is(":")){ next(); const it=expr(); expect(")"); return {k:"forin", type, ref, name, it, body:statement(), line}; }
        p=save;
      }
      let init=null; if(!is(";")) init = declAhead() ? varDecl(false) : {k:"expr", e:expr(), line}; expect(";");
      const c = is(";") ? null : expr(); expect(";");
      const step = is(")") ? null : expr(); expect(")");
      return {k:"for", init, c, step, body:statement(), line};
    }
    if (is("return")){ next(); const e = is(";") ? null : expr(); expect(";"); return {k:"return", e, line}; }
    if (is("break")){ next(); expect(";"); return {k:"break", line}; }
    if (is("continue")){ next(); expect(";"); return {k:"continue", line}; }
    if (is("prove")){
      next(); const a=p;
      if (is("forall")){ next(); expect("("); if(!isTypeAt(0)) throw new LangError("forall needs a typed variable: forall (Champion c : list)", line);
        const type=next().value; const name=ident(); expect(":"); const it=expr(); expect(")"); const b=p; const claim=expr(); expect(";");
        return {k:"proveall", type, name, it, claim, line, src:srcOf(a,p-1), claimSrc:srcOf(b,p-1)}; }
      const claim=expr(); expect(";"); return {k:"prove", claim, line, src:srcOf(a,p-1)};
    }
    if (declAhead()) return varDecl();
    const a=p; const e=expr(); expect(";"); return {k:"expr", e, line, src:srcOf(a,p-1)};
  }
  function initList(){
    const line=peek().line; expect("{"); const items=[];
    while(!is("}")){ items.push(expr()); if(!is("}")) expect(","); }
    expect("}"); return {k:"list", items, line};
  }
  // precedence climbing
  const BIN = [["||"],["&&"],["==","!="],["<","<=",">",">="],["+","-"],["*","/","%"]];
  function expr(){ return assign(); }
  function assign(){
    const a=p; const left=binary(0);
    if (peek().type==="op" && ["=","+=","-=","*=","/="].includes(peek().value)){
      const op=next().value, line=T[p-1].line; const right=assign();
      if (!["id","member","index"].includes(left.k)) throw new LangError("you can only assign to a variable or a field", line);
      return {k:"assign", op, target:left, value:right, line, src:srcOf(a,p)};
    }
    return left;
  }
  function binary(level){
    if (level>=BIN.length) return unary();
    const a=p; let left=binary(level+1);
    while (peek().type==="op" && BIN[level].includes(peek().value)){
      const op=next().value, line=T[p-1].line; const right=binary(level+1);
      left={k:"bin", op, a:left, b:right, line, src:srcOf(a,p)};
    }
    return left;
  }
  function unary(){
    const a=p;
    if (is("!")||is("-")){ const op=next().value; const e=unary(); return {k:"un", op, e, line:T[a].line, src:srcOf(a,p)}; }
    if (is("++")||is("--")){ const op=next().value; const e=unary(); return {k:"incr", op, e, pre:true, line:T[a].line}; }
    return postfix();
  }
  function postfix(){
    const a=p; let e=primary();
    for(;;){
      if (is(".")){ next(); const name=ident(); e={k:"member", obj:e, name, line:T[p-1].line, src:srcOf(a,p)}; continue; }
      if (is("(")){
        next(); const args=[], named={};
        while(!is(")")){
          if (peek().type==="id" && is(":",1)){ const n=next().value; next(); named[n]=expr(); }
          else args.push(expr());
          if (!is(")")) expect(",");
        }
        expect(")");
        if (e.k==="member") e.called=true;
        e={k:"call", fn:e, args, named, line:T[a].line, src:srcOf(a,p)}; continue;
      }
      if (is("[")){ next(); const i=expr(); expect("]"); e={k:"index", obj:e, i, line:T[a].line, src:srcOf(a,p)}; continue; }
      if (is("++")||is("--")){ const op=next().value; e={k:"incr", op, e, pre:false, line:T[a].line}; continue; }
      return e;
    }
  }
  function primary(){
    const t=next(), a=p-1;
    if (t.type==="num") return {k:"num", v:t.value, src:srcOf(a,p)};
    if (t.type==="str") return {k:"str", v:t.value, src:srcOf(a,p)};
    if (t.type==="kw" && (t.value==="true"||t.value==="false")) return {k:"bool", v:t.value==="true", src:t.value};
    if (t.type==="op" && t.value==="("){ const e=expr(); expect(")"); return e; }
    if (t.type==="op" && t.value==="{"){ p--; return initList(); }
    if (t.type==="id"){
      if (TYPES.has(t.value) && is("{")){ const l=initList(); return {k:"typed", type:t.value, list:l, line:t.line, src:srcOf(a,p)}; }
      if (TYPES.has(t.value) && is("(")) return {k:"id", name:t.value, line:t.line, src:t.value};
      return {k:"id", name:t.value, line:t.line, src:t.value};
    }
    throw new LangError(`unexpected “${t.value||"end of program"}”`, t.line);
  }
  return program();
}

/* ================= world: data + asserted facts ================= */
function World(){
  const over={}, asserted=[];
  const get=id=>over[id] ||= structuredClone(KB.champs[id]);
  return {
    champ: id => over[id] || KB.champs[id],
    addTag(id, slot, tag, line, text){ const c=get(id); const f={line, text}; c.slots[slot].tags[tag]={asserted:f}; if(tag==="dash"||tag==="blink") c.slots[slot].tags.mobile={asserted:f}; asserted.push(f); },
    removeTag(id, slot, tag, line, text){ const c=get(id); delete c.slots[slot].tags[tag]; if(tag==="dash"||tag==="blink") delete c.slots[slot].tags.mobile; asserted.push({line, text}); },
    setCd(id, slot, v, line, text){ const c=get(id); const f={line,text}; (c.cdOver ||= {})[slot]={v,f}; asserted.push(f); },
    setType(id, slot, type, line, text){ const c=get(id); (c.typeOver ||= {})[slot]={v:type, f:{line,text}}; asserted.push({line,text}); },
    setPhys(id, slot, vals, line, text){ const c=get(id); const f={line,text}; (c.physOver ||= {})[slot]={v:{...((c.physOver||{})[slot]||{}).v, ...vals}, f}; asserted.push(f); },
    addClass(id, cls, add, line, text){ const c=get(id); c.classes = add ? [...new Set([...c.classes, cls])] : c.classes.filter(x=>x!==cls); (c.clsOver ||= {})[cls]={line,text}; asserted.push({line,text}); },
  };
}

/* ================= calculator ================= */
const growth = (base, g, L) => base + g*(L-1)*(0.7025+0.0175*(L-1));
const STATLABEL = {0:"AP",1:"armor",2:"AD",4:"attack speed",6:"MR",7:"move speed",8:"crit chance",9:"crit damage",10:"ability haste",12:"health",14:"current health",29:"lethality",31:"attack range"};
const STATKEYS = ["ap","ad","bonusad","basead","hp","bonushp","basehp","armor","bonusarmor","basearmor","mr","bonusmr","basemr","mana","haste","ms","bonusms","as","bonusas","crit","critdmg","lethality","armorpen","armorpenpct","magicpen","magicpenpct","range","lifesteal","omnivamp","tenacity","slowresist","gold","ehpphysical","ehpmagic","aa","dps","level","healpower","healIn","shieldIn"];
const statMemo = new Map();
function champKey(c){ const stk=c.opts&&c.opts.stacks; return `${c.champ}${dummyKey(c)}@${c.level}[${c.items.join(",")}](${(c.runes||[]).join(",")}){${Object.entries(c.ranks).map(([k,v])=>k+v).join("")}}${stk&&Object.keys(stk).length?JSON.stringify(stk):""}`; }
function champName(c){ return KB.champs[c.champ].name; }
function label(c){ return c.label || champName(c); }
/* ================= runes ================= */
const lerpL = (a, b, L) => a + (b - a) * (Math.min(18, Math.max(1, L)) - 1) / 17;
const RUNE_KEYS = Object.keys(CALC.runes);
function findRune(tok, prefix){
  const n = norm(tok);
  if (own(CALC.runes, n)) return n;
  if (!prefix) return null;
  const c = RUNE_KEYS.filter(k => k.startsWith(n));
  if (c.length === 1) return c[0];
  if (c.length > 1) throw new Error(`“${tok}” matches several runes: ${c.map(k=>CALC.runes[k].name).join(", ")}`);
  return null;
}
const runeName = k => CALC.runes[k] ? CALC.runes[k].name : k;
// runes that change stats (applied in stats()) and runes that act in fights (applied in fight())
const STAT_RUNES = new Set(["adaptiveforce","attackspeed","abilityhaste","movespeed","healthscaling","health","armor","magicresist","resistscaling","tenacityandslowresist",
  "eyeballcollection","zombieward","ghostporo","absolutefocus","gatheringstorm","chrysalis","transcendence","ultimatehunter","legendalacrity","legendhaste","legendbloodline",
  "conditioning","overgrowth","celestialbody","revitalize","ironskin","mirrorshell","jackofalltrades","axiomarcanist","celerity","magicalfootwear","biscuitdelivery",
  "manaflowband","cosmicinsight"]);
const FIGHT_RUNES = new Set(["electrocute","darkharvest","conqueror","lethaltempo","presstheattack","fleetfootwork","graspoftheundying","aftershock","summonaery","arcanecomet",
  "firststrike","hailofblades","guardian","deathfiretouch","cheapshot","tasteofblood","suddenimpact","scorch","secondwind","boneplating","triumph","laststand","coupdegrace",
  "cutdown","celestialbody","revitalize","axiomarcanist","stormraiderssurge","nimbuscloak","glacialaugment","fontoflife","shieldbash","unflinching",
  "absorblife","absolutefocus","approachvelocity"]);
/* current-patch runes with no effect on fight numbers (gold, wards, vision, mana, out-of-combat or river-only effects, item
   and summoner swaps); stats() notes them as "no combat effect" instead of "not modelled". Audit: outputs/runes_audit/RUNES.md */
const NA_RUNES = {waterwalking:"river only (fights happen off the river)", demolish:"turrets only", sixthsense:"wards only", grislymementos:"trinket haste only",
  deepward:"wards only", treasurehunter:"gold only", relentlesshunter:"out-of-combat move speed only", presenceofmind:"mana (not simulated)",
  cashback:"gold only", tripletonic:"grants single-use elixirs (Avarice: gold; Force: 25 adaptive for 60 s once drunk, not applied)", timewarptonic:"potions (add HealthPotion as an item; the extra 40% is not modelled)",
  unsealedspellbook:"summoner swaps out of combat (set .summoners)", hextechflashtraption:"Hexflash's 1–2 s channel blink is not modelled"};
/* rune stacks from outside the fight: set with .stacks(Rune, n); default 0 = a fresh game, as in the practice tool */
const RUNE_STACKS = {legendalacrity:[10,"Legend stacks"], legendhaste:[10,"Legend stacks"], legendbloodline:[15,"Legend stacks"],
  ultimatehunter:[5,"Bounty Hunter stacks"], overgrowth:[Infinity,"Overgrowth stacks (one per 8 minions or monsters)"], darkharvest:[Infinity,"souls"],
  manaflowband:[250,"bonus mana from Manaflow Band"]};
const GAME = {minute: 20};

/* ================= item passives ================= */
/* Every Summoner's Rift item whose passive or active changes a fight number, with a short note of what
   the simulator does with it. Values come from the item's game data (dv / calcs) wherever the data has
   them; the few numbers the data lacks are taken from the item text and marked “item text”. The docs page's
   “Modelled item passives” list is generated from this object. */
const MODELLED_ITEMS = {
  // ---- stat passives (stats())
  rabadonsdeathcap:"Magical Opus: +30% AP",
  archangelsstaff:"Awe: AP = 1% bonus mana; Manaflow mana from .stacks()",
  riftmaker:"Void Infusion AP from bonus health; Void Corruption +2%/s damage up to 8%, then 10%/6% omnivamp",
  spiritvisage:"+25% healing and shielding received (and Doran's Shield regen)",
  steraksgage:"Claws that Catch: +50% base AD; Lifeline: shield of 60% bonus health decaying over 4.5s when damage would drop you below 30%",
  overlordsbloodmail:"Tyranny: 2.5% bonus health as AD; Retribution: up to 12% of AD from missing health (full at 70% missing), live in fights",
  warmogsarmor:"Vitality: +12% item health; Heart: 1.5% max health every 0.5s after 8s without damage (needs 2000 bonus health)",
  manamune:"Awe: AD = 2% max mana; Manaflow mana from .stacks()",
  wintersapproach:"Awe: health = 15% bonus mana; Manaflow mana from .stacks()",
  whisperingcirclet:"Harmony: heal/shield power = 0.5% bonus mana; Manaflow mana from .stacks()",
  tearofthegoddess:"Manaflow mana from .stacks() (mana itself is not simulated)",
  dawncore:"First Light: 2% heal/shield power and 10 AP per 100% base mana regen",
  endlesshunger:"Famine: 5 + 13% bonus AD haste (10% ranged, item text); Feast: 15% omnivamp for 8s after a takedown",
  mejaissoulstealer:"Glory: 5 AP per stack (.stacks(), default 0), +10% move speed at 10+; +4 kill / +2 assist in fights",
  darkseal:"Glory: 4 AP per stack (.stacks(), default 0); +2 kill / +1 assist in fights",
  rodofages:"Timeless stacks (.stacks(), default 0): 10 health, 30 mana, 3 AP each, +1 level at 10; Eternity: heals 25% of each cast's mana cost (max 20)",
  yuntalwildarrows:"Practice Makes Lethal: crit stacks (.stacks(), default 0) grow 0.4%/0.2% per attack up to 25%; Flurry: 30% attack speed for 6s (30s cooldown, −1s per attack, −2s per crit)",
  gluttonousgreaves:"Slay: 0.6% omnivamp per takedown stack (.stacks(), grows in fights)",
  immortalpath:"Slay stacks as Gluttonous Greaves; +4% damage above 50% health, +12% healing and shielding received below 50%",
  swiftmarch:"Noxian Fervor: 5% of move speed as adaptive force",
  spearofshojin:"Dragonforce: +25 basic ability haste; Focused Will: ability damage stacks +3% (1.5% ranged) ability and passive damage, 4 stacks, 6s",
  experimentalhexplate:"+30 ultimate haste; Overdrive: +50%/35% attack speed for 8s after casting R (30s cooldown)",
  fiendhunterbolts:"+30 ultimate haste; Opening Barrage: after R, next 3 attacks +50% attack speed and crit for 80% (a would-be crit deals full crit + 15% true)",
  malignance:"+20 ultimate haste; Hatefog: R damage leaves a 3s zone: 60 + 5% AP magic per second and −10 MR",
  zekesconvergence:"+15 ultimate haste; Frostfire Tempest: after R, 30 magic damage per second to enemies for 5s (45s cooldown)",
  imperialmandate:"+20 ability haste on immobilizing abilities; immobilized champions take 7% more damage for 4s",
  jakshotheprotean:"Voidborn Resilience: +30% bonus armor and MR after 5s of champion combat",
  forceofnature:"Steadfast: stacks from champion magic damage (1/s) and immobilizes (+2), 7s; at 8 stacks +70 MR",
  elixirofiron:"Consumed before the fight: +300 health, +25% tenacity (item text)",
  elixirofsorcery:"Consumed before the fight: +50 AP; damaging a champion deals 25 true damage (5s per champion) (item text)",
  elixirofwrath:"Consumed before the fight: +30 AD; 12% physical vamp against champions (item text)",
  // ---- attacks and on-hit
  sheen:"Spellblade: 100% base AD physical on the next attack (10s window, 1.5s cooldown after the empowered attack)",
  trinityforce:"Spellblade: 200% base AD physical",
  lichbane:"Spellblade: 75% base AD + 45% AP magic, empowered attack +50% attack speed",
  iceborngauntlet:"Spellblade: 150% base AD physical",
  bloodsong:"Spellblade: 100% base AD physical; champions hit take 8% (5% ranged) more damage for 4s",
  duskanddawn:"Spellblade: 75% base AD + 10% AP magic, heals 10% AP + 3% bonus health, applies on-hit again after 0.2s",
  essencereaver:"Spellblade: 125% base AD + crit-scaled physical (mana refund not simulated)",
  krakenslayer:"Bring It Down: every 3rd attack (stacks last 4s) deals 150–200 physical (80% ranged), up to +75% by target missing health",
  bladeoftheruinedking:"Mist's Edge: 9% (6% ranged) of the target's current health physical on-hit",
  nashorstooth:"15 + 15% AP magic on-hit",
  witsend:"45 magic on-hit",
  recurvebow:"15 physical on-hit",
  terminus:"30 + 10% bonus AD + 10% AP magic on-hit; Juxtaposition: Light hits +armor/MR, Dark hits +10% armor and magic pen, 3 stacks each, 5s",
  guinsoosrageblade:"30 magic on-hit; +8% attack speed per attack (4 stacks, 4s); fully stacked, every 3rd attack applies on-hit twice",
  titanichydra:"Cleave: 1% max health (0.5% ranged) physical on-hit, 3% to other enemies; active empowers the next attack (4% / 9%)",
  ravenoushydra:"Cleave 40% AD (20% ranged) to other enemies; active 80% AD physical to all enemies; life steal applies",
  tiamat:"Cleave 40% AD (20% ranged) to other enemies; active 75% AD physical to all enemies",
  profanehydra:"Cleave 40% AD (20% ranged) to other enemies; active 80% AD physical to all enemies",
  stridebreaker:"Cleave 40% AD (20% ranged) to other enemies; active 80% AD physical to all enemies",
  heartsteel:"Colossal Consumption: after 3s near a champion, the next attack deals 70 + 6% max health physical and grants 10% of it as max health (30s per target); earlier gains via .stacks()",
  hullbreaker:"Skipper: every 5th attack deals 120% base AD + 5% max health physical (×0.7 ranged)",
  sunderedsky:"Lightshield Strike: first attack on a champion crits for 80% of crit damage and heals 90% base AD (45% ranged) + 4% missing health (10s per target); overheal becomes bonus health for 8s",
  navoriflickerblade:"Transcendence: each attack cuts remaining basic ability cooldowns by 15%",
  runaanshurricane:"Wind's Fury: each attack fires bolts at up to 2 other enemies for 65% AD physical with on-hit damage",
  statikkshiv:"Energized (15 stacks per attack): 60 magic chain lightning to the target and up to 3–6 more enemies (on-hit to them)",
  rapidfirecannon:"Energized: 40 magic on-hit (range bonus irrelevant: everyone is in range)",
  stormrazor:"Energized: 100 magic on-hit",
  voltaiccyclosword:"Energized (also triggered by ability damage): 9% (7% ranged) current health physical and +15/12 lethality for 4s",
  deadmansplate:"Shipwrecker: first attack of the fight discharges full Momentum: 40 + 100% base AD physical",
  hexopticsc44:"Magnification: up to +10% attack damage from distance (assumed at the attacker's attack range)",
  ardentcenser:"Sanctify: healing or shielding an ally gives both +25% attack speed and 20 magic on-hit for 6s",
  thornmail:"Thorns: 20 + 10% bonus armor magic to attackers and 40% Grievous Wounds",
  bramblevest:"Thorns: 10 magic to attackers and 40% Grievous Wounds",
  randuinsomen:"Resilience: critical strikes deal 30% less damage to you",
  platedsteelcaps:"Plating: −10% basic attack damage taken",
  armoredadvance:"Plating: −10% basic attack damage taken; Noxian Endurance: physical shield (8% bonus health) after champion physical damage (15s cooldown)",
  chainlacedcrushers:"Noxian Persistence: magic shield (8% bonus health) after champion magic damage (15s cooldown)",
  wardensmail:"Rock Solid: each basic attack's damage taken −15 (at most 20%)",
  frozenheart:"Winter's Caress: enemy champions' attack speed −20%",
  cull:"Reap: 3 health on-hit",
  // ---- ability and damage passives
  ludensecho:"Echo: ability damage fires 6 echoes: 75 + 5% AP to the target and one per extra enemy, +20% per unused echo on the target (12s cooldown)",
  liandrystorment:"Torment: ability damage burns 1% max health every 0.5s for 3s; Suffering: +2%/s damage up to 6%",
  hauntingguise:"Madness: +2%/s damage in champion combat, up to 6%",
  blackfiretorch:"Baleful Blaze: ability damage burns 20 + 2% AP magic per second for 3s; +4% AP per burning champion",
  fatedashes:"Inflame: ability damage burns 5 magic per second for 3s",
  shadowflame:"Cinderbloom: magic and true damage to targets below 40% health deal 20% more",
  lorddominiksregards:"Giant Slayer: up to 15% more damage from the target's bonus health (max at 1500)",
  stormsurge:"Stormraider: 25% of a champion's max health within 2.5s applies Squall: 125 + 10% AP magic 2s later (30s cooldown); hits all enemies if the target dies first",
  cryptbloom:"Life From Death: takedowns within 3s of your damage heal you and allies 100 + 20% AP",
  horizonfocus:"Hypershot: ability damage from an ability with 600+ range marks the target 6s (+10% damage), other enemies 3s",
  bloodletterscurse:"Vile Decay: champion ability magic damage −7.5% MR per stack (4 stacks, 6s)",
  blackcleaver:"Carve: physical damage −6% armor per stack (5 stacks, 6s)",
  seryldasgrudge:"armor pen stat; Bitter Cold slow (movement not simulated)",
  rylaiscrystalscepter:"Rimefrost slow: counts as slowing for Bandlepipes and Solstice Sleigh (movement not simulated)",
  abyssalmask:"Unmake: enemy champions take 12% more magic damage",
  morellonomicon:"40% Grievous Wounds on magic damage",
  oblivionorb:"40% Grievous Wounds on magic damage",
  chempunkchainsword:"40% Grievous Wounds on physical damage",
  executionerscalling:"40% Grievous Wounds on physical damage",
  mortalreminder:"40% Grievous Wounds on physical damage",
  thecollector:"Death: executes champions left below 5% health",
  bansheesveil:"Annul: the first enemy ability cast on you is blocked; ready again 40s after the last champion damage",
  edgeofnight:"Annul: the first enemy ability cast on you is blocked; ready again 40s after the last champion damage",
  verdantbarrier:"Annul: the first enemy ability cast on you is blocked; ready again 60s after the last champion damage",
  axiomarc:"Flux: takedowns within 3s refund 10% + 0.25% per lethality of R's cooldown",
  hubris:"Eminence: takedowns within 3s give 12 + 3 per stack AD for 90s",
  bastionbreaker:"Shaped Charge: next ability damage to a champion deals 50 + 1.5 per lethality true (half ranged, 20s cooldown)",
  eclipse:"Ever Rising Moon: 2 hits within 2s: 8% (5% ranged) max health physical and a 150 + 40% bonus AD shield (half ranged) for 2s (6s cooldown)",
  hextechalternator:"Revved: damaging a champion deals 65 magic (40s cooldown)",
  scoutsslingshot:"Bullseye: damaging a champion deals 40 magic (40s cooldown, −1s per attack)",
  zazzaksrealmspike:"Void Explosion: ability damage to a champion explodes 0.5s later: 10 + 15% AP + 3% max health magic (10s cooldown)",
  hollowradiance:"Immolate: 15 + 1% bonus health magic per second to enemies for 3s after dealing or taking damage; takedowns erupt for 4× that",
  sunfireaegis:"Immolate: 20 + 1.5% bonus health magic per second to enemies for 3s after dealing or taking damage",
  bamiscinder:"Immolate: 15 magic per second to enemies for 3s after dealing or taking damage",
  unendingdespair:"Anguish: every 4s in champion combat, 3% bonus health magic to all enemies and heal 250% of the damage dealt",
  // ---- defensive
  kaenicrookern:"Magebane: magic shield of 15% max health (assumed up at the start; again after 15s without magic damage)",
  immortalshieldbow:"Lifeline: 400–700 shield (80% ranged) for 3s when damage would drop you below 30% (90s)",
  mawofmalmortius:"Lifeline: 200 + 150% bonus AD magic shield (75% ranged) for 3s below 30%, then 10% omnivamp for the fight",
  hexdrinker:"Lifeline: 110–280 magic shield (75% ranged) for 2.5s below 30%",
  protoplasmharness:"Lifeline: below 30%, gain bonus health for 5s and heal over 5s",
  deathsdance:"Ignore Pain: 30% (10% ranged) of physical and magic damage taken is delayed as true damage over 3s; Defy: takedowns cleanse it and heal 75% bonus AD over 2s",
  guardianangel:"Rebirth: 4s stasis then 50% base health on lethal damage",
  zhonyashourglass:"Time Stop: 2.5s stasis (used by fighters below 30% health; add Zhonyas to a combo to press it)",
  seekersarmguard:"Time Stop: 2.5s stasis, once",
  celestialopposition:"Blessing of the Mountain: −35% (25% ranged) champion damage for 2s after being hit, then 18s cooldown",
  knightsvow:"Sacrifice: takes 14% of the Worthy ally's damage (above 30% health) and heals 12% of the ally's champion damage",
  serpentsfang:"Shield Reaver: shields the target gains are 50% (35% ranged) weaker for 3s; existing shields cut on first hit",
  bloodthirster:"Ichorshield: life steal healing beyond max health becomes a shield (165, +15/level from 9)",
  // ---- support
  redemption:"Intervention: heals allies 150–350 and deals 10% max health true damage to enemies after 2.5s",
  locketoftheironsolari:"Devotion: 290–360 shield to allies decaying over 2.5s",
  mikaelsblessing:"Purify: heals an ally 100–250 (cleanse not simulated)",
  moonstonerenewer:"Starlit Grace: heals on allies chain 30%, shields 35% to another ally",
  echoesofhelia:"Soul Siphon: 30% of damage dealt stored (cap by level); healing or shielding an ally releases it as healing",
  staffofflowingwater:"Rapids: healing or shielding an ally gives both 40 AP and 15 ability haste for 6s",
  dreammaker:"Dream Bubbles: healing or shielding an ally gives it −X damage on the next hit taken and +X magic damage on its next hit (every 8s)",
  solsticesleigh:"Going Sledding: slowing or immobilizing a champion gives you and the most wounded ally bonus health for 2.5s (30s)",
  bandlepipes:"Fanfare: slowing or immobilizing a champion gives you and allies +30% attack speed (20% ranged holder) for 8s (4s ranged)",
  actualizer:"Mana Made Real (active): 8s of +15% (+0.5% per 100 bonus mana) ability damage, healing and shielding, basic cooldowns 30% faster",
  // ---- damaging actives
  hextechgunblade:"Lightning Bolt (active): 175–253 + 30% AP magic to the target (60s)",
  hextechrocketbelt:"Supersonic (active): 100 + 10% AP magic (50s), counts as a dash",
  // ---- starters and consumables
  doransshield:"Enduring Focus: after champion damage, regenerate 0.066 (0.05 ranged or area) health per 1% missing health per second for 8s",
  doransring:"Drain: champions without mana heal 45% of the mana restore: 0.45 health per second, 0.9 for 5s after damaging a champion",
  healthpotion:"Consume: 120 health over 15s (drunk by fighters below 50%, one potion)",
  catalystofaeons:"Eternity: heals 25% of each cast's mana cost (max 20)",
  refillablepotion:"2 charges of 100 health over 12s (drunk by fighters below 50%)",
};
/* Items with nothing a fight can see (gold, vision, minions-only, mana, pure movement, cleanses); the
   simulator names each of these in the assumptions when a build contains it. */
const ITEM_GAPS = {
  shurelyasbattlesong:"Shurelya's Battlesong: active move speed has no effect (item slows are not modelled)",
  youmuusghostblade:"Youmuu's Ghostblade: move speed and ghosting have no effect (not modelled)",
  mercurialscimitar:"Mercurial Scimitar: Quicksilver cleanses every crowd control except airborne as soon as it lands (perfect play; wiki CC table); the +50% move speed has no effect",
  quicksilversash:"Quicksilver Sash: Quicksilver cleanses every crowd control except airborne as soon as it lands (perfect play; wiki CC table)",
  phantomdancer:"Phantom Dancer: ghosting has no effect (item slows are not modelled)",
  umbralglaive:"Umbral Glaive: Nightstalker needs being unseen (no vision in the simulator), never triggers",
  cosmicdrive:"Cosmic Drive: move speed has no effect (item slows are not modelled)",
  crimsonlucidity:"Crimson Lucidity: its on-summoner-cast move speed has no effect; its summoner haste only shortens summoner cooldowns (x.Flash.cooldown)",
  bootsofswiftness:"Boots of Swiftness: slow resist has no effect (item slows are not modelled)",
  phage:"Phage: move speed has no effect (item slows are not modelled)",
  lostchapter:"Lost Chapter: mana is not simulated",
  worldatlas:"World Atlas: gold only",
  cull:"Cull: gold part only affects minions",
  scorchclawpup:"Scorchclaw Pup: companion assumed not evolved (freshly bought), no champion effect",
  gustwalkerhatchling:"Gustwalker Hatchling: companion assumed not evolved, and its bonus is move speed",
  mosstomperseedling:"Mosstomper Seedling: companion assumed not evolved (freshly bought), no champion effect",
  controlward:"Control Ward: vision only",
  cappajuice:"Cappa Juice: does nothing",
  doranshelm:"Doran's Helm: minion damage only",
  ionianbootsoflucidity:"Ionian Boots of Lucidity: its summoner spell haste only shortens summoner cooldowns (x.Flash.cooldown); fights use each summoner at most once",
  shatteredarmguard:"Shattered Armguard: stasis already used",
};
/* data values that only restate the item's stats or preview an upgrade (Feats of Warfare boots); no passive in the item text */
const STAT_ONLY = new Set(["thebrutalizer","serrateddirk","steelsigil","doransbow","berserkersgreaves","sorcerersshoes","mercurystreads","gunmetalgreaves","spectrescowl"]);
// items whose on-hit damage benefits from life steal (League wiki item tags)
const LS_ONHIT = new Set(["ardentcenser","bladeoftheruinedking","bloodsong","duskanddawn","guinsoosrageblade","heartsteel","hullbreaker","iceborngauntlet",
  "krakenslayer","lichbane","nashorstooth","recurvebow","sheen","terminus","titanichydra","trinityforce","witsend","ravenoushydra"]);
const SPELLBLADE = ["lichbane","duskanddawn","trinityforce","essencereaver","iceborngauntlet","bloodsong","sheen"];
const IMMOB_TAGS = ["stun","root","knockup","knockback","pull","suppress","sleep"];
const MANAFLOW = ["tearofthegoddess","manamune","archangelsstaff","wintersapproach","whisperingcirclet"];
/* stacks that come from outside the fight: set with .stacks(Item, n); default 0 = freshly bought, as in the practice tool */
const ITEM_STACKS = {
  heartsteel:"bonus health from earlier Colossal Consumption procs", mejaissoulstealer:"Glory stacks", darkseal:"Glory stacks",
  hubris:"Eminence stacks", yuntalwildarrows:"Practice Makes Lethal stacks", rodofages:"Timeless stacks (one per minute)",
  gluttonousgreaves:"Slay stacks", immortalpath:"Slay stacks", tearofthegoddess:"Manaflow bonus mana", manamune:"Manaflow bonus mana",
  archangelsstaff:"Manaflow bonus mana", wintersapproach:"Manaflow bonus mana", whisperingcirclet:"Manaflow bonus mana",
};
/* a.proc(Item): the item's main damage formula and its damage type */
const ITEM_PROC = { ludensecho:["singletargetmax","magic","single target, all 6 echoes"], terminus:["onhitdamage","magic","on-hit"], nashorstooth:["totalonhitdamage","magic","on-hit"],
  witsend:["onhitdamage","magic","on-hit"], krakenslayer:["damageamount","physical","before the missing-health bonus"], lichbane:["spellbladedamage","magic","spellblade"],
  sheen:["spellbladedamage","physical","spellblade"], trinityforce:["spellbladedamage","physical","spellblade"], iceborngauntlet:["spellbladedamage","physical","spellblade"],
  bloodsong:["spellbladedamage","physical","spellblade"], essencereaver:["spellbladedamage","physical","spellblade"], duskanddawn:["spellbladedamage","magic","spellblade"],
  stormsurge:["squalldamage","magic","Squall"], hextechrocketbelt:["fireboltdamage","magic","active"], hextechgunblade:["activedamage","magic","active"],
  heartsteel:["damagecalc","physical","Colossal Consumption"], hullbreaker:["maxstackdamage","physical","Skipper"], deadmansplate:["maxdamagecalc","physical","full Momentum"],
  profanehydra:["slashdamagebase","physical","active"], stridebreaker:["slashdamage","physical","active"], ravenoushydra:["primarydamage","physical","active"], tiamat:["primarydamage","physical","active"],
  stormrazor:["totalprocdamage","magic","Energized"], hextechalternator:["damageamount","magic","Revved"], scoutsslingshot:["damageamount","magic","Bullseye"],
  sunfireaegis:["damagepertick","magic","one second of Immolate"], hollowradiance:["damagepertick","magic","one second of Immolate"], bamiscinder:["damagepertick","magic","one second of Immolate"],
  unendingdespair:["draincalc","magic","one Anguish tick"], malignance:["groundburndamageperticktooltiponly","magic","one second of Hatefog"],
  thornmail:["totaldamage","magic","Thorns"], bramblevest:["totaldamage","magic","Thorns"], titanichydra:["onhitdamagecalc","physical","on-hit"], runaanshurricane:["boltdamage","physical","one bolt"],
  dreammaker:["procdmg","magic","purple bubble"], cryptbloom:["totalhealamount","heal","heal"] };
/* items whose main damage is a share of the target's health: flat part, share, whose health, type, what */
const ITEM_PROC_PCT = {
  bladeoftheruinedking: st=>({flat:0, pct:st.ranged?idv("bladeoftheruinedking","RangedValue",0.06):idv("bladeoftheruinedking","MeleeValue",0.09), of:"current", type:"physical", what:"Mist's Edge on-hit, 9% (6% ranged) of current health"}),
  voltaiccyclosword: st=>({flat:0, pct:(st.ranged?idv("voltaiccyclosword","PercentCurrentHPRanged",7):idv("voltaiccyclosword","PercentCurrentHPMelee",9))/100, of:"current", type:"physical", what:"Firmament, 9% (7% ranged) of current health"}),
  liandrystorment: st=>({flat:0, pct:idv("liandrystorment","BurnPercentHealthDamage",0.02)*idv("liandrystorment","BurnDuration",3), of:"max", type:"magic", what:"the whole Torment burn, 6% of max health over 3s"}),
  eclipse: st=>({flat:0, pct:idv("eclipse","MeleePercMaxHP",0.08)*(st.ranged?idv("eclipse","RangedPercMaxHPMult",0.625):1), of:"max", type:"physical", what:"Ever Rising Moon, 8% (5% ranged) of max health"}),
  zazzaksrealmspike: st=>({flat:idv("zazzaksrealmspike","BaseDamage",10)+idv("zazzaksrealmspike","APRatio",0.15)*st.ap, pct:idv("zazzaksrealmspike","PercentHPDamage",0.03), of:"max", type:"magic", what:"Void Explosion, 10 + 15% AP + 3% of max health"}),
  redemption: st=>({flat:0, pct:idv("redemption","DamageToChampions",0.1), of:"max", type:"true", what:"Intervention damage, 10% of max health"}),
  blackfiretorch: st=>({flat:idv("blackfiretorch","BurnDuration",3)*itemCalc(st,"blackfiretorch","burndamagepersecondcalc"), pct:0, of:"max", type:"magic", what:"the whole Baleful Blaze burn over 3s"}),
  krakenslayer: st=>({flat:itemCalc(st,"krakenslayer","damageamount"), pct:0, of:"missing", type:"physical", what:"third-hit bonus; +0–75% by the target's missing health, 0% at full health"}),
};
function itemCalc(st, key, calc, flags){
  const I = ITEMS[key]; if (!I || !I.calcs || !I.calcs[calc]) { flags && flags.add(`${I?I.name:key}: formula ${calc} missing`); return 0; }
  const ctx = {S:{calcs:I.calcs, dv:I.dv||{}}, rank:1, st, flags:flags||new Set()};
  return evalCalc(ctx, calc).v;
}
const idv = (key, name, dflt=0) => { const I=ITEMS[key]; const e=I&&I.dv&&I.dv[name.toLowerCase()]; return e ? e[1] : dflt; };

/* ================= stats (items + runes) ================= */
/* mods: in-fight changes (buffs, stacks) from the simulator; null outside fights */
/* Attack-speed cap 3.003 = one attack per 0.333 s (wiki 'Attack speed'; raised from 2.5 in V25.S1.3). Bel'Veth's
   passive removes it for good; the other exceptions on that page (Jinx, Kennen, Varus, Sion, Zeri, Graves, Urgot) only
   apply during an ability and aren't modelled. */
const AS_CAP = 3.003;
const asCapOf = champ => champ==="Belveth" ? Infinity : AS_CAP;
function stats(c, mods){
  const runes = c.runes || [], stk = (c.opts && c.opts.stacks) || {};
  const key = c.champ+dummyKey(c)+"@"+c.level+"["+c.items.join(",")+"]("+runes.join(",")+")#"+GAME.minute+(Object.keys(stk).length?JSON.stringify(stk):"")+kitRankKey(c)+(mods?"|"+JSON.stringify(mods):"");
  let r = statMemo.get(key);
  if (!r){
    if (statMemo.size > 10000) statMemo.clear();   // ~2 KB an entry: a cache, not a store (a loop over champions × levels × items stays small)
    const m = mods || {};
    const has = k => c.items.includes(k);
    const sk = (k, max) => has(k) ? Math.max(0, Math.min(max ?? Infinity, Number(stk[k]) || 0)) : 0;
    const B=CALC.champs[c.champ].base, it={}, notes=[];
    for (const k of c.items) for (const [s,v] of Object.entries(ITEMS[k].stats)) it[s]=(it[s]||0)+v;
    const kbMelee = KB.champs[c.champ] && KB.champs[c.champ].stats ? KB.champs[c.champ].stats.melee : null;
    const ranged = kbMelee!=null ? kbMelee!==1 : B.range>=350;
    // Rod of Ages: Timeless stacks; at max stacks the champion gains a level
    const roaMax=idv("rodofages","MaxStacks",10), roa=sk("rodofages", roaMax);
    const L = roa>=roaMax ? Math.min(18, c.level+1) : c.level;
    const rc = k => runes.filter(x=>x===k).length;
    const st={level:L, ranged};
    st.basead=growth(B.ad,B.adg,L); st.bonusad=(it.ad||0)+(m.bonusad||0);
    st.ap=(it.ap||0)+(m.ap||0);
    st.basehp=growth(B.hp,B.hpg,L); st.bonushp=(it.hp||0)+(m.bonushp||0);
    st.basearmor=growth(B.armor,B.armorg,L); st.bonusarmor=(it.armor||0)+(m.bonusarmor||0);
    st.basemr=growth(B.mr,B.mrg,L); st.bonusmr=(it.mr||0)+(m.bonusmr||0);
    // practice-tool cheats grant BONUS health / armor / MR on top of the dummy's 1000 / 0 / 0 (wiki Practice Tool § Commands)
    if (c.dummy){ st.bonushp+=c.dummy.hp-B.hp; st.bonusarmor+=c.dummy.armor-B.armor; st.bonusmr+=c.dummy.mr-B.mr;
      notes.push(`Target Dummy: ${fmt(c.dummy.hp)} health = 1000 base + ${fmt(c.dummy.hp-1000)} bonus, ${fmt(c.dummy.armor)} armor and ${fmt(c.dummy.mr)} MR all bonus (practice-tool cheats), level 1, counts as a champion`);
      if (c.dummy.warn.length) notes.push(`Target Dummy: not settable in the practice tool: ${c.dummy.warn.join("; ")}`); }
    st.basemana=growth(B.mp,B.mpg,L); st.bonusmana=it.mana||0;
    st.haste=(it.haste||0)+(m.haste||0); st.rhaste=0; st.basichaste=0; st.ramp=0;
    let bonusAS=(it.as||0)+(m.bonusAS||0), mspct=(it.mspct||0)+(m.mspct||0), adaptive=0; const pairs=[];
    st.lifesteal=it.lifesteal||0; st.omnivamp=(it.omnivamp||0)+(m.omnivamp||0);
    // tenacity (wiki Tenacity § Stacking): items, elixirs and the rune shard are group A and stack multiplicatively; slow resist too
    const tenA=c.items.map(k=>ITEMS[k].stats.tenacity||0).filter(x=>x>0), slowRes=c.items.map(k=>{ const v=idv(k,"SlowResistTooltip",0); return v>1?v/100:v; }).filter(x=>x>0);
    st.healpower=it.healpower||0; st.healIn=0; st.shieldIn=0; st.physvamp=0;
    // ---- item stacks from outside the fight (default: freshly bought)
    for (const k of Object.keys(ITEM_STACKS)) if (has(k) && k!=="hubris")
      notes.push(`${ITEMS[k].name}: ${fmt(sk(k))} ${ITEM_STACKS[k]} from before the fight (${stk[k]!=null?"set":"freshly bought, as in the practice tool"}; set with .stacks(${ITEMS[k].name.replace(/[^A-Za-z]/g,"")}, n))`);
    if (roa){ st.bonushp+=roa*idv("rodofages","HealthPerStack",10); st.bonusmana+=roa*idv("rodofages","ManaPerStack",30); st.ap+=roa*idv("rodofages","APPerStack",3); if (L>c.level) notes.push(`Rod of Ages: fully stacked, +1 level (level ${L})`); }
    const mf = Math.max(0, ...MANAFLOW.map(k=>sk(k, idv(k,"MaxMana",360)))); st.bonusmana += mf;
    st.bonushp += sk("heartsteel");
    const glory = has("mejaissoulstealer") ? sk("mejaissoulstealer", idv("mejaissoulstealer","MaxGloryStacks",25)) : sk("darkseal", idv("darkseal","MaxGloryStacks",10));
    const gloryItem = has("mejaissoulstealer") ? "mejaissoulstealer" : has("darkseal") ? "darkseal" : null;
    if (gloryItem){ const g=Math.min(idv(gloryItem,"MaxGloryStacks",25), glory+(m.glory||0)); st.ap += g*idv(gloryItem,"APPerGlory",4);
      if (gloryItem==="mejaissoulstealer" && g>=idv("mejaissoulstealer","GloryThreshold",10)) mspct += idv("mejaissoulstealer","MoveSpeedMod",0.1); }
    if (has("yuntalwildarrows")){ const per=idv("yuntalwildarrows","CritPerStackMelee",0.4)/100*(ranged?idv("yuntalwildarrows","StackRangedMultiplier",0.5):1);
      it.crit=(it.crit||0)+Math.min(idv("yuntalwildarrows","CritMax",25)/100, sk("yuntalwildarrows")*per+(m.yuncrit||0)); }
    for (const k of ["gluttonousgreaves","immortalpath"]) if (has(k)){ st.omnivamp += idv(k,"OmnivampOnTakedown",0.006)*Math.min(idv(k,"MaxStacks",10), sk(k)+(m.slay||0)); break; }
    // consumed elixirs (the data has no values for these; numbers from the item text)
    if (has("elixirofiron")){ st.bonushp+=300; tenA.push(0.25); }
    if (has("elixirofsorcery")) st.ap+=50;
    if (has("elixirofwrath")){ st.bonusad+=30; st.physvamp+=0.12; }
    st.mana=st.basemana+st.bonusmana;
    // ---- runes that change stats
    adaptive += 9*rc("adaptiveforce");
    bonusAS += 0.10*rc("attackspeed");
    st.haste += 8*rc("abilityhaste");
    mspct += 0.025*rc("movespeed");
    st.bonushp += lerpL(10,180,L)*rc("healthscaling") + 65*rc("health");
    st.bonusarmor += 6*rc("armor") + 5*rc("ironskin") + lerpL(1,8,L)*rc("resistscaling");
    st.bonusmr += 8*rc("magicresist") + 6*rc("mirrorshell") + lerpL(1,8,L)*rc("resistscaling");
    for (let i=0;i<rc("tenacityandslowresist");i++){ tenA.push(0.15); slowRes.push(0.15); }   // shard: "+15% Tenacity and Slow Resist" (game data)
    if (m.slowres) slowRes.push(m.slowres);   // in-fight slow resist (Stormraider's Surge 50%)
    st.tenacity = Math.min(1, 1-tenA.reduce((p,x)=>p*(1-x),1)); st.slowresist = Math.min(1, 1-slowRes.reduce((p,x)=>p*(1-x),1));
    for (const k of ["eyeballcollection","zombieward","ghostporo"]) if (rc(k)){ pairs.push([18,30]); notes.push(`${runeName(k)}: full stacks assumed (18 AD or 30 AP)`); }
    if (rc("absolutefocus") && !m.afOff){ pairs.push([lerpL(1.8,18,L), lerpL(3,30,L)]); if (!mods) notes.push("Absolute Focus: counted at full health (above 70%); fight() drops it below 70%"); }
    // Gathering Storm (wiki): 4·m·(m−1) AP or 2.4·m·(m−1) AD, m = 1 + floor(minute/10), no cap (the client text rounds the AD: 5, 14, 29…)
    if (rc("gatheringstorm")){ const gm=1+Math.floor(GAME.minute/10); pairs.push([2.4*gm*(gm-1), 4*gm*(gm-1)]); notes.push(`Gathering Storm at minute ${GAME.minute} (set gameMinute)`); }
    if (rc("chrysalis")){ pairs.push([6,10]); notes.push("Chrysalis: assumed converted (4 takedowns)"); }
    if (rc("transcendence")) st.haste += (L>=5?5:0)+(L>=8?5:0);
    // stacking runes: stacks from before the fight via .stacks(Rune, n), default 0 (a fresh game, as in the practice tool)
    const rsk = k => rc(k) ? Math.max(0, Math.min(RUNE_STACKS[k][0], Number(stk[k]) || 0)) : 0;
    for (const k of Object.keys(RUNE_STACKS)) if (rc(k)) notes.push(`${runeName(k)}: ${fmt(rsk(k))} ${RUNE_STACKS[k][1]} (${stk[k]!=null?"set":"a fresh game, as in the practice tool"}; set with .stacks(${runeName(k).replace(/[^A-Za-z]/g,"")}, n))`);
    if (rc("ultimatehunter")) st.rhaste += 6 + 5*rsk("ultimatehunter");                          // wiki: 6 (+5 per Bounty Hunter stack), 31 at 5
    if (rc("legendalacrity")) bonusAS += 0.03 + 0.015*rsk("legendalacrity");                    // wiki: 3% (+1.5% per stack), 18% at 10
    if (rc("legendhaste")) st.basichaste += 1.5*rsk("legendhaste");                             // wiki: 1.5 basic ability haste per stack, 15 at 10
    if (rc("legendbloodline")){ st.lifesteal += 0.0045*rsk("legendbloodline"); if (rsk("legendbloodline")>=15) st.bonushp += 85; }   // wiki: 0.45% per stack; 85 health at 15
    if (rc("manaflowband")){ st.bonusmana += rsk("manaflowband"); st.mana += rsk("manaflowband"); }                             // wiki: +25 max mana per proc, up to 250
    if (rc("biscuitdelivery")){ const n=Math.min(3, Math.floor(GAME.minute/2)); st.bonushp += 30*n; notes.push(`Biscuit Delivery: ${n} biscuit${n===1?"":"s"} by minute ${GAME.minute} (at 2, 4, 6), eaten: +${30*n} max health`); }
    if (rc("celerity")) notes.push("Celerity: +1% move speed; flat bonuses ×1.07, % bonuses ×1.07 only above 5% (wiki notes)");
    if (rc("celestialbody")) st.bonushp += 100;
    if (rc("revitalize")) st.healpower += 0.05;
    if (rc("axiomarcanist")) st.ramp = 0.12;
    if (rc("jackofalltrades")){ const n=Math.min(10, Object.keys(it).filter(k=>it[k]>0).length); st.haste += n; adaptive += n>=10?20:n>=5?8:0; notes.push(`Jack of All Trades: ${n} stat types from items`); }
    // Swiftmarch: 5% of move speed as adaptive force
    if (has("swiftmarch")) adaptive += idv("swiftmarch","MSAdaptiveRatio",0.05)*msCap((B.ms+(it.ms||0))*(1+mspct));
    // (adaptive force is applied after the item conversions below, so it compares the final bonus AD and AP)
    // Overgrowth (wiki): 3 health per stack; at 15 stacks base and bonus health +3.5%
    if (rc("overgrowth")){ const n=rsk("overgrowth"); st.bonushp += 3*n; if (n>=15) st.bonushp += 0.035*(st.basehp+st.bonushp); }
    if (rc("conditioning") && GAME.minute>=12){ st.bonusarmor += 8 + 0.03*(st.basearmor+st.bonusarmor+8); st.bonusmr += 8 + 0.03*(st.basemr+st.bonusmr+8); }
    // ---- item passives that change stats (order: health → mana → AD/AP conversions → multipliers)
    if (has("warmogsarmor")){ const v=idv("warmogsarmor","HPAmp",0.12)*(it.hp||0); st.bonushp+=v; notes.push(`Warmog's Armor: +${fmt(v)} health (12% of item health)`); }
    if (has("wintersapproach")){ const v=itemCalc(st,"wintersapproach","bonushpfrommana"); st.bonushp+=v; }
    if (has("riftmaker")){ const v=idv("riftmaker","HealthToAPConversionPercent",0.02)*st.bonushp; st.ap+=v; notes.push(`Riftmaker: +${fmt(v)} AP from bonus health`); }
    if (has("archangelsstaff")){ const v=idv("archangelsstaff","APFromMana",0.01)*st.bonusmana; st.ap+=v; notes.push(`Archangel's Staff: +${fmt(v)} AP from bonus mana`); }
    if (has("steraksgage")){ const v=itemCalc(st,"steraksgage","bonusad"); st.bonusad+=v; notes.push(`Sterak's Gage: +${fmt(v)} AD (50% base AD)`); }
    if (has("overlordsbloodmail")){ const v=idv("overlordsbloodmail","HPToADPercentage",0.025)*st.bonushp; st.bonusad+=v; notes.push(`Overlord's Bloodmail: +${fmt(v)} AD from bonus health`); }
    if (has("manamune")){ const v=itemCalc(st,"manamune","bonusadfrommana"); st.bonusad+=v; }
    if (m.retribution){ st.bonusad += m.retribution*(st.basead+st.bonusad); }
    if (has("whisperingcirclet")) st.healpower += itemCalc(st,"whisperingcirclet","bonushspcalc")/100;
    if (has("dawncore")){ const mr=it.manaregenpct||0; st.healpower += idv("dawncore","HSPowerPerManaRegen",0.02)*mr; st.ap += idv("dawncore","APPerManaRegen",10)*mr; }
    let amp=m.apPct||0; for (const k of c.items){ const d=ITEMS[k].dv&&ITEMS[k].dv.apamp; if (d){ amp+=d[1]; notes.push(`${ITEMS[k].name}: +${Math.round(d[1]*100)}% AP applied`); } }
    // ---- adaptive (wiki 'Adaptive force'): AD if bonus AD > AP, AP if AP > bonus AD, a tie goes to the champion's
    // adaptive type (character record). The AP compared includes Rabadon's amplification, which then also amplifies
    // adaptive AP (the wiki's Veigar example).
    const apCmp = st.ap*(1+amp), isAD = st.bonusad > apCmp || (st.bonusad === apCmp && B.adaptive === "physical");
    if (adaptive || pairs.length) st.adaptiveFrom = st.bonusad===apCmp ? `tie (${fmt(st.bonusad)}): ${B.adaptive} adaptive type` : isAD ? "bonus AD > AP" : "AP > bonus AD";
    for (const [ad,ap] of pairs){ if (isAD) st.bonusad+=ad; else st.ap+=ap; }
    if (isAD) st.bonusad += 0.6*adaptive; else st.ap += adaptive;
    st.ap *= 1+amp;
    if (has("endlesshunger")) st.haste += 5 + (ranged?0.10:0.13)*st.bonusad;   // item text: 5 (+13% bonus AD, 10% ranged)
    if (has("spearofshojin")) st.basichaste += idv("spearofshojin","AHBase",25);
    for (const k of ["experimentalhexplate","fiendhunterbolts","malignance","zekesconvergence"]) if (has(k)) st.rhaste += idv(k,"UltimateHaste",0);
    if (has("spiritvisage")){ st.healIn += idv("spiritvisage","HealingIncrease",0.25); st.shieldIn += idv("spiritvisage","ShieldIncrease",0.25); }
    if (m.healIn) st.healIn += m.healIn; if (m.shieldIn) st.shieldIn += m.shieldIn;
    if (m.jaksho){ const f=1+idv("jakshotheprotean","BonusResistPercentage",0.3); st.bonusarmor*=f; st.bonusmr*=f; }
    for (const k of c.items){ const I=ITEMS[k]; if (!MODELLED_ITEMS[k] && (I.dv||I.calcs) && !ITEM_GAPS[k] && !STAT_ONLY.has(k)) notes.push(`${I.name}: passive not modelled`); }
    for (const k of new Set(runes)) if (!STAT_RUNES.has(k) && !FIGHT_RUNES.has(k)) notes.push(NA_RUNES[k] ? `${runeName(k)}: no combat effect (${NA_RUNES[k]})` : `${runeName(k)}: not modelled`);
    { const kit=KIT[c.champ]; if (kit && kit.stats) kit.stats(c, st, notes, {it, m, amp}); if (kit && kit.stacks && kit.stacks.buff) st.kitBuff={buff:kit.stacks.buff, n:kitStacks(c)}; }
    // ---- totals
    st.ad=st.basead+st.bonusad; st.hp=st.basehp+st.bonushp; st.armor=st.basearmor+st.bonusarmor; st.mr=st.basemr+st.bonusmr; st.bonusap=st.ap;
    // move speed = (base + flat) × (1 + additive %), then the soft caps (msCap; wiki 'Movement speed')
    // Magical Footwear: boots +10 flat (wiki); Celerity: +1%, flat bonuses ×1.07, additive % ×1.07 only when above 5% without it (wiki notes, a bug)
    let msflat=(it.ms||0)+(rc("magicalfootwear")&&it.ms>0?10:0);
    if (rc("celerity")){ msflat*=1.07; const o=mspct; mspct=o+0.01; if (o>0.05) mspct*=1.07; }
    st.basems=B.ms; st.msraw=B.ms+msflat; st.mspct=mspct; st.msuncapped=st.msraw*(1+mspct); st.ms=msCap(st.msuncapped); st.bonusms=st.ms-B.ms;
    if (st.ms!==st.msuncapped) notes.push(`move speed ${fmt(st.msuncapped)} soft-capped to ${fmt(st.ms)}`);
    // total attack speed = base + bonus% × attack-speed ratio (the ratio differs from base AS for many champions); cripples multiply the total
    st.baseas=B.as; st.asratio=B.asr||B.as; st.asMult=m.asMult||1;
    st.ascap=asCapOf(c.champ);
    st.bonusas=(B.asg/100)*(L-1)*(0.7025+0.0175*(L-1))+bonusAS; st.as=Math.min(st.ascap, (B.as + st.asratio*st.bonusas)*st.asMult);
    // base crit damage 200% (critDamageMultiplier in every character record; wiki 'Critical strike': back to 200% in V26.01).
    // Ashe's record has 1.0: her crits deal no bonus damage, so crit-damage items don't raise it either.
    st.basecritdmg=B.critmult??2; st.crit=Math.min(1,(it.crit||0)+(m.crit||0)); st.critdmg=st.basecritdmg<=1 ? 1 : st.basecritdmg+(it.critdmg||0);
    if (st.basecritdmg<=1 && st.crit>0) notes.push(`${KB.champs[c.champ].name}: critical strikes deal no bonus damage (game files; her Frost Shot bonus is not modelled)`);
    st.lethality=(it.lethality||0)+(m.lethality||0); st.armorpen=it.armorpen||0;
    // percentage penetration from separate sources multiplies: 1 − (1−a)(1−b)
    st.armorpenpct=1-(1-Math.min(1,it.armorpenpct||0))*(1-(m.armorpenpct||0));
    st.magicpen=it.magicpen||0; st.magicpenpct=1-(1-Math.min(1,it.magicpenpct||0))*(1-(m.magicpenpct||0));
    st.range=B.range+(it.range||0)+(m.range||0);   // m.range: in-fight bonus attack range (Twitch R)
    { const kit=KIT[c.champ]; if (kit && kit.statsFinal) kit.statsFinal(c, st, notes, {it, m, amp}); }
    st.gold=c.items.reduce((s,k)=>s+ITEMS[k].gold,0);
    st.ehpphysical=st.hp*(1+st.armor/100); st.ehpmagic=st.hp*(1+st.mr/100);
    st.aa=st.ad; st.dps=st.ad*st.as*(1+st.crit*(st.critdmg-1));
    st.adaptiveType = st.bonusad > st.ap ? "physical" : st.bonusad < st.ap ? "magic" : (B.adaptive || "magic");
    r={st, notes}; statMemo.set(key, r);
  }
  if (TR && !mods) for (const n of r.notes) TR.notes.add(n);
  return r.st;
}
const statNotes = c => { stats(c); const runes=c.runes||[], stk=(c.opts&&c.opts.stacks)||{}; return statMemo.get(c.champ+dummyKey(c)+"@"+c.level+"["+c.items.join(",")+"]("+runes.join(",")+")#"+GAME.minute+(Object.keys(stk).length?JSON.stringify(stk):"")+kitRankKey(c)).notes; };
// champion kits whose stats depend on ability ranks (Dr. Mundo E passive AD) key the stat memo by the set ranks too
function kitRankKey(c){ const k=KIT[c.champ]; return k && (k.stats || k.statsFinal) && k.rankStats ? "{"+Object.entries(c.ranks||{}).map(([s,r])=>s+r).join("")+"}" : ""; }

/* ================= fight simulator ================= */
const SIM_ASSUMPTIONS = [
  "fight(): positions on one line (1-D): the fronts start: units apart (default 0 = contact), centred on 0 (side 1's front at −start/2); each unit stands max(0, attack range − 175) behind its front (formation: false = all on the front); champions can back off without limit unless room: is given; everyone acts at once each 0.05 s step (damage, deaths, moves and new crowd control land at the end of the step); no terrain, walls or body blocking; attacks need edge range (range + both gameplay radii), point-and-click abilities centred range (range + both radii for the game files' castRangeUseBoundingBoxes spells: Tristana E/R, Vayne E, Viktor Q, …), other abilities their reach + the target's hitbox, except skillshots the wiki marks centred ({{tip|cr}}: the reach itself) or edge ({{tip|er}}: + both hitboxes) (wiki Range; one rule shared with canDodge)",
  "fight(): every ability and attack in range hits (perfect aim, no dodging in fight(); use canDodge for that), except the kit mechanics that say otherwise (Viktor's Gravity Field stuns only a unit still inside on its 5th stack, Aftershock can be sidestepped, his storm moves, Akali's shroud hides her from attacks and point-and-click spells); an ability's effects land after its cast time, flight and appear-delay (the same timing as .arrival and canDodge: Lux Q 0.67 s at 500, Lux R 1 s, Karthus Q 0.75 s); cooldown, cost and cast lock start at the press; crowd control never cancels a cast time (wiki Cast time: only death does), it cancels channels (Karthus R) and charges (Vi Q, Sion Q); dashes start when the cast time ends and hit on arrival if the target is in reach there (or was at the press); a displacement or knockdown stops a dash under way, a stun or root doesn't (wiki Dash; Akshan E, Camille E, Rakan W/E, Yasuo E, Yuumi W are also stopped by immobilizing CC); unstoppable abilities (Malphite R, Vi R, Hecarim R, Jarvan IV R, …) are immune to displacements and can't be stopped (wiki Crowd control § Displacement Immunity), spell shields still block them; self-casts, heals and shields apply when the cast time ends",
  "fight(): basic attacks start when the attack timer allows (timer, on-attack effects) and land at the end of their windup (wiki Attack speed: attack time × windup %, scaled by the champion's windup modifier; .windup), a ranged one after its missile's flight too (.missileSpeed; 0 = instant); the attacker can't act during the windup; a stun, knock-up or death during it cancels the attack (the timer resets), a silence doesn't; a target dead or in stasis when it lands isn't hit; empowered-attack abilities (Nasus Q, Garen Q, Darius W, Jax W, Leona Q…) resolve with the next attack, and attack resets reset the timer at the press",
  "fight(): abilities are cast as soon as they're off cooldown (each ability locks its caster for its cast time: game data checked against the wiki's cast time field, calc.json phys.castTime; an ability with none frees the caster on the next step); mana is ignored, energy is not (Zed, Akali, Lee Sin, Kennen, Shen: abilities wait until it covers their cost); a champion whose ability makes it untargetable from the cast (the ability pages' windows: Zed R, Fizz E, Vladimir W, Master Yi Q, Kayn R, Ekko R, Evelynn R, Xayah R, Camille R, and Pantheon E's kit) is untargetable for that whole step",
  "fight(): crowd control per ability from the game data checked against the wiki (Rift Logic docs: Crowd control); stun, airborne, suppression, sleep and forced actions stop everything, root stops moving, silence stops casting, polymorph stops attacking and casting, disarm stops attacking, ground and root prevent starting a dash, slows cut move speed (only the strongest applies; slow resist; soft caps). Tenacity shortens all but airborne, suppression and drowsy (floor 0.3s); every CC interrupts channels",
  "fight(): default roles: ranged = kite (keep max attack range from shorter-ranged enemies, peel them with hard CC, knockbacks held for peel, dashes/blinks used to escape), melee = dive (walk or dash to the lowest-health enemy, use everything on it but knockbacks); knockbacks are held to peel an enemy that dives an ally (except role engage); a stacking-stun field (Viktor W) is held until the enemy commits (moving in within the field's radius + both hitboxes, in its attack reach, unable to move, or diving an ally), not cast on cooldown at range; set x.role = \"kite\" | \"dive\" | \"peel\" | \"engage\" | \"fight\"",
  "fight(): area abilities hit every enemy within their radius on the line (lines and cones: every enemy within reach); ability damage over time lands up front",
  "fight(): attacks without a set target go to the enemy with the lowest health",
  "fight(): each ability does what its tooltip formula says; special mechanics (clones, stored damage, stacks, empowered recasts) are not simulated, except for the champions with a kit in the engine (KIT / CHAMP_MECH: Syndra, Viktor, Gwen, Dr. Mundo, Kai'Sa, Smolder, Ezreal, Katarina, Yone, Samira, Zed, Akali, Yasuo, Caitlyn)",
];
/* per-item assumptions, added whenever a fighter owns the item */
const ITEM_SIM_NOTES = {
  krakenslayer:"Kraken Slayer: on-hit effects that read the target's health use its health before the attack's own damage",
  bladeoftheruinedking:"Blade of The Ruined King: current health is read before the attack's own damage; Clawing Shadows slow has no effect (item slows are not modelled)",
  voltaiccyclosword:"Voltaic Cyclosword: fighters arrive fully Energized; afterwards only attacks (6 stacks each) recharge it (walking in fight() doesn't build Energize)",
  statikkshiv:"Statikk Shiv: fighters arrive fully Energized; afterwards only attacks (15 stacks each) recharge it (walking in fight() doesn't build Energize)",
  rapidfirecannon:"Rapid Firecannon: fighters arrive fully Energized; afterwards only attacks (6 stacks each) recharge it (walking in fight() doesn't build Energize)",
  stormrazor:"Stormrazor: fighters arrive fully Energized; afterwards only attacks recharge it; the move speed has no effect",
  deadmansplate:"Dead Man's Plate: assumed to walk in with full Momentum (first attack only); walking in fight() doesn't recharge it",
  heartsteel:"Heartsteel: stacks start building when the fight starts (everyone is within 700 units)",
  hexopticsc44:"Hexoptics C44: attack distance assumed equal to the attacker's attack range (1% per 50 units, max 10% at 500)",
  horizonfocus:"Horizon Focus: an ability counts as cast from 600+ units if its range is 600 or more (not the distance in the fight)",
  terminus:"Terminus: the first on-hit against a champion is a Light hit, then Dark, alternating",
  guinsoosrageblade:"Guinsoo's Rageblade: Phantom stacks come from attacks made at 4 Seething stacks (the 5th, 6th… attack), so hits 7, 10, 13… are Phantom hits",
  runaanshurricane:"Runaan's Hurricane: bolts apply on-hit damage but not on-hit stacks (Kraken, Terminus); they need other enemies",
  zhonyashourglass:"Zhonya's Hourglass: fighters (and combo targets) use it below 30% health unless x.stasis says otherwise (\"dash\", \"pop\", \"cover\", a time, \"never\"); a combo's own caster only when listed as a step",
  sunderedsky:"Sundered Sky: overheal becomes bonus health for 8s",
  deathsdance:"Death's Dance: stored damage is taken as true damage in thirds at 1, 2 and 3 seconds",
  knightsvow:"Knight's Vow: the Worthy ally is the ally named by healPolicy, otherwise the ally with the most AD + AP",
  celestialopposition:"Celestial Opposition: the slow when Blessed ends has no effect (item slows are not modelled)",
  rylaiscrystalscepter:"Rylai's Crystal Scepter: the slow has no effect (item slows are not modelled)",
  seryldasgrudge:"Serylda's Grudge: the slow has no effect (item slows are not modelled)",
  iceborngauntlet:"Iceborn Gauntlet: the frost field slow has no effect (item slows are not modelled)",
  randuinsomen:"Randuin's Omen: the Humility slow active has no effect (item slows are not modelled)",
  stridebreaker:"Stridebreaker: the active's slow and move speed have no effect (not modelled)",
  hextechgunblade:"Hextech Gunblade: the slow has no effect (item slows are not modelled)",
  zekesconvergence:"Zeke's Convergence: the storm starts when R is cast (an enemy is always in range); the slow has no effect",
  imperialmandate:"Imperial Mandate: immobilizing = abilities tagged stun, root, knock-up/back, pull, suppress or sleep",
  forceofnature:"Force of Nature: the 6% move speed has no effect",
  kaenicrookern:"Kaenic Rookern: assumed out of combat for 15s before the fight, so the shield is up at the start",
  warmogsarmor:"Warmog's Armor: 'not taking damage' counts champion damage only (8s)",
  redemption:"Redemption: every ally and enemy is inside the beam",
  healthpotion:"Health Potion: one potion, drunk below 50% health by fighters (not by passive targets)",
  refillablepotion:"Refillable Potion: drunk below 50% health by fighters (not by passive targets)",
  echoesofhelia:"Echoes of Helia: charges start empty",
  dreammaker:"Dream Maker: both bubbles are ready at the start",
  catalystofaeons:"Catalyst of Aeons: mana restore is not simulated",
  doransring:"Doran's Ring: mana is not simulated; only champions with no mana bar (0 base mana) get its heal",
  rodofages:"Rod of Ages: mana restore is not simulated",
  essencereaver:"Essence Reaver: the mana refund is not simulated",
  trinityforce:"Trinity Force: Quicken move speed has no effect",
  blackcleaver:"Black Cleaver: Fervor move speed has no effect",
  bandlepipes:"Bandlepipes: every ally is inside the aura; slows count (ability tag slow or Rylai's)",
  solsticesleigh:"Solstice Sleigh: slows count (ability tag slow or Rylai's); the move speed has no effect",
  mejaissoulstealer:"Mejai's Soulstealer: the move speed has no effect",
  actualizer:"Actualizer: basic ability cooldowns started during the 8s tick 30% faster; mana cost is ignored",
  titanichydra:"Titanic Hydra: fighters press the active whenever it is ready; in combos only when listed",
  bansheesveil:"Banshee's Veil: the spell shield is up when the fight starts and blocks one ability: the whole cast, or only what that ability's page says (one hit of a multi-hit ability, only its crowd control, nothing; wiki)",
  edgeofnight:"Edge of Night: the spell shield is up when the fight starts and blocks one ability: the whole cast, or only what that ability's page says (one hit of a multi-hit ability, only its crowd control, nothing; wiki)",
  verdantbarrier:"Verdant Barrier: the spell shield is up when the fight starts and blocks one ability: the whole cast, or only what that ability's page says (one hit of a multi-hit ability, only its crowd control, nothing; wiki)",
};
const ITEM_ACTIVE_CD = { tiamat:"tiamat", ravenoushydra:"ravenoushydra", profanehydra:"profanehydra", stridebreaker:"stridebreaker", titanichydra:"titanichydra",
  hextechgunblade:"hextechgunblade", hextechrocketbelt:"hextechrocketbelt", zhonyashourglass:"zhonyashourglass", seekersarmguard:"seekersarmguard",
  redemption:"redemption", locketoftheironsolari:"locketoftheironsolari", mikaelsblessing:"mikaelsblessing", actualizer:"actualizer",
  healthpotion:"healthpotion", refillablepotion:"refillablepotion", randuinsomen:"randuinsomen", youmuusghostblade:"youmuusghostblade",
  shurelyasbattlesong:"shurelyasbattlesong", mercurialscimitar:"mercurialscimitar", quicksilversash:"quicksilversash" };
const ACTIVE_NAME = {}; for (const k of Object.keys(ITEM_ACTIVE_CD)) ACTIVE_NAME[ITEMS[k] ? ITEMS[k].name : k] = k;
/* ---- crowd control (calc.json S.cc from src/cc_export.py: game data values checked against the wiki text) ---- */
const HARD_CC = new Set(["stun","root","knockup","knockback","pull","suppress","silence","polymorph","charm","fear","taunt","sleep","berserk"]);
const AIRBORNE = new Set(["knockup","knockback","pull"]);
// wiki Tenacity: reduces every disable except airborne, drowsy, nearsight, stasis and suppression; never below 0.3 s
const NO_TENACITY = new Set(["knockup","knockback","pull","suppress","drowsy"]);
// wiki Types of Crowd Control (summary table): what each type stops, and what can remove it
const CC_STOPS = { stun:"everything", suppress:"everything", sleep:"everything", knockup:"everything", knockback:"everything", pull:"everything",
  charm:"everything (walks to the caster)", fear:"everything (walks away)", taunt:"everything (walks to and attacks the caster)", berserk:"everything",
  polymorph:"attacks and casts", silence:"casts", root:"moving and dashing", disarm:"attacks", ground:"dashes", blind:"attack damage (attacks miss)", slow:"move speed", drowsy:"move speed" };
const CC_VERB = { stun:"stunned", suppress:"suppressed", sleep:"put to sleep", knockup:"knocked up", knockback:"knocked back", pull:"pulled", charm:"charmed",
  fear:"feared", taunt:"taunted", berserk:"berserked", polymorph:"polymorphed", silence:"silenced", root:"rooted", disarm:"disarmed", ground:"grounded", blind:"blinded", slow:"slowed", drowsy:"drowsy" };
const QSS_CLEANSES = t => !AIRBORNE.has(t) && t!=="egg";   // (Anivia's egg is her own state)                                        // Quicksilver: all but airborne (wiki)
const MIKAEL_CLEANSES = t => ["stun","root","silence","polymorph","charm","fear","taunt","berserk","sleep","slow","drowsy"].includes(t);
/* The ability's crowd control at its rank: [{type, dur, dist, mode, pct, decay, durMin, src, note}]. Effects the wiki makes
   conditional on terrain are left out (no terrain in fight()); effects with no known duration are left out and listed in skipped. */
function ccList(c, slot, rank){
  const S=CALC.champs[c.champ][slot]; const out=[], skipped=[];
  const ov = WORLD.champ(c.champ).ccOver && WORLD.champ(c.champ).ccOver[slot];
  // champion kits (audit): crowd control the data export misses or gets wrong, from the wiki (KIT[champ].cc[slot], same format)
  const kc = !ov && KIT[c.champ] && KIT[c.champ].cc && KIT[c.champ].cc[slot];
  const list = ov ? ov.v : kc ? (typeof kc==="function" ? kc(S, rank, c) : kc) : (S && S.cc) || [];
  const at = v => v==null ? null : Array.isArray(v) ? (v[rank] ?? v[v.length-1]) : v;
  for (const e of list){
    if (e.cond){ skipped.push(`${e.type} (only when it hits terrain)`); continue; }
    const x={type:e.type, dur:at(e.dur), dist:at(e.dist), mode:e.distMode||"by", pct:at(e.pct), decay:!!e.decay, durMin:e.durMin??null,
             src:e.src||{}, agree:e.agree, text:e.text, asserted:e.asserted};
    if (AIRBORNE.has(x.type) && x.type!=="knockup" && x.dur==null && (x.dist || x.type==="pull")){ x.dur=0.5; x.durAssumed=true; }
    if (x.type==="slow" && !(x.pct>0)){ skipped.push("slow (strength unknown)"); continue; }
    if (!(x.dur>0)){ skipped.push(`${x.type} (duration unknown)`); continue; }
    out.push(x);
  }
  return {list:out, skipped};
}
const ccSrc = e => [e.src.dur ? `duration ${e.src.dur==="wiki"?"from the wiki (no game data value)":e.src.dur.replace(/^dv:/,"game data ")}` : "", e.src.dist ? `distance ${e.src.dist==="wiki"?"from the wiki":e.src.dist.replace(/^dv:/,"game data ")}` : "",
  e.src.pct ? `strength ${e.src.pct==="wiki"?"from the wiki":e.src.pct.replace(/^dv:/,"game data ")}` : "", e.src.durData ? `the game data has ${e.src.durData.replace(/^dv:/,"")} (disagrees with the wiki; wiki used)` : "",
  e.src.durMin ? `minimum ${fmt(e.durMin)}s from game data ${e.src.durMin.replace(/^dv:/,"")} (wiki agrees)` : "",
  e.durAssumed ? "airborne time assumed 0.5 s (not in the data or the wiki text)" : "", e.asserted ? `set on line ${e.asserted}` : ""].filter(Boolean).join("; ");
function ccDescribe(e){
  const base = e.type==="knockback" ? `knockback ${e.mode==="to"?"to":"by"} ${fmt(e.dist)} units over ${fmt(e.dur)}s` : e.type==="pull" ? `pull${e.dist?` ${fmt(e.dist)} units`:" to the caster"} over ${fmt(e.dur)}s`
    : e.type==="slow" ? `slow ${fmt(100*e.pct)}%${e.decay?" decaying":""} for ${fmt(e.dur)}s` : `${e.type} ${e.durMin!=null?`${fmt(e.durMin)}–`:""}${fmt(e.dur)}s`;
  return base;
}
/* Tenacity: duration × (1 − tenacity), not below 0.3 s (wiki Tenacity); airborne, suppression and drowsy are unaffected */
function ccDuration(e, ten){
  if (NO_TENACITY.has(e.type) || !(ten>0)) return e.dur;
  return Math.max(Math.min(e.dur, 0.3), e.dur*(1-ten));
}
function simulate(sidesIn, T, simNotes, fo){
  fo = fo || {};
  const saved=TR; TR=null;
  const dt=0.05, U=[], log=[], events=[], pendingKills=[]; let inTick=false, dmgQueue=null, healQueue=null;
  const say=(t,s)=>{ if (log.length<600) log.push(`${t.toFixed(2)}s  ${s}`); };
  SIM_ASSUMPTIONS.forEach(n=>simNotes.add(n));
  const has=(u,k)=>u.items.has(k);
  // u's critical strike damage multiplier against y (Randuin's Omen: crits deal 30% less to its holder); every crit uses this
  const critVs=(u,y)=>u.st.critdmg*(y && has(y,"randuinsomen")?1-idv("randuinsomen","PercentCritDamageReduction",0.3):1);
  const ready=(u,k,t)=>!(u.rcd[k]>t);
  const setcd=(u,k,t,s)=>{ u.rcd[k]=t+s; };
  const L=u=>u.st.level;
  sidesIn.forEach((arr,side)=>arr.forEach(c=>U.push(makeUnit(c,side))));
  for (const u of U){ statNotes(u.c).forEach(n=>simNotes.add(n));
    for (const k of u.items){ if (ITEM_SIM_NOTES[k]) simNotes.add(ITEM_SIM_NOTES[k]); if (ITEM_GAPS[k]) simNotes.add(ITEM_GAPS[k]); } }
  if (U.some(u=>u.st.crit>0)) simNotes.add("fight(): critical strikes count at their expected value on every attack (damage × (1 + crit chance × (crit damage − 1)))");

  function abNums(u, a){
    // Axiom Arcanist (wiki): ultimate damage +12% (+8% area of effect), healing and shielding +12%
    const st=u.st, amp = a.slot==="R" ? 1+(st.ramp && a.aoe ? 0.08 : st.ramp) : 1, hamp = a.slot==="R" ? 1+st.ramp : 1, S=a.S;
    const kp=kitSimParts(u, a, u.flags);   // champion kits: parts with live options; a.later = parts dealt by CHAMP_MECH later
    if (kp && a.later) a.later=a.later.map(p=>({...p, v:p.v*amp, per:p.per!=null?p.per*amp:undefined}));
    a.parts = kp ? kp.map(p=>({v:p.v*amp, type:p.type, pct:!!p.pctOf, pctOf:p.pctOf, floor:p.floor, ampMissing:p.ampMissing, ampCap:p.ampCap, ampBelow:p.ampBelow}))
                 : a.keys.map(k=>{ const r=partRaw(S,k,a.rank,st,u.flags); return {v:r.v*amp, type:a.types[k], pct:!!r.pctOf, pctOf:r.pctOf}; });
    if (S.heal) a.heal=evalCalc({S,rank:a.rank,st,flags:u.flags},S.heal).v*hamp;
    if (S.shield) a.shield=evalCalc({S,rank:a.rank,st,flags:u.flags},S.shield).v*hamp;
    { const ks=kitSpec(u.c, a.slot); if (a.shield && ks && ks.shieldMult) a.shield*=ks.shieldMult(u.c, st, a.rank); }   // Viktor Turbocharge
    // P3: a "oneHit" ability's hit count as fight() deals it, for spell shields (oneHitCut): the kit option shieldHits names (Syndra R:
    // spheres), else the one count option the kit's fight() setting fixes (Samira W slashes: 1, Samira R shots: 1, Gangplank R waves: 1)
    if (a.p && a.p.spellShield==="oneHit"){ const sh=a.p.shieldHits, ks=kitSpec(u.c, a.slot); a.shieldN=null;
      if (ks && ks.opts){ const so=ks.sim ? ks.sim(u, a) : null, o=kitOptions(ks, so, u.c, a.slot, st, a.rank);
        const cnt=Object.keys(so||{}).filter(n=>ks.opts[n] && typeof ks.opts[n].min==="number" && ks.opts[n].min>=1);
        if (typeof sh==="string" && ks.opts[sh]) a.shieldN=o[sh]; else if (cnt.length===1) a.shieldN=o[cnt[0]]; } }
  }
  function abCd(u, a){
    if (a.cdFixed!=null) return a.cdFixed;
    if (a.cdFromAS) return Math.max(1/u.st.as, a.minCd||0);
    { const ks=kitSpec(u.c, a.slot); if (ks && (ks.simCd || ks.cd)){ const x=kitCtx(u.c, a.slot, a.rank, u.st, u.flags, null, u); return ks.simCd ? ks.simCd(x) : ks.cd(x); } }
    const mandate = a.immob && has(u,"imperialmandate") ? idv("imperialmandate","ImmobilizingAbilityAH",20) : 0;
    return a.base*100/(100+u.st.haste+mandate+(a.slot==="R"?u.st.rhaste:u.st.basichaste)+grantedHaste(u.c, a.slot));
  }
  function makeUnit(c, side){
    const st=stats(c), o=c.opts||{}, stk=o.stacks||{};
    const u={c, side, name:label(c), st, base:st, hp:st.hp, max:st.hp, alive:true, deathAt:null, shields:[], cd:{}, nextAct:0, nextAA:0,
      dealt:0, taken:0, healDone:0, shieldDone:0, healRecv:0, grievUntil:-1, grievBy:0, combatAt:null, champCombatAt:null, dmgIn:[], aa:0,
      rcd:{}, stasisUntil:-1, dots:[], cleaver:{n:0,until:-1}, after:{until:-1,armor:0,mr:0}, plating:null,
      sb:{ready:false, until:-1, cd:-1}, lt:{n:0,until:-1}, conq:{n:0,until:-1}, hob:{n:0,until:-1}, ptaCount:{}, ptaOn:new Set(), ecl:{},
      elec:[], fsUntil:-1, fleetReady:true, graspAt:0, impairedBy:null, impairedUntil:-1, mobileUntil:-1, gaUsed:false, reviveAt:-1,
      aeryAt:0, ssWin:{}, immUntil:-1, immAt:null, udAt:null, kaenicDone:false, lastAATarget:null, lastAAt:-10, lastHurtAt:-Infinity, lastMagicAt:-Infinity,
      items:new Set(c.items), runes:new Set(c.runes||[]), passive:!!o.passive || !!c.dummy, target:o.target||null, policy:o.healPolicy||"lowest",
      dummy:!!c.dummy, dummyTaken:0, wouldDieAt:null, hits:[],
      souls:o.souls||0, rotation:(o.rotation||"").toUpperCase(), vamp:0, ab:{}, abAll:{},
      buffs:[], perm:{hp:0, omni:0, slay:0, glory:0, yun:0}, modKey:"null", energy:100, dmp:true,
      term:{light:{n:0,until:-1}, dark:{n:0,until:-1}, next:"light"}, rage:{n:0,until:-1,ph:0}, kraken:{n:0,until:-1}, hull:{n:0,until:-1},
      heart:{}, sunder:{}, shojin:{n:0,until:-1,cast:-1}, fiend:{n:0,until:-1}, hubris:Number(stk.hubris)||0, fon:{n:0,until:-1,last:{}},
      dd:[], echo:0, bubbles:{ready:0}, blue:null, purple:null, vowAlly:null, casts:0, charges:{refillablepotion:idv("refillablepotion","MaxCharges",2), healthpotion:1},
      dmgBy:new Map(), marks:{}, expose:null, vuln:null, venom:null, malig:null, bloodlet:{n:0,until:-1,at:-1}, squall:null,
      script: c._script ? c._script.slice() : null, si:0, stepLog:[], scriptWait: c._scriptWait !== false, scriptTravel: !!c._scriptTravel};
    u.ranged = st.ranged;
    // position on the line (side 1 faces +x from −start/2, side 2 faces −x from +start/2) and crowd control state
    // formation (default): each unit stands max(0, attack range − 175) behind its side's front, i.e. ranged units at their
    // attack range from where the enemy front will stand; fight(..., formation: false) puts everyone on the front line
    u.depth = fo.formation===false ? 0 : Math.max(0, st.range-175);
    // centred on 0 so mirrored positions are exact negatives (no rounding bias)
    u.x = side===0 ? -(fo.start||0)/2-u.depth : (fo.start||0)/2+u.depth; u.x0=u.x; u.ccs=[]; u.slows=[]; u.move=null; u.role=o.role||null; u.walk=null; u.chan=null;
    u.flags=new Set(); u.kit={};
    for (const s of ["P","Q","W","E","R"]){
      const S=CALC.champs[c.champ][s]; if (!S) continue;
      if (s==="P" && !u.script) continue;      // the passive is only triggered explicitly, in combos
      const rank=rankOf(c,s); if (!rank) continue;
      const tags=WORLD.champ(c.champ).slots[s].tags;
      const a={slot:s, rank, S, parts:[], heal:0, shield:0, aoe:tags.aoe!==undefined, hardcc:tags.hardcc!==undefined, mobile:tags.mobile!==undefined,
        immob:IMMOB_TAGS.some(x=>tags[x]!==undefined), slows:tags.slow!==undefined, range:((S.range||[])[rank]||0)+((levelRangeBonus(c, s)||{}).v||0)};
      { const cl=ccList(c, s, rank); a.cc=cl.list; for (const k of cl.skipped) simNotes.add(`${u.name} ${s}: ${k}: not applied`);
        for (const e of a.cc) simNotes.add(`${u.name} ${s}: ${ccDescribe(e)} (${ccSrc(e)})`);
        try { a.p=physOf(c, s); } catch(err){ a.p={range:a.range, castTime:0.25, delivery:"unit", kind:"targeted"}; }
        a.dash = s!=="P" && (tags.dash!==undefined || tags.blink!==undefined); a.blink = tags.blink!==undefined && tags.dash===undefined;
        a.spellShield = S.spellShield ?? null; a.ccImmune = !!S.ccImmuneWhileShield;
        a.hard = a.cc.some(e=>HARD_CC.has(e.type)); a.knock = a.cc.find(e=>e.type==="knockback" && e.dist>=100) || null;
        if (a.cc.length) a.immob = a.immob || a.cc.some(e=>["stun","root","knockup","knockback","pull","suppress","sleep"].includes(e.type)); }
      if (S.spread && S.dv[S.spread]){ const d=S.dv[S.spread][1]; a.spread = d[rank] ?? d[d.length-1]; a.channel = !!S.channel; }
      a.keys = S.mainparts&&S.mainparts.length ? S.mainparts : (S.main?[S.main]:[]);
      a.types={};
      for (const k of a.keys){
        const tov=WORLD.champ(c.champ).typeOver && WORLD.champ(c.champ).typeOver[s];
        a.types[k]=(tov && tov.v) || S.types[k] || (S.calcs[k] ? guessType(S.calcs[k]) : "magic");
        if (!S.types[k] && !tov && !(kitSpec(c,s) && (kitSpec(c,s).parts || kitSpec(c,s).none))) simNotes.add(`${u.name} ${s}: damage type not in tooltip, assumed ${a.types[k]}`); }
      abNums(u, a);
      if (S.healTarget) a.healTarget=S.healTarget;
      if (S.shield){ a.shieldTarget=S.shieldTarget; const d=S.shieldDur && S.dv[S.shieldDur]; a.shieldDur = d ? (d[1][rank] ?? 2.5) : 2.5; }
      if (S.vamp){ const v=evalCalc({S,rank,st,flags:u.flags},S.vamp).v; u.vamp += v>1 ? v/100 : v; }
      const w=WORLD.champ(c.champ);
      if (s==="P"){ a.isPassive=true; a.cd=0; if (a.parts.length) u.abAll.P=a; else a.passiveOnly=true; simNotes.add(`${u.name} P: each P step applies the passive's damage formula once; its trigger (e.g. picking up a dagger) is assumed to happen`); continue; }
      if (w.cdOver && w.cdOver[s]) a.cdFixed=w.cdOver[s].v;
      if (S.cdFromAS && a.cdFixed==null){ a.cdFromAS=true; a.minCd=dvOf(S,"mincooldown",rank)||0; a.cd=abCd(u,a); u.abAll[s]=a; if (a.parts.length || a.heal || a.shield) u.ab[s]=a; simNotes.add(`${u.name} ${s}: cooldown is 1 / attack speed (${fmt(a.cd)}s), not reduced by ability haste`); continue; }
      { const ks=kitSpec(c,s); if (ks && ks.simCd && a.cdFixed==null){ a.cdFixed=ks.simCd(kitCtx(c,s,rank,st,u.flags,null,u)); simNotes.add(ks.simCdWhy ? `${u.name} ${s}: ${ks.simCdWhy} (${fmt(a.cdFixed)}s)` : `${u.name} ${s}: in a fight it recasts on the same target only every ${fmt(a.cdFixed)}s (per-target lockout; the ability's own cooldown is shorter)`); } }
      a.base = a.cdFixed!=null ? a.cdFixed : (S.cd ? (S.cd[rank] ?? S.cd[1]) : 10);
      if (!(a.base>=0.5)){ a.passiveOnly=true; u.abAll[s]=a; if (!u.script) simNotes.add(`${u.name} ${s}: cooldown is ${fmt(a.base||0)} in the game data (a passive, toggle or ammo ability), so fight() doesn't cast it; set one with ${champName(c)}.${s}.setCooldown(…)`); continue; }
      a.cd = abCd(u,a);
      // ammo abilities (game data mMaxAmmo, mAmmoRechargeTime): charges, each recharging separately (ability haste applies); S.cd is the lockout between casts
      if (S.charges && S.recharge && a.cdFixed==null){ const rc=S.recharge[rank] ?? S.recharge[1], ks=kitSpec(c,s), mx=ks && ks.charges ? ks.charges(rank) : S.charges;
        if (rc>a.base){ a.ammo={max:mx, n:mx, at:null, rc}; if (!u.script) simNotes.add(`${u.name} ${s}: ${mx} charges, one every ${fmt(rc)}s (ability haste applies), ${fmt(a.base)}s between casts`); } }
      u.abAll[s]=a;
      if (!a.parts.length && !a.heal && !a.shield && !a.cc.length && !(a.later && a.later.length)) continue;
      u.ab[s]=a;
    }
    for (const f of u.flags) simNotes.add(`${u.name}: ${f}`);
    return u;
  }
  const inStasis = (x,t) => t < (x.stasisS ?? x.stasisUntil);      // stasisS: at the start of the tick (stasis gained mid-tick counts from the next)
  const enemiesOf = (u,t) => U.filter(x=>x.alive && x.side!==u.side && !inStasis(x,t));
  const partDmg = (p, x) => { const hp = x.hpS ?? x.hp; let v = !p.pct ? p.v : p.v*(p.pctOf==="current" ? Math.max(0,hp) : p.pctOf==="missing" ? Math.max(0,x.max-hp) : x.max);
    if (p.floor && v<p.floor) v=p.floor;                                                              // champion kits: Dr. Mundo Q minimum
    if (p.ampMissing) v*=1+Math.min(p.ampCap??1, p.ampMissing*Math.max(0,1-x.hp/x.max));             // Akali R recast, Samira passive
    if (p.ampBelow && hp < p.ampBelow.pct*x.max) v*=1+p.ampBelow.amp;                                   // Qiyana Q (Terrain): +60% below 50% health
    return v; };
  const alliesOf = (u) => U.filter(x=>x.alive && x.side===u.side && !x.pet);   // pets (Daisy) aren't healed, shielded or buffed by allies
  const pct = x => (x.hpS ?? x.hp)/x.max;     // hpS: health at the start of the tick (decisions are simultaneous)
  const incoming = (x,t,w=1.5) => x.dmgIn.filter(d=>d.t>t-w && d.t<t).reduce((s,d)=>s+d.v,0)/w;
  const sameChamp = (u, c) => !!c && champKey(u.c)===champKey(c);
  /* ---- positions, movement and crowd control (fight(); scripted combos ignore range) ---- */
  const RAD = u => u._rad ?? (u._rad = hitboxOf(u.c));  // gameplay radius per champion (character record; dummy grows with health); fixed for the fight, so cached per unit
  const face = u => u.side===0 ? 1 : -1;                // the direction of the enemy side
  const gap = (a,b) => Math.abs((a.xS ?? a.x)-(b.xS ?? b.x));   // xS: position at the start of the tick (simultaneous decisions)
  // a crowd control applied during tick t takes effect from the next tick, so the order units act in within a tick doesn't matter
  const ccLive = (c,t) => c.until>t && !(c.at>=t);
  const ccOn = (u,t,type) => u.ccs.some(c=>c.type===type && ccLive(c,t));
  const LOCKS = ["stun","suppress","sleep","knockup","knockback","pull","charm","fear","taunt","berserk","egg"];   // egg: Anivia's Rebirth
  const locked = (u,t) => u.ccs.some(c=>ccLive(c,t) && LOCKS.includes(c.type));
  const canCast = (u,t) => !locked(u,t) && !ccOn(u,t,"silence") && !ccOn(u,t,"polymorph");
  const canAttack = (u,t) => !locked(u,t) && !ccOn(u,t,"disarm") && !ccOn(u,t,"polymorph");
  // a displacement started this tick counts from the next; during the decision pass the movement is the one at its start (u.moveS):
  // a unit displaced by another's action this tick (its dash stopped and replaced) decides as it would have before (order-independence)
  const canMove = (u,t) => { const m = u.moveS!==undefined ? u.moveS : u.move; return !locked(u,t) && !ccOn(u,t,"root") && !(m && m.t1>t && m.t0<t); };
  const canDash = (u,t) => canMove(u,t) && !ccOn(u,t,"ground");
  // unstoppable (UNSTOPPABLE, item 28): u.unstop = {imm, slot, from, until, why} while an unstoppable ability is cast / dashing
  const unstopOn = (u,t) => { const s=u.unstop; return s && t>=s.from-1e-9 && t<=s.until+1e-9 ? s : null; };
  const ccImmune = (u,t) => u.ccImmuneUntil>t || u.shields.some(s=>s.ccImmune && s.until>=t && shieldLeft(s,t)>0.01) || (unstopOn(u,t)||{}).imm==="cc";   // ccImmuneUntil: kits (Olaf R)
  // wiki Movement speed: only the strongest slow counts; slow resist scales it; soft caps after
  function slowNow(u,t){ let best=0; for (const s of u.slows){ if (s.until<=t || s.t0>=t) continue;   // takes effect from the next tick
      const v = s.decay ? s.pct*(s.until-t)/Math.max(1e-9,s.until-s.t0) : s.pct; if (v>best) best=v; } return best*(1-(u.st.slowresist||0)); }
  const msNow = (u,t) => msCap((u.st.msuncapped||u.st.ms)*(1-slowNow(u,t)));
  // Cheap Shot's crowd control (wiki Rune_data_Cheap_Shot): immobilize, blind, disarm, ground, nearsight, polymorph, silence, slow
  const CHEAP_CC = ["stun","root","knockup","knockback","pull","suppress","sleep","charm","fear","taunt","berserk","blind","disarm","ground","nearsight","polymorph","silence"];
  const cheapShotImpaired = (x,t) => x.ccs.some(c=>ccLive(c,t) && CHEAP_CC.includes(c.type)) || x.slows.some(s=>s.until>t && !(s.t0>=t)) || x.impairedUntil>t;
  // Approach Velocity (wiki): +7.5% move speed walking toward a movement-impaired enemy within 1000, +15% toward one you impaired (any distance)
  function msWalk(u,t,dir){
    if (!u.runes.has("approachvelocity") || !dir) return msNow(u,t);
    let b=0; for (const e of U){ if (!e.alive || e.side===u.side || Math.sign((e.xS??e.x)-(u.xS??u.x))!==dir) continue;
      const imp = e.slows.some(s=>s.until>t && !(s.t0>=t)) || e.ccs.some(c=>ccLive(c,t) && ["stun","root","knockup","suppress","sleep","charm","fear","taunt","ground"].includes(c.type));
      if (!imp) continue; const mine = e.slows.some(s=>s.until>t && !(s.t0>=t) && s.by===u) || e.ccs.some(c=>ccLive(c,t) && c.src===u) || e.impairedBy===u && e.impairedUntil>t;
      b=Math.max(b, mine ? 0.15 : gap(u,e)<=1000 ? 0.075 : 0); }
    if (!b) return msNow(u,t);
    return msCap(u.st.msraw*(1+u.st.mspct+b)*(1-slowNow(u,t))); }
  const aaReach =(u,x) => attackReach(u.st.range, RAD(u), RAD(x));   // the shared reach rule (hitReach below reachOf)
  function abReach(u,a,x){ const p=a.p||{};
    const r = p.delivery==="unit" ? p.reach ?? p.range : reachOf(p);
    return r>=20000 ? Infinity : hitReach(p, RAD(u), RAD(x), u.st.range); }
  const inReach = (u,a,x) => gap(u,x) <= abReach(u,a,x) + 1e-6;
  // the lock after a cast: the ability's cast time (calc.json phys.castTime: the game's, checked against the wiki's "cast time"
  // field, backlog 23), so an ability with none (Zed W/E, Syndra Q/W, Camille Q, Nasus Q, …) frees the caster on the next
  // 0.05 s step (Syndra-Zed gap G7); a longer one (Lux R 1 s, Caitlyn Q 0.625 s) holds it that long
  const castLock = (u,a) => a.p && a.p.castTime!=null ? Math.max(dt, a.p.castTime) : 0.25;
  // fight(..., kite: false) wins over x.role = "kite" (the option is the more specific instruction for this fight)
  const roleOf = u => { const r = u.role || (u.ranged ? "kite" : "dive"); return r==="kite" && fo.kite===false ? "fight" : r; };
  const arenaClamp = (x, to, t) => x.arena && x.arena.until>t ? Math.max(x.arena.cx-x.arena.r, Math.min(x.arena.cx+x.arena.r, to)) : to;   // Jarvan IV R walls
  // forced (enemy) displacements beat the unit's own dash started in the same tick, whichever came first in the tick
  function displace(x, to, dur, t, forced){ if (!forced && x.move && x.move.forced && x.move.t0>=t) return; to=arenaClamp(x, to, t); x.move={x0:x.x, x1:to, t0:t, t1:t+Math.max(dur,1e-3), forced:!!forced}; }
  function stepMove(u,t){ const m=u.move; if (!m) return; const f=Math.min(1,(t-m.t0)/(m.t1-m.t0)); u.x=m.x0+(m.x1-m.x0)*f; if (f>=1) u.move=null; }
  const clampRoom = (u, x) => fo.room==null ? x : u.side===0 ? Math.max(u.x0-fo.room, x) : Math.min(u.x0+fo.room, x);
  function walk(u, toX, t, why){
    const d=toX-u.x, step=msWalk(u,t,Math.sign(d))*dt; if (Math.abs(d)<1e-6) return;
    let nx=arenaClamp(u, clampRoom(u, u.x + Math.sign(d)*Math.min(step, Math.abs(d))), t);
    if (zones.length){ const cx=zoneBlock(u, nx, t); if (cx!=null){ nx=Math.sign(d)>0 ? Math.min(nx, cx) : Math.max(nx, cx); if (u.walk!=="zone"){ u.walk="zone"; say(t, `${u.name} waits at the edge of the Gravity Field (its next stack would stun)`); } } }
    if (Math.abs(nx-u.x)<1e-9) return;
    const state=`${why}`; if (u.walk!==state){ u.walk=state; say(t, `${u.name} ${why} (move speed ${fmt(msNow(u,t))})`); }
    u.nx=nx;                                   // applied at the end of the tick (everyone moves simultaneously)
  }
  const holdStill = u => { u.walk=null; };
  // an enemy diving an ally that outranges it (or u itself): the peel target
  function threat(u,t){ let best=null, bd=Infinity;
    for (const e of enemiesOf(u,t)){ if (e.passive) continue;
      for (const A of alliesOf(u)){ const g=gap(e,A); if (g<=aaReach(e,A)+50 && aaReach(e,A)<aaReach(A,e) && g<bd){ bd=g; best=e; best.victim=A; } } }
    return best; }
  function chaser(u,t){ let best=null, bd=Infinity;
    for (const e of enemiesOf(u,t)){ if (e.passive) continue; const g=gap(u,e); if (aaReach(e,u)<aaReach(u,e) && g<aaReach(u,e)-5 && g<bd){ bd=g; best=e; } } return best; }
  // crowd control's interruption (channels, cast locks) is applied at the end of the tick, whatever order the units acted in
  // soft: a silence (it stops casts, not a basic attack's windup)
  function interrupt(x,t,soft){ if (inTick){ if (x.interruptAt!==t) x.intSoft=true; x.interruptAt=t; x.intSoft = x.intSoft && !!soft; return; } doInterrupt(x,t,soft); }
  function doInterrupt(x,t,soft){
    let freed=false;
    if (x.chan && x.chan.until>t){ for (const y of U) y.dots=y.dots.filter(d=>!(d.u===x && d.ability && d.ability.channel)); say(t, `  ${x.name}'s ${x.chan.slot} channel is interrupted`); x.chan=null; freed=true; }
    if (cancelCasts(x, t, "is interrupted", soft)) freed=true;
    if (freed) x.nextAct=Math.min(x.nextAct, t+dt);   // free again from the next tick (not later in this one: order-independence)
  }
  /* item 28 (wiki "Cast time" § Interrupting cast times: "Cast times cannot be interrupted by any means ... except by death";
     Template:Channel type: a cast time's default interrupts = none, a channel's = silence, death): crowd control never cancels a
     cast time — the ability fires when it ends, whatever happened to the caster meanwhile — but it does cancel a channel
     (P.chanFrom: Karthus R, Galio R) once the channel has started; death cancels both. (Backlog 25 had a stun or silence cancel
     cast times, which the wiki contradicts.)
     an attack's windup (P.slot "attack", backlog 25 step 7): cancelled by crowd control but not by a silence; the attack
     timer resets (wiki "Attack speed": an interrupted windup resets the timer, a new windup may begin whenever possible) */
  function cancelCasts(x, t, why, soft){ if (!x.pend || !x.pend.length) return 0; let n=0;
    for (const P of x.pend) if (!P.done && !P.cancelled && P.end > t+1e-9){
      if (P.slot==="attack"){ if (soft) continue; P.cancelled=true; n++; x.nextAA=Math.min(x.nextAA, t); say(t, `  ${x.name}'s attack ${why==="dies"?"is lost (the attacker dies during its windup)":"is interrupted during its windup: it doesn't land"}`); continue; }
      if (why==="is interrupted"){ if (P.chanFrom==null || t < P.chanFrom-1e-9) continue;   // a cast time: not interrupted (wiki Cast time)
        const s=unstopOn(x,t); if (s && s.slot===P.slot) continue; }                        // unstoppable (Galio R after 1.25 s)
      P.cancelled=true; n++; say(t, `  ${x.name}'s ${P.slot} ${why==="dies"?"cast is lost (the caster dies before its cast time (or channel) ends)":why==="is interrupted"?`${P.charge?"charge":"channel"} is interrupted: it doesn't land`:`cast is lost (the caster ${why})`}`); }
    x.pend=x.pend.filter(P=>!P.done && !P.cancelled); return n; }
  // spell shields: items (Banshee's, Edge of Night, Verdant Barrier) and abilities (Sivir E, Nocturne W: cast as the ability lands, perfect play)
  // what: the part blocked, for the log ("one sphere of", "the crowd control of"; default the whole ability)
  function blocked(u,a,x,t,what){
    const w = what ? `${what} ${u.name}'s ${a.slot}` : `${u.name}'s ${a.slot}`;
    const ss=["bansheesveil","edgeofnight","verdantbarrier"].find(k=>has(x,k));
    if (ss && t>=(x.annulAt??0)){ x.annulAt=t+idv(ss,"Cooldown",40); x.blocks=(x.blocks||0)+1; say(t, `  ${ITEMS[ss].name} blocks ${w} on ${x.name}`); return true; }
    if (!x.passive && !x.script) for (const s of ["Q","W","E","R"]){ const b=x.abAll[s]; if (!b || b.spellShield==null || (x.cd[s]||0)>t || !canCast(x,t)) continue;
      x.cd[s]=t+abCd(x,b); x.blocks=(x.blocks||0)+1; say(t, `  ${x.name} blocks ${w} with ${s} (spell shield raised as it lands: perfect play)`);
      simNotes.add(`${x.name} ${s}: spell shield raised just as a hostile ability lands (perfect reaction); it blocks one ability: the whole cast, or only the part the ability's page says (one hit of a multi-hit ability, only its crowd control, …; wiki)`);
      if (b.heal) heal(x,x,b.heal,t,`${s} spell shield block`); return true; }
    return false;
  }
  /* P3 (interaction audit): spell shields per hit, from the ability's page (a.p.spellShield; SIM_INTERIM_P3 until P1 exports it).
     Returns null (nothing blocked) | "all" | "one" (one hit: the rest land) | "cc" (only the crowd control) | "dmg" (only the damage).
     A kit dealing later hits of its own asks blockedHit() per hit (P6). */
  function shieldHit(u,a,x,t){ const m=(a.p && a.p.spellShield) || "blocks";
    if (m==="not"){ if (a.p.shieldConsumed && blocked(u,a,x,t,"(consumed without blocking: wiki bug)")) simNotes.add(`${u.name} ${a.slot}: a spell shield is used up but doesn't block it (wiki, a documented bug)`);
      return null; }
    if (m==="oneHit"){ const cut=oneHitCut(u,a); if (!cut) return blocked(u,a,x,t) ? "all" : null;
      return blocked(u,a,x,t,cut.what) ? "one" : null; }
    if (m==="ccOnly") return (a.cc||[]).length && blocked(u,a,x,t,"the crowd control of") ? "cc" : null;
    if (m==="damageOnly") return a.parts.length && blocked(u,a,x,t,"the damage of") ? "dmg" : null;
    return blocked(u,a,x,t) ? "all" : null; }
  function blockedHit(u,a,x,t,what){ return blocked(u,a,x,t,what||"one hit of"); }
  /* the hit a spell shield takes from a "oneHit" ability, as fight() deals it: {skip0} a channel's first separate hit (Katarina R),
     {first} the first damage part (Ahri Q's out pass), {n} 1/n of the damage (Syndra R spheres, Fiddlesticks R ticks, a spread's
     ticks); null when fight() deals one hit only (the kit deals the others, or the rest aren't modelled): that hit is blocked */
  function oneHitCut(u,a){ const sh=a.p.shieldHits;
    if (a.spread>0 && a.S.onHit && dvOf(a.S,"tickspersecond",a.rank)>0) return {skip0:true, what:"one hit of"};
    if (sh==="first" && a.parts.length>1) return {first:true, what:"one pass of"};
    const n = a.shieldN!=null ? a.shieldN : typeof sh==="number" ? sh : a.spread>0 ? Math.max(1, Math.round(a.spread/0.5)) : 1;
    return n>1 ? {n, what:`one ${typeof sh==="string" && sh!=="first" ? sh.replace(/s$/,"") : "hit"} (of ${fmt(n)}) of`} : null; }
  // Kennen's Mark of the Storm (wiki): each ability hit adds a mark for 6 s (MarkDuration); the third consumes them to stun
  // for 1.25 s (StunDuration), 0.5 s (ReducedStunDuration) if the same target was stunned by it in the last 6 s.
  // Slicing Maelstrom marks each target up to 3 times: modelled as marks at 0, 0.5 and 1 s while the target stays inside.
  function passiveMarks(u, a, x, t){
    if (u.c.champ!=="Kennen" || u.script || !x.alive) return;
    const P=CALC.champs.Kennen.P; if (!P || !P.dv || !P.dv.stunduration) return;
    const add=(tt)=>{ if (!x.alive || !u.alive) return; const k=x.kmark ||= {n:0, until:-1, last:-99};
      if (k.until<tt) k.n=0; k.n++; k.until=tt+(dvOf(P,"markduration",1)||6);
      if (k.n>=3){ k.n=0; const reduced = tt-k.last < (dvOf(P,"diminishingreturnduration",1)||6); k.last=tt;
        const dur = reduced ? dvOf(P,"reducedstunduration",1) : dvOf(P,"stunduration",1);
        say(tt, `  ${x.name}: 3 Marks of the Storm → stun${reduced?" (reduced: stunned by it within 6 s)":""}`);
        applyCC(u, {slot:"P", S:P, p:{}, cc:[{type:"stun", dur, src:{dur:"dv:StunDuration"}}], hard:true}, x, tt, 0);
        enGain(u, dvOf(P,"energyrestore",1)||25, tt, "Mark of the Storm stun"); } };   // game data EnergyRestore (item 24)
    add(t);
    if (a.slot==="R"){ const r=(a.p&&a.p.radius)||550; for (const dd of [0.5, 1]) events.push({at:t+dd, fn:(tt)=>{ if (gap(u,x)<=r+RAD(x)) add(tt); }}); }
    simNotes.add(`${u.name} P: Mark of the Storm — every ability hit marks the target; 3 marks stun it (1.25 s, 0.5 s again within 6 s; game data); R marks each target up to 3 times (0, 0.5, 1 s)`);
  }
  /* a crowd control that stops dashes lands on x (wiki Dash): a dash in progress (x.dashNow, from its start to its arrival) is
     stopped and its hits don't land; x halts where it is unless the effect displaces it (displaced: the knockback/pull moves it).
     x.dashStopAt records it for a dash starting in the same step (order-independence: the displacement wins, as before). */
  function dashStop(x, t, why, displaced){ x.dashStopAt=t; x.dashStopWhy=why; const D=x.dashNow;
    // a dash arriving on this very step has arrived: a displacement landing on the same step doesn't stop it, whichever of the two
    // events runs first (order-independence; P3: two Jarvan IV Q dashes landing together knocked up each other in array order)
    if (!D || D.stopped || t<D.t0-1e-9 || t>D.t1-1e-9) return false;
    D.stopped=true; if (!displaced && x.move && !x.move.forced) x.move=null;
    say(t, `  ${x.name}'s ${D.slot} dash is stopped (${why}; wiki Dash): it doesn't land`); return true; }
  // an unstoppable window starting at t: crowd control it resists that landed earlier in the same step doesn't apply either
  // (everything in a step is simultaneous), and a same-step displacement doesn't beat its dash
  function unstopClean(u, t){ const s=unstopOn(u,t); if (!s) return;
    const res = c => c.at>=t-1e-9 && (s.imm==="cc" || AIRBORNE.has(c.type) || c.type==="sleep");
    const mv = u.move && u.move.forced && u.move.t0>=t-1e-9;
    if (!u.ccs.some(res) && !mv && !(u.dashStopAt>=t-1e-9)) return;
    const gone=u.ccs.filter(res).map(c=>c.type); u.ccs=u.ccs.filter(c=>!res(c)); if (s.imm==="cc") u.slows=u.slows.filter(x=>!(x.t0>=t-1e-9));
    if (mv) u.move=null; u.dashStopAt=null; u.immobAt=null;
    if (u.interruptAt===t && !u.ccs.some(c=>c.at>=t-1e-9 && (LOCKS.includes(c.type) || c.type==="silence" || c.type==="polymorph"))) u.interruptAt=null;
    say(t, `  ${u.name} is ${s.imm==="cc"?"immune to crowd control":"displacement immune"} from this step (${s.slot}): ${gone.length?`the ${[...new Set(gone)].join(", ")} landing on it this step doesn't apply`:"the displacement landing on it this step doesn't apply"}`); }
  function applyCC(u, a, x, t, d0){
    if (!a.cc || !a.cc.length || !x.alive || inStasis(x,t)) return;
    // a crowd-control-immunity shield (Morgana E) is cast on the ally just as the hard CC lands (perfect play)
    if (a.hard && !ccImmune(x,t)) for (const y of alliesOf(x)){ if (y.passive || y.script || !canCast(y,t)) continue;
      for (const s of ["Q","W","E","R"]){ const b=y.abAll[s]; if (!b || !b.ccImmune || !b.shield || (y.cd[s]||0)>t) continue; const r=b.p&&b.p.range||0; if (y!==x && gap(y,x)>r+RAD(x)) continue;
        refresh(y,t); abNums(y,b); y.cd[s]=t+abCd(y,b); say(t, `  ${y.name} casts ${s} on ${x===y?"self":x.name} as ${u.name}'s ${a.slot} lands (perfect reaction)`);
        shield(y,x,b.shield,b.shieldDur,t,`${s}`); if (x.shields.length) x.shields[x.shields.length-1].ccImmune=true;
        simNotes.add(`${y.name} ${s}: the crowd-control-immunity shield is cast just as enemy hard CC lands on an ally in range (perfect reaction)`); break; }
      if (ccImmune(x,t)) break; }
    if (x.kit && x.kit.parry && x.kit.parry.until>t && a.cc.some(e=>["stun","root","knockup","knockback","pull","suppress","sleep","charm","fear","taunt","berserk"].includes(e.type))) x.kit.parry.hit=true;   // Fiora W parries an immobilizing effect
    if (ccImmune(x,t)){ say(t, `  ${x.name} ignores ${u.name}'s ${a.slot} crowd control (crowd control immunity${(unstopOn(x,t)||{}).imm==="cc"?`: ${x.name}'s ${x.unstop.slot}`:""})`); return; }
    const ten=x.st.tenacity||0, srcChamp=(u.pet && u.pet.owner ? u.pet.owner : u).c.champ, US=unstopOn(x,t);
    const knockdown = inTable(KNOCKDOWN, srcChamp, a.slot);
    for (const e of a.cc){
      // displacement immunity (UNSTOPPABLE; wiki Crowd control § Displacement Immunity): airborne, sleep, the special-cased
      // suppressions and the stun of the listed knock-up + stun abilities don't apply; other crowd control does, but can't stop the dash
      if (US && (AIRBORNE.has(e.type) || e.type==="sleep" || (e.type==="suppress" && inTable(DISP_SUPPRESS, srcChamp, a.slot)) || (e.type==="stun" && inTable(DISP_STUN, srcChamp, a.slot)))){
        say(t, `  ${x.name} ignores ${u.name}'s ${a.slot} ${e.type} (displacement immunity: ${x.name}'s ${US.slot})`); continue; }
      // a dash in progress (wiki Dash): stopped by a displacement or a knockdown; the dashes in DASH_CC_STOPS also by immobilizing CC
      if (!US && (AIRBORNE.has(e.type) || (knockdown && HARD_CC.has(e.type)))) dashStop(x, t, AIRBORNE.has(e.type) ? `${e.type==="knockup"?"knocked up":e.type==="pull"?"pulled":"knocked back"} by ${u.name}'s ${a.slot}` : `knocked down by ${u.name}'s ${a.slot}`, e.type==="knockback" || e.type==="pull");
      else if (!US && (LOCKS.includes(e.type) || e.type==="polymorph")){ x.immobAt=t; if (x.dashNow && x.dashNow.ccStops) dashStop(x, t, `${CC_VERB[e.type]||e.type} by ${u.name}'s ${a.slot}`, false); }
      let dur=e.dur;
      if (e.durMin!=null){ const r=Math.min(abReach(u,a,x), 5000)||1; dur=e.durMin+(e.dur-e.durMin)*Math.min(1, d0/r);
        simNotes.add(`${u.name} ${a.slot}: ${e.type} lasts ${fmt(e.durMin)}–${fmt(e.dur)}s growing with distance (wiki); assumed linear from 0 to the ability's reach`); }
      const eff=ccDuration({...e, dur}, ten), why = eff<dur-1e-9 ? ` (${fmt(dur)}s, −${fmt(100*ten)}% tenacity)` : "";
      if (e.type==="slow"){ x.slows.push({pct:e.pct, until:t+eff, t0:t, decay:e.decay, by:u});
        say(t, `  ${x.name} is slowed ${fmt(100*e.pct)}%${e.decay?" (decaying)":""}${x.st.slowresist?` × (1 − ${fmt(100*x.st.slowresist)}% slow resist)`:""} for ${fmt(eff)}s${why}: move speed ${fmt(msNow(x,t))}`); continue; }
      // cripple (champion audit batch 7, Malphite E): attack speed × (1 − strength) while it lasts; several multiply (wiki Cripple)
      if (e.type==="cripple"){ (x.cripples ||= []).push({pct:e.pct, until:t+eff}); refresh(x,t); say(t, `  ${x.name} is crippled ${fmt(100*e.pct)}% (attack speed) for ${fmt(eff)}s${why}`); continue; }
      if (e.type==="knockback" || e.type==="pull"){
        const away = x.x===u.x ? face(u) : Math.sign(x.x-u.x);
        let to, what;
        if (e.type==="pull"){ const g=gap(u,x), room=Math.max(0, g-RAD(u)-RAD(x)), by=e.dist ? Math.min(e.dist, room) : room; to=x.x-away*by; what=`pulled ${fmt(by)} units toward ${u.name}`; }
        else if (!e.dist){ to=x.x; what=`knocked aside (no distance in the data or the wiki; not displaced)`; }
        else { const placed = ["placed","lobbed","remote"].includes((a.p||{}).delivery);
          // a placed knockback's direction is chosen (perfect play): into the caster's team for role engage, otherwise away (peel)
          const dir = placed ? (roleOf(u)==="engage" && !a.peeling ? -face(u) : face(u)) : away;
          const push = e.mode==="to" ? Math.max(0, e.dist-gap(u,x)) : e.dist; to=x.x+dir*push;
          what=`knocked back ${fmt(push)} units${e.mode==="to"?` (to ${fmt(e.dist)} from ${u.name})`:""}${placed?(dir===face(u)?" away from "+u.name+"'s team":" toward "+u.name+"'s team"):" away from "+u.name}`; }
        x.ccs.push({type:e.type, until:t+e.dur, src:u, at:t}); displace(x, to, e.dur, t, true); interrupt(x,t);
        say(t, `  ${x.name} is ${what} over ${fmt(e.dur)}s (airborne; tenacity doesn't apply): ${fmt(gap(u,x))} → ${fmt(Math.abs(to-u.x))} units from ${u.name}`); continue; }
      x.ccs.push({type:e.type, until:t+eff, src:u, at:t});
      if (LOCKS.includes(e.type) || ["silence","polymorph"].includes(e.type)) interrupt(x,t,e.type==="silence");
      say(t, `  ${x.name} is ${CC_VERB[e.type]||e.type} for ${fmt(eff)}s${why}${NO_TENACITY.has(e.type)&&ten>0?" (tenacity doesn't apply)":""}`);
      if (e.type==="knockup" || e.type==="stun" || e.type==="suppress"){ x.impairedBy=u; x.impairedUntil=Math.max(x.impairedUntil, t+eff); }
    }
  }
  // charm, fear, taunt, berserk: the unit walks (and taunt/berserk attack) on its own
  function forcedAct(u,t){
    if (u.ccs.some(c=>ccLive(c,t) && ["stun","suppress","sleep","knockup","knockback","pull"].includes(c.type))) return;
    const c=u.ccs.find(c=>ccLive(c,t) && ["charm","fear","taunt","berserk"].includes(c.type)); if (!c || !c.src) return;
    if ((c.type==="taunt"||c.type==="berserk") && c.src.alive && t>=u.nextAA && gap(u,c.src)<=aaReach(u,c.src)){ autoAttack(u,c.src,t); return; }
    if (!(u.move && u.move.t1>t) && !ccOn(u,t,"root")) walk(u, c.type==="fear" ? u.x+(u.x===c.src.x?-face(u):Math.sign(u.x-c.src.x))*1000 : c.src.x, t, c.type==="fear"?`flees from ${c.src.name}`:`walks to ${c.src.name} (${c.type})`);
  }
  function pickTarget(u, foes, role, t){
    // pets (Ivern's Daisy): a pet attacks the nearest enemy champion (wiki Daisy "Target Acquisition"); champions prefer champions
    // and pick a pet only when no enemy champion is within their attack or ability reach
    if (u.pet){ const ch=foes.filter(x=>!x.pet); return (ch.length?ch:foes).slice().sort((a,b)=>gap(u,a)-gap(u,b))[0]; }
    if (foes.some(x=>x.pet)){ const ch=foes.filter(x=>!x.pet), pets=foes.filter(x=>x.pet);
      const rch = x => Math.max(aaReach(u,x), ...Object.values(u.ab).filter(a=>a.parts.length).map(a=>Math.min(abReach(u,a,x), 3000)));
      if (!ch.some(x=>gap(u,x)<=rch(x)) && pets.some(x=>gap(u,x)<=rch(x))) return pets.filter(x=>gap(u,x)<=rch(x)).sort((a,b)=>gap(u,a)-gap(u,b))[0];
      if (ch.length) foes=ch; }
    let tgt = u.target ? foes.find(x=>sameChamp(x,u.target)) : null;
    if (tgt) return tgt;
    if (role==="dive" || role==="engage") return foes.slice().sort((a,b)=>(a.hpS??a.hp)-(b.hpS??b.hp))[0];
    const reach = x => Math.max(aaReach(u,x), ...Object.values(u.ab).filter(a=>a.parts.length).map(a=>Math.min(abReach(u,a,x), 3000)));
    const near = foes.filter(x=>gap(u,x)<=reach(x));
    if (near.length) return near.sort((a,b)=>(a.hpS??a.hp)-(b.hpS??b.hp))[0];
    return foes.slice().sort((a,b)=>gap(u,a)-gap(u,b))[0];
  }
  function moveAI(u, tgt, role, t){
    if (!canMove(u,t)) return;
    if (role==="kite"){ const e=chaser(u,t);
      if (e){ walk(u, u.x-face(u)*1000, t, `kites back from ${e.name}`); return; }
      if (gap(u,tgt)>aaReach(u,tgt)){ walk(u, tgt.x-face(u)*(aaReach(u,tgt)-1), t, `walks toward ${tgt.name}`); return; }
      holdStill(u); return; }
    if (role==="peel"){ const th=threat(u,t);
      if (th && gap(u,th)>aaReach(u,th)){ walk(u, th.x, t, `walks to peel ${th.name}`); return; }
      if (!th){ const carries=alliesOf(u).filter(x=>x!==u && x.ranged); if (carries.length){ const back=carries.reduce((m,x)=>face(u)*x.x<face(u)*m.x?x:m); const post=back.x+face(u)*150;
          if (gap(u,tgt)<=aaReach(u,tgt)){ holdStill(u); return; }
          if (Math.abs(u.x-post)>5){ walk(u, post, t, `guards ${back.name}`); return; } holdStill(u); return; } } }
    if (gap(u,tgt)>aaReach(u,tgt)) walk(u, tgt.x-face(u)*(aaReach(u,tgt)-1), t, `walks toward ${tgt.name}`); else holdStill(u);
  }
  /* First Strike (wiki): hitting a champion within 0.25 s of entering champion combat grants 7% extra damage for 3 s;
     being struck first and not answering within 0.25 s puts it on full cooldown without the effect. */
  function enterCombat(u,t,isAtt){ if (u.combatAt==null) u.combatAt=t;
    if (!u.runes.has("firststrike")) return;
    if (!isAtt){ if (u.fsHitAt==null && u.fsUntil<t && ready(u,"firststrike",t)) u.fsHitAt=t; return; }
    if (u.fsHitAt!=null && t-u.fsHitAt>0.25+1e-9 && ready(u,"firststrike",u.fsHitAt)){ setcd(u,"firststrike",u.fsHitAt,lerpL(25,15,L(u))); say(t, `  ${u.name}: First Strike lost (struck first, no answer within 0.25s)`); }
    u.fsHitAt=null;
    if (ready(u,"firststrike",t) && u.fsUntil<t){ u.fsUntil=t+3; setcd(u,"firststrike",t,lerpL(25,15,L(u))); } }
  function adaptive(u){ return u.st.adaptiveType; }

  /* ---- live stats: buffs and stacks feed stats(c, mods) ---- */
  function addBuff(u, id, until, mods, t){ u.buffs=u.buffs.filter(b=>b.id!==id); u.buffs.push({id, until, mods}); refresh(u, t); }
  function refresh(u, t){
    const m={}; const r3=x=>Math.round(x*1000)/1000;
    const add=(k,v)=>{ if (v) m[k]=r3((m[k]||0)+v); };
    const pen=(k,v)=>{ if (v) m[k]=r3(1-(1-(m[k]||0))*(1-v)); };
    u.buffs=u.buffs.filter(b=>b.until>t);
    for (const b of u.buffs){ const f = b.decayFrom!=null ? Math.max(0, (b.until-t)/Math.max(1e-9, b.until-b.decayFrom)) : 1;   // decaying buffs (Akali W speed)
      for (const [k,v] of Object.entries(b.mods)) (k.endsWith("penpct")?pen:add)(k, f===1 ? v : Math.round(v*f*100)/100); }
    add("bonushp",u.perm.hp); add("glory",u.perm.glory); add("slay",u.perm.slay); add("yuncrit",u.perm.yun);
    if (has(u,"terminus")){ const T=u.term;
      if (T.light.until>t){ const per=itemCalc(u.base,"terminus","armrperhitscaling"); add("bonusarmor",per*T.light.n); add("bonusmr",per*T.light.n); }
      if (T.dark.until>t){ const p=idv("terminus","PenPerHit",0.1)*T.dark.n; pen("armorpenpct",p); pen("magicpenpct",p); } }
    if (has(u,"guinsoosrageblade") && u.rage.until>t) add("bonusAS", idv("guinsoosrageblade","AttackSpeedPerStack",0.08)*u.rage.n);
    if (has(u,"overlordsbloodmail")){ const miss=Math.max(0,1-u.hp/u.max), full=idv("overlordsbloodmail","MissingHealthThreshold",0.7);
      add("retribution", Math.round(idv("overlordsbloodmail","MissingHealthAD",0.12)*Math.min(1,miss/full)*1000)/1000); }
    if (has(u,"jakshotheprotean") && u.champCombatAt!=null && t-u.champCombatAt>=idv("jakshotheprotean","MaxStacks",5)) m.jaksho=1;
    if (has(u,"forceofnature") && u.fon.until>t && u.fon.n>=idv("forceofnature","MaxStacks",8)){ add("bonusmr",idv("forceofnature","BonusMagicResist",70)); add("mspct",idv("forceofnature","MoveSpeed",0.06)); }
    if (has(u,"blackfiretorch")){ const n=U.filter(x=>x.alive && x.side!==u.side && x.dots.some(d=>d.id==="blackfire" && d.u===u && d.until>=t)).length; add("apPct", idv("blackfiretorch","APPerStack",0.04)*n); }
    if (has(u,"immortalpath") && pct(u)<0.5){ add("healIn",idv("immortalpath","HealingMod",0.12)); add("shieldIn",idv("immortalpath","HealingMod",0.12)); }
    if (U.some(x=>x.alive && x.side!==u.side && has(x,"frozenheart"))) m.asMult=r3(1+idv("frozenheart","ASPDSlow",-0.2));
    if (u.cripples){ u.cripples=u.cripples.filter(c=>c.until>t); for (const c of u.cripples) m.asMult=r3((m.asMult||1)*(1-c.pct)); }   // cripples (Malphite E)
    // runes with in-fight stats (wiki Rune_data_*): Conqueror 1.08–2.56 AD or 1.8–4.26 AP per stack (wiki; AP = AD / 0.6), Absolute Focus
    // off below 70% health, Unflinching +10 armor/MR while crowd controlled and 2 s after, Nimbus Cloak decaying speed
    if (u.runes.has("conqueror") && u.conq.until>t && u.conq.n>0){ const per=lerpL(1.08,2.56,L(u))*u.conq.n; if (u.base.adaptiveType==="physical") add("bonusad",per); else add("ap",per/0.6); }
    if (u.runes.has("absolutefocus") && u.hp<0.7*u.max) m.afOff=1;
    if (u.runes.has("unflinching") && (u.ccs.some(c=>c.until>t-2) || u.slows.some(s=>s.until>t-2))){ add("bonusarmor",10); add("bonusmr",10); }
    if (u.nimbus && u.nimbus.until>t) add("mspct", Math.round(u.nimbus.pct*(u.nimbus.until-t)/2*100)/100);
    const key=JSON.stringify(m);
    if (key===u.modKey) return;
    u.modKey=key; const oldMax=u.max, oldAS=u.st.as; u.st=stats(u.c, Object.keys(m).length?m:null);
    u.max=u.st.hp; if (u.max>oldMax) u.hp+=u.max-oldMax; else u.hp=Math.min(u.hp,u.max);
    // attack speed changes mid-attack-timer rescale the time left
    if (u.nextAA>t && u.st.as!==oldAS) u.nextAA = t + (u.nextAA-t)*oldAS/u.st.as;
  }

  /* ---- shields ---- */
  const shieldLeft = (s,t) => Math.max(0, (s.decay ? s.amt*Math.max(0,(s.until-t)/(s.until-s.t0)) : s.amt) - s.used);
  function addShield(u, amt, dur, t, o={}){
    if (u.venom && u.venom.until>t) amt*=1-u.venom.pct;
    const s={amt, used:0, t0:t, until:t+dur, decay:!!o.decay, type:o.type||null, id:o.id||null}; u.shields.push(s);
    if (u.runes.has("shieldbash") && amt>0) u.sbash={amt, until:t+Math.min(dur,1e6)+2};   // Shield Bash: the next attack within 2 s after the shield ends
    return amt;
  }
  function absorb(tgt, v, type, t){
    let left=v;
    for (const s of tgt.shields){ if (s.until<t) continue; if (s.type && s.type!==type) continue; const cur=shieldLeft(s,t); if (cur<=0) continue; const a=Math.min(cur,left); s.used+=a; left-=a; if (left<=0) break; }
    return left;
  }
  // heal and shield given by src; item hooks for helping allies
  function heal(src, tgt, amt, t, what, isVamp, noHooks){
    if (healQueue){ healQueue.push([src, tgt, amt, t, what, isVamp, noHooks]); return 0; }   // heals from this tick's damage land after all of it
    if (!tgt.alive || amt<=0) return 0;
    let a = isVamp ? amt : amt*(1+src.st.healpower+(src.runes.has("revitalize")&&pct(tgt)<0.4?0.10:0)+actualizerAmp(src,t));
    a *= 1+tgt.st.healIn;
    if (t<tgt.grievUntil) a*=1-tgt.grievBy;
    const eff=Math.min(a, tgt.max-tgt.hp); tgt.hp+=eff;
    src.healDone+=eff; tgt.healRecv+=eff;
    if (what && eff>=1) say(t, `${src.name} heals ${tgt===src?"self":tgt.name} for ${fmt(eff)} (${what})${t<tgt.grievUntil?` [grievous wounds −${Math.round(tgt.grievBy*100)}%]`:""}`);
    if (isVamp==="lifesteal" && has(src,"bloodthirster") && a>eff){ const cap=itemCalc(src.st,"bloodthirster","overshieldcalc"); const ex=src.shields.find(s=>s.id==="ichor");
      const cur = ex ? shieldLeft(ex,t) : 0, add=Math.min(a-eff, cap-cur); if (add>0){ if (ex) ex.amt+=add; else addShield(src, add, 1e9, t, {id:"ichor"}); src.shieldDone+=add; } }
    if (!isVamp && what && !noHooks && src!==tgt) allyHelped(src, tgt, t, "heal", eff);
    return eff;
  }
  function shield(src, tgt, amt, dur, t, what, noHooks){
    if (!tgt.alive || amt<=0) return;
    const a=addShield(tgt, amt*(1+src.st.healpower+actualizerAmp(src,t))*(1+tgt.st.shieldIn), dur, t, {decay:/Locket/.test(what)});
    src.shieldDone+=a;
    say(t, `${src.name} shields ${tgt===src?"self":tgt.name} for ${fmt(a)} (${what}, ${fmt(dur)}s)`);
    if (src.runes.has("summonaery") && t>=src.aeryAt && tgt!==src){ const v=lerpL(20,100,L(src))+0.05*src.st.ap+0.1*src.st.bonusad; addShield(tgt,v,2.5,t); src.aeryAt=t+2; src.shieldDone+=v; }
    if (!noHooks && src!==tgt) allyHelped(src, tgt, t, "shield", a);
  }
  const actualizerAmp = (u,t) => has(u,"actualizer") && u.actUntil>t ? itemCalc(u.st,"actualizer","manacalc") : 0;
  function allyHelped(src, tgt, t, kind, amt){
    if (has(src,"moonstonerenewer")){ const other=alliesOf(src).filter(x=>x!==tgt && x!==src).sort((a,b)=>pct(a)-pct(b))[0];
      if (other){ if (kind==="heal"){ const e2=Math.min(amt*idv("moonstonerenewer","ChainHeal",0.3), other.max-other.hp); if (e2>0){ other.hp+=e2; src.healDone+=e2; other.healRecv+=e2; if(e2>=1) say(t, `  Moonstone chains ${fmt(e2)} healing to ${other.name}`); } }
        else { const v=addShield(other, amt*idv("moonstonerenewer","ChainShield",0.35), 2.5, t); src.shieldDone+=v; say(t, `  Moonstone chains a ${fmt(v)} shield to ${other.name}`); } } }
    if (has(src,"staffofflowingwater")) for (const x of [src,tgt]) addBuff(x, "flowingwater", t+idv("staffofflowingwater","BuffDuration",6), {ap:idv("staffofflowingwater","APMod",40), haste:idv("staffofflowingwater","AHMod",15)}, t);
    if (has(src,"ardentcenser")) for (const x of [src,tgt]){ addBuff(x, "ardent", t+idv("ardentcenser","Duration",6), {bonusAS:idv("ardentcenser","AttackSpeedMin",0.25)}, t); x.ardentUntil=t+idv("ardentcenser","Duration",6); x.ardentOnHit=idv("ardentcenser","OnHitMin",20); }
    if (has(src,"echoesofhelia") && src.echo>0){ const v=src.echo; src.echo=0; heal(src, tgt, v, t, "Echoes of Helia", false, true); }
    if (has(src,"dreammaker") && t>=src.bubbles.ready){ src.bubbles.ready=t+idv("dreammaker","Cooldown",8);
      tgt.blue={until:t+idv("dreammaker","BubbleDuration",3), amt:itemCalc(src.st,"dreammaker","flatdr")}; tgt.purple={until:t+idv("dreammaker","BubbleDuration",3), amt:itemCalc(src.st,"dreammaker","procdmg"), by:src};
      say(t, `  Dream Maker bubbles on ${tgt.name}`); }
  }

  /* ---- damage ---- */
  const isAbility = kind => kind==="ability" || kind==="abilitydot";
  function kill(tgt, att, t){
    if (tgt.pet){ tgt.alive=false; tgt.deathAt=t; tgt.hp=0; say(t, `☠ ${tgt.name} dies${att?` (killed by ${att.name})`:""}`); return; }   // a pet's death is no champion takedown
    // Zilean's Chronoshift rune (champion audit batch 7; wiki Zilean_R: priority over every other resurrection): 3 s of stasis, then the heal
    if (tgt.zilRune && tgt.zilRune.until>t){ const Z=tgt.zilRune; tgt.zilRune=null; tgt.hp=1; tgt.stasisUntil=Math.max(tgt.stasisUntil, t+Z.dur); cancelCasts(tgt, t, "revives");
      events.push({at:t+Z.dur, fn:(tt)=>{ if (tgt.alive) heal(Z.by, tgt, Z.v, tt, "R Chronoshift"); }}); say(t, `${tgt.name} would die: Chronoshift — ${fmt(Z.dur)} s of stasis, then a ${fmt(Z.v)} heal`); return; }
    if (has(tgt,"guardianangel") && !tgt.gaUsed){ tgt.gaUsed=true; tgt.hp=1; tgt.stasisUntil=t+4; tgt.reviveAt=t+4; say(t, `${tgt.name} would die: Guardian Angel revives in 4s`); return; }
    { const km=CHAMP_MECH[tgt.c.champ]; if (km && km.onFatal && km.onFatal(tgt, att, t)) return; }   // champion kits: Anivia's Rebirth (after Guardian Angel: wiki)
    tgt.alive=false; tgt.deathAt=t; tgt.hp=0; say(t, `☠ ${tgt.name} dies${att?` (killed by ${att.name})`:""}`);
    cancelCasts(tgt, t, "dies");
    if (att && att.alive){
      // Absorb Life (wiki): killing heals 1, +0.25 per level to 5, +1 per level to 10, then +2 per level (23 at 18)
      if (att.runes.has("absorblife")){ const l=L(att); heal(att, att, l<=5 ? 1+0.25*(l-1) : l<=10 ? 2+(l-5) : 7+2*(l-10), t, "Absorb Life"); }
    }
    // takedowns: everyone who damaged the victim in the last 3 seconds
    const window = 3;
    const part = [...tgt.dmgBy].filter(([x,tt])=>x.side!==tgt.side && t-tt<=window).map(([x])=>x);
    if (att && att.side!==tgt.side && !part.includes(att)) part.push(att);
    for (const p of part){
      const killer = p===att;
      { const km=CHAMP_MECH[p.c.champ]; if (km && km.onTakedown && p.alive) km.onTakedown(p, tgt, t); }   // champion kits: takedown resets
      // takedown runes (wiki): Triumph heals 2.5% max + 5% missing health after 1 s; Dark Harvest cooldown resets to 1 s;
      // Axiom Arcanist −7% of R's current cooldown; Transcendence (level 11+) −20% of basic abilities' current cooldowns
      if (p.alive && p.runes.has("triumph")) events.push({at:t+1, fn:(tt)=>{ if (p.alive) heal(p, p, 0.05*(p.max-p.hp)+0.025*p.max, tt, "Triumph"); }});
      if (p.runes.has("darkharvest")) p.rcd.darkharvest=Math.min(p.rcd.darkharvest||0, t+1);
      if (p.runes.has("axiomarcanist") && (p.cd.R||0)>t){ p.cd.R=t+(p.cd.R-t)*0.93; say(t, `  ${p.name}: Axiom Arcanist −7% of R's cooldown`); }
      if (p.runes.has("transcendence") && L(p)>=11) for (const s of ["Q","W","E"]) if ((p.cd[s]||0)>t) p.cd[s]=t+(p.cd[s]-t)*0.8;
      if (has(p,"cryptbloom") && p.alive && ready(p,"cryptbloom",t)){ setcd(p,"cryptbloom",t,idv("cryptbloom","Cooldown",60)); const v=itemCalc(p.st,"cryptbloom","totalhealamount"); for (const x of alliesOf(p)) heal(p,x,v,t,"Cryptbloom"); }
      if (has(p,"axiomarc") && p.abAll.R){ const cut=itemCalc(p.st,"axiomarc","ultimaterefund")/100*abCd(p,p.abAll.R); if ((p.cd.R||0)>t){ p.cd.R=Math.max(t,p.cd.R-cut); say(t, `  ${p.name}: Axiom Arc refunds ${fmt(cut)}s of R`); } }
      if (has(p,"hubris")){ p.hubris++; addBuff(p,"hubris",t+idv("hubris","BuffDuration",90),{bonusad:idv("hubris","BaseADBonus",12)+idv("hubris","ADPerStatue",3)*p.hubris},t); say(t, `  ${p.name}: Hubris +${fmt(idv("hubris","BaseADBonus",12)+3*p.hubris)} AD`); }
      if (has(p,"endlesshunger")) addBuff(p,"feast",t+idv("endlesshunger","OmnivampDuration",8),{omnivamp:idv("endlesshunger","OmnivampOnTakedown",0.15)},t);
      for (const k of ["gluttonousgreaves","immortalpath"]) if (has(p,k)){ const stk=Number(((p.c.opts||{}).stacks||{})[k])||0; if (stk+p.perm.slay<idv(k,"MaxStacks",10)){ p.perm.slay++; refresh(p,t); } break; }
      for (const k of ["mejaissoulstealer","darkseal"]) if (has(p,k)){ p.perm.glory += killer ? idv(k,"GloryOnKill",2) : idv(k,"GloryOnAssist",1); refresh(p,t); break; }
      if (has(p,"hollowradiance") && p.alive){ const v=itemCalc(p.st,"hollowradiance","damagepertick")*idv("hollowradiance","ChampProcDPSMultiplier",4); for (const x of enemiesOf(p,t)) deal(p,x,v,"magic",t,"proc","Hollow Radiance eruption"); }
      if (has(p,"deathsdance") && p.alive){ p.dd=[]; const v=itemCalc(p.st,"deathsdance","healtotal"); for (let i=1;i<=4;i++) events.push({at:t+0.5*i, fn:(tt)=>heal(p,p,v/4,tt,i===1?"Death's Dance (Defy)":null)}); say(t, `  ${p.name}: Death's Dance cleanses stored damage`); }
      if (p.squall && p.squall.tgt===tgt){ const s=p.squall; p.squall=null; for (const x of enemiesOf(p,t)) deal(p,x,s.dmg,"magic",t,"proc","Stormsurge field"); }
    }
  }
  function deal(att, tgt, raw, type, t, kind, what, o={}){
    if (dmgQueue && att.side!==tgt.side){ dmgQueue.push([att, tgt, raw, type, t, kind, what, o]);
      if (att.kit && att.kit.hit && kind==="ability" && tgt.alive && !inStasis(tgt,t) && raw>0) att.kit.hit.add(tgt);   // kits that collect a cast's targets (Annie, …) see the hit now
      return 0; }   // resolved after everyone has acted this tick
    if (!tgt.alive || inStasis(tgt,t) || raw<=0) return 0;
    if (att.side!==tgt.side && invulnTo(att, tgt, t)){ say(t, `  ${tgt.name} is invulnerable: ${att.name}'s ${what||kind} deals no damage`); return 0; }   // P3
    // practice-tool dummy: after 3 s without damage it restores to full health and resets its damage tracking (wiki Practice Tool § Dummy)
    if (tgt.dummy && tgt.hp<tgt.max && t-tgt.lastHurtAt>=DUMMY_RESET-1e-9){ tgt.hp=tgt.max; tgt.dummyTaken=0; say(t, `${tgt.name} resets to full health (no damage for ${DUMMY_RESET}s)`); }
    if (kind!=="dot" && kind!=="abilitydot"){ enterCombat(att,t,true); enterCombat(tgt,t,false); }
    if (att.champCombatAt==null) att.champCombatAt=t; if (tgt.champCombatAt==null) tgt.champCombatAt=t;
    const hp0=pct(tgt);
    // Cheap Shot needs the target impaired before this hit lands (wiki): note it now, before this ability's own CC
    if (att.runes.has("cheapshot") && (kind==="aa" || kind==="ability")) att.csPre={tgt, t, ok:cheapShotImpaired(tgt,t)};
    let amp=1;
    if (!o.redirect){
      if (att.runes.has("laststand")){ const p=pct(att); if (p<0.6) amp*=1+(p<=0.3?0.11:0.05+0.06*(0.6-p)/0.3); }
      if (att.runes.has("coupdegrace") && hp0<0.4) amp*=1.08;
      if (att.runes.has("cutdown") && hp0>0.6) amp*=1.08;
      if (t<=att.fsUntil) amp*=1.07;
      if (att.ptaOn.has(tgt)) amp*=1.08;
      const inC = att.champCombatAt==null ? 0 : t-att.champCombatAt;
      if (has(att,"liandrystorment")) amp*=1+Math.min(idv("liandrystorment","DamageIncreaseMax",0.06), idv("liandrystorment","DamageIncreasePerSecond",0.02)*Math.floor(inC));
      else if (has(att,"hauntingguise")) amp*=1+Math.min(idv("hauntingguise","DamageIncreaseMax",0.06), idv("hauntingguise","DamageIncreasePerSecond",0.02)*Math.floor(inC));
      if (has(att,"riftmaker")) amp*=1+Math.min(idv("riftmaker","EternityDamageIncreaseMax",0.08), idv("riftmaker","EternityDamageIncreasePerSecond",0.02)*Math.floor(inC));
      if (has(att,"immortalpath") && pct(att)>0.5) amp*=1+idv("immortalpath","DamageMod",0.04);
      if (has(att,"shadowflame") && type!=="physical" && hp0<idv("shadowflame","HealthThreshold",0.4)) amp*=1+idv("shadowflame",kind==="dot"||kind==="abilitydot"?"DamageOverTimeAmp":"SpellItemDamageAmp",0.2);
      if (has(att,"lorddominiksregards")) amp*=1+idv("lorddominiksregards","MaxBonusDamagePercent",0.15)*Math.min(1, Math.max(0,tgt.st.bonushp)/idv("lorddominiksregards","MaxBonusHealth",1500));
      if (has(att,"spearofshojin") && (isAbility(kind)||kind==="passive") && att.shojin.until>t) amp*=1+att.shojin.n*itemCalc(att.st,"spearofshojin","meleeitemcalcvalue")/100*(att.ranged?0.5:1);
      if (tgt.marks[att.name] && tgt.marks[att.name]>t) amp*=1+idv("horizonfocus","DamageAmp",0.1);
      if (kind==="aa" && has(att,"hexopticsc44")) amp*=1+Math.min(idv("hexopticsc44","MaxDamageAmp",0.1), 0.01*att.st.range/50);
      if (isAbility(kind) && has(att,"actualizer") && att.actUntil>t) amp*=1+actualizerAmp(att,t);
      if (type==="magic" && U.some(x=>x.alive && x.side===att.side && has(x,"abyssalmask"))) amp*=1+idv("abyssalmask","DamageAmp",0.12);
      if (att.runes.has("celestialbody") && GAME.minute<10) amp*=0.9;
      if (att.exhaust && t<att.exhaust.until) amp*=1-att.exhaust.dr;      // Exhaust: damage dealt −35% (game files DamageReduction; wiki)
      if (att.glacial && t<att.glacial.until && tgt.side===att.glacial.by.side && tgt!==att.glacial.by) amp*=0.85;   // Glacial Augment: −15% vs the user's allies, not the user (wiki)
    }
    let v=raw*amp; const pre=v;
    // Knight's Vow: the holder takes 14% of the Worthy ally's physical and magic damage (pre-mitigation)
    if (!o.redirect && type!=="true" && tgt.vowBy && tgt.vowBy.alive && pct(tgt.vowBy)>idv("knightsvow","DamageRedirectionThreshold",0.3)){
      const red=v*idv("knightsvow","DamageRedirection",0.14); v-=red; deal(att, tgt.vowBy, red, type, t, kind, null, {redirect:true}); }
    // Celestial Opposition: less champion damage while Blessed (pre-mitigation)
    if (has(tgt,"celestialopposition")){ const co=tgt.co ||= {until:-1, cdAt:-1}, cd=idv("celestialopposition","Cooldown",18), red=1-(tgt.ranged?idv("celestialopposition","RangedShieldDRPercentage",0.25):idv("celestialopposition","MeleeShieldDRPercentage",0.35));
      if (t<=co.until) v*=red;                                                  // Blessed, lingering 2s after the first hit
      else if (t>=co.cdAt){ co.until=t+idv("celestialopposition","ShieldLingerAfterInitiallyPopped",2); co.cdAt=co.until+cd; v*=red; }
      else co.cdAt=Math.max(co.cdAt, t+cd); }                                  // the cooldown restarts on champion damage
    if (type!=="true"){
      const magic = type==="magic";
      let R = magic ? tgt.st.mr : tgt.st.armor;
      // resistance reduction: flat first, then percentage; then the attacker's percentage and flat penetration
      if (magic && tgt.malig && tgt.malig.until>=t) R-=tgt.malig.mr;
      if (tgt.kitShred) for (const k in tgt.kitShred){ const s=tgt.kitShred[k], f=magic ? s.mrFlat : s.flat; if (s.until>t && f) R-=f; }   // flat armor reduction (Rengar R), flat magic resist (mrFlat: Corki E)
      if (tgt.rellMold && tgt.rellMold.until>t && R>0) R-=tgt.rellMold.n*Math.max(0.03*R, tgt.rellMold.floor);   // Rell, Break the Mold: −3% per stack (at least 1.5–3 per stack by level)
      if (!magic && t<tgt.cleaver.until) R*=1-idv("blackcleaver","ShredPerStack",0.06)*tgt.cleaver.n;
      if (!magic && tgt.olafQ && tgt.olafQ.until>t) R*=1-tgt.olafQ.pct;   // Olaf Q, Undertow: −20% armor for 4 s
      if (tgt.kitShred) for (const k in tgt.kitShred){ const s=tgt.kitShred[k], p=magic ? s.mrPct : s.pct; if (s.until>t && p) R*=1-p; }   // % armor reduction (Jarvan IV Q, Nasus E), % magic resist (mrPct: Karthus W)
      if (magic && tgt.bloodlet.until>t) R*=1-idv("bloodletterscurse","ShredPerStack",0.075)*tgt.bloodlet.n;
      if (magic && tgt.zoeSleep && t>=tgt.zoeSleep.from && t<tgt.zoeSleep.sleepEnd) R*=1-tgt.zoeSleep.pen;   // Zoe E: −30% magic resist while asleep
      if (t<tgt.after.until) R+= magic ? tgt.after.mr : tgt.after.armor;
      const p=magic?att.st.magicpenpct:att.st.armorpenpct, f=magic?att.st.magicpen:att.st.lethality+att.st.armorpen;
      let r=R>0 ? R*(1-p) : R; r = R>0 ? Math.max(0,r-f) : r;
      v *= r>=0 ? 100/(100+r) : 2-100/(100-r);
    }
    // damage taken modifiers (post-mitigation, from all sources)
    if (tgt.expose && tgt.expose.until>t) v*=1+tgt.expose.amp;
    if (tgt.vuln && tgt.vuln.until>t) v*=1+idv("imperialmandate","DamageAmp",0.07);
    if (tgt.kit && tgt.kit.rDR && tgt.kit.rDR.until>t) v*=1-tgt.kit.rDR.dr;   // Alistar R, Unbreakable Will: damage taken reduced (post-mitigation)
    if (kind==="aa"){
      if (has(tgt,"platedsteelcaps")||has(tgt,"armoredadvance")) v*=0.9;   // Plating: item text, 10%
      if (has(tgt,"wardensmail")) v-=Math.min(idv("wardensmail","BlockBase",15), idv("wardensmail","WardenDamageMax",0.2)*v);
    }
    if (tgt.blue && tgt.blue.until>t && (kind==="aa"||kind==="ability")){ v=Math.max(0, v-tgt.blue.amt); tgt.blue=null; }
    if (tgt.plating && tgt.plating.from===att && tgt.plating.n>0 && t<tgt.plating.until){ v=Math.max(0, v-tgt.plating.amt); tgt.plating.n--; }
    else if (tgt.runes.has("boneplating") && ready(tgt,"boneplating",t) && kind!=="dot"){ tgt.plating={from:att, n:3, until:t+1.5, amt:lerpL(30,60,L(tgt))}; setcd(tgt,"boneplating",t,55); }
    { const k1=CHAMP_MECH[tgt.c.champ], k2=CHAMP_MECH[att.c.champ];   // champion kits: damage taken / dealt (Yasuo shield, Zed and Yone marks)
      if (k1 && k1.onHurt && !o.redirect) k1.onHurt(tgt, att, v, type, t, kind); if (k2 && k2.onDealt && !o.redirect) k2.onDealt(att, tgt, v, pre, type, t, kind); }
    if (tgt.sunlight && !o.redirect) kitSunlight(att, tgt, t, kind);   // Leona's Sunlight mark
    if (tgt.zoeSleep && !o.redirect) kitZoeWake(att, tgt, v, t, kind);   // Zoe E: the hit that wakes the target
    // Death's Dance: part of physical and magic damage is stored and taken later as true damage
    if (has(tgt,"deathsdance") && (type==="physical"||type==="magic") && !o.bleed){ const s=v*itemCalc(tgt.st,"deathsdance",tgt.ranged?"rangeditemcalcvalue":"meleeitemcalcvalue");
      if (s>0){ v-=s; const e={amt:s, by:att}; tgt.dd.push(e); for (let i=1;i<=3;i++) events.push({at:t+i, fn:(tt)=>{ if (tgt.dd.includes(e)) deal(e.by,tgt,e.amt/3,"true",tt,"dot",null,{bleed:true}); if (i===3) tgt.dd=tgt.dd.filter(x=>x!==e); }}); } }
    let left=absorb(tgt, v, type, t);
    // Lifeline items: damage that would take you below 30% grants the shield first
    if (tgt.hp-left < 0.3*tgt.max && left>0) lifeline(tgt, t, type);
    left=absorb(tgt, left, type, t);
    tgt.hp-=left; att.dealt+=v; tgt.taken+=v; att.lastDmgAt=t; tgt.dmgIn.push({t, v}); att.hitOnce=true; tgt.dmgBy.set(att, t);
    tgt.lastHurtAt=t; if (type==="magic") tgt.lastMagicAt=t;
    if (tgt.annulAt!==undefined && tgt.annulAt>t){ const k=["bansheesveil","edgeofnight","verdantbarrier"].find(k=>has(tgt,k)); if (k) tgt.annulAt=t+idv(k,"Cooldown",40); }
    for (const x of [att, tgt]){ if (x.immUntil<t) x.immOn=t; x.immUntil=Math.max(x.immUntil,t+3); }
    if (what && v>=1) say(t, `${att.name} → ${tgt.name}: ${fmt(v)} ${type} (${what})`);
    // healing from damage
    const ls = (kind==="aa" || (kind==="onhit" && o.ls) || o.lifesteal) ? v*att.st.lifesteal : 0;
    let vh = v*(att.st.omnivamp + att.vamp) + (type==="physical" ? v*att.st.physvamp : 0);
    if (att.runes.has("conqueror") && att.conq.n>=12 && t<att.conq.until) vh += v*(att.ranged?0.05:0.08);
    if (has(att,"riftmaker") && att.champCombatAt!=null && t-att.champCombatAt>=idv("riftmaker","SecondsInCombat",4)) vh += v*itemCalc(att.st,"riftmaker",att.ranged?"rangeditemcalcvalue":"meleeitemcalcvalue");
    if (vh>0) heal(att, att, vh, t, null, true);
    if (ls>0) heal(att, att, ls, t, null, "lifesteal");
    if (has(att,"echoesofhelia")) att.echo=Math.min(itemCalc(att.st,"echoesofhelia","maxcharges"), att.echo+idv("echoesofhelia","DamageStorageRate",0.3)*pre);
    // Knight's Vow: the holder heals from the Worthy ally's champion damage
    if (att.vowBy && att.vowBy.alive) heal(att.vowBy, att.vowBy, v*idv("knightsvow","AllyHealingConversion",0.12), t, null, true);
    // debuffs
    const griev = (by, k) => { tgt.grievUntil=t+idv(k,"GrievousDuration",3); tgt.grievBy=Math.max(t<tgt.grievUntil?tgt.grievBy:0, idv(k,"GrievousAmount",0.4)); };
    if (type==="magic") for (const k of ["morellonomicon","oblivionorb"]) if (has(att,k)){ griev(att,k); break; }
    if (type==="physical") for (const k of ["mortalreminder","chempunkchainsword","executionerscalling"]) if (has(att,k)){ griev(att,k); break; }
    if (has(att,"blackcleaver") && type==="physical"){ tgt.cleaver.n=Math.min(idv("blackcleaver","MaxStacks",5),(t<tgt.cleaver.until?tgt.cleaver.n:0)+1); tgt.cleaver.until=t+idv("blackcleaver","DebuffDuration",6); }
    if (has(att,"bloodletterscurse") && type==="magic" && (isAbility(kind)||kind==="passive") && t>=tgt.bloodlet.at){ const b=tgt.bloodlet; b.n=Math.min(idv("bloodletterscurse","MaxStacks",4),(b.until>t?b.n:0)+1); b.until=t+idv("bloodletterscurse","DebuffDuration",6); b.at=t+idv("bloodletterscurse","InternalCD",0.3); }
    if (has(att,"serpentsfang")){ const shred=idv("serpentsfang",att.ranged?"ShieldShredRange":"ShieldShred",50)/100, wounds=idv("serpentsfang",att.ranged?"ShieldWoundsRange":"ShieldWounds",50)/100;
      if (!(tgt.venom && tgt.venom.until>t)) for (const s of tgt.shields) s.used += shieldLeft(s,t)*shred;
      tgt.venom={until:t+idv("serpentsfang","DebuffDuration",3), pct:wounds}; }
    if (has(tgt,"forceofnature") && type==="magic" && !(tgt.fon.last[att.name]>t)){ tgt.fon.last[att.name]=t+idv("forceofnature","StackRefreshTimer",1); tgt.fon.n=Math.min(idv("forceofnature","MaxStacks",8),(tgt.fon.until>t?tgt.fon.n:0)+1); tgt.fon.until=t+idv("forceofnature","BuffDuration",7); }
    if (has(tgt,"chainlacedcrushers") && type==="magic" && ready(tgt,"crushers",t)){ setcd(tgt,"crushers",t,idv("chainlacedcrushers","Cooldown",15)); const s=addShield(tgt,itemCalc(tgt.st,"chainlacedcrushers","shieldamountcalc"),idv("chainlacedcrushers","ShieldDuration",5),t,{type:"magic"}); say(t, `${tgt.name}: Chainlaced Crushers magic shield ${fmt(s)}`); }
    if (has(tgt,"armoredadvance") && type==="physical" && ready(tgt,"advance",t)){ setcd(tgt,"advance",t,idv("armoredadvance","Cooldown",15)); const s=addShield(tgt,itemCalc(tgt.st,"armoredadvance","shieldamountcalc"),idv("armoredadvance","ShieldDuration",5),t,{type:"physical"}); say(t, `${tgt.name}: Armored Advance physical shield ${fmt(s)}`); }
    if (has(tgt,"doransshield")) tgt.doranUntil=t+idv("doransshield","RegenDuration",8), tgt.doranArea = kind!=="aa";
    // Stormsurge: 25% of the target's max health within 2.5s
    if (has(att,"stormsurge") && ready(att,"stormsurge",t) && !o.redirect){ const w=(att.ssWin[tgt.name]||[]).filter(x=>x.t>t-idv("stormsurge","WindowDuration",2.5)); w.push({t,v}); att.ssWin[tgt.name]=w;
      if (w.reduce((s,x)=>s+x.v,0) >= idv("stormsurge","DamageThreshold",0.25)*tgt.max){ setcd(att,"stormsurge",t,idv("stormsurge","Cooldown",30)); const dmg=itemCalc(att.st,"stormsurge","squalldamage"); att.squall={tgt,dmg};
        events.push({at:t+idv("stormsurge","DelayDuration",2), fn:(tt)=>{ if (att.squall && att.squall.tgt===tgt){ att.squall=null; deal(att,tgt,dmg,"magic",tt,"proc","Stormsurge"); } }}); } }
    // Stormraider's Surge (wiki): 25% of the target's max health (post-mitigation) within 3 s → 48% move speed (36% ranged) and 50% slow resist for 4 s
    if (att.runes.has("stormraiderssurge") && ready(att,"stormraider",t) && !o.redirect){ const w=((att.srWin||={})[tgt.name]||[]).filter(x=>x.t>t-3); w.push({t,v}); att.srWin[tgt.name]=w;
      if (w.reduce((s,x)=>s+x.v,0) >= 0.25*tgt.max){ setcd(att,"stormraider",t,lerpL(20,10,L(att))); att.srWin={}; addBuff(att,"stormraider",t+4,{mspct:att.ranged?0.36:0.48, slowres:0.5},t); say(t, `  ${att.name}: Stormraider's Surge (+${att.ranged?36:48}% move speed, 50% slow resist for 4s)`); } }
    // damaging a champion: item procs with their own cooldowns
    if (!o.redirect && kind!=="reflect"){
      if (has(att,"hextechalternator") && ready(att,"alternator",t)){ setcd(att,"alternator",t,idv("hextechalternator","Cooldown",40)); deal(att,tgt,itemCalc(att.st,"hextechalternator","damageamount"),"magic",t,"proc","Hextech Alternator"); }
      if (has(att,"scoutsslingshot") && ready(att,"slingshot",t)){ setcd(att,"slingshot",t,idv("scoutsslingshot","Cooldown",40)); deal(att,tgt,itemCalc(att.st,"scoutsslingshot","damageamount"),"magic",t,"proc","Scout's Slingshot"); }
      if (has(att,"elixirofsorcery") && ready(att,"sorcery:"+tgt.name,t)){ setcd(att,"sorcery:"+tgt.name,t,5); deal(att,tgt,25,"true",t,"proc","Elixir of Sorcery"); }
    }
    // Guardian rune: allies of the target shield it
    // wiki Rune_data_Guardian: the user or an ally within 350 taking 50–165 damage within 2.5 s, or lethal damage, shields both
    // for 40–150 (+20% AP) (+6% bonus health) for 2 s (wiki patch history: 2 s since V10.18; the client text still says 1.5 s)
    for (const g of alliesOf(tgt)) if (g.runes.has("guardian") && ready(g,"guardian",t) && (g===tgt || gap(g,tgt)<=350) && !o.redirect){
      const took=tgt.dmgIn.filter(d=>d.t>t-2.5).reduce((s,d)=>s+d.v,0);
      if (took < lerpL(50,165,L(g)) && tgt.hp>0) continue;
      const s=lerpL(40,150,L(g))+0.2*g.st.ap+0.06*g.st.bonushp; setcd(g,"guardian",t,lerpL(75,40,L(g)));
      for (const x of g===tgt ? [g] : [tgt, g]) shield(g,x,s,2,t,"Guardian",true);
      if (tgt.hp<=0){ const sh=tgt.shields[tgt.shields.length-1]; const back=Math.min(sh?shieldLeft(sh,t):0, left); if (back>0){ sh.used+=back; tgt.hp+=back; say(t, `  Guardian's shield absorbs ${fmt(back)} of the lethal hit on ${tgt.name}`); } }
      break; }
    if (att.hits.length<2000) att.hits.push({t, v, type, what:what||kind, kind, tgt:tgt.name, step: att.curStep ?? (kind==="dot"||kind==="abilitydot" || !att.script ? null : att.stepLog.length)});
    // practice-tool dummy: can't die or go below 1 health; it takes at most (max health − 1) (wiki). wouldDieAt = when a champion with these stats dies.
    if (tgt.dummy){ tgt.dummyTaken+=left; if (tgt.dummyTaken>=tgt.max && tgt.wouldDieAt==null){ tgt.wouldDieAt=t; say(t, `${tgt.name}: ${fmt(tgt.dummyTaken)} damage taken ≥ ${fmt(tgt.max)} health (a champion would die here; the dummy stays at 1)`); } if (tgt.hp<1) tgt.hp=1; return v; }
    if (tgt.hp<=0){ if (inTick){ if (!pendingKills.some(k=>k.tgt===tgt)) pendingKills.push({tgt, att}); } else kill(tgt, att, t); }
    else if (has(att,"thecollector") && pct(tgt)<idv("thecollector","ExecuteThreshold",0.05) && !o.redirect){ say(t, `${att.name} executes ${tgt.name} (The Collector)`); tgt.hp=0; if (inTick){ if (!pendingKills.some(k=>k.tgt===tgt)) pendingKills.push({tgt, att}); } else kill(tgt, att, t); }
    return v;
  }
  function lifeline(u, t, type){
    const ready_ = k => ready(u,"lifeline:"+k,t), cd = (k,s) => setcd(u,"lifeline:"+k,t,s);
    if (has(u,"steraksgage") && ready_("sterak")){ cd("sterak",idv("steraksgage","Cooldown",90)); const v=addShield(u,itemCalc(u.st,"steraksgage","shieldsize"),idv("steraksgage","ShieldDuration",4.5),t,{decay:true}); say(t, `${u.name}: Sterak's Gage shield ${fmt(v)} (decays over 4.5s)`); return; }
    if (has(u,"immortalshieldbow") && ready_("shieldbow")){ cd("shieldbow",idv("immortalshieldbow","Cooldown",90)); const v=addShield(u,itemCalc(u.st,"immortalshieldbow","shieldamount"),idv("immortalshieldbow","ShieldDuration",3),t); say(t, `${u.name}: Immortal Shieldbow shield ${fmt(v)}`); return; }
    if (has(u,"mawofmalmortius") && type==="magic" && ready_("maw")){ cd("maw",idv("mawofmalmortius","Cooldown",90)); const v=addShield(u,itemCalc(u.st,"mawofmalmortius",u.ranged?"rangeditemcalcvalue":"meleeitemcalcvalue"),idv("mawofmalmortius","ShieldDuration",3),t,{type:"magic"});
      addBuff(u,"maw",Infinity,{omnivamp:idv("mawofmalmortius","BuffVamp",0.1)},t); say(t, `${u.name}: Maw of Malmortius magic shield ${fmt(v)}, +10% omnivamp`); return; }
    if (has(u,"hexdrinker") && type==="magic" && ready_("hexdrinker")){ cd("hexdrinker",idv("hexdrinker","Cooldown",90)); const v=addShield(u,itemCalc(u.st,"hexdrinker",u.ranged?"rangeditemcalcvalue":"meleeitemcalcvalue"),idv("hexdrinker","ShieldLifetime",2.5),t,{type:"magic"}); say(t, `${u.name}: Hexdrinker magic shield ${fmt(v)}`); return; }
    if (has(u,"protoplasmharness") && ready_("protoplasm")){ cd("protoplasm",idv("protoplasmharness","Cooldown",90)); const dur=idv("protoplasmharness","Duration",5);
      addBuff(u,"protoplasm",t+dur,{bonushp:itemCalc(u.st,"protoplasmharness","maxhealthgain")},t); const h=itemCalc(u.st,"protoplasmharness","totalhealthregen");
      for (let i=1;i<=dur*2;i++) events.push({at:t+0.5*i, fn:(tt)=>heal(u,u,h/(dur*2),tt,i===1?"Protoplasm Harness":null)}); say(t, `${u.name}: Protoplasm Harness Lifeline`); }
  }
  function addDot(u,tgt,t,id,what,dps,dur,rampAfter,type){
    const ex=tgt.dots.find(d=>d.id===id && d.u===u);
    if (ex){ ex.until=t+dur; ex.dps=dps; return; }
    tgt.dots.push({id,u,what,dps,until:t+dur,start:t,next:t+0.5,rampAfter,type:type||"magic"});
  }
  // effects on every separate attack or ability hit (runes, Eclipse)
  function onHit(u, tgt, t, kind, a){
    if (!tgt.alive) return;
    const ad=adaptive(u);
    u.elec=u.elec.filter(x=>x>t-3); u.elec.push(t);
    // Electrocute (wiki): 3 separate hits on the same champion within 3 s; the lightning strikes 0.25 s later
    { const w=((u.elecT||={})[tgt.name]||[]).filter(x=>x>t-3); w.push(t); u.elecT[tgt.name]=w;
      if (u.runes.has("electrocute") && w.length>=3 && ready(u,"electrocute",t)){ setcd(u,"electrocute",t,20); u.elecT[tgt.name]=[]; const v=lerpL(70,240,L(u))+0.1*u.st.bonusad+0.05*u.st.ap;
        events.push({at:t+0.25, fn:(tt)=>deal(u,tgt,v,ad,tt,"proc","Electrocute")}); } }
    // Dark Harvest (wiki): the proc reaps a soul 1.75 s later (+11 damage each); a takedown resets the cooldown to 1 s (kill())
    if (u.runes.has("darkharvest") && pct(tgt)<0.5 && ready(u,"darkharvest",t)){ setcd(u,"darkharvest",t,35); deal(u,tgt,30+11*u.souls+0.1*u.st.bonusad+0.05*u.st.ap,ad,t,"proc","Dark Harvest"); events.push({at:t+1.75, fn:()=>{ u.souls++; }}); }
    if (u.runes.has("conqueror")){ u.conq.n=Math.min(12,(t<u.conq.until?u.conq.n:0)+(kind==="aa"&&u.ranged?1:2)); u.conq.until=t+5; refresh(u,t); }
    if (u.runes.has("tasteofblood") && u.hp<u.max && ready(u,"tasteofblood",t)){ setcd(u,"tasteofblood",t,20); heal(u,u,lerpL(16,40,L(u))+0.1*u.st.bonusad+0.05*u.st.ap,t,"Taste of Blood"); }   // wiki: not at full health
    if (u.runes.has("cheapshot") && u.csPre && u.csPre.tgt===tgt && u.csPre.t===t && u.csPre.ok && ready(u,"cheapshot",t)){ setcd(u,"cheapshot",t,4); deal(u,tgt,lerpL(10,45,L(u)),"true",t,"proc","Cheap Shot"); }
    if (u.runes.has("suddenimpact") && t<=u.mobileUntil && ready(u,"suddenimpact",t)){ setcd(u,"suddenimpact",t,10); deal(u,tgt,lerpL(20,80,L(u)),"true",t,"proc","Sudden Impact"); }
    if (u.runes.has("summonaery") && t>=u.aeryAt){ u.aeryAt=t+2; deal(u,tgt,lerpL(10,50,L(u))+0.05*u.st.ap+0.1*u.st.bonusad,ad,t,"proc","Aery"); }
    if (has(u,"eclipse") && ready(u,"eclipse",t)){ const w=(u.ecl[tgt.name]||[]).filter(x=>x>t-idv("eclipse","WindowDuration",2)); w.push(t); u.ecl[tgt.name]=w;
      if (w.length>=2){ setcd(u,"eclipse",t,idv("eclipse","Cooldown",6)); u.ecl[tgt.name]=[];
        deal(u,tgt,idv("eclipse","MeleePercMaxHP",0.08)*(u.ranged?idv("eclipse","RangedPercMaxHPMult",0.625):1)*tgt.max,"physical",t,"proc","Eclipse");
        const s=(idv("eclipse","MeleeBaseShield",150)+idv("eclipse","MeleeBonusADShieldRatio",0.4)*u.st.bonusad)*(u.ranged?idv("eclipse","RangedShieldMult",0.5):1);
        shield(u,u,s,idv("eclipse","ShieldDuration",2),t,"Eclipse",true); } }
    if (kind!=="ability") return;
    // Deathfire Touch (wiki): 3–12 (+7% bonus AD, +2.5% AP) magic per second, +75% after burning 3 s; lasts 4 s (single target),
    // 2 s (area) or 1 s (persistent); a new application keeps the longer of the two remaining durations; damage fixed when applied
    if (u.runes.has("deathfiretouch")){ const dur = a && a.spread>0 ? (a.S&&a.S.onHit&&dvOf(a.S,"tickspersecond",a.rank)>0 ? 1 : a.spread+1) : a && a.aoe ? 2 : 4;
      const ex=tgt.dots.find(d=>d.id==="deathfire" && d.u===u);
      if (ex) ex.until=Math.max(ex.until, t+dur); else addDot(u,tgt,t,"deathfire","Deathfire Touch",lerpL(3,12,L(u))+0.025*u.st.ap+0.07*u.st.bonusad,dur,3); }
    // Arcane Comet (wiki): 15–100 (+10% bonus AD, +5% AP) adaptive, +0–100% by the distance it travels (0–750 units from the caster), lands 0.8 s later
    if (u.runes.has("arcanecomet") && ready(u,"comet",t)){ setcd(u,"comet",t,lerpL(20,8,L(u))); const dist=gap(u,tgt), f=Math.min(1, dist/750), v=(lerpL(15,100,L(u))+0.05*u.st.ap+0.1*u.st.bonusad)*(1+f);
      simNotes.add(`${u.name}: Arcane Comet +${fmt(100*f)}% for ${fmt(dist)} units travelled (wiki: +100% at 750), landing 0.8s after the hit; assumed to hit`);
      events.push({at:t+0.8, fn:(tt)=>deal(u,tgt,v,ad,tt,"proc","Arcane Comet")}); }
    if (u.runes.has("scorch") && ready(u,"scorch",t)){ setcd(u,"scorch",t,10); const v=lerpL(20,40,L(u)); events.push({at:t+1, fn:(tt)=>deal(u,tgt,v,"magic",tt,"proc","Scorch")}); }
  }
  // item effects of ability damage landing on x (once per target per cast)
  function abilityItems(u, x, t, a, first){
    if (!x.alive) return;
    if (has(u,"ludensecho") && first && ready(u,"ludens",t)){ setcd(u,"ludens",t,idv("ludensecho","Cooldown",12));
      const d=itemCalc(u.st,"ludensecho","damage"), n=idv("ludensecho","MaxCharges",6), others=enemiesOf(u,t).filter(y=>y!==x).slice(0,n-1);
      deal(u,x,d*(1+idv("ludensecho","RepeatDamageReduction",0.2)*(n-1-others.length)),"magic",t,"proc","Luden's Echo");
      for (const y of others) events.push({at:t+0.5, fn:(tt)=>deal(u,y,d,"magic",tt,"proc","Luden's Echo")}); }
    if (has(u,"liandrystorment")) addDot(u,x,t,"liandry","Liandry's burn",idv("liandrystorment","BurnPercentHealthDamage",0.02)*x.max,idv("liandrystorment","BurnDuration",3),0);
    if (has(u,"blackfiretorch")){ addDot(u,x,t,"blackfire","Blackfire burn",itemCalc(u.st,"blackfiretorch","burndamagepersecondcalc"),idv("blackfiretorch","BurnDuration",3),0); refresh(u,t); }
    else if (has(u,"fatedashes")) addDot(u,x,t,"fatedashes","Fated Ashes burn",idv("fatedashes","BurnFlatDamagePerSecond",5),idv("fatedashes","BurnDuration",3),0);
    if (has(u,"malignance") && a && a.slot==="R" && ready(u,"malig:"+x.name,t)){ setcd(u,"malig:"+x.name,t,idv("malignance","GroundDuration",3));
      addDot(u,x,t,"malignance","Hatefog",itemCalc(u.st,"malignance","groundburndamageperticktooltiponly"),idv("malignance","GroundDuration",3),0); x.malig={until:t+idv("malignance","GroundDuration",3), mr:itemCalc(u.st,"malignance","magicresistanceshred")}; }
    if (has(u,"spearofshojin") && a && first && u.shojin.cast!==u.casts){ u.shojin.cast=u.casts; u.shojin.n=Math.min(idv("spearofshojin","StackCount",4),(u.shojin.until>t?u.shojin.n:0)+1); u.shojin.until=t+idv("spearofshojin","StackDuration",6); }
    if (has(u,"zazzaksrealmspike") && ready(u,"zazzak",t)){ setcd(u,"zazzak",t,itemCalc(u.st,"zazzaksrealmspike","cooldown")||10);
      events.push({at:t+0.5, fn:(tt)=>{ for (const y of enemiesOf(u,tt)) deal(u,y,idv("zazzaksrealmspike","BaseDamage",10)+idv("zazzaksrealmspike","APRatio",0.15)*u.st.ap+idv("zazzaksrealmspike","PercentHPDamage",0.03)*y.max,"magic",tt,"proc","Zaz'Zak's Void Explosion"); }}); }
    if (has(u,"bastionbreaker") && a && ready(u,"bastion",t)){ setcd(u,"bastion",t,idv("bastionbreaker","Cooldown",20));
      const v=itemCalc({...u.st, ranged:false},"bastionbreaker","abilitydamagecalc")*(u.ranged?idv("bastionbreaker","AbilityDamageRangeMod",0.5):1); deal(u,x,v,"true",t,"proc","Bastionbreaker"); }
    if (has(u,"voltaiccyclosword") && a && u.energy>=100){ u.energy=0; energized(u,x,t,x.hp,"Galvanize"); }
    if (has(u,"horizonfocus") && a && a.range>=idv("horizonfocus","SnipeRange",600)){ x.marks[u.name]=t+idv("horizonfocus","BuffDuration",6);
      for (const y of enemiesOf(u,t)) if (y!==x) y.marks[u.name]=Math.max(y.marks[u.name]||0, t+idv("horizonfocus","SecondaryBuffDuration",3)); }
    ccItems(u, x, t, a);
    if (u.purple && u.purple.until>t){ const p=u.purple; u.purple=null; deal(u,x,p.amt,"magic",t,"proc","Dream Maker bubble"); }
  }
  /* runes triggered by immobilizing or slowing an enemy champion (wiki Rune_data_*) */
  function ccRunes(u, x, t, a){
    if (!x.alive || x.side===u.side) return;
    const IMM=["stun","root","knockup","knockback","pull","suppress","sleep","charm","fear","taunt","berserk"];
    const imm=(a.cc||[]).filter(e=>IMM.includes(e.type)), immDur=Math.max(0, ...imm.map(e=>ccDuration(e, x.st.tenacity||0)));
    // the ability's crowd-control list (game data / wiki) decides; the text tags only when it has none
    const known=!!(a.cc && a.cc.length), immob = known ? imm.length>0 : !!a.immob, slows = known ? a.cc.some(e=>e.type==="slow") : !!a.slows;
    if (!immob && !slows) return;
    a={...a, immob};
    // Aftershock: +45 (+75% bonus) armor and MR, each capped at 80–150, for 2.5 s; then 25–120 (+8% bonus health) magic within 350
    if (a.immob && u.runes.has("aftershock") && ready(u,"aftershock",t)){ setcd(u,"aftershock",t,20); const cap=lerpL(80,150,L(u));
      u.after={until:t+2.5, armor:Math.min(cap,45+0.75*u.st.bonusarmor), mr:Math.min(cap,45+0.75*u.st.bonusmr)};
      const v=lerpL(25,120,L(u))+0.08*u.st.bonushp; events.push({at:t+2.5, fn:(tt)=>{ if (!u.alive) return; for (const y of enemiesOf(u,tt)) if (gap(u,y)<=350+RAD(y)) deal(u,y,v,"magic",tt,"proc","Aftershock"); }}); }
    // Glacial Augment: a zone for 3 s + the immobilize's duration that slows 20% (+7% per 100 bonus AD, +6% per 100 AP, +9% per 10% heal
    // and shield power) and cuts the target's damage to the user's allies (not the user) by 15%; assumed to stay in the zone
    if (a.immob && u.runes.has("glacialaugment") && ready(u,"glacial",t)){ setcd(u,"glacial",t,25); const dur=3+immDur, p=0.2+0.07*u.st.bonusad/100+0.06*u.st.ap/100+0.9*u.st.healpower;
      x.slows.push({pct:p, until:t+dur, t0:t, by:u}); x.glacial={by:u, until:t+dur};
      say(t, `  ${u.name}: Glacial Augment zone on ${x.name}: ${fmt(100*p)}% slow, −15% damage to ${u.name}'s allies for ${fmt(dur)}s`);
      simNotes.add(`Glacial Augment: the immobilized target is assumed to stay in the frozen zone for its whole ${fmt(dur)}s (wiki: 3 s + the immobilize's duration)`); }
    // Font of Life: heals the user and the most wounded allied champion within 1000 for 10–50 (70% ranged)
    if (u.runes.has("fontoflife") && ready(u,"fontoflife",t)){ setcd(u,"fontoflife",t,20); const v=lerpL(10,50,L(u))*(u.ranged?0.7:1);
      heal(u,u,v,t,"Font of Life",false,true); const y=alliesOf(u).filter(z=>z!==u && gap(u,z)<=1000).sort((p,q)=>pct(p)-pct(q))[0]; if (y) heal(u,y,v,t,"Font of Life",false,true); }
  }
  // item effects of crowd control landing on x (also from abilities without damage)
  function ccItems(u, x, t, a){
    if (a && a.immob && has(u,"imperialmandate")) x.vuln={until:Math.max(x.vuln&&x.vuln.until>t?x.vuln.until:0, t+idv("imperialmandate","DamageAmpDuration",4))};
    if (a && a.immob && has(x,"forceofnature")){ x.fon.n=Math.min(idv("forceofnature","MaxStacks",8),(x.fon.until>t?x.fon.n:0)+idv("forceofnature","ImmobilizeStacks",2)); x.fon.until=t+idv("forceofnature","BuffDuration",7); }
    if (a && (a.immob || a.slows || (a.parts.length && has(u,"rylaiscrystalscepter")))) slowed(u, x, t);
    if (a && (a.immob || a.slows)) ccRunes(u, x, t, a);
  }
  function slowed(u, x, t){
    if (has(u,"bandlepipes")){ const dur=idv("bandlepipes","Duration",8)*(u.ranged?0.5:1), as=idv("bandlepipes","MeleeAuraAttackSpeed",0.3)*(u.ranged?idv("bandlepipes","RangedAttackSpeedMultiplier",0.667):1);
      for (const y of alliesOf(u)) addBuff(y,"fanfare",t+dur,{bonusAS:as},t); }
    if (has(u,"solsticesleigh") && ready(u,"sleigh",t)){ setcd(u,"sleigh",t,idv("solsticesleigh","Cooldown",30)); const v=itemCalc(u.st,"solsticesleigh","bonushealthbuff");
      const other=alliesOf(u).filter(y=>y!==u).sort((a,b)=>pct(a)-pct(b))[0]; for (const y of [u, other]) if (y) addBuff(y,"sleigh",t+idv("solsticesleigh","BuffDuration",2.5),{bonushp:v},t); }
  }
  /* ---- basic attacks and on-hit ---- */
  function energized(u, x, t, hpBefore, why){
    const tag = why ? ` (${why})` : "";
    if (has(u,"rapidfirecannon")) deal(u,x,idv("rapidfirecannon","BonusDamage",40),"magic",t,"onhit","Rapid Firecannon"+tag);
    if (has(u,"stormrazor")) deal(u,x,itemCalc(u.st,"stormrazor","totalprocdamage"),"magic",t,"onhit","Stormrazor"+tag);
    if (has(u,"statikkshiv")){ const d=idv("statikkshiv","ChainDamage",60), n=Math.max(1,Math.round(itemCalc(u.st,"statikkshiv","bouncecount")));
      deal(u,x,d,"magic",t,"onhit","Statikk Shiv"+tag); for (const y of enemiesOf(u,t).filter(y=>y!==x).slice(0,n-1)){ deal(u,y,d,"magic",t,"onhit","Statikk Shiv chain"); applyOnHit(u,y,t,{eff:1}); } }
    if (has(u,"voltaiccyclosword")){ const p=(u.ranged?idv("voltaiccyclosword","PercentCurrentHPRanged",7):idv("voltaiccyclosword","PercentCurrentHPMelee",9))/100;
      deal(u,x,p*hpBefore,"physical",t,"onhit","Voltaic Cyclosword"+tag);
      addBuff(u,"voltaic",t+idv("voltaiccyclosword","LethalityBonusDuration",4),{lethality:u.ranged?idv("voltaiccyclosword","LethalityBonusModRanged",12):idv("voltaiccyclosword","LethalityBonusModMelee",15)},t); }
  }
  const hasEnergize = u => ["rapidfirecannon","stormrazor","statikkshiv","voltaiccyclosword"].some(k=>has(u,k));
  /* on-hit effects. o.eff scales flat on-hit damage (e.g. Katarina R); o.basic: a basic attack's on-hit (stack effects);
     o.primary: the attack's own target (Energized, cleave); o.sb: may consume Spellblade; o.hp0: target health before the attack */
  function applyOnHit(u, x, t, o){
    if (!x.alive) return;
    const e=o.eff ?? 1, hpB = o.hp0 ?? (dmgQueue && x.hpS!=null ? x.hpS : x.hp);   // fight(): health at the start of the step, not after a self-heal cast earlier in it (order-independence)
    if (o.sb && u.sb.ready && t<=u.sb.until){ const k=SPELLBLADE.find(k=>has(u,k));
      if (k){ u.sb.ready=false; u.sb.cd=t+idv(k,"SpellbladeCooldown",1.5);
        const magic = k==="lichbane"||k==="duskanddawn";
        deal(u,x,itemCalc(u.st,k,"spellbladedamage"),magic?"magic":"physical",t,"onhit",ITEMS[k].name+" spellblade",{ls:LS_ONHIT.has(k)});
        if (k==="bloodsong") x.expose={until:t+idv("bloodsong","DebuffDuration",4), amp:u.ranged?idv("bloodsong","RangedDamageAmp",0.05):idv("bloodsong","MeleeDamageAmp",0.08)};
        if (k==="duskanddawn"){ heal(u,u,itemCalc(u.st,"duskanddawn","spellbladehealing"),t,"Dusk and Dawn"); events.push({at:t+0.2, fn:(tt)=>applyOnHit(u,x,tt,{basic:true})}); } } }
    const oh = (k, v, type) => { if (v>0) deal(u,x,v*e,type,t,"onhit",ITEMS[k].name+(e!==1?` (×${fmt(e)})`:""),{ls:LS_ONHIT.has(k)}); };
    if (has(u,"recurvebow")) oh("recurvebow", idv("recurvebow","OnHitDamage",15), "physical");
    if (has(u,"nashorstooth")) oh("nashorstooth", itemCalc(u.st,"nashorstooth","totalonhitdamage"), "magic");
    if (has(u,"witsend")) oh("witsend", itemCalc(u.st,"witsend","onhitdamage"), "magic");
    if (has(u,"terminus")) oh("terminus", itemCalc(u.st,"terminus","onhitdamage"), "magic");
    if (has(u,"guinsoosrageblade")) oh("guinsoosrageblade", idv("guinsoosrageblade","OnHitDamage",30), "magic");
    if (has(u,"bladeoftheruinedking")) oh("bladeoftheruinedking", (u.ranged?idv("bladeoftheruinedking","RangedValue",0.06):idv("bladeoftheruinedking","MeleeValue",0.09))*hpB, "physical");
    if (has(u,"titanichydra")){ const emp = o.primary && u.titanicReady; if (emp) u.titanicReady=false;
      oh("titanichydra", emp ? idv("titanichydra","ActivePrimaryTargetHPRatio",0.04)*u.max*(u.ranged?idv("titanichydra","RangedEffectiveness",0.5):1) : itemCalc(u.st,"titanichydra","onhitdamagecalc"), "physical");
      if (o.primary) for (const y of enemiesOf(u,t)) if (y!==x) deal(u,y,((emp?idv("titanichydra","ActiveSplashHPRatio",0.09):idv("titanichydra","SplashHPRatio",0.03))*u.max)*(u.ranged?idv("titanichydra","RangedEffectiveness",0.5):1),"physical",t,"onhit","Titanic Hydra cleave",{ls:true}); }
    if (u.ardentUntil>t) deal(u,x,u.ardentOnHit*e,"magic",t,"onhit","Ardent Censer",{ls:true});
    if (has(u,"cull")) heal(u,u,idv("cull","OnHitHeal",3),t,null);
    { const km=CHAMP_MECH[u.c.champ]; if (km && km.onHit) km.onHit(u, x, t, o, e, hpB); }   // champion kits: on-hit passives
    if (o.primary){
      for (const k of ["ravenoushydra","profanehydra","stridebreaker","tiamat"]) if (has(u,k)){ const r=u.ranged?0.2:0.4;   // wiki: 40% AD (20% ranged)
        for (const y of enemiesOf(u,t)) if (y!==x) deal(u,y,r*u.st.ad,"physical",t,"onhit",ITEMS[k].name+" cleave",{lifesteal:k==="ravenoushydra"}); break; }
      if (u.purple && u.purple.until>t){ const p=u.purple; u.purple=null; deal(u,x,p.amt,"magic",t,"proc","Dream Maker bubble"); }
    }
    // wiki Kraken Slayer: "Abilities that do not trigger on-attack effects but trigger on-hit effects (e.g. Onslaught) will
    // instead always apply and consume Bring It Down on-hit": they stack and consume it like attacks (o.krakenStack);
    // the proc's damage is × the ability's on-hit effectiveness
    if (!o.basic && !o.krakenStack) return;
    if (has(u,"krakenslayer")){ const K=u.kraken;
      if (K.n>=idv("krakenslayer","AttackCount",3)-1 && K.until>t){ K.n=0; K.until=-1;
        const miss=1-Math.max(0,hpB)/x.max, v=itemCalc(u.st,"krakenslayer","damageamount")*(1+(idv("krakenslayer","MaxAmpNumber",1.75)-1)*miss);
        deal(u,x,v*e,"physical",t,"onhit","Kraken Slayer"+(e!==1?` (×${fmt(e)})`:""),{ls:true}); }
      else { K.n=(K.until>t?K.n:0)+1; K.until=t+idv("krakenslayer","BuffDuration",4); } }
    if (!o.basic) return;
    if (has(u,"terminus")){ const T=u.term, side=T[T.next]; side.n=Math.min(3,(side.until>t?side.n:0)+1); side.until=t+idv("terminus","BuffDuration",5); T.next = T.next==="light"?"dark":"light"; refresh(u,t); }
    if (has(u,"heartsteel")){ const h=u.heart[x.name] ||= {since:0, cd:-1};
      if (t-h.since>=idv("heartsteel","NumTicksToTrigger",6)*idv("heartsteel","TrackerTickRate",0.5) && t>=h.cd){ h.cd=t+idv("heartsteel","PerTargetCooldown",30); h.since=t;
        const v=itemCalc(u.st,"heartsteel","damagecalc"); deal(u,x,v,"physical",t,"onhit","Heartsteel",{ls:true});
        u.perm.hp += idv("heartsteel","DamageToMaxHealthRatio",0.1)*v; refresh(u,t); say(t, `  ${u.name}: Heartsteel +${fmt(0.1*v)} max health`); } }
    if (has(u,"hullbreaker")){ const H=u.hull;
      if (H.n>=4 && H.until>t){ H.n=0; deal(u,x,itemCalc(u.st,"hullbreaker","maxstackdamage"),"physical",t,"onhit","Hullbreaker",{ls:true}); }
      else { H.n=(H.until>t?H.n:0)+1; H.until=t+idv("hullbreaker","SkipperStackDuration",10); } }
    if (o.primary && hasEnergize(u)){ if (u.energy>=100){ u.energy=0; energized(u,x,t,hpB); } else u.energy=Math.min(100,u.energy+(has(u,"statikkshiv")?15:6)); }
    if (o.primary && has(u,"deadmansplate") && u.dmp){ u.dmp=false; deal(u,x,itemCalc(u.st,"deadmansplate","maxdamagecalc"),"physical",t,"onhit","Dead Man's Plate"); }
  }
  /* An ability that applies on-hit effects (S.onHit, from the wiki's "Attack effects" list): on-hit damage at the listed
     effectiveness. Abilities that also trigger on-attack effects (Death Lotus daggers, Ezreal Q…) count as basic attacks
     for on-hit stacks (Kraken's counter, Terminus Light/Dark, Hullbreaker); on-hit-only ones (Shunpo, Sinister Steel,
     Fiora Q…) stack and consume Kraken's Bring It Down on-hit (wiki Kraken Slayer) and don't build Terminus stacks. */
  function abilityOnHit(u, x, t, a, hp0){
    const S=a.S||CALC.champs[u.c.champ][a.slot], oh=S&&S.onHit; if (!oh || !x.alive) return;
    const eff = oh.eff ?? (oh.effKey ? dvOf(S, oh.effKey, a.rank||rankOf(u.c,a.slot)) : null);
    const who=`${u.name} ${a.slot}`;
    if (eff==null){ simNotes.add(`${who}: applies on-hit effects at a varying effectiveness (wiki); not applied`); return; }
    simNotes.add(`${who}: applies on-hit effects at ${fmt(eff*100)}% (wiki 'Attack effects')${oh.onAttack?"; also triggers on-attack effects, so it counts as a basic attack for Kraken, Terminus and Hullbreaker stacks (assumed)":"; on-hit only, so it stacks and consumes Kraken's Bring It Down on-hit like an attack (wiki Kraken Slayer) but builds no Terminus stacks (assumed: Terminus says basic attacks)"}`);
    applyOnHit(u, x, t, oh.onAttack ? {eff, basic:true, hp0} : {eff, krakenStack:true, hp0});
  }
  const asOf = (u, extra) => Math.min(u.st.ascap??AS_CAP, (u.st.baseas + u.st.asratio*(u.st.bonusas+extra))*u.st.asMult);
  /* backlog 25 step 7: basic-attack windup and missile (wiki "Attack speed": windup percent = attack cast time ÷ attack total
     time, else 0.3 + attack offset; windup = base windup + windup modifier × (attack time × windup percent − base windup), base
     windup = windup percent ÷ base attack speed, modifier 1 unless the champion has one: Darius, Garen 0.5, Graves 0.1, Jayce
     0.005, Kalista 0.75, Senna 0.6, Taric, Thresh 0.25). calc.json base.wu/wm/msl (src/calc_export.py attack_timing: wiki
     Module:ChampionData = the CharacterRecord basicAttack; missile speed 0 = instant). */
  function attackData(u){ return attackTiming(!u.pet && u.c ? u.c.champ : null, u.st, u.ranged); }
  const attackWindup = (u, as) => attackTiming(!u.pet && u.c ? u.c.champ : null, {...u.st, as}, u.ranged).windup;
  // a generic empowered next attack (EMPOWER_NEXT: Nasus Q, Garen Q…) waiting for the attack that consumes it
  // a kit hook setting this attack's timer (Jayce Hyper Charge, Sylas, Ambessa: the attack's own attack speed): from the attack's
  // start (the hooks run at the landing), unless a newer attack has started since
  function aaTimer(u, t, v){ const t0=u.aaT0 ?? t; if (u.lastAAt > t0+1e-9) return; u.nextAA=t0+v; }
  function takeEmpower(u, t){ const E=u.empower; if (!E) return null; u.empower=null; return E.until>t ? E : null; }
  // its landing: the ability resolves on the attack's target as the attack lands, with the numbers of its press
  function landEmpower(u, E, tgt, t){ const a=E.a;
    resolveCast(u, {...a, parts:E.snap.parts, later:E.snap.later, heal:E.snap.heal, shield:E.snap.shield, aoe:false}, tgt, t, E.d0, E.L);
    if (E.snap.heal) heal(u, u, E.snap.heal, t, a.slot); }
  function autoAttack(u, tgt, t){
    refresh(u,t);
    let phantom=false;
    // on-attack effects first: they change this attack's timer
    if (has(u,"guinsoosrageblade")){ const R=u.rage, max=idv("guinsoosrageblade","MaxStacks",4);
      if (R.until>t && R.n>=max){ if (R.ph>=2){ R.ph=0; phantom=true; } else R.ph++; } else R.ph=0;
      R.n=Math.min(max,(R.until>t?R.n:0)+1); R.until=t+idv("guinsoosrageblade","BuffDuration",4); }
    if (has(u,"yuntalwildarrows")){ const per=idv("yuntalwildarrows","CritPerStackMelee",0.4)/100*(u.ranged?idv("yuntalwildarrows","StackRangedMultiplier",0.5):1); u.perm.yun+=per;
      if (ready(u,"flurry",t)){ setcd(u,"flurry",t,idv("yuntalwildarrows","Cooldown",30)); addBuff(u,"flurry",t+idv("yuntalwildarrows","ASDuration",6),{bonusAS:idv("yuntalwildarrows","ASMod",0.3)},t); }
      else if (u.rcd.flurry>t) u.rcd.flurry-=idv("yuntalwildarrows","AACDR",1)+u.st.crit*(idv("yuntalwildarrows","CritCDR",2)-idv("yuntalwildarrows","AACDR",1)); }
    if (has(u,"navoriflickerblade")) for (const s of ["Q","W","E"]) if ((u.cd[s]||0)>t) u.cd[s]=t+(u.cd[s]-t)*(1-idv("navoriflickerblade","CDRAmount",0.15));
    if (has(u,"scoutsslingshot") && u.rcd.slingshot>t) u.rcd.slingshot-=1;
    refresh(u,t);
    let extra=0;
    // Lethal Tempo (wiki): 6% bonus attack speed per stack (ranged ×0.8 = 4.8%; the client text's 4% is stale), 6 stacks, 6 s
    if (u.runes.has("lethaltempo")){ u.lt.n=Math.min(6,(t<u.lt.until?u.lt.n:0)+1); u.lt.until=t+6; extra+=(u.ranged?0.048:0.06)*u.lt.n; }
    // Hail of Blades (wiki, V26.16): 2 stacks (attack resets add up to 2 more, not modelled), 90% (60% ranged) bonus attack speed
    // above the attack-speed cap; 3 s between attacks; the 10 s cooldown starts when the effect ends
    let hob=false;
    if (u.runes.has("hailofblades")){ const H=u.hob;
      if (H.n>0 && t>=H.until){ H.n=0; setcd(u,"hob",H.until,10); }
      if (H.n<=0 && ready(u,"hob",t)) H.n=2;
      if (H.n>0){ H.until=t+3; extra+=u.ranged?0.6:0.9; hob=true; } }
    const fh = u.fiend.n>0 && t<u.fiend.until;
    if (fh){ u.fiend.n--; if (u.fiend.n>0) extra+=idv("fiendhunterbolts","BonusAS",0.5); }
    const as = hob ? Math.min(90, (u.st.baseas + u.st.asratio*(u.st.bonusas+extra))*u.st.asMult) : asOf(u, extra);
    const wind = ATTACK_TIMING ? attackWindup(u, as) : 0, t0=t;
    u.nextAA=t+1/as; u.nextAct=t+(ATTACK_TIMING ? wind : Math.min(0.25,0.4/as)); u.lastAAt=t; u.walk=null;
    { const km=!u.pet && CHAMP_MECH[u.c.champ]; if (km && km.onAttack) km.onAttack(u, tgt, t); }   // champion kits: on-attack effects at the attack's start (Jinx Rev'd up)
    if (ccOn(u,t,"blind")){ say(t, `${u.name}'s attack on ${tgt.name} misses (blinded)`); return; }
    const emp = ATTACK_TIMING ? takeEmpower(u, t) : null;
    /* the attack starts now (timer, on-attack effects above) and lands at the end of its windup, a ranged one after its missile's
       flight too (tracking the target from where it is at the launch); a stun, knock-up or death of the attacker during the
       windup cancels it (cancelCasts); a target dead or in stasis/untargetable at the landing isn't hit. Kit attack hooks run at
       the landing (u.aaT0 = the start, for the timers they set). */
    const land=(t)=>{
    if (!tgt.alive || inStasis(tgt,t)){ if (ATTACK_TIMING) say(t, `${u.name}'s attack on ${tgt.name} misses (${!tgt.alive?"dead":"untargetable"} as it lands)`); return; }
    { const kd=!tgt.pet && CHAMP_MECH[tgt.c.champ]; if (kd && kd.dodgeAttack && kd.dodgeAttack(tgt, u, t)){ say(t, `${tgt.name} dodges ${u.name}'s attack`); return; } }   // Jax E, Counter Strike
    refresh(u,t); u.aaT0=t0;
    // the attack's damage (critical strikes at their expected value)
    const hp0=tgt.hpS ?? tgt.hp, crit=u.st.crit, cdm=critVs(u,tgt);
    let mult=1+crit*(cdm-1), what=crit?"attack, expected crit":"attack", trueX=0;
    if (has(u,"sunderedsky") && !(u.sunder[tgt.name]>t)){ u.sunder[tgt.name]=t+idv("sunderedsky","Cooldown",10); mult=cdm*idv("sunderedsky","CritModifier",0.8); what="attack, Sundered Sky crit"; }
    else if (fh){ const fm=idv("fiendhunterbolts","CritModifier",0.8);
      mult=(1-crit)*cdm*fm + crit*cdm; trueX=crit*idv("fiendhunterbolts","BonusTrueDamage",0.15)*u.st.ad*cdm; what="attack, Opening Barrage crit"; }
    const kam=u.pet ? u.pet.mech : CHAMP_MECH[u.c.champ], am = kam && kam.attack ? kam.attack(u,tgt,t,mult) : null;   // champion kits: empowered attacks (pets: their own)
    if (am && am.replace) deal(u,tgt,am.replace.v,am.replace.type,t,"aa",am.replace.what); else deal(u,tgt,u.st.ad*mult,"physical",t,"aa",what);
    if (am && am.bonus) for (const b of am.bonus) deal(u,tgt,b.v,b.type,t,"aa",b.what);
    if (emp) landEmpower(u, emp, tgt, t);   // Nasus Q, Garen Q…: the ability's damage and crowd control ride this attack
    if (tgt.alive) kitBrushBolts(u, tgt, t);
    if (tgt.alive) kitSoulMark(u, tgt, t);   // Kalista W passive: her and her Oathsworn's attacks
    if (tgt.alive && u.namiE) kitNamiHit(u, tgt, t, null);   // Nami E on the attacker
    if (trueX>0) deal(u,tgt,trueX,"true",t,"proc","Fiendhunter Bolts");
    if (what==="attack, Sundered Sky crit"){ const hv=idv("sunderedsky","HealBaseADRatio",0.9)*u.st.basead*(u.ranged?idv("sunderedsky","RangedHealMod",0.5):1)+idv("sunderedsky","MissingHealthHeal",0.04)*(u.max-u.hp);
      const room=u.max-u.hp, full=hv*(1+u.st.healpower)*(1+u.st.healIn)*(t<u.grievUntil?1-u.grievBy:1); heal(u,u,hv,t,"Sundered Sky");
      if (full>room+1e-6){ addBuff(u,"sundered",t+8,{bonushp:Math.round(full-room)},t); say(t, `  ${u.name}: Sundered Sky overheal → +${fmt(full-room)} bonus health for 8s`); } }
    u.aa++;
    if (tgt.alive){
      applyOnHit(u,tgt,t,{basic:true, primary:true, sb:true, hp0});
      const ad=adaptive(u);
      // Lethal Tempo bolt at 6 stacks (wiki notes): 9–30 (ranged ×0.667: 6–20; the client text's 6–24 is wrong) adaptive,
      // +1% per 1% bonus attack speed, the rune's own stacks (and other temporary bonuses) included
      if (u.lt.n>=6) deal(u,tgt,lerpL(9,30,L(u))*(u.ranged?0.667:1)*(1+u.st.bonusas+extra),ad,t,"proc","Lethal Tempo");
      if (hob && u.hob.n>0){ u.hob.n--; deal(u,tgt,lerpL(2,20,L(u))+0.12*u.st.bonusad+0.1*u.st.ap,"true",t,"proc","Hail of Blades"); if (u.hob.n===0) setcd(u,"hob",t,10); }
      // Press the Attack (wiki): 3 attacks on one champion (stacks last 4 s, lost on switching champions) → 40–160 adaptive and
      // +8% damage to that champion (kept for the rest of the fight: it lasts until 5 s after leaving combat); 6 s cooldown per target
      if (u.runes.has("presstheattack")){ const P=(u.pta||={})[tgt.name]||={n:0,until:-1,cd:-1};
        if (u.lastAATarget && u.lastAATarget!==tgt){ const o=u.pta[u.lastAATarget.name]; if (o) o.n=0; }
        if (t>=P.cd){ P.n=(t<P.until?P.n:0)+1; P.until=t+4; if (P.n>=3){ P.n=0; P.cd=t+6; deal(u,tgt,lerpL(40,160,L(u)),ad,t,"proc","Press the Attack"); u.ptaOn.add(tgt); } } }
      // Grasp (client text: every 4 s in combat): ready 4 s after entering combat and 4 s after each proc
      if (u.runes.has("graspoftheundying") && u.combatAt!=null && t>=(u.graspAt || u.combatAt+4)){ u.graspAt=t+4; const m=u.ranged?0.4:1; deal(u,tgt,0.035*u.max*m,"magic",t,"proc","Grasp"); heal(u,u,0.013*u.max*m,t,"Grasp"); }
      // Fleet Footwork (wiki, V26.16): heal 15 + 145/17·(L−1)·(0.7025 + 0.0175·(L−1)) (+10% bonus AD, +5% AP), ranged 60%; +20% (15%) move speed 1 s
      if (u.runes.has("fleetfootwork") && u.fleetReady){ u.fleetReady=false; events.push({at:t+3, fn:()=>{u.fleetReady=true;}}); const l=L(u)-1;
        heal(u,u,(15+145/17*l*(0.7025+0.0175*l)+0.1*u.st.bonusad+0.05*u.st.ap)*(u.ranged?0.6:1),t,"Fleet Footwork"); addBuff(u,"fleet",t+1,{mspct:u.ranged?0.15:0.2},t); }
      // Shield Bash (wiki): after gaining a shield, the next attack deals 5–30 (+2.5% bonus health) (+15% of the shield) adaptive on-hit
      if (u.sbash && t<=u.sbash.until){ const s=u.sbash; u.sbash=null; deal(u,tgt,lerpL(5,30,L(u))+0.025*u.st.bonushp+0.15*s.amt,ad,t,"onhit","Shield Bash"); }
      for (const k of ["thornmail","bramblevest"]) if (has(tgt,k)){ u.grievUntil=t+idv(k,"GrievousDuration",3); u.grievBy=Math.max(u.grievBy||0, idv(k,"GrievousAmount",0.4)); deal(tgt,u,itemCalc(tgt.st,k,"totaldamage"),"magic",t,"reflect",ITEMS[k].name); break; }
      u.lastAATarget=tgt;
      onHit(u,tgt,t,"aa");
    }
    // Runaan's Hurricane: bolts at up to 2 other enemies
    if (has(u,"runaanshurricane")) for (const y of enemiesOf(u,t).filter(y=>y!==tgt).slice(0,2)){ deal(u,y,itemCalc(u.st,"runaanshurricane","boltdamage")*(1+crit*(critVs(u,y)-1)),"physical",t,"onhit","Runaan's bolt"); applyOnHit(u,y,t,{}); }
    if (phantom) events.push({at:t+0.15, fn:(tt)=>{ if (!tgt.alive) return; say(tt, `  ${u.name}: Guinsoo's Phantom Hit`); applyOnHit(u,tgt,tt,{basic:true}); }});
    };
    if (!ATTACK_TIMING){ land(t); return; }
    // the windup, then (ranged) the missile; landings run as the step that started the attack (perform's step log)
    const step=u.curStep ?? (u.script ? u.stepLog.length : null), P={slot:"attack", end:t+wind, done:false, cancelled:false};
    const run=(fn)=>(tt)=>{ if (P.cancelled) return; const prev=u.curStep, b=u.dealt; u.curStep=step; fn(tt); u.curStep=prev; if (u.script && step!=null && u.stepLog[step] && tt>t0) u.stepLog[step].dmg += u.dealt-b; };
    if (wind >= dt/2-1e-9){ u.pend=(u.pend||[]).filter(Q=>!Q.done && !Q.cancelled); u.pend.push(P); }
    const B=attackData(u);
    const fire=(tt)=>{ if (P.cancelled) return; P.done=true;
      const fly = B.msl>0 && tgt.alive && !(u.script && !u.scriptTravel) ? gap(u,tgt)/B.msl : 0, when=t0+wind+fly;   // perform() without distance: no positions
      if (when < tt+dt/2-1e-9) run(land)(tt); else events.push({at:when, fn:run(land)}); };
    if (wind < dt/2-1e-9) fire(t0); else events.push({at:t0+wind, fn:fire});
  }
  function pickAlly(u, pool, t){
    const p=u.policy;
    if (p && typeof p==="object"){ const x=pool.find(x=>sameChamp(x,p)); if (x) return x; }
    if (p==="self" && pool.includes(u)) return u;
    if (p==="save"){ let best=null, bt=Infinity; for (const x of pool){ const d=incoming(x,t); const ttd = d>0 ? x.hp/d : Infinity; if (ttd<bt){ bt=ttd; best=x; } } if (best && bt<6) return best; }
    return pool.slice().sort((a,b)=>pct(a)-pct(b))[0];
  }
  function supportTargets(u, a, t, force){
    const amt=a.heal||a.shield, kind=a.heal?a.healTarget:a.shieldTarget, allies=alliesOf(u);
    const big = a.slot==="R";   // save ultimates for real emergencies
    const need = x => force || (a.heal ? (big ? (pct(x)<0.4 || (x.max-x.hp)>=amt*(1+u.st.healpower)) : ((x.max-x.hp)>=0.5*amt*(1+u.st.healpower) || pct(x)<0.5))
                                       : (big ? pct(x)<0.4 : (incoming(x,t,1)>0 || pct(x)<0.6)));
    if (kind==="team") return allies.some(need) ? allies : null;
    if (kind==="self") return need(u) ? [u] : null;
    const pool = allies.filter(x=> kind==="ally" ? x!==u : true);
    const x = pickAlly(u, pool, t);
    if (!x || !need(x)) return null;
    if (kind==="self_and_ally") return x===u ? [u] : [u, x];
    return [x];
  }
  // L (backlog 25): a landing after the press. The aim is decided at the press (the target in reach then, perfect aim) and the hit
  // test is at the landing: the target must still be alive and targetable (a stasis or untargetability at the landing blocks it; a
  // point-and-click missile tracks it); areas hit whoever is inside them at the landing (centred on the target: perfect aim).
  function hitList(u,a,tgt,t,L){
    if (u.script) return a.aoe ? enemiesOf(u,t) : (tgt ? [tgt] : []);
    { const km=CHAMP_MECH[u.c.champ], r=km && km.hitList ? km.hitList(u,a,tgt,t) : null; if (r) return r; }   // champion kits: hits from other origins (Zed's shadows)
    const aimed = x => L && L.deferred ? L.castOk : inReach(u,a,x);
    if (!a.aoe) return tgt && tgt.alive && !inStasis(tgt,t) && aimed(tgt) ? [tgt] : [];
    const p=a.p||{}, r=p.radius||0, foes=enemiesOf(u,t);
    let list;
    if (p.delivery==="self") list = foes.filter(x=>gap(u,x)<=abReach(u,a,x)+1e-6);
    else if (tgt && r>0 && (p.kind==="area" || ["placed","lobbed","remote"].includes(p.delivery))) list = foes.filter(x=>gap(x,tgt)<=r+RAD(x)+1e-6 && aimed(tgt));
    else { list = foes.filter(x=>gap(u,x)<=abReach(u,a,x)+1e-6);        // lines and cones: on one line, everything within reach
      if (L && L.deferred && L.castOk && tgt && foes.includes(tgt) && !list.includes(tgt)) list.push(tgt); }   // aimed at it at the press
    return list;
  }
  function cast(u, a, tgt, t, o={}){
    refresh(u,t); u.kitT=t; abNums(u,a); a.cd=abCd(u,a);
    let cdv=a.cd; const cd0=u.cd[a.slot], ammo0=a.ammo ? {n:a.ammo.n, at:a.ammo.at} : null, en0=enCost(u,a);   // P3: refunded if the cast is cancelled (rule 3)
    if (has(u,"actualizer") && u.actUntil>t && a.slot!=="R"){ const win=u.actUntil-t, f=1+idv("actualizer","CooldownTick",0.3); cdv = cdv<=win*f ? cdv/f : win+(cdv-win*f); }
    u.cd[a.slot]=t+cdv; u.nextAct=t+(a.channel ? a.spread : castLock(u,a)); u.casts++; (u.castsBy ||= {})[a.slot]=(u.castsBy[a.slot]||0)+1;
    if (a.ammo){ const A=a.ammo, rc=A.rc*100/(100+u.st.haste+(a.slot==="R"?u.st.rhaste:u.st.basichaste));   // ammo: spend a charge; with none left, wait for the next
      while (A.at!=null && t>=A.at-1e-9){ A.n++; A.at = A.n<A.max ? A.at+rc : null; }
      A.n=Math.max(0, A.n-1); if (A.at==null) A.at=t+rc; if (A.n<=0) u.cd[a.slot]=Math.max(u.cd[a.slot], A.at); }
    if (a.channel){ u.nextAA=Math.max(u.nextAA, t+a.spread); simNotes.add(`${u.name} ${a.slot}: channel — its damage is spread over ${fmt(a.spread)}s and the caster does nothing else meanwhile`); }
    if (a.mobile) u.mobileUntil=t+4;
    if (a.channel) u.chan={id:u.casts, slot:a.slot, until:t+a.spread};
    // energy (item 24): the cost is paid at the cast (callers check enShort first); Akali W (perform) restores 100 and raises the cap
    { const c=enCost(u,a); if (c>0) enSpend(u,c,t);
      if (u.en && u.c.champ==="Akali" && a.slot==="W"){ u.en.bonus={v:100, until:t+(dvOf(a.S,"baseduration",a.rank)||5)}; enGain(u, dvOf(a.S,"energyrestore",a.rank)||100, t, "Twilight Shroud"); } }
    // the caster's own windows from the ability's page (P3; a.p.grants, SIM_INTERIM until P1): untargetable / stasis (modelled as
    // stasis: nothing lands on it, it doesn't act) and invulnerable (0 damage; still targetable, crowd control still applies).
    // A window from the press applies to the whole press step (the tick loop: castStartSlot); a later one starts at press + start.
    castGrants(u, a, t);
    // dashes and blinks move the caster: toward the target (to touching distance, at most the dash range) or away from a chaser (o.away)
    const d0 = tgt ? gap(u,tgt) : 0;
    { const km=CHAMP_MECH[u.c.champ]; if (!o.away && km && km.startCast && km.startCast(u, a, tgt, t, d0)) return; }   // champion kits: delayed resolution (Zed R)
    a.castAt=t;   // when this cast started (a kit timing a recast from the cast, not the dash's arrival: Akali R2)
    { const km=CHAMP_MECH[u.c.champ]; if (km && km.pressCast) km.pressCast(u, a, tgt, t); }   // champion kits: state set at the press (Syndra's sphere and charges)
    /* backlog 25: WHEN the effects land. At the press: cooldown, cost, cast lock, untargetability, the "casts" line and the on-cast
       item effects (castStart: Spellblade, Rod of Ages, Hexplate…). The hits, crowd control, marks, on-hit effects and the kit's
       onCast/afterCast land at press + landOf(): the cast time, then the flight to the target and any appear-delay (landTime, the
       rule .arrival and canDodge use); self-casts and dashes after the cast time. The landing is lost if the caster dies before
       the cast time ends, or is disabled during a channel / charge (cancelCasts; item 28: crowd control doesn't cancel a cast
       time, wiki Cast time); after that it lands anyway. */
    const ct=Math.max(0, (a.p && a.p.castTime) || 0), land=landOf(u,a,tgt,d0), chan = a.p && a.p.delayKind==="channel" ? (a.p.delay||0) : 0;
    if (a.p && a.p.charge && tgt) u.nextAct=Math.max(u.nextAct, t+land);   // a charged cast (Xerath Q): charging and the release lockout hold the caster
    if (chan){ u.nextAct=Math.max(u.nextAct, t+ct+chan); u.nextAA=Math.max(u.nextAA, t+ct+chan); }   // a channel after the cast (Karthus R): he does nothing else meanwhile
    // until P.end death cancels it; crowd control only once its channel has started (P.chanFrom; wiki Cast time, item 28)
    const P={slot:a.slot, end:t+ct+chan, chanFrom: inTable(CHARGE_CAST, u.c.champ, a.slot) ? t : chan ? t+ct : null, charge: inTable(CHARGE_CAST, u.c.champ, a.slot), done:false, cancelled:false}, step=u.curStep ?? null;
    if (chan && ct >= dt/2-1e-9) events.push({at:t+ct, fn:(tt)=>{ if (P.cancelled || P.done || !u.alive) return;   // stunned or silenced as the channel starts
      const s=unstopOn(u,tt); if ((locked(u,tt) || !canCast(u,tt)) && !(s && s.slot===a.slot)){ P.cancelled=true; say(tt, `  ${u.name}'s ${a.slot} channel can't start (the caster is disabled as its cast time ends): it doesn't land`); } }});
    // unstoppable abilities (UNSTOPPABLE, item 28): the immunity window, from the press or the dash's start until the landing
    const US=unstopOf(u, a);
    if (US){ u.unstop={imm:US.imm, slot:a.slot, why:US.why, from: US.from==="press" ? t : US.from==="dash" ? t+ct : t+US.from, until: US.fixedUntil!=null ? t+US.fixedUntil : t+Math.max(ct, land), fixed:US.fixedUntil!=null};
      if (US.ccFor) u.ccImmuneUntil=Math.max(u.ccImmuneUntil||0, t+US.ccFor);   // Zaahen R: CC immune over the cast, then displacement immune
      simNotes.add(`${u.name} ${a.slot}: unstoppable — ${US.why}; ${US.imm==="cc"?"immune to all crowd control":"immune to airborne, sleep and the special-cased suppressions; other crowd control still applies but can't stop it"} from ${US.from==="press"||US.from===0?"the press":US.from==="dash"?"the end of its cast time":`${fmt(US.from)} s after the press`} ${US.fixedUntil!=null?`until ${fmt(US.fixedUntil)} s after it`:"until it lands"}; spell shields still block it`);
      if (US.from==="press" || US.from===0) unstopClean(u, t); }
    // the numbers at the press: another cast of this ability before this one lands recomputes a.parts (abNums)
    const snap={parts:a.parts, later:a.later, heal:a.heal, shield:a.shield, shieldN:a.shieldN};
    const L={started:false, castOk: tgt ? inReach(u,a,tgt) : false, pressT:t, land, deferred:false};
    targetWatch(u, a, tgt, t, ct, land, P, L, {cd0, ammo0, en0});
    const hsAt = a.p && a.p.delivery!=="self" && tgt && !a.dash ? ct + (u.script && !u.scriptTravel ? 0 : flightTime(a.p, d0)) : ct;
    const km0=CHAMP_MECH[u.c.champ], hsWithLanding = !!(km0 && km0.onCast) && !(km0.shieldAtCast||[]).includes(a.slot);   // kits may change the heal or shield in onCast
    const support=(tt)=>{
      if (a.heal){ const ts = supportTargets(u,a,tt,true) || [u]; if (!a.parts.length && a.saidAt!==tt && !L.deferred) say(tt, `${u.name} casts ${a.slot}`); for (const x of ts) if (x.alive) heal(u,x,a.heal,tt,`${a.slot}`); }
      if (a.shield){ const ts = supportTargets(u,{...a, heal:0},tt,true) || [u]; if (!a.parts.length && !a.heal && a.saidAt!==tt && !L.deferred) say(tt, `${u.name} casts ${a.slot}`);
        for (const x of ts){ if (!x.alive) continue; shield(u,x,a.shield,a.shieldDur,tt,`${a.slot}`); if (a.ccImmune && x.shields.length){ x.shields[x.shields.length-1].ccImmune=true; say(tt, `  ${x.name} is immune to crowd control while the shield holds`); } } } };
    // run fn at press + at (now when under half a step), as the combo step that pressed it; the landing counts for that step
    const later=(at, fn)=>{ if (at < dt/2-1e-9){ fn(t); return; }
      events.push({at:t+at, fn:(tt)=>{ if (P.cancelled) return; const prev=u.curStep, b=u.dealt, pa=a.parts, pl=a.later, ph=a.heal, psh=a.shield, pn=a.shieldN;
        u.curStep=step; u.kitT=tt; a.parts=snap.parts; a.later=snap.later; a.heal=snap.heal; a.shield=snap.shield; a.shieldN=snap.shieldN;
        fn(tt);
        if (a.parts===snap.parts){ a.parts=pa; a.later=pl; a.heal=ph; a.shield=psh; a.shieldN=pn; }   // keep what a later press computed, unless the kit replaced it
        u.curStep=prev; if (u.script && step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }}); };
    if (ct >= dt/2-1e-9 || land >= dt/2-1e-9){ u.pend=(u.pend||[]).filter(Q=>!Q.done && !Q.cancelled); u.pend.push(P); }
    let dashed=false;
    if (a.dash && (!u.script || (u.scriptTravel && tgt && !o.away && !a.blink)) && (tgt || o.away) && canDash(u,t)){
      if (!a.di){ try { a.di=dashInfo(u.c, a.slot); } catch(err){ a.di={dist:0, time:0, castTime:0, blink:a.blink}; } }
      const di=a.di, ref=o.away||tgt;
      // P3, DECISIONS 21 (a.p.leapTo "press": Jayce hammer Q): the leap goes to where the target stood at the press
      const pressX = !o.away && tgt && a.p && a.p.leapTo==="press" ? (tgt.xS ?? tgt.x) : null;
      const dest=()=>{ if (pressX!=null){ const dir = pressX===u.x ? face(u) : Math.sign(pressX-u.x); return u.x+dir*Math.min(di.dist, Math.max(0, Math.abs(pressX-u.x)-RAD(u)-RAD(tgt))); }
        const dir = o.away ? (u.x===ref.x ? -face(u) : Math.sign(u.x-ref.x)) : (ref.x===u.x ? face(u) : Math.sign(ref.x-u.x));
        return o.away ? clampRoom(u, u.x+dir*di.dist) : u.x+dir*Math.min(di.dist, Math.max(0, gap(u,tgt)-RAD(u)-RAD(tgt))); };
      const by=Math.abs(dest()-u.x), dct=Math.max(0, di.castTime||0);
      if (by>1){ dashed=true;
        // the dash starts when the cast time ends (backlog 25); its hits land when it arrives, a blink's at once
        const dur = a.blink ? 0 : Math.max(0.05, (di.time-di.castTime)*by/Math.max(1,di.dist)), arrive=dct+dur;
        if (US && !u.unstop.fixed){ if (US.from==="dash") u.unstop.from=t+dct; u.unstop.until=t+arrive; }
        /* item 28 (wiki Cast time, Dash, Types of Crowd Control § Airborne): the dash starts when the cast time ends whatever
           happened to the caster meanwhile (the newest movement overrides an older displacement); only a displacement or knockdown
           landing in the step it starts stops it (it would override the dash), and for DASH_CC_STOPS dashes an immobilize or
           polymorph on the caster. Unstoppable dashes (UNSTOPPABLE) start regardless. */
        const ccStops=inTable(DASH_CC_STOPS, u.c.champ, a.slot); let D=null;
        const move=(tt)=>{ if (!u.alive) return false;
          if (unstopOn(u,tt)) unstopClean(u,tt);
          else if (u.dashStopAt!=null && u.dashStopAt>=tt-1e-9){ say(tt, `  ${u.name}'s ${a.slot} dash is stopped (${u.dashStopWhy} as it starts; wiki Dash)`); return false; }
          else if (ccStops && (locked(u,tt) || ccOn(u,tt,"polymorph") || u.immobAt>=tt-1e-9)){ say(tt, `  ${u.name}'s ${a.slot} dash is stopped (immobilized: this dash is interrupted by crowd control, wiki Dash)`); return false; }
          const to=dest(), by2=Math.abs(to-u.x); if (u.move && u.move.forced && u.move.t0<tt-1e-9) u.move=null;   // overrides an older displacement
          if (a.blink) displace(u, to, 1e-3, tt);   /* lands at the start of the next tick */ else displace(u, to, dur, tt);
          D={slot:a.slot, t0:tt, t1:tt+(a.blink?0:dur), to, ccStops, stopped:false}; u.dashNow=D;
          say(tt, `${u.name} ${a.blink?"blinks":"dashes"} ${fmt(by2)} units ${o.away?`away from ${o.away.name}`:`toward ${tgt.name}`} (${a.slot})${a.blink?"":` in ${fmt(dur)}s`}${unstopOn(u,tt)?` (${u.unstop.imm==="cc"?"immune to crowd control":"unstoppable: displacement immune"})`:""}`); return true; };
        simNotes.add(`fight(): dashes and blinks use the game data dash range and speed (dashInfo); they start when the cast time ends (crowd control during the cast time doesn't stop them: wiki Cast time), a dash's hits land when it arrives, a blink's at once; a displacement or knockdown during the dash stops it and its hits (wiki Dash), a stun or root doesn't`);
        if (u.script) u.nextAct=Math.max(u.nextAct, t+arrive);   // perform(): the next step comes after the dash lands
        // the hit: lost if the dash was stopped; the reach is tested where the dash ends (item 28: a dash pressed from its dash range
        // but beyond the ability's reach hits once it arrives in reach; the press-time reach also counts: targeted dashes track)
        const hit=(tt)=>{ if (!u.alive) return; if (u.dashNow===D) u.dashNow=null; if (D && D.stopped){ P.done=true; return; } P.done=true;
          const px = a.blink && D ? D.to : (u.xS ?? u.x), arrOk = !!tgt && Math.abs(px-(tgt.xS ?? tgt.x)) <= (pressX!=null ? (a.p.leapRadius||0)+RAD(tgt) : abReach(u,a,tgt))+1e-6;
          if (pressX!=null && !arrOk) say(tt, `  ${u.name}'s ${a.slot} lands where ${tgt.name} stood at the press: ${tgt.name} isn't there (DECISIONS 21)`);
          resolveCast(u,a,tgt,tt,d0,{...L, deferred:tt>t, castOk: pressX!=null ? arrOk : L.castOk || arrOk}); if (!hsWithLanding) return; support(tt); };
        // P3: untargetable during a dash (a.p.untargetableDash: Maokai W) from the press to the arrival; a watched targeted dash
        // (a.p.inFlight: Jarvan IV R, DECISIONS 13): the target untargetable during it takes nothing, he still lands (the kit's arena)
        if (a.p && a.p.untargetableDash){ castStasis(u, t+arrive, t); say(t, `${u.name} is untargetable until the ${a.slot} dash arrives (${fmt(t+arrive)}s; wiki)`); }
        if (a.p && a.p.inFlight) flightWatch(u, a, tgt, t, dct, arrive, P, L);
        if (a.blink){ later(dct, (tt)=>{ if (move(tt)) hit(tt); else P.done=true; }); if (!hsWithLanding) later(dct, support); }
        else { let ok=true; later(dct, (tt)=>{ ok=move(tt); }); later(arrive, (tt)=>{ if (ok) hit(tt); else P.done=true; }); if (!hsWithLanding) later(Math.min(hsAt, arrive), support); }
        if (dct >= dt/2-1e-9 || arrive >= dt/2-1e-9) castStart(u, a, t), L.started=true;
      }
    }
    // an empowered next attack (EMPOWER_NEXT, backlog 25 step 7): the press arms it (and resets the attack timer where the wiki
    // says so); its damage and crowd control land with the next basic attack within the window (autoAttack → landEmpower)
    const EMP = ATTACK_TIMING && !dashed && !u.pet && (EMPOWER_NEXT[u.c.champ]||{})[a.slot];
    if (EMP){ castStart(u, a, t); P.done=true;
      if (EMP.reset) u.nextAA=Math.min(u.nextAA, t);
      u.empower={a, until:t+EMP.win, snap:{...snap}, d0, L:{...L, started:true, deferred:true, castOk:true}};
      say(t, `${u.name} casts ${a.slot}: empowers the next attack within ${fmt(EMP.win)}s${EMP.reset?" (attack reset)":""}`); a.saidAt=t;
      simNotes.add(`${u.name} ${a.slot}: empowers the next basic attack within ${fmt(EMP.win)} s${EMP.reset?" and resets the attack timer":""} (wiki); its damage and crowd control land with that attack${u.script?" (a combo needs an AA step after it)":""}`);
      return; }
    if (!dashed){
      const deferred = land >= dt/2-1e-9;
      if (deferred){ castStart(u, a, t); L.started=true; L.deferred=true;
        say(t, `${u.name} casts ${a.slot}${tgt && (a.parts.length || (a.cc||[]).length) ? ` at ${tgt.name}: lands at ${fmt(t+land)}s` : ""}`); a.saidAt=t;
        if (land > ct+1e-9) simNotes.add(`${u.name} ${a.slot}: lands ${fmt(land)}s after the press (cast time ${fmt(ct)}s${land-ct>1e-9?` + ${fmt(land-ct)}s flight/delay`:""}; backlog 25)`); }
      const both = hsWithLanding || Math.abs(hsAt-land) < 1e-9;
      later(land, (tt)=>{ P.done=true; resolveCast(u,a,tgt,tt,d0,L); if (both) support(tt); });
      if (!both) later(hsAt, support);
    }
  }
  /* the landing time of a cast in fight()/perform() (backlog 25): landTime (cast time + flight + appear-delay) at the live distance,
     except: dashes and self-casts (and casts with nothing to hit) land when the cast time ends; channels start after the cast time +
     flight; perform() without distance: ignores positions (no flight); kits that time their own effects (CHAMP_MECH timing):
     "own" = at the press (the kit schedules everything), "cast" = after the cast time, "travel" = cast time + flight (the data's
     delay is a later part the kit schedules itself) */
  function landOf(u, a, tgt, d0){
    const p=a.p; if (!p) return 0;
    const km=CHAMP_MECH[u.c.champ], mode=km && km.timing ? km.timing[a.slot] : null; if (mode==="own") return 0;
    const ct=Math.max(0, p.castTime||0), noPos = u.script && !u.scriptTravel;
    if (p.charge && tgt) return landTime(p, noPos ? 0 : d0);                          // Xerath Q: charge to reach the target, then the release lockout
    const chan = p.delayKind==="channel" ? (p.delay||0) : 0;   // a channel after the cast (Karthus R): lands when it completes
    if (mode==="cast" || a.dash || p.delivery==="self" || !tgt || (!a.parts.length && !(a.cc||[]).length && !(a.later||[]).length)) return ct + (mode==="cast" ? 0 : chan);
    const tr = noPos ? (p.fixedTravel || p.minTravel || 0) : flightTime(p, d0);
    // a missile launched at the press (p.flightFrom "press": Syndra R, DECISIONS 5) flies during the cast time, as in landTime
    return (p.flightFrom==="press" && !noPos ? 0 : ct) + tr + (mode==="travel" || a.channel ? 0 : (p.delay||0)) + (km && km.landAdd ? km.landAdd(u, a, tgt, d0) : 0);   // a kit's own flight (Syndra W's throw)
  }
  // effects at the press of any cast (backlog 25: they don't wait for the landing): Spellblade, mana-spent heals, ultimate procs
  function castStart(u, a, t){
    // Spellblade: an ability cast empowers the next attack (not while Spellblade is on cooldown)
    if (SPELLBLADE.some(k=>has(u,k)) && t>=u.sb.cd){ const k=SPELLBLADE.find(k=>has(u,k)); u.sb.ready=true; u.sb.until=t+idv(k,"SpellBladeDuration",10);
      if (k==="lichbane" && u.lastAAt>-10){ const as=asOf(u, idv("lichbane","SheenASBuff",0.5)); u.nextAA=Math.min(u.nextAA, u.lastAAt+1/as); } }
    // mana spent heals (Rod of Ages / Catalyst Eternity)
    if (has(u,"rodofages")||has(u,"catalystofaeons")){ const k=has(u,"rodofages")?"rodofages":"catalystofaeons"; const cost=(a.S.cost||[])[Math.max(1,a.rank||1)-1]||0; if (cost>0) heal(u,u,Math.min(idv(k,"EternityMaxHealPerCast",20), idv(k,"EternityHealthRestore",0.25)*cost),t,null); }
    if (a.slot==="R"){
      if (has(u,"experimentalhexplate") && ready(u,"hexplate",t)){ setcd(u,"hexplate",t,idv("experimentalhexplate","Cooldown",30)); addBuff(u,"overdrive",t+idv("experimentalhexplate","HasteDuration",8),{bonusAS:(u.ranged?idv("experimentalhexplate","BonusASRanged",35):idv("experimentalhexplate","BonusASMelee",50))/100},t); say(t, `  ${u.name}: Hexplate Overdrive`); }
      if (has(u,"fiendhunterbolts") && ready(u,"fiend",t)){ setcd(u,"fiend",t,idv("fiendhunterbolts","Cooldown",45)); u.fiend={n:idv("fiendhunterbolts","NumberOfAttacks",3), until:t+idv("fiendhunterbolts","Duration",8)};
        if (u.lastAAt>-10) u.nextAA=Math.min(u.nextAA, u.lastAAt+1/asOf(u, idv("fiendhunterbolts","BonusAS",0.5))); }
      if (has(u,"zekesconvergence") && ready(u,"zeke",t)){ setcd(u,"zeke",t,idv("zekesconvergence","Cooldown",45)); for (const x of enemiesOf(u,t)) addDot(u,x,t,"zeke","Frostfire Tempest",idv("zekesconvergence","DamagePerSecond",30),idv("zekesconvergence","Duration",5),0); }
    }
  }
  // L (backlog 25, from cast()): {started: castStart already ran at the press, castOk: the target was in reach at the press,
  // pressT, deferred: landing after the press}. Kits that call resolveCast themselves (Zed) pass none: everything happens now.
  function resolveCast(u, a, tgt, t, d0, L){
    if (!L || !L.started) castStart(u, a, t);
    const km=CHAMP_MECH[u.c.champ], ktg=tgt||enemiesOf(u,t)[0]||null; if (km && km.onCast){ a.land=L; km.onCast(u, a, ktg, t); }
    if (a.parts.length && tgt){
      const targets = hitList(u,a,tgt,t,L).filter(x=>!(L && L.voided && x===tgt));   // P3: a targeted hit voided in flight (flightWatch)
      if (!targets.length && !u.script) say(t, L && L.deferred ? `${u.name}'s ${a.slot} misses ${tgt.name}${!L.castOk ? ` (out of reach at the cast: ${fmt(d0)} > ${fmt(abReach(u,a,tgt))})` : !tgt.alive ? " (dead)" : L.voided ? ` (untargetable while it was in flight, from ${fmt(L.voided)}s: its effect is voided)` : inStasis(tgt,t) ? " (untargetable as it lands)" : ""}`
        : `${u.name}'s ${a.slot} misses: ${tgt.name} is out of reach (${fmt(gap(u,tgt))} > ${fmt(abReach(u,a,tgt))})`);
      if (!(L && L.deferred && !targets.length)) say(t, `${u.name}${L && L.deferred ? `'s ${a.slot} lands` : ` casts ${a.slot}`}${a.aoe&&targets.length>1?` (area, ${targets.length} targets)`:""}`);
      let hitAny=false;
      targets.forEach((x, i)=>{
        // P3: spell shields per hit (shieldHit): "all" blocks the cast on x, "one" one hit (cut), "cc" its crowd control, "dmg" its damage
        const sh=shieldHit(u,a,x,t); if (sh==="all") return; hitAny=true;
        const cut = sh==="one" ? oneHitCut(u,a) : null, keep = cut && cut.n ? 1-1/cut.n : 1, noDmg = sh==="dmg";
        const parts = noDmg ? [] : cut && cut.first ? a.parts.slice(1) : a.parts;
        const tps = a.spread > 0 && a.S.onHit ? dvOf(a.S, "tickspersecond", a.rank) : 0, cid=u.casts;
        if (tps > 0){
          // a channel of separate hits that apply on-hit effects (Katarina R: a dagger every 1/6 s, wiki 0.166 s; each dagger is
          // its own hit for runes and on-hit items, wiki Death Lotus notes): one event per hit, damage split evenly
          const n=Math.round(a.spread*tps), step=u.curStep ?? null, raw=a.parts.map(p=>p);
          simNotes.add(`${u.name} ${a.slot}: ${n} separate hits over ${fmt(a.spread)}s (one every ${fmt(1/tps)}s, the first when the first one reaches the target: cast time + flight), each 1/${n} of the channel's damage`);
          const hitK=(k)=>(tt)=>{ if (!x.alive || !u.alive) return; if (a.channel && !u.script && !(u.chan && u.chan.id===cid)) return; const prev=u.curStep, b=u.dealt; u.curStep=step;
            const hp0=x.hp; for (const p of raw) deal(u,x,partDmg(p,x)/n,p.type,tt,"ability",`${a.slot} hit ${k+1}/${n}`);
            if (k===0) abilityItems(u,x,tt,a,i===0);
            onHit(u,x,tt,"ability",a); abilityOnHit(u,x,tt,a,hp0);
            u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; };
          // a spell shield took the first hit (Katarina R: 'will block and be consumed by only one dagger', wiki): the on-cast item
          // effects ride the first hit that lands
          const k0 = cut && cut.skip0 ? 1 : 0;
          for (let k=k0;k<n;k++){ const fn = k0 && k===k0 ? (tt)=>{ hitK(k)(tt); if (x.alive && u.alive) abilityItems(u,x,tt,a,i===0); } : hitK(k);
            if (k===0 && L && L.deferred) fn(t); else events.push({at:t+k/tps, fn}); }
        }
        else if (a.spread > 0){ parts.forEach((p,j) => x.dots.push({id:`${a.slot}-spread-${j}`, u, what:`${a.slot} over ${fmt(a.spread)}s`, dps:partDmg(p,x)*keep/a.spread, type:p.type, until:t+a.spread, start:t, next:t+0.5, rampAfter:0, step:u.curStep ?? null, ability:a, abilityDot:true})); }
        else for (const p of parts) deal(u,x,partDmg(p,x)*keep,p.type,t,"ability",a.slot);
        say(t, `  ${a.slot} hits ${x.name}${x.alive?` → ${fmt(x.hp)}/${fmt(x.max)}`:""}`);
        if (sh!=="cc"){ if (a.hardcc){ x.impairedBy=u; x.impairedUntil=t+1; } applyCC(u,a,x,t,d0); }   // "one": the other hits carry it
        passiveMarks(u,a,x,t);
        if (u.namiE) kitNamiHit(u, x, t, u.casts);   // Nami E on the caster: one charge per cast
        if (tps > 0) return;
        abilityItems(u,x,t,a,i===0);
        onHit(u,x,t,"ability",a);
        abilityOnHit(u,x,t,a);
      });
      if (hitAny) enOnHit(u, a, t);   // energy restores on a damaging cast (Kennen E, Shen Q/E; item 24)
    }
    if (!a.parts.length && (tgt || (a.p && a.p.delivery==="self")) && (a.immob || a.slows || (a.cc && a.cc.length))){ say(t, `${u.name}${L && L.deferred ? `'s ${a.slot} lands` : ` casts ${a.slot}`}`); a.saidAt=t;
      for (const x of hitList(u,a,tgt,t,L)){ if (L && L.voided && x===tgt) continue; { const sh=shieldHit(u,a,x,t); if (sh && sh!=="dmg") continue; } passiveMarks(u,a,x,t); if (a.hardcc){ x.impairedBy=u; x.impairedUntil=t+1; } ccItems(u,x,t,a); applyCC(u,a,x,t,d0); } }
    else if (!a.parts.length && !a.heal && !a.shield && !a.quiet && !(L && L.deferred)) say(t, `${u.name} casts ${a.slot}`);
    if (km && km.afterCast) km.afterCast(u, a, ktg, t);
    a.land=null;
  }
  /* ---- item actives ---- */
  function useActive(u, k, tgt, t, forced){
    const I=ITEMS[k], cdOf = dflt => idv(k,"Cooldown",dflt);
    if (!ready(u,"active:"+k,t)) return false;
    const go = s => { setcd(u,"active:"+k,t,s); say(t, `${u.name} uses ${I.name}`); };
    const foes=enemiesOf(u,t);
    switch (k){
      case "tiamat": case "ravenoushydra": case "profanehydra": case "stridebreaker": { if (!foes.length) return false; go(cdOf(10));
        const v = k==="tiamat" ? idv("tiamat","ActiveADRatio",0.75)*u.st.ad : k==="stridebreaker" ? itemCalc(u.st,k,"slashdamage") : k==="profanehydra" ? itemCalc(u.st,k,"slashdamagebase") : idv("ravenoushydra","ActiveADRatio",0.8)*u.st.ad;
        for (const x of foes) deal(u,x,v,"physical",t,"proc",I.name,{lifesteal:k==="ravenoushydra"}); return true; }
      case "titanichydra": go(cdOf(10)); u.titanicReady=true; return true;
      case "hextechgunblade": { if (!tgt) return false; go(cdOf(60)); deal(u,tgt,itemCalc(u.st,k,"activedamage"),"magic",t,"proc",I.name); onHit(u,tgt,t,"item"); return true; }
      case "hextechrocketbelt": { if (!tgt) return false; go(cdOf(50)); u.mobileUntil=t+4; for (const x of foes) deal(u,x,itemCalc(u.st,k,"fireboltdamage"),"magic",t,"proc",I.name); return true; }
      case "zhonyashourglass": case "seekersarmguard": { if (k==="seekersarmguard" && u.seekerUsed) return false; if (k==="seekersarmguard") u.seekerUsed=true; go(k==="seekersarmguard"?1e9:cdOf(120)); u.stasisUntil=t+idv(k,"Duration",2.5); return true; }
      case "redemption": { go(cdOf(90)); const h=itemCalc(u.st,k,"healamount"), R=idv("redemption","AOESize",550);
        // wiki Redemption: a 550-radius beam at the target location, 2.5 s later: heals allies and deals 10% max health true damage to
        // enemy champions inside it. Centre: the unit position (at cast) covering the most hurt allies + enemies (perfect aim), then
        // only units within 550 (+ hitbox) of it when it lands are affected.
        const inR = (x, cx) => Math.abs((x.xS ?? x.x)-cx) <= R+RAD(x), cands=U.filter(x=>x.alive).map(x=>x.xS ?? x.x);
        const score = cx => alliesOf(u).filter(x=>(x.hpS ?? x.hp)<x.max && inR(x,cx)).length + enemiesOf(u,t).filter(x=>inR(x,cx)).length;
        // ties: the spot nearest the caster, then the one further toward the enemy (mirror-symmetric, not U order)
        const better = (c, b) => { const sc=score(c), sb=score(b), ux=u.xS ?? u.x; if (sc!==sb) return sc>sb; const dc=Math.abs(c-ux), db=Math.abs(b-ux);
          if (Math.abs(dc-db)>1e-6) return dc<db; return face(u)*(c-ux) > face(u)*(b-ux); };
        const cx = cands.length ? cands.reduce((b,c)=>better(c,b)?c:b) : (u.xS ?? u.x);
        simNotes.add(`${u.name}: Redemption lands 2.5 s after the cast on a 550-radius area (wiki), aimed at the position covering the most hurt allies and enemies; only units inside it then are healed or damaged`);
        events.push({at:t+2.5, fn:(tt)=>{ for (const x of alliesOf(u)) if (inR(x,cx)) heal(u,x,h,tt,"Redemption"); for (const x of enemiesOf(u,tt)) if (inR(x,cx)) deal(u,x,idv("redemption","DamageToChampions",0.1)*x.max,"true",tt,"proc","Redemption"); }}); return true; }
      case "locketoftheironsolari": { go(cdOf(90)); const v=itemCalc(u.st,k,"shieldamount"); for (const x of alliesOf(u)) shield(u,x,v,idv(k,"ShieldDuration",2.5),t,"Locket"); return true; }
      case "mikaelsblessing": { const x=forced ? (alliesOf(u).filter(y=>y!==u).sort((a,b)=>pct(a)-pct(b))[0]||u) : tgt; if (!x) return false; go(cdOf(120)); heal(u,x,itemCalc(u.st,k,"amounttoheal"),t,"Mikael's Blessing");
        const gone=x.ccs.filter(c=>c.until>t && MIKAEL_CLEANSES(c.type)).map(c=>c.type); if (gone.length){ x.ccs=x.ccs.filter(c=>!MIKAEL_CLEANSES(c.type)); x.slows=[]; say(t, `  Mikael's Blessing cleanses ${[...new Set(gone)].join(", ")} from ${x.name}`); } return true; }
      case "actualizer": go(cdOf(60)); u.actUntil=t+idv(k,"Duration",8); return true;
      case "healthpotion": case "refillablepotion": { if (!(u.charges[k]>0) || u.potUntil>t) return false; u.charges[k]--; const d=idv(k,"PotionDuration",15), h=idv(k,"HealAmount",120); u.potUntil=t+d; say(t, `${u.name} drinks a ${I.name}`);
        for (let i=1;i<=d*2;i++) events.push({at:t+0.5*i, fn:(tt)=>heal(u,u,h/(d*2),tt,null)}); return true; }
      default: go(cdOf(90)); return true;   // move speed, slows and cleanses: no fight effect (see assumptions)
    }
  }
  function order(u){ const r=u.rotation ? u.rotation.split("").filter(s=>"QWER".includes(s)) : ["R","Q","E","W"]; return r.filter(s=>u.ab[s]); }
  /* ---- champion audit helpers (CHAMP_MECH) ---- */
  // Kalista's Oathsworn (bound for the whole game with the Black Spear): kalista.oathsworn = ally, else the ally with the Support
  // class (kb classes), else the ally with the least AD + AP; chosen once from the whole team, so a dead Oathsworn isn't replaced
  function kitOathsworn(u){ const K=u.kit;
    if (K.oath===undefined){ const team=U.filter(x=>x.side===u.side && x!==u && !x.pet), want=u.c.opts && u.c.opts.oathsworn;
      if (want) K.oath=team.find(x=>sameChamp(x,want)) || null;
      else { const sup=team.filter(x=>WORLD.champ(x.c.champ).classes.includes("Support")), pool=sup.length ? sup : team;
        K.oath=pool.slice().sort((a,b)=>(a.st.ad+a.st.ap)-(b.st.ad+b.st.ap))[0] || null; }
      if (K.oath) simNotes.add(`${u.name}: the Oathsworn is ${K.oath.name} (${want ? "set with .oathsworn" : "default: the Support-class ally, else the ally with the least AD + AP; set kalista.oathsworn = ally"})`);
      else if (want) simNotes.add(`${u.name}: the Oathsworn set with .oathsworn is not in her team`); }
    return K.oath && K.oath.alive ? K.oath : null; }
  // Kalista W passive, Soul-Marked (wiki Sentinel): while tethered, Kalista's and the Oathsworn's attacks (and Pierce) mark the
  // target for 4 s; when both marks are on one enemy they are consumed for 10–18% of its maximum health as magic damage (dealt by
  // Kalista), at most once per target every 10 s (PerTargetCooldown). Assumed tethered (within range) all fight.
  function kitSoulMark(u, x, t){ if (!x || !x.alive) return;
    for (const k of U){ if (k.side!==u.side || !k.alive || k.c.champ!=="Kalista" || !k.abAll.W) continue;
      const mine = k===u; if (!mine && kitOathsworn(k)!==u) continue;
      const A=k.abAll.W, M=(x.soulMark ||= {}), m=(M[k.name] ||= {k:-9, o:-9, cd:-1}), dur=dvOf(A.S,"markduration",A.rank)||4;
      if (t < m.cd) continue;
      if (mine) m.k=t; else m.o=t;
      if (t-m.k<=dur && t-m.o<=dur){ m.k=m.o=-9; m.cd=t+(dvOf(A.S,"pertargetcooldown",A.rank)||10);
        deal(k,x,(dvOf(A.S,"maxhealthdamage",A.rank)||0)*x.max,"magic",t,"proc","Soul-Marked");
        simNotes.add(`${k.name} W: Soul-Marked — when Kalista and her Oathsworn both hit the same enemy within 4 s, ${fmt((dvOf(A.S,"maxhealthdamage",A.rank)||0)*100)}% of its maximum health as magic damage, once per target every 10 s (tether assumed); the Sentinel itself deals no damage and isn't cast`); } } }
  // Brushmaker: Ivern's brush empowers his and his allies' attacks (wiki Ivern_W; allies need Ivern within 1000, assumed)
  function kitBrushBolts(u, tgt, t){ for (const iv of U) if (iv.side===u.side && iv.alive && iv.c.champ==="Ivern" && iv.kit.brushUntil>t){
      const A=iv.abAll.W; if (!A) continue; const own = iv===u || (u.pet && u.pet.owner===iv);   // Daisy's attacks fire Ivern's own bolt (wiki)
      const v=evalCalc({S:A.S, rank:A.rank, st:iv.st, flags:iv.flags}, own ? "totaldamage" : "totalallydamage").v;
      deal(u,tgt,v,"magic",t,"proc",own?"Brushmaker":"Brushmaker (ally)"); } }
  // Ivern R, Daisy (wiki Ivern, Pets): a real unit in fight(). Health 1000 at level 6, +50 per level to 10, +400 per level from 11
  // (2400 at 13, 4400 at 18) (+50% AP); armor and MR 30 to 90 over levels 6–18 (+5 per level); attack damage 70/100/130 (+15% AP)
  // physical (game data totaldaisyad); attack speed 0.75 × (1 + 30/45/60%) = 0.975/1.0875/1.2 (DaisyAS); 175 range, 430 move speed.
  // She lands 350 units in front of Ivern 0.5 s after the cast and stays up to 45 s (game data DaisyDuration and the wiki ability
  // text; the coordinator's 60 s isn't in either source) or until killed. Daisy Smash!: her attack on a target with 2 stacks is instead
  // a shockwave in a line (800 × 200): 90/140/190 (+50% AP) magic damage, stun + knock-up 1 s, then 3 s before the next.
  // Policy: she attacks the nearest enemy champion; enemy champions target her only when no enemy champion is in their reach; area
  // abilities hit her like anyone standing there. Not modelled: her 25% area/epic damage reduction and spawn damage reduction, her
  // hitbox (100; the dummy-sized one grows with health), Ivern's on-hit items on her attacks. Her damage is credited to Ivern.
  function kitDaisy(u, a, tgt, t){ const S=a.S, r=a.rank, ev=k=>evalCalc({S, rank:r, st:u.st, flags:u.flags}, k).v;
    const L=Math.max(6, u.st.level), hp=(L<=10 ? 1000+50*(L-6) : 1200+400*(L-10)) + 0.5*u.st.ap, res=30+5*(L-6);
    const ad=ev("totaldaisyad"), as=0.75*(1+(dvOf(S,"daisyas",r)||45)/100), dur=dvOf(S,"daisyduration",r)||45, smash=ev("totalshockwavedamage");
    simNotes.add(`${u.name} R: Daisy is a unit (${fmt(hp)} health, ${fmt(res)} armor and MR, ${fmt(ad)} physical per attack, ${fmt(as)} attacks/s, up to ${fmt(dur)} s); every third attack on one target is Daisy Smash! (${fmt(smash)} magic, stun + knock-up 1 s, 3 s lockout). She attacks the nearest enemy champion; enemies attack her only when no champion is in their reach; area damage hits her. Her damage counts as Ivern's`);
    events.push({at:t+0.5, fn:(tt)=>{ if (!u.alive) return;
      const c={t:"champ", champ:DUMMY_ID, level:L, ranks:{}, items:[], runes:[], opts:{}, dummy:{hp, armor:res, mr:res, warn:[]}, label:"Daisy"};
      const d=makeUnit(c, u.side); d.name=`Daisy (${u.name})`; d.dummy=false; d.passive=false; d.role="dive";
      const D={n:0, on:null, smashAt:-9};
      d.pet={owner:u, until:tt+dur, mech:{attack(d2, x, t2){
        if (x!==D.on){ D.on=x; D.n=0; }
        if (D.n>=2 && t2>=D.smashAt){ D.n=0; D.smashAt=t2+(dvOf(S,"shockwavecd",r)||3); const cx=x.xS ?? x.x;
          for (const y of enemiesOf(d2,t2)) if (y!==x && Math.abs((y.xS ?? y.x)-cx) <= 100+RAD(y)){ deal(d2,y,smash,"magic",t2,"ability","Daisy Smash!"); applyCC(d2, {slot:"R", S, p:{}, cc:[{type:"stun", dur:1}, {type:"knockup", dur:1}], hard:true}, y, t2, 0); }
          applyCC(d2, {slot:"R", S, p:{}, cc:[{type:"stun", dur:1}, {type:"knockup", dur:1}], hard:true}, x, t2, 0);
          return {replace:{v:smash, type:"magic", what:"Daisy Smash!"}}; }
        D.n=Math.min(2, D.n+1); return null; }}};
      addBuff(d, "daisy", Infinity, {bonusad:ad, bonusAS:as/(d.st.baseas||0.658)-1, mspct:430/(d.st.basems||370)-1}, tt);
      d.hp=d.max; d.x=d.x0=u.x+face(u)*350; U.push(d);
      say(tt, `  ${u.name}: Daisy! lands (${fmt(d.max)} health)`);
      if (!U.some(x=>x.script)) events.push({at:tt+dur, fn:(t3)=>{ if (d.alive){ d.alive=false; d.pet.expired=true; say(t3, `  ${d.name} leaves (${fmt(dur)} s)`); } }}); }}); }
  // Yasuo / Yone Steel Tempest / Mortal Steel: a hit gives a Gathering Storm stack (6 s, max 2); the cast at 2 stacks is the
  // empowered third cast, the only one that knocks up (wiki). onCast: before the hit (choose the crowd control); after: stack.
  function kitGatheringStorm(u, a, t, after){ const K=u.kit, G=K.storm && K.storm.until>t ? K.storm : {n:0};
    if (!after){ a.ccAll ??= a.cc||[]; K.q3 = G.n>=2; a.cc = K.q3 ? a.ccAll : a.ccAll.filter(e=>!AIRBORNE.has(e.type)); if (K.q3) K.storm=null;
      simNotes.add(`${u.name} Q: two hits give Gathering Storm; only the third, empowered cast knocks up (wiki)`); return; }
    if (!K.q3) K.storm={n:Math.min(2, G.n+1), until:t+(dvOf(a.S,"gatheringstormduration",a.rank)||dvOf(a.S,"buffduration",a.rank)||6)}; }
  // Yasuo / Yone: Gathering Storm stacks from before the fight (x.stacks = 2: Q3 ready at the start; they last 6 s)
  function kitStormStart(u){ const n=kitStacks(u.c), Q=u.abAll.Q; if (!(n>0)) return;
    u.kit.storm={n, until:(Q && (dvOf(Q.S,"gatheringstormduration",Q.rank)||dvOf(Q.S,"buffduration",Q.rank))) || 6};
    simNotes.add(`${u.name} starts with ${fmt(n)} Gathering Storm stack${n>1?"s":""}${n>=2?" (the next Q is the empowered third cast)":""} (set with .stacks; they last 6 s)`); }
  const kitAirborne = (u, t) => enemiesOf(u,t).some(x=>(x.ccs||[]).some(c=>c.until>t && AIRBORNE.has(c.type)));
  // a kit part dealt later (recasts, delayed explosions, ticks), counted on the step that started it
  function kitLater(u, x, at, p, what){ const step=u.curStep ?? null;
    events.push({at, fn:(tt)=>{ if (!x.alive || !u.alive) return; const prev=u.curStep, b=u.dealt; u.curStep=step;
      deal(u,x,partDmg({...p, pct:!!p.pctOf},x),p.type,tt,"ability",what);
      if (u.c.champ==="Smolder") kitSmolderExecute(u, x, tt);
      u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }}); }
  /* ---- cast-start untargetability and energy (item 24; tables CAST_UNTARGETABLE / ENERGY_CHAMPS) ---- */
  // a state gained at the cast start: the tick loop makes it count for the whole step (u.castStasisAt)
  function castStasis(u, until, t){ u.stasisUntil=Math.max(u.stasisUntil, until); u.castStasisAt=t; }
  function numWin(w){ return Array.isArray(w) && typeof w[0]==="number" && typeof w[1]==="number" && w[1]>w[0]; }
  /* P3 (interaction audit): the caster's own windows from the ability's page (a.p.grants; replaces the hand table CAST_UNTARGETABLE).
     Kits that set their own (KIT_OWN_GRANTS) are skipped; GRANT_NOTES adds a longer lockout (Master Yi Q) and the log text. */
  function castGrants(u, a, t){ const k=`${u.c.champ}.${a.slot}`; if (!a.p || KIT_OWN_GRANTS.has(k)) return;
    const G=a.p.grants||{}, N=GRANT_NOTES[k]||{}; let hide=null;
    for (const kind of ["untargetable","stasis"]){ const w=grantWin(G[kind], k, a.rank, a.slot); if (w) hide = hide ? [Math.min(hide[0],w[0]), Math.max(hide[1],w[1])] : w; }
    if (hide){ const [s,e]=hide, lock=N.lock ?? e;
      if (s < dt/2-1e-9) castStasis(u, t+e, t); else events.push({at:t+s, fn:()=>{ if (u.alive) u.stasisUntil=Math.max(u.stasisUntil, t+e); }});
      u.nextAct=Math.max(u.nextAct, t+lock); u.nextAA=Math.max(u.nextAA, t+lock);
      say(t, `${u.name} casts ${a.slot}: untargetable ${s>=dt/2?`from ${fmt(t+s)}s `:""}until ${fmt(t+e)}s`);
      simNotes.add(`${u.name} ${a.slot}: ${N.why || `untargetable ${fmt(s)}–${fmt(e)} s after the press (wiki)`} (modelled as stasis: nothing lands on it and it doesn't act)`); }
    const iv=grantWin(G.invulnerable, k, a.rank, a.slot);
    if (iv){ (u.invuln ||= []).push({from:t+iv[0], until:t+iv[1], slot:a.slot});
      simNotes.add(`${u.name} ${a.slot}: ${N.why || `invulnerable ${fmt(iv[0])}–${fmt(iv[1])} s after the press (wiki)`}: it takes no damage, crowd control still lands`); }
    const F=a.p.invulnFar;
    if (F){ (u.invuln ||= []).push({from:t+F.from, until:t+F.until, beyond:F.beyond, slot:a.slot});
      simNotes.add(`${u.name} ${a.slot}: invulnerable ${fmt(F.from)}–${fmt(F.until)} s after the press only to enemies farther than ${fmt(F.beyond)} units (centre to centre; wiki)`); } }
  /* P3 (interaction audit) — a unit-targeted cast on an enemy, watched step by step between the press and the landing:
     - DECISIONS 3: during the cast time, the target turning untargetable / stasis (both modelled as stasis), invisible, or leaving the
       ability's reach cancels the cast: no cooldown, no cost (refunded), the caster is free the next step — unless the page documents a
       bug that still spends them (a.p.cancelSpends: Lulu W, Evelynn W, Sejuani E; DECISIONS 1). a.p.cancelOn narrows the list
       (DECISIONS 27: Fiddlesticks Q keeps casting on an unseen target; Syndra R's spheres are already flying; Rek'Sai R).
     - in flight (from the launch — the end of the cast time, or the press for a.p.flightFrom "press" — to the landing): the target
       untargetable / in stasis at any step voids the hit (L.voided) for a.p.inFlight "invalidated" | "destroyed" (the default for
       targeted missiles; DECISIONS 5, 10, 31); "hits" keeps today's rule (only the landing step counts). A targeted dash is watched only
       when its data says so (Jarvan IV R, DECISIONS 13: he still lands and the arena forms, the target takes nothing).
     The steps checked are those strictly before the landing step (which hitList already checks). Dashes, kits timing their own
     effects and scripted combos without positions aren't watched. */
  function targetWatch(u, a, tgt, t, ct, land, P, L, R){
    if (!tgt || tgt.side===u.side || !unitTargeted(a) || tgt.pet) return;
    const p=a.p, km=CHAMP_MECH[u.c.champ]; if (km && km.timing && km.timing[a.slot]==="own") return;
    const on = p.cancelOn || ["untargetable","stasis","invisible","range"], hid=(tt)=>inStasis(tgt,tt) && (on.includes("untargetable") || on.includes("stasis"));
    if (on.length && ct >= dt-1e-9) for (let k=1; k*dt < ct-1e-9; k++) events.push({at:t+k*dt, fn:(tt)=>{ if (P.cancelled || P.done || !u.alive || !tgt.alive) return;
      const why = hid(tt) ? "untargetable" : on.includes("invisible") && unseen(tgt,tt) ? "invisible" : on.includes("range") && !a.dash && !(u.script && !u.scriptTravel) && gap(u,tgt) > abReach(u,a,tgt)+1e-6 ? `out of reach (${fmt(gap(u,tgt))} > ${fmt(abReach(u,a,tgt))})` : null;
      if (!why) return; P.cancelled=true; P.done=true; u.nextAct=Math.min(u.nextAct, tt+dt);
      if (!p.cancelSpends){ u.cd[a.slot]=R.cd0; if (R.ammo0 && a.ammo){ a.ammo.n=R.ammo0.n; a.ammo.at=R.ammo0.at; } if (R.en0>0) enGain(u, R.en0, tt, `${a.slot} cancelled: cost refunded`); }
      say(tt, `  ${u.name}'s ${a.slot} is cancelled: ${tgt.name} is ${why} during its cast time (${p.cancelSpends ? "it still goes on cooldown and costs: a documented bug, wiki" : "no cooldown, no cost"}; DECISIONS 3)`);
      simNotes.add(`${u.name} ${a.slot}: a unit-targeted cast is cancelled if its target turns untargetable, invisible or leaves its reach during the cast time (DECISIONS 3${p.cancelSpends?"; this one still spends its cooldown and cost: wiki bug":": no cooldown, no cost"})`); }});
    if (a.dash) return;   // a watched dash: flightWatch from the dash code (its arrival is known there)
    flightWatch(u, a, tgt, t, p.flightFrom==="press" ? 0 : ct, land, P, L); }
  function flightWatch(u, a, tgt, t, from, to, P, L){ const p=a.p, fl = p.inFlight || (a.dash ? null : "destroyed");
    if (!tgt || tgt.side===u.side || tgt.pet || !(fl==="invalidated" || fl==="destroyed") || (u.script && !u.scriptTravel)) return;
    for (let k=Math.max(1, Math.ceil((from-1e-9)/dt)); k*dt < to-1e-9; k++) events.push({at:t+k*dt, fn:(tt)=>{ if (P.cancelled || L.voided || !inStasis(tgt,tt)) return;
      L.voided=tt; say(tt, `  ${tgt.name} is untargetable while ${u.name}'s ${a.slot} is in flight: its effect on ${tgt.name} is voided (wiki${p.inFlight?"":": targeted missiles are destroyed"})`); }});
  }
  /* P3: an ability's immunity window: the UNSTOPPABLE hand entry (dash / press to landing), else the data's ccImmune /
     displacementImmune window (fixed: seconds from the press; kits with their own code are skipped) */
  function unstopOf(u, a){ const H=(UNSTOPPABLE[u.c.champ]||{})[a.slot]; if (H) return H;
    const k=`${u.c.champ}.${a.slot}`, G=(a.p && a.p.grants)||{}; if (KIT_OWN_GRANTS.has(k)) return null;
    for (const [kind, imm] of [["ccImmune","cc"],["displacementImmune","displacement"]]){ const w=grantWin(G[kind], k, a.rank, a.slot);
      if (w) return {imm, from:w[0], fixedUntil:w[1], why:`${kind==="ccImmune"?"crowd control":"displacement"} immune ${fmt(w[0])}–${fmt(w[1])} s after the press (wiki)`}; }   // an end with no number (Kled R, Vi R, … "until it lands") is in the hand table; Vex R / Yuumi W (recast, attach) aren't modelled
    return null; }
  // invulnerable to this hit (P3: Kayle R, Xin Zhao R beyond 450, Taric R): 0 damage, the unit stays targetable
  function invulnTo(att, x, t){ return !!x.invuln && x.invuln.some(w=>t>=w.from-1e-9 && t<w.until-1e-9 && (w.beyond==null || gap(att, x) > w.beyond)); }   // the source's own position (sheet: pets and DoTs count if the source is outside)
  function enOf(u){ if (u.en!==undefined) return u.en; const E=ENERGY_CHAMPS[u.c.champ];
    u.en = E && !(u.c.champ==="Akali" && !u.script) ? {v:E.max, max:E.max, regen:E.regen, at:0, bonus:null} : null;   // fight() Akali: her kit's energy
    if (u.en) simNotes.add(`${u.name}: energy ${E.max}, +${E.regen} per second (game data); abilities wait until it covers their cost`);
    return u.en; }
  function enNow(u, t){ const E=enOf(u); if (!E) return Infinity; const mx=E.max+(E.bonus && E.bonus.until>t ? E.bonus.v : 0);
    if (t>E.at){ E.v+=E.regen*(t-E.at); E.at=t; } E.v=Math.min(mx, E.v); return E.v; }
  const enCost = (u, a) => { if (!a || !a.S || !enOf(u)) return 0; const c=a.S.cost||[]; return c[Math.max(1,a.rank||1)-1] ?? 0; };
  const enShort = (u, a, t) => { const c=enCost(u,a); return c>0 && enNow(u,t)<c-1e-9; };
  function enGain(u, v, t, why){ if (!enOf(u) || !(v>0)) return; const b=enNow(u,t); u.en.v+=v; enNow(u,t); if (u.en.v>b+1e-9) say(t, `  ${u.name}: +${fmt(u.en.v-b)} energy (${why}) → ${fmt(u.en.v)}`); }
  function enSpend(u, c, t){ if (!enOf(u) || !(c>0)) return; enNow(u,t); u.en.v-=c; }
  // once per cast that damages an enemy (Kennen E, Shen Q/E)
  function enOnHit(u, a, t){ if (!enOf(u)) return; const L=u.st.level;
    if (u.c.champ==="Kennen" && a.slot==="E") enGain(u, dvOf(a.S,"energyrefund",a.rank)||40, t, "Lightning Rush hit");
    if (u.c.champ==="Shen" && (a.slot==="Q" || a.slot==="E")) enGain(u, 30+(L>=4?10:0)+(L>=12?10:0), t, `${a.slot} hit`); }
  /* ---- viktor-akali engine gaps (2026-09-24): stacking ground fields (G3), invisibility (G1/G2), telegraphed delayed areas (G9),
     a moving storm (G8). Wiki Viktor_W / Viktor_E / Viktor_R / Akali_W and the Invisibility page. ---- */
  // Gravity Field (Viktor W; phys.stackStun): placed on the target at the end of the cast, active after the delay; every `every` s it
  // slows enemies inside (refreshed, 1 s) and adds a stack (the debuff lasts `debuff` s, so stacks drop after leaving); the
  // `stacks`-th stack stuns, once per cast per enemy. zones: {by, a, x, r, from, until, every, stacks, debuff, slow, stun, st, done, blocked}
  const zones=[];
  const inZoneAt = (F, pos, x) => Math.abs(pos-F.x) <= F.r + RAD(x) + 1e-6;
  function kitGravityField(u, a, tgt, t){
    const G=a.p.stackStun, r=a.p.radius||340, cc=a.ccAll||[], range=a.p.range||800, dir=tgt.x===u.x ? face(u) : Math.sign(tgt.x-u.x);
    const x = u.script ? tgt.x : u.x + dir*Math.min(Math.abs(tgt.x-u.x), range);   // perfect aim: centred on the target, at most the cast range away
    const placed=t+(a.p.castTime||0), from=placed+(a.p.delay||0);
    const F={by:u, a, x, r, from, until:from+G.active, every:G.every, stacks:G.stacks, debuff:G.debuff,
      slow:cc.find(e=>e.type==="slow"), stun:cc.find(e=>e.type==="stun"), st:new Map(), done:new Set(), blocked:new Set()};
    zones.push(F);
    for (let k=0; from+k*G.every <= F.until+1e-9; k++) events.push({at:from+k*G.every, fn:(tt)=>kitFieldTick(F, tt)});
    say(t, `  ${u.name}'s W: Gravity Field on ${tgt.name} (radius ${fmt(r)}), placed at ${fmt(placed)}s, active from ${fmt(from)}s: a stack every ${fmt(G.every)}s inside, the ${G.stacks}th stuns`);
    simNotes.add(`${u.name} W: Gravity Field (wiki Viktor_W): placed on the target at the end of the ${fmt(a.p.castTime||0)} s cast (perfect aim), active ${fmt(a.p.delay||0)} s later for ${fmt(G.active)} s, radius ${fmt(r)}; every ${fmt(G.every)} s it slows enemies inside for 1 s and adds a stack (stacks drop ${fmt(G.debuff)} s after the last one); the ${G.stacks}th stack stuns (once per cast per enemy), so the earliest stun is ${fmt((a.p.castTime||0)+(a.p.delay||0)+(G.stacks-1)*G.every)} s after the cast starts. Fighters walk out before the stun when they can and don't step back in when the next stack would stun`);
  }
  function kitFieldTick(F, tt){ const u=F.by;
    for (const x of enemiesOf(u, tt)){ if (x.pet || F.blocked.has(x) || !inZoneAt(F, x.x, x)) continue;
      if (!F.st.has(x) && blocked(u, F.a, x, tt)){ F.blocked.add(x); continue; }   // a spell shield blocks the whole field for that enemy
      if (F.slow){ const s=x.slows.find(s=>s.field===F); if (s) s.until=tt+ccDuration(F.slow, 0); else { x.slows.push({pct:F.slow.pct, until:tt+ccDuration(F.slow, 0), t0:tt, by:u, field:F});
          say(tt, `  ${x.name} is slowed ${fmt(100*F.slow.pct)}% by ${u.name}'s Gravity Field (refreshed every ${fmt(F.every)}s while inside)`); } }
      const S=F.st.get(x) || {n:0, last:-Infinity}; if (tt-S.last > F.debuff+1e-6) S.n=0; S.n++; S.last=tt; F.st.set(x, S);
      if (S.n>=F.stacks){ S.n=0; if (F.stun && !F.done.has(x)){ F.done.add(x); say(tt, `  ${x.name}: ${F.stacks} Heavy Gravity stacks → stun`);
          applyCC(u, {slot:"W", S:F.a.S, p:F.a.p, cc:[F.stun], hard:true}, x, tt, 0); } }
      else if (F.stun && !F.done.has(x)) say(tt, `  ${x.name}: Heavy Gravity stack ${S.n}/${F.stacks}`);
    } }
  // the field u stands in (at position pos) whose stun would still land on it, and when: {F, stunAt}
  function zoneThreat(u, t, pos){ let best=null; pos = pos ?? (u.xS ?? u.x);
    for (const F of zones){ if (F.by.side===u.side || !F.stun || F.done.has(u) || F.blocked.has(u) || F.until<t || !inZoneAt(F, pos, u)) continue;
      const next = t < F.from-1e-9 ? F.from : F.from + (Math.floor((t-F.from)/F.every + 1e-6) + 1)*F.every;
      const S=F.st.get(u), n = S && next-S.last <= F.debuff+1e-6 ? S.n : 0, stunAt = next + (F.stacks-n-1)*F.every;
      if (stunAt > F.until+1e-9) continue;
      if (!best || stunAt<best.stunAt) best={F, stunAt, n, next}; }
    return best; }
  /* Hold policy for a stacking-stun field (Viktor W, phys.stackStun; item 26): its stun needs the enemy still inside ~2 s after the
     cast, and a free enemy walks out (zoneExit), so cast on cooldown at range it's wasted. The fight AI casts it only when the enemy
     (1) can't walk (stunned, rooted, airborne…) or is passive, or (2) has committed: close enough that a field on it reaches the
     caster (centres within radius + both hitboxes: 340 + 65 + 65 = 470 for Viktor vs Akali) and moving in, or already in its own
     attack reach of the caster (the field then zones it off him). Peel (the kite/peel roles' hard CC on a diver) and role "engage"
     don't hold. The target's last distance is kept per caster to tell if it is moving in. */
  function zoneWorth(u, a, tgt, t){ const H=(u.kit.zoneSeen ||= new Map()), last=H.get(tgt), g=gap(u,tgt); H.set(tgt, {g, t});
    if (tgt.passive || tgt.script || !canMove(tgt,t)) return true;   // tgt.script: perform(…, fightBack: true)'s attacker is all-in by definition
    const moving = !!last && t-last.t <= 2*dt+1e-9 && g < last.g-1e-6;
    const ok = g <= aaReach(tgt,u)+1e-6 || moving && g <= (a.p.radius||340) + RAD(tgt) + RAD(u) + 1e-6;
    if (!ok) simNotes.add(`${u.name} ${a.slot}: held, not cast on cooldown: a free enemy walks out before the stun, so it waits until the enemy commits (moving in within ${fmt((a.p.radius||340)+RAD(tgt)+RAD(u))} units, or in its attack reach), can't move, or dives an ally (peel); role "engage" casts it at once`);
    return ok; }
  // walking out of a threatening field: the exit toward the target first (a diver keeps contact), else the other side; null = can't make it
  function zoneExit(u, Z, tgt, t){ const pos=u.xS ?? u.x, F=Z.F, left=Z.stunAt-t-1e-6, tdir = tgt ? (tgt.x===pos ? face(u) : Math.sign((tgt.xS ?? tgt.x)-pos)) : face(u);
    for (const dir of [tdir, -tdir]){ const need=F.r+RAD(u)+1-dir*(pos-F.x), ms=msWalk(u,t,dir); if (need<=0) continue;
      const time=need/Math.max(1,ms); if (time<=left) return {dir, need, time, to:pos+dir*need}; }
    return null; }
  // entering a field is refused when the stack at the next tick would stun (the fighter waits at the edge until its stacks drop)
  function zoneBlock(u, nx, t){
    for (const F of zones){ if (F.by.side===u.side || !F.stun || F.done.has(u) || F.blocked.has(u) || F.until<t || inZoneAt(F, u.x, u) || !inZoneAt(F, nx, u)) continue;
      const next = t < F.from-1e-9 ? F.from : F.from + (Math.floor((t-F.from)/F.every + 1e-6) + 1)*F.every, S=F.st.get(u);
      const n = S && next-S.last <= F.debuff+1e-6 ? S.n : 0;
      if (n+1>=F.stacks) return F.x + Math.sign(u.x-F.x || -face(u))*(F.r+RAD(u)+1.01); }
    return null; }
  // invisibility (Akali W; wiki Invisibility): an unseen unit can't be targeted by attacks or point-and-click spells; skillshots
  // and areas still hit it (perfect aim). x.shroud {from, until}: in the shroud (assumed: she stays inside it on the 1-D line);
  // attacking or casting reveals her until x.revealUntil; she is seen while dashing
  // (a reveal or dash started this step counts from the next, so the order units act in within a step doesn't matter)
  const unseen = (x, t) => !!x.shroud && t>=x.shroud.from && t<x.shroud.until && !(x.revealUntil>t && x.revealAt<t) && !(x.move && !x.move.forced && x.move.t1>t && x.move.t0<t);
  const akRevealAt = (u, t) => { if (!(u.revealUntil>t)) u.revealAt=t; u.revealUntil=Math.max(u.revealUntil||0, t+akReveal(u)); };
  const unitTargeted = a => !!a && !!a.p && a.p.delivery==="unit";
  // a telegraphed delayed area (Viktor Aftershock: the beam's path explodes `delay` s later; wiki Viktor_E): a free enemy fighter
  // sidesteps it (perfect play) when it can walk `need` units (the line's half-width + its hitbox) before it lands, spending that time
  // walking instead of attacking or casting; locked, rooted, scripted or passive targets are hit
  function kitDelayedLine(u, x, t, delay, p, what, halfWidth, cc){ const step=u.curStep ?? null, land=t+delay;
    let dodge=null;
    // decided at the start of the next step (so the order units act in within a step doesn't matter)
    if (!x.script && !x.passive && !x.dummy) events.push({at:t+dt, fn:(t1)=>{ if (!x.alive) return;
      const need=halfWidth+RAD(x), ms=msNow(x,t1), start=Math.max(t1, x.nextAct, ...x.ccs.filter(c=>ccLive(c,t1) && (LOCKS.includes(c.type) || c.type==="root")).map(c=>c.until));
      const end=start+need/Math.max(1,ms);
      if (end<=land-1e-6){ dodge={start, end}; x.nextAct=Math.max(x.nextAct, end); x.nextAA=Math.max(x.nextAA, end);
        say(t1, `  ${x.name} sidesteps ${what}: walks ${fmt(need)} units off its line (${fmt(halfWidth)} half-width + ${fmt(RAD(x))} hitbox) from ${fmt(start)}s to ${fmt(end)}s, before it lands at ${fmt(land)}s`); } }});
    simNotes.add(`${u.name}: ${what} is telegraphed and lands ${fmt(delay)} s later; an enemy fighter that can walk ${fmt(halfWidth)} + its hitbox units sideways before then sidesteps it (perfect play, spending that time walking), else it hits`);
    events.push({at:land, fn:(tt)=>{ if (!x.alive) return;
      if (dodge && !x.ccs.some(c=>c.at!=null && c.at>=dodge.start-1e-9 && c.at<dodge.end && (LOCKS.includes(c.type)||c.type==="root"))){ say(tt, `  ${what} misses ${x.name} (sidestepped)`); return; }
      const prev=u.curStep, b=u.dealt; u.curStep=step; deal(u,x,partDmg({...p, pct:!!p.pctOf},x),p.type,tt,"ability",what);
      if (cc && x.alive) applyCC(u, {slot:what, p:{}, cc:[cc]}, x, tt, 0);
      u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }}); }
  // Arcane Storm (Viktor R; wiki Viktor_R): after the initial hit the storm follows the nearest champion hit, moving 300/s within 300
  // of Viktor down to 200/s at 900 or more (linear; ×1.25 with Perfect Storm), and strikes enemies within its radius once a second
  function kitStorm(u, a, x, t, per, n){ const r=(a.p && a.p.radius)||325, S=a.S, boost=kitEvolved(u.c, u.st).includes("R") ? 1+(dvOf(S,"augmentboost",a.rank) ?? 0.25) : 1;
    const vmax=300*boost, vmin=200*boost, step=u.curStep ?? null, St={x:x.x, tgt:x, until:t+n+0.5};
    const speed = () => { const d=Math.abs(St.x-u.x); return d<=300 ? vmax : d>=900 ? vmin : vmax-(vmax-vmin)*(d-300)/600; };
    const move = (tt) => { if (tt>St.until) return; if (St.tgt.alive){ const d=St.tgt.x-St.x, v=speed()*dt; St.x += Math.abs(d)<=v ? d : Math.sign(d)*v; }
      events.push({at:tt+dt, fn:move}); };
    events.push({at:t+dt, fn:move});
    for (let i=1;i<=n;i++) events.push({at:t+i, fn:(tt)=>{ for (const y of enemiesOf(u,tt)){ if (y.pet || Math.abs(y.x-St.x) > r+RAD(y)+1e-6){ if (y===St.tgt) say(tt, `  R storm ${i}/${n} misses ${y.name} (${fmt(Math.abs(y.x-St.x))} units from the storm's centre)`); continue; }
        const prev=u.curStep, b=u.dealt; u.curStep=step; deal(u,y,partDmg({...per, pct:!!per.pctOf},y),per.type,tt,"ability",`R storm ${i}/${n}`);
        u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; } }});
    simNotes.add(`${u.name} R: the storm follows ${x.name} at ${fmt(vmin)}–${fmt(vmax)} units/s (faster near ${u.name}; wiki Viktor_R) and strikes enemies within ${fmt(r)} (+ hitbox) once a second, ${n} times after the initial burst; it keeps following an invisible target (wiki)`); }
  /* Akali in fight() (see CHAMP_MECH.Akali) */
  const akCost = (u, s) => { const a=u.abAll[s]; if (!a || !(s==="Q"||s==="E")) return 0; const c=a.S.cost||[]; return c[a.rank-1] ?? c[c.length-1] ?? 0; };
  function akEnergy(u, t){ const K=u.kit; if (K.en==null) return Infinity; const max=200+(u.shroud && t>=u.shroud.cast && t<u.shroud.until ? 100 : 0);
    if (t>K.enT){ if (K.en<max) K.en=Math.min(max, K.en+10*(t-K.enT)); K.enT=t; } K.en=Math.min(K.en, max); return K.en; }
  const akWms = u => { const W=u.abAll.W; return W ? (dvOf(W.S,"movementspeed",W.rank) ?? 30)/100 : 0; };
  const akReveal = u => { const L=u.st.level; return L>=16 ? 0.625 : L>=13 ? 0.725 : L>=10 ? 0.825 : L>=7 ? 0.9 : 1; };   // wiki Akali_W description3
  const akPart = (a, i) => a.parts[i] ? [a.parts[i]] : [];
  // Assassin's Mark (wiki Akali_P; game data Level1MS 0.3, +0.1 at levels 6/11/16): an ability that damages a champion puts a 500-radius
  // ring around it for 4 s (refreshed by more ability damage; none while Swinging Kama is up); leaving it readies Swinging Kama for 4 s
  // (+125 attack range) and each of the two moments gives +30–60% move speed for 2 s. 1-D: the ring is centred on the target's position
  // (the wiki's 120-unit offset toward her is ignored: she can leave on any side); the speed counts in every direction.
  const akRingPct = u => { const L=u.st.level, P=CALC.champs.Akali.P; return (dvOf(P,"level1ms",1) ?? 0.3) + (dvOf(P,"msadditionalbonusatthreshold",1) ?? 0.1)*((L>=6)+(L>=11)+(L>=16)); };
  function akRing(u, x, t, a){ const K=u.kit; if (!x || x.pet || !x.alive || !(a && (a.akHit || inReach(u,a,x)))) return;   // the hit landed (damage is queued until the end of the tick)
    if (K.kama && K.kama.until>t) return;
    if (K.ring && K.ring.until>t){ K.ring.until=t+4; return; }
    K.ring={cx:x.x, r:500, until:t+4}; addBuff(u,"akaliRing",t+2,{mspct:akRingPct(u)},t);
    say(t, `  ${u.name}: Assassin's Mark ring around ${x.name} (radius 500, 4s); +${fmt(100*akRingPct(u))}% move speed for 2s`);
    simNotes.add(`${u.name} P: an ability hit on a champion rings it (500 radius, 4 s); she steps out of the ring (+${fmt(100*akRingPct(u))}% move speed for 2 s) to ready Swinging Kama (+125 range, 4 s), then attacks with it (wiki Akali_P; 1-D: the ring is centred on the target, the 120-unit offset is ignored)`); }
  function akRingExit(u, t){ const K=u.kit, R=K.ring, pos=u.xS ?? u.x; if (!R || !(R.until>t) || Math.abs(pos-R.cx) <= R.r) return false;
    K.ring=null; K.kama={until:t+4, bonus:125}; addBuff(u,"akaliRing",t+2,{mspct:akRingPct(u)},t);
    say(t, `  ${u.name} leaves the ring: Swinging Kama ready (4s, +125 range), +${fmt(100*akRingPct(u))}% move speed for 2s`); return true; }
  // perfect play: no dash that lands her inside a Gravity Field whose stun she then couldn't walk away from in time
  function akLandOK(u, pos, land, t){ const Z=zones.length ? zoneThreat(u, t, pos) : null; if (!Z) return true;
    const F=Z.F, need=F.r+RAD(u)+1-Math.abs(pos-F.x), ms=Math.max(1, msCap((u.st.msuncapped||u.st.ms)*(1-(F.slow ? F.slow.pct : 0))));   // slowed inside
    return land + need/ms < Z.stunAt - 2*dt; }
  function akResolve(u, a, x, t, d0, parts){ const keep=a.parts; a.parts=parts; a.akHit=true; const b=x.blocks||0;
    resolveCast(u, a, x, t, d0); a.parts=keep; a.akHit=false; return (x.blocks||0)===b; }
  // E first cast: flip back 400 from 0.15 s; the shuriken leaves at 0.25 s toward where the target is, reaching 825 from her start point
  function akThrow(u, a, x, t, d0){ const K=u.kit, F=a.p.flipBack||{dist:400, at:0.15}, sp=a.p.dashSpeed||1500, ct=a.p.castTime||0.25, x0=u.x, dir=x.x===u.x ? face(u) : Math.sign(x.x-u.x);
    K.busyUntil=t+ct; u.nextAct=Math.max(u.nextAct, t+ct); const step=u.curStep ?? null;
    say(t, `${u.name} casts E (Shuriken Flip) toward ${x.name}`);
    events.push({at:t+F.at, fn:(tt)=>{ if (!u.alive) return; if (!canDash(u,tt)){ say(tt, `  ${u.name} can't flip back (immobilized or grounded)`); return; }
      const to=clampRoom(u, u.x-dir*F.dist); displace(u, to, Math.abs(to-u.x)/sp, tt); say(tt, `${u.name} flips back ${fmt(Math.abs(to-u.x))} units (E) in ${fmt(Math.abs(to-u.x)/sp)}s`); }});
    events.push({at:t+ct, fn:(tt)=>{ if (!u.alive) return; const from=u.x, d=Math.max(0, Math.abs(x.x-from)-RAD(x)), fly=d/Math.max(1, a.p.speed||1800);
      events.push({at:tt+fly, fn:(t2)=>{ if (!u.alive || !x.alive) return; const prev=u.curStep; u.curStep=step;
        if (Math.sign(x.x-x0)!==dir && Math.abs(x.x-x0)>RAD(x) || Math.abs(x.x-x0) > (a.p.range||825)+RAD(x)+1e-6){ say(t2, `${u.name}'s E shuriken misses ${x.name} (${fmt(Math.abs(x.x-x0))} units from where she threw it; reach ${fmt((a.p.range||825)+RAD(x))})`); u.curStep=prev; return; }
        const ok=akResolve(u, a, x, t2, d0, akPart(a,0)); u.curStep=prev;
        if (ok){ K.akE={tgt:x, until:t2+3, a, d0, step}; say(t2, `  ${x.name} is marked for 3s (E recast ready)`); } }}); }});
    simNotes.add(`${u.name} E: flips back ${fmt(F.dist)} units from ${fmt(F.at)} s at ${fmt(sp)}/s, throws the shuriken at ${fmt(ct)} s (${fmt(a.p.speed||1800)}/s, up to ${fmt(a.p.range||825)} from where she stood), and recasts (0.1 s) to dash to the marked target at ${fmt(sp)}/s: 30% on the throw, 70% on arrival (wiki Akali_E)`); }
  function akRecastE(u, M, t){ const K=u.kit, a=M.a, x=M.tgt, sp=a.p.dashSpeed||1500, d=Math.max(0, gap(u,x)-RAD(u)-RAD(x)), dir=x.x===u.x ? face(u) : Math.sign(x.x-u.x);
    K.akE=null; const dur=0.1+d/sp; displace(u, u.x+dir*d, dur, t); K.busyUntil=t+dur; u.nextAct=Math.max(u.nextAct, t+dur); akRevealAt(u, t);
    u.mobileUntil=t+4; say(t, `${u.name} recasts E: dashes ${fmt(d)} units to ${x.name} in ${fmt(dur)}s`);
    events.push({at:t+dur, fn:(tt)=>{ if (!u.alive || !x.alive) return; const prev=u.curStep; u.curStep=M.step; akResolve(u, a, x, tt, M.d0, akPart(a,1)); u.curStep=prev; }}); }
  // R1: 0.25 s cast, then 750 units toward the target at 1500/s, hitting as she reaches it and ending at least 150 past it
  function akR1(u, a, x, t, d0){ const K=u.kit, ct=a.p.castTime||0.25, D=a.p.dashRange||750, sp=a.p.dashSpeed||1500, step=u.curStep ?? null, R2=a.p.recastDash||{dist:800, speed:3000, lockout:2.5, window:10};
    K.busyUntil=t+ct; u.nextAct=Math.max(u.nextAct, t+ct); u.mobileUntil=t+4;
    const r2=(a.later||[]).find(p=>p.later==="recast"); K.akR = r2 ? {tgt:x, from:t+(dvOf(a.S,"cooldownbetweencasts",a.rank)||R2.lockout), until:t+R2.window, part:r2, a, d0, step} : null;
    say(t, `${u.name} casts R on ${x.name}`);
    events.push({at:t+ct, fn:(tt)=>{ if (!u.alive) return; if (!canDash(u,tt)){ say(tt, `  ${u.name}'s R dash is stopped (immobilized or grounded)`); return; }
      const g=gap(u,x), reach=g-RAD(u)-RAD(x), dir=x.x===u.x ? face(u) : Math.sign(x.x-u.x);
      if (reach > D){ displace(u, u.x+dir*D, D/sp, tt); K.busyUntil=tt+D/sp; u.nextAct=Math.max(u.nextAct, tt+D/sp); say(tt, `${u.name}'s R dash (${fmt(D)}) falls short of ${x.name} (${fmt(g)} away)`); return; }
      const e=Math.max(150, D-g), len=g+e;   // flips over: ends e past the target (1-D: e units from it on her own side)
      displace(u, x.x-dir*e, len/sp, tt); K.busyUntil=tt+len/sp; u.nextAct=Math.max(u.nextAct, tt+len/sp);
      say(tt, `${u.name} dashes through ${x.name} (R): ${fmt(len)} units in ${fmt(len/sp)}s, ending ${fmt(e)} units past`);
      events.push({at:tt+Math.max(0,reach)/sp, fn:(t2)=>{ if (!u.alive || !x.alive) return; const prev=u.curStep; u.curStep=step; akResolve(u, a, x, t2, d0, akPart(a,0)); u.curStep=prev; }}); }});
    simNotes.add(`${u.name} R: R1 after its ${fmt(ct)} s cast dashes ${fmt(D)} units toward the target at ${fmt(sp)}/s, hits as she reaches it and flips at least 150 past (1-D: she ends that far from the target on her own side); R2 (no cast time, ${fmt(R2.lockout)}–${fmt(R2.window)} s after R1) dashes ${fmt(R2.dist)} at ${fmt(R2.speed)}/s through the target when it kills, at the 70%-missing cap or as the window closes, or away to escape a Gravity Field (wiki Akali_R)`); }
  function akR2(u, x, t, dir, through){ const K=u.kit, R=K.akR, a=R.a, P=a.p.recastDash||{dist:800, speed:3000}, D=P.dist, sp=P.speed, pos=u.xS ?? u.x;
    K.akR=null; akRevealAt(u, t); u.mobileUntil=t+4;
    if (through){ const g=gap(u,x), reach=Math.max(0, g-RAD(u)-RAD(x)), e=Math.max(0, D-g);
      displace(u, x.x-dir*e, D/sp, t); K.busyUntil=t+D/sp; u.nextAct=Math.max(u.nextAct, t+D/sp);
      say(t, `${u.name} recasts R: dashes ${fmt(D)} units through ${x.name} in ${fmt(D/sp)}s`);
      events.push({at:t+reach/sp, fn:(tt)=>{ if (!u.alive || !x.alive) return; const prev=u.curStep; u.curStep=R.step; akResolve(u, a, x, tt, R.d0, [R.part]); u.curStep=prev; }}); return; }
    const to=clampRoom(u, pos+dir*D); displace(u, to, Math.abs(to-pos)/sp, t); K.busyUntil=t+D/sp; u.nextAct=Math.max(u.nextAct, t+D/sp);
    say(t, `${u.name} recasts R away: dashes ${fmt(Math.abs(to-pos))} units in ${fmt(D/sp)}s (escape)`); }
  // a multi-cast ability (Riven Q, Ahri R): called from onCast; returns this cast's number (1..max). Between casts the
  // ability is ready again after `gap` s (static); the real cooldown, which cast() started at the first cast, applies after
  // the last cast or when the recast window closes (window from the previous cast, or from the first when fromFirst)
  // the time a cast was pressed (backlog 25: kit onCast/afterCast run when the cast lands; recast windows and cooldown changes that
  // count from the cast use the press)
  const pressOf = (a, t) => a.land && a.land.pressT!=null ? a.land.pressT : t;
  function kitRecast(u, a, t1, max, gap, window, fromFirst){ const t=pressOf(a, t1), K=u.kit, k="recast"+a.slot, Q=K[k] && K[k].until>t ? K[k] : {n:0, cdEnd:u.cd[a.slot], first:t};
    const n=Q.n+1;
    if (n>=max){ K[k]=null; u.cd[a.slot]=Q.cdEnd; return n; }
    const R={n, cdEnd:Q.cdEnd, first:Q.first, until:(fromFirst ? Q.first : t)+window}; K[k]=R; u.cd[a.slot]=t+gap;
    events.push({at:R.until, fn:()=>{ if (u.kit[k]===R){ u.kit[k]=null; u.cd[a.slot]=Math.max(u.cd[a.slot], R.cdEnd); } }});
    return n; }
  const kitShadowsAt = (u, t) => (u.kit.shadows||[]).filter(s=>s.until>t);
  // Kai'Sa Plasma (wiki Second Skin; game data P): each application deals base + per existing stack (up to 4); the 5th stack ruptures
  function kitPlasma(u, x, t, k){ if (!x.alive) return; const P=CALC.champs.Kaisa.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
    x.kaisaPlasmaAt={by:u, t};   // combo audit 2026-09-24: Killer Instinct needs a champion affected by Plasma in the last 4 s (wiki Kaisa_R)
    const pl=x.plasma && x.plasma.by===u && x.plasma.until>t ? x.plasma : {by:u, n:0, until:0}, before=pl.n;
    deal(u,x,evalCalc(ctx,"pbasedamage").v + evalCalc(ctx,"pcurrentperstackdamage").v*Math.min(dvOf(P,"pmaxstacks",1)||4, before),"magic",t,"onhit","Plasma");
    if (before+k >= 5){ x.plasma=null; const pct=evalCalc(ctx,"pexecutepercentage").v; deal(u,x,pct*Math.max(0,x.max-x.hp),"magic",t,"proc",`Plasma rupture (${fmt(pct*100)}% missing health)`); }
    else x.plasma={by:u, n:before+k, until:t+(dvOf(P,"pduration",1)||4)};
    simNotes.add(`${u.name}: Plasma from attacks (1) and W (2, 3 evolved); each application deals its damage, the 5th stack ruptures for missing-health damage`); }
  function kitEzP(u, t){ const S=CALC.champs.Ezreal.P, P=u.kit.ezP && u.kit.ezP.until>t ? u.kit.ezP : {n:0};
    u.kit.ezP={n:Math.min(dvOf(S,"maxstacks",1)||5, P.n+1), until:t+(dvOf(S,"stackduration",1)||6)};
    addBuff(u,"risingspellforce",u.kit.ezP.until,{bonusAS:(dvOf(S,"attackspeedperstack",1)||0.1)*u.kit.ezP.n},t); }
  function kitEzDetonate(u, x, t){ const M=x.ezMark; if (!M || M.by!==u || !(M.until>t)) return; x.ezMark=null; deal(u,x,M.v,"magic",t,"ability","Essence Flux detonation"); }
  function kitYoneDetonate(u, t, E){ if (E.done || !u.alive) return; E.done=true; const prev=u.curStep, b=u.dealt; u.curStep=E.step;
    for (const [x,v] of E.stored) if (x.alive && v>0) deal(u,x,v,"true",t,"ability","Soul Unbound return");
    u.curStep=prev; if (E.step!=null && u.stepLog[E.step]) u.stepLog[E.step].dmg += u.dealt-b; }
  function kitStyle(u, kind, t){ const S=u.kit.style && u.kit.style.until>t ? u.kit.style : {n:0, last:null};
    u.kit.style={n: S.last!==kind ? Math.min(6, S.n+1) : S.n, last:kind, until:t+6}; }
  function kitSmolderExecute(u, x, t){ if (!x || !x.alive || x.kitBurnBy!==u || !(x.kitBurnUntil>=t)) return;
    const th=(dvOf(CALC.champs.Smolder.Q,"tier3_executethresholdstart",1)||6.5)/100; if (x.hp < th*x.max){ say(t, `  ${u.name}: burning ${x.name} executed below ${fmt(th*100)}%`); deal(u,x,x.hp,"true",t,"proc","Super Scorcher Breath execute"); } }
  /* ---- champion audit batch 2 helpers ---- */
  // Tristana E (wiki Explosive Charge): attacks and ability hits on the charged target add a stack (+25%); the 4th detonates at once,
  // otherwise it detonates after 4 s; a full-stack detonation on a champion resets Rocket Jump
  function kitTristStack(u, x, t){ const C=u.kit.charge; if (!C || C.done || C.tgt!==x || !(C.until>t)) return; C.n++; if (C.n>=4) kitTristBoom(u, C, t); }
  function kitTristBoom(u, C, t){ if (C.done) return; C.done=true; if (!C.tgt.alive || !u.alive) return;
    deal(u, C.tgt, C.v*(1+C.amp*Math.min(4,C.n)), C.type, t, "ability", `Explosive Charge (${C.n} stack${C.n===1?"":"s"})`);
    if (C.n>=4 && (u.cd.W||0)>t){ u.cd.W=t; say(t, `  ${u.name}: Rocket Jump reset (full Explosive Charge)`); } }
  // Qiyana: Terrashape on-hit magic while holding an element; Royal Privilege once per target per cooldown (game data ICD)
  function kitQiyanaHit(u, x, t){ if (!x.alive) return; const P=CALC.champs.Qiyana.P, ctx={S:P, rank:1, st:u.st, flags:u.flags}, W=u.abAll.W;
    if (W && u.kit.element!==false) deal(u,x,evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"onhitdamage").v,"magic",t,"onhit","Terrashape");
    const R=(x.qiyanaP ||= {}); if (!(R[u.name]>t)){ R[u.name]=t+evalCalc(ctx,"icd").v; deal(u,x,evalCalc(ctx,"finaldamage").v,"physical",t,"onhit","Royal Privilege"); } }
  // Locke Q (wiki Ritual Nails): Soul Nails stacks (1 per nail, the recasts 0.5 s apart) consumed by his next attack or E dash
  function kitLockeNails(u, x, t){ const N=x.lockeNails; if (!N || N.by!==u || !(N.until>t)) return; x.lockeNails=null; const Q=u.abAll.Q; if (!Q) return;
    const n=1+(t>=N.t0+0.5-1e-9)+(t>=N.t0+1-1e-9), f=n*(1+(n===2?(dvOf(Q.S,"twomarkbonuspercent",Q.rank)??20):n===3?(dvOf(Q.S,"threemarkbonuspercent",Q.rank)??40):0)/100);
    deal(u,x,evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"naildamage").v*f,"magic",t,"onhit",`Soul Nails (${n} stack${n>1?"s":""})`); }
  // Talon (wiki Blade's End): each ability hit adds a Wound (6 s); at 3, his next attack makes the target bleed over 2 s (no new stacks meanwhile)
  function kitTalonWound(u, x, t){ const W=x.talonW; if (W && W.bleeding && W.until>t) return;
    x.talonW={by:u, n:Math.min(3,(W && W.by===u && !W.bleeding && W.until>t ? W.n : 0)+1), until:t+(dvOf(CALC.champs.Talon.P,"stackduration",1)||6)}; }
  /* ---- champion audit batch 3 helpers ---- */
  // Rell (wiki Break the Mold): a stack per attack or ability hit on a non-minion (5 max, 5 s); read in deal() as −3% armor and MR each
  function kitRellMold(u, x, t){ if (!x.alive || x.minion) return; const M=x.rellMold && x.rellMold.by===u && x.rellMold.until>t ? x.rellMold : {n:0};
    x.rellMold={by:u, n:Math.min(dvOf(CALC.champs.Rell.P,"maxstacks",1)||5, M.n+1), until:t+(dvOf(CALC.champs.Rell.P,"shredduration",1)||5), floor:evalCalc({S:CALC.champs.Rell.P, rank:1, st:u.st, flags:u.flags},"stealfloor").v};
    simNotes.add(`${u.name}: Break the Mold — attacks and ability hits stack −3% armor and MR on the target (5 stacks, 5 s; at least ${fmt(x.rellMold.floor)} per stack); the resistances Rell gains aren't modelled`); }
  function kitGravesGrit(u, t){ const G=u.kit.grit; if (!G) return; addBuff(u, "gravesGrit", G.until, {bonusarmor:G.per*G.n, bonusmr:G.per*G.n*G.mr}, t); }
  function kitGalioHit(u, t){ const K=u.kit; if (K.pAt>t) K.pAt=Math.max(t, K.pAt-(dvOf(CALC.champs.Galio.P,"chargerateperhit",1)||3)); }   // Galio: −3 s on Colossal Smash per cast hitting a champion
  // Ekko (wiki Z-Drive Resonance): a stack per attack or damaging ability hit (4 s); the 3rd deals the bonus; then 4 s lockout on that target
  function kitEkkoRes(u, x, t){ if (!x.alive) return; const P=CALC.champs.Ekko.P, R=(x.ekkoRes && x.ekkoRes.by===u) ? x.ekkoRes : {by:u, n:0, until:-1, lock:-1};
    if (t < R.lock) return; R.n = R.until>t ? R.n+1 : 1; R.until=t+4; x.ekkoRes=R;
    if (R.n>=3){ R.n=0; R.lock=t+(dvOf(P,"lockouttime",1)||4); deal(u,x,evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"threehitdamage").v,"magic",t,"proc","Z-Drive Resonance");
      if (!x.dummy && !x.pet) addBuff(u,"ekkoP",t+evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"speedduration").v,{mspct:evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"bonusms").v},t); }
    simNotes.add(`${u.name}: Z-Drive Resonance — attacks and damaging abilities stack on the target (4 s); the 3rd deals bonus magic damage (once per target every 4 s) and gives Ekko move speed against champions`); }
  function kitRellTilt(u, x, t){ const E=u.kit.tilt; if (!E || !(E.until>t)) return; u.kit.tilt=null; deal(u,x,E.pct*x.max,"magic",t,"proc","Full Tilt"); }
  /* ---- champion audit batch 4 helpers ---- */
  // Leona (wiki Sunlight): her ability hits mark the target 2.5 s; an ALLIED champion's attack or ability damage consumes it for bonus magic
  function kitSunlight(att, tgt, t, kind){ const S=tgt.sunlight; if (!S || !(S.until>t) || att===S.by || att.side!==S.by.side || att.pet || att.dummy || !(kind==="aa"||kind==="ability")) return;
    tgt.sunlight=null; if (!S.by.alive || !tgt.alive) return;
    deal(S.by, tgt, evalCalc({S:CALC.champs.Leona.P, rank:1, st:S.by.st, flags:S.by.flags},"totaldamage").v, "magic", t, "proc", "Sunlight");
    simNotes.add(`${S.by.name}: Sunlight — her ability hits mark enemies for 2.5 s; an allied champion's attack or ability consumes the mark for bonus magic damage (not Leona's own)`); }
  function kitMarkSun(u, x, t){ if (x && x.alive && !x.pet) x.sunlight={by:u, until:t+(dvOf(CALC.champs.Leona.P,"markduration",1)||2.5)}; }
  // Kalista (wiki Rend): attacks and Pierce add a spear to the target (4 s, refreshed); Rend deals the first spear + each extra one
  function kitRend(u, x, t){ if (!x.alive) return; const R=x.rend && x.rend.by===u && x.rend.until>t ? x.rend : {by:u, n:0}; x.rend={by:u, n:Math.min(254, R.n+1), until:t+4}; }
  function kitRendReady(u, x, t){ const R=x && x.rend; if (!R || R.by!==u || !(R.until>t)) return false; const v=kitRendDmg(u, x, t), st=x.st;
    const r=Math.max(0, st.armor*(1-u.st.armorpenpct)-u.st.lethality-u.st.armorpen); return v*100/(100+r) >= (x.hpS ?? x.hp) || R.until-t < 0.5; }
  function kitRendDmg(u, x, t){ const E=u.abAll.E; if (!E || !x.rend || x.rend.by!==u || !(x.rend.until>t)) return 0; const ctx={S:E.S, rank:E.rank, st:u.st, flags:u.flags};
    return evalCalc(ctx,"normaldamage").v + (x.rend.n-1)*evalCalc(ctx,"additionaldamage").v; }
  // Caitlyn (wiki Yordle Snap Trap): a trap arms 1 s after it is placed; the first enemy champion on it (not trap-immune) springs it:
  // root 1.5 s, a trap Headshot within 1.8 s, and 3 s immunity to her traps; armed traps on the same spot spring together
  function kitTrapCheck(u, trap, tt){ const K=u.kit; if (!K.traps || !K.traps.includes(trap)) return true; if (tt>=trap.until){ K.traps=K.traps.filter(x=>x!==trap); return true; }
    const foes=U.filter(x=>x.alive && x.side!==u.side && !x.pet && !inStasis(x,tt)); if (!foes.length) return true;
    const x=foes.find(x=>Math.abs((x.xS ?? x.x)-trap.x) <= trap.r+RAD(x) && !(x.caitImm>tt)); if (!x) return false;
    const gone=K.traps.filter(y=>y.armAt<=tt && Math.abs(y.x-trap.x) <= 2*trap.r); K.traps=K.traps.filter(y=>!gone.includes(y));
    x.caitImm=tt+3; say(tt, `  ${x.name} springs ${u.name}'s trap${gone.length>1?` (${gone.length} traps on the spot)`:""}`);
    applyCC(u, {slot:"W", S:trap.S, p:{}, cc:[{type:"root", dur:trap.root}], hard:true}, x, tt, 0);
    K.caitFree=(K.caitFree||[]).filter(f=>f.src!=="W").concat([{src:"W", from:tt, until:tt+1.8, w:trap.w}]); return true; }
  // Hecarim (wiki Devastating Charge): move speed 25% rising to 65% over 2.5 s (game data TimeToMaxMoveSpeed; wiki 3 s), until the charge hits
  function kitHecSpeed(u, t0, t){ const K=u.kit; if (!K.charge || K.charge.t0!==t0 || !(K.charge.until>t)) return; const E=u.abAll.E, f=Math.min(1,(t-t0)/(dvOf(E.S,"timetomaxmovespeed",E.rank)||2.5));
    addBuff(u, "hecE", K.charge.until, {mspct:(dvOf(E.S,"minmovespeed",E.rank)||0.25)+f*((dvOf(E.S,"maxmovespeed",E.rank)||0.65)-(dvOf(E.S,"minmovespeed",E.rank)||0.25))}, t); }
  /* ---- champion audit batch 5 helpers ---- */
  // a heal keyed to the damage just dealt (Viego's second strike, Aatrox's Deathbringer Stance): estimated after resistances and penetration
  const kitPostMit = (u, x, v, type) => mitigate(v, type, u.st, x.st).v;
  // a kit part dealt now from inside an event (kitLater would land a step later), counted on the step that started it
  function kitDealNow(u, x, tt, p, what, step){ if (!x.alive || !u.alive) return; const prev=u.curStep, b=u.dealt; u.curStep=step;
    deal(u,x,partDmg({...p, pct:!!p.pctOf},x),p.type,tt,"ability",what); u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }
  // Zoe (wiki Sleepy Trouble Bubble): the next non-persistent damage from a champion on the sleeping target (or within 1 s after the sleep)
  // wakes it and deals the same post-mitigation damage again as true damage, up to the cap (credited to Zoe)
  function kitZoeWake(att, tgt, v, t, kind){ const S=tgt.zoeSleep;
    if (!S || t<S.from || t>=S.sleepEnd+1 || kind==="dot" || kind==="abilitydot" || att.side!==S.by.side || att.pet || att.dummy || !(v>0)) return;
    tgt.zoeSleep=null; tgt.ccs=tgt.ccs.filter(c=>!(c.type==="sleep" && c.src===S.by));
    if (S.by.alive && tgt.alive) deal(S.by, tgt, Math.min(v, S.cap), "true", t, "proc", "Sleepy Trouble Bubble (woken)");
    simNotes.add(`${S.by.name} E: Sleepy Trouble Bubble — drowsy 1.4 s, then asleep 2.25 s with −30% magic resist; the next champion hit (not damage over time) wakes the target and deals its post-mitigation damage again as true damage, up to ${fmt(S.cap)}`); }
  // Nami E (wiki Tidecaller's Blessing): the blessed ally's next 3 attacks or ability casts within 6 s each deal bonus magic damage and
  // slow 1 s (an area cast uses one charge for everyone it hits); credited to Nami
  function kitNamiHit(u, x, t, cid){ const B=u.namiE; if (!B || !(B.until>t) || B.n<=0 || !x.alive || x.side===u.side) return;
    if (cid==null || B.cid!==cid){ B.n--; B.cid=cid ?? null; }
    deal(B.by, x, B.v, "magic", t, "proc", "Tidecaller's Blessing"); if (x.alive) applyCC(B.by, {slot:"E", S:B.S, p:{}, cc:[{type:"slow", dur:1, pct:B.slow}]}, x, t, 0);
    if (B.n<=0) u.namiE=null; }
  // Taliyah E (wiki Unraveled Earth): a target displaced over the stones detonates them (up to 4, −25% each after the first) and is
  // stunned 0.75 s once the displacement ends
  function kitTaliyahStones(u, x, t, dispEnd){ const F=u.kit.field; if (!F || !(F.until>t) || !x.alive || (F.hit && F.hit.has(x))) return;
    (F.hit ||= new Set()).add(x); if (F.det) kitDealNow(u, x, t, F.det, "E Unraveled Earth detonation", F.step);
    events.push({at:dispEnd, fn:(tt)=>{ if (u.alive && x.alive) applyCC(u, {slot:"E", S:F.S, p:{}, cc:F.stun, hard:true}, x, tt, 0); }}); }
  // champion-specific mechanics that live in scripts, not in the formula data
  const CHAMP_MECH = {
    Katarina: { onTakedown(u, x, t){   // Voracity: a champion takedown within 3 s of damaging them cuts current cooldowns by 15 s (wiki)
      if (x.dummy) return; for (const s of ["Q","W","E","R"]) if ((u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-15); say(t, `  ${u.name}: Voracity −15 s on every cooldown`); },
      onPassiveStep(u, t){   // picking up a Dagger cuts Shunpo's cooldown (tooltip: daggercooldownreduction)
      const S=CALC.champs.Katarina.E; if (!S || !S.calcs.daggercooldownreduction) return;
      const v=evalCalc({S, rank:rankOf(u.c,"E"), st:u.st, flags:new Set()}, "daggercooldownreduction").v;
      if ((u.cd.E||0) > t){ u.cd.E=Math.max(t, u.cd.E - v); say(t, `  dagger picked up: Shunpo cooldown −${fmt(v)}s`); }
      simNotes.add("Katarina: picking up a Dagger (P step) reduces Shunpo's cooldown by the tooltip's daggercooldownreduction");
    },
      /* combo audit 2026-09-24 (wiki Katarina_Q, Katarina_W, Katarina passive): a Dagger lands 1 s after Bouncing Blade strikes its
         first target, or 1.25 s after Preparation tosses it, and disappears after 4 s on the ground; "Katarina may not slash until
         it has [landed]". perform(): a P step (pick-up) waits for a landed Dagger and uses it; with none thrown it is skipped. */
      pressCast(u, a, tgt, t){ const D=(u.kit.daggers ||= []);
        if (a.slot==="Q" && tgt){ const at=t+landOf(u, a, tgt, gap(u,tgt))+1; D.push({at, until:at+4}); }
        if (a.slot==="W"){ const at=t+((a.p && a.p.delay) ?? 1.25); D.push({at, until:at+4}); } },
      step(u, step, tgt, t, log){ if (step!=="P") return false; const D=(u.kit.daggers||[]).filter(d=>d.until>t).sort((x,y)=>x.at-y.at); u.kit.daggers=D;
        if (!D.length){ log({skipped:"no Dagger thrown (Q or W) to pick up"}); return "logged"; }
        if (D[0].at>t+1e-9){ if (u.scriptWait){ simNotes.add(`Katarina P (perform()): waits for the Dagger to land (Q: 1 s after it strikes; W: 1.25 s) — she can't slash before it lands (wiki)`); return "wait"; }
          log({skipped:"the Dagger hasn't landed yet"}); return "logged"; }
        D.shift(); return false; } },
    /* ---- range-disengage debate fixes (2026-09-23) ---- */
    Ivern: {
      shieldAtCast:["E"],   // backlog 25: Triggerseed shields at once; its burst lands after the 2 s delay
      // Ivern himself never dashes on Q or R (wiki): Q1 is a root skillshot (the optional recast leaps to the rooted enemy, not
      // modelled), R summons Daisy; the generic "dash" tags come from the tooltips' text about the recast and Daisy
      init(u){ for (const s of ["Q","R"]){ const A=u.abAll[s]; if (A){ A.dash=false; A.blink=false; } } },
      onCast(u, a, tgt, t){ if (a.slot==="R") return kitDaisy(u, a, tgt, t); if (a.slot!=="W") return; u.kit.brushUntil=t+(dvOf(a.S,"maxbrushduration",a.rank)||45);
        simNotes.add(`${u.name} W: grows a brush where the fight is; Ivern and his allies are assumed to fight inside it for its 45 s, so their attacks fire Brushmaker bolts (Ivern ${fmt(evalCalc({S:a.S,rank:a.rank,st:u.st,flags:u.flags},"totaldamage").v)}, allies ${fmt(evalCalc({S:a.S,rank:a.rank,st:u.st,flags:u.flags},"totalallydamage").v)} magic); fight() recasts it only every 20 s (one charge)`); },
    },
    Annie: {
      onCast(u, a, tgt, t){ const K=u.kit; if (K.pyro==null) K.pyro=dvOf(CALC.champs.Annie.P,"maxstacks",1)||4;   // wiki: max stacks at game start / respawn
        K.stunCast = ["Q","W","R"].includes(a.slot) && K.pyro>=4; K.hit=new Set(); if (K.stunCast) K.pyro=0; },
      onDealt(att, tgt, v, pre, type, t, kind){ const K=att.kit; if (K.hit && kind==="ability") K.hit.add(tgt); },
      afterCast(u, a, tgt, t){ const K=u.kit, hit=[...(K.hit||[])]; K.hit=null;
        if (K.stunCast){ K.stunCast=false; const P=CALC.champs.Annie.P, L=u.st.level, dur=(dvOf(P,"stunbaseduration",1)||1.25)+(dvOf(P,"stundurationpertier",1)||0.25)*(L>=11?2:L>=6?1:0);
          for (const x of hit) if (x.alive) applyCC(u, {...a, cc:[{type:"stun", dur}], hard:true}, x, t, 0);
          simNotes.add(`${u.name}: Pyromania — she starts Energized (wiki: full stacks at game start and respawn); her next Q, W or R stuns every enemy it damages for ${fmt(dur)}s (1.25/1.5/1.75 s at levels 1/6/11); Q hits and W/E/R casts build the next 4 stacks`); return; }
        if (a.slot!=="Q" || hit.length) K.pyro=Math.min(4, K.pyro+1); },
    },
    JarvanIV: {
      /* champion audit batch 4: Martial Cadence on his attacks; Demacian Standard's flag (E) is what Dragon Strike (Q) knocks up from;
         Q's armor reduction; Golden Aegis +1.3% maximum health shield per champion hit */
      attack(u, tgt, t){ const P=CALC.champs.JarvanIV.P, R=(tgt.j4P ||= {}); if (R[u.name]>t) return null; const ctx={S:P, rank:1, st:u.st, flags:u.flags};
        R[u.name]=t+(evalCalc(ctx,"tooltipcooldown").v||6); let v=Math.max(dvOf(P,"minimumcadencedamage",1)||20, (dvOf(P,"tooltipcurrenthealthdamage",1)||0.08)*(tgt.hpS ?? tgt.hp));
        if (tgt.pet) v=Math.min(v, dvOf(P,"maximumcadencedamage",1)||400);
        simNotes.add(`${u.name}: Martial Cadence — an attack deals 8% of the target's current health as bonus physical (at least 20), once per target every ${fmt(evalCalc(ctx,"tooltipcooldown").v)} s`);
        return {bonus:[{v, type:"physical", what:"Martial Cadence"}]}; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="E") K.flag={x:tgt ? (tgt.xS ?? tgt.x) : u.x, until:t+8};
        if (a.slot==="Q"){ a.ccAll ??= a.cc||[]; const F=K.flag;
          if (F && F.until>t && Math.abs(F.x-u.x) <= (a.p && a.p.range || 770)+80){ a.cc=a.ccAll; K.flag=null; displace(u, F.x, Math.max(1e-3, Math.abs(F.x-u.x)/(dvOf(CALC.champs.JarvanIV.E,"edashspeed",1)||1400)), t);
            simNotes.add(`${u.name} Q: Dragon Strike reaches the flag: he dashes to it and knocks up enemies on the way (0.75 s)`); }
          else { a.cc=a.ccAll.filter(e=>e.type!=="knockup"); simNotes.add(`${u.name} Q: Dragon Strike knocks up only when it reaches his Demacian Standard (E within 8 s)`); } }
        if (a.slot==="W" && a.shield){ const n=enemiesOf(u,t).filter(x=>!x.pet && gap(u,x) <= 600+RAD(x)).length; a.shield+=0.013*u.max*n; } },
      afterCast(u, a, tgt, t){ if (a.slot==="Q"){ if (a.ccAll) a.cc=a.ccAll;
          if (tgt && tgt.alive && a.parts.length && inReach(u,a,tgt)) (tgt.kitShred ||= {}).j4Q={until:t+3, pct:dvOf(a.S,"basearshred",a.rank)||0.1}; }
        if (a.slot!=="R" || !tgt) return;
        // he leaps onto the target champion (unit-targeted, wiki), wherever it went during the 0.35 s leap; the ring is centred there
        const cx=tgt.xS ?? tgt.x; u.move=null; displace(u, cx - (Math.sign(cx-u.x)||face(u))*(RAD(u)+RAD(tgt)), 1e-3, t, true);   /* lands at the start of the next tick */ const until=t+(dvOf(a.S,"wallduration",a.rank)||3.5), r=255;
        for (const x of [u, ...enemiesOf(u,t)]) if (x===u || Math.abs((x.xS??x.x)-cx)<=350+RAD(x)) x.arena={cx, r, until};
        say(t, `  ${u.name}: Cataclysm walls in everyone within 350 of ${tgt.name} for ${fmt(until-t)}s`);
        simNotes.add(`${u.name} R: Cataclysm's terrain ring (wiki: 350 creation radius, pathing inside 255 of the centre, 3.5 s) keeps everyone caught inside from walking or dashing out (1-D: within 255 of the target's spot); blinks and Flash still cross it; the recast that breaks the walls is not used`); },
    },
    Kalista: {
      timing:{E:"cast"},   // backlog 25: Rend tears the spears out when the cast ends (no missile)
      castable:(u, a, tgt, t)=>a.slot==="W" ? "the Sentinel deals no damage (Soul-Marked is passive)" : a.slot==="E" ? (kitRendReady(u, tgt, t) || "Rend waits until it kills or the spears are about to fall off") : a.slot!=="R" || kitOathsworn(u) ? true : "Fate's Call needs an Oathsworn ally",
      // champion audit batch 4: Rend spears from her attacks and Pierce (4 s, refreshed); E tears them out of every enemy within 1100
      onHit(u, x, t, o){ if (o.basic && o.primary) kitRend(u, x, t); },
      step(u, step, tgt, t, log){ if (step!=="W") return false; log({skipped:"the Sentinel deals no damage; Soul-Marked is her passive with the Oathsworn"}); return "logged"; },
      init(u){ const R=u.abAll.R; if (R){ R.dash=null; R.blink=false; R.knock=null; R.hard=false; } },   // Kalista doesn't move or knock anyone herself: the Oathsworn does
      onCast(u, a, tgt, t){ if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=[]; a.parts=[]; let kill=false;
          for (const x of enemiesOf(u,t)){ const v=kitRendDmg(u, x, t); if (!(v>0) || gap(u,x) > 1100+RAD(x)) continue; const n=x.rend.n; x.rend=null;
            deal(u, x, v, "physical", t, "ability", `E Rend (${n} spear${n>1?"s":""})`); if (x.alive) applyCC(u, {slot:"E", S:a.S, p:{}, cc:a.ccAll}, x, t, 0); else if (!x.dummy) kill=true; }
          if (kill) u.cd.E=t;   // wiki: a Rend kill refunds its cooldown and mana
          simNotes.add(`${u.name} E: Rend — her attacks and Pierce lodge spears (4 s, refreshed); E deals the first spear + each extra one to every enemy within 1100 and slows; a kill resets it; fight() casts it when it kills or the spears are about to fall off`); return; }
        if (a.slot!=="R") return; a.ccAll ??= a.cc||[]; a.cc=[];   // the crowd control is the Oathsworn's landing, below
        const o=kitOathsworn(u); if (!o) return; const dur=dvOf(a.S,"knockupduration",a.rank)||1;
        o.stasisUntil=Math.max(o.stasisUntil, t+1); displace(o, u.x, 1e-3, t, true);   /* lands at the start of the next tick */   // held and pulled to Kalista over 1 s: untargetable and invulnerable (wiki)
        say(t, `  ${u.name}: Fate's Call pulls ${o.name} in`);
        // positions change only through displace() (applied at the start of the next tick), never directly inside an event: another
        // side's event in the same tick must see the same positions (mirror symmetry; tests/fight_symmetry.rl)
        events.push({at:t+1, fn:(tt)=>{ if (!o.alive) return; displace(o, u.x, 1e-3, tt, true); const foes=enemiesOf(u,tt); if (!foes.length) return;
          const e=foes.slice().sort((p,q)=>gap(p,u)-gap(q,u))[0], dist=gap(e,u);
          if (dist>1200+RAD(e)) return;   // wiki: the Oathsworn dashes only toward an enemy within 1200
          o.stasisUntil=Math.max(o.stasisUntil, tt+dist/1500);   // silenced and unable to act until the dash lands (wiki); modelled as held
          events.push({at:tt+dist/1500, fn:(t2)=>{ if (!o.alive || !e.alive) return; const ex=e.x, dir=Math.sign(ex-u.x)||face(u);
            displace(o, ex - dir*Math.min(dist, (CALC.champs[o.c.champ].base.range||125)+RAD(o)+RAD(e)), 1e-3, t2, true);
            say(t2, `  ${o.name} lands from Fate's Call`);
            for (const x of enemiesOf(u,t2)) if (gap(x,e)<=300) applyCC(o, {slot:"R", S:a.S, p:{}, cc:[{type:"knockup", dur}], hard:true}, x, t2, 0); }}); }});
        simNotes.add(`${u.name} R: the Oathsworn (${o.name}) is held 1 s (untargetable), then dashes at 1500/s to the nearest enemy within 1200, lands at its own attack range and knocks up enemies within 300 of that enemy for ${fmt(dur)}s (wiki: 1/1.5/2 s; landing radius not given, 300 assumed)`); },
      afterCast(u, a, tgt, t){ if ((a.slot==="R" || a.slot==="E") && a.ccAll) a.cc=a.ccAll; if (a.slot==="Q" && tgt){ kitSoulMark(u, tgt, t); if (tgt.alive && inReach(u,a,tgt)) kitRend(u, tgt, t); } },   // Pierce applies Kalista's Soul-Mark and a spear
    },
    /* ---- champion audit (backlog 10): own-ability mechanics in fights; static numbers live in KIT ---- */
    Syndra: {
      // backlog 25: the sphere (it appears 0.6 s after the press, where the Q lands) and the charges are set at the press, so a cast
      // that lands before the Q does (E pressed right after it) sees the sphere that will be there
      pressCast(u, a, tgt, t){ const K=u.kit, n=kitStacks(u.c), P=CALC.champs.Syndra.P, t0=t;
        if (a.slot==="Q"){
          K.spheres=(K.spheres||[]).filter(s=>s.until>t); K.spheres.push({pressT:t0, from:t0+((a.p && a.p.delay) ?? 0.6), until:t0+((a.p && a.p.delay) ?? 0.6)+(dvOf(a.S,"sphereduration",a.rank)||6), x:!u.script && tgt ? (tgt.xS ?? tgt.x) : null});
          if (n >= (dvOf(P,"q1upgradethreshold",1)||40)){   // Transcendent: Dark Sphere holds 2 charges; recharge = its cooldown, 1.25 s between casts (wiki Dark Sphere)
            const cd=abCd(u,a), max=dvOf(a.S,"upgrade1maxammo",a.rank)||2, A=K.ammo ||= {n:max, at:null};
            while (A.at!=null && t>=A.at-1e-9){ A.n++; A.at = A.n<max ? A.at+cd : null; }
            A.n--; if (A.at==null) A.at=t0+cd;
            u.cd.Q = A.n>0 ? t0+1.25 : A.at;
            simNotes.add(`${u.name} Q: ${fmt(n)} Splinters of Wrath (≥ 40): ${max} charges, one every ${fmt(cd)}s, 1.25 s between casts (wiki Dark Sphere; the recharge starts when a charge is spent and runs while she has fewer than ${max})`); } }
        /* combo audit 2026-09-24 (wiki Syndra_W): Force of Will grabs a Dark Sphere that is on the ground (else a minion or monster,
           assumed at hand), refreshes its 6 s, holds it and throws it; the damage lands when it lands (throw flight: kit landAdd).
           The sphere then stays on the ground where it lands (the refresh is "only on the first cast, not when it is thrown"). */
        if (a.slot==="W"){ const s=(K.spheres||[]).find(s=>s.from<=t+1e-9 && s.until>t && !(s.heldUntil>t) && !(s.pushUntil>t));
          const fly=CHAMP_MECH.Syndra.landAdd(u, a, tgt, tgt ? gap(u,tgt) : 0);
          if (s){ s.heldUntil=t+fly; s.until=Math.max(s.until, t+6); if (tgt && !u.script) s.x=tgt.xS ?? tgt.x;
            simNotes.add(`${u.name} W: grabs a Dark Sphere on the ground (its 6 s refresh) and throws it; it lands with the damage and stays on the ground as a sphere (wiki Syndra_W); R can't take it while it is held or in flight (wiki Syndra_R)`); }
          else simNotes.add(`${u.name} W: no Dark Sphere on the ground to grab: a minion or non-epic monster within reach is assumed (wiki Syndra_W: she grabs the nearest sphere, minion or monster)`); }
        /* combo audit 2026-09-24 (wiki Syndra_E): every sphere on the ground, or appearing before the slowest wave passes, is pushed
           950 units at 2000/s (0.475 s) from when the wave reaches it; Unleashed Power doesn't pick up a sphere being pushed (wiki
           Syndra_R notes), and the push delays its expiry. perform(): every sphere is in the cone (perfect aim). */
        if (a.slot==="E"){ const ct=(a.p && a.p.castTime) ?? 0.25, noPos=u.script && !u.scriptTravel, d=tgt && !noPos ? gap(u,tgt) : 0, slow=t0+ct+Math.min(700, u.script ? 700 : d)/1100;
          for (const s of (K.spheres||[])){ if (!(s.until>t0) || s.from>slow+1e-9 || s.heldUntil>t0+ct) continue;
            const hit=Math.max(s.from, t0+ct+Math.min(700,d)/2500), end=hit+950/2000; s.pushUntil=Math.max(s.pushUntil||0, end); s.until=Math.max(s.until, end); } }
        // R (wiki Syndra_R: "takes place at the start of the cast time"): the spheres are counted at the press (KIT sim, syndraRSpheres)
        if (a.slot==="R"){ const live=syndraRSpheres(K, t).slice(0,4); K.rTaken=live; K.rUsed=3+live.length; }
      },
      // throw flight of W (combo audit 2026-09-24): no wiki value; the ability's only projectile speed in the game files is SyndraW
      // missileSpeed 1450, taken as the throw speed over the distance to the target (perform() without distance: positions ignored)
      landAdd(u, a, tgt, d0){ return a.slot==="W" && tgt && !(u.script && !u.scriptTravel) ? Math.max(0, d0)/1450 : 0; },
      /* perform() (combo audit 2026-09-24): a player maximising damage waits a moment — W for a Dark Sphere still forming (Q then W at
         once: it appears 0.6 s after the Q), R for spheres she is throwing (W) or pushing (E) that land within 1 s, so R takes them. */
      step(u, step, tgt, t, log){ if (!u.scriptWait) return false; const K=u.kit, a=u.abAll[step]; if (!a || (u.cd[step]||0)>t) return false;
        if (step==="W"){ const S=K.spheres||[], now=S.some(s=>s.from<=t+1e-9 && s.until>t && !(s.heldUntil>t) && !(s.pushUntil>t));
          if (!now && S.some(s=>s.from>t && s.until>t && !(s.heldUntil>t))){ simNotes.add(`${u.name} W (perform()): waits for the Dark Sphere to appear before grabbing it (0.6 s after its Q)`); return "wait"; } }
        if (step==="R"){ const live=syndraRSpheres(K, t).length, soon=(K.spheres||[]).filter(s=>s.until>t && ((s.heldUntil>t+1e-9 && s.heldUntil<=t+1) || (s.pushUntil>t+1e-9 && s.pushUntil<=t+1))).length;
          if (live<4 && soon>0){ simNotes.add(`${u.name} R (perform()): waits for the Dark Spheres being thrown or pushed to land (up to 1 s) so Unleashed Power takes them (wiki Syndra_R: it doesn't take a held or pushed sphere)`); return "wait"; } }
        return false; },
      onCast(u, a, tgt, t){ const K=u.kit, n=kitStacks(u.c), P=CALC.champs.Syndra.P, t0=a.land ? a.land.pressT : t;   // t0: the press (backlog 25: onCast runs when the cast lands)
        if (a.slot==="R"){ const taken=K.rTaken||[], used=K.rUsed ?? 3; K.rTaken=null; K.rUsed=null;
          K.spheres=(K.spheres||[]).filter(s=>!taken.includes(s)); for (let i=0;i<used;i++) K.spheres.push({pressT:t, from:t, until:t+6, x:!u.script && tgt ? (tgt.xS ?? tgt.x) : null});    // the spheres stay on the ground for 6 s (wiki)
          simNotes.add(`${u.name} R: 3 conjured spheres plus up to 4 Dark Spheres counted at the press: on the ground or still forming (wiki: "a sphere summoned very shortly before" is used), not one held by W or being pushed by E`); }
        if (a.slot==="E"){ a.ccAll=a.ccAll||a.cc;
          /* wiki Syndra_E (Syndra-Zed gap G6): the wave knocks back (400 units, airborne) with no stun; only an enemy hit by a pushed Dark
             Sphere is stunned (1.25 s). A sphere counts when it is (or will be) on the ground as the slowest wave passes (wiki: extra
             cone waves at 1600 and 1100/s hit spheres spawned late: Q then E stuns) and, in fight(), lies between Syndra (within 700)
             and the target, which is within the sphere's push (950 units, at most 1200 from Syndra). The 70% slow is Transcendent only (80 Splinters). */
          const ux=u.xS ?? u.x, tx=tgt ? (tgt.xS ?? tgt.x) : ux, dir=Math.sign(tx-ux)||face(u), dT=Math.abs(tx-ux), wave=t0+((a.p && a.p.castTime) ?? 0.25)+Math.min(700, u.script ? 700 : dT)/1100;
          const sphere=(K.spheres||[]).some(s=>s.until>t && s.from<=wave+1e-9 && (u.script || s.x==null || !tgt || (()=>{ const ds=(s.x-ux)*dir; return ds>=-1e-6 && ds<=700 && dT>=ds-RAD(tgt) && dT<=Math.min(ds+950, 1200)+RAD(tgt); })()));
          const up=n >= (dvOf(P,"eupgradethreshold",1)||80);
          a.cc=a.ccAll.filter(e=>(e.type!=="stun" || sphere) && (e.type!=="slow" || up));
          simNotes.add(`${u.name} E: knockback without a stun unless a Dark Sphere is pushed into the target (wiki Syndra_E; spheres from her Q/R in this fight, perfect aim); the 70% slow needs 80 Splinters (Transcendent)`);
          if (tgt && !sphere) say(t, `  ${u.name}'s E: no Dark Sphere to push into ${tgt.name}: knockback only`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="R" && tgt && tgt.alive && kitStacks(u.c) >= (dvOf(CALC.champs.Syndra.P,"rupgradethreshold",1)||100) && tgt.hp < (dvOf(a.S,"upgradeexecutethreshold",a.rank)||0.15)*tgt.max){
          say(t, `  ${u.name}: Unleashed Power executes ${tgt.name} (below 15% health, 100+ Splinters)`); deal(u,tgt,tgt.hp,"true",t,"proc","Unleashed Power execute"); } },
    },
    Viktor: {
      timing:{W:"own"},   // backlog 25: Gravity Field times its own activation and stacks (kitGravityField)
      // Hex Core augments in fights (wiki Viktor_Q/W): Turbocharge (Q) shield ×1.6 (KIT shieldMult) and +30% move speed for 2.5 s after
      // the device hits; Magnetize (W): his other abilities (not the storm's strikes) slow enemies hit by 20% for 1 s
      init(u){ const ev=kitEvolved(u.c, u.st); u.kit.vikEv=ev;
        if (ev.includes("W")){ const pct=(dvOf(CALC.champs.Viktor.W,"augmentslow",1) ?? 20)/100;
          for (const s of ["Q","E","R"]){ const A=u.abAll[s]; if (A) A.cc=[...(A.cc||[]), {type:"slow", pct, dur:1, src:{dur:"wiki", pct:"dv:AugmentSlow"}, text:"Magnetize"}]; }
          simNotes.add(`${u.name}: Magnetize (W augment): Q, E, Aftershock and the storm's initial hit slow enemies hit by ${fmt(100*pct)}% for 1 s (wiki Viktor_W; game data AugmentSlow)`); } },
      onCast(u, a, tgt, t){ const L=a.later||[];
        if (a.slot==="Q"){ const d=L.find(p=>p.later==="attack"); if (d){ u.kit.discharge={until:t+4, v:d.v}; simNotes.add(`${u.name} Q: Discharge makes the next attack within 4 s deal ${fmt(d.v)} magic damage instead of its physical damage`); }
          if ((u.kit.vikEv||"").includes("Q") && tgt){ const ms=(dvOf(a.S,"augmentmovespeedbonus",a.rank) ?? 30)/100, dur=dvOf(a.S,"buffduration",a.rank) ?? 2.5;
            addBuff(u,"turbocharge",t+dur,{mspct:ms},t); say(t, `  ${u.name}: Turbocharge +${fmt(100*ms)}% move speed for ${fmt(dur)}s`);
            simNotes.add(`${u.name} Q: Turbocharge (augment): shield ×${fmt(dvOf(a.S,"augmentshieldbonus",a.rank) ?? 1.6)} and +${fmt(100*ms)}% move speed for ${fmt(dur)} s when the device hits (wiki Viktor_Q; game data)`); } }
        if (a.slot==="E" && tgt){ const d=L.find(p=>p.later==="delay"); if (d){ const mg=(u.kit.vikEv||"").includes("W") ? a.cc.find(e=>e.text==="Magnetize") : null;
          if (u.script) kitLater(u, tgt, t+(dvOf(a.S,"delay",a.rank)||1), d, "E Aftershock");
          else kitDelayedLine(u, tgt, t, dvOf(a.S,"delay",a.rank)||1, d, "E Aftershock", (a.p && a.p.halfWidth)||80, mg); } }
        // W (phys.stackStun): the stun comes from the field's stacks, not the cast (G3); the cast itself applies no crowd control
        if (a.slot==="W" && a.p && a.p.stackStun && tgt){ a.ccAll ??= a.cc; a.wSaved=[a.cc, a.immob, a.slows, a.hardcc]; a.cc=[]; a.immob=false; a.slows=false; a.hardcc=false; kitGravityField(u, a, tgt, t); }
        if (a.slot==="R" && tgt){ const d=L.find(p=>p.later==="ticks"); if (d){ const n=Math.round(d.v/d.per);
          if (u.script){ for (let i=1;i<=n;i++) kitLater(u, tgt, t+i, {...d, v:d.per}, `R storm ${i}/${n}`);
            simNotes.add(`${u.name} R: the storm follows its target and strikes once a second, ${n} times after the initial burst (perform(): the target stands still, so every strike lands)`); }
          else kitStorm(u, a, tgt, t, {...d, v:d.per}, n); } } },
      afterCast(u, a){ if (a.wSaved){ [a.cc, a.immob, a.slows, a.hardcc]=a.wSaved; a.wSaved=null; } },
      attack(u, tgt, t){ const D=u.kit.discharge; if (D && D.until>t){ u.kit.discharge=null; return {replace:{v:D.v, type:"magic", what:"Discharge (Q empowered attack)"}}; } return null; },
    },
    Gwen: {
      onHit(u, x, t, o){ if (!o.basic) return;
        const v=evalCalc({S:CALC.champs.Gwen.P, rank:1, st:u.st, flags:u.flags}, "percenthealth1000cuts").v*x.max;
        deal(u,x,v,"magic",t,"onhit","A Thousand Cuts");
        const E=u.kit.gwenE; if (E && E.until>t){ deal(u,x,E.v,"magic",t,"onhit","Skip 'n Slash");
          if (E.first){ E.first=false; if ((u.cd.E||0)>t){ const cut=E.refund*E.cd; u.cd.E=Math.max(t, u.cd.E-cut); } } }
        if (o.primary){ const S=u.kit.snippy; u.kit.snippy={n:Math.min(4,(S && S.until>t ? S.n : 0)+1), until:t+(dvOf(CALC.champs.Gwen.Q,"buffduration",1)||6)}; } },
      onCast(u, a, tgt, t){
        if (a.slot==="Q"){ u.kit.snippy=null; simNotes.add(`${u.name} Q: 1 snip plus one per Snippy stack from attacks in the last 6 s (up to 4), then the final snip; target in the centre`); }
        if (a.slot==="W"){ const r=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"totalresists").v, dur=dvOf(a.S,"zoneduration",a.rank)||4;
          addBuff(u,"gwenW",t+dur,{bonusarmor:r, bonusmr:r},t); say(t, `  ${u.name}: Hallowed Mist +${fmt(r)} armor and MR for ${fmt(dur)}s`);
          simNotes.add(`${u.name} W: +${fmt(r)} armor and MR for 4 s (assumed: the fight stays in the mist); untargetability from outside the mist is not modelled`); }
        if (a.slot==="E"){ const S=a.S, ctx={S, rank:a.rank, st:u.st, flags:u.flags};
          const as=evalCalc(ctx,"bonusattackspeed").v, v=evalCalc(ctx,"onhitdamage").v;
          addBuff(u,"gwenE",t+(dvOf(S,"buffduration",a.rank)||4),{bonusAS:as>2?as/100:as},t);
          u.kit.gwenE={until:t+(dvOf(S,"buffduration",a.rank)||4), v, first:true, refund:dvOf(S,"cdrefund",a.rank)||0, cd:abCd(u,a)}; u.nextAA=Math.min(u.nextAA,t);
          simNotes.add(`${u.name} E: 4 s of bonus attack speed and on-hit magic damage; resets the attack timer; the first attack refunds part of the cooldown`); }
        if (a.slot==="R" && tgt){ const needle=a.parts.map(p=>({...p}));
          [[1,3],[2,5]].forEach(([dt,n])=>{ for (const p of needle) kitLater(u, tgt, t+dt, {...p, v:p.v*n}, `R cast ${dt+1} (${n} needles)`); });
          simNotes.add(`${u.name} R: recast at 1 s intervals (the static cooldown): 1 + 3 + 5 needles, all hitting the target`); } },
    },
    DrMundo: {
      onCast(u, a, tgt, t){
        if (a.slot==="W" && tgt){ const r=(a.later||[]).find(p=>p.later==="recast"); if (r) kitLater(u, tgt, t+(dvOf(a.S,"duration",a.rank)||3), r, "W recast");
          simNotes.add(`${u.name} W: charges the full 3 s, then recasts (grey health and its heal not modelled)`); }
        if (a.slot==="E"){ const v=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"additionaldamage").v; u.kit.mundoE={until:t+(dvOf(a.S,"attackoverrideduration",a.rank)||4), v, S:a.S, rank:a.rank}; u.nextAA=Math.min(u.nextAA,t); }
        if (a.slot==="R"){ const S=a.S, dur=dvOf(S,"duration",a.rank)||10, gain=(dvOf(S,"missinghealthheal",a.rank)||0)*(u.max-u.hp);
          addBuff(u,"mundoR",t+dur,{bonushp:gain},t);
          const hot=(dvOf(S,"maxhealthhot",a.rank)||0)*u.max; for (let i=1;i<=dur*2;i++) events.push({at:t+0.5*i, fn:(tt)=>heal(u,u,hot/(dur*2),tt,i===1?"Maximum Dosage":null)});
          say(t, `  ${u.name}: Maximum Dosage +${fmt(gain)} health (missing health), ${fmt(hot)} over ${fmt(dur)}s`);
          simNotes.add(`${u.name} R: base health up by ${fmt((dvOf(S,"missinghealthheal",a.rank)||0)*100)}% of missing health and ${fmt((dvOf(S,"maxhealthhot",a.rank)||0)*100)}% of maximum health regenerated over 10 s (no enemy-champion bonus at rank 3)`); } },
      attack(u, tgt, t){ const E=u.kit.mundoE; if (!E || !(E.until>t)) return null; u.kit.mundoE=null;
        const thr=dvOf(E.S,"maxmissinghealththreshold",E.rank)||0.7, mx=dvOf(E.S,"maxdamageamp",E.rank)||1.4, m=1+(mx-1)*Math.min(1,(1-u.hp/u.max)/thr);
        return {bonus:[{v:E.v*m, type:"physical", what:`Blunt Force Trauma${m>1.0001?` ×${fmt(m)}`:""}`}]}; },
    },
    Kaisa: {
      /* combo audit 2026-09-24 (wiki Kaisa_R): "An enemy champion within range and affected by Plasma is required to cast this
         ability" — affected = a stack applied or consumed within the last 4 s. perform(): an R step with no such target is skipped. */
      castable:(u, a, tgt, t)=>{ if (a.slot!=="R" || !tgt) return true; const m=tgt.kaisaPlasmaAt; return m && m.by===u && t-m.t<=4+1e-9 ? true : "Killer Instinct needs a champion affected by Plasma in the last 4 s (her attacks or W)"; },
      step(u, step, tgt, t, log){ if (step!=="R" || !u.abAll.R || (u.cd.R||0)>t) return false; const why=CHAMP_MECH.Kaisa.castable(u,u.abAll.R,tgt,t); if (why===true) return false; log({skipped:why}); return "logged"; },
      onHit(u, x, t, o){ if (o.basic && o.primary){ kitPlasma(u, x, t, 1); if ((u.cd.E||0)>t) u.cd.E=Math.max(t, u.cd.E-0.5); } },   // Supercharge: −0.5 s per attack (wiki)
      onCast(u, a, tgt, t){
        if (a.slot==="E"){ const as=[0.4,0.5,0.6,0.7,0.8][a.rank-1]||0.4;   // wiki Supercharge 40–80% (not in the exported game data)
          addBuff(u,"kaisaE",t+4,{bonusAS:as},t); simNotes.add(`${u.name} E: +${fmt(as*100)}% attack speed for 4 s at once (after the charge-up cast time: backlog 25; wiki value, one source)`); }
        if (a.slot==="R") u.nextAA=Math.min(u.nextAA,t);
        if (a.slot==="Q") simNotes.add(`${u.name} Q: every missile hits the one target (${kitEvolved(u.c,u.st).includes("Q")?12:6}; first full, the rest 25%)`); },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && tgt && tgt.alive){ const ev=kitEvolved(u.c,u.st).includes("W"); kitPlasma(u, tgt, t, ev?3:2);
        const t0=pressOf(a,t); if (ev && (u.cd.W||0)>t) u.cd.W = Math.max(t, t0+(u.cd.W-t0)*0.25); } },
    },
    Smolder: {
      onCast(u, a, tgt, t){
        if (a.slot==="Q" && tgt){ const b=(a.later||[]).find(p=>p.later==="burn"); if (b){ for (let i=1;i<=3;i++) kitLater(u, tgt, t+i, {...b, v:b.v/3}, `Q burn ${i}/3`); tgt.kitBurnBy=u; tgt.kitBurnUntil=t+3;
          simNotes.add(`${u.name} Q: 225+ stacks: the burn (true damage, maximum health) over 3 s in 3 ticks, and the 6.5% execute while it burns`); } } },
      afterCast(u, a, tgt, t){ kitSmolderExecute(u, tgt, t); },
    },
    Ezreal: {
      onCast(u, a, tgt, t){ u.kit.hit=new Set(); if (a.slot==="W" && tgt){ const m=(a.later||[]).find(p=>p.later==="mark"); if (m){ tgt.ezMark={by:u, until:t+(dvOf(a.S,"detonationtimeout",a.rank)||4), v:m.v};
        simNotes.add(`${u.name} W: the mark is detonated by the next attack or ability hit within 4 s`); } } },
      onDealt(att, tgt, v, pre, type, t, kind){ if (att.kit.hit && kind==="ability") att.kit.hit.add(tgt); },
      afterCast(u, a, tgt, t){ const hit=[...(u.kit.hit||[])]; u.kit.hit=null; if (!tgt) return;
        if (a.slot==="W"){ kitEzP(u, t); return; }                 // the orb's hit (the mark) counts for Rising Spell Force
        if (!hit.length) return;                                    // missed: no stack, no detonation, no refund
        kitEzP(u, t);
        for (const x of hit) kitEzDetonate(u, x, t);
        if (a.slot==="Q"){ const cut=dvOf(a.S,"cdrefund",a.rank)||1.5; for (const s of ["Q","W","E","R"]) if ((u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-cut);
          simNotes.add(`${u.name} Q: a hit cuts every current cooldown by ${fmt(cut)} s`); } },
      onHit(u, x, t, o){ if (o.basic && o.primary) kitEzDetonate(u, x, t); },
    },
    Yone: {
      init(u){ kitStormStart(u); },
      afterCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t, true); },
      attack(u, tgt, t, mult){ u.kit.swings=(u.kit.swings||0)+1; if (u.kit.swings%2) return null;   // Steel first, then Azakana: half physical, half magic
        const v=u.st.ad*mult*(dvOf(CALC.champs.Yone.P,"magicdamagesplit",1) ?? 0.5);
        simNotes.add(`${u.name}: every second attack (Azakana Sword) deals half its damage as magic damage`);
        return {replace:{v, type:"physical", what:"attack (Azakana, physical half)"}, bonus:[{v, type:"magic", what:"attack (Azakana, magic half)"}]}; },
      onCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t); if (a.slot==="E"){ u.kit.yoneE={until:t+(dvOf(a.S,"returntimer",a.rank)||5), pct:dvOf(a.S,"deathmarkpercent",a.rank)||0.25, stored:new Map(), step:u.curStep};
        const E=u.kit.yoneE; events.push({at:E.until, fn:(tt)=>kitYoneDetonate(u, tt, E)});
        simNotes.add(`${u.name} E: stores ${fmt(E.pct*100)}% of the post-mitigation damage dealt to champions for 5 s, dealt again as true damage on the return (a second E step recasts early)`); } },
      onDealt(att, tgt, v, pre, type, t){ const E=att.kit.yoneE; if (E && E.until>t && !E.done && (type==="physical"||type==="magic")) E.stored.set(tgt, (E.stored.get(tgt)||0)+v*E.pct); },
      step(u, step, tgt, t){ const E=u.kit.yoneE; if (step!=="E" || !E || E.done || !(E.until>t)) return false; E.step=null; kitYoneDetonate(u, t, E); return true; },
    },
    Yasuo: {
      init(u){ kitStormStart(u); },
      castable:(u, a, tgt, t)=>a.slot!=="R" || kitAirborne(u, t) ? true : "Last Breath needs an airborne enemy champion",
      step(u, step, tgt, t, log){ if (step!=="R" || !u.abAll.R || (u.cd.R||0)>t) return false; const why=CHAMP_MECH.Yasuo.castable(u,u.abAll.R,tgt,t); if (why===true) return false; log({skipped:why}); return "logged"; },
      onCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t); },
      afterCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t, true); },
      onHurt(u, att, v, type, t){ if (!u.kit.flowSpent && att && !att.dummy && v>0){ u.kit.flowSpent=true;
        const s=evalCalc({S:CALC.champs.Yasuo.P, rank:1, st:u.st, flags:u.flags},"shieldvalue").v; u.shieldDone+=addShield(u, s, 1, t, {id:"flow"}); say(t, `  ${u.name}: Resolve shield ${fmt(s)} (1 s)`);
        simNotes.add(`${u.name}: starts with full Flow; the first champion damage taken triggers the Resolve shield (no Flow regained: nobody moves in fight())`); } },
    },
    Samira: {
      init(u){ const n=kitStacks(u.c); if (n>0){ u.kit.style={n, last:null, until:6}; simNotes.add(`${u.name} starts with ${fmt(n)} Style stacks (set with .stacks; they last 6 s)`); } },
      onTakedown(u, x, t){ if (!x.dummy && (u.cd.E||0)>t){ u.cd.E=t; say(t, `  ${u.name}: Wild Rush reset (takedown)`); } },
      attack(u, tgt, t){ kitStyle(u, "AA", t); const v=evalCalc({S:CALC.champs.Samira.P, rank:1, st:u.st, flags:u.flags},"bonusmeleedamage").v*(1+Math.min(1, 1-tgt.hp/tgt.max));
        simNotes.add(`${u.name}: attacks are blade attacks (target within 200 units assumed) with the Daredevil Impulse magic bonus`);
        return {bonus:[{v, type:"magic", what:"Daredevil Impulse"}]}; },
      onCast(u, a, tgt, t){ kitStyle(u, a.slot, t);
        if (a.slot==="E"){ addBuff(u,"samiraE",t+(dvOf(a.S,"attackspeedduration",a.rank)||5),{bonusAS:dvOf(a.S,"bonusattackspeed",a.rank)||0},t); }
        if (a.slot==="W" && tgt){ for (const p of a.parts) kitLater(u, tgt, t+(dvOf(a.S,"slashduration",a.rank)||0.75), p, "W second slash"); }
        if (a.slot==="R" && tgt){ for (let i=1;i<10;i++) for (const p of a.parts) kitLater(u, tgt, t+0.2*i, p, `R shot ${i+1}/10`);
          u.kit.style={n:0, until:-1, last:null}; simNotes.add(`${u.name} R: 10 shots over 2 s, all at the one target; needs 6 Style stacks (one per hit of a different kind than the previous)`); } },
      castable:(u, a, tgt, t)=>{ if (a.slot!=="R") return true; const S=u.kit.style; return S && S.until>t && S.n>=6 ? true : "needs 6 Style stacks"; },
      step(u, step, tgt, t, log){ if (step!=="R") return false; const S=u.kit.style; if (S && S.until>t && S.n>=6) return false;
        log({skipped:`needs 6 Style stacks (has ${S && S.until>t ? S.n : 0})`}); return "logged"; },
    },
    Zed: {
      onHit(u, x, t, o, e, hpB){ if (!o.basic || !o.primary || !x.alive) return; if (!(hpB < 0.5*x.max) || (x.zedP||-1)>t) return;
        x.zedP=t+(dvOf(CALC.champs.Zed.P,"perunitcd",1)||10); const pct=evalCalc({S:CALC.champs.Zed.P, rank:1, st:u.st, flags:u.flags},"maxhpdamage").v;
        deal(u,x,pct*x.max,"magic",t,"onhit","Contempt for the Weak"); },
      /* Syndra-Zed gaps G1-G4 (wiki Zed_W, Zed_E, Zed_R, checked 2026-09-24). Shadows: {src, from (lands), until, x (fight(): position; perform(): null)}.
         R: untargetable from the cast (no cast time); after 0.6 s he dashes over 0.35 s and lands 125 units from the target; the mark is
         applied on landing (not if the target is untargetable then) and pops 3 s later. He can't act, attack or use items meanwhile
         (wiki interaction table), modelled as stasis on Zed for 0.95 s. W (fight()): the shadow is thrown at the target (perfect aim,
         up to 700 units at 2500/s); Zed swaps to it (W recast) when it is closer to the target than he is and he is out of attack range. */
      startCast(u, a, tgt, t, d0){ const K=u.kit;
        if (a.slot==="W" && !u.script){ a.quiet=true; resolveCast(u, a, tgt, t, d0); a.quiet=false; return true; }   // W moves the shadow, not Zed (no generic dash)
        if (a.slot!=="R") return false;
        tgt = tgt || enemiesOf(u,t)[0]; if (!tgt) return false;
        const delay=(a.p && a.p.dashDelay)||0.6, dash=Math.max(0, ((a.p && a.p.delay)||0.95)-delay) || 0.35, land=t+delay+dash, step=u.curStep ?? null;   // phys: delay 0.95 = dashDelay 0.6 + the 0.35 s dash (wiki)
        K.shadows=kitShadowsAt(u,t).filter(s=>s.src!=="R"); K.shadows.push({src:"R", from:t, until:t+9, x:u.script?null:u.x});   // spawned at the cast position (wiki)
        castStasis(u, land, t); u.nextAct=Math.max(u.nextAct, land); u.nextAA=Math.max(u.nextAA, land);   // untargetable from the cast, for the whole cast step (item 24)
        tgt.zedIncoming={by:u, land};
        say(t, `${u.name} casts R on ${tgt.name}: untargetable, dashes after ${fmt(delay)}s over ${fmt(dash)}s and reappears at ${fmt(land)}s`);
        simNotes.add(`${u.name} R: no cast time; untargetable and unable to act for ${fmt(delay+dash)} s (${fmt(delay)} s delay + ${fmt(dash)} s dash, wiki), lands 125 units from the target (the wiki's "beyond" side isn't modelled on the 1-D line), then applies the mark (none if the target is untargetable then), which pops 3 s later`);
        if (!u.script) events.push({at:t+delay, fn:(tt)=>{ if (!u.alive || !tgt.alive) return; const dir=tgt.x===u.x ? face(u) : Math.sign(tgt.x-u.x); displace(u, tgt.x-dir*125, dash, tt, true); }});
        events.push({at:land, fn:(tt)=>{ if (tgt.zedIncoming && tgt.zedIncoming.by===u) tgt.zedIncoming=null; if (!u.alive) return;
          const prev=u.curStep; u.curStep=step; a.quiet=true; resolveCast(u, a, tgt, tt, d0); a.quiet=false; u.curStep=prev; }});
        return true; },
      act(u, tgt, t, cc, role){ if (!cc || !tgt) return false; const K=u.kit, W=u.abAll.W, tx=tgt.xS ?? tgt.x, g=gap(u,tgt);
        // W recast: swap with the shadow when it is closer to the target and Zed is out of attack range (not while rooted or grounded, wiki)
        const S=kitShadowsAt(u,t).find(s=>s.src==="W" && s.x!=null && !s.swapped && !(s.from>t));
        if (S && canDash(u,t) && g>aaReach(u,tgt)+1e-6 && Math.abs(S.x-tx)<g-1){ const ox=u.xS ?? u.x, nx=S.x; displace(u, nx, 1e-3, t); S.x=ox; S.swapped=true; u.nextAct=t+dt;
          say(t, `${u.name} recasts W: swaps places with his shadow (${fmt(g)} → ${fmt(Math.abs(nx-tx))} units from ${tgt.name})`); return true; }
        // W: thrown at the target when she is within its range; R first when it's ready, in range and before W in the rotation
        if (W && (!u.rotation || u.rotation.includes("W")) && !(t<(u.cd.W||0)) && !enShort(u,W,t) && g<=(W.p.range||700)+RAD(tgt)){ const R=u.ab.R, rot=u.rotation||"RQEW";
          const rFirst = R && rot.includes("R") && (!rot.includes("W") || rot.indexOf("R")<rot.indexOf("W")) && !(t<(u.cd.R||0)) && canDash(u,t);
          if (!rFirst){ cast(u, W, tgt, t); return true; } }
        // Q and E that reach the target only from a shadow
        for (const s of order(u)){ if (s!=="Q" && s!=="E") continue; const a=u.ab[s]; if (!a || t<(u.cd[s]||0) || inReach(u,a,tgt) || enShort(u,a,t)) continue;
          if (kitShadowsAt(u,t).some(z=>z.x!=null && !(z.from>t) && Math.abs(z.x-tx)<=abReach(u,a,tgt)+1e-6)){ cast(u, a, tgt, t); return true; } }
        return false; },
      hitList(u, a, tgt, t){ if (a.slot!=="Q" && a.slot!=="E") return null;
        const sh=kitShadowsAt(u,t).filter(s=>s.x!=null && !(s.from>t)); if (!sh.length) return null;
        const from=[u.xS ?? u.x, ...sh.map(s=>s.x)], reaches=x=>from.some(o=>Math.abs((x.xS ?? x.x)-o)<=abReach(u,a,x)+1e-6);
        if (a.slot==="E") return enemiesOf(u,t).filter(reaches);
        return tgt && tgt.alive && !inStasis(tgt,t) && reaches(tgt) ? [tgt] : []; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W"){ K.shadows=kitShadowsAt(u,t).filter(s=>s.src!=="W"); const sp=(a.p && a.p.speed)||2500, rg=(a.p && a.p.range)||700;
          const sh={src:"W", from:t, until:t+(dvOf(a.S,"shadowduration",a.rank)||5.25), x:null};
          if (!u.script && tgt){ const ux=u.xS ?? u.x, tx=tgt.xS ?? tgt.x, d=Math.min(rg, Math.abs(tx-ux)); sh.x=ux+(tx===ux ? face(u) : Math.sign(tx-ux))*d; sh.from=t+d/sp;
            say(t, `${u.name} casts W: the shadow flies ${fmt(d)} units toward ${tgt.name} (lands at ${fmt(sh.from)}s)`);
            simNotes.add(`${u.name} W: no cast time (wiki); in fight() the shadow is thrown at the target (up to ${fmt(rg)} units at ${fmt(sp)}/s) and mimics Q and E from where it lands; Zed swaps to it when it's closer to the target and he is out of attack range`); }
          K.shadows.push(sh); }
        if (a.slot==="Q" && kitShadows(u).length) simNotes.add(`${u.name} Q: each live shadow throws a shuriken too; each deals full damage to the target (wiki: mimicked casts are separate)`);
        if (a.slot==="E"){ a.ccAll=a.ccAll||a.cc;   // wiki Zed_E: only a shadow's slash slows
          const hit = kitShadowsAt(u,t).some(s=>!(s.from>t) && (s.x==null || !tgt || Math.abs(s.x-(tgt.xS ?? tgt.x))<=abReach(u,a,tgt)+1e-6));
          a.cc = hit ? a.ccAll : a.ccAll.filter(e=>e.type!=="slow");
          if (!hit) simNotes.add(`${u.name} E: no shadow slash reaches the target, so no slow (wiki Zed_E: enemies hit by a shadow's slash are slowed)`); }
        if (a.slot==="R"){ const m=(a.later||[]).find(p=>p.later==="mark"); if (!(tgt && m && tgt.alive)) return;
          if (inStasis(tgt,t)){ say(t, `${u.name} reappears next to ${tgt.name}, who is untargetable: no Death Mark (wiki Zed_R)`); return; }
          if (blocked(u,a,tgt,t)) return;   // a spell shield blocks only the mark's application (wiki)
          const M={u, until:t+(dvOf(a.S,"rdeathmarkduration",a.rank)||3), stored:0, amp:dvOf(a.S,"rdamageamp",a.rank)||0.25, step:u.curStep}; tgt.zedMark=M;
          say(t, `${u.name} reappears next to ${tgt.name}: Death Mark (pops at ${fmt(M.until)}s)`);
          events.push({at:M.until, fn:(tt)=>{ if (tgt.zedMark===M) tgt.zedMark=null; if (!tgt.alive || !u.alive) return;
            if (inStasis(tgt,tt)){ say(tt, `Death Mark pops while ${tgt.name} is in stasis: no damage`); return; }
            const b=u.dealt, prev=u.curStep; u.curStep=M.step;
            deal(u,tgt,m.v + M.amp*M.stored,"physical",tt,"ability",`Death Mark (${fmt(M.amp*100)}% of ${fmt(M.stored)} stored)`);
            u.curStep=prev; if (M.step!=null && u.stepLog[M.step]) u.stepLog[M.step].dmg += u.dealt-b; }});
          simNotes.add(`${u.name} R: the mark is applied when the dash ends (0.95 s after the cast) and pops 3 s later for 100% AD plus ${fmt(M.amp*100)}% of the physical and magic damage (before mitigation) Zed dealt meanwhile; a stasis over the pop avoids it`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="E" && tgt && (u.cd.W||0)>t) u.cd.W=Math.max(t, u.cd.W-(dvOf(a.S,"shadowhitcdr",a.rank)||3));
        // W passive (item 24): energy when Zed and a shadow, or two shadows, hit the same target with one Q or E (wiki Zed_W; spell shields not checked)
        if ((a.slot==="Q" || a.slot==="E") && tgt && tgt.alive && enOf(u) && !inStasis(tgt,t)){ const tx=tgt.xS ?? tgt.x, r=abReach(u,a,tgt)+1e-6;
          const n=(u.script || Math.abs((u.xS ?? u.x)-tx)<=r ? 1 : 0) + kitShadowsAt(u,t).filter(z=>!(z.from>t) && (z.x==null || Math.abs(z.x-tx)<=r)).length;
          if (n>=2){ const W=u.abAll.W; enGain(u, dvOf(CALC.champs.Zed.W,"energyrestoredoublehit",Math.max(1,(W&&W.rank)||1))||30, t, "Living Shadow: a double hit"); } } },
      onDealt(att, tgt, v, pre, type, t){ const M=tgt.zedMark; if (M && M.u===att && t<M.until && (type==="physical"||type==="magic")) M.stored+=pre; },
    },
    Akali: {
      timing:{W:"own"},   // backlog 25: the shroud times itself from the press (invisible from 0.5 s: the 0.25 s cast + the smoke's flight)
      /* viktor-akali gaps G1/G2/G4/G5/G7 (wiki Akali_W/E/R, Invisibility; checked 2026-09-24). fight() only (perform() keeps one E step =
         both casts and R scheduling its own recast):
         W  Twilight Shroud: +30–50% move speed decaying over 2 s and 100 energy over 0.4 s from the start of the cast (she can move during
            it); invisible in the shroud from 0.5 s (0.25 s cast + the smoke bomb's 250 units at 1000/s; assumed: she stays in the shroud)
            until it ends, except while dashing and for 1/0.9/0.825/0.725/0.625 s (levels 1/7/10/13/16) after each attack or cast.
            Cast when she needs the energy for Q, when the rotation puts W first, or to walk out of a Gravity Field in time.
         E  the throw flips her 400 units BACK from 0.15 s (1500/s); the shuriken leaves at 0.25 s and reaches 825 from where she stood;
            a hit marks the target for 3 s; the recast (0.1 s cast) dashes to it at 1500/s, the 70% hit on arrival.
         R  R1 (0.25 s cast, unit-targeted, 675) dashes 750 toward the target at 1500/s, hits as she passes and flips at least 150 past
            (1-D: she ends that far from the target on her own side); R2 (no cast time, 2.5–10 s after R1) dashes 800 at 3000/s through
            the target when it kills, at the 70%-missing cap, when the window closes, or away to escape a Gravity Field.
         energy: 200 (+100 while the shroud lasts), 10 per second; Q 110–70, E 30. */
      init(u){ if (u.script) return; for (const s of ["E","R"]){ const A=u.abAll[s]; if (A){ A.dash=false; A.blink=false; } }
        u.kit.en=200; u.kit.enT=0;
        simNotes.add(`${u.name}: energy 200 (+100 while the shroud lasts), +10 per second; Q costs ${fmt(akCost(u,"Q"))}, E 30; W restores 100 over 0.4 s (wiki Akali; game data)`);
        simNotes.add(`${u.name} W: +${fmt(100*akWms(u))}% move speed decaying over 2 s and invisible in the shroud from 0.5 s after the cast (unless dashing or for ${fmt(akReveal(u))} s after an attack or cast); an invisible unit can't be targeted by attacks or point-and-click spells, but skillshots and areas hit her (wiki Invisibility; perfect aim, and she's assumed to stay inside the shroud: gap G15)`); },
      castable(u, a, tgt, t){ if (u.script) return true; const K=u.kit;
        if (K.busyUntil>t) return "she is dashing or casting";
        if (a.slot==="E" && K.akE && K.akE.until>t) return "E is marked: the recast comes next";
        if (a.slot==="R" && K.akR && K.akR.until>t) return "R2 comes next";
        const c=akCost(u, a.slot); if (c>0 && akEnergy(u,t)<c-1e-9) return `not enough energy (${fmt(akEnergy(u,t))} < ${fmt(c)})`;
        if (tgt && (a.slot==="E" || a.slot==="R")){ const pos=u.xS ?? u.x, dir=Math.sign(tgt.x-pos)||face(u), g=gap(u,tgt);
          const land = a.slot==="E" ? pos-dir*((a.p.flipBack||{}).dist||400) : tgt.x-dir*Math.max(150, (a.p.dashRange||750)-g);
          if (!akLandOK(u, land, t+(a.slot==="E" ? 0.42 : 0.25+(g+Math.max(150,(a.p.dashRange||750)-g))/(a.p.dashSpeed||1500)), t)) return "it would land her in a Gravity Field she couldn't leave before the stun"; }
        return true; },
      startCast(u, a, tgt, t, d0){ if (u.script || !tgt) return false; const K=u.kit;
        if (a.slot!=="W") akRevealAt(u, t);
        const c=akCost(u, a.slot); if (c>0){ akEnergy(u,t); K.en-=c; }
        if (a.slot==="E"){ akThrow(u, a, tgt, t, d0); return true; }
        if (a.slot==="R"){ akR1(u, a, tgt, t, d0); return true; }
        return false; },
      onCast(u, a, tgt, t){ if (u.script || a.slot!=="W") return; const K=u.kit;
        const ms=akWms(u), dur=dvOf(a.S,"movementspeedduration",a.rank)||2, sd=dvOf(a.S,"baseduration",a.rank)||5;
        addBuff(u,"akaliW",t+dur,{mspct:ms},t); const b=u.buffs.find(b=>b.id==="akaliW"); if (b) b.decayFrom=t;
        u.shroud={cast:t, from:t+0.5, until:t+0.5+sd}; u.nextAct=t+dt; K.busyUntil=t+(a.p.castTime||0.25); u.nextAA=Math.max(u.nextAA, t+(a.p.castTime||0.25));
        for (let i=1;i<=4;i++) events.push({at:t+0.1*i, fn:(tt)=>{ akEnergy(u,tt); K.en=Math.min(300, K.en+25); }});
        say(t, `  ${u.name}: Twilight Shroud: +${fmt(100*ms)}% move speed decaying over ${fmt(dur)}s, +100 energy over 0.4s, invisible from ${fmt(t+0.5)}s to ${fmt(t+0.5+sd)}s (revealed ${fmt(akReveal(u))}s after each attack or cast, and while dashing)`); },
      hitList(u, a, tgt, t){ return a.akHit ? (tgt && tgt.alive && !inStasis(tgt,t) ? [tgt] : []) : null; },
      act(u, tgt, t, cc, role){ akRingExit(u, t); if (!cc || !tgt) return false; const K=u.kit, W=u.abAll.W;
        // a Gravity Field she can't walk out of in time: R2 away from its centre, or E thrown at the target to flip back out of it
        const Z=zones.length ? zoneThreat(u,t) : null;
        if (Z && canDash(u,t) && !zoneExit(u, Z, tgt, t) && !(K.busyUntil>t)){ const pos=u.xS ?? u.x, away=pos===Z.F.x ? -Math.sign(tgt.x-pos)||-face(u) : Math.sign(pos-Z.F.x);
          if (K.akR && t>=K.akR.from && t<K.akR.until && Z.F.r+RAD(u)-Math.abs(pos-Z.F.x) < 800){ akR2(u, tgt, t, away); return true; }
          const E=u.abAll.E, tdir=Math.sign(tgt.x-pos)||face(u);
          if (E && !(t<(u.cd.E||0)) && !(K.akE && K.akE.until>t) && akEnergy(u,t)>=30 && Math.abs(pos-400*tdir-Z.F.x) > Z.F.r+RAD(u) && Z.stunAt-t > 0.15+400/1500){
            say(t, `${u.name} throws E at ${tgt.name} to flip out of the Gravity Field`); cast(u,E,tgt,t); return true; }
          if (W && !(t<(u.cd.W||0)) && !(u.shroud && u.shroud.until>t)){ const need=Z.F.r+RAD(u)+1-Math.abs(pos-Z.F.x), v=(u.st.msraw||u.st.ms)*(1+(u.st.mspct||0)+akWms(u)*0.5)*(1-slowNow(u,t));
            if (need/Math.max(1,v) <= Z.stunAt-t){ say(t, `${u.name} casts W to speed out of the Gravity Field`); cast(u,W,null,t); return true; } } }
        if (K.busyUntil>t) return false;
        // E recast: dash to the marked target (as soon as she can)
        if (K.akE && K.akE.until>t && K.akE.tgt.alive && canDash(u,t)){ const x=K.akE.tgt, pos=u.xS ?? u.x, d=Math.max(0, gap(u,x)-RAD(u)-RAD(x));
          if (akLandOK(u, x.x-(Math.sign(x.x-pos)||face(u))*(RAD(u)+RAD(x)), t+0.1+d/(K.akE.a.p.dashSpeed||1500), t)){ akRecastE(u, K.akE, t); return true; } }
        // R2 through the target: when it kills, at the 70%-missing cap, or when the window is closing
        if (K.akR && t>=K.akR.from && t<K.akR.until && canDash(u,t)){ const x=K.akR.tgt, g=gap(u,x);
          if (x.alive && g-RAD(u)-RAD(x) <= 800){ const p=K.akR.part, raw=partDmg(p, x), v=mitigate(raw, p.type, u.st, x.st).v, sh=x.shields.reduce((s,z)=>s+shieldLeft(z,t),0);
            const dir2=Math.sign(x.x-(u.xS ?? u.x))||face(u), landOK = v >= x.hp+sh || akLandOK(u, x.x-dir2*Math.max(0, 800-g), t+800/3000, t);
            if (landOK && (v >= x.hp+sh || x.hp <= 0.3*x.max || t >= K.akR.until-0.3)){ akR2(u, x, t, Math.sign(x.x-(u.xS ?? u.x))||face(u), true); return true; } } }
        // W: for energy (Q not affordable and Q is ready), or first when the rotation says so
        if (W && !(t<(u.cd.W||0)) && !(u.shroud && u.shroud.until>t)){ const Q=u.abAll.Q, rot=u.rotation||"";
          const needEn = Q && !(t<(u.cd.Q||0)) && akEnergy(u,t) < akCost(u,"Q") && gap(u,tgt) <= 1000;
          // W first: cast by 1500 units, so she is invisible (0.5 s later) before walking into point-and-click range (Viktor Q 730)
          const first = rot.includes("W") && [...rot].filter(s=>"QER".includes(s) && rot.indexOf(s)<rot.indexOf("W")).every(s=>!u.ab[s] || t<(u.cd[s]||0)) && gap(u,tgt) <= 1500;
          if (needEn || first){ say(t, `${u.name} casts W${needEn?" (for energy)":""}`); cast(u,W,null,t); return true; } }
        return false; },
      afterCast(u, a, tgt, t){ if (!tgt || !a.parts.length) return;
        // perform(): the R recast is scheduled whether or not a ring is already up (it used to be lost when R followed another ability)
        if (a.slot==="R" && u.script){ const r=(a.later||[]).find(p=>p.later==="recast"); if (r){ const t0=a.castAt ?? t, W=(a.p.recastDash||{}).window||10, step=u.curStep ?? null;   // lockout from the R1 cast, as fight()'s kit
            // R2 is a cast: it waits while she can't dash (stunned, rooted, grounded…) or the target is in stasis (Zhonya's), up to
            // the 10 s recast window from R1 (wiki Akali_R), instead of landing on a stunned Akali or being lost to the stasis
            const go=(tt)=>{ if (!u.alive || !tgt.alive) return;
              if (!canDash(u,tt) || locked(u,tt) || inStasis(tgt,tt)){ if (tt+dt<=t0+W+1e-9) events.push({at:tt+dt, fn:go});
                else say(tt, `  ${u.name}'s R recast window closes (${!canDash(u,tt)||locked(u,tt)?"she can't dash":`${tgt.name} is in stasis`})`); return; }
              const prev=u.curStep, b=u.dealt; u.curStep=step; deal(u,tgt,partDmg({...r, pct:!!r.pctOf},tgt),r.type,tt,"ability","R recast");
              u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; };
            events.push({at:t0+(dvOf(a.S,"cooldownbetweencasts",a.rank)||2.5), fn:go}); }
          simNotes.add(`${u.name} R: recast after the 2.5 s lockout, its damage raised by the target's missing health then`); }
        if (!u.script){ akRing(u, tgt, t, a); return; }
        const P=u.kit.akaliP; if (P && P.until>t) return;
        u.kit.akaliP={until:t+4}; simNotes.add(`${u.name}: an ability hit creates the ring; the next attack is Swinging Kama (perform(): assumed she steps out of the ring at once)`); },
      // fight(): step out of the ring for Swinging Kama rather than a plain attack; with Kama, attack from its doubled range (G6)
      actLate(u, tgt, t){ const K=u.kit, pos=u.xS ?? u.x;
        if (K.ring && K.ring.until>t){ if (akRingExit(u, t)) return false;
          if (!canMove(u,t)) return false; const dir=Math.sign(pos-K.ring.cx) || -(Math.sign((tgt.xS ?? tgt.x)-pos)||face(u));
          walk(u, K.ring.cx+dir*(K.ring.r+1), t, `steps out of her ring for Swinging Kama`); return true; }
        if (K.kama && K.kama.until>t){ const reach=(u.st.range+(K.kama.bonus||125))+RAD(u)+RAD(tgt), g=gap(u,tgt);
          if (g<=reach+1e-6){ if (t>=u.nextAA && canAttack(u,t) && !unseen(tgt,t)){ autoAttack(u,tgt,t); return true; } holdStill(u); return true; }
          if (canMove(u,t)){ walk(u, (tgt.xS ?? tgt.x)-Math.sign((tgt.xS ?? tgt.x)-pos||face(u))*(reach-1), t, `walks toward ${tgt.name} (Swinging Kama range)`); return true; } }
        return false; },
      attack(u, tgt, t){ if (!u.script) akRevealAt(u, t);   // attacking breaks the invisibility (wiki Akali_W)
        if (!u.script){ const K=u.kit; if (!(K.kama && K.kama.until>t)) return null; K.kama=null;
          const v=evalCalc({S:CALC.champs.Akali.P, rank:1, st:u.st, flags:u.flags},"damage").v; return {bonus:[{v, type:"magic", what:"Swinging Kama"}]}; }
        const P=u.kit.akaliP; if (!P || !(P.until>t)) return null; u.kit.akaliP={until:t+0.01, used:true};
        const v=evalCalc({S:CALC.champs.Akali.P, rank:1, st:u.st, flags:u.flags},"damage").v; return {bonus:[{v, type:"magic", what:"Swinging Kama"}]}; },
    },
    Caitlyn: {
      timing:{W:"cast"},   // backlog 25: the trap is placed when the cast ends and arms 1 s later (the kit times the arming)
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Caitlyn.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        // Headshots are consumed on-attack (wiki Caitlyn_P): whether this attack is one is decided at its start (u.aaT0; the hook runs at the landing)
        const t0=u.aaT0 ?? t; K.caitFree=(K.caitFree||[]).filter(f=>f.until>t0); const free=K.caitFree.filter(f=>!(f.from>t0)).sort((a,b)=>b.w-a.w)[0] || null;
        if (!free){ K.count=(K.count||0); if (K.count < (dvOf(P,"attacksperheadshot",1)||5)){ K.count++; return null; } K.count=0; }
        else K.caitFree=K.caitFree.filter(f=>f!==free);
        const v=evalCalc(ctx,"headshotbonusdamage").v + (free && free.w ? free.w : 0);
        simNotes.add(`${u.name}: every 6th attack is a Headshot (5 stacks, then the Headshot); a trap or net hit grants one more`);
        return {bonus:[{v, type:"physical", what:`Headshot${free && free.w ? " (trap)" : free ? " (net)" : ""}`}]}; },
      // Yordle Snap Trap (wiki; game data mMaxAmmo 3/3/4/4/5, mAmmoRechargeTime 26–10 s, 0.5 s between casts): placed under the target, arms
      // after 1 s; the first enemy champion on it that isn't trap-immune springs it (root 1.5 s, trap Headshot, 3 s immunity to her traps)
      castable:(u, a, tgt, t)=>a.slot!=="W" || !tgt ? true : tgt.caitImm>t+1 ? "the target is immune to her traps (3 s after springing one)"
        : (u.kit.traps||[]).some(tr=>tr.until>t && Math.abs(tr.x-(tgt.xS ?? tgt.x)) <= tr.r+RAD(tgt)) ? "a trap of hers is already under the target" : true,
      onCast(u, a, tgt, t){ if (a.slot==="W" && tgt){ const m=(a.later||[]).find(p=>p.later==="headshot"), K=u.kit; a.ccAll ??= a.cc||[]; a.cc=[];
          const trap={x:tgt.xS ?? tgt.x, r:(a.p && a.p.radius)||75, armAt:t+1, until:t+(dvOf(a.S,"trapduration",a.rank)||30), w:m?m.v:0, root:(a.ccAll.find(e=>e.type==="root")||{}).dur||dvOf(a.S,"rootduration",a.rank)||1.5, S:a.S};
          const mx=dvOf(a.S,"maximumtraps",a.rank)||3; K.traps=(K.traps||[]).filter(x=>x.until>t); if (K.traps.length>=mx) K.traps.shift(); K.traps.push(trap);   // beyond the maximum the oldest trap goes
          const check=(tt)=>{ if (!kitTrapCheck(u, trap, tt)) events.push({at:tt+0.25, fn:check}); }; events.push({at:trap.armAt, fn:check});
          simNotes.add(`${u.name} W: a trap is placed under the target and arms after 1 s; the first enemy champion on it springs it (root 1.5 s, a Headshot with the trap bonus within 1.8 s) and can't spring her traps for 3 s; charges 3/3/4/4/5, one every 26–10 s (ability haste applies), 0.5 s between casts`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; if (a.slot==="E" && tgt) u.kit.caitFree=(u.kit.caitFree||[]).filter(f=>f.src!=="E").concat([{src:"E", from:t, until:t+1.8, w:0}]); },
    },
    /* ---- champion audit batch 2 (2026-09-24) ---- */
    // Riven (wiki Broken Wings, Blade of the Exile, Wind Slash, Runic Blade): Q casts 3 times (0.3125 s static between
    // casts, 4 s to recast, the 13 s cooldown runs from the first cast); only the third knocks back and has the larger
    // radius (150 → 250); each cast resets the attack timer. R: Blade of the Exile (+20% AD bonus AD for 15 s, no damage),
    // then the recast Wind Slash (0.5 s later at the earliest; cooldown after the 15 s, wiki cdstart post-effect).
    // Runic Blade: each ability cast gives a charge (up to 3, 6 s); each attack spends one for bonus physical damage.
    Riven: {
      recastAs: ["Q","R"],
      onCast(u, a, tgt, t){ const K=u.kit, P=CALC.champs.Riven.P, rb=K.rb && K.rb.until>t ? K.rb : {n:0};
        K.rb={n:Math.min(dvOf(P,"charges",1)||3, rb.n+1), until:t+6};
        if (a.slot==="W"){ a.p0 ??= a.p; a.p={...a.p0, radius: K.rw && K.rw.until>t ? 360 : a.p0.radius}; }   // Ki Burst 300, 360 during Blade of the Exile (wiki Riven_W)
        simNotes.add(`${u.name}: Runic Blade — each ability cast gives a charge (up to 3, 6 s); each attack spends one for bonus physical damage (30–45% AD by level)`);
        if (a.slot==="Q"){ a.ccAll ??= a.cc||[]; a.p0 ??= a.p; const n=kitRecast(u, a, t, 3, 0.3125, 4, false);
          const ex=K.rw && K.rw.until>t;   // Blade of the Exile widens Broken Wings: 200 / 300 (wiki Riven_Q)
          a.cc = n===3 ? a.ccAll : a.ccAll.filter(e=>!AIRBORNE.has(e.type)); a.p={...a.p0, radius: n===3 ? (ex ? 300 : 250) : (ex ? 200 : 150)};
          u.nextAA=Math.min(u.nextAA, t);
          simNotes.add(`${u.name} Q: Broken Wings casts 3 times (0.3125 s apart at the earliest, 4 s to recast, the cooldown from the first cast); the third knocks back and hits a 250 radius (150 before); each cast resets the attack timer`); }
        if (a.slot==="R"){ const W=K.rw && K.rw.until>t ? K.rw : null, dur=dvOf(a.S,"duration",a.rank)||15;
          if (!W){ const v=(dvOf(a.S,"percentbonusad",a.rank)||0.2)*u.st.ad, R={until:t+dur, cdFull:Math.max(0,(u.cd.R||t)-t)};
            addBuff(u,"bladeoftheexile",t+dur,{bonusad:v, range:dvOf(a.S,"tooltipattackrange",a.rank)||75},t); K.rw=R; u.cd.R=t+0.5; a.parts=[];
            events.push({at:R.until, fn:()=>{ if (u.kit.rw===R){ u.kit.rw=null; u.cd.R=Math.max(u.cd.R, R.until+R.cdFull); } }});
            say(t, `  ${u.name}: Blade of the Exile, +${fmt(v)} bonus AD for ${fmt(dur)} s`);
            simNotes.add(`${u.name} R: Blade of the Exile gives 20% AD as bonus AD and +75 attack range (game data TooltipAttackRange; wiki) for 15 s, and widens Broken Wings (200 / 300) and Ki Burst (360); the recast Wind Slash deals the damage, raised 2.667% per 1% of the target's missing health (×3 at 75% missing); in fight() it's held until the target is at 25% health or the blade has 1 s left`); }
          else { a.parts=(a.later||[]).filter(p=>p.later==="recast").map(p=>({v:p.v, type:p.type, pct:false, ampMissing:p.ampMissing, ampCap:p.ampCap}));
            K.rw=null; u.cd.R=W.until+W.cdFull; } } },
      castable:(u, a, tgt, t)=>{ const W=u.kit.rw; if (a.slot!=="R" || !W || !(W.until>t) || !tgt) return true;
        return tgt.hp<=0.25*tgt.max || W.until-t<=1 ? true : "Wind Slash is held for the missing-health bonus"; },
      attack(u, tgt, t){ const rb=u.kit.rb; if (!rb || !(rb.until>t) || rb.n<=0) return null; rb.n--;
        return {bonus:[{v:evalCalc({S:CALC.champs.Riven.P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, type:"physical", what:"Runic Blade"}]}; },
    },
    // Ahri R (wiki Spirit Rush): 3 casts within 15 s of the first, 1 s static cooldown between them, the cooldown from
    // the first cast; each cast is a dash and a bolt at each of up to 3 enemies (one per enemy per cast)
    Ahri: {
      recastAs: ["R"],
      onCast(u, a, tgt, t){ if (a.slot!=="R") return; const S=a.S;
        kitRecast(u, a, t, dvOf(S,"rmaxcasts",a.rank)||3, dvOf(S,"rdashcooldown",a.rank)||1, dvOf(S,"rrecastwindow",a.rank)||15, true);
        simNotes.add(`${u.name} R: Spirit Rush casts 3 times within 15 s (1 s apart at the earliest; the cooldown runs from the first cast); each cast deals its bolt damage once to each enemy it reaches (Essence Theft's extra recasts aren't modelled)`); },
    },
    LeeSin: {
      onCast(u, a, tgt, t){ u.kit.flurry={n:2, until:t+3}; addBuff(u,"flurry",t+3,{bonusAS:(dvOf(CALC.champs.LeeSin.P,"passiveas",1)||40)/100},t);
        if (a.slot==="Q" && tgt){ const r=(a.later||[]).find(p=>p.later==="recast");
          // Q2 costs 25 energy (wiki Lee Sin; item 24): paid at the recast, skipped when he can't pay then
          if (r && enOf(u)){ const at=t+0.5; if (enNow(u,t)+u.en.regen*0.5 >= 25-1e-9){ events.push({at, fn:(tt)=>{ enSpend(u,25,tt); }}); kitLater(u, tgt, at, r, "Q recast (Resonating Strike)"); }
            else say(t, `  ${u.name}: not enough energy for the Q recast (needs 25)`); }
          else if (r) kitLater(u, tgt, t+0.5, r, "Q recast (Resonating Strike)"); }
        simNotes.add(`${u.name}: Flurry — each ability gives his next 2 attacks within 3 s +40% attack speed and energy (20/30/40 then 10/15/20); Q is recast 0.5 s later (Resonating Strike, raised by the target's missing health then)`); },
      attack(u, tgt, t){ const F=u.kit.flurry;
        // Flurry energy (game data LeeSinPassive EnergyReturn 10, +5 at levels 7 and 13; the first attack x2; item 24)
        if (F && F.until>t && enOf(u)){ const e=10+(u.st.level>=7?5:0)+(u.st.level>=13?5:0); enGain(u, F.n>=2 ? 2*e : e, t, "Flurry"); }
        if (F && F.until>t && --F.n<=0){ u.kit.flurry=null; const B=u.buffs.find(b=>b.id==="flurry"); if (B) B.until=Math.min(B.until, u.nextAA); } return null; },   // the buff ends when the next attack starts (this attack's timer keeps it)
    },
    Jayce: {
      onCast(u, a, tgt, t){ if (a.slot!=="R") return; const h=(a.later||[]).find(p=>p.later==="hyper");
        if (h){ u.kit.hyper={n:h.n||3, v:h.v, until:t+4}; u.nextAA=Math.min(u.nextAA,t); }
        simNotes.add(`${u.name} R: each cast is a Mercury Cannon burst — Shock Blast through Acceleration Gate (+40%), then Hyper Charge: the next 3 attacks deal ${fmt(h?h.v:0)} physical each (70–110% AD) with +360% attack speed; the hammer spells are Q/W/E. His attack range stays melee (the stance's 500 range isn't modelled)`); },
      attack(u, tgt, t, mult){ const H=u.kit.hyper; if (!H || !(H.until>t) || H.n<=0) return null; H.n--;
        aaTimer(u, t, 1/asOf(u, dvOf(CALC.champs.Jayce.forms.W,"percentincreasedas",1)||3.6));
        return {replace:{v:H.v*mult, type:"physical", what:"Hyper Charge attack"}}; },
    },
    // Twitch R (wiki Spray and Pray; game data BonusRange 300, BonusAD 30–60, Duration 6): a self-cast buff, not a 1200-range spell;
    // his hits are basic attacks at his attack range + 300 (edge range). The bolts' pierce through a line of enemies isn't modelled.
    Twitch: {
      onCast(u, a, tgt, t){ if (a.slot!=="R") return; const dur=dvOf(a.S,"duration",a.rank)||6, br=dvOf(a.S,"bonusrange",a.rank)||300, ad=dvOf(a.S,"bonusad",a.rank)||0;
        addBuff(u, "twitchR", t+dur, {range:br, bonusad:ad}, t); say(t, `  ${u.name}: Spray and Pray (+${fmt(br)} attack range, +${fmt(ad)} AD for ${fmt(dur)}s)`);
        simNotes.add(`${u.name} R: Spray and Pray — +${fmt(br)} attack range and +${fmt(ad)} bonus AD for ${fmt(dur)} s (game data BonusRange, BonusAD; wiki); his hits are attacks (edge range); the bolts' pierce isn't modelled`); } },
    Tristana: {
      onCast(u, a, tgt, t){
        if (a.slot==="Q"){ addBuff(u,"tristQ",t+(dvOf(a.S,"buffduration",a.rank)||7),{bonusAS:dvOf(a.S,"attackspeedmod",a.rank)||0},t); say(t, `  ${u.name}: Rapid Fire`); }
        if (a.slot==="E" && tgt){ const c=(a.later||[]).find(p=>p.later==="charge"); if (c){ const C={tgt, n:0, v:c.v, type:c.type, until:t+4, amp:dvOf(a.S,"activeperstackamp",a.rank)??0.25, done:false}; u.kit.charge=C;
          events.push({at:t+4, fn:(tt)=>kitTristBoom(u, C, tt)});
          simNotes.add(`${u.name} E: the charge detonates after 4 s, or at once on the 4th stack (her attacks and ability hits, +25% each); a full-stack detonation resets W`); } } },
      afterCast(u, a, tgt, t){ if (tgt && a.slot!=="E" && a.parts.length) kitTristStack(u, tgt, t); },
      onHit(u, x, t, o){ if (o.basic && o.primary) kitTristStack(u, x, t); },
      onTakedown(u, x, t){ if (!x.dummy && (u.cd.W||0)>t){ u.cd.W=t; say(t, `  ${u.name}: Rocket Jump reset (takedown)`); } },
    },
    Qiyana: {
      init(u){ u.kit.element = rankOf(u.c,"W")>0; },
      onCast(u, a, tgt, t){ if (a.slot==="W"){ u.kit.element=true; if ((u.cd.Q||0)>t) u.cd.Q=t;
          simNotes.add(`${u.name}: she holds an element from the start (Terrain on respawn, wiki); Q consumes it (Elemental Wrath, Terrain +60% below 50% health) and W grabs a new one and resets Q; while holding one, attacks and basic-ability hits add Terrashape magic damage`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="Q") u.kit.element=false; if (tgt && a.parts.length && a.slot!=="R") kitQiyanaHit(u, tgt, t); },
      onHit(u, x, t, o){ if (o.basic && o.primary) kitQiyanaHit(u, x, t); },
    },
    Jhin: {
      attack(u, tgt, t){ const K=u.kit; K.shots=(K.shots||0)+1; if (K.shots<4) return null; K.shots=0;
        const P=CALC.champs.Jhin.P, pct=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"fourthshotexecutepercent").v, miss=Math.max(0, tgt.max-(tgt.hpS ?? tgt.hp));
        u.nextAA=Math.max(u.nextAA, (u.aaT0 ?? t)+(dvOf(P,"reloadtime",1)||2.5));   // the reload from the 4th shot's start (backlog 25 step 7: this runs at its landing)
        simNotes.add(`${u.name}: Whisper — every 4th shot crits (${fmt(u.st.critdmg*100)}%) and adds ${fmt(pct*100)}% of the target's missing health; then a 2.5 s reload (4 rounds at the start)`);
        return {replace:{v:u.st.ad*critVs(u,tgt), type:"physical", what:"4th shot (crit)"}, bonus:[{v:pct*miss, type:"physical", what:"4th shot (missing health)"}]}; },
      onCast(u, a, tgt, t){
        if (a.slot==="W" && tgt){ a.ccAll ??= a.cc||[]; const marked=[...tgt.dmgBy].some(([x,tt])=>x.side===u.side && t-tt<=4); a.cc = marked ? a.ccAll : a.ccAll.filter(e=>e.type!=="root");
          simNotes.add(`${u.name} W: roots only a target damaged by Jhin or his allies in the last 4 s (Caught Out, wiki)`); }
        if (a.slot==="R" && tgt){ const m=dvOf(a.S,"fourthshotmultiplier",a.rank)||2;
          for (let i=1;i<4;i++) for (const p of a.parts) kitLater(u, tgt, t+i, {...p, v:p.v*(i===3?m:1)}, `R shot ${i+1}/4${i===3?" (crit)":""}`);
          u.nextAA=Math.max(u.nextAA, t+3.25); u.nextAct=Math.max(u.nextAct, t+3.25);
          simNotes.add(`${u.name} R: 4 shots 1 s apart at the one target (each +3% per 1% missing health, up to ×4; the 4th ×2); he does nothing else meanwhile`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; },
    },
    Yunara: {
      attack(u, tgt, t){ const K=u.kit, Q=u.abAll.Q, b=[];
        if (u.st.crit>0){ const amp=evalCalc({S:CALC.champs.Yunara.P, rank:1, st:u.st, flags:u.flags},"calc_damage_amp").v; b.push({v:u.st.crit*u.st.ad*u.st.critdmg*amp, type:"magic", what:"Vow of the First Lands (expected crit)"}); }
        if (Q){ const ctx={S:Q.S, rank:Q.rank, st:u.st, flags:u.flags}; b.push({v:evalCalc(ctx,"calc_passive_damage").v, type:"magic", what:"Cultivation of Spirit"});
          if (K.unleash>t || K.transcend>t) b.push({v:evalCalc(ctx,"calc_damage").v, type:"magic", what:"Unleashed"});
          else { K.stacks=Math.min(8,(K.stacks||0)+2); if (K.stacks>=8){ K.stacks=0; K.unleash=t+(dvOf(Q.S,"buff_duration",Q.rank)||5); addBuff(u,"yunaraQ",K.unleash,{bonusAS:evalCalc(ctx,"calc_attack_speed").v},t); u.nextAA=Math.min(u.nextAA, t+dt);
              say(t, `  ${u.name}: Cultivation of Spirit unleashed`); } }
          simNotes.add(`${u.name} Q: every attack deals the passive on-hit; after 4 attacks on champions (8 Unleash stacks) she unleashes at once for 5 s (attack speed and more on-hit; attack reset); the spread to nearby enemies isn't modelled`); }
        return b.length ? {bonus:b} : null; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W" && tgt){ const l=(a.later||[]).find(p=>p.later==="linger"); if (l) kitLater(u, tgt, t+1, l, "W linger"); }
        if (a.slot==="R"){ const Q=u.abAll.Q; K.transcend=t+(dvOf(a.S,"buff_duration",a.rank)||15);
          if (Q) addBuff(u,"yunaraQ",K.transcend,{bonusAS:evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"calc_attack_speed").v},t);
          const cut=()=>{ if ((u.cd.W||0)>u.kitT) u.cd.W=u.kitT+(u.cd.W-u.kitT)*(1-(dvOf(a.S,"rw_cdr",a.rank)||0.8)); u.cd.E=Math.min(u.cd.E||0, u.kitT); };
          cut(); events.push({at:K.transcend, fn:(tt)=>{ u.kitT=tt; cut(); }});
          simNotes.add(`${u.name} R: Transcendent State for 15 s — Q unleashed throughout, W becomes Arc of Ruin (R-rank damage) and its remaining cooldown drops 80% on entering and leaving, E resets`); } },
    },
    Camille: {
      recastAs: ["Q"],   // a library "Q recast" is the Q2 cast (1.5 s after the empowered attack); its damage rides the next attack
      onHit(u, x, t, o){ if (!o.basic || !o.primary) return; const K=u.kit; if (t<(K.shieldAt ?? 0)) return; const P=CALC.champs.Camille.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        K.shieldAt=t+evalCalc(ctx,"passivecooldown").v; const v=evalCalc(ctx,"shieldamount").v, ty=x.st.adaptiveType==="magic"?"magic":"physical";
        u.shieldDone+=addShield(u, v, dvOf(P,"shieldduration",1)||2, t, {type:ty}); say(t, `  ${u.name}: Adaptive Defenses ${fmt(v)} ${ty} shield (2 s)`); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, re = !!(K.camQ2 && K.camQ2.from<=t && K.camQ2.until>t);
          K.camQ={stage:re?2:1, until:t+4, v:evalCalc(ctx, re?"empoweredbonusdamage":"bonusdamage").v, conv:re?Math.min(1, evalCalc(ctx,"damageconversionpercentage").v):0};
          K.camQ2=null; u.nextAA=Math.min(u.nextAA,t); if (!re) u.cd.Q=t+4;   // the recast opens after the empowered attack
          simNotes.add(`${u.name} Q: the empowered attack, then the recast 1.5 s later (bonus ×2, ${fmt(Math.min(1, evalCalc(ctx,"damageconversionpercentage").v)*100)}% of that attack as true damage); the cooldown starts after the recast`); }
        if (a.slot==="E"){ addBuff(u,"camE",t+(dvOf(a.S,"asduration",a.rank)||5),{bonusAS:dvOf(a.S,"asbuff",a.rank)||0},t); simNotes.add(`${u.name} E: Wall Dive from a wall (assumed available): damage, 0.75 s stun and bonus attack speed for 5 s`); }
        if (a.slot==="R" && tgt){ const dur=dvOf(a.S,"rduration",a.rank)||4, pct=(dvOf(a.S,"rpercentcurrenthpdamage",a.rank)||0)/100, cx=tgt.xS ?? tgt.x;
          K.camR={tgt, until:t+dur, pct}; tgt.arena={cx, r:dvOf(a.S,"rcircleradius",a.rank)||425, until:t+dur};
          simNotes.add(`${u.name} R: the target can't leave the ${fmt(dvOf(a.S,"rcircleradius",a.rank)||425)} zone for ${fmt(dur)} s and her attacks on it add ${fmt(pct*100)}% of its current health as magic damage`); } },
      attack(u, tgt, t){ const K=u.kit, Q=K.camQ; let out=null;
        if (Q && Q.until>t){ K.camQ=null; const tot=u.st.ad+Q.v;   // this attack can't crit (wiki)
          if (Q.stage===1){ K.camQ2={from:t+1.5, until:t+3.75}; u.cd.Q=t+1.5; }
          out = Q.conv>0 ? {replace:{v:tot*(1-Q.conv), type:"physical", what:"Precision Protocol recast (physical share)"}, bonus:[{v:tot*Q.conv, type:"true", what:"Precision Protocol recast (true)"}]}
                         : {replace:{v:tot, type:"physical", what:"Precision Protocol"}}; }
        if (K.camR && K.camR.until>t && K.camR.tgt===tgt){ const b={v:K.camR.pct*(tgt.hpS ?? tgt.hp), type:"magic", what:"The Hextech Ultimatum"}; out = out ? {...out, bonus:[...(out.bonus||[]), b]} : {bonus:[b]}; }
        return out; },
    },
    Sylas: {
      timing:{Q:"travel"},   // backlog 25: the chains land after the cast; the kit times the explosion 0.6 s later (the data's delay)
      onCast(u, a, tgt, t){ const K=u.kit; K.unsh={n:Math.min(3,(K.unsh && K.unsh.until>t ? K.unsh.n : 0)+1), until:t+4};
        if (a.slot==="Q" && tgt){ const d=(a.later||[]).find(p=>p.later==="delay"); if (d) kitLater(u, tgt, t+(dvOf(a.S,"detonationdelay",a.rank)||0.6), d, "Q explosion"); }
        if (a.slot==="R" && tgt && !tgt.pet){ const x=kitCtx(u.c,"R",a.rank,u.st,u.flags,{},null); for (const p of kitHijack(x, tgt.c)) kitLater(u, tgt, t+0.25, p, `hijacked ${champName(tgt.c)} R`);
          simNotes.add(`${u.name} R: Hijack steals ${champName(tgt.c)}'s ultimate and casts it on it right away (its damage formulas with Sylas' Hijack rank and stats; its crowd control and extras aren't copied)`); }
        simNotes.add(`${u.name}: Petricite Burst — each ability stores a charge (up to 3, 4 s); the next attack spends one for bonus magic damage with +125% attack speed`); },
      attack(u, tgt, t){ const K=u.kit; if (!K.unsh || !(K.unsh.until>t) || K.unsh.n<=0) return null; K.unsh.n--;
        aaTimer(u, t, 1/asOf(u, dvOf(CALC.champs.Sylas.P,"passiveattackspeed",1)||1.25));
        return {bonus:[{v:evalCalc({S:CALC.champs.Sylas.P, rank:1, st:u.st, flags:u.flags},"passivedamage").v, type:"magic", what:"Petricite Burst"}]}; },
    },
    Locke: {
      onHit(u, x, t, o, e, hpB){ if (!o.basic || !o.primary || !x.alive) return; const P=CALC.champs.Locke.P, L=u.st.level, a=dvOf(P,"minonhitstartvalue",1)??5, b=dvOf(P,"minonhitendvalue",1)??40;
        const h=hpB ?? x.hp, v=(a+(b-a)*(L-1)/17+0.1*u.st.ap)*(1+Math.min(1, Math.max(0,1-h/x.max)/0.7));
        deal(u,x,v,"magic",t,"onhit","Silver Stake"); kitLockeNails(u, x, t); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q" && tgt){ for (const dd of [0.5, 1]) for (const p of a.parts) kitLater(u, tgt, t+dd, p, "Q recast nail"); tgt.lockeNails={by:u, t0:t, until:t+1+(dvOf(a.S,"nailduration",a.rank)||4)};
          simNotes.add(`${u.name} Q: three nails 0.5 s apart; the Soul Nails stacks are consumed by his next attack or E dash`); }
        if (a.slot==="W") addBuff(u,"lockeW",t+(dvOf(a.S,"baseduration",a.rank)||6),{bonusAS:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"attackspeed").v},t);
        if (a.slot==="E"){ const d=(a.later||[]).find(p=>p.later==="attack"); K.lockeE = d ? {until:t+4, v:d.v} : null; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="R" && tgt){ const thr=dvOf(a.S,"executionthreshold",a.rank)||0.1, cx=tgt.xS ?? tgt.x, R=dvOf(a.S,"radius",a.rank)||400;
          const marked=enemiesOf(u,t).filter(x=>Math.abs((x.xS ?? x.x)-cx)<=R+RAD(x) && !x.pet);
          for (let i=1;i<=20;i++) events.push({at:t+0.25+0.25*i, fn:(tt)=>{ if (!u.alive) return; for (const x of marked) if (x.alive && !x.dummy && x.hp < thr*x.max){ say(tt, `  ${u.name}: Purgatory executes ${x.name}`); deal(u,x,x.hp,"true",tt,"proc","Purgatory execute"); } }});
          simNotes.add(`${u.name} R: champions hit are marked for 5 s and executed below ${fmt(thr*100)}% maximum health (checked every 0.25 s)`); } },
      attack(u, tgt, t){ const E=u.kit.lockeE; if (!E || !(E.until>t)) return null; u.kit.lockeE=null; return {bonus:[{v:E.v, type:"magic", what:"Ashen Pursuit dash"}]}; },
      onTakedown(u, x, t){ if (!x.dummy && (u.cd.E||0)>t){ u.cd.E=t; say(t, `  ${u.name}: Ashen Pursuit reset (takedown)`); } },
    },
    Lulu: {
      attack(u, tgt, t){ simNotes.add(`${u.name}: Pix fires 3 bolts with each attack (all on the target)`);
        return {bonus:[{v:evalCalc({S:CALC.champs.Lulu.P, rank:1, st:u.st, flags:u.flags},"combineddamage").v, type:"magic", what:"Pix (3 bolts)"}]}; },
    },
    Nidalee: {
      onCast(u, a, tgt, t){ if (a.slot==="Q" && tgt && a.parts.length){ const d=gap(u,tgt), f=Math.min(1, Math.max(0,(d-525)/775)), m=1+((dvOf(a.S,"damagemulti",a.rank)||3.25)-1)*f; if (m>1) for (const p of a.parts) p.v*=m;
          simNotes.add(`${u.name} Q: Javelin Toss grows with the distance it flies (×1 at 525 or closer to ×3.25 at 1300, wiki), from the gap at the throw`); }
        if (a.slot==="R") simNotes.add(`${u.name} R: each cast is the cougar burst on the Hunted target (Takedown, Pounce, Swipe) every 6 s; the stance's melee range and swapping back aren't modelled`); },
    },
    Talon: {
      onCast(u, a, tgt, t){ if (a.slot==="Q") a.heal=0;   // Noxian Diplomacy heals only when it kills (wiki); kills aren't predicted here
        if (a.slot==="Q" && tgt && gap(u,tgt) <= 170+RAD(u)+RAD(tgt)){ const k=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"criticaldamage").v/Math.max(1e-9, evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"leapdamage").v); for (const p of a.parts) p.v*=k;
        simNotes.add(`${u.name} Q: cast within 170 units it crits (150%, wiki); from farther it is the leap without a crit`); } },
      afterCast(u, a, tgt, t){ if (!tgt) return;
        // the return (afterCast runs at the out blades' landing, cast + 0.35 s fixed travel): they linger 0.7 s at maximum range, then home
        // back at 3000/s (wiki Rake) over the maximum range less the target's distance
        if (a.slot==="W"){ const d=(a.later||[]).find(p=>p.later==="delay"), R=(a.p && (a.p.coneLength||a.p.range))||900; if (d) kitLater(u, tgt, t+(dvOf(a.S,"returndelay",a.rank)||0.7)+Math.max(0, R-gap(u,tgt))/3000, d, "W return"); }
        if (a.slot==="R"){ const d=(a.later||[]).find(p=>p.later==="recast"); if (d) kitLater(u, tgt, t+1, d, "R blades converge"); }
        if (a.parts.length) kitTalonWound(u, tgt, t); },
      attack(u, tgt, t){ const W=tgt.talonW; if (!W || W.by!==u || W.bleeding || W.n<3 || !(W.until>t)) return null;
        tgt.talonW={by:u, n:0, until:t+(dvOf(CALC.champs.Talon.P,"bleedduration",1)||2), bleeding:true};
        const v=evalCalc({S:CALC.champs.Talon.P, rank:1, st:u.st, flags:u.flags},"bleeddamage").v; for (let i=1;i<=16;i++) kitLater(u, tgt, t+0.125*i, {v:v/16, type:"physical"}, "Blade's End bleed");
        simNotes.add(`${u.name}: Blade's End — ability hits add Wounds; at 3, his next attack bleeds the target for ${fmt(v)} physical over 2 s`); return null; },
    },
    Bard: {
      attack(u, tgt, t){ const K=u.kit, n=kitStacks(u.c), max=n>=100?9:n>=95?8:n>=90?7:n>=80?6:n>=65?5:n>=50?4:n>=30?3:n>=10?2:1, cd=n>=70?4:n>=55?5:n>=40?6:n>=20?7:8;
        if (K.meeps==null){ K.meeps=max; K.meepAt=t; }
        while (K.meeps<max && t>=K.meepAt+cd){ K.meeps++; K.meepAt+=cd; } if (K.meeps>=max) K.meepAt=t;
        if (K.meeps<=0) return null; K.meeps--; const P=CALC.champs.Bard.P, v=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"meepdamagenochime").v + Math.floor(n/5)*(dvOf(P,"damagepercheckpoint",1)||6);
        simNotes.add(`${u.name}: Meeps — ${max} at the start (${fmt(n)} Chimes), one more every ${cd} s; each attack spends one for bonus magic damage (the Chime slow and splash aren't modelled)`);
        return {bonus:[{v, type:"magic", what:"Meep"}]}; },
      afterCast(u, a, tgt, t){ if (a.slot!=="R") return; const d=dvOf(a.S,"rstasisduration",a.rank)||2.5;
        for (const x of U) if (x.alive && x.side!==u.side && x.ccs.some(c=>c.src===u && c.at===t && c.type==="stun")) x.stasisUntil=Math.max(x.stasisUntil, t+d);
        simNotes.add(`${u.name} R: enemies hit are put in stasis for ${fmt(d)} s (untargetable and invulnerable, wiki), not only stunned; allies caught in it aren't modelled`); },
    },
    Ryze: {
      onCast(u, a, tgt, t){
        if (a.slot==="W" && tgt){ a.ccAll ??= a.cc||[]; const fl=!!(tgt.ryzeFlux && tgt.ryzeFlux.by===u && tgt.ryzeFlux.until>t); a.cc = fl ? a.ccAll.filter(e=>e.type!=="slow") : a.ccAll.filter(e=>e.type!=="root"); if (fl) tgt.ryzeFlux=null; }
        if (a.slot==="Q" && tgt){ const fl=!!(tgt.ryzeFlux && tgt.ryzeFlux.by===u && tgt.ryzeFlux.until>t);
          if (!fl){ const amp=(dvOf(CALC.champs.Ryze.R,"overloaddamagebonus",rankOf(u.c,"R"))||15)/100; for (const p of a.parts) p.v/=1+amp; } else tgt.ryzeFlux=null; }
        if (a.slot==="E" && tgt) tgt.ryzeFlux={by:u, until:t+(dvOf(a.S,"debuffduration",a.rank)||4)};
        if ((a.slot==="W" || a.slot==="E") && (u.cd.Q||0)>t) u.cd.Q=t;
        simNotes.add(`${u.name}: W and E reset Q (Overload); E marks the target with Flux for 4 s, which the next Q (+40/65/90% by R rank) or W (root 1.5 s instead of the slow) consumes`); },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; },
    },
    Alistar: {
      onCast(u, a, tgt, t){
        if (a.slot==="E"){ const L=a.later||[], tk=L.find(p=>p.later==="ticks"), at=L.find(p=>p.later==="attack"), T={n:0, v:at?at.v:0, ready:false, until2:-1}; u.kit.trample=T;
          if (tk) for (let i=1;i<=10;i++) events.push({at:t+0.5*i, fn:(tt)=>{ if (!u.alive || u.kit.trample!==T) return; const hit=enemiesOf(u,tt).filter(x=>gap(u,x)<=(dvOf(a.S,"radius",a.rank)||350)+RAD(x));
            for (const x of hit) deal(u,x,tk.v/10,"magic",tt,"ability","E trample"); if (hit.some(x=>!x.pet)){ T.n=Math.min(5,T.n+1); if (T.n>=5 && !T.ready){ T.ready=true; T.until2=tt+6; } } }});
          simNotes.add(`${u.name} E: tramples every 0.5 s for 5 s (a tenth of the total each); at 5 champion ticks his next attack deals bonus magic damage and stuns 1 s, ending Trample`); }
        if (a.slot==="R"){ u.ccs=u.ccs.filter(c=>c.until<=t); u.slows=[]; u.kit.rDR={until:t+(dvOf(a.S,"rduration",a.rank)||7), dr:(dvOf(a.S,"rdamagereduction",a.rank)||55)/100};
          simNotes.add(`${u.name} R: cleanses his crowd control and takes ${fmt(u.kit.rDR.dr*100)}% less damage for 7 s`); } },
      attack(u, tgt, t){ const T=u.kit.trample; if (!T || !T.ready || !(T.until2>t) || tgt.pet) return null; u.kit.trample=null;
        applyCC(u, {slot:"E", S:u.abAll.E ? u.abAll.E.S : {}, p:{}, cc:[{type:"stun", dur:1}], hard:true}, tgt, t, 0);
        return {bonus:[{v:T.v, type:"magic", what:"Trample empowered attack"}]}; },
    },
    Sona: {
      onCast(u, a, tgt, t){ const K=u.kit; K.chord=Math.min(3,(K.chord||0)+1); K.last=a.slot; if (K.chord>=3) u.nextAA=Math.min(u.nextAA, t);
        if (a.slot==="Q"){ const m=(a.later||[]).find(p=>p.later==="attack"); if (m) K.melody={until:t+(dvOf(a.S,"onhitduration",a.rank)||5), v:m.v}; }
        simNotes.add(`${u.name}: Power Chord — 3 basic-ability casts empower her next attack (Staccato ×1.5 if Q was last; attack reset); Q's Melody adds bonus magic to her next attack within 5 s`); },
      attack(u, tgt, t){ const K=u.kit, b=[];
        if (K.melody && K.melody.until>t){ b.push({v:K.melody.v, type:"magic", what:"Melody (Hymn of Valor)"}); K.melody=null; }
        if ((K.chord||0)>=3){ K.chord=0; const Q=u.abAll.Q, sc=K.last==="Q" && Q;
          b.push({v: sc ? evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"totalstaccatodamage").v : evalCalc({S:CALC.champs.Sona.P, rank:1, st:u.st, flags:u.flags},"powerchorddamage").v, type:"magic", what: sc ? "Power Chord (Staccato)" : "Power Chord"}); }
        return b.length ? {bonus:b} : null; },
    },
    /* ---- champion audit batch 3 (2026-09-24) ---- */
    Nautilus: {
      onCast(u, a, tgt, t){ if (a.slot!=="W") return; const p=(a.later||[]).find(q=>q.later==="attack");
        u.kit.wrath={until:t+(dvOf(a.S,"shieldduration",a.rank)||6), v:p?p.v:0}; u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} W: Titan's Wrath resets his attack; for 6 s his attacks add Pain of Wrath (half the magic damage at once, half 1.25 s later; the splash to nearby enemies isn't modelled)`); },
      attack(u, tgt, t){ const b=[], W=u.kit.wrath;
        if (W && W.until>t && W.v>0){ b.push({v:W.v/2, type:"magic", what:"Pain of Wrath"}); kitLater(u, tgt, t+1.25, {v:W.v/2, type:"magic"}, "Pain of Wrath (second half)"); }
        const R=(tgt.nautP ||= {}); if (!(R[u.name]>t)){ R[u.name]=t+6; const ctx={S:CALC.champs.Nautilus.P, rank:1, st:u.st, flags:u.flags};
          b.push({v:evalCalc(ctx,"bonusdamage").v, type:"physical", what:"Staggering Blow"});
          applyCC(u, {slot:"P", S:CALC.champs.Nautilus.P, p:{}, cc:[{type:"root", dur:evalCalc(ctx,"rootduration").v||0.75}], hard:true}, tgt, t, 0);
          simNotes.add(`${u.name}: Staggering Blow — his attack deals bonus physical damage and roots, once per target every 6 s`); }
        return b.length ? {bonus:b} : null; },
    },
    Rell: {
      onHit(u, x, t, o){ if (!o.basic || !o.primary || !x.alive) return; const ctx={S:CALC.champs.Rell.P, rank:1, st:u.st, flags:u.flags};
        deal(u,x,evalCalc(ctx,"onhitdamage").v,"magic",t,"onhit","Break the Mold"); kitRellTilt(u, x, t); kitRellMold(u, x, t); },
      onCast(u, a, tgt, t){ if (a.slot!=="E") return; const p=(a.later||[]).find(q=>q.later==="attack"); u.kit.tilt=p ? {until:t+5, pct:p.v} : null;
        simNotes.add(`${u.name} E: Full Tilt — her next attack or Q within 5 s explodes for ${fmt(p?p.v*100:0)}% of the target's maximum health (the ally's speed isn't modelled)`); },
      afterCast(u, a, tgt, t){ if (!tgt || !a.parts.length) return; if (a.slot==="Q") kitRellTilt(u, tgt, t); kitRellMold(u, tgt, t); },
    },
    Thresh: {
      // Flay passive: charge = time since his last attack / 10 s (linear assumed; full at the fight's start)
      attack(u, tgt, t){ const E=u.abAll.E, K=u.kit; if (!E) return null; const ch=Math.min(1, (t-(K.lastAA ?? -Infinity))/(dvOf(E.S,"fullchargeduration",E.rank)||10)); K.lastAA=t;
        const v=kitStacks(u.c)*(dvOf(E.S,"dmgpersoul",E.rank)||1.7) + ch*(dvOf(E.S,"passiveadratiott",E.rank)||0.9)*u.st.ad;
        simNotes.add(`${u.name} E: Flay passive — each attack deals bonus magic: 1.7 per Soul + up to ${fmt((dvOf(E.S,"passiveadratiott",E.rank)||0.9)*100)}% AD, charging linearly over 10 s without attacking (full on the first attack)`);
        return v>0 ? {bonus:[{v, type:"magic", what:`Flay passive (${fmt(ch*100)}% charged)`}]} : null; },
      afterCast(u, a, tgt, t){ if (a.slot==="Q" && tgt && (u.cd.Q||0)>t){ u.cd.Q=Math.max(t, u.cd.Q-(dvOf(a.S,"hitbonuscooldown",a.rank)||2)); } },
    },
    Graves: {
      timing:{Q:"travel"},   // backlog 25: the bullet lands after the cast + flight; the kit times the detonation
      // 12-Gauge: 4 pellets on one target (6 on a crit, each +50% of the bonus crit damage), at the expected crit rate
      attack(u, tgt, t){ const P=CALC.champs.Graves.P, ctx={S:P, rank:1, st:u.st, flags:u.flags}, one=evalCalc(ctx,"singlebulletdamage").v, k=one>0 ? evalCalc(ctx,"multibulletdamage").v/one : 0.333;
        const c=u.st.crit, cd=critVs(u,tgt), cm=dvOf(P,"critdamageratio",1)??0.5, v=one*((1-c)*(1+3*k) + c*(1+5*k)*(1+cm*(cd-1)));
        const K=u.kit, E=u.abAll.E;
        if (E && (u.cd.E||0)>t) u.cd.E=Math.max(t, u.cd.E-4*(dvOf(E.S,"cooldownperhit",E.rank)||0.5));   // Quickdraw: −0.5 s per pellet hit
        if (K.grit && K.grit.until>t && !tgt.pet){ K.grit.until=t+4; kitGravesGrit(u, t); }
        simNotes.add(`${u.name}: 12-Gauge — each attack is 4 pellets on the one target (${fmt(one)} + 3 × ${fmt(one*k)}); crits fire 6 pellets for +50% of the bonus crit damage; each pellet cuts Quickdraw's cooldown 0.5 s. The two-shell clip and reload are not modelled (attacks follow his attack speed; the wiki: exact reload formula unknown)`);
        return {replace:{v, type:"physical", what:c?"attack, 4 pellets (expected crit)":"attack, 4 pellets"}}; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q" && tgt){ const d=(a.later||[]).find(p=>p.later==="delay"); if (d) kitLater(u, tgt, t+2, d, "Q detonation"); }
        if (a.slot==="E"){ u.nextAA=Math.min(u.nextAA, t); const n=tgt && !tgt.pet ? 2 : 1;
          K.grit={n:Math.min(dvOf(a.S,"maxstacks",a.rank)||8, (K.grit && K.grit.until>t ? K.grit.n : 0)+n), until:t+(dvOf(a.S,"buffduration",a.rank)||4), per:dvOf(a.S,"armorperstack",a.rank)||0, mr:dvOf(a.S,"mrgrantpercent",a.rank)??0.5};
          kitGravesGrit(u, t);
          simNotes.add(`${u.name} E: Quickdraw resets his attack and gives True Grit (2 stacks dashing at a champion, up to 8, 4 s, refreshed by his attacks): +${fmt(K.grit.per)} armor and +${fmt(K.grit.per*K.grit.mr)} MR per stack`); } },
    },
    Jinx: {
      castable:(u, a)=>a.slot==="Q" ? "Switcheroo! is a stance swap (fight() keeps the minigun)" : true,
      // Pow-Pow, Rev'd up (wiki; game data MinigunAttackSpeedMax 30–130%): each attack gives a stack (3 max, 2.5 s); the first stack is
      // worth half the maximum, the next two a quarter each (stacks all end 2.5 s after the last attack here; the game drops them one by one)
      // (on-attack, backlog 25 step 7: the stack comes as the attack starts, so it speeds up the timer of the attack that gave it)
      onAttack(u, tgt, t){ const Q=u.abAll.Q; if (!Q) return null; const K=u.kit, R=K.revd && K.revd.until>t ? K.revd : {n:0}, mx=(dvOf(Q.S,"minigunattackspeedmax",Q.rank)||30)/100;
        K.revd={n:Math.min(dvOf(Q.S,"minigunattackspeedstacks",Q.rank)||3, R.n+1), until:t+(dvOf(Q.S,"minigunattackspeedduration",Q.rank)||2.5)};
        addBuff(u, "revd", K.revd.until, {bonusAS:mx*(0.5+0.25*(K.revd.n-1))}, t);
        simNotes.add(`${u.name} Q: Pow-Pow — each attack gives Rev'd up (up to 3 stacks, 2.5 s): +${fmt(mx*50)}% attack speed for the first, +${fmt(mx*25)}% for each of the next two (the Fishbones stance isn't used in fights)`);
        return null; },
      onCast(u, a, tgt, t){ if (a.slot!=="R" || !tgt) return; const d=gap(u,tgt), f=0.1+0.9*Math.min(1, d/1500);
        for (const p of a.parts) if (p.pctOf!=="missing") p.v*=f;
        simNotes.add(`${u.name} R: the rocket deals 10% to 100% of its damage by the distance flown (0 to 1500 units), here ${fmt(d)} units (×${fmt(f)}); the missing-health part isn't scaled`); },
      onTakedown(u, x, t){ if (x.dummy || x.pet) return; const K=u.kit, E=K.excited && K.excited.until>t ? K.excited : {n:0}, t0=t;
        K.excited={n:Math.min(5, E.n+1), until:t+6}; const n=K.excited.n, asv=u.st.as/Math.max(1e-9,u.st.asratio)*0.25*n;
        for (let i=0;i<6;i++) events.push({at:t0+i, fn:(tt)=>{ if (K.excited.until>tt) addBuff(u, "jinxP", K.excited.until, {mspct:1.75*(1-(tt-t0)/6), bonusAS:asv}, tt); }});
        say(t, `  ${u.name}: Get Excited! (${n} stack${n>1?"s":""})`);
        simNotes.add(`${u.name}: Get Excited! — a champion takedown gives +175% move speed decaying over 6 s (stepped each second here) and +25% total attack speed per stack (up to 5; as bonus attack speed; her attack-speed cap lift isn't modelled)`); },
    },
    Pantheon: {
      timing:{R:"own"},   // backlog 25: Grand Starfall times its own spear, shockwave and reappearance from the cast
      init(u){ u.kit.mw=dvOf(CALC.champs.Pantheon.P,"actionstoempower",1)||5; },   // Mortal Will: full at the start (wiki)
      onCast(u, a, tgt, t){ const K=u.kit, P=CALC.champs.Pantheon.P, full=dvOf(P,"actionstoempower",1)||5, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        const emp = "QWE".includes(a.slot) && K.mw>=full; K.mw = emp ? 0 : Math.min(full, K.mw+1); K.qEmp=false;
        if (a.slot==="Q"){ K.qEmp=emp; K.qTap = !tgt || gap(u,tgt) <= 560+RAD(tgt); }
        if (a.slot==="W" && emp){ K.wEmp={until:t+(dvOf(a.S,"buffduration",a.rank)||4), v:evalCalc(ctx,"empowereddamagemultcalcmodified").v}; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="E"){ const L=a.later||[], ch=L.find(p=>p.later==="channel"), sl=L.find(p=>p.later==="slam");
          if (tgt){ if (ch) for (let i=1;i<=12;i++) kitLater(u, tgt, t+0.125*i, {...ch, v:ch.v/12}, "E strike");
            if (sl) kitLater(u, tgt, t+1.75, sl, "E shield slam"); }
          u.nextAct=Math.max(u.nextAct, t+1.75); u.nextAA=Math.max(u.nextAA, t+1.75); castStasis(u, t+1.5, t);   // blocks from the cast (no cast time), whole step (item 24)
          if (emp){ const v=evalCalc(ctx,"resistscalc").v; events.push({at:t+1.75, fn:(tt)=>{ addBuff(u,"pantheonE",tt+(dvOf(a.S,"resistsduration",a.rank)||4),{bonusarmor:v, bonusmr:v},tt); addBuff(u,"pantheonEms",tt+1.5,{mspct:dvOf(a.S,"speedamount",a.rank)||0.6},tt); }}); }
          simNotes.add(`${u.name} E: Aegis Assault — 12 strikes over the 1.5 s channel (100% AD), then the slam; he blocks all damage meanwhile (modelled as untargetable: in a line every enemy is in front) and does nothing else`); }
        if (a.slot==="R" && tgt){ const L=a.later||[], sp=L.find(p=>p.later==="spear"), wv=L.find(p=>p.later==="wave"), cx=tgt.xS ?? tgt.x;
          if (sp) events.push({at:t+3, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= 450+RAD(x)){ kitLater(u, x, tt, sp, "R spear");
              applyCC(u, {slot:"R", S:a.S, p:{}, cc:[{type:"slow", dur:dvOf(a.S,"spearslowduration",a.rank)||2, pct:dvOf(a.S,"spearslow",a.rank)||0.5}]}, x, tt, 0); } }});
          if (wv) events.push({at:t+3.55, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= 450+RAD(x)) kitLater(u, x, tt, wv, "R shockwave"); }});
          u.nextAct=Math.max(u.nextAct, t+4.25); u.nextAA=Math.max(u.nextAA, t+4.25);
          events.push({at:t+2, fn:(tt)=>{ if (u.alive) u.stasisUntil=Math.max(u.stasisUntil, t+4.25); }});
          events.push({at:t+4.25, fn:(tt)=>{ if (!u.alive) return; u.move=null; displace(u, cx - face(u)*(RAD(u)+RAD(tgt)), 1e-3, tt, true); K.mw=full; }});
          simNotes.add(`${u.name} R: Grand Starfall — 2 s channel, then he vanishes; the spear lands 3 s after the cast (slow 50% 2 s), the shockwave at 3.55 s, and he reappears at the spot at 4.25 s with full Mortal Will (all within 450 of where the target stood)`); }
        simNotes.add(`${u.name}: Mortal Will — attacks and casts give stacks, full (5) at the start; the next basic ability at 5 is empowered (Q +damage, W: the next attack strikes 3 times, E: resists and speed)`); },
      afterCast(u, a, tgt, t){ const K=u.kit; if (a.slot!=="Q" || !tgt) return;
        if (K.qEmp && tgt.alive){ const Q=a; deal(u, tgt, evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"empowereddamagecalc").v, "physical", t, "ability", "Mortal Will (Q)"); K.qEmp=false; }
        const t0=pressOf(a,t); if (K.qTap && (u.cd.Q||0)>t){ u.cd.Q=Math.max(t, t0+(u.cd.Q-t0)*(1-(dvOf(a.S,"tapcooldownrefund",a.rank)||0.6))); } },
      attack(u, tgt, t, mult){ const K=u.kit, full=dvOf(CALC.champs.Pantheon.P,"actionstoempower",1)||5; let out=null;
        if (K.wEmp && K.wEmp.until>t){ out={replace:{v:K.wEmp.v*mult, type:"physical", what:"Mortal Will: 3 strikes"}}; K.wEmp=null; }
        K.mw=Math.min(full, (K.mw||0)+1); return out; },
    },
    Olaf: {
      // Berserker Rage: 1% of 50–100% bonus attack speed per 0.7% missing health (full at 70% missing), updated on each attack
      attack(u, tgt, t){ const P=CALC.champs.Olaf.P, miss=Math.max(0, 1-(u.hpS ?? u.hp)/u.max), f=Math.min(1, miss/(1-(dvOf(P,"maxstatsthreshold",1)||0.3)));
        addBuff(u, "olafP", Infinity, {bonusAS:f*evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"maxattackspeed").v}, t);
        const E=u.abAll.E; if (E && (u.cd.E||0)>t && !tgt.pet) u.cd.E=Math.max(t, u.cd.E-(dvOf(E.S,"championrefresh",E.rank)||1));   // Reckless Swing −1 s per attack
        const R=u.kit.rag; if (R && R.until>t && !tgt.pet){ R.until=Math.max(R.until, t+(dvOf(u.abAll.R.S,"durationextension",u.abAll.R.rank)||2.5)); addBuff(u,"olafR",R.until,{bonusad:R.ad},t); u.ccImmuneUntil=R.until; }
        simNotes.add(`${u.name}: Berserker Rage bonus attack speed follows his missing health (life steal not modelled); each attack cuts Reckless Swing's cooldown 1 s`);
        return null; },
      onCast(u, a, tgt, t){ const K=u.kit, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        if (a.slot==="W"){ const miss=Math.min(0.7*u.max, u.max-u.hp); a.shield=(dvOf(a.S,"baseshield",a.rank)||0)+(dvOf(a.S,"shieldpercmissinghp",a.rank)||0.175)*miss;
          addBuff(u,"olafW",t+(dvOf(a.S,"duration",a.rank)||5),{bonusAS:(dvOf(a.S,"attackspeed",a.rank)??[0,0.4,0.5,0.6,0.7,0.8][a.rank])},t); u.nextAA=Math.min(u.nextAA, t);
          simNotes.add(`${u.name} W: Tough It Out — +40–80% attack speed for 5 s, attack reset, shield 10–130 + 17.5% of his missing health (at most 70% missing) from his health at the cast`); }
        if (a.slot==="R"){ const v=evalCalc(ctx,"ad").v, dur=dvOf(a.S,"duration",a.rank)||3; K.rag={until:t+dur, ad:v}; addBuff(u,"olafR",t+dur,{bonusad:v},t);
          u.ccs=u.ccs.filter(c=>c.until<=t); u.slows=[]; u.ccImmuneUntil=t+dur;
          simNotes.add(`${u.name} R: Ragnarok — cleanses, crowd-control immune and +${fmt(v)} AD (10/20/30 + 25% AD) for 3 s, kept to at least 2.5 s by each attack on a champion`); } },
      // Undertow: champions hit lose 20% armor for 4 s, after the axe's own damage
      afterCast(u, a, tgt, t){ if (a.slot==="Q" && tgt && !tgt.pet && a.parts.length) tgt.olafQ={until:t+(dvOf(a.S,"debuffduration",a.rank)||4), pct:dvOf(a.S,"shredamount",a.rank)||0.2}; },
    },
    Karma: {
      onCast(u, a, tgt, t){ const K=u.kit, R=u.abAll.R, M=CALC.champs.Karma.R, mctx=R ? {S:M, rank:R.rank, st:u.st, flags:u.flags} : null;
        if (a.slot==="R"){ K.mantra=t+8; simNotes.add(`${u.name} R: Mantra empowers her next basic ability within 8 s (Soulflare: bonus damage and a field that ruptures 1.5 s later; Renewal: longer root and a heal; Defiance: bonus shield)`); return; }
        const man = !!(K.mantra>t) && mctx; if (man) K.mantra=0;
        if (a.slot==="Q" && man && tgt){ const d=evalCalc(mctx,"rqimpactdamage").v, f=evalCalc(mctx,"rqfielddamage").v; a.parts.push({v:d, type:"magic"});
          kitLater(u, tgt, t+1.5, {v:f, type:"magic"}, "Soulflare field rupture"); }
        if (a.slot==="W" && tgt){ const tw=(a.later||[]).find(p=>p.later==="tether"), rd=(dvOf(a.S,"rootduration",a.rank)||1.6)+(man ? dvOf(M,"rwbonusroot",R.rank)||0 : 0);
          a.ccAll ??= a.cc||[]; a.cc=[];
          events.push({at:t+2, fn:(tt)=>{ if (!u.alive || !tgt.alive) return; if (tw) kitLater(u, tgt, tt, tw, "W tether completes"); applyCC(u, {slot:"W", S:a.S, p:{}, cc:[{type:"root", dur:rd}], hard:true}, tgt, tt, 0); }});
          if (man){ const h=evalCalc(mctx,"rwhealamount").v; heal(u,u,h*(u.max-u.hp),t,"Renewal"); events.push({at:t+2, fn:(tt)=>{ if (u.alive) heal(u,u,h*(u.max-u.hp),tt,"Renewal"); }}); }
          simNotes.add(`${u.name} W: the second hit and the root (${fmt(rd)} s) land when the 2 s tether completes (assumed held)`); }
        if (a.slot==="E" && man && a.shield) a.shield+=evalCalc(mctx,"rebonusshield").v; },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll;
        if (tgt && !tgt.pet && a.parts.length && a.slot!=="R" && (u.cd.R||0)>t){ u.cd.R=Math.max(t, u.cd.R-(evalCalc({S:CALC.champs.Karma.P, rank:1, st:u.st, flags:u.flags},"spellmantrarefund").v||4)); } },
    },
    Galio: {
      init(u){ const W=u.abAll.W; u.kit.pAt=0;
        if (W){ const v=evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"totalpassiveshield").v; if (v>0){ addShield(u, v, 1e6, 0, {type:"magic"}); simNotes.add(`${u.name} W passive: Anti-Magic Bulwark, a ${fmt(v)} magic shield at the start (its regeneration after 8–12 s without damage isn't modelled)`); } } },
      attack(u, tgt, t, mult){ const K=u.kit; if (t < (K.pAt ?? 0)) return null; const P=CALC.champs.Galio.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        const v=evalCalc(ctx,"totaldamage").v + u.st.ad*(mult-1);   // the AD part at the attack's expected crit
        K.pAt=t+(dvOf(P,"passivecooldown",1)||5)*100/(100+u.st.haste+u.st.basichaste);
        for (const x of enemiesOf(u,t)) if (x!==tgt && Math.abs((x.xS ?? x.x)-(tgt.xS ?? tgt.x)) <= 250+RAD(x)) deal(u,x,v,"magic",t,"proc","Colossal Smash (area)");
        simNotes.add(`${u.name}: Colossal Smash — every 5 s (× cooldown reduction) an attack deals ${fmt(v)} magic damage instead, to the target and enemies within 250; each cast that hits a champion cuts the wait 3 s`);
        return {replace:{v, type:"magic", what:"Colossal Smash"}}; },
      onCast(u, a, tgt, t){
        if (a.slot==="Q" && tgt){ const tn=(a.later||[]).find(p=>p.later==="tornado"); if (tn) for (let i=1;i<=4;i++) kitLater(u, tgt, t+0.5+0.5*i, {...tn, v:tn.v/4}, "Q tornado"); }
        if (a.slot==="W"){ const ch=(a.later||[]).find(p=>p.later==="charge"), cc=a.cc||[]; a.ccAll ??= cc; a.shield=0;   // the data's shield is the passive Bulwark, not a cast effect
          if (ch){ a.cc=[]; u.nextAct=Math.max(u.nextAct, t+1.65); u.nextAA=Math.max(u.nextAA, t+1.65);
            events.push({at:t+1.25, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (!x.pet && gap(u,x) <= 350){ kitLater(u, x, tt, ch, "W recast (charged)"); applyCC(u, {slot:"W", S:a.S, p:{}, cc:a.ccAll, hard:true}, x, tt, 0); }
              kitGalioHit(u, tt); }});
            simNotes.add(`${u.name} W: Shield of Durand charges 1.25 s (fully), then the recast hits champions within 350 for ×3 damage and a 1.5 s taunt; the damage reduction while charging isn't modelled`); } } },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; if (tgt && !tgt.pet && a.parts.length) kitGalioHit(u, t); },
    },
    Ekko: {
      timing:{W:"cast"},   // backlog 25: the kit times the chronosphere (3 s after the cast)
      attack(u, tgt, t){ const K=u.kit, b=[];
        if (K.phase && K.phase.until>t){ b.push({v:K.phase.v, type:"magic", what:"Phase Dive"}); K.phase=null; }
        const W=u.abAll.W, h=tgt.hpS ?? tgt.hp;
        if (W && h < (dvOf(W.S,"belowhealththreshold",W.rank)||0.3)*tgt.max){ const pct=evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"missinghealthpercent").v; b.push({v:pct*(tgt.max-h), type:"magic", what:"Parallel Convergence passive"}); }
        return b.length ? {bonus:b} : null; },
      onHit(u, x, t, o){ if (o.basic && o.primary) kitEkkoRes(u, x, t); },
      onCast(u, a, tgt, t){
        if (a.slot==="Q" && tgt){ const r=(a.later||[]).find(p=>p.later==="return"); if (r) kitLater(u, tgt, t+2.5, r, "Q return"); }
        if (a.slot==="E"){ const p=(a.later||[]).find(q=>q.later==="attack"); u.kit.phase = p ? {until:t+(dvOf(a.S,"buffduration",a.rank)||3), v:p.v} : null; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="W"){ const cx=tgt ? (tgt.xS ?? tgt.x) : u.x, sh=a.shield, cc=a.cc||[]; a.shield=0; a.ccAll ??= cc; a.cc=[];
          events.push({at:t+(dvOf(a.S,"delaybeforedetonation",a.rank)||3), fn:(tt)=>{ if (!u.alive) return;
            for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= (dvOf(a.S,"aoeradius",a.rank)||375)+RAD(x)) applyCC(u, {slot:"W", S:a.S, p:{}, cc:a.ccAll.filter(e=>e.type==="stun"), hard:true}, x, tt, 0);
            if (sh>0) shield(u, u, sh, 2, tt, "W"); }});
          simNotes.add(`${u.name} W: the chronosphere lands 3 s after the cast where the target stood; Ekko is assumed to enter it: stun 2.25 s on enemies still within 375, and his shield`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; if (tgt && a.parts.length && a.slot!=="W") kitEkkoRes(u, tgt, t); },
    },
    Zeri: {
      timing:{W:"travel"},   // backlog 25: the laser lands after cast + flight (the data's 0.85 s delay is the path through a wall)
      castable:(u, a)=>a.slot==="Q" ? "Burst Fire is her attack in fight() (every attack is a Burst Fire)" : true,
      init(u){ u.kit.charge=100; },   // Living Battery: full charge at the start (wiki)
      // every attack is Burst Fire (Q: 1/attack speed, crits, on-hit); at full charge she uses the charged basic attack instead
      attack(u, tgt, t, mult){ const K=u.kit, Q=u.abAll.Q; if (!Q) return null; const QS=CALC.champs.Zeri.Q, ctx={S:QS, rank:Q.rank, st:u.st, flags:u.flags};
        if ((K.charge??100)>=100){ K.charge=0; const v=evalCalc(ctx,"passivemaxdamage").v + evalCalc(ctx,"passivemaxchargepercenthealth").v*tgt.max;
          simNotes.add(`${u.name}: Living Battery — she starts with full charge and opens with the charged attack (magic, % maximum health); each Burst Fire gives 10 charge (movement charge isn't modelled)`);
          return {replace:{v, type:"magic", what:"charged attack (Living Battery)"}}; }
        K.charge=Math.min(100, (K.charge||0)+(dvOf(QS,"chargeperattack",Q.rank)||10));
        const b=[], E=K.lr && K.lr.until>t ? K.lr : null; if (E) b.push({v:E.v*mult, type:"magic", what:"Lightning Rounds"});
        const Ea=u.abAll.E; if (Ea && (u.cd.E||0)>t) u.cd.E=Math.max(t, u.cd.E-((dvOf(Ea.S,"cdreductionperhit",Ea.rank)||0.5)+u.st.crit*((dvOf(Ea.S,"critcdreductionperhit",Ea.rank)||1.5)-(dvOf(Ea.S,"cdreductionperhit",Ea.rank)||0.5))));
        const O=K.over; if (O && O.until>t && !tgt.pet){ O.until=Math.min(t+5, O.until+2.5); addBuff(u,"zeriR",O.until,O.mods,t); }
        simNotes.add(`${u.name}: every attack is Burst Fire (22–38 + 102–110% AD, crits, on-hit; attack speed capped at 1.5); each cuts Spark Surge's cooldown 0.5 s (1.5 s on a crit, expected)`);
        return {replace:{v:evalCalc(ctx,"activedamagethatcancrit").v*mult, type:"physical", what:"Burst Fire"}, bonus:b}; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="E"){ const p=(a.later||[]).find(q=>q.later==="attack"); K.lr=p ? {until:t+(dvOf(a.S,"buffduration",a.rank)||5), v:p.v/(1+u.st.crit*(u.st.critdmg-1))} : null; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="R"){ const mods={bonusAS:dvOf(a.S,"baseaspercent",a.rank)||0.3, mspct:dvOf(a.S,"basebonusms",a.rank)||0.15, zeriOver:1}; K.over={until:t+(dvOf(a.S,"rduration",a.rank)||5), mods}; addBuff(u,"zeriR",K.over.until,mods,t);
          simNotes.add(`${u.name} R: Overcharged 5 s (+2.5 s per hit, at most 5 s left): +30% attack speed, +15% move speed, attack-speed cap 1.5 + 0.3 × ratio; the chain lightning to other enemies isn't modelled`); } },
    },
    /* ---- champion audit batch 4 (2026-09-24) ---- */
    Nasus: {
      onCast(u, a, tgt, t){ const K=u.kit, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        if (a.slot==="E" && tgt){ const d=(a.later||[]).find(p=>p.later==="dot"), cx=tgt.xS ?? tgt.x, sh=-(dvOf(a.S,"armorshredpercent",a.rank)||-0.3), r=400;
          const inside=(x)=>Math.abs((x.xS ?? x.x)-cx) <= r+RAD(x);
          for (const x of enemiesOf(u,t)) if (inside(x)) (x.kitShred ||= {}).nasusE={until:t+1, pct:sh};
          if (d && d.per>0) for (let i=1;i<=Math.round(d.v/d.per);i++) events.push({at:t+i, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (inside(x)){ (x.kitShred ||= {}).nasusE={until:tt+1, pct:sh}; kitLater(u, x, tt, {v:d.per, type:"magic"}, "E Spirit Fire tick"); } }});
          simNotes.add(`${u.name} E: Spirit Fire — the blast, then a tick every second for 5 s (game data; the wiki's total says 10) to enemies within 400 of the spot, and −${fmt(sh*100)}% armor while inside (+1 s)`); }
        if (a.slot==="W" && tgt){ const base=(dvOf(a.S,"slowbase",a.rank)||35)/100, per=(dvOf(a.S,"slowpertick",a.rank)||3)/100, dur=dvOf(a.S,"duration",a.rank)||5, mx=(dvOf(a.S,"maxslowtooltiponly",a.rank)||47)/100;
          for (let k=1;k<dur;k++) events.push({at:t+k, fn:(tt)=>{ if (tgt.alive && u.alive) applyCC(u, {slot:"W", S:a.S, p:{}, cc:[{type:"slow", dur:dur-k, pct:Math.min(mx, base+per*k)}]}, tgt, tt, 0); }});
          simNotes.add(`${u.name} W: Wither slows 35%, +${fmt(per*100)}% each second up to ${fmt(mx*100)}% (5 s); its attack-speed slow isn't modelled`); }
        if (a.slot==="R"){ const dur=dvOf(a.S,"duration",a.rank)||15, res=dvOf(a.S,"initialresistgain",a.rank)||40, cap=(dvOf(a.S,"maxdamagecap",a.rank)||240)/2;
          K.fury=t+dur; addBuff(u, "nasusR", t+dur, {bonushp:dvOf(a.S,"bonushealth",a.rank)||300, bonusarmor:res, bonusmr:res}, t);
          const per=evalCalc(ctx,"damagecalc").v/2;
          for (let i=1;i<=Math.round(dur*2);i++) events.push({at:t+0.5*i, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 400+RAD(x)) kitLater(u, x, tt, {v:Math.min(cap, per*x.max), type:"magic"}, "R storm"); }});
          simNotes.add(`${u.name} R: Fury of the Sands 15 s — +${fmt(dvOf(a.S,"bonushealth",a.rank)||300)} health, +${fmt(res)} armor and MR; enemies within 400 take ${fmt(per*200)}% of their maximum health per second (every 0.5 s, at most 240 per second); Siphoning Strike's cooldown halved`); } },
    },
    Jax: {
      // Relentless Assault: +5–12.5% attack speed per attack (8 stacks, 2.5 s; all fall off together here); Grandmaster-at-Arms: every third attack
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Jax.P, per=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"attackspeedperstack").v, R=K.ra && K.ra.until>t ? K.ra : {n:0};
        K.ra={n:Math.min(dvOf(P,"maxstacks",1)||8, R.n+1), until:t+(dvOf(P,"buffduration",1)||2.5)}; addBuff(u, "jaxP", K.ra.until, {bonusAS:per*K.ra.n}, t);
        const Ra=u.abAll.R, b=[];
        if (Ra){ const G=K.gm && K.gm.until>t ? K.gm : {n:0};
          if (G.n>=2){ K.gm=null; b.push({v:evalCalc({S:Ra.S, rank:Ra.rank, st:u.st, flags:u.flags},"onhitdamage").v, type:"magic", what:"Grandmaster-at-Arms"}); }
          else K.gm={n:G.n+1, until:t+(dvOf(Ra.S,"passivefallofftime",Ra.rank)||2.5)}; }
        simNotes.add(`${u.name}: Relentless Assault — each attack +${fmt(per*100)}% attack speed (up to 8 stacks, 2.5 s); Grandmaster-at-Arms (R learned): every third attack within 2.5 s deals bonus magic`);
        return b.length ? {bonus:b} : null; },
      dodgeAttack(u, att, t){ const E=u.kit.evade; if (!E || !(E.until>t)) return false; E.n++; return true; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W" && !ATTACK_TIMING) u.nextAA=Math.min(u.nextAA, t);   // Empower resets his attack (with attack timing: EMPOWER_NEXT resets it at the press; this runs at the empowered attack's landing)
        if (a.slot==="E"){ const L=(a.later||[]).filter(p=>p.later==="recast"), d=dvOf(a.S,"dodgeduration",a.rank)||2, E={until:t+d, n:0}; K.evade=E; a.ccAll ??= a.cc||[]; a.cc=[]; const cc=a.ccAll;
          events.push({at:t+d, fn:(tt)=>{ if (!u.alive) return; const n=Math.min(dvOf(a.S,"maxdodgesfordamageincrease",a.rank)||5, E.n), m=1+(dvOf(a.S,"percentincreasedperdodge",a.rank)??0.2)*n;
            for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 375+RAD(x)){ for (const p of L) kitLater(u, x, tt, {...p, v:p.v*m}, `E recast (${n} dodged)`); applyCC(u, {slot:"E", S:a.S, p:{}, cc, hard:true}, x, tt, 0); } }});
          simNotes.add(`${u.name} E: Counter Strike — dodges attacks for 2 s, then the recast hits enemies within 375 (+20% per attack dodged, up to 5) and stuns 1 s; the 25% area-damage reduction isn't modelled`); }
        if (a.slot==="R"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, n=enemiesOf(u,t).filter(x=>!x.pet && gap(u,x) <= 375+RAD(x)).length;
          if (n>0){ const ar=evalCalc(ctx,"basearmor").v+(n-1)*evalCalc(ctx,"bonusarmor").v, mr=ar*(dvOf(a.S,"mrmult",a.rank)||0.6);
            addBuff(u, "jaxR", t+(dvOf(a.S,"duration",a.rank)||8), {bonusarmor:ar, bonusmr:mr}, t);
            simNotes.add(`${u.name} R: hitting ${n} champion${n>1?"s":""} gives +${fmt(ar)} armor and +${fmt(mr)} MR for 8 s`); } } },
      afterCast(u, a){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll; },
    },
    Chogath: {
      onCast(u, a, tgt, t){ if (a.slot!=="E") return; const n=dvOf(a.S,"maximumattacks",a.rank)||3, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        u.kit.spikes={n, until:t+(dvOf(a.S,"buffduration",a.rank)||6), flat:evalCalc(ctx,"flatdamagecalc").v, pct:evalCalc(ctx,"maxhealthpercentcalc").v, cc:a.cc||[]};
        a.ccAll ??= a.cc||[]; a.cc=[]; u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} E: Vorpal Spikes — his next 3 attacks within 6 s (attack reset) each add bonus magic damage (flat + % maximum health) and a decaying slow`); },
      afterCast(u, a){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t){ const S=u.kit.spikes; if (!S || !(S.until>t) || S.n<=0) return null; S.n--;
        applyCC(u, {slot:"E", S:u.abAll.E.S, p:{}, cc:S.cc}, tgt, t, 0);
        return {bonus:[{v:S.flat+S.pct*tgt.max, type:"magic", what:"Vorpal Spikes"}]}; },
    },
    Leona: {
      onCast(u, a, tgt, t){ if (a.slot!=="W") return; const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, d=dvOf(a.S,"armormrduration",a.rank)||3, L=(a.later||[]).filter(p=>p.later==="delay");
        const mods={bonusarmor:evalCalc(ctx,"bonusarmortooltip").v, bonusmr:evalCalc(ctx,"bonusmrtooltip").v}; addBuff(u, "leonaW", t+d, mods, t);
        events.push({at:t+d, fn:(tt)=>{ if (!u.alive) return; let hit=false; for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 450+RAD(x)){ hit=true; for (const p of L) kitLater(u, x, tt, p, "W Eclipse detonation"); kitMarkSun(u, x, tt); }
          if (hit) addBuff(u, "leonaW", tt+d, mods, tt); }});
        simNotes.add(`${u.name} W: Eclipse — +${fmt(mods.bonusarmor)} armor and MR for 3 s, then the detonation around her (450); a hit keeps the resistances 3 s more; the flat damage reduction isn't modelled`); },
      afterCast(u, a, tgt, t){ if (tgt && a.slot!=="W" && a.parts.length && inReach(u,a,tgt)) kitMarkSun(u, tgt, t); },
    },
    KSante: {
      attack(u, tgt, t){ const M=tgt.ksMark; if (!M || M.by!==u || !(M.until>t)) return null; tgt.ksMark=null; const L=u.st.level||1, f=0.01+0.01*(L-1)/17;
        simNotes.add(`${u.name}: Dauntless Instinct — his ability hits mark the target (4 s); his next attack on it deals 12 + ${fmt(f*100)}% maximum health bonus physical`);
        return {bonus:[{v:(dvOf(CALC.champs.KSante.P,"flatdamage",1)||12)+f*tgt.max, type:"physical", what:"Dauntless Instinct"}]}; },
      onCast(u, a, tgt, t){ if (a.slot!=="Q") return; const K=u.kit, S=K.qst && K.qst.until>t ? K.qst : {n:0};
        a.ccAll ??= a.cc||[]; K.qEmp = S.n>=2; if (K.qEmp){ K.qst=null; a.cc=a.ccAll; } else a.cc=a.ccAll.filter(e=>e.type==="slow"); u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} Q: Ntofo Strikes — each hit gives a stack (6 s); the cast after 2 stacks pulls and stuns, the others only slow; attack reset`); },
      afterCast(u, a, tgt, t){ const hit = tgt && tgt.alive && a.parts.length && inReach(u,a,tgt);
        if (a.slot==="Q"){ if (a.ccAll) a.cc=a.ccAll; if (hit && !u.kit.qEmp){ const S=u.kit.qst && u.kit.qst.until>t ? u.kit.qst : {n:0}; u.kit.qst={n:Math.min(2,S.n+1), until:t+(dvOf(a.S,"recastwindow",a.rank)||6)}; } }
        if (hit && !tgt.pet) tgt.ksMark={by:u, until:t+(dvOf(CALC.champs.KSante.P,"markduration",1)||4)}; },
    },
    Cassiopeia: {
      afterCast(u, a, tgt, t){ if (!tgt || !tgt.alive || !inReach(u,a,tgt)) return;
        if (a.slot==="Q") tgt.cassPoison={by:u, until:Math.max(tgt.cassPoison && tgt.cassPoison.by===u ? tgt.cassPoison.until : 0, t+(dvOf(a.S,"poisonduration",a.rank)||3))};
        if (a.slot==="W") tgt.cassPoison={by:u, until:Math.max(tgt.cassPoison && tgt.cassPoison.by===u ? tgt.cassPoison.until : 0, t+(dvOf(a.S,"cloudduration",a.rank)||5)+(dvOf(a.S,"poisonduration",a.rank)||1))}; },
      onCast(u, a, tgt, t){ if (a.slot!=="E" || !tgt) return; const P=tgt.cassPoison; if (!P || P.by!==u || !(P.until>t)) return; const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        a.parts.push({v:evalCalc(ctx,"bonuspoisoneddamage").v, type:"magic"}); heal(u, u, evalCalc(ctx,"healcalc").v, t, "Twin Fang");
        simNotes.add(`${u.name} E: Twin Fang on a target she poisoned (Q 3 s, W while in the clouds + 1 s): bonus magic damage and a heal`); },
    },
    TwistedFate: {
      init(u){ u.kit.deck=3; },   // Stacked Deck: full stacks on respawning (wiki)
      onCast(u, a, tgt, t){ if (a.slot!=="W") return; const p=(a.later||[]).find(q=>q.later==="attack"); a.ccAll ??= a.cc||[]; a.cc=[];
        u.kit.card = p ? {until:t+6, v:p.v, what:p.card||"Gold Card", cc:a.ccAll.filter(e=>e.type==="stun"), S:a.S} : null; u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} W: the Gold Card is locked at once (the up to 1 s wait for it in the cycle isn't modelled) and replaces his next attack: magic damage and the stun then`); },
      afterCast(u, a){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t){ const K=u.kit, C=K.card, E=u.abAll.E; let out=null;
        if (C && C.until>t){ K.card=null; out={replace:{v:C.v, type:"magic", what:C.what}}; applyCC(u, {slot:"W", S:C.S, p:{}, cc:C.cc, hard:true}, tgt, t, 0); }
        if (E){ if ((K.deck||0)>=3){ K.deck=0; const b={v:evalCalc({S:E.S, rank:E.rank, st:u.st, flags:u.flags},"bonusdamage").v, type:"magic", what:"Stacked Deck"}; out=out ? {...out, bonus:[b]} : {bonus:[b]}; } else K.deck=(K.deck||0)+1;
          simNotes.add(`${u.name}: Stacked Deck — every 4th attack deals bonus magic damage (full stacks at the start)`); }
        return out; },
    },
    Pyke: {
      onCast(u, a, tgt, t){
        if (a.slot==="E" && tgt){ const p=(a.later||[]).find(q=>q.later==="phantom"); a.ccAll ??= a.cc||[]; a.cc=[]; const cc=a.ccAll.map(e=>e.type==="stun" ? {...e, dur:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"stunduration").v||e.dur} : e);
          events.push({at:t+(dvOf(a.S,"stundelay",a.rank)||1), fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt)) return; if (p) kitLater(u, tgt, tt, p, "E phantom"); applyCC(u, {slot:"E", S:a.S, p:{}, cc, hard:true}, tgt, tt, 0); }});
          simNotes.add(`${u.name} E: the phantom returns 1 s after the dash and stuns the target (assumed on its path) for 1.25 s (+0.1 per 10 lethality), dealing its damage then`); }
        if (a.slot==="R" && tgt){ const th=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"rdamage").v; u.kit.exec = !tgt.pet && (tgt.hpS ?? tgt.hp) <= th ? th : 0; if (u.kit.exec) a.parts=[]; } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="R" && tgt && u.kit.exec){ u.kit.exec=0; if (tgt.alive){ say(t, `  ${u.name}: Death from Below executes ${tgt.name}`); deal(u, tgt, tgt.hp, "true", t, "proc", "Death from Below execute"); }
          if (!tgt.alive && !tgt.dummy) u.cd.R=Math.min(u.cd.R||0, t+0.5);   // a kill lets him recast within 20 s
          simNotes.add(`${u.name} R: Death from Below executes champions at or below the threshold (250–550 by level + 80% bonus AD + 1.5 per lethality); a kill lets him recast`); } },
    },
    Hecarim: {
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=[]; K.charge={t0:t, until:t+(dvOf(a.S,"duration",a.rank)||4), x0:u.x, S:a.S, rank:a.rank}; u.nextAA=Math.min(u.nextAA, t);
          for (let i=0;i<=5;i++) events.push({at:t+0.5*i, fn:(tt)=>kitHecSpeed(u, t, tt)});
          simNotes.add(`${u.name} E: Devastating Charge — move speed 25% rising to 65% over 2.5 s; his next attack within 4 s deals 30–90 (+50% bonus AD) up to double after 1200 units travelled since the cast, knocks back 150–350 and stuns 0.25 s`); }
        if (a.slot==="W"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, d=dvOf(a.S,"buffduration",a.rank)||4, r=dvOf(a.S,"resistamount",a.rank)||5; K.wUntil=t+d;
          addBuff(u, "hecW", t+d, {bonusarmor:r, bonusmr:r}, t);
          simNotes.add(`${u.name} W: Spirit of Dread — +${fmt(r)} armor and MR for 4 s; he heals 25% of the damage he deals to enemies within 525 (allies' damage isn't counted)`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="Q" && tgt && a.parts.length && inReach(u,a,tgt)){ const R=u.kit.ramp && u.kit.ramp.until>t ? u.kit.ramp : {n:0}; u.kit.ramp={n:Math.min(dvOf(a.S,"maxstacks",a.rank)||3, R.n+1), until:t+(dvOf(a.S,"buffduration",a.rank)||8)};
          simNotes.add(`${u.name} Q: Rampage — each hit gives a stack (3 max, 8 s): +3% (+3% per 100 bonus AD) damage and −0.75 s cooldown each`); } },
      onDealt(u, x, v, pre, type, t){ if (u.kit.wUntil>t && v>0 && gap(u,x) <= 525+RAD(x)) heal(u, u, v*(dvOf(u.abAll.W.S,"damageleechperc",u.abAll.W.rank)||25)/100, t, null, true); },
      attack(u, tgt, t){ const K=u.kit, C=K.charge; if (!C || !(C.until>t)) return null; K.charge=null; u.buffs=u.buffs.filter(b=>b.id!=="hecE"); refresh(u, t);
        const ctx={S:C.S, rank:C.rank, st:u.st, flags:u.flags}, dist=Math.abs(u.x-C.x0), f=Math.min(1, dist/(dvOf(C.S,"distancetomaxdamage",C.rank)||1200)), mn=evalCalc(ctx,"mindamage").v, mx=evalCalc(ctx,"maxdamage").v;
        const kb=(dvOf(C.S,"minknockback",C.rank)||150)+f*((dvOf(C.S,"maxknockback",C.rank)||350)-(dvOf(C.S,"minknockback",C.rank)||150));
        applyCC(u, {slot:"E", S:C.S, p:{}, cc:[{type:"knockback", dist:kb, dur:0.5}, {type:"stun", dur:0.25}], hard:true}, tgt, t, 0);
        return {bonus:[{v:mn+(mx-mn)*f, type:"physical", what:`Devastating Charge (${fmt(dist)} units)`}]}; },
    },
    Lucian: {
      onCast(u, a, tgt, t){ u.kit.ls={until:t+(dvOf(CALC.champs.Lucian.P,"passiveduration",1)||3.5)}; if (a.slot==="E") u.nextAA=Math.min(u.nextAA, t); },
      attack(u, tgt, t, mult){ const K=u.kit; if (!K.ls || !(K.ls.until>t)) return null; K.ls=null; const v=evalCalc({S:CALC.champs.Lucian.P, rank:1, st:u.st, flags:u.flags},"totaldamage").v*mult;
        events.push({at:t+0.25, fn:(tt)=>{ if (!u.alive || !tgt.alive) return; deal(u, tgt, v, "physical", tt, "aa", "Lightslinger second shot"); if (tgt.alive) applyOnHit(u, tgt, tt, {basic:true}); }});
        const E=u.abAll.E; if (E && (u.cd.E||0)>t) u.cd.E=Math.max(t, u.cd.E-2*(tgt.pet ? (dvOf(E.S,"cdrefundbase",E.rank)||1) : (dvOf(E.S,"cdrefundchampion",E.rank)||2)));
        simNotes.add(`${u.name}: Lightslinger — after each ability his next attack within 3.5 s fires a second shot 0.25 s later (50/55/60% AD, expected crit, on-hit); each of the two shots cuts Relentless Pursuit's cooldown 2 s (1 s on non-champions); Vigilance isn't modelled`);
        return null; },
    },
    /* ---- champion audit batch 5 (2026-09-24) ---- */
    Viego: {
      // Blade of the Ruined King passive: his attacks deal 2–6% of the target's current health (at least 10–30) bonus physical, crits ×1.7
      // (game data HealthCritMod 0.7); Q and W hits mark the target 4 s and his next attack on it strikes again: 20% AD (+15% AP) physical
      // (expected crit, on-hit effects), healing 150% of it (100% vs minions). Spectral Maw resets his attack; Harrowed Path: attack speed
      // in the mist (assumed inside for its 8 s)
      attack(u, tgt, t){ const Q=u.abAll.Q; if (!Q) return null; const S=Q.S, r=Q.rank, b=[];
        const f=(dvOf(S,"percenthealthonhit",r)||0)/100, mn=dvOf(S,"mindamageonhit",r)||0, cm=1+u.st.crit*(dvOf(S,"healthcritmod",r)??0.7);
        b.push({v:Math.max(mn, f*(tgt.hpS ?? tgt.hp))*cm, type:"physical", what:"Blade of the Ruined King"});
        const M=tgt.viegoMark;
        if (M && M.by===u && M.until>t){ tgt.viegoMark=null; const v=evalCalc({S, rank:r, st:u.st, flags:u.flags},"secondattackdamage").v*(1+u.st.crit*(critVs(u,tgt)-1));
          b.push({v, type:"physical", what:"Blade of the Ruined King second strike"});
          heal(u, u, kitPostMit(u, tgt, v, "physical")*(tgt.minion ? (dvOf(S,"healmodvsminions",r)||1) : (dvOf(S,"healmodvschamps",r)||1.5)), t, "Blade of the Ruined King");
          if (tgt.alive) applyOnHit(u, tgt, t, {basic:true}); }
        simNotes.add(`${u.name}: Blade of the Ruined King — his attacks deal ${fmt(f*100)}% of the target's current health (at least ${fmt(mn)}) bonus physical; Q and W hits mark the target (4 s) and his next attack strikes again for 20% AD (+15% AP), on-hit, healing 150% of it; possession isn't modelled`);
        return {bonus:b}; },
      onCast(u, a, tgt, t){
        if (a.slot==="W") u.nextAA=Math.min(u.nextAA, t);   // Spectral Maw resets his attack
        if (a.slot==="E"){ addBuff(u, "viegoE", t+(dvOf(a.S,"mistduration",a.rank)||8), {bonusAS:dvOf(a.S,"attackspeed",a.rank)||0}, t);
          simNotes.add(`${u.name} E: Harrowed Path — +${fmt((dvOf(a.S,"attackspeed",a.rank)||0)*100)}% attack speed in the mist (assumed inside for 8 s; camouflage not modelled)`); }
        if (a.slot==="W") simNotes.add(`${u.name} W: Spectral Maw fully charged: stun 1.25 s (game data MaxStunTT; the 1 s charge isn't modelled: the blast lands at the cast)`); },
      afterCast(u, a, tgt, t){ if ((a.slot==="Q" || a.slot==="W") && tgt && tgt.alive && a.parts.length && inReach(u,a,tgt)) tgt.viegoMark={by:u, until:t+(u.abAll.Q ? dvOf(u.abAll.Q.S,"markduration",u.abAll.Q.rank)||4 : 4)}; },
    },
    Zoe: {
      timing:{Q:"own"},   // backlog 25: Paddle Star! computes its own redirected flight from the press
      // More Sparkles!: after an ability, her next attack within 5 s deals bonus magic. Paddle Star!: redirected (perfect play) the star
      // travels 800 out, 800 back and the gap: damage ×(1 + 0–150% by distance), landing after its flight. Sleepy Trouble Bubble: drowsy
      // 1.4 s, then asleep 2.25 s (kitZoeWake); a champion hit refunds 16–30% of its cooldown. Spell Thief needs a spell shard (not cast).
      castable:(u, a)=>a.slot==="W" ? "Spell Thief's active needs a spell shard (not modelled)" : true,
      step(u, step, tgt, t, log){ if (step!=="W") return false; log({skipped:"Spell Thief's active needs a spell shard (not modelled); its bolts come with a summoner spell or shard cast"}); return "logged"; },
      onCast(u, a, tgt, t){ u.kit.spark=t+5;
        if (a.slot==="Q" && tgt){ const g=gap(u,tgt), d=Math.min(2550, 1600+g), f=zoeQMult(d), dl=800/1200+0.25+(800+g)/2500, L=a.parts.map(p=>({...p, v:p.v*f}));
          a.parts=[]; for (const p of L) kitLater(u, tgt, t+dl, p, `Q Paddle Star! (${fmt(d)} units, ×${fmt(f)})`);
          simNotes.add(`${u.name} Q: Paddle Star! is redirected (perfect play): the star flies 800 away, is recast after 0.25 s and flies back past her to the target (1600 + the gap in units travelled, ×1 to ×2.5 by distance; wiki breakpoints, linear between); it lands ${fmt(dl)} s after the cast`); }
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=a.ccAll.filter(e=>e.type!=="sleep"); } },
      afterCast(u, a, tgt, t){ if (a.slot!=="E") return; if (a.ccAll) a.cc=a.ccAll;
        if (!tgt || !tgt.alive || !inReach(u,a,tgt)) return; const dd=dvOf(a.S,"drowsyduration",a.rank)||1.4, sd=dvOf(a.S,"sleepduration",a.rank)||2.25, cap=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"breakdamagetooltip").v;
        // the drowsy clock starts when the bubble reaches the target: the cast time (0.3 s, game data) + the flight to its hitbox at 1850/s
        const land=a.land && a.land.deferred ? 0 : (a.p && a.p.castTime || 0) + Math.max(0, gap(u,tgt)-RAD(tgt))/((a.p && a.p.speed) || 1850);   // backlog 25: afterCast runs when the bubble lands
        events.push({at:t+land+dd, fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt)) return; applyCC(u, {slot:"E", S:a.S, p:{}, cc:[{type:"sleep", dur:sd}], hard:true}, tgt, tt, 0);
          const c=tgt.ccs.find(c=>c.type==="sleep" && c.src===u && c.until>tt); if (c) tgt.zoeSleep={by:u, from:tt, sleepEnd:c.until, cap, pen:dvOf(a.S,"percentpen",a.rank)??0.3}; }});
        const t0=pressOf(a,t); if (!tgt.pet && (u.cd.E||0)>t) u.cd.E=Math.max(t, t0+(u.cd.E-t0)*(1-(dvOf(a.S,"cooldownrefresh",a.rank)||0))); },
      attack(u, tgt, t){ const K=u.kit; if (!(K.spark>t)) return null; K.spark=0;
        simNotes.add(`${u.name}: More Sparkles! — after an ability her next attack within 5 s deals bonus magic damage`);
        return {bonus:[{v:evalCalc({S:CALC.champs.Zoe.P, rank:1, st:u.st, flags:u.flags},"passivedamage").v, type:"magic", what:"More Sparkles!"}]}; },
    },
    Leblanc: {
      // Sigil of Malice: the mark (3.5 s) is popped by her next ability hit on the target for the same damage again (a Mimic Q's for double);
      // Ethereal Chains: the tether fractures 1.5 s later if the target stays within 865 (game data TetherDistance): damage and root 1.5 s;
      // Mimic casts her last basic ability again with its own numbers
      castable:(u, a)=>a.slot!=="R" || u.kit.last ? true : "Mimic copies her last basic ability (none cast yet)",
      step(u, step, tgt, t, log){ if (step!=="R" || u.kit.last || !u.abAll.R) return false; log({skipped:"Mimic copies her last basic ability (none cast yet)"}); return "logged"; },
      onCast(u, a, tgt, t){ const K=u.kit; K.mim = a.slot==="R" ? (K.last||"Q") : a.slot; if (a.slot!=="R") K.last=a.slot;
        if (K.mim==="E"){ a.ccAll ??= a.cc||[]; a.cc=[]; } },
      afterCast(u, a, tgt, t){ const K=u.kit, mim=K.mim; if (a.ccAll) a.cc=a.ccAll;
        if (!tgt || !tgt.alive || inStasis(tgt,t) || !inReach(u,a,tgt) || !(a.parts.length || (a.later||[]).length)) return;
        const M=tgt.lbMark; if (M && M.by===u && M.until>t && M.at<=t){ tgt.lbMark=null; kitLater(u, tgt, t, M.p, `${M.slot==="R"?"Mimic ":""}Sigil of Malice mark popped`); }
        const L=a.later||[];
        if (mim==="Q"){ const p=L.find(q=>q.later==="mark"); if (p) tgt.lbMark={by:u, at:t, until:t+(dvOf(a.S, a.slot==="R" ? "rqmarkduration" : "markduration", a.rank)||3.5), p, slot:a.slot}; }
        if (mim==="E"){ const step=u.curStep ?? null, p=L.find(q=>q.later==="tether"), E=u.abAll.E, d=(E && dvOf(E.S,"tetherduration",E.rank))||1.5, rd=(E && dvOf(E.S,"rootduration",E.rank))||1.5, far=(E && dvOf(E.S,"tetherdistance",E.rank))||865;
          events.push({at:t+d, fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt) || gap(u,tgt) > far) return;
            if (p) kitDealNow(u, tgt, tt, p, `${a.slot==="R"?"Mimic ":""}Ethereal Chains fracture`, step); applyCC(u, {slot:a.slot, S:a.S, p:{}, cc:[{type:"root", dur:rd}], hard:true}, tgt, tt, 0); }}); }
        simNotes.add(`${u.name}: Sigil of Malice's mark is popped by her next ability hit (same damage again, double for Mimic's); Ethereal Chains roots and deals its second hit 1.5 s later if the target stays within 865; Mimic repeats her last basic ability (Mirror Image and Distortion's return aren't modelled)`); },
    },
    Taliyah: {
      timing:{W:"cast"},   // backlog 25: the kit times the knock-up (0.5 s after the cast)
      // Threaded Volley: 5 shards (all assumed to hit one target) and Worked Ground where she cast it (400 radius, 30 s); a cast on Worked
      // Ground is the Boulder instead (180%, slow, half cooldown, at least 0.75 s). Unraveled Earth: stones for 4 s; Seismic Shove knocks
      // enemies 400 units 0.5 s after the cast, detonating the stones under them (kitTaliyahStones)
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ a.ccAll ??= a.cc||[]; const G=(K.ground||[]).filter(g=>g.until>t), on=G.find(g=>Math.abs(u.x-g.x) <= (dvOf(a.S,"groundexhaustradius",a.rank)||400));
          if (on){ K.ground=G.filter(g=>g!==on); a.parts=[{v:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"bigrockdamage").v, type:"magic", pct:false}]; a.cc=a.ccAll;
            { const t0=pressOf(a,t); u.cd.Q=Math.max(t, t0+Math.max(dvOf(a.S,"minimumworkedgroundcd",a.rank)||0.75, (u.cd.Q-t0)*(1-(dvOf(a.S,"workedgroundcdr",a.rank)||0.5)))); }
            say(t, `  ${u.name}: Threaded Volley on Worked Ground — the Boulder`); }
          else { K.ground=[...G, {x:u.x, until:t+(dvOf(a.S,"groundexhaustduration",a.rank)||30)}]; a.cc=[]; }
          simNotes.add(`${u.name} Q: Threaded Volley — 5 shards (the first full, the rest 40%; all assumed on the target) leave Worked Ground (400 radius, 30 s); a cast from Worked Ground is the Boulder (180%, slows 1.5 s, half cooldown)`); }
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=a.ccAll.filter(e=>e.type==="slow");
          K.field={until:t+(dvOf(a.S,"minelifetime",a.rank)||4), step:u.curStep ?? null, det:(a.later||[]).find(p=>p.later==="stones")||null, S:a.S, stun:a.ccAll.filter(e=>e.type==="stun"), hit:new Set(), in:new Set(tgt ? hitList(u,a,tgt,t) : [])}; }
        if (a.slot==="W" && tgt){ a.ccAll ??= a.cc||[]; a.cc=[]; const cx=tgt.xS ?? tgt.x, cc=a.ccAll, dl=dvOf(a.S,"knockupdelay",a.rank)||0.5, r=(a.p && a.p.radius)||225;
          events.push({at:t+dl, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= r+RAD(x)){ applyCC(u, {slot:"W", S:a.S, p:a.p, cc, hard:true}, x, tt, 0);
            const kb=cc.find(e=>AIRBORNE.has(e.type)), F=u.kit.field; if (F && F.in.has(x)) kitTaliyahStones(u, x, tt, tt+(kb ? kb.dur : 1)); } }});
          simNotes.add(`${u.name} W: Seismic Shove erupts 0.5 s after the cast (game data KnockupDelay) and knocks enemies within 225 of the spot 400 units over 1 s; a target Unraveled Earth hit in the last 4 s is shoved over the stones: they detonate (up to 4, −25% each) and stun it 0.75 s when it lands`); } },
      afterCast(u, a){ if (a.ccAll && a.slot!=="Q") a.cc=a.ccAll; },
    },
    Aatrox: {
      // Deathbringer Stance: ready at the start; an empowered attack deals 4–10% of the target's maximum health bonus magic and heals him for
      // it (post-mitigation); cooldown 22–10 s by level (static), −2 s per attack or ability hit on a champion (−4 s for a Q sweetspot).
      // The Darkin Blade: 3 casts (1 s static between them, 4 s to recast; +25% each), all assumed in the sweetspot (+75%, knock-up
      // 0.25 s); the cooldown starts after the third. Infernal Chains: slow, then the same damage again and a pull back to the spot after
      // 1.5 s if the tether holds (assumed). World Ender: +20–40% AD and +50–100% healing for 10 s.
      recastAs: ["Q"],
      init(u){ u.kit.pAt=0; },
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Aatrox.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        if (t < K.pAt){ if (!tgt.pet && !tgt.minion) K.pAt=Math.max(t, K.pAt-(dvOf(P,"pchargerate",1)||2)); return null; }
        let v=evalCalc(ctx,"pdamage").v*tgt.max; if (tgt.pet) v=Math.min(v, evalCalc(ctx,"monsterdamagecap").v);
        K.pAt=t+evalCalc(ctx,"pcooldown").v; heal(u, u, kitPostMit(u, tgt, v, "magic")*(tgt.minion ? (dvOf(P,"phealingminionmod",1)||0.25) : 1), t, "Deathbringer Stance");
        simNotes.add(`${u.name}: Deathbringer Stance — an empowered attack deals ${fmt(evalCalc(ctx,"pdamage").v*100)}% of the target's maximum health bonus magic and heals him for it; cooldown ${fmt(evalCalc(ctx,"pcooldown").v)} s (static), −2 s per attack or ability hit on a champion (−4 s for a Q sweetspot)`);
        return {bonus:[{v, type:"magic", what:"Deathbringer Stance"}]}; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ const n=kitRecast(u, a, t, 3, 1, dvOf(a.S,"qextensiontime",a.rank)||4, false); if (n>=3) u.cd.Q=pressOf(a,t)+a.cd;
          simNotes.add(`${u.name} Q: The Darkin Blade casts 3 times (1 s apart at the earliest, 4 s to recast; each +25%), all in the sweetspot (+75%, knock-up 0.25 s, perfect aim); the cooldown starts after the third`); }
        if (a.slot==="E") u.nextAA=Math.min(u.nextAA, t);   // Umbral Dash resets his attack
        if (a.slot==="W"){ a.ccAll ??= a.cc||[]; a.cc=a.ccAll.filter(e=>e.type==="slow"); }
        if (a.slot==="R"){ const d=dvOf(a.S,"rduration",a.rank)||10, ad=(dvOf(a.S,"rtotaladamp",a.rank)||0)*u.st.ad, h=dvOf(a.S,"rhealingamp",a.rank)||0;
          addBuff(u, "aatroxR", t+d, {bonusad:ad, healIn:h}, t); say(t, `  ${u.name}: World Ender, +${fmt(ad)} AD and +${fmt(h*100)}% healing for ${fmt(d)} s`);
          simNotes.add(`${u.name} R: World Ender — +${fmt((dvOf(a.S,"rtotaladamp",a.rank)||0)*100)}% AD as bonus AD and +${fmt(h*100)}% healing for 10 s (the takedown extension isn't modelled)`); } },
      afterCast(u, a, tgt, t){ const K=u.kit; if (a.slot==="W" && a.ccAll) a.cc=a.ccAll;
        const hit = tgt && tgt.alive && !tgt.pet && !tgt.minion && a.parts.length && inReach(u,a,tgt);
        if (hit && K.pAt>t) K.pAt=Math.max(t, K.pAt-(a.slot==="Q" ? 2 : 1)*(dvOf(CALC.champs.Aatrox.P,"pchargerate",1)||2));
        if (a.slot==="W" && tgt && tgt.alive && inReach(u,a,tgt)){ const p=(a.later||[]).find(q=>q.later==="tether"), cx=tgt.xS ?? tgt.x, step=u.curStep ?? null;
          events.push({at:t+1.5, fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt)) return; if (p) kitDealNow(u, tgt, tt, p, "W Infernal Chains (tether held)", step);
            applyCC(u, {slot:"W", S:a.S, p:{}, cc:(a.ccAll||[]).filter(e=>AIRBORNE.has(e.type)), hard:true}, tgt, tt, 0); displace(tgt, cx, 0.5, tt, true); }});
          simNotes.add(`${u.name} W: Infernal Chains — the tether is assumed to hold: 1.5 s later the same damage again and a pull back to where it hit (airborne 0.5 s assumed; the break range isn't in the game data or the wiki)`); } },
    },
    Seraphine: {
      // Echo: every third basic ability cast (full stacks at the start) is cast again 0.01 s later; Notes: each ability cast gives one (up to 4,
      // 6 s), her next attack fires them all; Beat Drop roots an already slowed target and stuns an immobilized one; Surround Sound heals only
      // if she already has a shield
      init(u){ u.kit.echo=2; },
      // the Note and the Echo count are the cast's (at the press: a Q still in the air doesn't give its Note to an attack or its Echo to a
      // later E that lands first; batch 8 re-check after the sheets' Q delay 0.4 s)
      pressCast(u, a, tgt, t){ const K=u.kit; if (K.echoing) return;
        K.notes={n:Math.min(dvOf(CALC.champs.Seraphine.P,"maxnotes",1)||4, (K.notes && K.notes.until>t ? K.notes.n : 0)+1), until:t+(dvOf(CALC.champs.Seraphine.P,"noteduration",1)||6)};
        if ("QWE".includes(a.slot)){ if ((K.echo||0)>=2){ K.echo=0; K.echoNext=a.slot; } else K.echo=(K.echo||0)+1; } },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W" && !u.shields.some(s=>s.until>t && shieldLeft(s,t)>0)) a.heal=0;
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; const slowed=tgt && tgt.slows.some(s=>s.until>t && !(s.t0>=t)), imm=tgt && tgt.ccs.some(c=>ccLive(c,t) && ["stun","root","knockup","knockback","pull","suppress","sleep","ground"].includes(c.type));
          a.cc=a.ccAll.filter(e=>e.type==="slow" || (e.type==="root" && slowed) || (e.type==="stun" && imm)); } },
      afterCast(u, a, tgt, t){ const K=u.kit; if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (K.echoNext!==a.slot || K.echoing) return; K.echoNext=null; const d0=tgt ? gap(u,tgt) : 0, step=u.curStep ?? null;
        events.push({at:t+0.01, fn:(tt)=>{ if (!u.alive) return; const x=tgt && tgt.alive ? tgt : enemiesOf(u,tt)[0]||null, prev=u.curStep, b=u.dealt; u.curStep=step; K.echoing=true; refresh(u,tt); abNums(u,a);
          say(tt, `  ${u.name}: Echo — ${a.slot} again`); resolveCast(u, a, x, tt, d0);
          if (a.slot==="W"){ const sh=u.shields.some(s=>s.until>tt && shieldLeft(s,tt)>0); for (const y of alliesOf(u)) if (gap(u,y) <= 800){ if (a.shield) shield(u, y, a.shield, a.shieldDur, tt, "W (Echo)"); if (sh && a.heal) heal(u, y, a.heal, tt, "W (Echo)"); } }
          K.echoing=false; u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }});
        simNotes.add(`${u.name}: Echo —every third basic ability cast (she starts with 2 stacks, so her first one echoes) is cast again at once; Notes from her casts power up her next attack; Beat Drop roots a target already slowed and stuns one already immobilized`); },
      attack(u, tgt, t){ const N=u.kit.notes; if (!N || !(N.until>t) || N.n<=0) return null; u.kit.notes=null;
        return {bonus:[{v:N.n*evalCalc({S:CALC.champs.Seraphine.P, rank:1, st:u.st, flags:u.flags},"autodamage").v, type:"magic", what:`Stage Presence (${N.n} Note${N.n>1?"s":""})`}]}; },
    },
    Senna: {
      timing:{W:"travel"},   // backlog 25: the root lands 1 s after the hit (the kit times it; the data's delay is that)
      // Relic Cannon: +20% AD bonus physical on her attacks (life steal applies); each attack cuts Piercing Darkness 1 s. Absolution: her
      // attacks and ability hits mark a champion 4 s; the next one consumes it for 1–10% (by level) of its current health bonus physical, then
      // 6/5/4 s (game data DebuffDuration) before it can be marked again. Last Embrace roots 1 s after the hit (the target and enemies within 280).
      mark(u, x, t){ if (!x.alive || x.pet || x.minion) return null; const M=x.sennaMark, ctx={S:CALC.champs.Senna.P, rank:1, st:u.st, flags:u.flags};
        if (M && M.by===u && M.until>t){ x.sennaMark=null; x.sennaImm=t+evalCalc(ctx,"debuffduration").v;
          return {v:evalCalc(ctx,"bonuscurenthealthdamage").v/100*(x.hpS ?? x.hp), type:"physical", what:"Absolution"}; }
        if (!(x.sennaImm>t)) x.sennaMark={by:u, until:t+(dvOf(CALC.champs.Senna.P,"markduration",1)||4)}; return null; },
      attack(u, tgt, t){ const b=[{v:evalCalc({S:CALC.champs.Senna.P, rank:1, st:u.st, flags:u.flags},"bonusonhitdamage").v, type:"physical", what:"Relic Cannon"}];
        const Q=u.abAll.Q; if (Q && (u.cd.Q||0)>t) u.cd.Q=Math.max(t, u.cd.Q-(dvOf(Q.S,"cdreductiononhit",Q.rank)||1));
        const m=CHAMP_MECH.Senna.mark(u, tgt, t); if (m) b.push(m);
        simNotes.add(`${u.name}: Relic Cannon +20% AD on her attacks; each attack cuts Piercing Darkness 1 s; Absolution marks (4 s) are consumed by her next hit for 1–10% current health (Mist stacks: set .stacks)`);
        return {bonus:b}; },
      onCast(u, a){ if (a.slot==="W"){ a.ccAll ??= a.cc||[]; a.cc=[]; } },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll;
        if (!tgt || !tgt.alive || !a.parts.length || !inReach(u,a,tgt)) return;
        const m=CHAMP_MECH.Senna.mark(u, tgt, t); if (m) deal(u, tgt, m.v, m.type, t, "proc", m.what);
        if (a.slot==="W"){ const cx=tgt, cc=a.ccAll||[];
          events.push({at:t+(dvOf(a.S,"delaytime",a.rank)||1), fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (x===cx || gap(x,cx) <= 280+RAD(x)) applyCC(u, {slot:"W", S:a.S, p:{}, cc, hard:true}, x, tt, 0); }});
          simNotes.add(`${u.name} W: Last Embrace roots 1 s after the hit (game data DelayTime), the target and enemies within 280 of it`); } },
    },
    Nami: {
      // Tidecaller's Blessing goes on the allied champion (or Nami) with the most attack damage per second: its next 3 attacks or ability
      // casts within 6 s (kitNamiHit). Tidal Wave's slow: 2 s + 0.002 s per unit travelled, up to 4 s (game data)
      onCast(u, a, tgt, t){
        if (a.slot==="E"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, al=alliesOf(u).slice().sort((p,q)=>q.st.ad*q.st.as-p.st.ad*p.st.as || (p===u)-(q===u))[0]||u;
          al.namiE={by:u, n:dvOf(a.S,"hitcount",a.rank)||3, until:t+(dvOf(a.S,"buffduration",a.rank)||6), v:evalCalc(ctx,"totaldamage").v, slow:evalCalc(ctx,"totalslow").v, S:a.S, cid:null};
          a.parts=[]; a.ccAll ??= a.cc||[]; a.cc=[]; say(t, `  ${u.name}: Tidecaller's Blessing on ${al===u?"herself":al.name}`);
          simNotes.add(`${u.name} E: Tidecaller's Blessing on the ally with the most attack damage per second (or Nami): its next 3 attacks or ability casts within 6 s deal bonus magic and slow 1 s`); }
        if (a.slot==="R" && tgt){ a.ccAll ??= a.cc||[]; const dur=Math.min(dvOf(a.S,"maxslowduration",a.rank)||4, (dvOf(a.S,"minslowduration",a.rank)||2)+(dvOf(a.S,"disttoslowratio",a.rank)||0.002)*gap(u,tgt));
          a.cc=a.ccAll.map(e=>e.type==="slow" ? {...e, dur} : e); } },
      afterCast(u, a){ if ((a.slot==="E" || a.slot==="R") && a.ccAll) a.cc=a.ccAll; },
    },
    Janna: {
      // Tailwind: 30% of her bonus move speed as on-hit magic on her attacks; Eye of the Storm: the shielded ally gains 10–30 (+10% AP) AD for
      // the 4 s (assumed unbroken); her abilities that slow or knock up an enemy champion refund 20% of its cooldown
      attack(u, tgt, t){ const v=evalCalc({S:CALC.champs.Janna.P, rank:1, st:u.st, flags:u.flags},"bonusdamage").v; return v>0 ? {bonus:[{v, type:"magic", what:"Tailwind"}]} : null; },
      afterCast(u, a, tgt, t){ const E=u.abAll.E;
        if (a.slot!=="E" && E && (u.cd.E||0)>t && tgt && tgt.alive && !tgt.pet && (a.cc||[]).some(e=>e.type==="slow" || AIRBORNE.has(e.type)) && (a.parts.length ? inReach(u,a,tgt) : hitList(u,a,tgt,t).includes(tgt))){
          u.cd.E=Math.max(t, u.cd.E-(dvOf(E.S,"ecdrefundforcc",E.rank)||0.2)*abCd(u,E)); simNotes.add(`${u.name}: Eye of the Storm's cooldown −20% when her abilities slow or knock up an enemy champion`); }
        if (a.slot==="E" && a.shield){ const ad=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"totalad").v;
          for (const x of supportTargets(u,{...a, heal:0},t,true)||[u]) addBuff(x, "jannaE", t+(dvOf(a.S,"shieldduration",a.rank)||4), {bonusad:ad}, t);
          simNotes.add(`${u.name} E: Eye of the Storm's shield also gives +${fmt(ad)} AD for its 4 s (assumed unbroken)`); } },
    },
    Vladimir: {
      timing:{R:"cast"},   // backlog 25: the plague lands at the cast (wiki: cast time none); the data's 0.4 s delay is the heal after the burst, which the kit times
      // Transfusion: each cast gives a Fury point when its cooldown ends; at 2 he surges for 2.5 s and a Q then is empowered (×1.85, extra heal
      // 30–200 + 5% (+4% per 100 AP) of his missing health). Sanguine Pool: 15% current health, untargetable 2 s. Tides of Blood: charged
      // 1 s (8% maximum health above 12%), then the burst around him and the slow. Hemoplague: +10% damage taken for 4 s, then the burst
      // and his heal (40% for champions after the first)
      onCast(u, a, tgt, t){ const K=u.kit, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
        if (a.slot==="Q"){ if ((K.fury||0)>=2 && K.surge>t){ K.fury=0; K.surge=0; heal(u, u, evalCalc(ctx,"empoweredhealtooltip").v+evalCalc(ctx,"empoweredhealpercenttooltip").v*(u.max-u.hp), t, "Transfusion (empowered)"); say(t, `  ${u.name}: empowered Transfusion (2 Fury)`); }
          events.push({at:Math.max(t, u.cd.Q||t), fn:(tt)=>{ K.fury=Math.min(2,(K.fury||0)+1); if (K.fury>=2){ const s=tt+(dvOf(a.S,"frenzyduration",a.rank)||2.5); K.surge=s; events.push({at:s, fn:()=>{ if (K.surge===s) K.fury=0; }}); } }});
          simNotes.add(`${u.name} Q: Transfusion — each cast gives a Fury point when its cooldown ends; at 2 he surges for 2.5 s and the next Q is empowered (×1.85 damage and extra healing)`); }
        if (a.slot==="W"){ u.hp=Math.max(1, u.hp-(dvOf(a.S,"healthcost",a.rank)??0.15)*u.hp); u.stasisUntil=Math.max(u.stasisUntil, t+2);
          simNotes.add(`${u.name} W: Sanguine Pool costs 15% of his current health; he is untargetable for 2 s (modelled as stasis: he doesn't act either)`); }
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=[]; const P=a.parts, ch=dvOf(a.S,"timetorampmaxdamage",a.rank)||1, step=u.curStep ?? null; a.parts=[];
          if (u.hp > 0.12*u.max) u.hp=Math.max(1, u.hp-evalCalc(ctx,"chargehealthtooltip").v); u.nextAA=Math.max(u.nextAA, t+ch);
          events.push({at:t+ch, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 600+RAD(x)){ for (const p of P) kitDealNow(u, x, tt, p, "E Tides of Blood (charged 1 s)", step); applyCC(u, {slot:"E", S:a.S, p:{}, cc:a.ccAll}, x, tt, 0); } }});
          simNotes.add(`${u.name} E: Tides of Blood is charged 1 s (costing 8% of his maximum health above 12%; no attacks meanwhile), then hits enemies within 600 and slows them 0.5 s`); }
        if (a.slot==="R"){ const L=a.parts, hits=tgt ? hitList(u,a,tgt,t) : [], amp=(dvOf(a.S,"damageamp",a.rank)||10)/100, hv=a.heal; a.parts=[]; a.heal=0;
          for (const x of hits){ x.expose={until:t+4, amp:Math.max(amp, x.expose && x.expose.until>t ? x.expose.amp : 0)}; for (const p of L) kitLater(u, x, t+4, p, "R Hemoplague burst"); }
          const n=hits.filter(x=>!x.pet && !x.minion).length; if (n) events.push({at:t+4.4, fn:(tt)=>{ if (u.alive) heal(u, u, hv*(1+(dvOf(a.S,"vamppercentadditionalchamp",a.rank)||40)/100*(n-1)), tt, "Hemoplague"); }});
          simNotes.add(`${u.name} R: Hemoplague — +10% damage taken for 4 s, then the burst; he heals 0.4 s later (40% for each champion after the first)`); } },
      afterCast(u, a){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll; },
    },
    Khazix: {
      // Unseen Threat: ready at the start (he comes out of fog or brush) and after Void Assault: his next attack on a champion deals bonus
      // magic and slows 25% for 2 s. Taste Their Fear: ×2.1 on an isolated target (no other enemy within 375); evolved: −45% cooldown then.
      // Void Assault: invisible 1.25 s (2 evolved) with +40% move speed, recast 2 s after (2 casts, 3 evolved; invisibility not modelled)
      recastAs: ["R"],
      init(u){ u.kit.unseen=true; },
      attack(u, tgt, t){ const K=u.kit; if (!K.unseen || tgt.pet || tgt.minion) return null; K.unseen=false; const P=CALC.champs.Khazix.P;
        applyCC(u, {slot:"P", S:P, p:{}, cc:[{type:"slow", pct:dvOf(P,"slowamount",1)||0.25, dur:dvOf(P,"slowduration",1)||2}]}, tgt, t, 0);
        simNotes.add(`${u.name}: Unseen Threat — ready at the start (assumed out of sight) and after Void Assault: his next attack on a champion deals bonus magic and slows 25% for 2 s`);
        return {bonus:[{v:evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, type:"magic", what:"Unseen Threat"}]}; },
      onCast(u, a, tgt, t){ const K=u.kit, evo=kitEvolved(u.c, u.st), iso=x=>!enemiesOf(u,t).some(y=>y!==x && gap(y,x) <= (dvOf(CALC.champs.Khazix.P,"isolationrange",1)||375));
        if (a.slot==="Q" && tgt){ if (!iso(tgt)) a.parts=[{v:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"spell.khazixq:basedamage").v, type:"physical", pct:false}];
          else if (evo.includes("Q")){ const t0=pressOf(a,t); u.cd.Q=Math.max(t, t0+(u.cd.Q-t0)*(1-(dvOf(a.S,"evolutionisolationcdrpercentage",a.rank)||45)/100)); }
          simNotes.add(`${u.name} Q: Taste Their Fear deals ×2.1 to an isolated target (no other enemy within 375)${evo.includes("Q")?"; evolved: −45% cooldown on an isolated target":""}`); }
        if (a.slot==="W" && tgt && evo.includes("W")){ a.ccAll ??= a.cc||[]; a.cc = iso(tgt) ? a.ccAll.map(e=>e.type==="slow" ? {...e, pct:(dvOf(a.S,"isolatedslowpercentage",a.rank)||60)/100} : e) : a.ccAll; }
        if (a.slot==="R"){ K.unseen=true; const ev=evo.includes("R"), sd=ev ? (dvOf(a.S,"evolvedstealthduration",a.rank)||2) : (dvOf(a.S,"stealthduration",a.rank)||1.25);
          kitRecast(u, a, t, ev ? (dvOf(a.S,"evolvednumberofcasts",a.rank)||3) : (dvOf(a.S,"numberofcasts",a.rank)||2), sd+(dvOf(a.S,"recastcd",a.rank)||2), sd+(dvOf(a.S,"recastwindow",a.rank)||12), false);
          addBuff(u, "khazixR", t+sd, {mspct:dvOf(a.S,"bonusmovementspeedpercent",a.rank)||0.4}, t);
          simNotes.add(`${u.name} R: Void Assault — Unseen Threat again, +40% move speed while invisible (${fmt(sd)} s; the invisibility itself isn't modelled); recast 2 s after it ends, ${ev?3:2} casts`); } },
      afterCast(u, a){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; },
      onTakedown(u, x, t){ if (!x.dummy && kitEvolved(u.c, u.st).includes("E") && (u.cd.E||0)>t){ u.cd.E=t; say(t, `  ${u.name}: Evolved Wings — Leap reset (takedown)`); } },
    },
    Shen: {
      // Ki Barrier: after an ability, a shield (47–120 +13% bonus health, 2.5 s) if ready; 11 s static cooldown from the shield, −4–8 s when
      // an ability affects an enemy or allied champion. Twilight Assault: his next 3 attacks within 8 s deal bonus magic (flat + 5–7% of
      // maximum health: the blade is assumed to pass through the target) with +50% attack speed. Spirit's Refuge: blocks attacks on Shen 1.75 s.
      init(u){ u.kit.kiAt=0; },
      dodgeAttack(u, att, t){ const B=u.kit.block; return !!(B && B.until>t); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}; K.q={n:dvOf(a.S,"numenhancedattacks",a.rank)||3, until:t+(dvOf(a.S,"attackbuffduration",a.rank)||8), flat:evalCalc(ctx,"baseflatdamage").v, pct:evalCalc(ctx,"emppercenthealth").v};
          addBuff(u, "shenQ", K.q.until, {bonusAS:(dvOf(a.S,"steroidas",a.rank)||50)/100}, t);
          simNotes.add(`${u.name} Q: Twilight Assault — his next 3 attacks within 8 s deal ${fmt(K.q.flat)} + ${fmt(K.q.pct*100)}% of the target's maximum health bonus magic (the blade assumed to pass through an enemy champion) with +50% attack speed`); }
        if (a.slot==="W"){ K.block={until:t+(dvOf(a.S,"zoneduration",a.rank)||1.75)}; simNotes.add(`${u.name} W: Spirit's Refuge — blocks attacks on Shen for 1.75 s (he's assumed to stand in it at once; allies in the zone aren't covered)`); } },
      afterCast(u, a, tgt, t){ const K=u.kit, P=CALC.champs.Shen.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        const aff = a.slot==="R" || (tgt && tgt.alive && !tgt.pet && (a.parts.length || (a.cc||[]).length) && (a.parts.length ? inReach(u,a,tgt) : hitList(u,a,tgt,t).includes(tgt)));
        if (t>=K.kiAt){ const v=evalCalc(ctx,"shieldvalue").v; shield(u, u, v, dvOf(P,"shieldduration",1)||2.5, t, "Ki Barrier"); K.kiAt=t+(dvOf(P,"shieldcooldown",1)||11); }
        else if (aff) K.kiAt=Math.max(t, K.kiAt-evalCalc(ctx,"shieldcooldownreduction").v);
        simNotes.add(`${u.name}: Ki Barrier — a shield after an ability (11 s static cooldown, −4–8 s when an ability affects a champion)`); },
      attack(u, tgt, t){ const Q=u.kit.q; if (!Q || !(Q.until>t) || Q.n<=0) return null; if (--Q.n<=0){ u.kit.q=null; const B=u.buffs.find(b=>b.id==="shenQ"); if (B) B.until=Math.min(B.until, u.nextAA); }
        return {bonus:[{v:Q.flat+Q.pct*tgt.max, type:"magic", what:"Twilight Assault"}]}; },
    },
    Ambessa: {
      onCast(u, a, tgt, t){ const K=u.kit, stack=()=>{ K.mm={n:Math.min(3,(K.mm && K.mm.until>u.kitT ? K.mm.n : 0)+1), until:u.kitT+4}; };
        u.kitT=t; stack();
        if (a.slot==="Q" && tgt){ const L=(a.later||[]).filter(p=>p.later==="recast");
          for (const p of L) kitLater(u, tgt, t+0.5, p, "Q recast (Sundering Slam)");
          if (L.length) events.push({at:t+0.5, fn:(tt)=>{ u.kitT=tt; stack(); }}); }
        simNotes.add(`${u.name}: Medarda Maxim — each ability (and the Sundering Slam recast, 0.5 s after Cunning Sweep) gives a stack (up to 3, 4 s); each attack spends one for bonus physical damage and +50% attack speed; the passive dash, energy and the 75 bonus range aren't modelled`); },
      attack(u, tgt, t){ const M=u.kit.mm; if (!M || !(M.until>t) || M.n<=0) return null; M.n--;
        aaTimer(u, t, 1/asOf(u, dvOf(CALC.champs.Ambessa.P,"attack_speed",1)||0.5));
        return {bonus:[{v:evalCalc({S:CALC.champs.Ambessa.P, rank:1, st:u.st, flags:u.flags},"calc_onhit_damage_flat").v, type:"physical", what:"Medarda Maxim"}]}; },
      // Public Execution passive: heals 15–20% (+50% life steal) of her active abilities' post-mitigation damage
      onDealt(att, tgt, v, pre, type, t, kind){ const R=att.abAll.R; if (!R || kind!=="ability" || !(v>0)) return;
        const f=evalCalc({S:R.S, rank:R.rank, st:att.st, flags:att.flags},"calc_omnivamp").v; heal(att, att, v*f*(tgt.pet||tgt.minion?0.25:1), t, null, true); },
    },
    // (Death Lotus daggers: separate hits with on-hit effects, handled generically in cast() from S.onHit)
    /* ---- champion audit batch 6 (2026-09-24) ---- */
    Blitzcrank: {
      // Mana Barrier: damage that would take him below 30% health first raises a 35%-of-maximum-mana shield (10 s; 90 s cooldown).
      // Overdrive: attack speed 5 s, move speed 60–80% decaying to 10% over 2.5 s (game data MoveSpeedModMinTime; wiki 2.9 s).
      // Power Fist: his next attack within 5 s (attack reset) deals +100% AD (+25% AP), crit-affected, and knocks up 1 s.
      // Static Field passive (R learned, off cooldown): each attack adds a stack; one strikes every 1 s. The active breaks shields.
      init(u){ u.kit.mbAt=0; },
      onHurt(u, att, v, type, t){ const K=u.kit, P=CALC.champs.Blitzcrank.P; if (!u.alive || t<K.mbAt || !(u.hp-v < (dvOf(P,"healththreshold",1)||0.3)*u.max) || u.hp<=0) return;
        K.mbAt=t+(dvOf(P,"cooldown",1)||90); shield(u, u, (dvOf(P,"manapercent",1)||0.35)*u.st.mana, dvOf(P,"shieldduration",1)||10, t, "Mana Barrier");
        simNotes.add(`${u.name}: Mana Barrier — damage that would take him below 30% health first gives a shield of 35% of his maximum mana (10 s, 90 s cooldown)`); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W"){ const d=dvOf(a.S,"duration",a.rank)||5, mn=dvOf(a.S,"movespeedmodmin",a.rank)||0.1, dt=dvOf(a.S,"movespeedmodmintime",a.rank)||2.5;
          addBuff(u, "blitzW", t+d, {bonusAS:dvOf(a.S,"attackspeedmod",a.rank)||0, mspct:mn}, t); addBuff(u, "blitzWms", t+dt, {mspct:(dvOf(a.S,"movespeedmod",a.rank)||0.8)-mn}, t);
          const B=u.buffs.find(b=>b.id==="blitzWms"); if (B) B.decayFrom=t;
          simNotes.add(`${u.name} W: Overdrive — +${fmt((dvOf(a.S,"attackspeedmod",a.rank)||0)*100)}% attack speed for 5 s, move speed decaying to 10% over 2.5 s (game data; wiki 2.9 s); the 30% slow when it ends is on him (not modelled)`); }
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; K.fist={until:t+5, cc:a.ccAll, S:a.S}; a.cc=[]; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="R") for (const x of enemiesOf(u,t)) if (gap(u,x) <= 600+RAD(x) && x.shields.length){ x.shields=[]; say(t, `  ${u.name}: Static Field breaks ${x.name}'s shields`); } },
      afterCast(u, a){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t, mult){ const K=u.kit, b=[];
        if (K.fist && K.fist.until>t){ const F=K.fist; K.fist=null; const E=u.abAll.E, tot=evalCalc({S:E.S, rank:E.rank, st:u.st, flags:u.flags},"totaldamage").v;
          b.push({v:(tot-u.st.ad)*mult, type:"physical", what:"Power Fist"}); applyCC(u, {slot:"E", S:F.S, p:{}, cc:F.cc, hard:true}, tgt, t, 0);
          simNotes.add(`${u.name} E: Power Fist — his next attack within 5 s (attack reset) deals +100% AD (+25% AP), crit-affected, and knocks up 1 s`); }
        const R=u.abAll.R; if (R && !((u.cd.R||0)>t)){ const Z=(tgt.blitzZap && tgt.blitzZap.by===u) ? tgt.blitzZap : (tgt.blitzZap={by:u, n:0, busy:false}), step=u.curStep ?? null;
          Z.n++; const zap=(at)=>events.push({at, fn:(tt)=>{ if (!u.alive || !tgt.alive || Z.n<=0){ Z.busy=false; Z.n=0; return; } Z.n--;
            kitDealNow(u, tgt, tt, {v:evalCalc({S:R.S, rank:R.rank, st:u.st, flags:u.flags},"passivedamage").v, type:"magic"}, "Static Field strike", step); if (Z.n>0) zap(tt+1); else Z.busy=false; }});
          if (!Z.busy){ Z.busy=true; zap(t+(dvOf(R.S,"zapcountdown",R.rank)||1)); }
          simNotes.add(`${u.name} R: Static Field passive — while R is off cooldown each attack adds a stack; one strikes the target every 1 s for magic damage`); }
        return b.length ? {bonus:b} : null; },
    },
    Irelia: {
      // Ionian Fervor: a stack per champion hit by her abilities (6 s, attacks refresh), +10–25% attack speed each; at 4 her attacks deal
      // bonus magic. Flawless Duet and Vanguard's Edge mark the target Unsteady (5 s): Bladesurge on it consumes the mark and is ready
      // again 0.2 s later. Defiant Dance is charged the full 0.75 s (the damage reduction meanwhile isn't modelled).
      // Defiant Dance: she charges from the press (0.75 s for the maximum), then the recast's 0.25 s cast (the data's castTime + 0.05 s
      // delay are the recast's): no attacks or casts until press + 0.75 + 0.25 (batch 8 re-check: onCast runs at the landing now)
      pressCast(u, a, tgt, t){ if (a.slot!=="W") return; const d=(dvOf(a.S,"chargetimeformax",a.rank)||0.75)+((a.p && a.p.castTime)||0.25);
        u.nextAct=Math.max(u.nextAct, t+d); u.nextAA=Math.max(u.nextAA, t+d); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q" && tgt){ const M=tgt.ireliaMark; K.qReset = !!(M && M.by===u && M.until>t); if (K.qReset) tgt.ireliaMark=null; }
        if (a.slot==="W" && tgt){ const ps=a.parts; a.parts=[]; const d=dvOf(a.S,"chargetimeformax",a.rank)||0.75, step=u.curStep ?? null;
          u.nextAct=Math.max(u.nextAct, t+d); u.nextAA=Math.max(u.nextAA, t+d);
          events.push({at:t+d, fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt) || !inReach(u,a,tgt)) return; for (const p of ps) kitDealNow(u, tgt, tt, p, "W Defiant Dance (charged)", step);
            if (!tgt.pet) kitIreliaStack(u, tt); }});
          simNotes.add(`${u.name} W: Defiant Dance is charged 0.75 s (the maximum), then released; her damage reduction while charging isn't modelled`); } },
      afterCast(u, a, tgt, t){ const K=u.kit, hit = tgt && tgt.alive && !tgt.pet && a.parts.length && inReach(u,a,tgt);
        if (a.slot==="Q" && K.qReset){ K.qReset=false; u.cd.Q=Math.min(u.cd.Q, t+0.2); say(t, `  ${u.name}: Bladesurge on an Unsteady target — ready again in 0.2 s`); }
        if (hit && "QER".includes(a.slot)) kitIreliaStack(u, t);
        if (hit && (a.slot==="E" || a.slot==="R")) tgt.ireliaMark={by:u, until:t+(dvOf(a.S,"markduration",a.rank)||5)};
        simNotes.add(`${u.name}: Ionian Fervor — a stack per champion hit by her abilities (6 s, 4 max, attacks refresh): +attack speed each; at 4 her attacks deal bonus magic; Flawless Duet and Vanguard's Edge mark Unsteady: Bladesurge on the mark is ready again 0.2 s later`); },
      attack(u, tgt, t){ const F=u.kit.fervor; if (!F || !(F.until>t)) return null; F.until=t+(dvOf(CALC.champs.Irelia.P,"buffduration",1)||6); kitIreliaStack(u, t, 0);
        return F.n>=4 ? {bonus:[{v:kitIreliaOnHit(u.st).v, type:"magic", what:"Ionian Fervor"}]} : null; },
    },
    Naafiri: {
      // Packmates (2–5 by level; +2 from 1.25 s into The Call of the Pack) attack with her: one volley per attack of hers, each
      // 10–20 (+4% bonus AD) physical, ×1.3 for the next volley after each ability (up to 3 stored, 3 s). Darkin Daggers: the bleed ticks
      // every 0.5 s for 5 s; the recast (0.75 s lockout, 4 s window; game data RecastLockout, wiki 0.5 s) on the bleeding target deals the
      // rest of the bleed at once + the bonus by missing health; the cooldown starts after the recast.
      onCast(u, a, tgt, t){ const K=u.kit, P=CALC.champs.Naafiri.P;
        K.emp={n:Math.min(dvOf(P,"packmatefrenzymaxcounters",1)||3, (K.emp && K.emp.until>t ? K.emp.n : 0)+1), until:t+(dvOf(P,"packmatefrenzyduration",1)||3)};
        if (a.slot==="W"){ const d=dvOf(a.S,"duration",a.rank)||5; addBuff(u, "naafiriW", t+d, {bonusad:(dvOf(a.S,"naafiriadpercentboost",a.rank)||0.2)*u.st.ad, mspct:dvOf(a.S,"movespeedamount",a.rank)||0.3}, t);
          K.callFrom=t+1.25; K.callUntil=t+d; castStasis(u, t+(dvOf(a.S,"untargetableduration",a.rank)||1), t);
          simNotes.add(`${u.name} W: The Call of the Pack — +20% AD and move speed for 5 s, 2 more Packmates from 1.25 s, untargetable for the first 1 s`); }
        if (a.slot==="Q" && tgt){ const n=kitRecast(u, a, t, 2, dvOf(a.S,"recastlockout",a.rank)||0.75, dvOf(a.S,"recastwindow",a.rank)||4, false), B=tgt.naafBleed, step=u.curStep ?? null, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
          if (n>=2) u.cd.Q=pressOf(a,t)+a.cd;
          if (n>=2 && B && B.by===u && B.left>0 && inReach(u,a,tgt)){ a.parts=[]; const m=Math.min(1, Math.max(0, 1-(tgt.hpS ?? tgt.hp)/tgt.max)), bonus=(dvOf(a.S,"basedamagesecondcast",a.rank)||0)*(1+m)+(dvOf(a.S,"secondcastbonusadratio",a.rank)||0.4)*(1+2.5*m)*u.st.bonusad;
            const rest=B.left*B.per; B.left=0; tgt.naafBleed=null; kitDealNow(u, tgt, t, {v:rest+bonus, type:"physical"}, `Q recast: the rest of the bleed + ${fmt(m*100)}% missing health bonus`, step); }
          else if (inReach(u,a,tgt)){ const per=evalCalc(ctx,"totalbleeddamage").v/10, Bn={by:u, left:10, per}; tgt.naafBleed=Bn;
            for (let i=1;i<=10;i++) events.push({at:t+0.5*i, fn:(tt)=>{ if (tgt.naafBleed!==Bn || Bn.left<=0 || !u.alive) return; Bn.left--; kitDealNow(u, tgt, tt, {v:per, type:"physical"}, "Q bleed", step); }}); }
          simNotes.add(`${u.name} Q: Darkin Daggers — the dagger and a 5 s bleed (a tick every 0.5 s); the recast (0.75 s later at the earliest, game data RecastLockout) on the bleeding target deals the rest of the bleed at once + bonus by missing health`); } },
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Naafiri.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        const n=evalCalc(ctx,"packmatecap").v+(K.callUntil>t && t>=K.callFrom ? 2 : 0); if (!(n>0)) return null;
        let m=1; if (K.emp && K.emp.until>t && K.emp.n>0){ K.emp.n--; m=dvOf(P,"packmatefrenzydamagemult",1)||1.3; }
        simNotes.add(`${u.name}: We Are More — her Packmates (2–5 by level, +2 during The Call of the Pack) attack with each of her attacks (10–20 + 4% bonus AD each; ×1.3 after an ability, up to 3 volleys); their own attack timing and health aren't modelled`);
        return {bonus:[{v:n*evalCalc(ctx,"packmatetotaldamage").v*m, type:"physical", what:`${n} Packmates${m>1?" (empowered)":""}`}]}; },
    },
    Rakan: {
      // Fey Feathers: a shield at the start (until broken); a new one 40 − 1.5 per level s after the last (−1 s per champion hit by his
      // attacks and abilities) once it's gone. Grand Entrance: damage and knock-up 0.35 s after he lands.
      init(u){ kitRakanShield(u, 0); },
      onCast(u, a, tgt, t){ if (a.slot!=="W") return; const ps=a.parts; a.parts=[]; a.ccAll ??= a.cc||[]; a.cc=[]; const cc=a.ccAll, step=u.curStep ?? null;
        events.push({at:t+0.35, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 275+RAD(x)){ for (const p of ps) kitDealNow(u, x, tt, p, "W Grand Entrance", step); applyCC(u, {slot:"W", S:a.S, p:{}, cc, hard:true}, x, tt, 0); if (!x.pet) kitRakanHit(u, tt); } }});
        simNotes.add(`${u.name} W: Grand Entrance lands 0.35 s after the dash (wiki): damage and knock-up 1 s to enemies within 275`); },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; if (tgt && tgt.alive && !tgt.pet && a.parts.length && inReach(u,a,tgt)) kitRakanHit(u, t); },
      attack(u, tgt, t){ if (!tgt.pet) kitRakanHit(u, t); return null; },
    },
    Anivia: {
      // Flash Frost and the fully formed Glacial Storm make targets Iced (3 s): Frostbite deals double. Glacial Storm: a tick every 0.5 s
      // to enemies within its radius (200 → 400 over 1.5 s: half ticks), then ×3 and Iced; it stays until no enemy is inside, she's
      // disabled or dies (mana ignored); the cooldown starts when it ends. Rebirth: fatal damage makes her an egg (6 s, full health).
      afterCast(u, a, tgt, t){ if (a.slot==="Q" && tgt && tgt.alive && a.parts.length) for (const x of hitList(u,a,tgt,t)) x.aniviaIced={by:u, until:t+3}; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="E" && tgt){ const I=tgt.aniviaIced; if (I && I.by===u && I.until>t){ for (const p of a.parts) p.v*=2; say(t, `  ${tgt.name} is Iced: Frostbite ×2`); }
          simNotes.add(`${u.name} E: Frostbite deals double to a target Iced by Flash Frost (3 s) or the fully formed Glacial Storm`); }
        if (a.slot==="R" && tgt){ a.parts=[]; const cx=tgt.xS ?? tgt.x, per=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"totaldamagepersecond").v/2, cc=a.cc||[], step=u.curStep ?? null, cd=a.cd, S={on:true}; a.cc=[];
          K.storm=S; u.cd.R=Infinity;
          const end=(tt)=>{ S.on=false; u.cd.R=tt+cd; say(tt, `  ${u.name}: Glacial Storm ends`); };
          const tick=(k)=>events.push({at:t+0.5*k, fn:(tt)=>{ if (!S.on) return; if (!u.alive || !canCast(u,tt) || Math.abs(u.x-cx)>1000){ end(tt); return; }
            const formed=k>3, r=formed ? 400 : 200+(400-200)*(k/3); let any=false;
            for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= r+RAD(x)){ any=true; kitDealNow(u, x, tt, {v:formed ? 3*per : per/2, type:"magic"}, `R Glacial Storm${formed?" (formed)":""}`, step);
              applyCC(u, {slot:"R", S:a.S, p:{}, cc}, x, tt, 0); if (formed) x.aniviaIced={by:u, until:tt+3}; }
            if (!any && k>=3){ end(tt); return; } tick(k+1); }});
          tick(1);
          simNotes.add(`${u.name} R: Glacial Storm — a tick every 0.5 s: 3 half ticks while it forms (200 → 400 radius over 1.5 s; wiki notes), then ×3 and Iced; it stays while an enemy is inside (mana ignored); the cooldown starts when it ends`); } },
      onFatal(u, att, t){ const K=u.kit; if (K.eggUsed) return false; K.eggUsed=true; const P=CALC.champs.Anivia.P, res=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"bonusresists").v;
        u.hp=u.max; u.ccs.push({type:"egg", until:t+6, src:u, at:t}); interrupt(u,t); addBuff(u, "aniviaEgg", t+6, {bonusarmor:res, bonusmr:res}, t);
        if (K.storm) K.storm.on=false;
        say(t, `${u.name} would die: Rebirth — an egg for 6 s at full health (${res>=0?"+":""}${fmt(res)} armor and MR)`);
        simNotes.add(`${u.name}: Rebirth — fatal damage turns her into an egg for 6 s at full health, unable to act, ${fmt(res)} bonus armor and MR by level; she hatches with the egg's health (once per fight: 240 s cooldown)`); return true; },
    },
    Renekton: {
      // Fury: 5 per attack, 10 per champion hit by Q, W (+ its strikes) and each E cast (up to 30 a cast), ×1.5 below 50% health; 20 on R
      // and 5 per second during it. At 50 his next Q or W, or the E recast, consumes 50 and is empowered (empowered casts give none).
      init(u){ u.kit.fury=0; },
      attack(u, tgt, t){ kitFury(u, 5); return null; },
      onCast(u, a, tgt, t){ const K=u.kit, emp=(K.fury||0)>=50; K.emp=false;
        if (a.slot==="Q"){ K.emp=emp; if (emp) K.fury-=50; a.heal=0; }
        if (a.slot==="W"){ K.emp=emp; if (emp){ K.fury-=50; if (tgt && !tgt.pet) tgt.shields=[]; } a.ccAll ??= a.cc||[]; a.cc=emp ? a.ccAll.map(e=>e.type==="stun" ? {...e, dur:dvOf(a.S,"enragedstunduration",a.rank)||1.5} : e) : a.ccAll;
          u.nextAA=Math.max(u.nextAA, t+1/asOf(u)); }
        if (a.slot==="E"){ const n=kitRecast(u, a, t, 2, 0.5, dvOf(a.S,"dicetimer",a.rank)||4, false); K.dice=n>=2; K.emp = n>=2 && emp; if (K.emp) K.fury-=50;
          simNotes.add(`${u.name} E: Slice and Dice — the recast (Dice) within 4 s (0.5 s after the dash assumed); at 50 Fury Dice is empowered: bonus damage and −25–35% armor 4 s`); }
        if (a.slot==="R"){ a.parts=[]; const d=dvOf(a.S,"buffduration",a.rank)||15, per=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"totaldamagepersecond").v/2, step=u.curStep ?? null;
          addBuff(u, "renR", t+d, {bonushp:dvOf(a.S,"healthgain",a.rank)||700, range:25}, t); kitFury(u, dvOf(a.S,"furyoncast",a.rank)||20, true);
          for (let i=1;i<=Math.round(d*2);i++) events.push({at:t+0.5*i, fn:(tt)=>{ if (!u.alive) return; kitFury(u, (dvOf(a.S,"furypersecond",a.rank)||5)/2, true);
            for (const x of enemiesOf(u,tt)) if (gap(u,x) <= 375+RAD(x)) kitDealNow(u, x, tt, {v:per, type:"magic"}, "R Dominus", step); }});
          simNotes.add(`${u.name} R: Dominus — 15 s: +${fmt(dvOf(a.S,"healthgain",a.rank)||700)} health, +25 range, a tick every 0.5 s to enemies within 375, 20 Fury and 5 per second`); } },
      afterCast(u, a, tgt, t){ const K=u.kit, hit = tgt && tgt.alive && !tgt.pet && inReach(u,a,tgt), champs = hit ? 1 : 0;
        if (a.slot==="Q" && tgt && tgt.alive && inReach(u,a,tgt)){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, n=hitList(u,a,tgt,t).filter(x=>!x.pet).length;
          const h=Math.min(K.emp ? (dvOf(a.S,"empoweredhealcap",a.rank)||600) : (dvOf(a.S,"basichealcap",a.rank)||150), n*evalCalc(ctx, K.emp ? "empchamphealing" : "champhealing").v); if (h>0) heal(u, u, h, t, "Q Cull the Meek");
          if (!K.emp) kitFury(u, Math.min(dvOf(a.S,"furygaincap",a.rank)||30, n*(dvOf(a.S,"championfurygain",a.rank)||10))); }
        if (a.slot==="W" && hit){ const k=K.emp ? 3 : 2; for (let i=0;i<k;i++) if (tgt.alive) applyOnHit(u, tgt, t, {basic:true}); if (!K.emp) kitFury(u, 2*5+(dvOf(a.S,"bonusfuryvschamps",a.rank)||10)); }
        if (a.slot==="W" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="E" && hit){ if (K.emp) (tgt.kitShred ||= {}).renekE={until:t+(dvOf(a.S,"shredtimer",a.rank)||4), pct:(dvOf(a.S,"enragedarmorshred",a.rank)||35)/100}; else kitFury(u, champs*(dvOf(a.S,"championragegeneration",a.rank)||10)); }
        simNotes.add(`${u.name}: Reign of Anger — Fury from attacks (5) and champion hits (10), ×1.5 below 50% health; at 50 Fury his next Q or W, or the E recast, is empowered (Q heals by champions hit, up to the cap)`); },
    },
    Fiora: {
      timing:{W:"own", R:"cast"},   // backlog 25: Riposte parries from the press and times its own thrust; Grand Challenge marks from the cast end (+0.5 s by the kit)
      // Duelist's Dance: her damage (attacks and abilities) procs a Vital: 3% (+4% per 100 bonus AD) maximum health true, a 35–100 heal;
      // perfect positioning: the first hit procs one, then a new Vital every 1.75 s (its delay to become targetable). Grand Challenge: 4
      // Vitals after 0.5 s for 8 s, one per hit (no passive Vitals on that target meanwhile). Lunge: −50% of its cooldown on a hit.
      // Riposte: 0.75 s of no damage and no crowd control, the stab 0.5 s in (slow 50%, or stun 2 s if it parried an immobilizing effect).
      // Bladework: two attacks (+50–90% attack speed, 3 s: game data BuffDuration; wiki 4 s): 100% AD without crit + slow, then a crit.
      onDealt(att, tgt, v, pre, type, t, kind){ if (!(v>0) || tgt.pet || tgt.side===att.side || !["aa","ability","onhit"].includes(kind)) return;
        const R=tgt.fioraR; let ok=false;
        if (R && R.by===att && R.until>t){ if (t>=R.from && R.n>0){ R.n--; ok=true; } }
        else { const V=tgt.fioraV && tgt.fioraV.by===att ? tgt.fioraV : (tgt.fioraV={by:att, at:0}); if (t>=V.at){ V.at=t+1.75; ok=true; } }
        if (!ok) return; const P=CALC.champs.Fiora.P, ctx={S:P, rank:1, st:att.st, flags:att.flags};
        deal(att, tgt, evalCalc(ctx,"passivedamagetotal").v*tgt.max, "true", t, "proc", R && R.by===att && R.until>t ? "Grand Challenge Vital" : "Vital"); heal(att, att, evalCalc(ctx,"passivehealamount").v, t, "Vital");
        simNotes.add(`${att.name}: Duelist's Dance — a Vital on her first hit, then every 1.75 s (perfect positioning): 3% (+4% per 100 bonus AD) maximum health true and a heal; Grand Challenge: 4 Vitals after 0.5 s, one per hit`); },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="R" && tgt) tgt.fioraR={by:u, n:4, from:t+0.5, until:t+(dvOf(a.S,"markduration",a.rank)||8)};
        if (a.slot==="E"){ a.ccAll ??= a.cc||[]; a.cc=[]; K.blade={n:2, until:t+(dvOf(a.S,"buffduration",a.rank)||3), S:a.S, rank:a.rank, cc:a.ccAll};
          addBuff(u, "fioraE", K.blade.until, {bonusAS:dvOf(a.S,"aspercent",a.rank)||0.9}, t); u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="W"){ const ps=a.parts; a.parts=[]; a.ccAll ??= a.cc||[]; a.cc=[]; const cc=a.ccAll, d=dvOf(a.S,"parryduration",a.rank)||0.75, step=u.curStep ?? null, P={until:t+d, hit:false};
          K.parry=P; K.rDR={until:t+d, dr:1}; u.ccImmuneUntil=Math.max(u.ccImmuneUntil||0, t+d); u.nextAct=Math.max(u.nextAct, t+d); u.nextAA=Math.max(u.nextAA, t+d);
          if (tgt) events.push({at:t+0.5, fn:(tt)=>{ if (!u.alive || !tgt.alive || inStasis(tgt,tt) || gap(u,tgt) > (a.p && a.p.range || 900)+RAD(tgt)) return; for (const p of ps) kitDealNow(u, tgt, tt, p, "W Riposte", step);
            applyCC(u, {slot:"W", S:a.S, p:{}, cc:P.hit ? [{type:"stun", dur:dvOf(a.S,"ccduration",a.rank)||2}] : cc, hard:P.hit}, tgt, tt, 0); }});
          simNotes.add(`${u.name} W: Riposte — 0.75 s without damage or crowd control taken (she can't act), the stab 0.5 s in: slow 50% (game data; wiki 25%) 2 s, or a 2 s stun if she parried an immobilizing effect first`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && a.ccAll) a.cc=a.ccAll; if (a.slot==="W" && a.ccAll) a.cc=a.ccAll;
        if (a.slot==="Q" && tgt && tgt.alive && a.parts.length && inReach(u,a,tgt) && (u.cd.Q||0)>t){ const t0=pressOf(a,t); u.cd.Q=Math.max(t, t0+(u.cd.Q-t0)*(1-(dvOf(a.S,"cdrefundpercent",a.rank)||0.5))); } },
      attack(u, tgt, t, mult){ const B=u.kit.blade; if (!B || !(B.until>t) || B.n<=0) return null; B.n--;
        if (B.n<=0){ u.kit.blade=null; u.buffs=u.buffs.filter(b=>b.id!=="fioraE"); refresh(u, t); }
        if (B.n===1){ applyCC(u, {slot:"E", S:B.S, p:{}, cc:B.cc}, tgt, t, 0); return {replace:{v:u.st.ad*(dvOf(B.S,"attackonepercenttad",B.rank)||1), type:"physical", what:"Bladework (first, no crit)"}}; }
        return {replace:{v:u.st.ad*(dvOf(B.S,"attacktwopercenttad",B.rank)||2)*critVs(u,tgt)/2, type:"physical", what:"Bladework (crit)"}}; },
    },
    Orianna: {
      // Clockwork Windup: every attack deals 10–50 (+15% AP) bonus magic, +15% per earlier consecutive attack on the same target (2, 4 s)
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Orianna.P, W=K.wind && K.wind.tgt===tgt && K.wind.until>t ? K.wind : {n:0};
        const v=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"totaldamage").v*(1+(dvOf(P,"stackmult",1)||0.15)*W.n);
        K.wind={tgt, n:Math.min(dvOf(P,"stackcount",1)||2, W.n+1), until:t+(dvOf(P,"stackduration",1)||4)};
        simNotes.add(`${u.name}: Clockwork Windup — her attacks deal bonus magic, +15% per consecutive attack on the same target (up to 2 stacks, 4 s)`);
        return {bonus:[{v, type:"magic", what:`Clockwork Windup${W.n?` (${W.n} stack${W.n>1?"s":""})`:""}`}]}; },
    },
    Lux: {
      // Illumination: her ability hits mark enemies (6 s); her next attack or Final Spark consumes the mark for bonus magic (Final Spark
      // then marks again, assumed)
      onCast(u, a, tgt, t){ if (a.slot!=="R" || !tgt) return; for (const x of hitList(u,a,tgt,t)){ const M=x.luxMark; if (M && M.by===u && M.until>t){ x.luxMark=null;
        deal(u, x, evalCalc({S:CALC.champs.Lux.P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, "magic", t, "proc", "Illumination (Final Spark)"); } } },
      afterCast(u, a, tgt, t){ if (!tgt || !tgt.alive || !a.parts.length) return; for (const x of hitList(u,a,tgt,t)) x.luxMark={by:u, until:t+(dvOf(CALC.champs.Lux.P,"debuffduration",1)||6)};
        simNotes.add(`${u.name}: Illumination — her ability hits mark enemies for 6 s; her next attack or Final Spark consumes it for 30–200 (+35% AP) magic`); },
      attack(u, tgt, t){ const M=tgt.luxMark; if (!M || M.by!==u || !(M.until>t)) return null; tgt.luxMark=null;
        return {bonus:[{v:evalCalc({S:CALC.champs.Lux.P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, type:"magic", what:"Illumination"}]}; },
    },
    Rengar: {
      // Ferocity: +1 per basic ability cast (4 max); at 4 the next basic ability is empowered, spends it all and can be cast again at once
      // (wiki: "grant him an additional cast"). Savagery: his next attack deals the bonus and +40% attack speed for 2 attacks (empowered:
      // 50–101% attack speed for 5 s after). Thrill of the Hunt: his next attack +100% AD and −15–25 armor 4 s (the leap isn't modelled);
      // casting W or E ends it.
      init(u){ u.kit.ferocity=0; },
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="R") K.r={until:t+(dvOf(a.S,"stealthduration",a.rank)||20), shred:dvOf(a.S,"armorshred",a.rank)||25, d:dvOf(a.S,"armorshredduration",a.rank)||4};
        if (!"QWE".includes(a.slot)) return; const emp=(K.ferocity||0)>=4; K.again=null;
        if (emp){ K.ferocity=0; K.again=a.slot; say(t, `  ${u.name}: Ferocity — empowered ${a.slot}`); } else K.ferocity=Math.min(4, (K.ferocity||0)+1);
        if (a.slot!=="Q") K.r=null;
        if (a.slot==="Q"){ const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}; K.q={until:t+(dvOf(a.S,"buffduration",a.rank)||3), n:2, emp, v:evalCalc(ctx, emp ? "{d4a43abe}" : "qbonusdamage").v, as:emp ? evalCalc(ctx,"empoweredqas").v : 0};
          addBuff(u, "rengarQ", K.q.until, {bonusAS:(dvOf(a.S,"asbonus",a.rank)||40)/100}, t); u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="E" && emp){ a.ccAll ??= a.cc||[]; a.cc=[{type:"root", dur:dvOf(a.S,"ccduration",a.rank)||1.75}]; }
        if (a.slot==="W" && emp){ u.ccs=u.ccs.filter(c=>AIRBORNE.has(c.type)); u.slows=[]; } },
      afterCast(u, a, tgt, t){ const K=u.kit; if (a.slot==="E" && a.ccAll) a.cc=a.ccAll;
        if (K.again===a.slot){ K.again=null; u.cd[a.slot]=Math.min(u.cd[a.slot], t+0.25); if (a.ammo){ a.ammo.n=Math.min(a.ammo.max, a.ammo.n+1); } }
        simNotes.add(`${u.name}: Ferocity — 1 per basic ability (4 max); at 4 his next basic ability is empowered and he can cast it again (wiki: an additional cast; modelled as ready again 0.25 s later)`); },
      attack(u, tgt, t){ const K=u.kit, b=[];
        const Q=K.q; if (Q && Q.until>t && Q.n>0){ if (Q.n===2){ b.push({v:Q.v, type:"physical", what:Q.emp ? "Savagery (empowered)" : "Savagery"}); if (Q.emp) addBuff(u, "rengarQ2", t+(dvOf(u.abAll.Q.S,"asduration",u.abAll.Q.rank)||5), {bonusAS:Q.as}, t); }
          if (--Q.n<=0){ K.q=null; u.buffs=u.buffs.filter(x=>x.id!=="rengarQ"); refresh(u, t); } }
        const R=K.r; if (R && R.until>t){ K.r=null; b.push({v:u.st.ad, type:"physical", what:"Thrill of the Hunt"}); const x=tgt; events.push({at:t, fn:(tt)=>{ (x.kitShred ||= {}).rengarR={until:tt+R.d, flat:R.shred}; }});
          K.ferocity=Math.min(4, (K.ferocity||0)+1); }
        return b.length ? {bonus:b} : null; },
    },
    Vi: {
      // Denting Blows: every third hit on a target (4 s) from her attacks deals 4–8% (+3.5% per 100 bonus AD) of maximum health bonus
      // physical (300 cap on non-champions), −20% armor 4 s and +30–50% attack speed 4 s, and cuts Blast Shield's cooldown 4 s.
      // Relentless Force: her next attack within 6 s (attack reset) deals 10–90 (+110% AD +100% AP) instead (expected crit on the AD).
      // Blast Shield: her next ability hit gives a shield of 10% of her maximum health (3 s); 16–12 s cooldown.
      // The Vault Breaker charge (1.25 s) and the 0.75 s before Cease and Desist's damage aren't modelled.
      init(u){ u.kit.bsAt=0; },
      onCast(u, a, tgt, t){ if (a.slot==="E"){ u.kit.e={until:t+(dvOf(a.S,"attackbuffduration",a.rank)||6)}; u.nextAA=Math.min(u.nextAA, t); } },
      afterCast(u, a, tgt, t){ if (tgt && tgt.alive && !tgt.pet && a.parts.length && inReach(u,a,tgt)) kitViShield(u, t); },
      attack(u, tgt, t, mult){ const K=u.kit; let out=null;
        if (K.e && K.e.until>t){ K.e=null; const E=u.abAll.E; out={replace:{v:evalCalc({S:E.S, rank:E.rank, st:u.st, flags:u.flags},"totaldamagetooltip").v+u.st.ad*(mult-1), type:"physical", what:"Relentless Force"}}; if (!tgt.pet) kitViShield(u, t); }
        const W=u.abAll.W; if (W){ const D=tgt.viDent && tgt.viDent.by===u && tgt.viDent.until>t ? tgt.viDent : {by:u, n:0}; D.n++; D.until=t+(dvOf(W.S,"markerbuffduration",W.rank)||4); tgt.viDent=D;
          if (D.n>=3){ tgt.viDent=null; let v=evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"totaldamagetooltip").v*tgt.max; if (tgt.pet || tgt.minion) v=Math.min(v, dvOf(W.S,"monsterdamagecap",W.rank)||300);
            const x=tgt; events.push({at:t, fn:(tt)=>{ (x.kitShred ||= {}).viW={until:tt+(dvOf(W.S,"shareddebuffsduration",W.rank)||4), pct:(dvOf(W.S,"shredamount",W.rank)||20)/100}; }});
            addBuff(u, "viW", t+(dvOf(W.S,"sharedbuffsduration",W.rank)||4), {bonusAS:(dvOf(W.S,"attackspeed",W.rank)||50)/100}, t); K.bsAt=Math.max(0, K.bsAt-(dvOf(CALC.champs.Vi.P,"cdreductionon3hit",1)||4));
            const b={v, type:"physical", what:"Denting Blows"}; out = out ? {...out, bonus:[b]} : {bonus:[b]}; }
          simNotes.add(`${u.name}: Denting Blows — every third attack on a target (4 s) deals % maximum health bonus physical, −20% armor 4 s and +attack speed; Relentless Force replaces her next attack`); }
        return out; },
    },
    /* backlog 25 (heals now apply when the cast lands, after damage taken meanwhile, instead of at the press on full health): the
       two heals below were never on these casts (champion batch 7 has the full kits) */
    Lissandra: { onCast(u, a){ if (a.slot==="R") a.heal=0; } },   // Frozen Tomb on an enemy doesn't heal her (only the self-cast does; fight() casts it on enemies; wiki Lissandra_R)
    /* ---- champion audit batch 7 (2026-09-24) ---- */
    Zilean: {
      timing:{Q:"travel"},   // the bomb attaches when it lands (0.25 s cast + 0.45 s flight); the kit times the 3 s fuse
      // Time Bomb: attaches to the target and explodes 3 s later (FuseDuration); a second bomb on a unit that carries one detonates both at
      // once and stuns (the only stun). Rewind: −10 s on Time Bomb's and Time Warp's cooldowns. Chronoshift: a 5 s rune on the lowest ally in
      // range (himself included): fatal damage meanwhile → 3 s of stasis, then the heal (kill()); it heals nothing when cast.
      init(u){ const R=u.abAll.R; if (R){ R.dash=false; R.blink=false; } },   // the "blink" tag is the rune's revive, not a move
      onCast(u, a, tgt, t){ const step=u.curStep ?? null;
        if (a.slot==="R"){ a.heal=0; const r=(a.p && a.p.range)||900, pool=alliesOf(u).filter(x=>x===u || gap(u,x)<=r+RAD(x)), x=pool.sort((p,q)=>pct(p)-pct(q))[0]||u;
          x.zilRune={by:u, until:t+(dvOf(a.S,"rduration",a.rank)||5), dur:dvOf(a.S,"revivestateduration",a.rank)||3, v:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"rtotalheal").v};
          say(t, `  ${u.name}: Chronoshift on ${x===u?"himself":x.name} (5 s: fatal damage → 3 s of stasis, then a ${fmt(x.zilRune.v)} heal)`);
          simNotes.add(`${u.name} R: Chronoshift — a 5 s rune on the lowest ally in range (himself included); fatal damage meanwhile puts them in stasis for 3 s, then heals them (wiki Zilean_R)`); }
        if (a.slot==="W"){ const d=dvOf(a.S,"cooldownreduction",a.rank)||10; for (const s of ["Q","E"]) if ((u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-d);
          say(t, `  ${u.name}: Rewind — Time Bomb and Time Warp cooldowns −${fmt(d)} s`); }
        if (a.slot==="Q" && tgt){ a.ccAll ??= a.cc||[]; const B=tgt.zilBomb;
          if (B && B.by===u && B.live && tgt.alive){ B.live=false; tgt.zilBomb=null; a.parts=a.parts.concat(B.parts); a.cc=a.ccAll; say(t, `  ${u.name}: a second Time Bomb on ${tgt.name} — both explode and stun`); }
          else { const parts=a.parts, x0=tgt, r=(a.p && a.p.radius)||350, Bn={by:u, live:true, parts}; a.parts=[]; a.cc=[]; tgt.zilBomb=Bn;
            events.push({at:t+(dvOf(a.S,"fuseduration",a.rank)||3), fn:(tt)=>{ if (!Bn.live) return; Bn.live=false; if (x0.zilBomb===Bn) x0.zilBomb=null;
              for (const x of enemiesOf(u,tt)) if (gap(x0,x) <= r+RAD(x)) for (const p of parts) kitDealNow(u, x, tt, p, "Q Time Bomb", step); }}); }
          simNotes.add(`${u.name} Q: Time Bomb attaches when it lands and explodes 3 s later; only a second bomb on the same unit (both explode at once) stuns`); } },
      afterCast(u, a){ if (a.slot==="Q" && a.ccAll) a.cc=a.ccAll; },
    },
    Malphite: {
      // Granite Shield: 10% of his maximum health at the start, again after 8/7/6 s (by level) without taking damage; Thunderclap's passive
      // armor is tripled while it holds (KIT statsFinal, mod malphGS). Thunderclap: his next attack within 6 s (attack reset) deals the
      // bonus, and for 5 s every attack also deals the cone (the target included when inside it: wiki notes).
      init(u){ kitMalphShield(u, 0); },
      onHurt(u, att, v, type, t){ const K=u.kit, cd=evalCalc({S:CALC.champs.Malphite.P, rank:1, st:u.st, flags:u.flags},"passivecooldown").v||6; K.hurtAt=t;
        if (K.gs && u.buffs.some(b=>b.id==="malphGS") && !(shieldLeft(K.gs,t) > v+1e-6)){ u.buffs=u.buffs.filter(b=>b.id!=="malphGS"); refresh(u,t); }
        events.push({at:t+cd, fn:(tt)=>{ if (!u.alive || K.hurtAt>tt-cd+1e-6) return; if (!(K.gs && u.shields.includes(K.gs) && shieldLeft(K.gs,tt)>0.01)) kitMalphShield(u, tt); }}); },
      onCast(u, a, tgt, t){ if (a.slot!=="W") return; u.kit.w={emp:t+6, cone:t+(dvOf(a.S,"thunderclapbuffduration",a.rank)||5)}; u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} W: Thunderclap — his next attack within 6 s (attack reset) deals the bonus; for 5 s every attack also deals the cone (15–55 + 30% AP + 15% armor)`); },
      attack(u, tgt, t){ const K=u.kit, W=u.abAll.W; if (!K.w || !W) return null; const ctx={S:W.S, rank:W.rank, st:u.st, flags:u.flags}, b=[];
        if (K.w.emp>t){ K.w.emp=0; b.push({v:evalCalc(ctx,"totalbonusdamage").v, type:"physical", what:"Thunderclap"}); }
        if (K.w.cone>t) b.push({v:evalCalc(ctx,"thunderclapsplash").v, type:"physical", what:"Thunderclap cone"});
        return b.length ? {bonus:b} : null; },
    },
    Corki: {
      // Hextech Munitions: attacks deal 20% AD bonus true damage (crit-affected). Missile Barrage: every third missile is the Big One (×2).
      // Gatling Gun: a tick every 0.25 s for 4 s to enemies in front within 690; each adds a stack of −3 to −5 armor and magic resist (4, 2 s).
      // Valkyrie: the trail burns enemies in it every 0.5 s, up to 5 ticks (the target stays on the path: perfect aim).
      attack(u, tgt, t, mult){ return {bonus:[{v:(dvOf(CALC.champs.Corki.P,"attackconversion",1)||0.2)*u.st.ad*mult, type:"true", what:"Hextech Munitions"}]}; },
      onCast(u, a, tgt, t){ const K=u.kit, step=u.curStep ?? null;
        if (a.slot==="R"){ K.rn=(K.rn||0)+1; if (K.rn%3===0){ const m=dvOf(a.S,"rbigonemultiplier",a.rank)||2; a.parts=a.parts.map(p=>({...p, v:p.v*m})); say(t, `  ${u.name}: the Big One (×${fmt(m)})`); }
          simNotes.add(`${u.name} R: every third Missile Barrage is the Big One (×2 damage; game data RBigOneMultiplier)`); }
        if (a.slot==="E" && tgt){ const n=Math.round((dvOf(a.S,"sprayduration",a.rank)||4)*(dvOf(a.S,"tickspersecond",a.rank)||4)), per=a.parts.reduce((s,p)=>s+p.v,0)/n, cap=dvOf(a.S,"shredcap",a.rank)||4,
            each=-(dvOf(a.S,"shredmax",a.rank)||-20)/cap, dur=dvOf(a.S,"shredduration",a.rank)||2, reach=(a.p && (a.p.coneLength||a.p.range))||690, every=(dvOf(a.S,"sprayduration",a.rank)||4)/n; a.parts=[];
          for (let i=0;i<n;i++) events.push({at:t+every*i, fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (gap(u,x) <= reach+RAD(x)){ kitDealNow(u, x, tt, {v:per, type:"physical"}, "E Gatling Gun", step);
            const S=x.corkiE && x.corkiE.until>tt ? x.corkiE : {n:0}; S.n=Math.min(cap, S.n+1); S.until=tt+dur; x.corkiE=S; (x.kitShred ||= {}).corkiE={until:S.until, flat:S.n*each, mrFlat:S.n*each}; } }});
          simNotes.add(`${u.name} E: Gatling Gun — ${n} ticks over 4 s to enemies in front; each adds −${fmt(each)} armor and magic resist (up to ${cap} stacks, 2 s)`); }
        if (a.slot==="W" && tgt){ const n=dvOf(a.S,"maximumticks",a.rank)||5, per=a.parts.reduce((s,p)=>s+p.v,0)/n, px=tgt.xS ?? tgt.x, r=dvOf(a.S,"damageradius",a.rank)||200; a.parts=[];
          for (let i=1;i<=n;i++) events.push({at:t+0.5*i, fn:(tt)=>{ for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-px) <= r+RAD(x)) kitDealNow(u, x, tt, {v:per, type:"magic"}, "W Valkyrie", step); }});
          simNotes.add(`${u.name} W: Valkyrie — the trail burns enemies in it every 0.5 s (5 ticks at most; the target stays on the path)`); } },
    },
    Karthus: {
      // Lay Waste: ×2 when it hits only one enemy. Wall of Pain: −25% magic resist 5 s. Defile: a toggle, a tick every 0.25 s to enemies within
      // 550 while on (mana ignored; perform() switches it off after the last step). Death Defied: 7 s of zombie state (untargetable, crowd
      // control immune, casting, no moving or attacking), then he dies.
      onCast(u, a, tgt, t){ const K=u.kit, step=u.curStep ?? null;
        if (a.slot==="Q" && tgt && hitList(u,a,tgt,t).filter(x=>!x.pet).length<=1){ a.parts=a.parts.map(p=>({...p, v:p.v*2})); simNotes.add(`${u.name} Q: Lay Waste deals double when it hits only one enemy`); }
        if (a.slot==="W" && tgt) for (const x of hitList(u,a,tgt,t)) (x.kitShred ||= {}).karthusW={until:t+(dvOf(a.S,"debuffduration",a.rank)||5), mrPct:(dvOf(a.S,"magicresistshred",a.rank)||25)/100};
        if (a.slot==="E"){ a.parts=[]; if (K.defile) return; const r=(a.p && a.p.range)||550, E=a; K.defile=true; u.cd.E=Infinity;
          const tick=(k)=>events.push({at:t+0.25*k, fn:(tt)=>{ if (!u.alive || (u.script && u.si>=u.script.length)){ K.defile=false; return; }
            const per=evalCalc({S:E.S, rank:E.rank, st:u.st, flags:u.flags},"totaldps").v/4;
            for (const x of enemiesOf(u,tt)) if (gap(u,x) <= r+RAD(x)) kitDealNow(u, x, tt, {v:per, type:"magic"}, "E Defile", step); tick(k+1); }});
          tick(1); simNotes.add(`${u.name} E: Defile is toggled on: a tick every 0.25 s (a quarter of the damage per second) to enemies within ${fmt(r)} (mana ignored)`); } },
      onFatal(u, att, t){ const K=u.kit; if (K.zombie) return false; K.zombie=true; const d=dvOf(CALC.champs.Karthus.P,"passiveduration",1)||7;
        u.hp=1; u.ccs=[]; u.slows=[]; u.stasisUntil=Math.max(u.stasisUntil, t+d); u.actUntil=t+d; u.ccImmuneUntil=Math.max(u.ccImmuneUntil||0, t+d); u.nextAA=t+d;
        u.ccs.push({type:"root", until:t+d, src:u, at:t});
        events.push({at:t+d, fn:(tt)=>{ if (!u.alive) return; u.actUntil=0; u.stasisUntil=tt; u.hp=0; say(tt, `${u.name}: Death Defied ends`); kill(u, att, tt); }});
        say(t, `${u.name} would die: Death Defied — ${fmt(d)} s as a zombie (untargetable, casting)`);
        simNotes.add(`${u.name}: Death Defied — fatal damage leaves him ${fmt(d)} s untargetable and crowd control immune, casting his abilities (no moving or attacking), then he dies`); return true; },
    },
    Poppy: {
      // Iron Ambassador: an attack every 16/12/8 s (by level) throws the buckler: bonus magic; she picks it up 1 s later (perfect play):
      // a shield of 11–20% of her maximum health for 3 s. Stubborn to a Fault: KIT statsFinal (doubled below 40% health: mod poppyLow).
      // Hammer Shock: the field ruptures 1 s later for the same damage. Steadfast Presence: only an enemy dashing into it is hit (not
      // modelled: no damage or crowd control at the cast). Its "dash" tag is the enemy's dash, not hers.
      init(u){ const W=u.abAll.W; if (W){ W.dash=false; W.blink=false; } u.kit.pAt=0; },
      onHurt(u, att, v, type, t){ const th=dvOf(CALC.champs.Poppy.W,"passiveempoweredhealthpercent",1)||0.4; if (u.hp-v < th*u.max && !u.buffs.some(b=>b.id==="poppyLow")) addBuff(u, "poppyLow", 1e9, {poppyLow:1}, t); },
      onCast(u, a, tgt, t){ if (a.slot==="W"){ a.ccAll ??= a.cc||[]; a.cc=[]; }
        if (a.slot==="Q" && tgt){ const R=(a.later||[]).filter(p=>p.later==="rupture"); for (const x of hitList(u,a,tgt,t)) for (const p of R) kitLater(u, x, t+(dvOf(a.S,"delaybetweentwohits",a.rank)||1), p, "Q rupture");
          simNotes.add(`${u.name} Q: Hammer Shock's field ruptures 1 s later for the same damage (the target stays in it)`); } },
      afterCast(u, a){ if (a.slot==="W" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Poppy.P; if (t<K.pAt) return null; const ctx={S:P, rank:1, st:u.st, flags:u.flags}; K.pAt=t+(evalCalc(ctx,"actualcooldown").v||8);
        const sh=evalCalc(ctx,"shieldvalue").v; if (sh>0) events.push({at:t+1, fn:(tt)=>{ if (u.alive) shield(u, u, sh, dvOf(P,"shieldduration",1)||3, tt, "Iron Ambassador"); }});
        simNotes.add(`${u.name}: Iron Ambassador — an attack every 16/12/8 s (by level) throws the buckler for bonus magic; she picks it up 1 s later for a shield (perfect play)`);
        return {bonus:[{v:evalCalc(ctx,"totaldamage").v, type:"magic", what:"Iron Ambassador"}]}; },
    },
    Gangplank: {
      timing:{E:"cast", R:"cast"},   // the keg is placed when the cast ends; the kit times the barrage's waves
      // Trial by Fire: an attack every 15 s burns the target (true, 10 ticks over 2.5 s); a keg explosion resets it. Powder Keg: placed on the
      // target, it can be set off once down to 1 health (2 × BarrelDecayTime: 1 s at 13+); Parrrley on a target next to it (360) hits the
      // keg instead: the explosion deals the shot's damage + the bonus to champions, ignoring 40% armor, and slows. Cannon Barrage: 12 waves
      // in clusters of 3 (0.25 s apart) every 2 s from 0.5 s at the target point (radius 580), each slowing 30% 0.5 s.
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Gangplank.P; if (t<(K.tbfAt||0)) return null; K.tbfAt=t+(dvOf(P,"cooldown",1)||15);
        const tot=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, n=Math.round((dvOf(P,"dotduration",1)||2.5)/0.25);
        for (let i=1;i<=n;i++) kitLater(u, tgt, t+0.25*i, {v:tot/n, type:"true"}, "Trial by Fire");
        simNotes.add(`${u.name}: Trial by Fire — an attack every 15 s burns the target for ${fmt(tot)} true damage over 2.5 s (a keg explosion resets it)`); return null; },
      onCast(u, a, tgt, t){ const K=u.kit, step=u.curStep ?? null;
        if (a.slot==="E" && tgt){ a.parts=[]; a.ccAll ??= a.cc||[]; a.cc=[]; const dec=evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"barreldecaytime").v||1;
          K.keg={x:tgt.xS ?? tgt.x, ready:t+2*dec, until:t+(dvOf(a.S,"barrelduration",a.rank)||25), cc:a.ccAll, S:a.S, rank:a.rank};
          say(t, `  ${u.name}: a Powder Keg next to ${tgt.name} (can be set off from ${fmt(t+2*dec)}s)`); }
        if (a.slot==="Q" && tgt){ const G=K.keg; if (!(G && G.until>t && Math.abs((tgt.xS ?? tgt.x)-G.x) <= 360+RAD(tgt))) return;
          K.keg=null; const shot=a.parts.reduce((s,p)=>s+p.v,0); a.parts=[];
          const boom=(tt)=>{ if (!u.alive) return; const bonus=dvOf(G.S,"bonusdamagetochampions",G.rank)||0, pen=(dvOf(G.S,"barrelarmorpenetration",G.rank)||40)/100, o=u.st.armorpenpct;
            u.st.armorpenpct=1-(1-o)*(1-pen);
            for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-G.x) <= 360+RAD(x)){ kitDealNow(u, x, tt, {v:shot+(x.pet||x.minion ? 0 : bonus), type:"physical"}, "E Powder Keg", step); applyCC(u, {slot:"E", S:G.S, p:{}, cc:G.cc}, x, tt, 0); }
            u.st.armorpenpct=o; K.tbfAt=0; say(tt, `  ${u.name}: Parrrley sets off the Powder Keg`); };
          if (G.ready<=t) boom(t); else events.push({at:G.ready, fn:boom});
          simNotes.add(`${u.name}: Powder Keg + Parrrley — the shot hits the keg once it's down to 1 health (timed to arrive then: perfect play); the explosion deals the shot's damage + the bonus to champions, ignoring 40% armor`); }
        if (a.slot==="R" && tgt){ const per=a.parts.reduce((s,p)=>s+p.v,0), cx=tgt.xS ?? tgt.x, r=(a.p && a.p.radius)||580, d0=dvOf(a.S,"cannondelay",a.rank)||0.5, iv=dvOf(a.S,"cannoninterval",a.rank)||2, n=dvOf(a.S,"totalwavestooltip",a.rank)||12;
          a.ccAll ??= a.cc||[]; const cc=a.ccAll; a.parts=[]; a.cc=[];
          for (let k=0;k<n;k++) events.push({at:t+d0+iv*Math.floor(k/3)+0.25*(k%3), fn:(tt)=>{ for (const x of enemiesOf(u,tt)) if (Math.abs((x.xS ?? x.x)-cx) <= r+RAD(x)){ kitDealNow(u, x, tt, {v:per, type:"magic"}, "R Cannon Barrage", step); applyCC(u, {slot:"R", S:a.S, p:{}, cc}, x, tt, 0); } }});
          simNotes.add(`${u.name} R: Cannon Barrage — ${n} waves in clusters of 3 every 2 s from 0.5 s at the target point (radius ${fmt(r)}); enemies in it are hit by each (they don't walk out)`); } },
      afterCast(u, a){ if ((a.slot==="E" || a.slot==="R") && a.ccAll) a.cc=a.ccAll; },
    },
    Gnar: {
      // Mini Gnar only (Rage and Mega Gnar aren't modelled). Hyper: every third hit on a target (attacks and ability hits, 3.5 s) deals
      // bonus magic (0–40 + 6–14% of its maximum health + 100% AP); its W has no active in Mini form (not cast). Hop: +40–60% attack speed 6 s.
      init(u){ if (u.ab.W) delete u.ab.W; },
      onCast(u, a, tgt, t){ if (a.slot==="E") addBuff(u, "gnarE", t+(dvOf(a.S,"miniasduration",a.rank)||6), {bonusAS:dvOf(a.S,"minibas",a.rank)||0.6}, t); },
      afterCast(u, a, tgt, t){ if (tgt && tgt.alive && !tgt.pet && a.parts.length && inReach(u,a,tgt)) kitGnarHyper(u, tgt, t, true); },
      attack(u, tgt, t){ const b=kitGnarHyper(u, tgt, t, false); return b ? {bonus:[b]} : null; },
    },
    Braum: {
      // Concussive Blows: his attacks and Winter's Bite stack (4 s); the 4th deals 26–196 by level and stuns 1.25–1.75 s; the target is then
      // immune for 8/6/4 s, taking 40% of it from his attacks. Unbreakable: the first champion hit is blocked, then 35–55% less damage for
      // 3–4 s (1-D: everything comes from the front); the cooldown starts when it ends.
      onCast(u, a, tgt, t){ if (a.slot!=="E") return; const d=dvOf(a.S,"shieldholdduration",a.rank)||4; u.kit.rDR={until:t+d, dr:1, next:(dvOf(a.S,"shieldfacingdramount",a.rank)||55)/100};
        u.cd.E=Math.max(u.cd.E||0, t)+d; say(t, `  ${u.name}: Unbreakable for ${fmt(d)} s`);
        simNotes.add(`${u.name} E: Unbreakable — blocks the first champion hit, then ${fmt(100*u.kit.rDR.next)}% less damage for ${fmt(d)} s (all enemies are in front on the 1-D line); the cooldown starts when it ends`); },
      onHurt(u, att, v, type, t){ const R=u.kit.rDR; if (R && R.until>t && R.dr===1 && att && !att.pet && att.side!==u.side) R.dr=R.next; },
      afterCast(u, a, tgt, t){ if (a.slot==="Q" && tgt && tgt.alive && !tgt.pet && a.parts.length && inReach(u,a,tgt)) kitBraumStack(u, tgt, t, true); },
      attack(u, tgt, t){ return kitBraumStack(u, tgt, t, false); },
    },
    MonkeyKing: {
      // Stone Skin: each damaging hit on a champion adds a Strength of Stone stack (5, 5 s): +100% of the passive's armor each.
      // Crushing Blow: his next attack (attack reset) deals the bonus, then −10–30% armor 3 s. Nimbus Strike: +40–60% attack speed 5 s.
      // Cyclone: 8 ticks over 2 s to enemies within 315 (a knock-up on the first hit, once), then the second cast 1 s after the first ends.
      onCast(u, a, tgt, t){ const K=u.kit, step=u.curStep ?? null;
        if (a.slot==="Q"){ K.q={until:t+(dvOf(a.S,"buffduration",a.rank)||6)}; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="E") addBuff(u, "wukongE", t+(dvOf(a.S,"attackspeedduration",a.rank)||5), {bonusAS:dvOf(a.S,"attackspeed",a.rank)||0.6}, t);
        if (a.slot==="R"){ const parts=a.parts; a.ccAll ??= a.cc||[]; const cc=a.ccAll; a.parts=[]; a.cc=[]; const dur=dvOf(a.S,"spinduration",a.rank)||2, n=Math.round(dur/(dvOf(a.S,"secondspertick",a.rank)||0.25)), r=(a.p && (a.p.radius||a.p.range))||315, id={};
          const spin=(t0)=>{ u.nextAA=Math.max(u.nextAA, t0+dur); for (let i=1;i<=n;i++) events.push({at:t0+dur*i/n, fn:(tt)=>{ if (!u.alive) return;
            for (const x of enemiesOf(u,tt)) if (gap(u,x) <= r+RAD(x)){ for (const p of parts) kitDealNow(u, x, tt, {...p, v:p.v/n}, "R Cyclone", step); if (x.wkR!==id){ x.wkR=id; applyCC(u, {slot:"R", S:a.S, p:{}, cc, hard:true}, x, tt, 0); } } }}); };
          spin(t); events.push({at:t+dur+(dvOf(a.S,"lockouttimebetweencasts",a.rank)||1), fn:(tt)=>{ if (u.alive && enemiesOf(u,tt).some(x=>gap(u,x)<=r+RAD(x)+200)){ say(tt, `${u.name} casts R again (the second Cyclone)`); spin(tt); } }});
          simNotes.add(`${u.name} R: Cyclone — ${n} ticks over ${fmt(dur)} s to enemies within ${fmt(r)} (knock-up once per enemy), then the second cast 1 s after the first ends (perfect play)`); } },
      afterCast(u, a){ if (a.slot==="R" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t){ const K=u.kit, Q=u.abAll.Q; if (!Q || !(K.q && K.q.until>t)) return null; K.q=null; const S=Q.S, r=Q.rank, x=tgt;
        events.push({at:t, fn:(tt)=>{ (x.kitShred ||= {}).wukongQ={until:tt+(dvOf(S,"shredduration",r)||3), pct:dvOf(S,"armorshredpercent",r)||0.3}; }});
        simNotes.add(`${u.name} Q: Crushing Blow rides his next attack (attack reset), then −${fmt(100*(dvOf(S,"armorshredpercent",r)||0.3))}% armor for 3 s`);
        return {bonus:[{v:evalCalc({S, rank:r, st:u.st, flags:u.flags},"totaldamage").v, type:"physical", what:"Crushing Blow"}]}; },
      onDealt(att, tgt, v, pre, type, t){ if (tgt.pet || tgt.minion || !(v>0)) return; const K=att.kit, n=Math.min(5, (K.sos && K.sos.until>t ? K.sos.n : 0)+1);
        if (K.sos && K.sos.n===n && K.sos.until>t+4.9) return; K.sos={n, until:t+(dvOf(CALC.champs.MonkeyKing.P,"stackduration",1)||5)};
        addBuff(att, "wukongP", K.sos.until, {bonusarmor:n*evalCalc({S:CALC.champs.MonkeyKing.P, rank:1, st:att.base, flags:att.flags},"bonusarmor").v}, t); },
    },
    Xerath: {
      // Rite of the Arcane: the barrages land 0.6 s apart after the first (1.1 s after the press); each one after a champion hit is stronger
      // (+20–30 + 5% AP per stack, 3–5 stacks). He channels (no other actions) until the last one.
      onCast(u, a, tgt, t){ if (a.slot!=="R" || !tgt) return; const ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags}, n=dvOf(a.S,"numberofshots",a.rank)||6, base=evalCalc(ctx,"tooltiptotaldamage").v,
          ramp=evalCalc(ctx,"rampdamagecalc").v, maxSt=a.rank+2, every=dvOf(a.S,"cdpershot",a.rank)||0.6, step=u.curStep ?? null, r=(a.p && a.p.radius)||200;
        a.parts=[{v:base, type:"magic", pct:false}];
        for (let k=2;k<=n;k++) events.push({at:t+every*(k-1), fn:(tt)=>{ if (!u.alive) return; for (const x of enemiesOf(u,tt)) if (gap(tgt,x) <= r+RAD(x)) kitDealNow(u, x, tt, {v:base+ramp*Math.min(k-1, maxSt), type:"magic"}, "R Arcane Barrage", step); }});
        u.nextAct=Math.max(u.nextAct, t+every*(n-1)); u.nextAA=Math.max(u.nextAA, t+every*(n-1));
        simNotes.add(`${u.name} R: ${n} barrages 0.6 s apart on the target (perfect aim), +${fmt(ramp)} per Arcane Perfection stack (up to ${maxSt}); he channels until the last`); },
    },
    Draven: {
      // Spinning Axe: up to 2 axes; an axe empowers an attack, bounces and is caught 1.4 s later (perfect play), ready again (and resets
      // Blood Rush); an axe unused for 5.75 s is lost. Blood Rush: +20–40% attack speed 3 s, move speed decaying over 1.5 s.
      // Whirling Death: the axes turn back on the first champion hit and hit it again on the way back.
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ const d=dvOf(a.S,"axeduration",a.rank)||5.75; K.axes=(K.axes||[]).filter(x=>x.until>t); if (K.axes.length<2) K.axes.push({ready:t, until:t+d}); else for (const x of K.axes) x.until=Math.max(x.until, t+d); }
        if (a.slot==="W"){ addBuff(u, "dravenW", t+(dvOf(a.S,"attackspeedduration",a.rank)||3), {bonusAS:dvOf(a.S,"attackspeed",a.rank)||0.4}, t);
          addBuff(u, "dravenWms", t+(dvOf(a.S,"movespeedduration",a.rank)||1.5), {mspct:dvOf(a.S,"movespeed",a.rank)||0.7}, t); const B=u.buffs.find(b=>b.id==="dravenWms"); if (B) B.decayFrom=t; }
        if (a.slot==="R" && tgt && a.parts.length){ const parts=a.parts, x=tgt, back=Math.max(0.25, gap(u,tgt)/2000), step=u.curStep ?? null;
          events.push({at:t+back, fn:(tt)=>{ if (x.alive && !inStasis(x,tt)) for (const p of parts) kitDealNow(u, x, tt, p, "R Whirling Death (return)", step); }});
          simNotes.add(`${u.name} R: the axes turn back on the first champion hit and hit it again on the way back`); } },
      attack(u, tgt, t){ const K=u.kit, Q=u.abAll.Q; if (!K.axes || !Q) return null; K.axes=K.axes.filter(x=>x.until>t); const A=K.axes.find(x=>x.ready<=t); if (!A) return null;
        const back=t+1.4; A.ready=back; A.until=back+(dvOf(Q.S,"axeduration",Q.rank)||5.75); events.push({at:back, fn:(tt)=>{ if (u.alive && (u.cd.W||0)>tt) u.cd.W=tt; }});
        simNotes.add(`${u.name} Q: Spinning Axe — each axe empowers an attack and is caught 1.4 s later (perfect play; up to 2 axes), resetting Blood Rush`);
        return {bonus:[{v:evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"totaldamage").v, type:"physical", what:"Spinning Axe"}]}; },
    },
    Hwei: {
      // Signature of the Visionary: his damaging abilities mark (4 s); a damaging ability on a marked target consumes it: 40–285 by level
      // (+35% AP) 0.85 s later. Stirring Lights (WE): his next 3 attacks or ability hits within 9 s deal 20–60 (+15% AP) bonus magic.
      // fight() casts Devastating Fire (QQ), Stirring Lights (WE) and Grim Visage (EQ) from the three moods.
      onCast(u, a, tgt, t){ if (a.slot==="W"){ u.kit.we={n:3, until:t+9, v:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"tooltip_weonhitdamage").v}; } },
      afterCast(u, a, tgt, t){ if (!tgt || !tgt.alive || !a.parts.length || !inReach(u,a,tgt)) return; const K=u.kit, step=u.curStep ?? null;
        const W=K.we; if (W && W.until>t && W.n>0){ W.n--; kitDealNow(u, tgt, t, {v:W.v, type:"magic"}, "WE Stirring Lights", step); }
        const M=tgt.hweiMark; if (M && M.by===u && M.until>t){ tgt.hweiMark=null; kitLater(u, tgt, t+0.85, {v:evalCalc({S:CALC.champs.Hwei.P, rank:1, st:u.st, flags:u.flags},"totaldamage").v, type:"magic"}, "Signature of the Visionary"); }
        else tgt.hweiMark={by:u, until:t+(dvOf(CALC.champs.Hwei.P,"duration",1)||4)};
        simNotes.add(`${u.name}: Signature of the Visionary — an ability hit marks (4 s); the next one on the mark explodes 0.85 s later; fight() casts QQ, WE and EQ`); },
      attack(u, tgt, t){ const W=u.kit.we; if (!W || !(W.until>t) || W.n<=0) return null; W.n--; return {bonus:[{v:W.v, type:"magic", what:"WE Stirring Lights"}]}; },
    },
    /* ---- champion audit batch 8 (2026-09-24) ---- */
    Shaco: {
      // Deceive: his next attack within the stealth (2.5–3.5 s) is from behind (perfect play): attack + Deceive + Backstab, critically striking
      // for 1 + 60% × (crit damage − 1) (game data QCritDamageMod). Jack in the Box: the lone-target shot when it hits one enemy.
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="Q"){ const p=(a.later||[]).find(q=>q.later==="attack"); K.q={until:t+(dvOf(a.S,"stealthduration",a.rank)||3.5), v:p ? p.v : 0, mod:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"qcritdamagemod").v};
          simNotes.add(`${u.name} Q: Deceive — his next attack within the stealth is from behind: a critical strike for ${fmt(100*K.q.mod)}% of attack + Deceive + Backstab (perfect play)`); }
        if (a.slot==="W" && tgt && hitList(u,a,tgt,t).filter(x=>!x.pet).length<=1){ a.parts=[{v:evalCalc({S:a.S, rank:a.rank, st:u.st, flags:u.flags},"stdamage").v, type:"magic"}];
          simNotes.add(`${u.name} W: Jack in the Box deals its lone-target shot when it hits one enemy (one shot; the 0.5 s shots over 5 s aren't modelled)`); } },
      attack(u, tgt, t){ const K=u.kit, Q=K.q; if (!Q || !(Q.until>t)) return null; K.q=null;
        const back=evalCalc({S:CALC.champs.Shaco.P, rank:1, st:u.st, flags:u.flags},"basicattackdamage").v;
        return {replace:{v:(u.st.ad+Q.v+back)*Q.mod, type:"physical", what:"Deceive backstab crit"}}; },
    },
    Varus: {
      // Blighted Quiver: attacks deal the on-hit and add a Blight stack (6 s, 3 max); Q/E/R hits pop them (Q: +50% at full charge, the
      // fight() Q) and refund 13% of his basic abilities' cooldowns per stack on a champion. Active: his next Q within 5.5 s deals
      // 6–14% missing health (+50% at full charge). Hail of Arrows: Grievous Wounds 40% while in the field (4 s). Chain of Corruption:
      // 3 Blight stacks 0.65 / 1.2 / 1.75 s into the root (wiki notes).
      onCast(u, a, tgt, t){ const K=u.kit; if (a.slot==="W") K.wq={until:t+5.5}; },
      afterCast(u, a, tgt, t){ if (!tgt || !["Q","E","R"].includes(a.slot) || !a.parts.length) return; const K=u.kit, step=u.curStep ?? null, W=u.abAll.W;
        const hit=hitList(u,a,tgt,t,a.land).filter(x=>x.alive && x.side!==u.side);
        for (const x of hit){ kitVarusPop(u, x, t, a.slot==="Q" ? (W && dvOf(W.S,"varuswmaxchargehpdamage",W.rank)) || 1.5 : 1);
          if (a.slot==="Q" && W && K.wq && K.wq.until>t) kitDealNow(u, x, t, {v:evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"qempowerpercenthp").v*(dvOf(W.S,"varuswmaxchargehpdamage",W.rank)||1.5), type:"magic", pctOf:"missing"}, "W Blighted Quiver (empowered Q)", step);
          if (a.slot==="E"){ x.grievUntil=Math.max(x.grievUntil, t+(dvOf(a.S,"groundduration",a.rank)||4)); x.grievBy=Math.max(x.grievUntil>t?x.grievBy||0:0, dvOf(a.S,"grievousamount",a.rank)||0.4); }
          if (a.slot==="R" && !x.pet) for (const d of [0.65, 1.2, 1.75]) events.push({at:t+d, fn:(tt)=>{ if (x.alive && u.alive) kitVarusStack(u, x, tt); }}); }
        if (a.slot==="Q") K.wq=null;
        simNotes.add(`${u.name}: Blighted Quiver — attacks add Blight (6 s, 3 max); Q/E/R pop it for 3–5% (+1.3% per 100 AP) maximum health per stack (+50% with the fully charged Q) and refund 13% of his basic cooldowns per stack; R adds 3 stacks over the root`); },
      attack(u, tgt, t){ const W=u.abAll.W; if (!W) return null; kitVarusStack(u, tgt, t);
        return {bonus:[{v:evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"onhitdamage").v, type:"magic", what:"Blighted Quiver"}]}; },
    },
    Darius: {
      // Hemorrhage: his attacks, the Decimate blade (the handle isn't modelled: perfect spacing) and Noxian Guillotine (after its damage)
      // add a bleed stack. Noxian Guillotine: +20% per stack on the target; a kill with it within 0.15 s refreshes it (recast within 20 s).
      onCast(u, a, tgt, t){ if (a.slot!=="R" || !tgt) return; const H=tgt.dariusH, n=H && H.by===u && H.until>t ? H.n : 0;
        if (n){ const m=1+(dvOf(a.S,"rdamagepercentperhemostack",a.rank)||0.2)*n; a.parts=a.parts.map(p=>({...p, v:p.v*m})); say(t, `  ${u.name}: Noxian Guillotine +${fmt(100*(m-1))}% (${n} Hemorrhage stacks)`); }
        simNotes.add(`${u.name} R: Noxian Guillotine deals +20% per Hemorrhage stack on the target (×2 at 5); a kill with it refreshes it`); },
      afterCast(u, a, tgt, t){ if (!tgt || !(a.slot==="Q" || a.slot==="R") || !a.parts.length) return;
        for (const x of hitList(u,a,tgt,t,a.land)) if (x.alive && x.side!==u.side) kitDariusBleed(u, x, t);
        if (a.slot==="R") u.kit.rHit={x:tgt, t}; },
      onTakedown(u, x, t){ const R=u.kit.rHit; if (R && R.x===x && t-R.t<=0.15+1e-9){ u.kit.rHit=null; u.cd.R=t; say(t, `  ${u.name}: Noxian Guillotine kill — it can be cast again`); } },
      attack(u, tgt, t){ kitDariusBleed(u, tgt, t); return null; },
    },
    Fizz: {
      // Seastone Trident: passive: his attacks bleed the target (DoTDamage over 3 s, a tick every 0.5 s; a new attack restarts it); active:
      // his next attack within 4 s (attack reset) deals the bonus, then his attacks deal the on-hit for 5 s. Chum the Waters: the shark by
      // the distance to the target (Guppy / Chomper / Gigalodon: damage ×1 / 1.25 / 1.5, slow 40 / 60 / 80%).
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W"){ const p=(a.later||[]).find(q=>q.later==="attack"); K.w={until:t+(dvOf(a.S,"activeduration",a.rank)||4), v:p ? p.v : 0}; u.nextAA=Math.min(u.nextAA, t); }
        if (a.slot==="R" && tgt){ const d=gap(u,tgt), sh=kitFizzShark(d, a.S, a.rank); a.ccAll ??= a.cc||[];
          if (sh.m!==1) a.parts=a.parts.map(p=>({...p, v:p.v*sh.m})); a.cc=a.ccAll.map(e=>e.type==="slow" ? {...e, pct:sh.slow} : e);
          simNotes.add(`${u.name} R: the shark's size follows the lure's flight (the distance to the target): < 455 Guppy, 455–910 Chomper ×1.25, > 910 Gigalodon ×1.5; slow 40/60/80%`); } },
      afterCast(u, a){ if (a.slot==="R" && a.ccAll) a.cc=a.ccAll; },
      attack(u, tgt, t){ const K=u.kit, W=u.abAll.W; if (!W) return null; const ctx={S:W.S, rank:W.rank, st:u.st, flags:u.flags}, b=[];
        if (K.w && K.w.until>t){ K.w=null; b.push({v:evalCalc(ctx,"activedamage").v, type:"magic", what:"Seastone Trident"}); K.oh={until:t+(dvOf(W.S,"onhitbuffduration",W.rank)||5)}; }
        else if (K.oh && K.oh.until>t) b.push({v:evalCalc(ctx,"onhitbuffdamage").v, type:"magic", what:"Seastone Trident on-hit"});
        const tot=evalCalc(ctx,"dotdamage").v, dur=dvOf(W.S,"passivedotduration",W.rank)||3, n=Math.round(dur*(dvOf(W.S,"dottickspersecond",W.rank)||2)), id={}, x=tgt, step=u.curStep ?? null;
        x.fizzBleed=id;
        for (let i=1;i<=n;i++) events.push({at:t+dur*i/n, fn:(tt)=>{ if (x.fizzBleed!==id || !x.alive || !u.alive) return; const prev=u.curStep, b0=u.dealt; u.curStep=step;
          deal(u, x, tot/n, "magic", tt, "dot", "Seastone Trident bleed"); u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b0; }});
        simNotes.add(`${u.name} W: Seastone Trident — his attacks bleed ${fmt(tot)} magic over 3 s (a new attack restarts it); the active empowers his next attack (reset), then 5 s of on-hit damage`);
        return b.length ? {bonus:b} : null; },
    },
    Sion: {
      // Roar of the Slayer: −25% armor for 4 s on the champion hit (after the hit). Glory in Death: fatal damage → 1.5 s of stasis, then full
      // health draining 1 + level per 0.25 s, +70% of that each tick (the audit's reading of the wiki: 2–19 by level), 1.75 attack speed,
      // 100% life steal, attacks + 10% of the target's maximum health (75 max vs non-champions), no abilities; then he dies.
      afterCast(u, a, tgt, t){ if (a.slot!=="E" || !tgt || !a.parts.length) return; const S=a.S, r=a.rank;
        for (const x of hitList(u,a,tgt,t,a.land)) if (x.alive && x.side!==u.side && !x.pet && !x.minion) events.push({at:t, fn:(tt)=>{ (x.kitShred ||= {}).sionE={until:tt+(dvOf(S,"armorshredduration",r)||4), pct:(dvOf(S,"armorshred",r)||25)/100}; }});
        simNotes.add(`${u.name} E: Roar of the Slayer — −25% armor for 4 s on a champion hit (the stun and knock-back are for minions and monsters)`); },
      castable(u, a){ return u.kit.zombie ? "Glory in Death: no abilities while a zombie" : true; },
      onFatal(u, att, t){ const K=u.kit; if (K.zombie) return false; K.zombie=true; const P=CALC.champs.Sion.P, st=1.5, L=u.st.level, b=1+L;
        u.hp=u.max; u.ccs=[]; u.slows=[]; u.stasisUntil=Math.max(u.stasisUntil, t+st); u.nextAct=Math.max(u.nextAct, t+st); u.nextAA=Math.max(u.nextAA, t+st);
        addBuff(u, "sionZ", 1e9, {bonusAS:Math.max(0, (1.75-u.st.as)/(u.st.asratio||1))}, t);
        let k=0; const drain=(at)=>events.push({at, fn:(tt)=>{ if (!u.alive) return; u.hp-=b*(1+0.7*k); k++; if (u.hp<=0){ u.hp=0; say(tt, `${u.name}: Glory in Death ends`); kill(u, att, tt); return; } drain(tt+0.25); }});
        drain(t+st+0.25);
        say(t, `${u.name} would die: Glory in Death — ${fmt(st)} s of stasis, then full health that drains away`);
        simNotes.add(`${u.name}: Glory in Death — fatal damage puts him in stasis ${fmt(st)} s, then he fights on at full health that drains (${fmt(b)} per 0.25 s, +70% of that each tick), 1.75 attack speed, 100% life steal, attacks + 10% of the target's maximum health, no abilities (Death Surge not modelled)`); return true; },
      attack(u, tgt, t, mult){ if (!u.kit.zombie) return null; const P=CALC.champs.Sion.P; let v=(dvOf(P,"percentmaxhp",1)||0.1)*tgt.max; if (tgt.pet || tgt.minion) v=Math.min(v, dvOf(P,"nonchampcap",1)||75);
        heal(u, u, (dvOf(P,"lifesteal",1)||1)*kitPostMit(u, tgt, u.st.ad*mult+v, "physical"), t, "Glory in Death life steal");
        return {bonus:[{v, type:"physical", what:"Glory in Death"}]}; },
    },
    Gragas: {
      // Happy Hour: an ability cast heals 5.5% of his maximum health when its cast time ends, every 12/10/8/6 s (levels 1/6/11/16; the
      // game data's level breakpoints aren't readable by the evaluator). Drunken Rage: a 0.75 s drink from the press (no attacks or casts),
      // 10–26% (+4% per 100 AP) less damage taken for 2.5 s; then his next attack within 5 s carries the damage to enemies within 250 of it.
      pressCast(u, a, tgt, t){ const K=u.kit;
        if ("QWER".includes(a.slot) && t>=(K.hhAt||0)){ const L=u.st.level, cd=L>=16?6:L>=11?8:L>=6?10:12; K.hhAt=t+cd; const ct=(a.p && a.p.castTime)||0;
          events.push({at:t+ct, fn:(tt)=>{ if (u.alive) heal(u, u, (dvOf(CALC.champs.Gragas.P,"healratio",1)||0.055)*u.max, tt, "Happy Hour"); }});
          simNotes.add(`${u.name}: Happy Hour — an ability cast heals 5.5% of his maximum health, every ${cd} s at level ${L}`); }
        if (a.slot==="W"){ const ch=(a.p && a.p.channel)||0.75, ctx={S:a.S, rank:a.rank, st:u.st, flags:u.flags};
          u.nextAct=Math.max(u.nextAct, t+ch); u.nextAA=Math.max(u.nextAA, t+ch);
          K.rDR={until:t+(dvOf(a.S,"defenseduration",a.rank)||2.5), dr:evalCalc(ctx,"damagereduction").v};
          K.w={from:t+ch, until:t+ch+(dvOf(a.S,"attackduration",a.rank)||5)};
          simNotes.add(`${u.name} W: Drunken Rage — a ${fmt(ch)} s drink (no attacks), ${fmt(100*K.rDR.dr)}% less damage for 2.5 s, then his next attack within 5 s deals the damage around its target`); } },
      attack(u, tgt, t){ const K=u.kit, W=u.abAll.W; if (!W || !(K.w && t>=K.w.from-1e-9 && K.w.until>t)) return null; K.w=null;
        const ctx={S:W.S, rank:W.rank, st:u.st, flags:u.flags}, base=evalCalc(ctx,"totaldamage").v, f=(dvOf(W.S,"maxhppercentdamage",W.rank)||7)/100, cap=dvOf(W.S,"monsterdamagecap",W.rank)||300;
        const val=x=>{ const v=base+f*x.max; return x.pet || x.minion ? Math.min(v, cap) : v; }, cx=tgt.xS ?? tgt.x, step=u.curStep ?? null;
        for (const y of enemiesOf(u,t)) if (y!==tgt && Math.abs((y.xS ?? y.x)-cx) <= 250+RAD(y)) kitDealNow(u, y, t, {v:val(y), type:"magic"}, "Drunken Rage", step);
        return {bonus:[{v:val(tgt), type:"magic", what:"Drunken Rage"}]}; },
    },
    Ashe: {
      // Frost Shot: attacks slow 20–30% 2 s and deal × st.asheFrost instead of critting. Ranger's Focus: attacks add Focus (on-attack, 4 s,
      // 4 max) while it's inactive; at 4 she can cast it: 6 s of +20–60% attack speed (attack reset), each attack a flurry (the first +20%)
      castable(u, a, tgt, t){ if (a.slot!=="Q") return true; const K=u.kit; return (K.focus && K.focus.until>t && K.focus.n>=4 && !(K.q && K.q.until>t)) ? true : "Ranger's Focus needs 4 Focus stacks (4 attacks)"; },
      step(u, step, tgt, t, log){ if (step!=="Q" || !u.abAll.Q) return false; const why=CHAMP_MECH.Ashe.castable(u, u.abAll.Q, tgt, t); if (why===true) return false; log({skipped:why}); return "logged"; },
      onAttack(u, tgt, t){ const K=u.kit; if (!u.abAll.Q || (K.q && K.q.until>t)) return; const F=K.focus && K.focus.until>t ? K.focus : {n:0}; F.n=Math.min(4, F.n+1); F.until=t+(dvOf(u.abAll.Q.S,"stackduration",u.abAll.Q.rank)||4); K.focus=F; },
      afterCast(u, a){ if (a.slot==="R" && a.ccAll) a.cc=a.ccAll; },
      onCast(u, a, tgt, t){
        if (a.slot==="R" && tgt){ a.ccAll ??= a.cc||[]; const d=gap(u,tgt), mx=dvOf(a.S,"maxstunduration",a.rank)||3.5, s=Math.min(mx, (dvOf(a.S,"minstunduration",a.rank)||1)+0.25*Math.max(0, d-800)/200);
          a.cc=a.ccAll.map(e=>e.type==="stun" ? {...e, dur:s} : e);
          simNotes.add(`${u.name} R: the stun lasts 1 s up to 800 units flown, +0.25 s per 200 beyond (3.5 s at 2800; the distance to the target at the landing)`); }
        if (a.slot!=="Q") return; const K=u.kit, d=dvOf(a.S,"buffduration",a.rank)||6, p=(a.later||[]).find(q=>q.later==="attack"); K.focus=null; K.q={until:t+d, first:true};
        addBuff(u, "asheQ", t+d, {bonusAS:(dvOf(a.S,"bonusas",a.rank)||60)/100}, t); u.nextAA=Math.min(u.nextAA, t);
        simNotes.add(`${u.name} Q: Ranger's Focus at 4 Focus stacks — ${fmt(d)} s of bonus attack speed (attack reset); each attack is a flurry for ${fmt(100*(dvOf(a.S,"damageperstrike",a.rank)||1.3))}% AD (the first one +20%: a sixth arrow)`); },
      attack(u, tgt, t){ const K=u.kit, Q=u.abAll.Q, f=u.st.asheFrost||1, P=CALC.champs.Ashe.P;
        if (!tgt.pet) applyCC(u, {slot:"P", S:P, p:{}, cc:[{type:"slow", pct:kitAsheSlow(u.c, false), dur:dvOf(P,"slowduration",1)||2}]}, tgt, t, 0);
        if (Q && K.q && K.q.until>t){ const m=K.q.first ? 1.2 : 1; K.q.first=false;
          return {replace:{v:evalCalc({S:Q.S, rank:Q.rank, st:u.st, flags:u.flags},"empowereddamage").v*f*m, type:"physical", what:`Ranger's Focus flurry${m>1?" (first: 6 arrows)":""}`}}; }
        return f!==1 ? {replace:{v:u.st.ad*f, type:"physical", what:"attack, Frost Shot crit bonus"}} : null; },
    },
  };
  // batch 6 helpers
  function kitIreliaStack(u, t, add=1){ const P=CALC.champs.Irelia.P, F=u.kit.fervor && u.kit.fervor.until>t ? u.kit.fervor : {n:0};
    F.n=Math.min(dvOf(P,"maxstacks",1)||4, F.n+add); F.until=t+(dvOf(P,"buffduration",1)||6); u.kit.fervor=F;
    let per=evalCalc({S:P, rank:1, st:u.base, flags:u.flags},"singlestackas").v; if (per>1) per/=100; addBuff(u, "ireliaP", F.until, {bonusAS:per*F.n}, t); }
  function kitRakanShield(u, t){ const P=CALC.champs.Rakan.P, ctx={S:P, rank:1, st:u.st, flags:u.flags}; shield(u, u, evalCalc(ctx,"totalshield").v, 1e6, t, "Fey Feathers");
    u.kit.fey=u.shields[u.shields.length-1]; u.kit.feyAt=t+evalCalc(ctx,"shieldcooldown").v;
    simNotes.add(`${u.name}: Fey Feathers — a shield (30–225 by level + 95% AP) at the start that lasts until broken; another one ${fmt(evalCalc(ctx,"shieldcooldown").v)} s after the last (−1 s per champion hit) once it's gone`); }
  function kitRakanHit(u, t){ const K=u.kit; K.feyAt=(K.feyAt||0)-(dvOf(CALC.champs.Rakan.P,"hitcooldown",1)||1); const F=K.fey;
    if (t>=K.feyAt && !(F && u.shields.includes(F) && shieldLeft(F,t)>0.01)) kitRakanShield(u, t); }
  function kitFury(u, v, empty){ if (!(v>0)) return; const K=u.kit; K.fury=Math.min(100, (K.fury||0)+v*(u.hp<(dvOf(CALC.champs.Renekton.P,"lowhealthpercentthreshold",1)||0.5)*u.max ? 1.5 : 1)); }
  function kitViShield(u, t){ const K=u.kit; if (t<(K.bsAt||0)) return; const P=CALC.champs.Vi.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
    shield(u, u, evalCalc(ctx,"totalshield").v, dvOf(P,"shieldduration",1)||3, t, "Blast Shield"); K.bsAt=t+evalCalc(ctx,"shieldcooldown").v;
    simNotes.add(`${u.name}: Blast Shield — her next ability hit gives a shield of 10% of her maximum health (3 s); ${fmt(evalCalc(ctx,"shieldcooldown").v)} s cooldown, −4 s per Denting Blows`); }
  // batch 7 helpers
  function kitMalphShield(u, t){ const K=u.kit, v=evalCalc({S:CALC.champs.Malphite.P, rank:1, st:u.st, flags:u.flags},"totalshield").v; shield(u, u, v, 1e6, t, "Granite Shield");
    K.gs=u.shields[u.shields.length-1]; addBuff(u, "malphGS", 1e9, {malphGS:1}, t);
    simNotes.add(`${u.name}: Granite Shield — a shield of 10% of his maximum health at the start and again after 8/7/6 s (by level) without taking damage; Thunderclap's passive armor is tripled while it holds`); }
  function kitGnarHyper(u, x, t, now){ const W=u.abAll.W; if (!W) return null; const H=x.gnarW && x.gnarW.by===u && x.gnarW.until>t ? x.gnarW : {by:u, n:0};
    H.n++; H.until=t+(dvOf(W.S,"minimarkduration",W.rank)||3.5); x.gnarW=H; if (H.n<3) return null; x.gnarW=null;
    let v=evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"minitotaldamage").v+(dvOf(W.S,"minipercenthpdamage",W.rank)||0)*x.max; if (x.pet || x.minion) v=Math.min(v, dvOf(W.S,"minimonstercap",W.rank)||300);
    simNotes.add(`${u.name}: Hyper — every third hit on a target (attacks and abilities, 3.5 s) deals bonus magic: 0–40 + 6–14% of its maximum health + 100% AP`);
    const b={v, type:"magic", what:"Hyper"}; if (now){ kitDealNow(u, x, t, b, "Hyper", u.curStep ?? null); return null; } return b; }
  function kitBraumStack(u, x, t, now){ const P=CALC.champs.Braum.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
    if (x.braumImm && x.braumImm.by===u && x.braumImm.until>t) return now ? null : {bonus:[{v:evalCalc(ctx,"onhitdamage").v, type:"magic", what:"Concussive Blows (40%)"}]};
    const B=x.braumP && x.braumP.by===u && x.braumP.until>t ? x.braumP : {by:u, n:0}; B.n++; B.until=t+(dvOf(P,"stackduration",1)||4); x.braumP=B;
    simNotes.add(`${u.name}: Concussive Blows — his attacks and Winter's Bite stack on a target (4 s); the 4th deals magic damage and stuns, then the target is immune for 8/6/4 s (by level) and his attacks deal 40% of it`);
    if (B.n<(dvOf(P,"stackcap",1)||4)) return null; x.braumP=null; x.braumImm={by:u, until:t+evalCalc(ctx,"stuncd").v};
    applyCC(u, {slot:"P", S:P, p:{}, cc:[{type:"stun", dur:evalCalc(ctx,"stunduration").v}], hard:true}, x, t, 0);
    const b={v:evalCalc(ctx,"totaldamage").v, type:"magic", what:"Concussive Blows"}; if (now){ kitDealNow(u, x, t, b, "Concussive Blows", u.curStep ?? null); return null; } return {bonus:[b]}; }
  // batch 8 helpers
  // Darius Hemorrhage: a stack on x (5 max, the 5 s refreshed); the bleed ticks every 1.25 s (a quarter of a stack's damage per stack).
  // At 5 stacks on a champion: Noxian Might, + 30–230 AD by level for 5 s, every application meanwhile goes straight to 5 (wiki)
  function kitDariusBleed(u, x, t){ if (!x.alive) return; const P=CALC.champs.Darius.P, K=u.kit, mx=dvOf(P,"maxstacks",1)||5, dur=dvOf(P,"bleedduration",1)||5, every=dur/4;
    const H=x.dariusH && x.dariusH.by===u && x.dariusH.until>t ? x.dariusH : {by:u, n:0}, nm=K.nm && K.nm.until>t;
    H.n=nm ? mx : Math.min(mx, H.n+1); H.until=t+dur; x.dariusH=H;
    if (H.n>=mx && !nm && !x.pet && !x.minion){ const ad=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"noxianmightbonusad").v; K.nm={until:t+dur}; addBuff(u, "dariusNM", t+dur, {bonusad:ad}, t);
      say(t, `  ${u.name}: Noxian Might (+${fmt(ad)} AD for ${fmt(dur)} s)`); }
    if (H.ticking) return; H.ticking=true; const step=u.curStep ?? null;
    const tick=(at)=>events.push({at, fn:(tt)=>{ if (!x.alive || x.dariusH!==H || tt>H.until+1e-6){ H.ticking=false; if (x.dariusH===H && tt>H.until+1e-6) x.dariusH=null; return; }
      const v=evalCalc({S:P, rank:1, st:u.st, flags:u.flags},"bleeddamageperstack").v*H.n/4, prev=u.curStep, b=u.dealt; u.curStep=step;
      deal(u, x, v, "physical", tt, "dot", `Hemorrhage ×${H.n}`); u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b;
      if (tt+every <= H.until+1e-6) tick(tt+every); else { H.ticking=false; if (x.dariusH===H) x.dariusH=null; } }});
    tick(t+every);
    simNotes.add(`${u.name}: Hemorrhage — his attacks, the Decimate blade and Noxian Guillotine add a bleed stack (5 s, 5 max; a tick every 1.25 s); at 5 on a champion, Noxian Might (+AD 5 s, stacks go straight to 5)`); }
  // Varus Blight: a stack on x (6 s, refreshed, 3 max)
  function kitVarusStack(u, x, t){ const W=u.abAll.W; if (!W || !x.alive) return; const B=x.varusB && x.varusB.by===u && x.varusB.until>t ? x.varusB : {by:u, n:0};
    B.n=Math.min(dvOf(W.S,"varuswmaxstacks",W.rank)||3, B.n+1); B.until=t+(dvOf(W.S,"varuswdebuffduration",W.rank)||6); x.varusB=B; }
  // Varus: an ability hit pops x's Blight: % maximum health per stack (× m), capped per stack on non-champions; −13% of each basic
  // ability's full cooldown per stack popped on a champion
  function kitVarusPop(u, x, t, m){ const W=u.abAll.W, B=x.varusB; if (!W || !B || B.by!==u || !(B.until>t) || !(B.n>0)) return; x.varusB=null;
    const per=evalCalc({S:W.S, rank:W.rank, st:u.st, flags:u.flags},"percenthpperstack").v*m; let v=B.n*per*x.max;
    if (x.pet || x.minion) v=Math.min(v, B.n*(dvOf(W.S,"maxmonsterdamage",W.rank)||120)*m);
    kitDealNow(u, x, t, {v, type:"magic"}, `Blight ×${B.n}`, u.curStep ?? null);
    if (!x.pet && !x.minion){ const f=(dvOf(W.S,"cdrperblightstack",W.rank)||0.13)*B.n; for (const s of ["Q","W","E"]){ const A=u.abAll[s]; if (A && (u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-f*abCd(u, A)); } } }
  function runScript(u, t){
    if (u.si >= u.script.length) return;
    const foes=enemiesOf(u,t); if (!foes.length) return;
    let tgt = u.target ? foes.find(x=>sameChamp(x,u.target)) : null;
    if (!tgt) tgt = foes[0];
    const step=u.script[u.si], before=u.dealt, log=(extra)=>u.stepLog.push({step, t, dmg:u.dealt-before, ...extra});
    if (step==="AA"){
      if (t < u.nextAA) return;        // wait for the attack timer
      autoAttack(u, tgt, t); log({}); u.si++; return;
    }
    if (SUMM_NAMES[step]){ const k=SUMM_NAMES[step], took=u.c.summoners||[];
      if (took.length && !took.includes(k)){ log({skipped:`${u.name} took ${took.map(summName).join(" and ")}`}); u.si++; return; }
      if (!ready(u,"sum:"+k,t)){ if (u.scriptWait) return; log({skipped:"on cooldown"}); u.si++; return; }
      if (!took.length) simNotes.add(`${u.name} is assumed to have ${summName(k)} (set .summoners = {…} to restrict)`);
      useSummoner(u,k,tgt,t); log({}); u.si++; return; }
    if (ACTIVE_NAME[step]){ const k=ACTIVE_NAME[step];
      if (!has(u,k)){ log({skipped:`${step} is not in the build`}); u.si++; return; }
      if (!ready(u,"active:"+k,t)){ if (u.scriptWait) return; log({skipped:"on cooldown"}); u.si++; return; }
      useActive(u,k,tgt,t,true); log({}); u.si++; return; }
    { const rm=/^([QWER]) recast$/.exec(step); if (rm){ const s=rm[1], km=CHAMP_MECH[u.c.champ];   // library combos: a recast of the ability just cast
      // kits whose recasts are casts of the same ability (Riven Q2/Q3 and Wind Slash, Ahri R2/R3): play it as that step, keep the label
      if (km && km.recastAs && km.recastAs.includes(s)){ const n=u.stepLog.length; u.script[u.si]=s; runScript(u, t);
        if (u.stepLog.length>n) u.stepLog[n].step=step; if (u.si<u.script.length && u.script[u.si]===s && u.stepLog.length===n) u.script[u.si]=step; return; }
      const h=km && km.step ? km.step(u, s, tgt, t, log) : false; if (h){ if (h!=="logged") log({}); u.si++; return; }
      const ks=kitSpec(u.c, s), folded=!!(ks && ks.opts && ks.opts.recast) || (u.c.champ==="Gwen" && s==="R");
      if (folded) log({note:`counted in the first ${s} step`});
      else { log({note:"no damage modelled"}); simNotes.add(`${u.name} ${s} recast: the engine has no model of this recast (it deals no damage in the combo; any reposition is ignored)`); }
      u.si++; return; } }
    { const km=CHAMP_MECH[u.c.champ], h=km && km.step ? km.step(u, step, tgt, t, log) : false; if (h==="wait") return; if (h){ if (h!=="logged") log({}); u.si++; return; } }   // champion kits: recasts, gates ("wait": the step waits, like a cooldown)
    const a=u.abAll[step];
    if (!a){ log({skipped: step==="P" ? "this passive has no damage formula in the game data" : "not learned or no data"}); u.si++; return; }
    if (a.passiveOnly){ log({skipped:"passive, toggle or ammo ability (cooldown 0 in the data)"}); u.si++; return; }
    if (t < (u.cd[step]||0)){ if (u.scriptWait) return; log({skipped:"on cooldown"}); u.si++; return; }
    if (!a.isPassive && enShort(u,a,t)){ if (u.scriptWait) return; log({skipped:`not enough energy (${fmt(enNow(u,t))} < ${fmt(enCost(u,a))})`}); u.si++; return; }   // energy (item 24): wait for it like a cooldown
    if (a.isPassive){
      refresh(u,t); abNums(u,a);
      const hp0=tgt.hp; for (const p of a.parts) deal(u,tgt,partDmg(p,tgt),p.type,t,"passive","passive");
      onHit(u,tgt,t,"passive"); abilityOnHit(u,tgt,t,a,hp0);
      const mech = CHAMP_MECH[u.c.champ]; if (mech && mech.onPassiveStep) mech.onPassiveStep(u, t);
      log({}); u.si++; return; }
    u.curStep = u.stepLog.length;
    const km2=CHAMP_MECH[u.c.champ], laterHit = a.later && a.later.length && km2 && km2.recastAs && km2.recastAs.includes(step);   // Riven Wind Slash: damage only on the recast
    cast(u, a, a.parts.length || a.immob || a.slows || laterHit ? tgt : null, t); log(a.spread > 0 ? {spread:a.spread} : {}); u.curStep = null; u.si++;
  }
  /* Summoner spells in fights: damage, heal and shield effects only (Flash, Ghost, Cleanse and Exhaust's slow
     don't change fight numbers here). Cooldowns from the game files with summoner haste. */
  function useSummoner(u, k, tgt, t){
    if (!ready(u,"sum:"+k,t)) return false;
    const n=summNums(k, u.st.level), nm=summName(k);
    if ((k==="ignite"||k==="exhaust") && !tgt) return false;
    if (u.runes.has("nimbuscloak")){ const p=nimbusPct(k,u.c); if (!(u.nimbus && u.nimbus.until>t && u.nimbus.pct*(u.nimbus.until-t)/2>=p)){ u.nimbus={pct:p, until:t+2}; refresh(u,t); say(t, `  ${u.name}: Nimbus Cloak +${fmt(100*p)}% move speed, decaying over 2s`); } }
    setcd(u,"sum:"+k,t,summCd(k,u.c));
    if (k==="ignite"){
      const idx = u.script ? u.stepLog.length : null, ticks=5, per=n.damage/ticks, gap=1.056;
      tgt.grievBy=Math.max(t<tgt.grievUntil?tgt.grievBy:0, n.grievous); tgt.grievUntil=Math.max(tgt.grievUntil, t+n.duration);
      say(t, `${u.name}: Ignite on ${tgt.name}: ${fmt(n.damage)} true damage over ${fmt(n.duration)}s, ${Math.round(100*n.grievous)}% grievous wounds`);
      for (let i=0;i<ticks;i++) events.push({at:t+gap*i, fn:(tt)=>{ if (!tgt.alive) return; const got=deal(u,tgt,per,"true",tt,"dot","Ignite"); if (idx!=null && u.stepLog[idx]) u.stepLog[idx].dmg+=got; }});
      simNotes.add(`Ignite: ${fmt(n.damage)} true damage at level ${u.st.level} (game files: 70, +20 per level to 5, +25 per level from 6; wiki 70–525 to level 20) in 5 ticks, the first at the cast and then every 1.056s (wiki; the first tick's exact delay is an assumption), 40% grievous wounds for 5s`);
    } else if (k==="exhaust"){
      tgt.exhaust={until:t+n.duration, dr:n.damageReduction, slow:n.slow};
      say(t, `${u.name}: Exhaust on ${tgt.name}: its damage −${Math.round(100*n.damageReduction)}% for ${fmt(n.duration)}s`);
      simNotes.add(`Exhaust: the target deals ${Math.round(100*n.damageReduction)}% less damage for ${fmt(n.duration)}s (game files, wiki); its ${Math.round(100*n.slow)}% slow only matters if fight() moves units`);
    } else if (k==="heal"){
      heal(u,u,n.heal,t,"Heal",true);
      simNotes.add(`Heal: ${fmt(n.heal)} at level ${u.st.level} (game files 80–318 over levels 1–18; wiki 80–346 to level 20), not raised by heal and shield power (an assumption); grievous wounds and healing-received modifiers apply`);
    } else if (k==="barrier"){
      const a=addShield(u,n.shield,n.duration,t,{id:"barrier"}); u.shieldDone+=a; say(t, `${u.name}: Barrier shield ${fmt(a)} for ${fmt(n.duration)}s`);
      simNotes.add(`Barrier: ${fmt(n.shield)} shield for ${fmt(n.duration)}s at level ${u.st.level} (game files 100–460 over levels 1–18; wiki 100–502.35 to level 20)`);
    } else say(t, `${u.name}: ${nm} (no fight damage, heal or shield)`);
    return true;
  }
  /* Unscripted fighters with .summoners set: Ignite and Exhaust on their target as soon as they fight,
     Heal and Barrier below 30% health (like Zhonya's). */
  function summonersTick(u, t){
    exhaustAtTick(u, t);
    const took=u.c.summoners; if (!took || !took.length || u.script || u.dummy) return;
    if ((took.includes("heal")||took.includes("barrier")) && pct(u)<0.3){ for (const k of ["barrier","heal"]) if (took.includes(k) && useSummoner(u,k,null,t)) break; }
    if (u.passive || u.champCombatAt==null) return;
    const foes=enemiesOf(u,t); if (!foes.length) return;
    let tgt = u.target ? foes.find(x=>sameChamp(x,u.target)) : null; if (!tgt) tgt = foes.slice().sort((a,b)=>a.hp-b.hp)[0];
    for (const k of ["exhaust","ignite"]) if (took.includes(k) && !(k==="exhaust" && (u.c.opts||{}).exhaustAt!=null)){ const x=k==="exhaust" ? foes.slice().sort((a,b)=>(b.st.ad+b.st.ap)-(a.st.ad+a.st.ap))[0] : tgt;
      if (x && gap(u,x)<=SUMM_RANGE[k]+1e-6 && !unseen(x,t)) sumGuard(u,k,x,t); }
    simNotes.add(`${u.name} uses its summoner spells in fights: Ignite and Exhaust as soon as the target is within cast range (Exhaust 650, Ignite 600, centre to centre; Exhaust on the enemy with the most AD + AP), Heal and Barrier below 30% health`);
  }
  /* x.exhaustAt (item 24): when a champion (a fighter, or a combo's target even if it doesn't fight back) presses Exhaust:
       a number     at that time (s after the start), or as soon as an enemy is in range after it
       "arrival"    the first step an enemy is targetable within 650 (Zed: as his Death Mark dash ends); "arrival+0.25" = 0.25 s later
       "never"      not at all
     Unset: the default (on its target once it is fighting, see summonersTick). Target: the in-range enemy with the most AD + AP.
     Combo casters ignore range (as their steps do). Needs Exhaust in .summoners, or no summoners set (assumed). */
  function exhaustAtTick(u, t){
    const X=(u.c.opts||{}).exhaustAt; if (X==null || X==="never" || u.script || u.dummy) return;
    const took=u.c.summoners||[]; if (took.length && !took.includes("exhaust")) return;
    if (u.xAtUsed || !ready(u,"sum:exhaust",t)) return;
    const inR = x => x.alive && !inStasis(x,t) && !unseen(x,t) && (x.script || gap(u,x)<=SUMM_RANGE.exhaust+1e-6);
    const foes=U.filter(x=>x.side!==u.side && !x.pet && inR(x)).sort((a,b)=>(b.st.ad+b.st.ap)-(a.st.ad+a.st.ap));
    if (typeof X==="number"){ if (t<X-1e-6 || !foes.length) return; }
    else { const m=/^arrival(?:\+([0-9.]+))?$/.exec(X), d=m && m[1] ? Number(m[1]) : 0;
      if (!foes.length){ u.xArrive=null; return; } if (u.xArrive==null) u.xArrive=t; if (t<u.xArrive+d-1e-6) return; }
    if (sumGuard(u,"exhaust",foes[0],t)) u.xAtUsed=true;
    if (!took.length) simNotes.add(`${u.name} is assumed to have Exhaust (set .summoners = {…} to restrict)`);
    simNotes.add(`${u.name}: Exhaust pressed by exhaustAt = ${JSON.stringify(X)} (${fmt(t)}s, on ${foes[0].name})`); }
  /* Ignite / Exhaust pressed in pass 1 on a unit that then goes untargetable at its own cast this step (CAST_START: Zed R, …)
     can't have happened (the cast-start state covers the whole step): undone once the early group has acted (item 24). */
  const sumPending=[];
  function sumGuard(u, k, x, t){ const ev0=events.length, snap={exhaust:x.exhaust, grievBy:x.grievBy, grievUntil:x.grievUntil, cd:u.rcd["sum:"+k], nimbus:u.nimbus};
    const ok=useSummoner(u,k,x,t); if (ok && castStartSlot(x.c.champ)) sumPending.push({u, k, x, snap, ev:events.slice(ev0)}); return ok; }
  function sumUndo(t){ for (const p of sumPending.splice(0)){ if (p.x.castStasisAt!==t) continue; const {u, k, x, snap}=p;
      x.exhaust=snap.exhaust; x.grievBy=snap.grievBy; x.grievUntil=snap.grievUntil; u.rcd["sum:"+k]=snap.cd; u.nimbus=snap.nimbus; if (k==="exhaust") u.xAtUsed=false;
      for (const e of p.ev){ const i=events.indexOf(e); if (i>=0) events.splice(i,1); }
      say(t, `  ${u.name}'s ${summName(k)} on ${x.name} doesn't happen: ${x.name} is untargetable from its cast this step`); } }
  const DAMAGE_ACTIVES = ["hextechrocketbelt","hextechgunblade","profanehydra","ravenoushydra","tiamat","stridebreaker","titanichydra","actualizer"];
  // heals and shields: every unit's are cast in a first pass each tick, before anyone's damage (order-independent)
  function supportPass(u, t, cc){
    if (!cc || u.script) return false;
    for (const s of order(u)){ const a=u.ab[s]; if (!a || t<(u.cd[s]||0) || a.parts.length || a.spellShield!=null || !(a.heal||a.shield) || enShort(u,a,t)) continue; if (supportTargets(u,a,t,false)){ cast(u,a,null,t); return true; } }
    return false;
  }
  function act(u, t){
    if (locked(u,t)){ forcedAct(u,t); return; }
    if (u.script) return runScript(u, t);
    const cc = canCast(u,t), role=roleOf(u);
    // support abilities first: heals and shields that are needed now (spell shields are raised when an ability lands)
    if (supportPass(u,t,cc)) return;
    if (u.passive) return;
    const foes=enemiesOf(u,t); if (!foes.length) return;
    const tgt = pickTarget(u, foes, role, t);
    // a stacking field (Viktor W) that would stun it: walk out at the last moment that still makes it (perfect play; viktor-akali G3)
    { const Z=zones.length && canMove(u,t) ? zoneThreat(u,t) : null;
      if (Z){ const ex=zoneExit(u, Z, tgt, t); if (ex && ex.time + 0.25 + 2*dt >= Z.stunAt - t){ walk(u, ex.to, t, `walks out of ${Z.F.by.name}'s Gravity Field before its stun`); return; } } }
    for (const k of DAMAGE_ACTIVES) if (has(u,k) && ready(u,"active:"+k,t) && gap(u,tgt)<=Math.max(aaReach(u,tgt), 450) && !(k==="hextechgunblade" && unseen(tgt,t))) useActive(u,k,tgt,t);
    // peel: hard crowd control on an enemy that is diving an ally who outranges it (kite and peel roles)
    if (cc && role!=="engage"){ const th=threat(u,t);
      if (th) for (const s of order(u)){ const a=u.ab[s]; if (!a || !(role==="kite"||role==="peel" ? a.hard : a.knock) || t<(u.cd[s]||0) || a.spellShield!=null || (a.dash && role==="kite") || enShort(u,a,t)) continue;
        if (unitTargeted(a) && unseen(th,t)) continue;   // invisible: no point-and-click on it
        if (inReach(u,a,th) || a.p.delivery==="self" && gap(u,th)<=abReach(u,a,th)){ say(t, `${u.name} peels ${th.name} off ${th.victim===u?"itself":th.victim.name} with ${a.slot}`); a.peeling=true; cast(u,a,th,t); a.peeling=false; return; } } }
    // escape: a kiting unit dashes or blinks away from a shorter-ranged enemy inside its attack range
    if (cc && role==="kite" && canDash(u,t)){ const e=chaser(u,t); if (e && gap(u,e)<=aaReach(e,u)+50)
      for (const s of order(u)){ const a=u.ab[s]; if (!a || !a.dash || t<(u.cd[s]||0) || enShort(u,a,t)) continue; cast(u,a,tgt,t,{away:e}); return; } }
    { const km=CHAMP_MECH[u.c.champ]; if (km && km.act && km.act(u, tgt, t, cc, role)) return; }   // champion kits: abilities with no damage of their own (Zed W)
    // offensive abilities in reach (dashes also close the gap)
    if (cc) for (const s of order(u)){ const a=u.ab[s]; if (!a || t<(u.cd[s]||0) || a.spellShield!=null) continue;
      { const km=CHAMP_MECH[u.c.champ]; if (km && km.castable && km.castable(u,a,tgt,t)!==true) continue; }   // champion kits: Yasuo R needs airborne, Samira R 6 Style
      if (enShort(u,a,t)) continue;                                           // energy champions wait for the cost (item 24)
      if (!a.parts.length && !a.cc.length && !(a.later && a.later.length)) continue;
      if (!a.parts.length && (a.heal||a.shield) && !a.hard) continue;
      if (a.knock && role!=="engage") continue;                              // knockbacks are held for peel (role "engage" uses them at once)
      if (a.hard && role==="peel") continue;
      if (a.p && a.p.stackStun && role!=="engage" && !zoneWorth(u,a,tgt,t)) continue;   // held until the enemy commits (Viktor W; item 26)
      if (unitTargeted(a) && unseen(tgt,t)) continue;                       // invisible (Akali W): no point-and-click on it (wiki Invisibility)
      if (a.dash){ if (role==="kite" || !canDash(u,t)) continue;
        if (!a.di){ try { a.di=dashInfo(u.c, a.slot); } catch(err){ a.di={dist:0, time:0, castTime:0}; } }
        if (gap(u,tgt) <= a.di.dist + RAD(u) + RAD(tgt) + 1 || (inReach(u,a,tgt) && gap(u,tgt)<=aaReach(u,tgt))){ cast(u,a,tgt,t); return; }
        continue; }
      if (inReach(u,a,tgt)){ cast(u,a,tgt,t); return; }
    }
    { const km=CHAMP_MECH[u.c.champ]; if (km && km.actLate && km.actLate(u, tgt, t, role)) return; }   // champion kits: instead of a plain attack (Akali's ring)
    if (t>=u.nextAA && canAttack(u,t) && gap(u,tgt)<=aaReach(u,tgt)+1e-6 && !unseen(tgt,t)){ autoAttack(u,tgt,t); return; }
    moveAI(u, tgt, role, t);
  }
  /* When a fighter presses Zhonya's Hourglass / Seeker's Armguard (x.stasis; Syndra-Zed gap G5):
       "low" (default)  below 30% health
       "dash"           on the last step before an enemy Zed's Death Mark dash ends, so the mark isn't applied (wiki Zed_R)
       "pop"            on the last step before a Death Mark on it pops (the stasis covers the pop)
       "cover"          as early as a 2.5 s stasis still covers the pop (pop − 2.5 s, once the mark is on)
       a number         at that time (seconds after the fight or combo starts)
       "never"          not at all */
  function stasisNow(u, t){
    const P=(u.c.opts||{}).stasis ?? "low", nx=t+dt+1e-6;
    if (P==="never") return false;
    if (typeof P==="number") return t>=P-1e-6;
    if (P==="dash"){ const I=u.zedIncoming; return !!I && I.land<=nx; }
    if (P==="pop"){ const M=u.zedMark; return !!M && M.until<=nx; }
    if (P==="cover"){ const M=u.zedMark, k=has(u,"zhonyashourglass")?"zhonyashourglass":"seekersarmguard"; return !!M && t+idv(k,"Duration",2.5)>M.until+1e-6; }
    return pct(u)<0.3;
  }
  function itemsTick(u, t){
    const allies=alliesOf(u), inC=u.combatAt!=null;
    if (has(u,"kaenicrookern") && !u.shields.some(s=>s.id==="kaenic" && shieldLeft(s,t)>0) && t-u.lastMagicAt>=idv("kaenicrookern","OutOfCombatDuration",15)){
      const v=itemCalc(u.st,"kaenicrookern","shieldcalc"); addShield(u,v,1e9,t,{type:"magic", id:"kaenic"}); say(t, `${u.name}: Kaenic Rookern magic shield ${fmt(v)}`); }
    // defensive and support actives (also for passive targets); scripted fighters use theirs only as steps, except Zhonya's
    if (!u.script){
      for (const k of ["quicksilversash","mercurialscimitar"]) if (has(u,k) && !u.passive && ready(u,"active:"+k,t) && u.ccs.some(c=>c.until>t+0.3 && QSS_CLEANSES(c.type) && c.type!=="slow")){
        useActive(u,k,null,t,true); const gone=u.ccs.filter(c=>c.until>t && QSS_CLEANSES(c.type)).map(c=>c.type); u.ccs=u.ccs.filter(c=>!QSS_CLEANSES(c.type)); u.slows=[];
        say(t, `  ${u.name} cleanses ${[...new Set(gone)].join(", ")} (Quicksilver; airborne can't be cleansed)`); }
      if ((has(u,"zhonyashourglass")||has(u,"seekersarmguard")) && stasisNow(u,t)) useActive(u,has(u,"zhonyashourglass")?"zhonyashourglass":"seekersarmguard",null,t);
      {
        if (has(u,"redemption") && allies.some(x=>pct(x)<0.5)) useActive(u,"redemption",null,t);
        if (has(u,"mikaelsblessing") && !locked(u,t) && !ccOn(u,t,"silence")){ const cced=allies.find(x=>x!==u && x.ccs.some(c=>c.until>t+0.3 && MIKAEL_CLEANSES(c.type) && c.type!=="slow"));
          const x=cced || allies.filter(x=>x!==u).sort((a,b)=>pct(a)-pct(b))[0]; if (x && (cced || pct(x)<0.5)) useActive(u,"mikaelsblessing",x,t); }
        if (has(u,"locketoftheironsolari") && allies.some(x=>pct(x)<0.6 && incoming(x,t,1)>0)) useActive(u,"locketoftheironsolari",null,t);
        if (!u.passive && pct(u)<0.5) for (const k of ["healthpotion","refillablepotion"]) if (has(u,k) && useActive(u,k,null,t)) break;
      }
    }
    // Immolate (one per champion): every second for 3s after dealing or taking damage
    const imm=["sunfireaegis","hollowradiance","bamiscinder"].find(k=>has(u,k));
    if (imm && u.immUntil>=t){ if (u.immAt==null) u.immAt=(u.immOn??t)+1; if (t>=u.immAt-1e-9){ u.immAt=t+1; const v=itemCalc(u.st,imm,"damagepertick"); for (const f of enemiesOf(u,t)) deal(u,f,v,"magic",t,"dot",null); } }
    else u.immAt=null;
    if (has(u,"unendingdespair") && u.champCombatAt!=null){ if (u.udAt==null) u.udAt=u.champCombatAt+idv("unendingdespair","Cooldown",4);
      if (t>=u.udAt){ u.udAt=t+idv("unendingdespair","Cooldown",4); const hm=idv("unendingdespair","HealMultiplier",2.5), then=v=>{ if (v>0) heal(u,u,hm*v,t,"Unending Despair"); };
        for (const f of enemiesOf(u,t)){ const v=deal(u,f,itemCalc(u.st,"unendingdespair","draincalc"),"magic",t,"proc","Unending Despair",{then}); if (!dmgQueue) then(v); } } }
    if (has(u,"warmogsarmor") && u.st.bonushp>=idv("warmogsarmor","HealthThreshold",2000) && t-u.lastHurtAt>=idv("warmogsarmor","OOCTimerChampion",8) && u.hp<u.max && t>=(u.warmogAt||0)){
      u.warmogAt=t+idv("warmogsarmor","SecondsPerHeal",0.5); heal(u,u,idv("warmogsarmor","MaxHealthRatio",0.015)*u.max,t,null,true); }
    if (has(u,"doransring") && !(CALC.champs[u.c.champ].base.mp>0) && t>=(u.ringAt||0)){ u.ringAt=t+0.5;
      const per=idv("doransring","ManaRestorePerSecond",1)*((u.lastDmgAt??-99)>t-idv("doransring","UpgradeDuration",5)?idv("doransring","ManaRestorePerSecondUpgraded",2)/idv("doransring","ManaRestorePerSecond",1):1);
      heal(u,u,per*idv("doransring","ManaToHealthConversion",0.45)*0.5,t,null,true); }
    if (has(u,"doransshield") && u.doranUntil>t && t>=(u.doranAt||0)){ u.doranAt=t+0.5; const per=(u.ranged||u.doranArea)?0.05:0.066;   // wiki: 0.066 (0.05 ranged) regen per 1% missing health
      heal(u,u,per*100*(1-pct(u))*0.5,t,null,true); }
    if (inC && u.runes.has("secondwind") && u.taken>0) { const v=0.004*(u.max-u.hp)*dt; if (v>0){ const e=Math.min(v,u.max-u.hp); u.hp+=e; u.healDone+=e; u.healRecv+=e; } }
  }
  // before the first action: effects that are already up when the fight starts
  for (const u of U){
    { const km=CHAMP_MECH[u.c.champ]; if (km && km.init) km.init(u); }   // champion kits: fix what the generic tags get wrong
    if (has(u,"kaenicrookern")) itemsTick(u, 0);
    if (has(u,"knightsvow")){ const pool=alliesOf(u).filter(x=>x!==u); const p=u.policy&&typeof u.policy==="object" ? pool.find(x=>sameChamp(x,u.policy)) : null;
      const x=p || pool.sort((a,b)=>(b.st.ad+b.st.ap)-(a.st.ad+a.st.ap))[0]; if (x){ u.vowAlly=x; x.vowBy=u; say(0, `${u.name}: Knight's Vow on ${x.name}`); } }
  }
  // resolve the damage queued this tick (see the tick loop), then the heals it caused
  function flush(){ if (!dmgQueue) return; const q=dmgQueue; dmgQueue=null; healQueue=[];
    for (const a of q){ const v=deal(...a); if (a[7] && a[7].then) a[7].then(v); }
    const hq=healQueue; healQueue=null; for (const h of hq) heal(...h); }
  let t=0, over=false;
  for (t=0; t<=T+1e-9 && !over; t=Math.round((t+dt)*1000)/1000){
    budgetTime();
    // one tick: everyone acts on the state at the start of the tick; deaths, walking and new crowd control take effect at its end
    inTick=true; for (const u of U){ u.nx=null; if (u.alive) stepMove(u,t); }
    const simul = !U.some(u=>u.script);
    if (simul) dmgQueue=[];            // events and damage over time: also resolved together (flushed before the passes)
    // events (landings, kit timers) all see the state at the start of the tick (backlog 25: most casts now land in events, so a
    // stasis, position or health change from one side's event mustn't be seen by the other's in the same tick)
    if (simul) for (const u of U){ u.hpS=u.hp; u.xS=u.x; u.stasisS=u.stasisUntil; }
    for (let i=events.length-1;i>=0;i--) if (events[i].at<=t+1e-6){ const e=events.splice(i,1)[0]; e.fn(t); }   // tolerance: mirrored positions differ in the last bits
    if (simul) for (const u of U){ u.hpS=null; u.xS=null; u.stasisS=null; }
    for (const u of U){
      if (u.reviveAt>=0 && t>=u.reviveAt){ u.reviveAt=-1; u.hp=0.5*u.st.basehp; say(t, `${u.name} revives (Guardian Angel) at ${fmt(u.hp)} health`); }
      for (const d of u.dots){ while (u.alive && d.next<=t && d.next<=d.until+1e-9){ const m = d.rampAfter && d.next-d.start>d.rampAfter ? 1.75 : 1;
        const got=deal(d.u,u,d.dps*0.5*m,d.type||"magic",d.next,d.abilityDot?"abilitydot":"dot",null); if (d.step!=null && d.u.stepLog[d.step]) d.u.stepLog[d.step].dmg += got;
        if (d.abilityDot && /-0$/.test(d.id)){ const mech=CHAMP_MECH[d.u.c.champ]; if (mech && mech.spreadOnHit){ const b=d.u.dealt; mech.spreadOnHit(d.u,u,d,d.next); if (d.step!=null && d.u.stepLog[d.step]) d.u.stepLog[d.step].dmg += d.u.dealt-b; } }
        d.next+=0.5; } }
      u.dots=u.dots.filter(d=>d.next<=d.until+1e-9);
      u.shields=u.shields.filter(s=>s.until>=t && shieldLeft(s,t)>0.01);
    }
    flush();
    for (const u of U){ u.hpS=u.hp; u.xS=u.x; u.stasisS=u.stasisUntil; u.moveS=u.move; }   // the state everyone decides on this tick
    // pass 1: items, summoners, heals and shields (protection lands before anyone's damage this tick); pass 2: everything else
    if (simul) dmgQueue=[];
    for (const u of U){ if (!u.alive) continue; refresh(u,t); if (t<u.stasisUntil) continue; itemsTick(u,t); summonersTick(u,t); if (t>=u.nextAct && !locked(u,t)) supportPass(u,t,canCast(u,t)); }
    // pass 2 queues damage between the sides and applies it once everyone has acted (then the heals it causes), so nobody's
    // action this tick sees another's damage from the same tick. Scripted combos (perform) keep immediate damage for their step log.
    // Cast-start untargetability (item 24; CAST_START: Zed R, Pantheon E, Fizz E, Vladimir W, Master Yi Q, Kayn R): champions that
    // have one act first, all on the start-of-step state; a stasis one of them gains at its cast then counts for the whole step,
    // so the others can't target it and no damage resolving this step lands on it (nor starts or cancels its First Strike).
    // Order-independent: the early group acts together and sees none of its own new states; everyone else sees all of them.
    const act2 = u => { if (!u.alive || (t<u.stasisUntil && !(u.actUntil>t))) return; /* actUntil: acts while untargetable (Karthus's Death Defied) */ if (locked(u,t)) u.lockTime=(u.lockTime||0)+dt; if (t>=u.nextAct || locked(u,t)) act(u,t); };
    let early=false; for (const u of U) if (castStartSlot(u.c.champ)){ early=true; act2(u); }
    if (early) for (const u of U) if (u.castStasisAt===t && u.stasisS!=null) u.stasisS=u.stasisUntil;
    sumUndo(t);   // a summoner spell pressed on such a unit this step (pass 1) is taken back
    for (const u of U) if (!castStartSlot(u.c.champ)) act2(u);
    flush();
    inTick=false;
    for (const u of U){ if (u.nx!=null && u.alive && !(u.move && u.move.t0>=t)) u.x=u.nx; u.nx=null; u.hpS=null; u.xS=null; u.stasisS=null; u.moveS=undefined; }
    for (const u of U) if (u.interruptAt===t){ u.interruptAt=null; if (u.alive) doInterrupt(u,t,u.intSoft); u.intSoft=false; }
    for (const k of pendingKills.splice(0)) if (k.tgt.alive && k.tgt.hp<=0) kill(k.tgt, k.att, t);
    const aliveBy=[0,1].map(s=>U.some(x=>x.side===s && !x.pet && (x.alive || x.reviveAt>=0)));   // pets don't keep a side in the fight
    if (!aliveBy[0] || !aliveBy[1]) over=true;
    // scripted combos end once every script has finished and nothing is still burning or pending
    const scripted=U.filter(u=>u.script);
    if (scripted.length && scripted.every(u=>u.si>=u.script.length) && !events.length && U.every(u=>!u.dots.length)) over=true;
  }
  const end=Math.min(T, t);
  TR=saved;
  // pets (Daisy) are reported through their owner: their damage counts as the owner's (wiki: Daisy's damage is credited to Ivern)
  for (const p of U) if (p.pet){ const o=p.pet.owner; o.dealt+=p.dealt; o.petDealt=(o.petDealt||0)+p.dealt; o.petLine=`${p.name} dealt ${fmt(p.dealt)}, ${p.alive?`${fmt(Math.max(0,p.hp))}/${fmt(p.max)} health at the end`:p.pet.expired?"expired":`died at ${fmt(p.deathAt)}s`}`; }
  return {t:"fight", units:U.filter(x=>!x.pet), end, T, log};
}
/* Per-instance damage as the game's floating combat text would show it. The game shows whole numbers; whether it rounds or
   truncates is not documented (wiki "Health" only covers the health bar, which rounds UP; the C panel rounds AD/AP/armor/MR to
   nearest), so both are shown until practice-tool measurements settle it. Since V25.14 the dummy's "last hit" counter sums every
   instance of one hit (wiki Practice Tool, patch history). */
function floatingText(r){
  const rows=[`${r.who} → ${r.target}: ${r.hits.length} damage instances (floating text shows whole numbers; floor vs round is unverified, both shown)`,
    `   #   time  step        source                    type        exact   floor  round`];
  r.hits.forEach((h,i)=>{ const st = h.step!=null && r.steps[h.step] ? `${h.step+1}:${r.steps[h.step].step}` : "tick";
    rows.push(`${String(i+1).padStart(4)}  ${h.t.toFixed(2).padStart(5)}  ${st.padEnd(10)}  ${String(h.what).slice(0,24).padEnd(24)}  ${h.type.padEnd(8)}  ${h.v.toFixed(2).padStart(8)}  ${String(Math.floor(h.v)).padStart(6)}  ${String(Math.round(h.v)).padStart(5)}`); });
  const byStep=r.steps.map((x,i)=>x.skipped?null:`${i+1}:${x.step} ${Math.floor(x.dmg)}/${Math.round(x.dmg)}`).filter(Boolean);
  if (byStep.length) rows.push(`   per step (dummy "last hit" counter, floor/round): ${byStep.join(" · ")}`);
  const src={}; for (const h of r.hits){ const k=String(h.what).replace(/ \(×.*\)$| hit \d+\/\d+$/,""); src[k]=(src[k]||0)+h.v; }
  rows.push(`   per source (item "damage dealt" counters are after resistances): ${Object.entries(src).map(([k,v])=>`${k} ${fmt(v)}`).join(" · ")}`);
  // the dummy's health bar stops at 1, but its total damage counter doesn't (user's practice-tool reading: 2561 on a 1200-hp dummy)
  if (r.dummy){ const sum=r.hits.reduce((s,h)=>s+h.v,0), cap=r.hpMax-1; rows.push(`   dummy total damage counter: ${fmt(sum)}${sum>cap?` (more than the dummy's ${fmt(r.hpMax)} health: the counter isn't capped, the health bar stops at 1)`:""}`); }
  return rows.join("\n");
}
function fightSummary(f){
  const lines=[`fight for up to ${fmt(f.T)}s, ended at ${fmt(f.end)}s`];
  for (const u of f.units) lines.push(`  ${u.side===0?"side 1":"side 2"} · ${u.name}: ${u.alive?`${fmt(Math.max(0,u.hp))}/${fmt(u.max)} health`:`died at ${fmt(u.deathAt)}s`} · dealt ${fmt(u.dealt)} · healed ${fmt(u.healDone)}${u.shieldDone?` · shielded ${fmt(u.shieldDone)}`:""}${u.petLine?` (incl. ${u.petLine})`:""}`);
  return lines;
}
/* fights(): a sweep of fight() results, one record per fight {s: start, L: level (null = as given), r: role set 1..n,
   o: 0 = team 1 on side 1, 1 = sides swapped, w: 1 team 1 wins / 0 draw / -1 team 2 wins, end: seconds, m: alive margin}.
   share = (wins + draws/2) / fights; low/high = Wilson 95% score interval on that share (z = 1.96). */
function sweepStats(rec){
  let w=0, d=0, l=0, tDec=0, m=0; const n=rec.length;
  for (const x of rec){ if (x.w>0){ w++; tDec+=x.end; } else if (x.w<0){ l++; tDec+=x.end; } else d++; m+=x.m; }
  const share = n ? (w + d/2)/n : NaN, z=1.96;
  let low=NaN, high=NaN;
  if (n){ const den=1+z*z/n, c=(share+z*z/(2*n))/den, h=z*Math.sqrt(share*(1-share)/n + z*z/(4*n*n))/den; low=Math.max(0, c-h); high=Math.min(1, c+h); }
  // side swap check: cells (start, level, role set) whose result changes when the two teams swap sides
  const byCell=new Map(); let mism=0;
  for (const x of rec){ const k=`${x.s}|${x.L}|${x.r}`, y=byCell.get(k); if (y && y.o!==x.o){ if (y.w!==x.w) mism++; byCell.delete(k); } else byCell.set(k, x); }
  return {wins:w, draws:d, losses:l, total:n, share, low, high, meanTime: w+l ? tDec/(w+l) : Infinity, margin: n ? m/n : NaN, sideMismatches:mism};
}
const pct1 = x => `${(Math.round(x*1000)/10).toFixed(1)}%`;
function sweepLine(v){
  const s=sweepStats(v.rec);
  if (!s.total) return "fights: no fights in this selection";
  return `${v.names[0]} vs ${v.names[1]}: ${s.wins}-${s.draws}-${s.losses} of ${s.total}, share ${pct1(s.share)} (95% CI ${pct1(s.low)}–${pct1(s.high)})${Number.isFinite(s.meanTime)?`, decided in ${fmt(s.meanTime)}s on average`:", none decided"}${v.both?`, ${s.sideMismatches} side-swap mismatch${s.sideMismatches===1?"":"es"}`:""}`;
}
// the per-cell grid: one row per role set × level × side order, one character per start (W / D / L for team 1)
function sweepGrid(v){
  const starts=[...new Set(v.rec.map(x=>x.s))].sort((a,b)=>a-b), rows=new Map();
  for (const x of v.rec){ const k=`${x.r}|${x.L}|${x.o}`; if (!rows.has(k)) rows.set(k, {r:x.r, L:x.L, o:x.o, cells:new Map()}); rows.get(k).cells.set(x.s, x.w>0?"W":x.w<0?"L":"D"); }
  const name = R => `${v.nroles>1?`roles ${R.r} `:""}${R.L!=null?`L${R.L} `:""}${v.both?(R.o?"swapped ":"as given "):""}`.trim() || "all";
  const w=Math.max(...[...rows.values()].map(R=>name(R).length), 5);
  const lines=[`  ${"starts".padEnd(w)}  ${starts.length>1?`${fmt(starts[0])} … ${fmt(starts[starts.length-1])} (${starts.length})`:fmt(starts[0])}`];
  for (const R of rows.values()){ const c=R.cells, ws=[...c.values()].filter(x=>x==="W").length;
    lines.push(`  ${name(R).padEnd(w)}  ${starts.map(s=>c.get(s)||" ").join("")}  ${ws}/${c.size} won`); }
  return lines;
}

function statOf(st, code, formula, flags){
  const T={0:[st.ap,0,st.ap],1:[st.armor,st.basearmor,st.bonusarmor],2:[st.ad,st.basead,st.bonusad],4:[st.as,st.baseas,st.bonusas],6:[st.mr,st.basemr,st.bonusmr],7:[st.ms,st.basems,st.bonusms],8:[st.crit,0,st.crit],9:[st.critdmg,st.basecritdmg??2,st.critdmg-(st.basecritdmg??2)],10:[st.haste,0,st.haste],12:[st.hp,st.basehp,st.bonushp],14:[st.hp,st.hp,0],29:[st.lethality,0,st.lethality],31:[st.range,st.range,0]}[code];
  const lab=(formula===2?"bonus ":formula===1?"base ":"")+(STATLABEL[code]||`stat#${code}`);
  if (!T){ flags.add(`a formula uses stat #${code}, which is not modelled (counted as 0)`); return [0,lab]; }
  return [T[formula===1?1:formula===2?2:0], lab];
}
/* Skill points: a champion at level L has L points. The ultimate takes its points at 6/11/16
   (4-rank ultimates start at rank 1 for free), basics get one point each first, then are maxed
   in skillOrder (default Q, then E, then W). Ranks set by the program are kept as given. */
const rankMemo = new Map();
const maxRankOf = (c, s) => { const m = KB.champs[c.champ].slots[s] && KB.champs[c.champ].slots[s].maxrank; return m || (s==="R" ? 3 : 5); };
function allocateRanks(c){
  const order = String((c.opts && c.opts.skillOrder) || "QEW").toUpperCase().split("").filter(x => "QWE".includes(x));
  for (const x of ["Q","E","W"]) if (!order.includes(x)) order.push(x);
  const key = champKey(c) + "|" + order.join("");
  if (rankMemo.has(key)) return rankMemo.get(key);
  const L = c.level, rMax = maxRankOf(c, "R"), fixed = c.ranks || {};
  const r = { Q:0, W:0, E:0, R:0 };
  // ultimate: 3 ranks at 6/11/16; 4 ranks start at 1 for free; 5+ ranks level like a basic (Udyr)
  let rFree = 0;
  if (fixed.R != null) r.R = fixed.R;
  else if (rMax === 4) { r.R = 1 + (L>=6) + (L>=11) + (L>=16); rFree = 1; }
  else if (rMax === 1) { r.R = 1; rFree = 1; }   // Jayce: Transform from level 1, never ranked up; his basics take all points (6 ranks each)
  else if (rMax <= 3) r.R = (L>=16?3:L>=11?2:L>=6?1:0);
  const rLevels = rMax <= 4 ? new Set([6, 11, 16].slice(0, r.R - rFree)) : new Set();
  for (const s of ["Q","W","E"]) if (fixed[s] != null) r[s] = fixed[s];
  const free = ["Q","W","E"].filter(s => fixed[s] == null);
  const pri = order.filter(s => free.includes(s));
  if (rMax > 4 && fixed.R == null) pri.push("R");
  for (let lv = 1; lv <= L; lv++){
    if (rLevels.has(lv)) continue;
    const cap = s => Math.min(maxRankOf(c, s), Math.ceil(lv / 2));
    let pick = pri.find(s => r[s] === 0 && cap(s) > 0) || pri.find(s => r[s] < cap(s));
    if (pick) r[pick]++;
  }
  const out = { ranks: r, order: order.join("") };
  if (rankMemo.size > 20000) rankMemo.clear();   // a cache: keys include items, so a long loop would otherwise keep every build
  rankMemo.set(key, out);
  return out;
}
function rankOf(c, slot){
  if (c.ranks[slot]!=null) return c.ranks[slot];
  if (slot==="P") return 1;
  const a = allocateRanks(c), r = a.ranks[slot] ?? 0;
  if (TR) TR.notes.add(`${label(c)} ranks at level ${c.level}: Q${a.ranks.Q} W${a.ranks.W} E${a.ranks.E} R${a.ranks.R} (maxing ${a.order.split("").join(" > ")}; change with ${label(c)}.skillOrder = "EQW" or ${label(c)}.Q.rank = …)`);
  return r;
}
function dvAt(ctx, name){
  const e=ctx.S.dv && ctx.S.dv[String(name).toLowerCase()];
  if (!e){ ctx.flags.add(`value “${name}” is missing from the game data (counted as 0)`); return 0; }
  const v=e[1]; if (!Array.isArray(v)) return v; return v[ctx.rank] ?? v[v.length-1];
}
const dvOf = (S, name, rank) => { const e=S.dv && S.dv[name]; if (!e) return null; const v=e[1]; return Array.isArray(v) ? (v[rank] ?? v[v.length-1]) : v; };
function evalCalc(ctx, key, depth=0){
  const ent=ctx.S.calcs && ctx.S.calcs[String(key).toLowerCase()];
  if (!ent || depth>10){ ctx.flags.add(`formula “${key}” could not be resolved (counted as 0)`); return {v:0,s:"?"}; }
  return evalGC(ctx, ent[1], depth);
}
function evalGC(ctx, g, depth){
  const t=g.__type;
  // {e9a3c91d}: a GameCalculation with a multiplier for ranged champions (items: Kraken Slayer, Titanic Hydra, Shieldbow…)
  if (t==="GameCalculation" || t==="{e9a3c91d}"){ const parts=(g.mFormulaParts||[]).map(q=>evalPart(ctx,q,depth)); let v=parts.reduce((s,q)=>s+q.v,0), s=parts.map(q=>q.s).join(" + ")||"0";
    if (g.mMultiplier){ const m=evalPart(ctx,g.mMultiplier,depth); v*=m.v; s=`(${s}) × ${m.s}`; }
    if (t==="{e9a3c91d}" && g.mRangedMultiplier && ctx.st.ranged){ const m=evalPart(ctx,g.mRangedMultiplier,depth); v*=m.v; s=`(${s}) × ${m.s} (ranged)`; }
    return {v,s}; }
  if (t==="GameCalculationModified"){ const b=evalCalc(ctx,g.mModifiedGameCalculation,depth+1), m=evalPart(ctx,g.mMultiplier,depth); return {v:b.v*m.v, s:`(${b.s}) × ${m.s}`}; }
  if (t==="GameCalculationConditional") return evalCalc(ctx,g.mDefaultGameCalculation,depth+1);
  ctx.flags.add(`unsupported formula type ${t} (counted as 0)`); return {v:0,s:"?"};
}
function evalPart(ctx, q, depth){
  const L=ctx.st.level;
  switch(q.__type){
    case "NamedDataValueCalculationPart": { const v=dvAt(ctx,q.mDataValue); return {v, s:fmt(v)}; }
    case "StatByNamedDataValueCalculationPart": { const c=dvAt(ctx,q.mDataValue); const [sv,lab]=statOf(ctx.st,q.mStat||0,q.mStatFormula||0,ctx.flags); return {v:c*sv, s:`${fmtc(c)}×${lab} ${fmt(sv)}`}; }
    case "StatByCoefficientCalculationPart": { const c=q.mCoefficient??0; const [sv,lab]=statOf(ctx.st,q.mStat||0,q.mStatFormula||0,ctx.flags); return {v:c*sv, s:`${fmtc(c)}×${lab} ${fmt(sv)}`}; }
    case "StatBySubPartCalculationPart": { const sub=evalPart(ctx,q.mSubpart,depth); const [sv,lab]=statOf(ctx.st,q.mStat||0,q.mStatFormula||0,ctx.flags); return {v:sub.v*sv, s:`(${sub.s})×${lab} ${fmt(sv)}`}; }
    case "NumberCalculationPart": return {v:q.mNumber??0, s:fmt(q.mNumber??0)};
    case "ByCharLevelInterpolationCalculationPart": { const a=q.mStartValue??0, b=q.mEndValue??0, v=a+(b-a)*(q.mScaleByStatProgressionMultiplier ? (L-1)*(0.7025+0.0175*(L-1)) : L-1)/17; return {v, s:`${fmt(v)} (level ${L})`}; }
    case "ByCharLevelBreakpointsCalculationPart": { let v=q.mLevel1Value||0, per=q.mInitialBonusPerLevel||0; const bps=(q.mBreakpoints||[]).slice().sort((x,y)=>x.mLevel-y.mLevel);
      // a breakpoint sets the per-level bonus from its level on; an omitted mBonusPerLevelAtAndAfter is the bin default 0 (the value stops
      // growing: wiki Senna Absolution "capped at level 10", Tahm Kench "5 to 60 for 12", Renata "1 to 2 for 9", Camille Q 40% → 100% at 16)
      for (let l=2;l<=L;l++){ const bp=bps.find(x=>x.mLevel===l); if(bp){ v+=bp.mAdditionalBonusAtThisLevel||0; per=bp.mBonusPerLevelAtAndAfter ?? 0; } v+=per; }
      return {v, s:`${fmt(v)} (level ${L})`}; }
    case "ByCharLevelFormulaCalculationPart": { const arr=q.values||[]; const v=arr[L] ?? arr[arr.length-1] ?? 0; return {v, s:`${fmt(v)} (level ${L})`}; }
    case "SumOfSubPartsCalculationPart": { const ps=(q.mSubparts||[]).map(x=>evalPart(ctx,x,depth)); return {v:ps.reduce((s,x)=>s+x.v,0), s:`(${ps.map(x=>x.s).join(" + ")})`}; }
    case "ProductOfSubPartsCalculationPart": { const a=evalPart(ctx,q.mPart1,depth), b=evalPart(ctx,q.mPart2,depth); return {v:a.v*b.v, s:`${a.s} × ${b.s}`}; }
    case "ClampSubPartsCalculationPart": { const ps=(q.mSubparts||[]).map(x=>evalPart(ctx,x,depth)); let v=ps.reduce((s,x)=>s+x.v,0); v=Math.min(q.mCeiling??Infinity, Math.max(q.mFloor??-Infinity, v)); return {v, s:`clamp(${ps.map(x=>x.s).join(" + ")})`}; }
    case "EffectValueCalculationPart": { const arr=(ctx.S.eff||[])[(q.mEffectIndex||1)-1]||[]; const v=arr[ctx.rank]??0; return {v, s:fmt(v)}; }
    case "{f3cbe7b2}": { const r=evalCalc(ctx,q.mSpellCalculationKey,depth+1); return {v:r.v, s:`(${r.s})`}; }
    case "BuffCounterByNamedDataValueCalculationPart": case "BuffCounterByCoefficientCalculationPart": {
      // a champion's own stacks (x.stacks, champion kits: Smolder's Dragon Practice) count; any other buff counts as 0
      const kb=ctx.st.kitBuff; if (kb && q.mBuffName===kb.buff){ const c=q.__type==="BuffCounterByCoefficientCalculationPart" ? (q.mCoefficient??0) : dvAt(ctx,q.mDataValue); return {v:c*kb.n, s:`${fmtc(c)}×${fmt(kb.n)} stacks`}; }
      ctx.flags.add("part of this formula scales with stacks; counted at 0 stacks"); return {v:0, s:"0 (stacks)"}; }
    case "AbilityResourceByCoefficientCalculationPart": { const c=q.mCoefficient??0, f=q.mStatFormula||0; const sv = f===2 ? (ctx.st.bonusmana||0) : f===1 ? (ctx.st.basemana||0) : (ctx.st.mana||0);
      return {v:c*sv, s:`${fmtc(c)}×${f===2?"bonus ":f===1?"base ":""}mana ${fmt(sv)}`}; }
    case "CooldownMultiplierCalculationPart": { const m=100/(100+(ctx.st.haste||0)); return {v:m, s:`${fmtc(m)} (haste)`}; }
    default: ctx.flags.add(`unsupported formula part ${q.__type} (counted as 0)`); return {v:0, s:"?"};
  }
}
function mitigate(v, type, A, Tst){
  if (type==="true") return {v, s:"true damage (no resist)"};
  const magic=type==="magic", R=magic?Tst.mr:Tst.armor;
  const pct=magic?A.magicpenpct:A.armorpenpct, flat=magic?A.magicpen:A.lethality+A.armorpen;
  // penetration only lowers positive resistances (wiki; the same rule as fight()'s deal()): negative armor stays as it is
  let r=R>0 ? R*(1-pct) : R; r = R>0 ? Math.max(0, r-flat) : r;
  const mult = r>=0 ? 100/(100+r) : 2-100/(100-r);
  return {v:v*mult, s:`${magic?"MR":"armor"} ${fmt(R)}${(pct||flat) && r!==R?` → ${fmt(r)} after pen`:""} → ×${mult.toFixed(3)}`};
}
function line(s){ if (TR) TR.lines.push(s); }
/* Run budget (set by run()): interpreter steps, nested calls and wall-clock time, so an endless loop, endless recursion or a
   loop of fights stops with a clear error instead of freezing the page. Fight/perform ticks and canDodge's walk check the clock. */
class BudgetError extends LangError {}
/* Memory limits (a runaway program must stop with a Rift Logic error, never exhaust the machine or the browser tab):
   listSize   values in one list, TeamComp or Combo
   maxValues  values created in one run (list/TeamComp elements, champion copies, combo steps; counted when made, so a
              list that doubles itself stops after a few rounds)
   maxResults print/assert/prove results in one run
   traceLines working lines kept under one result; maxTraceLines working lines kept in one run */
const LIMITS = {listSize:100000, maxValues:2e6, maxResults:10000, traceLines:5000, maxTraceLines:200000};
const PERFORM_MAX_STEPS = 10000;   // perform(): ~0.1 s and a few MB per 1,000 steps
let BUDGET = {steps:0, maxSteps:3e6, depth:0, maxDepth:200, t0:0, maxMs:Infinity, polls:0, values:0, maxValues:Infinity, results:0, lines:0};
const big = n => Number(n).toLocaleString("en-US");
function budgetValues(n){
  if ((BUDGET.values += n) > BUDGET.maxValues) throw new BudgetError(`program stopped after creating ${big(BUDGET.maxValues)} values (list and TeamComp elements, champion copies, combo steps) — a list growing or copying itself in an endless loop?`);
}
// n: the size the list/TeamComp/Combo would have; made: how many new values that creates (charged to the values budget)
function checkSize(n, what, ln, made){
  if (n > LIMITS.listSize) throw new LangError(`a ${what} can hold at most ${big(LIMITS.listSize)} values (this one would have ${big(n)}) — is it growing in an endless loop?`, ln);
  budgetValues(made ?? n);
}
/* the working lines under a result: capped per result and per run, so a loop of fights inside print() can't fill memory */
class TraceLines extends Array {
  static get [Symbol.species](){ return Array; }
  push(...xs){
    for (const x of xs){
      if (this.length >= LIMITS.traceLines || BUDGET.lines >= LIMITS.maxTraceLines){
        if (!this.cut){ this.cut = true; super.push(`… working cut here (at most ${big(LIMITS.traceLines)} lines per result and ${big(LIMITS.maxTraceLines)} per program)`); }
        continue; }
      BUDGET.lines++; super.push(x);
    }
    return this.length;
  }
}
const newTrace = seen => ({lines:new TraceLines(), notes:new Set(), asm:new Set(), subs:[], ...(seen ? {seenFights:seen} : {})});
function budgetTime(line){
  if (++BUDGET.polls % 256) return;
  if (Date.now()-BUDGET.t0 > BUDGET.maxMs) throw new BudgetError(`program stopped after ${fmt(BUDGET.maxMs/1000)} s (time limit) — an infinite loop, or too many fights in a loop?`, line);
}
function budgetStep(line){
  if (++BUDGET.steps > BUDGET.maxSteps) throw new BudgetError(`program stopped after ${BUDGET.maxSteps.toLocaleString("en-US")} steps — infinite loop?`, line);
  budgetTime(line);
}
// a JS stack overflow (deeply nested brackets or blocks) or a leaked internal error becomes a Rift Logic message
function friendlyMsg(err){
  if (err instanceof RangeError && /call stack/i.test(err.message)) return "the program is nested too deeply (brackets, blocks or calls inside calls) for the interpreter";
  if (err instanceof BudgetError || err instanceof LangError) return err.message;
  const m = err && err.message;
  return typeof m==="string" && m.trim() ? m : "internal error (no message)";
}
let TR = null;          // the current trace (lines + assumptions) while evaluating an expression
let WORLD = World();

/* ======== Champion kits (champion-by-champion audit, AUTOPILOT backlog 10) ========
   Own-ability mechanics the tooltip formulas don't carry: hit counts, recasts, empowered versions, passives in the
   damage, stacks. Numbers come from the game data (calc.json) and are checked against the wiki ability templates
   (data/raw/wiki_abilities/, passives in data/raw/wiki_passives/). tests/champions/<Champ>.rl has the checks.
   Champion options, set in a program:
     x.stacks = n;          the champion's own permanent stacks (Syndra: Splinters of Wrath, Smolder: Dragon Practice)
     x.evolved = {Q, E};    evolved / augmented abilities (Kai'Sa: Second Skin evolutions, Viktor: Hex Core augments)
   Reading x.stacks or x.evolved gives the value in use; when unset, the default is stated in the working.
   Ability options: x.Q.damage(snips: 3), x.R.damage(needles: 5)… (each kit ability lists its own; perfect play is the
   default and says so in the working). fight()/perform() use live state instead (stacks built, shadows up, health). */
const kitOptsOf = c => (c.opts && c.opts.stacks) || {};
function kitStacks(c){ const k=KIT[c.champ]; if (!k || !k.stacks) return 0; const v=kitOptsOf(c)["@stacks"]; return v!=null ? v : k.stacks.dflt(c); }
function kitEvolved(c, st){ const k=KIT[c.champ]; if (!k || !k.evolved) return ""; const v=kitOptsOf(c)["@evolved"]; return v!=null ? v : k.evolved.dflt(c, st || stats(c)); }
const kitSpec = (c, slot) => { const k=KIT[c.champ]; return k && k[slot] ? k[slot] : null; };
/* Syndra's Dark Spheres Unleashed Power takes at time t (combo audit 2026-09-24, wiki Syndra_R notes): live ones and one "summoned
   very shortly before" (a Q pressed, still forming); not one held by Force of Will or in flight after its throw, nor one being
   pushed by Scatter the Weak. Sphere: {pressT, from (on the ground), until, x, heldUntil (W: grabbed until the throw lands),
   pushUntil (E: pushed until it lands)}. */
function syndraRSpheres(K, t){ return (K.spheres||[]).filter(s=>s.until>t && (s.pressT ?? s.from)<=t+1e-9 && !(s.heldUntil>t+1e-9) && !(s.pushUntil>t+1e-9)); }
function kitCtx(c, slot, rank, st, flags, o, u){
  const C=CALC.champs[c.champ]||{}, S=C[slot]||{}, fl=flags||new Set();
  const ev = (key, S2, r) => evalCalc({S:S2||S, rank:r ?? rank, st, flags:fl}, key);
  const x = {c, st, rank, S, slot, o:o||{}, u:u||null, flags:fl, P:C.P||{}, stacks:kitStacks(c), evolved:kitEvolved(c, st),
    ev, dv:(name, S2, r) => dvOf(S2||S, name, r ?? rank),
    // one formula as a damage part: {label, v, s, type, pctOf}
    part:(key, type, extra, S2, r) => { const S3=S2||S, e=partRaw(S3, key, r ?? rank, st, fl);   // a calc or data value, with the tooltip's reading
      return {label:e.name, v:e.v, s:e.s, type:type||(S3.types||{})[key]||"magic", pctOf:e.pctOf||null, ...(extra||{})}; },
    note:(s) => { if (TR) TR.notes.add(`${label(c)}.${slot}: ${s}`); } };
  return x;
}
// expected value of a part whose AD-ratio share can critically strike: (1 − crit) × normal + crit × critical formula
const kitCrit = (x, key, critKey, type) => { const n=x.part(key, type), k=x.ev(critKey), c=x.st.crit;
  if (!c) return n; return {...n, v:(1-c)*n.v + c*k.v, s:`${fmt(1-c)} × (${n.s}) + ${fmt(c)} crit × (${k.s})`}; };
const scale = (p, n, what) => ({...p, v:p.v*n, s:`(${p.s}) × ${fmt(n)}${what?` ${what}`:""}`, label:p.label+(what?` × ${fmt(n)} ${what}`:"")});
const KIT = {
  Syndra: {
    stacks: {name:"Splinters of Wrath", max:120, dflt:c=>Math.min(85, 5*(c.level-1)),
      why:"5 per skill point after level 1, up to 85 (wiki Transcendent; the practice tool gives no others without champion damage)"},
    stats(c, st, notes, e){ const n=kitStacks(c), P=CALC.champs.Syndra.P;
      if (n >= (dvOf(P,"maxstackamount",1)||120)){ const f=dvOf(P,"capstoneapperc",1)||0.15; st.ap = st.ap/(1+e.amp)*(1+e.amp+f); notes.push(`Syndra: Transcendence (${n} Splinters) +${fmt(f*100)}% AP`); } },
    P: {none:"Transcendent has no damage of its own; its thresholds (40 Q charges, 60 W true damage, 80 E slow, 100 R execute, 120 +15% AP) follow x.stacks"},
    W: {parts(x){ const r=[x.part("throwdamage","magic")], th=dvOf(x.P,"wupgradethreshold",1)||60;
      if (x.stacks >= th) r.push({...x.part("passivebonusdamage","true"), label:`Transcendent (${fmt(x.stacks)} ≥ ${th} Splinters): bonus true damage`});
      else x.note(`${fmt(x.stacks)} Splinters of Wrath: below ${th}, no bonus true damage`);
      return r; }},
    R: {opts:{spheres:{min:3, max:7, dflt:3, alias:"count", what:"spheres (3 conjured + up to 4 live ones grabbed)"}},
      sim:(u)=>({spheres: 3 + Math.min(4, syndraRSpheres(u.kit, u.kitT).length)}),
      parts(x){ const n=x.o.spheres; if (x.stacks >= (dvOf(x.P,"rupgradethreshold",1)||100)) x.note(`Transcendent (${fmt(x.stacks)} Splinters): executes below 15% maximum health (fight()/perform())`);
        return [scale(x.part("damagecalc","magic"), n, "spheres")]; }},
  },
  Viktor: {
    evolved: {slots:"QWER", name:"Hex Core augments", dflt:()=>"", why:"augments cost 100 Hex Fragments from kills; none in the practice tool"},
    P: {none:"Glorious Evolution has no damage of its own; augments follow x.evolved"},
    Q: {opts:{discharge:{bool:true, dflt:true, what:"the empowered next attack (Discharge) counted"}},
      parts(x){ const r=[x.part("totalmissiledamage","magic")];
        if (x.o.discharge) r.push({...x.part("attacktotaldmg","magic"), label:"Discharge: next attack (replaces the attack's damage)", later:"attack"});
        if (x.evolved.includes("Q")) x.note("Augment Turbocharge: shield ×1.6 and 30% move speed (no damage change)");
        return r; },
      // Turbocharge (wiki Viktor_Q description3; game data AugmentShieldBonus 1.6): the shield ×1.6 once Q is augmented
      shieldMult:(c, st, rank)=>kitEvolved(c, st).includes("Q") ? (dvOf(CALC.champs.Viktor.Q,"augmentshieldbonus",rank||1) ?? 1.6) : 1, shieldWhy:"Turbocharge augment"},
    E: {parts(x){ const r=[x.part("laserdamage","magic")];
        if (x.evolved.includes("E")) r.push({...x.part("aftershockdamage","magic"), label:"Augment Aftershock: explosion 1 s later", later:"delay"});
        else x.note("not augmented: no Aftershock (set x.evolved = {E})");
        return r; }},
    R: {opts:{ticks:{min:0, max:6, dflt:6, what:"storm ticks after the initial burst (one per second for 6.5 s; the storm follows its target)"}},
      parts(x){ return [x.part("initialburstdamage","magic"), {...scale(x.part("subsequentburstdamage","magic"), x.o.ticks, "ticks"), later:"ticks", per:x.part("subsequentburstdamage","magic").v}]; }},
  },
  Gwen: {
    P: {parts(x){ return [{...x.part("percenthealth1000cuts","magic",null,x.P,1), pctOf:"max", label:"A Thousand Cuts: 1% (+0.6% per 100 AP) maximum health"}]; }},
    Q: {opts:{snips:{min:1, max:5, dflt:5, what:"small snips before the final one (1 + one per Snippy stack; 5 = four attacks first)"},
              center:{bool:true, dflt:true, what:"the target in the centre (50% true damage, A Thousand Cuts on every snip)"}},
      sim:(u)=>({snips:1+Math.min(4, u.kit.snippy && u.kit.snippy.until>u.kitT ? u.kit.snippy.n : 0)}),
      parts(x){ const n=x.o.snips, mini=x.part("miniswipedamage","magic"), fin=x.part("finalswipedamage","magic");
        const tot={v:n*mini.v+fin.v, s:`${n} × (${mini.s}) + (${fin.s})`};
        if (!x.o.center) return [{label:`${n} snips + final snip`, v:tot.v, s:tot.s, type:"magic"}];
        const cv=dvOf(x.S,"truedamageconversion",x.rank) ?? 0.5, pas=x.part("percenthealth1000cuts","magic",null,x.P,1);
        return [{label:`${n} snips + final snip, magic half`, v:tot.v*(1-cv), s:`(${tot.s}) × ${fmt(1-cv)}`, type:"magic"},
                {label:`${n} snips + final snip, true half (centre)`, v:tot.v*cv, s:`(${tot.s}) × ${fmt(cv)}`, type:"true"},
                {...scale(pas, n+1, "snips"), pctOf:"max", label:`A Thousand Cuts × ${n+1} snips`}]; }},
    E: {parts(x){ return [{...x.part("onhitdamage","magic"), label:"bonus magic damage on-hit, each attack for 4 s", later:"onhit"}]; }},
    R: {opts:{needles:{min:1, max:9, dflt:9, what:"needles that hit (1 + 3 + 5 over the three casts)"}},
      sim:()=>({needles:1}),
      parts(x){ const n=x.o.needles, pas=x.part("percenthealth1000cuts","magic",null,x.P,1);
        return [scale(x.part("totaldamage","magic"), n, "needles"), {...scale(pas, n, "needles"), pctOf:"max", label:`A Thousand Cuts × ${n} needles`}]; }},
  },
  DrMundo: { rankStats:true,
    stats(c, st, notes){ const r=rankOf(c,"E"); if (!r) return; const S=CALC.champs.DrMundo.E, k=dvOf(S,"healthtoadratio",r)/100, v=k*(st.basehp+st.bonushp);
      st.bonusad += v; notes.push(`Dr. Mundo: Blunt Force Trauma passive +${fmt(v)} AD (${fmt(k*100)}% of maximum health, E rank ${r})`); },
    P: {none:"Goes Where He Pleases has no damage"},
    Q: {parts(x){ return [{...x.part("currenthealthdamage","magic"), floor:x.dv("minimumdamage"), label:"Infected Bonesaw (current health, at least the minimum)"}]; }},
    E: {parts(x){ x.note("the bonus grows up to ×1.4 with Dr. Mundo's missing health (at 70% missing); .damage takes him at full health, fight()/perform() use the live value");
      return [{...x.part("additionaldamage","physical"), label:"bonus physical damage on the next attack", later:"attack"}]; }},
    W: {opts:{ticks:{min:0, max:12, dflt:12, what:"ticks while charging (every 0.25 s for 3 s)"}, recast:{bool:true, dflt:true, what:"the recast detonation"}},
      parts(x){ const per=x.dv("damagepertick"), n=x.o.ticks, r=[{label:`${n} ticks`, v:per*n, s:`${fmt(per)} × ${n} ticks`, type:"magic"}];
        if (x.o.recast) r.push({...x.part("totaldamage","magic"), label:"recast detonation", later:"recast"});
        return r; }},
  },
  Kaisa: {
    evolved: {slots:"QWE", name:"Second Skin evolutions", why:"from stats: Q 100 AD from items and growth, W 100 AP, E 100% attack speed from items and growth (wiki Second Skin)",
      dflt:(c, st)=>{ const B=CALC.champs.Kaisa.base; return (st.bonusad + st.basead - B.ad >= 100 ? "Q" : "") + (st.ap >= 100 ? "W" : "") + (st.bonusas >= 1 ? "E" : ""); }},
    Q: {opts:{missiles:{min:1, max:12, dflt:x=>x.evolved.includes("Q")?12:6, what:"missiles on the one target (first full, the rest 25%)"}},
      parts(x){ const n=Math.min(x.o.missiles, x.evolved.includes("Q")?12:6), red=x.dv("extrahitreduction") ?? 0.25, one=x.part("totalindividualmissiledamage","physical");
        return [{...one, v:one.v*(1+red*(n-1)), s:`(${one.s}) × (1 + ${fmt(red)} × ${n-1})`, label:`${n} missiles on one target`}]; }},
  },
  Smolder: {
    stacks: {name:"Dragon Practice", max:Infinity, dflt:()=>0, buff:"{32bcea5d}", why:"stacks come from champion hits and Q kills; the practice tool starts at 0"},
    Q: {parts(x){ const r=[x.part("totaldamage","physical"), {...x.part("passive_qdamageincrease","magic",null,x.P,1), label:`Dragon Practice (${fmt(x.stacks)} stacks)`}];
        if (x.stacks >= (x.dv("stacktier3")||225)) r.push({...x.part("tier3_burn","true"), pctOf:"max", label:"tier 3 burn over 3 s (maximum health)", later:"burn"});
        return r; }},
    W: {parts(x){ return [x.part("initialdamage","physical"), x.part("explosiondamage","physical"), {...x.part("passive_wdamageincrease","magic",null,x.P,1), label:`Dragon Practice on the explosion (${fmt(x.stacks)} stacks)`}]; }},
    E: {opts:{bolts:{min:0, max:99, dflt:x=>Math.floor(x.ev("totalnumberofattacks").v), what:"bolts that hit (5 + 1 per 100 stacks)"}},
      parts(x){ const n=Math.min(x.o.bolts, Math.floor(x.ev("totalnumberofattacks").v));
        return [scale(x.part("damageperhit","physical"), n, "bolts"), {...scale(x.part("ebonusdamage","magic",null,x.P,1), n, "bolts"), label:`Dragon Practice × ${n} bolts`}]; }},
    R: {opts:{sweetspot:{bool:true, dflt:true, what:"the target in the centre of the wave (+50%)"}},
      parts(x){ const p=x.part("totaldamage","physical"); return [x.o.sweetspot ? scale(p, x.dv("sweetspotpercentageincrease")||1.5, "(centre)") : p]; }},
  },
  Yone: {
    stacks: {name:"Gathering Storm", max:2, dflt:()=>0, why:"Mortal Steel hits in the last 6 s; set 2 to start a fight or combo with Q3 ready (the guides' \"Q3\" openers)"},
    statsFinal:(c, st, notes, e)=>kitIntent(c, st, notes, e, CALC.champs.Yone.P),
    P: {none:"Way of the Hunter has no damage formula; every second attack deals half magic damage in fight()/perform()"},
    Q: {cd:(x)=>kitAsCd(x, 4, dvOf(x.S,"qattackspeedcdpercent",1)??0.6, dvOf(x.S,"qattackspeedcdmax",1)??0.667),
      parts(x){ return [kitCrit(x, "qdamage", "totaldamagecrit", "physical")]; }},
    W: {cd:(x)=>kitAsCd(x, 14, dvOf(x.S,"wattackspeedcdpercent",1)??0.6, dvOf(x.S,"wattackspeedcdmax",1)??0.571)},
  },
  Yasuo: {
    stacks: {name:"Gathering Storm", max:2, dflt:()=>0, why:"Steel Tempest hits in the last 6 s; set 2 to start a fight or combo with Q3 (the tornado) ready"},
    statsFinal:(c, st, notes, e)=>kitIntent(c, st, notes, e, CALC.champs.Yasuo.P),
    P: {none:"Way of the Wanderer has no damage; its Flow shield is modelled in fight()/perform()"},
    Q: {cd:(x)=>kitAsCd(x, 4, 0.6, 0.667), parts(x){ return [kitCrit(x, "totaldamage", "totaldamagecrit", "physical")]; }},
    E: {opts:{stacks:{min:0, max:4, dflt:0, what:"Ride the Wind stacks before this dash (+25% each; from other targets)"}},
      simCd:(x)=>x.dv("pertargetcooldown"),
      parts(x){ const p=x.part("totaldamage","magic"), n=x.o.stacks; return [n ? {...p, v:p.v*(1+0.25*n), s:`(${p.s}) × (1 + 0.25 × ${n} stacks)`} : p]; }},
  },
  Samira: {
    stacks: {name:"Style", max:6, dflt:()=>0, why:"built in the last 6 s by hits of different kinds; set up to 6 to start a fight or combo with Style already built (6 = Inferno Trigger ready)"},
    P: {parts(x){ return [kitSamiraP(x)]; }},
    Q: {opts:{melee:{bool:true, dflt:true, what:"the blade slash (target within 340) with the melee bonus"}},
      parts(x){ const r=[kitSamiraCrit(x, "damagecalc", "criticaldamagecalc")]; if (x.o.melee) r.push(kitSamiraP(x)); return r; }},
    W: {opts:{slashes:{min:1, max:2, dflt:2, what:"slashes that hit (one at cast, one after 0.75 s)"}}, sim:()=>({slashes:1}),
      parts(x){ const n=x.o.slashes; return [scale(x.part("damagecalc","physical"), n, "slashes"), scale(kitSamiraP(x), n, "slashes")]; }},
    E: {parts(x){ return [x.part("dashdamage","magic"), kitSamiraP(x)]; }},
    R: {opts:{shots:{min:1, max:10, dflt:10, what:"shots that hit (up to 10 per enemy over 2 s)"}}, sim:()=>({shots:1}),
      parts(x){ return [scale(kitSamiraCrit(x, "damagecalc", "criticaldamagecalc"), x.o.shots, "shots")]; }},
  },
  Zed: {
    P: {parts(x){ return [{...x.part("maxhpdamage","magic",null,x.P,1), pctOf:"max", label:"Contempt for the Weak (targets below 50% health)"}]; }},
    Q: {opts:{shurikens:{min:1, max:3, dflt:1, what:"shurikens that hit (Zed + Living Shadow + Death Mark shadow)"}},
      sim:(u)=>({shurikens:1+kitShadows(u).length}),
      parts(x){ return [scale(x.part("totaldamage","physical"), x.o.shurikens, "shurikens")]; }},
    R: {parts(x){ x.note("Death Mark detonates 3 s after it lands; it adds 25/40/55% of the damage dealt during the 3 s mark at detonation (fight()/perform() track it)"); return [{...x.part("rcalculateddamage","physical"), later:"mark"}]; }},
  },
  Ezreal: {
    W: {parts(x){ return [{...x.part("damage","magic"), label:"mark detonated by the next attack or ability", later:"mark"}]; }},
  },
  Caitlyn: {
    W: {charges:(r)=>[3,3,3,4,4,5][r] || 3,   // game data mMaxAmmo by rank (the data export kept only 3)
      parts(x){ return [{...x.part("headshotbonusdamage","physical"), label:"added to the Headshot on a trapped champion", later:"headshot"}]; }},
  },
  Kalista: {
    // Sentinel (wiki Kalista_W): the active is a vision ghost with no damage; the damage is the passive Soul-Marked: 10–18% of the
    // target's maximum health (magic) when Kalista's and her Oathsworn's marks meet, once per target every 10 s (fight() tracks it)
    // Rend (champion audit batch 4): the first spear + (spears − 1) × each extra spear (game data NormalDamage, AdditionalDamage)
    E: {opts:{spears:{min:1, max:254, dflt:2, what:"spears in the target (from her attacks and Pierce; fight() counts them)"}},
      parts(x){ const a=x.part("normaldamage","physical"), b=x.part("additionaldamage","physical"), n=x.o.spears;
        return [{...a, label:"first spear"}, ...(n>1 ? [{...scale(b, n-1, "extra spears"), label:`${n-1} extra spear${n>2?"s":""}`}] : [])]; }},
    W: {parts(x){ return [{...x.part("maxhealthdamage","magic"), pctOf:"max", label:"Soul-Marked (Kalista and her Oathsworn both hit the target; the Sentinel itself deals no damage)", later:"soulmark"}]; }},
    R: {parts(x){ x.note("Fate's Call deals no damage: the Oathsworn is pulled in, then dashes out and knocks up enemies where it lands (fight()/perform())");
      return [{label:"Fate's Call (no damage; the Oathsworn's knock-up)", v:0, s:"0", type:"magic", later:"oath"}]; }},
  },
  Ivern: {
    // Brushmaker: the damage is a bolt on Ivern's attacks while he's in brush (wiki Ivern_W passive), not a cast; 3 charges,
    // one every 20 s, 0.5 s between casts. One brush (45 s) covers a fight, so fight() casts it once per charge time.
    W: {simCd:(x)=>dvOf(x.S,"recharge",x.rank) || (x.S.recharge||[])[x.rank] || 20,
      parts(x){ return [{...x.part("totaldamage","magic"), label:"Brushmaker bolt on each of Ivern's attacks while in brush", later:"brush"}]; }},
    // Daisy! (wiki Ivern_R, Pets): R summons Daisy, who attacks; her third attack on one target (2 Daisy Smash! stacks) is a
    // shockwave (90/140/190 + 50% AP magic, stun + knock-up 1 s), at most every 3 s. .damage = one shockwave; fight() runs Daisy.
    R: {parts(x){ return [{...x.part("totalshockwavedamage","magic"), label:"Daisy Smash! shockwave (Daisy's third attack on a target, at most every 3 s)", later:"daisy"}]; }},
  },
  /* ---- champion audit batch 2 (2026-09-24): wiki templates Template:Data_<Champ>/<Ability> (live, fetched 2026-09-24) and game
     data; static numbers here, fight()/perform() mechanics in CHAMP_MECH. cc: crowd control the data export misses (wiki). ---- */
  LeeSin: {
    P: {none:"Flurry has no damage: after each ability his next 2 attacks within 3 s gain 40% bonus attack speed (fight()/perform())"},
    Q: {opts:{recast:{bool:true, dflt:true, what:"the recast Resonating Strike (+1% per 1% of the target's missing health, up to ×2)"}}, sim:()=>({recast:true}),
      parts(x){ const r=[x.part("initialdamage","physical")];
        if (x.o.recast) r.push({...x.part("recastdamage","physical"), ampMissing:dvOf(x.S,"q2maxmissinghealthmod",x.rank)??1, ampCap:1, label:"Resonating Strike (recast; × (1 + the target's missing health share))", later:"recast"});
        return r; }},
    cc: {E:(S,r)=>[{type:"slow", dur:4, pct:(dvOf(S,"slowamount",r)||0)/100, decay:true, src:{dur:"wiki", pct:"dv:SlowAmount"}, text:"Cripple (recast): slows enemies marked by Tempest, decaying over 4 seconds"}]},
  },
  Jayce: {
    Q: {opts:{cannon:{bool:true, dflt:false, what:"Mercury Cannon's Shock Blast instead of the hammer's To the Skies!"}, gate:{bool:true, dflt:true, what:"(cannon) Shock Blast through Acceleration Gate (+40%)"}},
      parts(x){ if (!x.o.cannon) return [x.part("damage","physical")];
        const F=CALC.champs.Jayce.forms.Q, p={...x.part("damage","physical",null,F), label:"Shock Blast"};
        return [x.o.gate ? {...scale(p, dvOf(F,"empowermultiplier",x.rank)||1.4, "(through Acceleration Gate)"), label:"Shock Blast through Acceleration Gate"} : p]; }},
    W: {opts:{cannon:{bool:true, dflt:false, what:"Mercury Cannon's Hyper Charge (3 empowered attacks) instead of the hammer's Lightning Field"}},
      parts(x){ if (!x.o.cannon) return [x.part("damage","magic")];
        const F=CALC.champs.Jayce.forms.W, n=dvOf(F,"numattacks",x.rank)||3, one=x.part("actualdamage","physical",null,F), c=x.st.crit, m=1+c*(x.st.critdmg-1);
        return [{...one, v:one.v*n*m, s:`(${one.s}) × ${n} attacks${c?` × ${fmt(m)} expected crit`:""}`, label:`Hyper Charge: ${n} empowered attacks (their whole damage)`, later:"attack"}]; }},
    E: {opts:{cannon:{bool:true, dflt:false, what:"Mercury Cannon's Acceleration Gate (no damage) instead of the hammer's Thundering Blow"}},
      parts(x){ if (x.o.cannon) return [{label:"Acceleration Gate (no damage)", v:0, s:"0", type:"magic"}];
        return [{...x.part("perchpdamage","magic"), pctOf:"max", label:"Thundering Blow: % of the target's maximum health"}, {...x.part("flatdamage","magic"), label:"Thundering Blow: + bonus AD"}]; }},
    // fight(): R is the stance swap; each cast is a Mercury Cannon burst (Shock Blast through the gate, then Hyper Charge on the next
    // 3 attacks), recast every Shock Blast cooldown; the hammer spells are the data's Q/W/E. .damage: the hammer Transform attack.
    R: {simCdWhy:"each fight() cast is a Mercury Cannon burst, recast every Shock Blast cooldown", simCd:(x)=>{ const F=CALC.champs.Jayce.forms.Q, r=rankOf(x.c,"Q")||1; return (F.cd[r] ?? 8)*100/(100+x.st.haste+x.st.basichaste); },
      parts(x){ if (x.u){ const F=CALC.champs.Jayce.forms, rq=rankOf(x.c,"Q"), rw=rankOf(x.c,"W"), r=[];
          if (rq) r.push({...scale(x.part("damage","physical",null,F.Q,rq), dvOf(F.Q,"empowermultiplier",rq)||1.4, "(gate)"), label:"Shock Blast through Acceleration Gate"});
          if (rw) r.push({...x.part("actualdamage","physical",null,F.W,rw), label:"Hyper Charge attack", later:"hyper", n:dvOf(F.W,"numattacks",rw)||3});
          return r; }
        return [{...x.part("damage","magic"), label:"Transform (to hammer): bonus magic damage on the next attack", later:"attack"}]; }},
    cc: {Q:(S,r)=>[{type:"slow", dur:dvOf(S,"slowduration",r)||2, pct:Math.abs(dvOf(S,"slow",r)||0), src:{dur:"dv:SlowDuration", pct:"dv:Slow"}, text:"To the Skies!: slows enemies for 2 seconds"}],
         E:(S,r)=>[{type:"knockback", dist:dvOf(S,"knockbackdistance",r)||600, dur:dvOf(S,"knockbackduration",r)||0.35, src:{dist:"dv:KnockbackDistance", dur:"dv:KnockbackDuration"}, text:"Thundering Blow: knocks the target back 600 units"}]},
  },
  Tristana: {
    statsFinal(c, st, notes){ const v=evalCalc({S:CALC.champs.Tristana.P, rank:1, st, flags:new Set()}, "bonuspassiverange").v;
      if (v>0){ st.range+=v; notes.push(`Tristana: Draw a Bead +${fmt(v)} attack range (0 to 150 over levels 1–18; game data BonusPassiveRange, wiki)`); } },
    Q: {parts(x){ return [{label:`Rapid Fire (no damage: +${fmt((x.dv("attackspeedmod")||0)*100)}% attack speed for ${fmt(x.dv("buffduration")||7)} s)`, v:0, s:"0", type:"physical", later:"buff"}]; }},
    E: {opts:{stacks:{min:0, max:4, dflt:4, what:"charge stacks from attacks and ability hits after it attaches (+25% each; the 4th detonates it at once)"}}, sim:()=>({stacks:0}),
      parts(x){ const p=x.part("activedamage","physical"), n=x.o.stacks, a=dvOf(x.S,"activeperstackamp",x.rank)??0.25;
        return [{...p, v:p.v*(1+a*n), s:`(${p.s}) × (1 + ${fmt(a)} × ${n} stacks)`, label:`Explosive Charge with ${n} stacks`, later:"charge"}]; }},
    cc: {E:[], R:(S,r)=>{ const d=dvOf(S,"knockbackdistance",r)||600; return [{type:"knockback", dist:d, dur:d/1500, src:{dist:"dv:KnockbackDistance"}, text:"Buster Shot knocks back (wiki knockback speed 1500: duration = distance / 1500, assumed)"},
         {type:"stun", dur:dvOf(S,"stunduration",r)||0.7, src:{dur:"dv:StunDuration"}, text:"and stuns"}]; }},
  },
  Qiyana: { rankStats:true,
    statsFinal(c, st, notes){ const r=rankOf(c,"W"); if (!r) return; const as=dvOf(CALC.champs.Qiyana.W,"attackspeed",r)||0;
      st.bonusas+=as; st.as=Math.min(st.ascap, (st.baseas+st.asratio*st.bonusas)*st.asMult); st.range+=25;
      notes.push(`Qiyana: Terrashape passive (holding an element, which she respawns with): +${fmt(as*100)}% attack speed, +25 attack range`); },
    P: {parts(x){ return [{...x.part("finaldamage","physical",null,x.P,1), label:"Royal Privilege: bonus physical on an attack or basic ability, once per target per cooldown"}]; }},
    Q: {opts:{terrain:{bool:true, dflt:true, what:"Elemental Wrath with the Terrain element (+60% against targets below 50% health)"}},
      sim:(u)=>({terrain: u.kit.element!==false}),
      parts(x){ const p=x.part("vanilladamage","physical"); if (!x.o.terrain) return [{...p, label:"Edge of Ixtal (no element)"}];
        const amp=p.v>0 ? x.ev("tremordamage").v/p.v : 0.6;
        x.note(`Terrain: +${fmt(amp*100)}% against a target below 50% health (.damage takes the target at full health; fight()/perform() use the live value)`);
        return [{...p, ampBelow:{pct:dvOf(x.S,"critthreshold",x.rank)??0.5, amp}, label:"Elemental Wrath (Terrain)"}]; }},
    W: {parts(x){ return [{...x.part("onhitdamage","magic"), label:"Terrashape passive: bonus magic on each attack and basic-ability hit while holding an element", later:"onhit"}]; }},
    R: {parts(x){ return [x.part("damage","physical"), {...x.part("missinghealthdamagerock","physical"), pctOf:"max", label:"10% of the target's maximum health"}]; }},
  },
  Jhin: {
    // Whisper (wiki): attack speed fixed at 0.625 × (1 + 3% per level growth); bonus attack speed and crit give AD instead:
    // +4–44% AD by level (+0.35% per 1% crit, +0.3% per 1% bonus attack speed; game data TotalADPercent); crits deal 75%
    statsFinal(c, st, notes){ const P=CALC.champs.Jhin.P, L=st.level, g=(dvOf(P,"percentattackspeedperlevel",1)||0.03)*(L-1)*(0.7025+0.0175*(L-1));
      const asv=(dvOf(P,"baseattackspeed",1)||0.625)*(1+g), pct=evalCalc({S:P, rank:1, st, flags:new Set()}, "totaladpercent").v, add=pct*st.ad;
      st.as=asv; st.baseas=asv; st.asratio=0; st.asMult=1; st.ascap=Infinity; st.bonusad+=add; st.ad+=add;
      st.critdmg*=1-(dvOf(P,"critreductionpercent",1)??0.25);
      notes.push(`Jhin: Every Moment Matters +${fmt(pct*100)}% AD = +${fmt(add)} (bonus attack speed ${fmt(st.bonusas*100)}% and crit give AD, not speed); attack speed fixed at ${fmt(asv)} (growth only); crits deal ${fmt(st.critdmg*100)}%`); },
    P: {parts(x){ return [{...x.part("fourthshotexecutepercent","physical",null,x.P,1), pctOf:"missing", label:"Whisper 4th shot: bonus physical = 15/20/25% of the target's missing health (the shot always crits)"}]; }},
    R: {opts:{shots:{min:1, max:4, dflt:4, what:"shots that hit (the 4th crits for ×2; each +3% per 1% of missing health, up to ×4)"}}, sim:()=>({shots:1}),
      parts(x){ const one=x.part("damagecalc","physical"), n=x.o.shots, m=dvOf(x.S,"fourthshotmultiplier",x.rank)||2, k=n>=4 ? n-1+m : n;
        return [{...one, v:one.v*k, s:`(${one.s}) × ${n>=4?`(${n-1} + ${fmt(m)} for the 4th shot)`:n}`, label:`${n} shot${n>1?"s":""}`, ampMissing:dvOf(x.S,"percentmissingamp",x.rank)||3, ampCap:3}]; }},
  },
  Yunara: {
    P: {none:"Vow of the First Lands has no damage formula of its own: critical strikes deal 10% (+10% per 100 AP) bonus magic damage (fight()/perform(), at the expected crit rate)"},
    Q: {opts:{active:{bool:true, dflt:false, what:"Unleashed (the active, after 8 stacks from attacks): +5–25 (+20% AP) more on-hit magic and bonus attack speed"}},
      parts(x){ const r=[{...x.part("calc_passive_damage","magic"), label:"Cultivation of Spirit: bonus magic on-hit (every attack)", later:"onhit"}];
        if (x.o.active) r.push({...x.part("calc_damage","magic"), label:"Unleashed: additional bonus magic on-hit", later:"onhit"});
        return r; }},
    W: {opts:{ticks:{min:0, max:4, dflt:4, what:"linger ticks on the target (15% of the hit every 0.25 s for 1 s where the bead expands)"}, ruin:{bool:true, dflt:false, what:"Arc of Ruin (during R): R-rank damage instead"}},
      sim:(u)=>({ruin: !!(u.kit.transcend>u.kitT), ticks:4}),
      parts(x){ if (x.o.ruin){ const rr=rankOf(x.c,"R"); if (rr) return [{...x.part("calc_rw_damage","magic",null,CALC.champs.Yunara.R,rr), label:"Arc of Ruin (Transcendent State)"}]; x.note("R not learned: no Arc of Ruin"); }
        const hit=x.part("calc_damage_initial","magic"), per=x.part("calc_damage_per_second","magic"), n=x.o.ticks, r=[hit];
        if (n) r.push({...per, v:per.v*n/4, s:`(${per.s}) × ${n}/4`, label:`linger: ${n} tick${n>1?"s":""} of 15%`, later:"linger"});
        return r; }},
    R: {parts(x){ return [{...x.part("calc_rw_damage","magic"), label:"Arc of Ruin: the empowered W during Transcendent State (R itself deals no damage)", later:"ruin"}]; }},
  },
  Camille: {
    P: {none:"Adaptive Defenses has no damage: every 14–8 s her next attack on a champion grants a shield of 10–25% maximum health for 2 s (fight()/perform())"},
    Q: {opts:{recast:{bool:true, dflt:true, what:"the recast after 1.5 s (bonus ×2 and part of the attack's damage converted to true damage)"}},
      parts(x){ const b=x.part("bonusdamage","physical"), r=[{...b, label:"Precision Protocol: bonus physical on the next attack", later:"attack"}];
        if (x.o.recast){ const conv=Math.min(1, x.ev("damageconversionpercentage").v), e2=x.part("empoweredbonusdamage","physical");
          r.push({...e2, v:e2.v*(1-conv), s:`(${e2.s}) × ${fmt(1-conv)}`, label:"recast bonus (×2), physical share", later:"attack"},
                 {...e2, v:e2.v*conv, s:`(${e2.s}) × ${fmt(conv)}`, type:"true", label:`recast bonus (×2), true share (${fmt(conv*100)}%: 36% + 4% per level, at most 100% from 16)`, later:"attack"});
          x.note(`the recast attack's own damage is also ${fmt(conv*100)}% true in fight()/perform()`); }
        return r; }},
    W: {opts:{outer:{bool:true, dflt:true, what:"the target in the outer half of the cone (+% of its maximum health, heals Camille)"}},
      parts(x){ const r=[x.part("basedamagetotal","physical")]; if (x.o.outer) r.push({...x.part("outeredgetooltip","physical"), pctOf:"max", label:"outer half: % of the target's maximum health"}); return r; }},
    R: {parts(x){ x.note("The Hextech Ultimatum deals its damage on Camille's attacks in the zone (2.5–4 s), each a share of the target's current health; fight()/perform() add it to every attack");
      return [{...x.part("rpercentcurrenthpdamage","magic"), label:"bonus magic on each attack in the zone (current health)", later:"zone"}]; }},
    cc: {E:(S,r)=>[{type:"stun", dur:dvOf(S,"knockupduration",r)||0.75, src:{dur:"dv:KnockupDuration"}, text:"Wall Dive: colliding with a champion knocks back and stuns for 0.75 seconds (needs a wall; assumed available)"}],
         R:[]},
  },
  Sylas: {
    P: {parts(x){ return [{...x.part("passivedamage","magic",null,x.P,1), label:"Petricite Burst: bonus magic on the next attack after an ability (up to 3 stacks)"}]; }},
    Q: {opts:{explosion:{bool:true, dflt:true, what:"the explosion where the chains cross, 0.6 s later"}},
      parts(x){ const r=[x.part("damage","magic")]; if (x.o.explosion) r.push({...x.part("explosiondamage","magic"), label:"explosion at the intersection (0.6 s later)", later:"delay"}); return r; }},
    R: {parts(x){ if (x.u) return [{label:"Hijack (the copied ultimate is cast in fight())", v:0, s:"0", type:"magic", later:"hijack"}];
        if (!x.vs || x.vs.dummy) throw new Error(`${label(x.c)}.R: Hijack copies the enemy's ultimate: give the enemy, e.g. sylas.R.damage(vs: garen) (its R with Sylas' Hijack rank and stats)`);
        return kitHijack(x, x.vs); }},
    cc: {E:(S,r)=>[{type:"stun", dur:0.5, src:{dur:"wiki"}, text:"Abduct: stuns the first enemy hit for 0.5 seconds (then he dashes to it)"},
                   {type:"knockup", dur:dvOf(S,"knockupduration",r)||0.5, src:{dur:"dv:KnockupDuration"}, text:"knocks it up for 0.5 seconds on arrival (modelled at the same time as the stun; the dash between isn't)"}]},
  },
  Locke: {
    P: {parts(x){ const P=x.P, L=x.st.level, a=dvOf(P,"minonhitstartvalue",1)??5, b=dvOf(P,"minonhitendvalue",1)??40, lo=a+(b-a)*(L-1)/17;
        x.note("Silver Stake's level scaling is taken linear from level 1 to 18 (the game data formula uses an unsupported part; wiki 5 to 40)");
        return [{label:"Silver Stake: bonus magic on-hit, up to ×2 by the target's missing health (at 70% missing)", v:lo+0.1*x.st.ap, s:`${fmt(lo)} (${fmt(a)} to ${fmt(b)} by level) + 0.1×AP ${fmt(x.st.ap)}`, type:"magic", ampMissing:1/0.7, ampCap:1}]; }},
    Q: {opts:{nails:{min:1, max:3, dflt:3, what:"nails that hit (the cast and two recasts)"}, detonate:{bool:true, dflt:true, what:"the Soul Nails stacks consumed by the next attack or Ashen Pursuit (×1, ×2.4, ×4.2)"}},
      sim:()=>({nails:1, detonate:false}),
      parts(x){ const n=x.o.nails, r=[scale(x.part("missiledamage","magic"), n, "nails")];
        if (x.o.detonate){ const m=x.part("naildamage","magic"), f=n*(1+(n===2?(x.dv("twomarkbonuspercent")??20):n===3?(x.dv("threemarkbonuspercent")??40):0)/100);
          r.push({...m, v:m.v*f, s:`(${m.s}) × ${fmt(f)}`, label:`Soul Nails: ${n} stack${n>1?"s":""} consumed`, later:"attack"}); }
        return r; }},
    W: {parts(x){ return [{label:`Soul Ignition (no damage: +${fmt(x.ev("attackspeed").v*100)}% attack speed, move speed and grey health for 6 s)`, v:0, s:"0", type:"magic", later:"buff"}]; }},
    E: {opts:{dash:{bool:true, dflt:true, what:"the empowered attack's dash damage after the blink"}},
      parts(x){ const r=[{...x.part("onhitdamage","magic"), label:"Ashen Pursuit blink"}]; if (x.o.dash) r.push({...x.part("dashdamage","magic"), label:"empowered attack dash", later:"attack"}); return r; }},
    R: {parts(x){ x.note(`Purgatory marks champions hit for 5 s; marked enemies below ${fmt((x.dv("executionthreshold")||0)*100)}% maximum health are executed (fight()/perform())`); return [x.part("damage","magic")]; }},
    cc: {E:[]},
  },
  Lulu: {
    P: {parts(x){ return [{...x.part("combineddamage","magic",null,x.P,1), label:"Pix: 3 bolts on each of Lulu's attacks (all on the one target)"}]; }},
    Q: {opts:{bolts:{min:1, max:2, dflt:2, what:"bolts that hit (Lulu's and Pix's; the second deals 50%)"}},
      parts(x){ const r=[x.part("totaldamage","magic")]; if (x.o.bolts>=2) r.push({...x.part("bonusmissiledamage","magic"), label:"second bolt (Pix, 50%)"}); return r; }},
    cc: {W:(S,r)=>{ const d=dvOf(S,"ccduration",r)||1.2; return [{type:"polymorph", dur:d, src:{dur:"dv:CCDuration"}, text:"Whimsy: polymorph"}, {type:"disarm", dur:d, src:{dur:"dv:CCDuration"}, text:"and disarm"}]; }},
  },
  Nidalee: {
    Q: {opts:{distance:{min:0, max:1500, dflt:0, what:"distance the javelin flew (+0 to 225% from 525 to 1300 units)"}},
      parts(x){ const p=x.part("humanminimumdamage","magic"), d=x.o.distance, f=Math.min(1, Math.max(0, (d-525)/(1300-525))), m=1+((dvOf(x.S,"damagemulti",x.rank)||3.25)-1)*f;
        if (!d) x.note("the minimum (thrown from 525 or closer); damage(distance: 1300) for the most");
        return [m===1 ? p : {...p, v:p.v*m, s:`(${p.s}) × ${fmt(m)} (${fmt(d)} units)`}]; }},
    // Aspect of the Cougar: R (4 ranks) sets the cougar spells' ranks. .damage = the cougar combo; fight() casts it as one burst
    R: {opts:{hunted:{bool:true, dflt:true, what:"the target is Hunted (Javelin or trap hit first): Takedown +30%, Pounce from range"}, takedown:{bool:true, dflt:true, what:"Takedown (empowered attack; up to ×2.75 at the R rank by missing health)"}, pounce:{bool:true, dflt:true, what:"Pounce"}, swipe:{bool:true, dflt:true, what:"Swipe"}},
      simCdWhy:"each fight() cast is the cougar burst, recast every 6 s (the cougar spells' cooldown)", simCd:(x)=>6*100/(100+x.st.haste+x.st.basichaste),
      parts(x){ const r=[];
        if (x.o.takedown){ const p=x.part("totaltakedowndamage","magic"), a=dvOf(x.S,"takedowndamageamp",x.rank)||1, h=x.o.hunted?1.3:1;
          r.push({...p, v:p.v*h, s:h>1?`(${p.s}) × 1.3 Hunted`:p.s, ampMissing:a, ampCap:a, label:`Takedown (× up to ${fmt(1+a)} by missing health)`}); }
        if (x.o.pounce) r.push({...x.part("totalpouncedamage","magic"), label:"Pounce"});
        if (x.o.swipe) r.push({...x.part("totalswipedamage","magic"), label:"Swipe"});
        return r; }},
  },
  Talon: {
    P: {parts(x){ return [{...x.part("bleeddamage","physical",null,x.P,1), label:"Blade's End bleed over 2 s (3 Wound stacks, then an attack)"}]; }},
    Q: {opts:{melee:{bool:true, dflt:false, what:"cast within 170 units: a critical strike for 150% (the default is the ranged leap, the tooltip's main number; fight() uses the gap)"}},
      parts(x){ return [x.o.melee ? {...x.part("criticaldamage","physical"), label:"Noxian Diplomacy (close: crit)"} : x.part("leapdamage","physical")]; }},
    W: {opts:{back:{bool:true, dflt:true, what:"the returning blades (the target is hit on the way back)"}},
      parts(x){ const r=[x.part("totalinitialdamage","physical")]; if (x.o.back) r.push({...x.part("totalreturndamage","physical"), label:"returning blades (about 1 s later)", later:"delay"}); return r; }},
    R: {opts:{recast:{bool:true, dflt:true, what:"the blades converging back (same damage again)"}},
      parts(x){ const r=[x.part("damage","physical")]; if (x.o.recast) r.push({...x.part("damage","physical"), label:"blades converge (recast)", later:"recast"}); return r; }},
  },
  Bard: {
    stacks: {name:"Chimes", max:Infinity, dflt:()=>0, why:"collected over the game; 0 in the practice tool"},
    P: {parts(x){ const n=Math.floor(x.stacks/5)*(dvOf(x.P,"damagepercheckpoint",1)||6), p=x.part("meepdamagenochime","magic",null,x.P,1);
        return [{...p, v:p.v+n, s:`${p.s} + ${fmt(n)} (${fmt(x.stacks)} Chimes: +6 per 5)`, label:"Meep: bonus magic on an attack (one Meep per attack)"}]; }},
    cc: {Q:(S,r)=>[{type:"stun", dur:dvOf(S,"stunduration",r)||1, src:{dur:"dv:StunDuration"}, text:"Cosmic Binding stuns when the bolt reaches terrain or a second enemy (assumed: perfect play)"}]},
  },
  Ryze: {
    statsFinal(c, st, notes){ if (!(st.ap>0)) return; const P=CALC.champs.Ryze.P, f=(dvOf(P,"percentmanaincrease",1)||10)/100*st.ap/(dvOf(P,"apamount",1)||100), add=f*st.mana;
      st.bonusmana+=add; st.mana+=add; notes.push(`Ryze: Arcane Mastery +${fmt(f*100)}% maximum mana (+${fmt(add)}) from ${fmt(st.ap)} AP`); },
    P: {none:"Arcane Mastery has no damage: 10% more maximum mana per 100 AP (in his stats)"},
    Q: {opts:{flux:{bool:true, dflt:true, what:"the target has Flux from E (+40/65/90% by R rank)"}},
      parts(x){ const p=x.part("qdamagecalc","magic"), rr=rankOf(x.c,"R"), a=x.o.flux ? (dvOf(CALC.champs.Ryze.R,"overloaddamagebonus",rr)||15)/100 : 0;
        return [a ? {...p, v:p.v*(1+a), s:`(${p.s}) × (1 + ${fmt(a)} Flux, R rank ${rr})`, label:"Overload on a Fluxed target"} : p]; }},
    cc: {W:(S,r)=>[...((S&&S.cc)||[]).filter(e=>e.type==="slow"), {type:"root", dur:1.5, src:{dur:"wiki"}, text:"Rune Prison roots a Fluxed target for 1.5 seconds instead of slowing it (fight(): only after E)"}], R:[]},
  },
  Alistar: {
    E: {opts:{ticks:{min:0, max:10, dflt:10, what:"trample ticks (every 0.5 s for 5 s)"}, attack:{bool:true, dflt:true, what:"the empowered attack at 5 stacks (bonus magic and 1 s stun)"}},
      parts(x){ const t=x.part("totaldamage","magic"), n=x.o.ticks, r=[{...t, v:t.v*n/10, s:`(${t.s}) × ${n}/10`, label:`Trample: ${n} ticks`, later:"ticks"}];
        if (x.o.attack) r.push({...x.part("attackbonusdamage","magic"), label:"empowered attack at 5 stacks", later:"attack"}); return r; }},
    cc: {E:[]},
  },
  Sona: {
    stacks: {name:"Accelerando", max:120, dflt:()=>0, why:"gained from Hymn of Valor and Aria hits over the game; 0 in the practice tool",
      buff:null},
    stats(c, st, notes){ const n=kitStacks(c); if (n>0){ const v=Math.min(60, 0.5*n); st.basichaste+=v; notes.push(`Sona: ${fmt(n)} Accelerando stacks: +${fmt(v)} basic ability haste`); } },
    P: {opts:{staccato:{bool:true, dflt:true, what:"Staccato (Hymn of Valor cast last: ×1.5)"}},
      parts(x){ return [x.o.staccato ? {...x.part("totalstaccatodamage","magic",null,CALC.champs.Sona.Q,Math.max(1,rankOf(x.c,"Q"))), label:"Power Chord, Staccato (×1.5)"} : {...x.part("powerchorddamage","magic",null,x.P,1), label:"Power Chord"}]; }},
    Q: {opts:{melody:{bool:true, dflt:true, what:"Melody: bonus magic on Sona's next attack within 5 s"}},
      parts(x){ const r=[x.part("totaldamage","magic")]; if (x.o.melody) r.push({...x.part("totalonhitdamage","magic"), label:"Melody: bonus magic on the next attack", later:"attack"}); return r; }},
  },
  // Riven R (wiki Wind Slash): the first cast (Blade of the Exile) deals nothing; the recast Wind Slash deals MinDamage
  // raised 2.667% per 1% of the target's missing health, up to ×3 at 75% missing (game data MaxDamage = 3 × MinDamage)
  Riven: {
    R: {opts:{missing:{min:0, max:100, dflt:0, what:"the target's missing health in % when Wind Slash hits"}},
      parts(x){ const w=x.part("mindamage","physical"), m=Math.min(0.75, x.o.missing/100);
        if (x.u) return [{...w, ampMissing:8/3, ampCap:2, label:"Wind Slash (the recast)", later:"recast"}];
        return [{...scale(w, 1+8/3*m, `(×(1 + 2.667 × ${fmt(m*100)}% missing))`), label:"Wind Slash (the recast; Blade of the Exile itself deals nothing)"}]; }},
  },
  Akali: {
    E: {opts:{recast:{bool:true, dflt:true, what:"the recast dash (70% of the total)"}},
      parts(x){ const r=[x.part("e1damage","magic")]; if (x.o.recast) r.push(x.part("e2damagecalc","magic")); return r; }},
    R: {opts:{recast:{bool:true, dflt:true, what:"the recast (up to ×3 by the target's missing health)"}},
      parts(x){ const r=[x.part("cast1damage","magic")];
        // wiki Akali_R: +2.86% per 1% missing health, capped at 70% missing (×3): 1 + min(2, 2/0.7 × missing share)
        if (x.o.recast) r.push({...x.part("cast2damagemin","magic"), ampMissing:2/0.7, ampCap:2, label:"recast (×(1 + 2.86 × missing health share), up to ×3)", later:"recast"});
        return r; }},
  },
  /* ---- champion audit batch 3 (2026-09-24): the most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<slot> and the game files (data/raw/cdragon_bins); game files win where they disagree ---- */
  Nautilus: {
    // Staggering Blow (wiki; game data P BonusDamage 8 + 6 per level = 14–116, RootDuration 0.75 +0.25 at 6/11/16): bonus PHYSICAL
    // damage and a root on his attack, once per target every 6 s
    P: {parts(x){ return [{...x.part("bonusdamage","physical",null,x.P,1), label:"Staggering Blow: bonus physical on an attack (once per target every 6 s)", later:"attack"}]; }},
    // Titan's Wrath: shield; while it holds (6 s) his attacks apply Pain of Wrath: half the magic damage at once, half 1.25 s later
    W: {parts(x){ return [{...x.part("dotdamagecalc","magic"), label:"Pain of Wrath on his attacks for 6 s (half at once, half 1.25 s later)", later:"attack"}]; }},
    // Riptide: three waves; each wave after the first deals 50% (wiki "Maximum Total Damage" 2×; game data MultiHitReduction 0.5)
    E: {opts:{waves:{min:1, max:3, dflt:3, what:"waves that hit (the 2nd and 3rd deal 50%)"}},
      parts(x){ const p=x.part("damagecalc","magic"), n=x.o.waves, m=1+(x.dv("multihitreduction")??0.5)*(n-1);
        return [{...p, v:p.v*m, s:`(${p.s}) × ${fmt(m)} (${n} wave${n>1?"s":""})`, label:`${n} wave${n>1?"s":""}`}]; }},
    cc: {P:(S,r,c)=>[{type:"root", dur:evalCalc({S:CALC.champs.Nautilus.P, rank:1, st:stats(c), flags:new Set()}, "rootduration").v||0.75, src:{dur:"dv:RootDuration"}, text:"Staggering Blow roots (0.75/1/1.25/1.5 s at levels 1/6/11/16)"}],
         // the primary target's knock-up lasts as long as the stun (wiki "Knock Up Duration 1 to 2"; the 1 s is for enemies in the path)
         R:(S,r)=>{ const d=dvOf(S,"stunduration",r)||1; return [{type:"knockup", dur:d, src:{dur:"dv:StunDuration"}, text:"Depth Charge knocks the primary target up for the stun's duration"}, {type:"stun", dur:d, src:{dur:"dv:StunDuration"}, text:"and stuns"}]; }},
  },
  Rell: {
    // Break the Mold (wiki; game data OnHitDamage): 5% total armor + 5% total MR as bonus magic on-hit; attacks and ability hits stack
    // −3% armor and MR (5 stacks, 5 s; at least StealFloor 1.5–3 per stack by level) — fight()/perform()
    P: {parts(x){ return [{...x.part("onhitdamage","magic",null,x.P,1), label:"Break the Mold: bonus magic on-hit (5% armor + 5% MR)", later:"attack"}]; }},
    // Full Tilt: her next attack or Shattering Strike within 5 s explodes for 5–7% (+3% per 100 AP) of the target's maximum health
    E: {parts(x){ return [{...x.part("maxhealthdamagecalc","magic"), pctOf:"max", label:"Full Tilt explosion on her next attack or Q (maximum health)", later:"attack"}]; }},
    // Shattering Strike stuns 0.65 s (the data export also read "grounded, or silenced" from the note about her own lunge)
    cc: {Q:(S,r)=>[{type:"stun", dur:dvOf(S,"stunduration",r)||0.65, src:{dur:"dv:StunDuration"}, text:"Shattering Strike stuns 0.65 s"}]},
  },
  Thresh: {
    // Damnation (wiki; game data StatValuePerSoul 1): +1 AP and +1 bonus armor per Soul; W shield +2 and Flay +1.7 per Soul
    stacks: {name:"Souls", max:Infinity, dflt:()=>0, buff:"{5fbfbf13}", why:"collected over the game; 0 in the practice tool"},
    stats(c, st, notes, e){ const n=kitStacks(c); if (n>0){ st.ap+=n*(1+e.amp); st.bonusarmor+=n; notes.push(`Thresh: ${fmt(n)} Souls: +${fmt(n)} AP and +${fmt(n)} bonus armor`); } },
    P: {none:"Damnation has no damage: each Soul gives 1 AP and 1 bonus armor (set x.stacks = n); his armor doesn't grow with level"},
    // Flay passive: his attacks deal bonus magic: 1.7 per Soul + 0 to 90–210% AD, charging over 10 s without attacking (fight(): linear)
    E: {opts:{passive:{bool:true, dflt:false, what:"the passive's empowered attack at full charge (10 s without attacking) instead of the active"}},
      parts(x){ if (x.o.passive) return [{...x.part("pattackdamagemax","magic"), label:"Flay passive: bonus magic on an attack at full charge (1.7 per Soul + 90–210% AD)"}];
        return [x.part("totaldamage","magic")]; }},
    cc: {// Death Sentence: stun 1.5 s and airborne 0.4 s; the 20% slow for 1 s is on Thresh himself (wiki), not the target
         Q:(S,r)=>[{type:"stun", dur:dvOf(S,"tauntlength",r)||1.5, src:{dur:"dv:TauntLength"}, text:"Death Sentence stuns 1.5 s"}, {type:"knockup", dur:0.4, src:{dur:"wiki"}, text:"airborne (tugged) 0.4 s"}],
         W:[],
         // Flay: knocked 200 units in the cast direction, then slowed 20–40% for 1 s (game data ActiveSlowPercentage, SlowDuration)
         E:(S,r)=>[{type:"knockback", dist:200, src:{dist:"wiki"}, text:"Flay knocks 200 units in the target direction"}, {type:"slow", dur:dvOf(S,"slowduration",r)||1, pct:(dvOf(S,"activeslowpercentage",r)||20)/100, src:{dur:"dv:SlowDuration", pct:"dv:ActiveSlowPercentage"}, text:"then slows"}]},
  },
  Graves: {
    // New Destiny, 12-Gauge (game data SingleBulletDamage = AD × 0.70 to 1.00 by level, MultiBulletDamage × 0.333; wiki 0.33302):
    // 4 pellets, each after the first on the same target 33.3%: one attack on one target = SingleBullet × (1 + 3 × 0.333)
    P: {parts(x){ const one=x.part("singlebulletdamage","physical",null,x.P,1), k=x.P.calcs && x.P.calcs.multibulletdamage ? x.ev("multibulletdamage",x.P,1).v/Math.max(1e-9,one.v) : 0.333;
      return [{...one, v:one.v*(1+3*k), s:`(${one.s}) × (1 + 3 × ${fmt(k)})`, label:"12-Gauge: one attack, all 4 pellets on one target (crits: 6 pellets, +50% of the bonus crit damage)", later:"attack"}]; }},
    // End of the Line: the round, then the detonation (2 s later, or 0.2 s after it hits terrain)
    Q: {opts:{detonation:{bool:true, dflt:true, what:"the detonation (2 s later, 0.2 s if the round hits terrain)"}},
      parts(x){ const r=[x.part("totaldamage","physical")]; if (x.o.detonation) r.push({...x.part("totaldetonationdamage","physical"), label:"detonation", later:"delay"}); return r; }},
    E: {parts(x){ return [{label:`Quickdraw (no damage: dash, attack reset, reloads a shell, True Grit +${fmt(x.dv("armorperstack")||0)} armor per stack)`, v:0, s:"0", type:"physical", later:"buff"}]; }},
  },
  Jinx: {
    P: {none:"Get Excited! has no damage: a takedown gives 175% decaying move speed and +25% total attack speed per stack for 6 s (fight())"},
    // Switcheroo!: fight() keeps Pow-Pow (the minigun: Rev'd up attack speed stacks); .damage is one Fishbones rocket attack (110% AD)
    Q: {parts(x){ return [{...x.part("rocketdamage","physical"), label:"Fishbones rocket attack (110% AD; the minigun is used in fight())", later:"attack"}]; }},
    // Super Mega Death Rocket!: 10% to 100% of the damage over 0 to 1500 units flown (game data BaseDamage = 10% of MaxDamage, 12% =
    // 10% of 120% bonus AD) + 25/30/35% of the missing health (not scaled by distance). The data export added the floor to the maximum.
    R: {opts:{distance:{min:0, max:1500, dflt:1500, what:"distance the rocket flew (10% at 0 to 100% from 1500 units)"}},
      parts(x){ const mx=x.part("damagemax","physical"), f=0.1+0.9*Math.min(1, x.o.distance/1500), pm=x.part("percentdamage","physical");
        return [f>=1 ? {...mx, label:"rocket (full damage, flew 1500+ units)"} : {...mx, v:mx.v*f, s:`(${mx.s}) × ${fmt(f)} (${fmt(x.o.distance)} units)`, label:"rocket"}, {...pm, pctOf:"missing", label:"missing health (not scaled by distance)"}]; }},
  },
  Pantheon: { rankStats:true,
    // Grand Starfall passive: 10/20/30% armor penetration (game data ArmorPenetration)
    statsFinal(c, st, notes){ const r=rankOf(c,"R"); if (!r) return; const p=dvOf(CALC.champs.Pantheon.R,"armorpenetration",r)||0;
      st.armorpenpct=1-(1-st.armorpenpct)*(1-p); notes.push(`Pantheon: Grand Starfall passive +${fmt(p*100)}% armor penetration (R rank ${r})`); },
    P: {none:"Mortal Will has no damage of its own: at 5 stacks (attacks and casts; full at the start) his next basic ability is empowered (Q.damage(empowered: true), W.damage(empowered: true); fight())"},
    // Comet Spear: the thrust (tap, no AP ratio, 60% cooldown refund) is the default; below 20% health it deals the execute damage
    // (game data ExecuteDamageCalcModified / HoldExecuteDamage: 155 to 455 + 230% bonus AD); Mortal Will adds 20–240 (+115% bonus AD)
    Q: {opts:{hurl:{bool:true, dflt:false, what:"the charged hurl (+50% AP, no cooldown refund) instead of the thrust"}, empowered:{bool:true, dflt:false, what:"Mortal Will (5 stacks): +20 to 240 by level (+115% bonus AD)"}},
      parts(x){ const p=x.part(x.o.hurl?"holddamagecalc":"tapdamagecalc","physical"), ex=x.ev("executedamagecalcmodified").v+(x.o.hurl?x.ev("holddamagecalc").v-x.ev("tapdamagecalc").v:0);
        const r=[{...p, ampBelow:{pct:x.dv("crithealththreshold")??0.2, amp:p.v>0 ? ex/p.v-1 : 0}, label:x.o.hurl?"Comet Spear hurl":"Comet Spear thrust"}];
        x.note(`below 20% health it deals ${fmt(ex)} instead (.damage takes the target at full health; fight()/perform() use the live value)`);
        if (x.o.empowered) r.push({...x.part("empowereddamagecalc","physical"), label:"Mortal Will"});
        return r; }},
    // Shield Vault: 6–8% max health (+1.5% per 100 AP, +0.4% per 100 bonus health); Mortal Will: the next attack strikes 3 times for
    // 40–55% AD each (game data {1b016817} × 3; crits and on-hit per strike)
    W: {opts:{empowered:{bool:true, dflt:false, what:"Mortal Will (5 stacks): the next attack strikes 3 times (120–165% AD in total)"}},
      parts(x){ const r=[{...x.part("maxhealthdamagecalc","physical"), pctOf:"max"}];
        if (x.o.empowered){ const e=x.part("empowereddamagemultcalcmodified","physical"), c=x.st.crit, m=1+c*(x.st.critdmg-1);
          r.push({...e, v:e.v*m, s:`(${e.s})${c?` × ${fmt(m)} expected crit`:""}`, label:"Mortal Will: empowered attack, 3 strikes (replaces the attack)", later:"attack"}); }
        return r; }},
    // Aegis Assault: 12 strikes over the 1.5 s channel (8.33% AD each, 100% AD in total), then the recast slam 55 to 255 (+150% bonus AD)
    E: {opts:{channel:{bool:true, dflt:true, what:"the full 1.5 s channel (12 strikes, 100% AD)"}, slam:{bool:true, dflt:true, what:"the recast slam"}},
      parts(x){ const r=[]; if (x.o.channel) r.push({...x.part("damagecalc","physical"), label:"12 strikes over 1.5 s", later:"channel"});
        if (x.o.slam) r.push({...x.part("shielddamagecalc","physical"), label:"shield slam (recast)", later:"slam"}); return r; }},
    // Grand Starfall: the spear (Comet Spear's thrust-style damage: 40 + 30 per Q rank + 115% bonus AD + 50% AP, game data
    // spell.pantheonq:holddamagecalc at the Q rank) near the impact, then the landing shockwave 300/500/700 (+100% AP) magic (up to 50% less at the edge)
    R: {opts:{edge:{bool:true, dflt:false, what:"the target at the edge of the shockwave (50%)"}},
      parts(x){ const rq=rankOf(x.c,"Q"), Q=CALC.champs.Pantheon.Q, r=[];
        { const q1=Math.max(1,rq), s=x.part("holddamagecalc","physical",null,Q,q1), base=40+30*rq, hold=(dvOf(Q,"holddamage",q1)||0);
          r.push({...s, v:s.v-hold+base, s:`${fmt(base)} (40 + 30 × Q rank ${rq}) + ${fmt(s.v-hold)} (115% bonus AD + 50% AP)`, label:"spear impact", later:x.u?"spear":undefined}); }
        const w=x.part("damagecalc","magic"); r.push({...(x.o.edge ? scale(w, x.dv("edgedamagereduction")??0.5, "(edge)") : {...w, label:"landing shockwave"}), later:x.u?"wave":undefined}); return r; }},
  },
  Olaf: { rankStats:true,
    // Ragnarok passive: +10/15/20 armor and MR (game data Resists)
    statsFinal(c, st, notes){ const r=rankOf(c,"R"); if (!r) return; const v=dvOf(CALC.champs.Olaf.R,"resists",r)||0;
      st.bonusarmor+=v; st.armor+=v; st.bonusmr+=v; st.mr+=v; st.ehpphysical=st.hp*(1+st.armor/100); st.ehpmagic=st.hp*(1+st.mr/100);
      notes.push(`Olaf: Ragnarok passive +${fmt(v)} armor and MR (R rank ${r})`); },
    P: {none:"Berserker Rage has no damage: up to 50–100% bonus attack speed (by level) at 70% missing health (fight() uses his live health; the 8–25% life steal isn't modelled)"},
    // Undertow: slow 1 s (thrown from 400) to 3 s (from 1000); champions hit lose 20% armor for 4 s (fight())
    cc: {Q:(S,r)=>[{type:"slow", dur:dvOf(S,"maxslowduration",r)||3, durMin:dvOf(S,"minslowduration",r)||1, pct:dvOf(S,"slowamount",r)||0.3, src:{dur:"dv:MaxSlowDuration", durMin:"dv:MinSlowDuration", pct:"dv:SlowAmount"}, text:"Undertow slows 1 to 3 s by the distance thrown"}]},
    // Ragnarok: +10/20/30 (+25% AD) AD for 3 s, extended to at least 2.5 s left by each attack on a champion; cleanse and crowd-control immunity
    R: {parts(x){ return [{label:`Ragnarok (no damage: +${fmt(x.ev("ad").v)} AD for 3 s+, crowd-control immunity)`, v:0, s:"0", type:"physical", later:"buff"}]; }},
  },
  Karma: {
    P: {none:"Gathering Fire has no damage: each enemy champion hit by her damaging abilities cuts Mantra's cooldown 4 s (fight())"},
    // Soulflare (Mantra + Q, wiki Template:Data_Karma/Soulflare; game data KarmaMantra): + 40–220 (+30% AP) on impact, and the field
    // ruptures 1.5 s later for 40–310 (+50% AP), by Mantra rank
    Q: {opts:{mantra:{bool:true, dflt:false, what:"Soulflare (empowered by Mantra: bonus impact damage + the field's rupture 1.5 s later)"}},
      parts(x){ const r=[x.part("totaldamage","magic")], rr=rankOf(x.c,"R");
        if (x.o.mantra){ if (!rr) x.note("Mantra not learned"); else { const M=CALC.champs.Karma.R;
          r.push({...x.part("rqimpactdamage","magic",null,M,rr), label:"Soulflare: bonus impact damage", later:"mantra"}, {...x.part("rqfielddamage","magic",null,M,rr), label:"Soulflare: the field ruptures (1.5 s later)", later:"field"}); } }
        return r; }},
    // Focused Resolve: the same damage again and the root when the 2 s tether holds (wiki "Total Magic Damage" 2×)
    W: {opts:{tether:{bool:true, dflt:true, what:"the tether holds 2 s (second hit and the root)"}},
      parts(x){ const p=x.part("initialdamage","magic"), r=[p]; if (x.o.tether) r.push({...p, label:"tether completes: the same damage again (2 s later)", later:"tether"}); return r; }},
    // Mantra deals no damage itself: it empowers her next basic ability within 8 s (Q.damage(mantra: true); fight())
    R: {parts(x){ return [{label:"Mantra (no damage: empowers the next basic ability within 8 s; see Q.damage(mantra: true))", v:0, s:"0", type:"magic", later:"buff"}]; }},
    // the root lands when the tether completes (fight() applies it 2 s after the cast)
    cc: {W:(S,r)=>[{type:"root", dur:dvOf(S,"rootduration",r)||1.6, src:{dur:"dv:RootDuration"}, text:"Focused Resolve roots when the 2 s tether completes"}]},
  },
  Galio: {
    // Colossal Smash: every 5 s (× cooldown multiplier) his next attack deals 15–115 (+100% AD +40% AP +60% bonus MR) magic instead
    // (the AD part can crit), −3 s per cast that hits a champion (fight())
    P: {parts(x){ return [{...x.part("totaldamage","magic",null,x.P,1), label:"Colossal Smash: the empowered attack (magic, replaces the attack; the area around the target too)", later:"attack"}]; }},
    // Winds of War: the two blasts, then the tornado for 2 s: 4 ticks of 2% (+1% per 100 AP) maximum health (game data TornadoTicks, SuperQBasePercentage)
    Q: {opts:{tornado:{bool:true, dflt:true, what:"the target stays in the tornado for its 2 s (4 ticks)"}},
      parts(x){ const r=[x.part("qmissiledamage","magic")];
        if (x.o.tornado){ const n=x.dv("tornadoticks")||4, per=x.ev("{85f4c0e9}").v/100; r.push({label:`tornado: ${n} ticks of ${fmt(per*100)}% maximum health`, v:per*n, s:`${fmt(per*100)}% × ${n}`, type:"magic", pctOf:"max", later:"tornado"}); }
        return r; }},
    // Shield of Durand: the recast after a full 1.25 s charge deals ×3 (60–180 + 90% AP) and taunts 1.5 s (0.5 s uncharged)
    W: {opts:{charged:{bool:true, dflt:true, what:"fully charged (1.25 s): ×3 damage, 1.5 s taunt"}},
      parts(x){ return [x.o.charged ? {...x.part("maxtotaldamage","magic"), label:"Shield of Durand, fully charged", later:x.u?"charge":undefined} : {...x.part("mintotaldamage","magic"), label:"Shield of Durand, uncharged"}]; }},
    cc: {W:(S,r)=>[{type:"taunt", dur:dvOf(S,"ccdurationmax",r)||1.5, src:{dur:"dv:CCDurationMax"}, text:"Shield of Durand fully charged taunts 1.5 s (0.5 s uncharged); the 15% slow is on Galio himself"}]},
  },
  Ekko: {
    // Z-Drive Resonance: the 3rd hit (attacks and damaging abilities, 4 s) deals 30–140 by level (+80% AP) bonus magic; once per target every 4 s
    P: {parts(x){ return [{...x.part("threehitdamage","magic",null,x.P,1), label:"Z-Drive Resonance: bonus magic on the 3rd hit (once per target every 4 s)", later:"resonance"}]; }},
    // Timewinder: out (80–140 + 30% AP) and back (40–140 + 70% AP); wiki "Total Magic Damage"
    Q: {opts:{back:{bool:true, dflt:true, what:"the grenade hits again on its way back"}},
      parts(x){ const r=[x.part("initialdamage","magic")]; if (x.o.back) r.push({...x.part("recalldamage","magic"), label:"return", later:"return"}); return r; }},
    // Parallel Convergence: the damage is the passive (attacks on targets below 30% health: 3% (+3% per 100 AP) of missing health);
    // the active has none: the sphere lands 3 s after the cast and stuns 2.25 s when Ekko enters it (assumed), shielding him
    W: {parts(x){ return [{...x.part("missinghealthpercent","magic"), pctOf:"missing", label:"passive: bonus magic on attacks against targets below 30% health (missing health)", later:"onhit"}]; }},
    // Phase Dive: his next attack within 3 s blinks to the target and deals bonus magic (attack reset)
    E: {parts(x){ return [{...x.part("totaldamage","magic"), label:"Phase Dive: bonus magic on the next attack", later:"attack"}]; }},
  },
  Zeri: {
    // Burst Fire is her attack: attack speed capped at 1.5 (Overcharged: 1.5 + 0.3 × AS ratio), 60% of the excess becomes bonus AD
    // (game data AttackSpeedCap, ExcessAttackSpeedToADMult; 1% attack speed over the cap = 0.6 AD)
    statsFinal(c, st, notes, e){ const cap=(dvOf(CALC.champs.Zeri.Q,"attackspeedcap",1)||1.5)+(e.m && e.m.zeriOver ? 0.3*st.asratio : 0);
      const raw=(st.baseas+st.asratio*st.bonusas)*st.asMult; st.ascap=Math.min(st.ascap, cap); st.as=Math.min(st.as, cap);
      if (raw>cap){ const v=(dvOf(CALC.champs.Zeri.Q,"excessattackspeedtoadmult",1)??0.6)*(raw-cap)*100; st.bonusad+=v; st.ad+=v; notes.push(`Zeri: attack speed capped at ${fmt(cap)}; the ${fmt(raw-cap)} over it gives +${fmt(v)} AD`); } },
    // Living Battery: at full charge (100; full at the start) her next basic attack deals 75–160 (+110% AP) + 1–11% max health magic
    P: {parts(x){ return [{...x.part("passivemaxdamage","magic",null,CALC.champs.Zeri.Q,Math.max(1,rankOf(x.c,"Q"))), label:"Living Battery: the charged attack"},
        {...x.part("passivemaxchargepercenthealth","magic",null,CALC.champs.Zeri.Q,Math.max(1,rankOf(x.c,"Q"))), pctOf:"max", label:"charged attack: % maximum health"}]; }},
    // Burst Fire: 7 rounds, 22–38 (+102–110% AD) in total; it crits (expected value) and is treated as her attack (fight(): every attack)
    Q: {parts(x){ const p=x.part("activedamagethatcancrit","physical"), c=x.st.crit, m=1+c*(x.st.critdmg-1);
      return [{...p, v:p.v*m, s:`(${p.s})${c?` × ${fmt(m)} expected crit`:""}`, label:"Burst Fire (7 rounds; her attack in fight())"}]; }},
    // Ultrashock Laser: through a wall it crits (×(1 + 50% of the bonus crit damage) = 1.5 at 200%)
    W: {opts:{wall:{bool:true, dflt:false, what:"fired through a wall: the laser crits champions (×1.5; 0.85 s delay)"}},
      parts(x){ return [x.o.wall ? {...x.part("walldamage","physical"), label:"laser through a wall (crit)"} : x.part("totaldamage","physical")]; }},
    // Spark Surge: for 5 s each Burst Fire adds 22–30 (+20% AP) magic (× crit damage on a crit) and pierces
    E: {parts(x){ return [{...x.part("bonusdamagetotal","magic"), label:"Lightning Rounds: bonus magic on each Burst Fire for 5 s", later:"attack"}]; }},
  },
  Ambessa: { rankStats:true,
    // Public Execution passive: 10/20/30% armor penetration (game data Armor_Penetration; combines with items multiplicatively)
    statsFinal(c, st, notes){ const r=rankOf(c,"R"); if (!r) return; const p=dvOf(CALC.champs.Ambessa.R,"armor_penetration",r)||0;
      st.armorpenpct=1-(1-st.armorpenpct)*(1-p); notes.push(`Ambessa: Public Execution passive +${fmt(p*100)}% armor penetration (R rank ${r})`); },
    // Drakehounds' Fall: each ability cast gives a Medarda Maxim stack (up to 3, 4 s); an attack spends one: bonus physical, +50% attack speed
    P: {parts(x){ return [{...x.part("calc_onhit_damage_flat","physical",null,x.P,1), label:"Medarda Maxim: bonus physical on an attack after an ability (5 to 30 by level + 25% bonus AD)", later:"attack"}]; }},
    // Cunning Sweep ×2 on the outer edge (game data *_Max, Damage_1_Min_Ratio 0.5 inside); the hit unlocks Sundering Slam (×2 on the first enemy)
    Q: {opts:{outer:{bool:true, dflt:true, what:"Cunning Sweep hits with the outer edge (×2)"}, recast:{bool:true, dflt:true, what:"Sundering Slam (the recast within 4 s) hits as the first enemy (×2)"}},
      parts(x){ const f=x.o.outer?1:(x.dv("damage_1_min_ratio")??0.5), a=x.part("calc_damage_1_max","physical"), b=x.part("calc_damage_1_percent_max","physical");
        const r=[f===1 ? {...a, label:"Cunning Sweep (outer edge)"} : {...scale(a,f,"(inner)"), label:"Cunning Sweep (inner)"}, f===1 ? {...b, pctOf:"max", label:"Cunning Sweep (outer edge): % maximum health"} : {...scale(b,f,"(inner)"), pctOf:"max", label:"Cunning Sweep (inner): % maximum health"}];
        if (x.o.recast) r.push({...x.part("calc_damage_2_max","physical"), label:"Sundering Slam (recast, first enemy)", later:"recast"}, {...x.part("calc_damage_2_percent_max","physical"), pctOf:"max", label:"Sundering Slam: % maximum health", later:"recast"});
        return r; }},
    // Repudiation: ×1.5 when its shield blocked damage from a champion before the slam (needs an enemy hitting her)
    W: {opts:{empowered:{bool:true, dflt:false, what:"the shield blocked champion damage first (×1.5; needs the enemy to hit her during the 0.5 s brace)"}},
      parts(x){ return [x.o.empowered ? {...x.part("calc_damage_high","physical"), label:"Repudiation (empowered ×1.5)"} : x.part("calc_damage_low","physical")]; }},
    // Lacerate: a second spin at the end of the dash (wiki "Total Physical Damage" 2×)
    E: {opts:{spins:{min:1, max:2, dflt:2, what:"spins that hit (the second after the Drakehound's Step dash)"}},
      parts(x){ return [scale(x.part("calc_damage_flat","physical"), x.o.spins, "spins")]; }},
  },
  /* ---- champion audit batch 4 (2026-09-24): the next most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<ability> and the game files (data/raw/cdragon_bins); game files win where they disagree ---- */
  JarvanIV: { rankStats:true,
    // Demacian Standard passive: +20–30% bonus attack speed (game data PermanentAttackSpeed; doubled near the flag, not modelled)
    statsFinal(c, st, notes){ const r=rankOf(c,"E"); if (!r) return; const as=dvOf(CALC.champs.JarvanIV.E,"permanentattackspeed",r)||0;
      st.bonusas+=as; st.as=Math.min(st.ascap, (st.baseas+st.asratio*st.bonusas)*st.asMult); notes.push(`Jarvan IV: Demacian Standard passive +${fmt(as*100)}% attack speed (E rank ${r})`); },
    // Martial Cadence (wiki; game data TooltipCurrentHealthDamage 0.08, MinimumCadenceDamage 20, TooltipCooldown 6 −1 at 6/11/16):
    // his attack deals 8% of the target's current health as bonus physical, at least 20, once per target every 6/5/4/3 s
    P: {parts(x){ const f=dvOf(x.P,"tooltipcurrenthealthdamage",1)||0.08, mn=dvOf(x.P,"minimumcadencedamage",1)||20;
      return [{label:`Martial Cadence: ${fmt(f*100)}% of the target's current health, bonus physical (at least ${fmt(mn)}; once per target every ${fmt(x.ev("tooltipcooldown",x.P,1).v)} s)`, v:f, s:`${fmt(f*100)}%`, type:"physical", pctOf:"current", floor:mn, later:"attack"}]; }},
  },
  Nasus: {
    stacks: {name:"Siphoning Strike stacks", max:Infinity, dflt:()=>0, buff:"{1b1d7345}", why:"from killing units with Q; the practice tool starts at 0"},
    P: {none:"Soul Eater has no damage: life steal by level"},
    // Siphoning Strike: cooldown halved while Fury of the Sands lasts (game data QCDR 0.5; fight())
    Q: {cd:(x)=>{ const b=(x.S.cd[x.rank] ?? x.S.cd[1])*100/(100+(x.st.haste||0)+(x.st.basichaste||0)), fury=x.u && x.u.kit.fury>x.u.kitT;
      line(`${label(x.c)}.Q.cd = ${fmt(x.S.cd[x.rank] ?? x.S.cd[1])}s × 100/(100 + ${fmt((x.st.haste||0)+(x.st.basichaste||0))} haste)${fury?" × 0.5 (Fury of the Sands)":""} = ${fmt(fury?b*0.5:b)}s`); return fury ? b*(1-(dvOf(CALC.champs.Nasus.R,"qcdr",1)??0.5)) : b; }},
    // Spirit Fire: the blast, then one tick per second for 5 s (game data TotalDotDamage = DamagePerTick × Duration 5; the wiki's
    // "Total 10× per tick" disagrees with its own "each second for 5 s" — game files kept); armor −30–50% while inside
    E: {opts:{ticks:{min:0, max:5, dflt:5, what:"seconds the target stays in the fire (one tick each)"}},
      parts(x){ const d=x.dv("duration")||5, tot=x.part("totaldotdamage","magic"), per=tot.v/d;
        return [x.part("initialdamage","magic"), {label:`${x.o.ticks} ticks (one per second in the fire)`, v:per*x.o.ticks, s:`(${tot.s}) / ${fmt(d)} × ${x.o.ticks}`, type:"magic", later:"dot", per}]; }},
    // Fury of the Sands: 3/4/5% (+1% per 100 AP) of maximum health per second (game data DamageCalc; ticks every 0.5 s) for 15 s,
    // at most 240 per second (MaxDamageCap; wiki "capped at 240 per second")
    R: {opts:{seconds:{min:0, max:15, dflt:15, what:"seconds the target stays in the storm (15 s = the whole duration)"}},
      parts(x){ const p=x.part("damagecalc","magic"); x.note("the storm deals at most 240 per second (fight())");
        return [{...scale(p, x.o.seconds, "seconds"), pctOf:"max", label:`storm: ${fmt(p.v*100)}% of maximum health per second × ${x.o.seconds} s`, later:"aura", per:p.v}]; }},
    cc: {W:(S,r)=>[{type:"slow", dur:dvOf(S,"duration",r)||5, pct:(dvOf(S,"slowbase",r)||35)/100, src:{dur:"dv:Duration", pct:"dv:SlowBase"}, text:"Wither slows 35%, +3–15% each second (fight())"}]},
  },
  Jax: {
    P: {none:"Relentless Assault has no damage: each attack gives +5% to 12.5% attack speed by level (game data AttackSpeedPerStack), 8 stacks, 2.5 s (fight())"},
    // Counter Strike: dodges attacks for 2 s, then the recast: 40–160 (+70% AP) + 4% maximum health, +20% per attack dodged (up to 5)
    E: {opts:{dodges:{min:0, max:5, dflt:0, what:"attacks dodged before the recast (+20% each; needs the enemy to attack Jax)"}},
      parts(x){ const m=1+(x.dv("percentincreasedperdodge")??0.2)*Math.min(x.dv("maxdodgesfordamageincrease")||5, x.o.dodges), p=x.part("totaldamage","magic"), h=(x.dv("percenthealthdamage")||4)/100;
        return [{...p, v:p.v*m, s:`(${p.s}) × ${fmt(m)}`, label:`recast${x.o.dodges?` (${x.o.dodges} dodged)`:""}`, later:"recast"},
                {label:`recast: ${fmt(h*100)}% maximum health${m>1?` × ${fmt(m)}`:""}`, v:h*m, s:`${fmt(h*100)}%${m>1?` × ${fmt(m)}`:""}`, type:"magic", pctOf:"max", later:"recast"}]; }},
    // Grandmaster-at-Arms: passive every third hit 75–185 (+60% AP) bonus magic; active 100–250 (+100% AP) around him
    R: {opts:{passive:{bool:true, dflt:false, what:"the passive (bonus magic on every third attack) instead of the swing"}},
      parts(x){ return [x.o.passive ? {...x.part("onhitdamage","magic"), label:"passive: bonus magic on every third attack", later:"attack"} : x.part("swingdamagetotal","magic")]; }},
  },
  Chogath: { rankStats:true,
    stacks: {name:"Feast", max:Infinity, dflt:()=>0, buff:"{8682fc00}", why:"from Feast kills; the practice tool starts at 0"},
    // Feast: +80/120/160 maximum health per stack (game data RHealthPerStack, by R rank)
    stats(c, st, notes){ const n=kitStacks(c), r=rankOf(c,"R"); if (!(n>0) || !r) return; const v=n*(dvOf(CALC.champs.Chogath.R,"rhealthperstack",r)||80);
      st.bonushp+=v; notes.push(`Cho'Gath: ${fmt(n)} Feast stacks: +${fmt(v)} health`); },
    P: {none:"Carnivore has no damage: kills heal him and restore mana"},
    // Vorpal Spikes: his next 3 attacks within 6 s each launch spikes: 30–110 (+30% AP) + 2.5–3.9% (+0.5% per Feast) maximum health
    E: {opts:{spikes:{min:1, max:3, dflt:3, what:"empowered attacks that hit (3 within 6 s)"}},
      parts(x){ const n=x.o.spikes; return [{...scale(x.part("flatdamagecalc","magic"), n, "attacks"), later:"attack"}, {...scale(x.part("maxhealthpercentcalc","magic"), n, "attacks"), pctOf:"max", later:"attack"}]; }},
  },
  Leona: {
    // Eclipse: the shield detonates after 3 s around her (fight(): 3 s later)
    W: {parts(x){ return [{...x.part("totaldamagetooltip","magic"), label:"Eclipse detonation (3 s after the cast)", later:"delay"}]; }},
  },
  KSante: {
    // Dauntless Instinct (wiki; game data FlatDamage 12, MarkDamagePercentMin/Max 1–2% by level): his attack on a target his ability
    // marked (4 s) deals 12 + 1–2% maximum health bonus physical
    P: {parts(x){ const L=x.st.level||1, f=0.01+0.01*(L-1)/17, fl=dvOf(x.P,"flatdamage",1)||12;
      return [{label:"Dauntless Instinct: flat", v:fl, s:fmt(fl), type:"physical", later:"attack"}, {label:`Dauntless Instinct: ${fmt(f*100)}% maximum health (1–2% by level)`, v:f, s:`${fmt(f*100)}%`, type:"physical", pctOf:"max", later:"attack"}]; }},
    // Ntofo Strikes: static cooldown 3.5 s − 0.0125 per bonus armor and MR, at least 2 s (game data BaseCD, MinCD, DefenseCapforCooldown 120)
    Q: {cd:(x)=>{ const res=Math.min(dvOf(x.S,"defensecapforcooldown",1)||120, (x.st.bonusarmor||0)+(x.st.bonusmr||0)), b=dvOf(x.S,"basecd",1)||3.5, mn=dvOf(x.S,"mincd",1)||2, v=b-(b-mn)*res/(dvOf(x.S,"defensecapforcooldown",1)||120);
      line(`${label(x.c)}.Q.cd = ${fmt(b)}s − ${fmt((b-mn)/120)} × ${fmt(res)} bonus armor and MR = ${fmt(v)}s (static: no ability haste)`); return v; }},
    cc: {// 1st and 2nd casts slow 80% 0.5 s; the 3rd (2 stacks) also pulls 300 over 0.65 s and stuns (game data StunDuration 1; wiki 0.8)
         Q:(S,r)=>[{type:"slow", dur:0.5, pct:0.8, src:{dur:"dv:SlowDuration", pct:"dv:SlowPercent"}, text:"slow 80% 0.5 s"},
                   {type:"pull", dist:dvOf(S,"pulldistance",r)||300, dur:dvOf(S,"knockupduration",r)||0.65, src:{dist:"dv:PullDistance", dur:"dv:KnockupDuration"}, text:"3rd cast: pulled 300 toward him over 0.65 s"},
                   {type:"stun", dur:dvOf(S,"stunduration",r)||1, src:{dur:"dv:StunDuration"}, text:"3rd cast: stun (game data 1 s; wiki 0.8 s)"}],
         // Path Maker fully charged (0.9 s): stun 1.75 s (game data MaxKnockbackDuration; 0.5 s uncharged)
         W:(S,r)=>[{type:"stun", dur:dvOf(S,"maxknockbackduration",r)||1.75, src:{dur:"dv:MaxKnockbackDuration"}, text:"Path Maker fully charged stuns 1.75 s (0.5 s uncharged)"},
                   {type:"knockback", dist:dvOf(S,"knockbackdist",r)||125, src:{dist:"dv:KnockbackDist"}, text:"carried along the dash"}],
         // All Out: root 0.5 s over the cast, the 300-unit push, then stun 0.25 s without a wall (game data NoWallStunDuration; wiki 0.3)
         R:(S,r)=>[{type:"root", dur:0.5, src:{dur:"wiki"}, text:"rooted over the cast time"}, {type:"pull", dist:300, src:{dist:"wiki"}, text:"pushed 300 units"},
                   {type:"stun", dur:dvOf(S,"nowallstunduration",r)||0.25, src:{dur:"dv:NoWallStunDuration"}, text:"stun 0.25 s (0.5 s over a wall)"}]},
  },
  Cassiopeia: {
    P: {none:"Serpentine Grace has no damage: move speed bonuses are more effective; she can't buy boots"},
    // Twin Fang on a poisoned target (Noxious Blast or Miasma): + 20–120 (+45% AP) and a heal (fight(): only while poisoned)
    E: {opts:{poisoned:{bool:true, dflt:true, what:"the target is poisoned (Q or W): bonus damage and a heal"}}, sim:()=>({poisoned:false}),
      parts(x){ const r=[x.part("basicdamage","magic")]; if (x.o.poisoned) r.push({...x.part("bonuspoisoneddamage","magic"), label:"poisoned target: bonus magic"}); return r; }},
    // Miasma: 20–40 (+10% AP) per second in the clouds for 5 s (wiki Total 100–200 (+50% AP); game data DamagePerSecond, CloudDuration)
    W: {opts:{seconds:{min:0, max:5, dflt:5, what:"seconds the target stays in the clouds"}},
      parts(x){ return [{...scale(x.part("damagepersecond","magic"), x.o.seconds, "seconds"), label:`Miasma: ${x.o.seconds} s in the clouds`}]; }},
    // Miasma: the clouds last 5 s (game data CloudDuration); enemies in them are grounded and slowed 40–80% decaying (assumed to stay in them)
    cc: {W:(S,r)=>[{type:"ground", dur:dvOf(S,"cloudduration",r)||5, src:{dur:"dv:CloudDuration"}, text:"grounded while in the clouds (assumed to stay 5 s)"},
                   {type:"slow", dur:dvOf(S,"cloudduration",r)||5, pct:(dvOf(S,"slowpercent",r)||40)/100, decay:true, src:{dur:"dv:CloudDuration", pct:"dv:SlowPercent"}, text:"slowed, decaying over the clouds' duration"}]},
  },
  TwistedFate: { rankStats:true,
    // Stacked Deck passive: +15–55% attack speed (game data AttackSpeedBonus)
    statsFinal(c, st, notes){ const r=rankOf(c,"E"); if (!r) return; const as=(dvOf(CALC.champs.TwistedFate.E,"attackspeedbonus",r)||0)/100;
      st.bonusas+=as; st.as=Math.min(st.ascap, (st.baseas+st.asratio*st.bonusas)*st.asMult); notes.push(`Twisted Fate: Stacked Deck passive +${fmt(as*100)}% attack speed (E rank ${r})`); },
    P: {none:"Loaded Dice has no damage: gold on kills"},
    // Pick a Card: the card replaces his next attack's damage (magic, 100% AD included). Gold: 15–45 (+100% AD +50% AP), stun 1–2 s;
    // Red: 30–90 (+100% AD +70% AP) area slow; Blue: 40–120 (+100% AD +100% AP), mana. The data export took Blue as the main formula.
    W: {opts:{red:{bool:true, dflt:false, what:"the Red Card instead of the Gold Card"}, blue:{bool:true, dflt:false, what:"the Blue Card instead of the Gold Card"}},
      parts(x){ const k=x.o.blue ? "bluedamage" : x.o.red ? "reddamage" : "golddamage", nm=x.o.blue ? "Blue Card" : x.o.red ? "Red Card" : "Gold Card";
        return [{...x.part(k,"magic"), label:`${nm}: replaces his next attack (magic)`, later:"attack", card:nm}]; }},
    // Stacked Deck: every 4th attack deals 65–165 (+20% bonus AD +40% AP) bonus magic
    E: {parts(x){ return [{...x.part("bonusdamage","magic"), label:"Stacked Deck: bonus magic on every 4th attack", later:"attack"}]; }},
    R: {none:"Destiny has no damage (true sight, then Gate's teleport)"},
  },
  Pyke: {
    P: {none:"Gift of the Drowned Ones has no damage: bonus health becomes AD (no health); grey health from damage taken (not modelled)"},
    // Gift of the Drowned Ones: bonus health gives no health; 1 bonus AD per 14 instead (game data HPPerBAD 14)
    stats(c, st, notes){ if (!(st.bonushp>0)) return; const k=dvOf(CALC.champs.Pyke.P,"hpperbad",1)||14, v=st.bonushp/k;
      notes.push(`Pyke: Gift of the Drowned Ones — ${fmt(st.bonushp)} bonus health becomes +${fmt(v)} AD (1 per ${fmt(k)}), no health`); st.bonusad+=v; st.bonushp=0; },
    // Phantom Undertow: the phantom returns after 1 s: damage and stun then (fight())
    E: {parts(x){ return [{...x.part("totaldamage","physical"), label:"Phantom Undertow (the phantom returns 1 s after the dash)", later:"phantom"}]; }},
    // Death from Below: champions at or below the threshold (250–550 by level +80% bonus AD +1.5 per lethality) are executed; the
    // rest take 50% of it as physical damage (.damage = that; fight() executes)
    R: {parts(x){ x.note(`executes champions at or below ${fmt(x.ev("rdamage").v)} health (fight()/perform())`); return [{...x.part("reduceddamagefinal","physical"), label:"Death from Below (target above the execute threshold: 50%)"}]; }},
  },
  Hecarim: {
    // Warpath: bonus AD = 12–24% of his bonus move speed (game data P BonusAD: 12% +2% at levels 3/6/9/12/15/18)
    statsFinal(c, st, notes){ if (!(st.bonusms>0)) return; const f=evalCalc({S:CALC.champs.Hecarim.P, rank:1, st:{...st, bonusms:1}, flags:new Set()}, "bonusad").v, v=f*st.bonusms;
      if (v>0){ st.bonusad+=v; st.ad+=v; notes.push(`Hecarim: Warpath +${fmt(v)} AD (${fmt(f*100)}% of ${fmt(st.bonusms)} bonus move speed)`); } },
    P: {none:"Warpath has no damage: bonus AD from bonus move speed (in his stats)"},
    // Rampage: +3% (+3% per 100 bonus AD) damage per stack (3 max, 8 s) from earlier hits; each stack −0.75 s cooldown (fight())
    Q: {opts:{stacks:{min:0, max:3, dflt:0, what:"Rampage stacks from earlier Q hits within 8 s"}}, sim:(u)=>({stacks:u.kit.ramp && u.kit.ramp.until>u.kitT ? u.kit.ramp.n : 0}),
      cd:(x)=>{ const n=x.u && x.u.kit.ramp && x.u.kit.ramp.until>x.u.kitT ? x.u.kit.ramp.n : 0, b=((x.S.cd[x.rank] ?? 4)-(dvOf(x.S,"rampagecooldownreduction",x.rank)||0.75)*n)*100/(100+(x.st.haste||0)+(x.st.basichaste||0));
        if (!x.u) line(`${label(x.c)}.Q.cd = ${fmt(x.S.cd[x.rank] ?? 4)}s × 100/(100 + ${fmt((x.st.haste||0)+(x.st.basichaste||0))} haste) = ${fmt(b)}s (−0.75 s per Rampage stack in fight())`); return b; },
      parts(x){ const p=x.part("damage","physical"), n=x.o.stacks; if (!n) return [p]; const k=x.ev("rampagebonusdamageperc").v/100;
        return [{...p, v:p.v*(1+k*n), s:`(${p.s}) × (1 + ${fmt(k)} × ${n} stacks)`, label:`Rampage (${n} stacks)`}]; }},
    // Devastating Charge: his next attack within 4 s deals 30–90 (+50% bonus AD), up to double after 1200 units travelled
    E: {opts:{distance:{min:0, max:1200, dflt:1200, what:"units travelled before the hit (double damage and 350 knockback at 1200)"}},
      parts(x){ const a=x.part("mindamage","physical"), b=x.part("maxdamage","physical"), f=Math.min(1, x.o.distance/(x.dv("distancetomaxdamage")||1200));
        return [f>=1 ? {...b, label:"Devastating Charge (full: 1200 units travelled)", later:"attack"} : {...a, v:a.v+(b.v-a.v)*f, s:`${fmt(a.v)} + (${fmt(b.v)} − ${fmt(a.v)}) × ${fmt(f)}`, label:`Devastating Charge (${fmt(x.o.distance)} units travelled)`, later:"attack"}]; }},
  },
  Lucian: {
    // Lightslinger: after an ability, his next attack within 3.5 s fires a second shot for 50/55/60% AD (fight())
    P: {parts(x){ return [{...x.part("totaldamage","physical",null,x.P,1), label:"Lightslinger: the second shot of his next attack after an ability", later:"attack"}]; }},
  },
  /* ---- champion audit batch 5 (2026-09-24): the next most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<ability> and the game files (data/raw/cdragon_bins); game files win where they disagree ---- */
  Viego: {
    P: {none:"Sovereign's Domination has no damage: a takedown lets him possess the champion (not modelled)"},
    Q: {parts(x){ x.note("the passive (2–6% of the target's current health on his attacks) and the mark's second strike (20% AD + 15% AP) are dealt in fight()/perform()");
      return [x.part("totaldamage","physical")]; }},
    E: {parts(x){ x.note(`Harrowed Path deals no damage: +${fmt((x.dv("attackspeed")||0)*100)}% attack speed in the mist (fight())`);
      return [{label:"Harrowed Path (no damage: attack speed in the mist)", v:0, s:"0", type:"physical", later:"buff"}]; }},
    // Spectral Maw fully charged (1 s): stun 1.25 s (game data MaxStunTT; StunDuration 0.25 is the uncharged stun)
    cc: {W:(S,r)=>[{type:"stun", dur:dvOf(S,"maxstuntt",r)||1.25, src:{dur:"dv:MaxStunTT"}, text:"Spectral Maw fully charged (1 s) stuns 1.25 s (0.25 s uncharged)"}]},
  },
  Zoe: {
    // Paddle Star!: ×(1 + 0–150%) by distance travelled (wiki: +0% at 800, then 25% steps at 950/1350/1650/1950/2250/2550; game data
    // MaxDamageTooltip ×2.5). A redirected star (perfect play) can travel the full 2550.
    Q: {opts:{distance:{min:0, max:2550, dflt:2550, what:"units the star travels before it hits (×1 up to 800, ×2.5 at 2550: a redirected Q)"}}, sim:()=>({distance:0}),
      parts(x){ const p=x.part("totaldamagetooltip","magic"), f=zoeQMult(x.o.distance); return [f===1 ? p : {...scale(p, f, `(${fmt(x.o.distance)} units travelled)`), label:`Paddle Star! (${fmt(x.o.distance)} units travelled, ×${fmt(f)})`}]; }},
    // Spell Thief: 3 bolts per cast (with a spell shard) or summoner spell
    W: {opts:{bolts:{min:1, max:3, dflt:3, what:"bolts that hit (3 per Spell Thief or summoner spell cast)"}},
      parts(x){ return [scale(x.part("missiledamagetooltip","magic"), x.o.bolts, "bolts")]; }},
    // Sleepy Trouble Bubble: the hit that wakes the target deals its post-mitigation damage again as true damage, capped at the bubble's damage
    E: {opts:{wake:{bool:true, dflt:true, what:"the hit that wakes the target deals its damage again as true damage (up to this cap)"}},
      parts(x){ const r=[x.part("totaldamagetooltip","magic")]; if (x.o.wake) r.push({...x.part("breakdamagetooltip","true"), label:"wake-up bonus true damage (the cap: the waking hit must deal at least this much)", later:"wake"}); return r; }},
    R: {none:"Portal Jump has no damage: she blinks up to 575 units and back after 1 s"},
    cc: {E:(S,r)=>[{type:"drowsy", dur:dvOf(S,"drowsyduration",r)||1.4, src:{dur:"dv:DrowsyDuration"}, text:"drowsy 1.4 s"},
                   {type:"slow", pct:dvOf(S,"drowsyslow",r)||0.3, dur:dvOf(S,"drowsyduration",r)||1.4, src:{pct:"dv:DrowsySlow", dur:"dv:DrowsyDuration"}, text:"slowed while drowsy (the growing slow taken at its maximum)"},
                   {type:"sleep", dur:dvOf(S,"sleepduration",r)||2.25, src:{dur:"dv:SleepDuration"}, text:"asleep 2.25 s after the drowsy 1.4 s (fight())"}]},
  },
  Leblanc: {
    P: {none:"Mirror Image has no damage: a clone below 40% health (not modelled)"},
    Q: {opts:{mark:{bool:true, dflt:true, what:"the mark popped by her next ability hit within 3.5 s (the same damage again)"}},
      parts(x){ const r=[x.part("damage","magic")]; if (x.o.mark) r.push({...x.part("markdamage","magic"), label:"mark popped by her next ability hit", later:"mark"}); return r; }},
    E: {opts:{tether:{bool:true, dflt:true, what:"the tether held 1.5 s: the fracture damage and the root"}},
      parts(x){ const r=[x.part("initialdamage","magic")]; if (x.o.tether) r.push({...x.part("delayeddamage","magic"), label:"tether fractures 1.5 s later", later:"tether"}); return r; }},
    // Mimic: her last basic ability again with its own numbers (game data RQ1/RQ2, RW, RE1/RE2): the mimicked Q's mark pops for double
    R: {opts:{w:{bool:true, dflt:false, what:"mimics Distortion (W) instead of Sigil of Malice (Q)"}, e:{bool:true, dflt:false, what:"mimics Ethereal Chains (E) instead of Sigil of Malice (Q)"},
              mark:{bool:true, dflt:true, what:"the mimicked Q's mark popped (double) or the mimicked E's tether held (double)"}},
      sim:(u)=>({w:u.kit.last==="W", e:u.kit.last==="E", mark:true}),
      parts(x){ if (x.o.w) return [{...x.part("rwdamage","magic"), label:"Mimic: Distortion"}];
        if (x.o.e){ const r=[{...x.part("re1damage","magic"), label:"Mimic: Ethereal Chains"}]; if (x.o.mark) r.push({...x.part("re2damage","magic"), label:"mimicked tether fractures 1.5 s later (double)", later:"tether"}); return r; }
        const r=[{...x.part("rq1damage","magic"), label:"Mimic: Sigil of Malice orb"}]; if (x.o.mark) r.push({...x.part("rq2damage","magic"), label:"mimicked mark popped by her next ability hit (double)", later:"mark"}); return r; }},
  },
  Taliyah: {
    P: {none:"Rock Surfing has no damage: move speed near terrain"},
    // Threaded Volley: 5 shards; after the first, hits on the same target deal 40% (game data ExtraMissileReducedDamagePercent 60): ×2.6.
    // On Worked Ground the cast is one Boulder: 180% (game data BigRockDamageMult)
    Q: {opts:{shards:{min:1, max:5, dflt:5, what:"Stone Shards that hit the target (the first full, the rest 40%: ×2.6 for all 5)"}, boulder:{bool:true, dflt:false, what:"the empowered cast on Worked Ground (one Boulder, 180%)"}},
      sim:()=>({shards:5, boulder:false}),
      parts(x){ if (x.o.boulder) return [{...x.part("bigrockdamage","magic"), label:"Boulder (Worked Ground: 180%)"}];
        const p=x.part("rockdamage","magic"), n=x.o.shards, k=1-(x.dv("extramissilereduceddamagepercent")??60)/100, m=1+k*(n-1);
        return [n===1 ? p : {...p, v:p.v*m, s:`(${p.s}) × (1 + ${fmt(k)} × ${n-1})`, label:`${n} Stone Shards (the first full, the rest ${fmt(k*100)}%)`}]; }},
    W: {none:"Seismic Shove has no damage: 0.5 s after the cast it knocks enemies 400 units over 1 s; over Unraveled Earth's stones they detonate (fight())"},
    // Unraveled Earth: the eruption, then the stones detonate under a target dashing or knocked over them: up to 4, each −25% after the
    // first (game data MineDamageFalloff): 1 + 0.75 + 0.5 + 0.25 = ×2.5
    E: {opts:{stones:{min:0, max:4, dflt:4, what:"stones detonated by the target displaced over them (Seismic Shove; −25% each after the first)"}},
      parts(x){ const r=[x.part("scatterdamage","magic")], n=x.o.stones; if (n>0){ const d=x.part("detonationdamage","magic"), f=x.dv("minedamagefalloff")??0.25, m=Array.from({length:n},(_,i)=>1-f*i).reduce((s,v)=>s+v,0);
        r.push({...d, v:d.v*m, s:`(${d.s}) × ${fmt(m)}`, label:`${n} stone${n>1?"s":""} detonated (−${fmt(f*100)}% each after the first)`, later:"stones"}); } return r; }},
    R: {none:"Weaver's Wall has no damage"},
    cc: {Q:(S,r)=>[{type:"slow", pct:dvOf(S,"slowpercent",r)||0.4, dur:dvOf(S,"slowduration",r)||1.5, src:{pct:"dv:SlowPercent", dur:"dv:SlowDuration"}, text:"only the Boulder (a cast on Worked Ground) slows; the 3 s stun is for monsters"}],
         W:(S,r)=>[{type:"knockback", dist:dvOf(S,"throwdistance",r)||400, dur:1, src:{dist:"dv:ThrowDistance", dur:"wiki"}, text:"knocked 400 units over 1 s, 0.5 s after the cast (game data KnockupDelay)"}],
         E:(S,r)=>[{type:"slow", pct:dvOf(S,"slowpercent",r)||0.2, dur:dvOf(S,"minelifetime",r)||4, src:{pct:"dv:SlowPercent", dur:"dv:MineLifetime"}, text:"slowed 20% in the stones (assumed to stay their 4 s)"},
                   {type:"stun", dur:dvOf(S,"stunduration",r)||0.75, src:{dur:"dv:StunDuration"}, text:"stunned 0.75 s when displaced over the stones (fight(): Seismic Shove)"}]},
  },
  Aatrox: {
    // Deathbringer Stance: 4–10% of the target's maximum health by level (game data PDamage), bonus magic, on an empowered attack
    P: {parts(x){ return [{...x.part("pdamage","magic",null,x.P,1), pctOf:"max", label:"Deathbringer Stance: an empowered attack (maximum health; cooldown 22–10 s by level)", later:"attack"}]; }},
    // The Darkin Blade: 3 casts, each +25% (game data QRampBonus); the sweetspot +75% (QSweetSpotBonus) and a 0.25 s knock-up
    Q: {opts:{casts:{min:1, max:3, dflt:3, what:"casts (each +25% over the one before)"}, sweetspot:{bool:true, dflt:true, what:"every cast hits with the sweetspot (+75%, knock-up 0.25 s)"}},
      parts(x){ const p=x.part("qdamage","physical"), ramp=x.dv("qrampbonus")??0.25, ss=1+(x.dv("qsweetspotbonus")??0.75);
        if (x.u){ const R=x.u.kit.recastQ, n=(R && R.until>x.u.kitT ? R.n : 0)+1, m=(1+ramp*(n-1))*ss; return [{...p, v:p.v*m, s:`(${p.s}) × ${fmt(1+ramp*(n-1))} × ${fmt(ss)}`, label:`cast ${n} (sweetspot)`}]; }
        const n=x.o.casts, m=Array.from({length:n},(_,i)=>1+ramp*i).reduce((s,v)=>s+v,0)*(x.o.sweetspot ? ss : 1);
        return [{...p, v:p.v*m, s:`(${p.s}) × ${fmt(m)}`, label:`${n} cast${n>1?"s":""}${x.o.sweetspot?" in the sweetspot":""}`}]; }},
    // Infernal Chains: the same damage again when the tether holds 1.5 s
    W: {opts:{tether:{bool:true, dflt:true, what:"the tether held 1.5 s: the same damage again and the pull"}},
      parts(x){ const p=x.part("wdamage","physical"); return x.o.tether ? [p, {...p, label:"tether held 1.5 s: the same damage again", later:"tether"}] : [p]; }},
    E: {none:"Umbral Dash has no damage: a dash that resets his attack; its passive heals 16% (+1.3% per 100 bonus health) of his damage to champions"},
    R: {parts(x){ x.note(`World Ender deals no damage: +${fmt((x.dv("rtotaladamp")||0)*100)}% AD and +${fmt((x.dv("rhealingamp")||0)*100)}% healing for 10 s (fight())`);
      return [{label:"World Ender (no damage: AD, healing and move speed for 10 s)", v:0, s:"0", type:"physical", later:"buff"}]; }},
    cc: {W:(S,r)=>[{type:"slow", pct:-(dvOf(S,"wslowpercentage",r)||-0.35), dur:dvOf(S,"wslowduration",r)||1.5, src:{pct:"dv:WSlowPercentage", dur:"dv:WSlowDuration"}, text:"slowed 1.5 s"},
                   {type:"knockup", dur:0.5, src:{dur:"wiki"}, text:"pulled back to the spot 1.5 s later if the tether holds (airborne time not in the data or the wiki: 0.5 s assumed)"}],
         R:()=>[]},
  },
  Seraphine: {
    P: {parts(x){ return [{...x.part("autodamage","magic",null,x.P,1), label:"Stage Presence: one Note (one per ability cast, up to 4; her next attack fires them all)", later:"attack"}]; }},
    // High Note: +1% per 1% of the target's missing health, up to +75% (game data DamageAmp 75, ExecuteThreshold 0.25)
    Q: {opts:{missing:{min:0, max:100, dflt:0, what:"the target's missing health in % (+1% damage per 1%, up to +75%)"}},
      parts(x){ const p=x.part("explosiondamage","magic"), cap=(x.dv("damageamp")??75)/100;
        if (x.u) return [{...p, ampMissing:1, ampCap:cap}];
        const m=Math.min(cap, x.o.missing/100); return [m>0 ? {...scale(p, 1+m, `(${fmt(m*100)}% missing health)`), label:`High Note (${fmt(x.o.missing)}% missing health)`} : p]; }},
    // Beat Drop: slow 99%; also root an already slowed target, stun an already immobilized one (same duration). Encore: charm 1.25–1.75 s
    // (game data RChannelDuration; wiki disable duration)
    cc: {E:(S,r)=>{ const d=dvOf(S,"slowduration",r)||1.5; return [{type:"slow", pct:(dvOf(S,"slowvalue",r)||99)/100, dur:d, src:{pct:"dv:SlowValue", dur:"dv:SlowDuration"}, text:"slowed 99%"},
                   {type:"root", dur:d, src:{dur:"dv:SlowDuration"}, text:"rooted too if already slowed (fight())"}, {type:"stun", dur:d, src:{dur:"dv:SlowDuration"}, text:"stunned too if already immobilized or grounded (fight())"}]; },
         R:(S,r)=>[{type:"charm", dur:dvOf(S,"rchannelduration",r)||1.75, src:{dur:"dv:RChannelDuration"}, text:"charmed 1.25/1.5/1.75 s (game data RChannelDuration; the wiki's disable duration agrees)"}]},
  },
  Senna: {
    stacks: {name:"Mist", max:Infinity, dflt:()=>0, why:"from Absolution: souls and mark consumptions; the practice tool starts at 0"},
    // Mist (game data P): +0.75 AD per stack; every 20: +20 range and +10% crit (crit above 100% → 0.35% life steal per 1%). Her crits deal
    // ×0.8 (game data CritDamageMod; wiki crit_mod)
    statsFinal(c, st, notes){ const n=kitStacks(c), P=CALC.champs.Senna.P; st.critdmg*=dvOf(P,"critdamagemod",1)??0.8;
      if (!(n>0)) return; const ad=n*(dvOf(P,"adperstack",1)||0.75), k=Math.floor(n/(dvOf(P,"stacksforbonus",1)||20)), cr=st.crit+k*(dvOf(P,"bonuscritchance",1)||10)/100;
      st.bonusad+=ad; st.ad+=ad; st.range+=k*(dvOf(P,"bonusrange",1)||20); st.crit=Math.min(1,cr); if (cr>1) st.lifesteal+=(cr-1)*(dvOf(P,"crittolifestealconversionpercent",1)??0.35);
      notes.push(`Senna: ${fmt(n)} Mist: +${fmt(ad)} AD${k?`, +${fmt(k*20)} range, +${fmt(k*10)}% crit`:""}`); },
    P: {parts(x){ return [{...x.part("bonusonhitdamage","physical",null,x.P,1), label:"Relic Cannon: 20% AD bonus physical on her attacks (Absolution's 1–10% current health in fight())", later:"attack"}]; }},
    E: {none:"Curse of the Black Mist has no damage: camouflage and move speed"},
  },
  Nami: {
    P: {none:"Surging Tides has no damage: allied move speed"},
    // Tidecaller's Blessing: 3 empowered attacks or ability casts of the blessed ally (or Nami) within 6 s
    E: {opts:{hits:{min:1, max:3, dflt:3, what:"empowered attacks or ability casts that hit (3 within 6 s)"}},
      parts(x){ return [{...scale(x.part("totaldamage","magic"), x.o.hits, "hits"), label:`Tidecaller's Blessing: ${x.o.hits} empowered hit${x.o.hits>1?"s":""} (the blessed ally's attacks or abilities)`, later:"bless"}]; }},
    // Aqua Prison: suspension 1.5 s (airborne: wiki; game data StunDuration); Tidal Wave: knock-up 0.5 s, slow 70% for 2 s + 0.002 s per
    // unit travelled, up to 4 s (game data MinSlowDuration, DistToSlowRatio, MaxSlowDuration; wiki "2 to 4")
    cc: {Q:(S,r)=>[{type:"knockup", dur:dvOf(S,"stunduration",r)||1.5, src:{dur:"dv:StunDuration"}, text:"suspended 1.5 s (airborne: tenacity doesn't apply)"}],
         R:(S,r)=>[{type:"knockup", dur:dvOf(S,"knockupduration",r)||0.5, src:{dur:"dv:KnockupDuration"}, text:"knocked up 0.5 s"},
                   {type:"slow", pct:(dvOf(S,"slowamount",r)||70)/100, dur:dvOf(S,"maxslowduration",r)||4, src:{pct:"dv:SlowAmount", dur:"dv:MaxSlowDuration"}, text:"slowed 70% for 2 s + 0.002 s per unit travelled, up to 4 s (fight(): by distance)"}]},
  },
  Janna: { rankStats:true,
    // Zephyr passive: +6–10% (+2% per 100 AP) move speed (game data MSPercent, MSAPRatio); Tailwind: 30% of her bonus move speed as magic on-hit
    statsFinal(c, st, notes){ const r=rankOf(c,"W"); if (!r) return; const S=CALC.champs.Janna.W, p=(dvOf(S,"mspercent",r)||0)+(dvOf(S,"msapratio",r)||0)*st.ap;
      st.mspct+=p; st.msuncapped=st.msraw*(1+st.mspct); st.ms=msCap(st.msuncapped); st.bonusms=st.ms-st.basems;
      notes.push(`Janna: Zephyr passive +${fmt(p*100)}% move speed (W rank ${r})`); },
    P: {parts(x){ return [{...x.part("bonusdamage","magic",null,x.P,1), label:"Tailwind: 30% of her bonus move speed as magic on her attacks", later:"attack"}]; }},
    // Howling Gale: +10–30 (+10% AP) per second charged, up to 3 s (fight() casts it uncharged)
    Q: {opts:{seconds:{min:0, max:3, dflt:0, what:"seconds charged (+damage and knock-up per second; fight() casts it uncharged)"}},
      parts(x){ const p=x.part("minimumdamage","magic"), s=x.o.seconds; return s ? [p, scale(x.part("extradamagepersecondcharged","magic"), s, "seconds charged")] : [p]; }},
  },
  Vladimir: {
    // Crimson Pact (wiki; game data HPforAP 30, APRatioBonusHP 1.6): +1 AP per 30 bonus health and +1.6 bonus health per AP. The two
    // don't feed each other; Rabadon's amplification of the pact's AP counts toward the health (wiki notes)
    stats(c, st, notes, e){ const P=CALC.champs.Vladimir.P, k=dvOf(P,"hpforap",1)||30, f=dvOf(P,"apratiobonushp",1)||1.6, h0=st.bonushp, base=h0/k, ap=base*(1+e.amp), hp=f*(st.ap+ap-base);
      if (!(ap>0) && !(hp>0)) return; st.ap+=ap; st.bonushp+=hp; notes.push(`Vladimir: Crimson Pact +${fmt(ap)} AP (1 per ${fmt(k)} bonus health) and +${fmt(hp)} health (${fmt(f)} per AP)`); },
    P: {none:"Crimson Pact has no damage: AP from bonus health and bonus health from AP (in his stats)"},
    // Transfusion at 2 Fury: ×1.85 damage (game data DamagePercentAmp 85) and extra healing
    Q: {opts:{empowered:{bool:true, dflt:false, what:"the empowered cast at 2 Fury (×1.85; every other cast after the first two)"}},
      sim:(u)=>({empowered:(u.kit.fury||0)>=2 && u.kit.surge>u.kitT}),
      parts(x){ return [x.o.empowered ? {...x.part("empowereddamagetooltip","magic"), label:"Transfusion (empowered, ×1.85)"} : x.part("basedamagetooltip","magic")]; }},
    // Tides of Blood charged 1 s: the maximum (60–180 + 6% maximum health + 80% AP) and the slow
    E: {opts:{charged:{bool:true, dflt:true, what:"charged the full 1 s (maximum damage and the slow)"}},
      parts(x){ return [x.o.charged ? {...x.part("maxdamagetooltip","magic"), label:"Tides of Blood (charged 1 s)"} : x.part("mindamagetooltip","magic")]; }},
    cc: {W:(S,r)=>[{type:"slow", pct:-(dvOf(S,"movespeedmod",r)||-0.4), dur:2, src:{pct:"dv:MoveSpeedMod", dur:"wiki"}, text:"slowed 40% in the pool (assumed to stay the 2 s)"}],
         E:(S,r)=>[{type:"slow", pct:(dvOf(S,"slowpercent",r)||60)/100, dur:0.5, src:{pct:"dv:SlowPercent", dur:"wiki"}, text:"slowed 0.5 s when charged 1 s (the 20% slow is on Vladimir while he charges)"}]},
  },
  Khazix: {
    evolved: {slots:"QWER", name:"evolutions", why:"one per R rank (levels 6/11/16); default Q, then E, then R", dflt:(c)=>"QER".slice(0, rankOf(c,"R"))},
    P: {parts(x){ return [{...x.part("totaldamage","magic",null,x.P,1), label:"Unseen Threat: his next attack on a champion after being unseen (slows 25% for 2 s)", later:"attack"}]; }},
    Q: {opts:{isolated:{bool:true, dflt:true, what:"the target is isolated (no other enemy within 375: ×2.1)"}}, sim:()=>({isolated:true}),
      parts(x){ return [x.o.isolated ? {...x.part("spell.khazixq:isodamage","physical"), label:"Taste Their Fear (isolated target, ×2.1)"} : x.part("spell.khazixq:basedamage","physical")]; }},
    R: {parts(x){ return [{label:"Void Assault (no damage: invisible, then Unseen Threat)", v:0, s:"0", type:"physical", later:"stealth"}]; }},
    cc: {W:(S,r,c)=>kitEvolved(c).includes("W") ? [{type:"slow", pct:(dvOf(S,"slowpercentage",r)||40)/100, dur:dvOf(S,"slowduration",r)||2.25, src:{pct:"dv:SlowPercentage", dur:"dv:SlowDuration"}, text:"Evolved Spike Racks slows 40% (60% isolated) for 2.25 s"}] : []},
  },
  Shen: {
    P: {none:"Ki Barrier has no damage: a shield after his abilities (fight())"},
    // Twilight Assault: 3 empowered attacks: 10–40 by level + 2–4% (+1.5% per 100 AP) maximum health, or 5–7% (+2% per 100 AP) when the
    // Spirit Blade passed through an enemy champion (game data BasePercentDamage, EnhancedPercentDamage)
    Q: {opts:{attacks:{min:1, max:3, dflt:3, what:"empowered attacks (3 within 8 s)"}, champion:{bool:true, dflt:true, what:"the Spirit Blade passed through an enemy champion (5–7% instead of 2–4%, +50% attack speed)"}},
      parts(x){ const n=x.o.attacks, f=x.part("baseflatdamage","magic"), p=x.part(x.o.champion ? "emppercenthealth" : "basepercenthealth","magic");
        return [{...scale(f, n, "attacks"), later:"attack"}, {...scale(p, n, "attacks"), pctOf:"max", later:"attack"}]; }},
    W: {parts(x){ return [{label:"Spirit's Refuge (no damage: blocks attacks for 1.75 s)", v:0, s:"0", type:"magic", later:"block"}]; }},
  },
  /* ---- champion audit batch 6 (2026-09-24): the next most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<ability> and the game files (data/raw/cdragon_bins); game files win where they disagree ---- */
  Blitzcrank: {
    P: {none:"Mana Barrier has no damage: a shield of 35% of his maximum mana when damage takes him below 30% health (90 s; fight())"},
    W: {none:"Overdrive has no damage: +30–70% attack speed for 5 s and move speed decaying to 10%; the 30% slow when it ends is on Blitzcrank"},
    // Power Fist: the empowered attack deals 200% AD (+25% AP) in all (game data TotalDamage = 2 × AD + 25% AP; wiki "100% AD bonus"),
    // crit-affected; knock-up 1 s (game data CCDuration)
    E: {parts(x){ return [{...x.part("totaldamage","physical"), label:"Power Fist: the empowered attack in all (the attack + 100% AD + 25% AP bonus)", later:"attack"}]; }},
    // Static Field active; its passive (a lightning strike 1 s after each attack while R is off cooldown) is dealt in fight()
    R: {parts(x){ x.note(`passive while R is off cooldown: each attack calls a lightning strike 1 s later for ${fmt(x.part("passivedamage","magic").v)} magic (fight())`); return [x.part("activedamage","magic")]; }},
    cc: {W:()=>[], E:(S,r)=>[{type:"knockup", dur:dvOf(S,"ccduration",r)||1, src:{dur:"dv:CCDuration"}, text:"knocked up 1 s by the empowered attack"}]},
  },
  Irelia: {
    // Ionian Fervor at 4 stacks: 10–61 by level (+20% bonus AD) bonus magic on her attacks (game data OnHitBonus)
    P: {parts(x){ return [{...kitIreliaOnHit(x.st), label:"Ionian Fervor at 4 stacks: bonus magic on each attack", later:"attack"}]; }},
    // Defiant Dance charged 0.75 s: ×3 (game data MaxDamageCalc 30–150 + 120% AD + 150% AP; wiki maximum)
    W: {opts:{charged:{bool:true, dflt:true, what:"charged the full 0.75 s (×3: the maximum)"}},
      parts(x){ return [x.o.charged ? {...x.part("maxdamagecalc","physical"), label:"Defiant Dance (charged 0.75 s, maximum)"} : x.part("mindamagecalc","physical")]; }},
  },
  Naafiri: {
    // We Are More: Packmates (2 → 5 by level: +1 at 9, 12, 15; game data PackmateCap) attack with her: 10–20 by level (+4% bonus AD) physical
    // each (game data PackmateTotalDamage); ×1.3 on their next attack after one of her abilities
    P: {opts:{packmates:{min:0, max:7, dflt:(x)=>x.ev("packmatecap", x.P, 1).v, what:"Packmates attacking (2–5 by level, +2 during The Call of the Pack)"}},
      parts(x){ const n=x.o.packmates; return [{...scale(x.part("packmatetotaldamage","physical",null,x.P,1), n, "Packmates"), label:`${n} Packmate attacks (one each, with her attack)`, later:"attack"}]; }},
    // Darkin Daggers: the dagger + the bleed (5 s), then the recast on the bleeding target: the rest of the bleed + 30–80 (+40% bonus AD),
    // the base +1% and the ratio +2.5% per 1% missing health (game data SecondCastMaxADRatio 0.7 × ExecuteMultiplier 2: 60–160 + 140%)
    Q: {opts:{recast:{bool:true, dflt:true, what:"the recast on the bleeding target (the rest of the bleed + bonus)"}, missing:{min:0, max:100, dflt:0, what:"the target's missing health in % when the recast lands"}},
      parts(x){ const r=[x.part("totaldamagefirstcast","physical"), {...x.part("totalbleeddamage","physical"), label:"bleed over 5 s (the recast deals what is left at once)", later:"bleed"}];
        if (x.o.recast){ const m=Math.min(1, x.o.missing/100), b=x.dv("basedamagesecondcast"), k=x.dv("secondcastbonusadratio"), v=b*(1+m)+k*(1+2.5*m)*x.st.bonusad;
          r.push({label:`recast bonus (${fmt(x.o.missing)}% missing health)`, v, s:`${fmt(b)} × ${fmt(1+m)} + ${fmt(k*(1+2.5*m))} × bonus AD ${fmt(x.st.bonusad)}`, type:"physical", later:"recast"}); }
        return r; }},
    W: {parts(x){ x.note(`The Call of the Pack deals no damage: +${fmt((x.dv("naafiriadpercentboost")||0.2)*100)}% AD, 2 more Packmates after 1.25 s and move speed for 5 s; untargetable for the first 1 s (fight())`);
      return [{label:"The Call of the Pack (no damage: +20% AD and 2 Packmates for 5 s)", v:0, s:"0", type:"physical", later:"buff"}]; }},
    // Eviscerate: the dash (15–55 +40% bonus AD) and the flurry on arrival (60–160 +80% bonus AD), both on the target (wiki; game data)
    E: {opts:{flurry:{bool:true, dflt:true, what:"the flurry on arrival hits the target too"}},
      parts(x){ const r=[x.part("totaldamagefirstslash","physical")]; if (x.o.flurry) r.push({...x.part("totaldamagesecondslash","physical"), label:"flurry on arrival"}); return r; }},
    // Hounds' Pursuit: Naafiri's hit + each Packmate's 10% of it (game data PackmateModifier)
    R: {opts:{packmates:{min:0, max:7, dflt:(x)=>x.ev("packmatecap", x.P, 1).v, what:"Packmates that charge with her (10% of her damage each)"}},
      parts(x){ const r=[x.part("totaldamage","physical")], n=x.o.packmates; if (n>0) r.push({...scale(x.part("packmatedamage","physical"), n, "Packmates"), label:`${n} Packmates (10% each)`}); return r; }},
  },
  Rakan: {
    P: {none:"Fey Feathers has no damage: a shield (30–225 by level + 95% AP) that lasts until broken; ready at the start, again 40 − 1.5 per level s later (−1 s per champion hit) (fight())"},
    // The Quickness: charm 1–1.5 s and a 75% slow for the same time (wiki); game data CharmDuration
    cc: {R:(S,r)=>{ const d=dvOf(S,"charmduration",r)||1.5; return [{type:"charm", dur:d, src:{dur:"dv:CharmDuration"}, text:"charmed 1/1.25/1.5 s"}, {type:"slow", pct:0.75, dur:d, src:{pct:"wiki", dur:"dv:CharmDuration"}, text:"slowed 75% while charmed"}]; }},
  },
  Anivia: {
    P: {none:"Rebirth has no damage: fatal damage turns her into an egg for 6 s at full health (+bonus resistances; 240 s; fight())"},
    // Flash Frost: the pass-through (50–130 +25% AP) and the detonation (60–200 +45% AP) on the same target (perfect recast; wiki Total)
    Q: {opts:{detonate:{bool:true, dflt:true, what:"recast on the target: the detonation (damage and the stun)"}},
      parts(x){ const r=[x.part("totalpassthroughdamage","magic")]; if (x.o.detonate) r.push({...x.part("totalexplosiondamage","magic"), label:"detonation (recast on the target)"}); return r; }},
    // Frostbite: double on an Iced target (hit by Flash Frost or the fully formed Glacial Storm in the last 3 s)
    E: {opts:{iced:{bool:true, dflt:true, what:"the target is Iced (Flash Frost or a fully formed Glacial Storm): double damage"}}, sim:()=>({iced:false}),
      parts(x){ return [x.o.iced ? {...x.part("empowereddamage","magic"), label:"Frostbite on an Iced target (×2)"} : x.part("totaldamage","magic")]; }},
    // Glacial Storm: a tick every 0.5 s (half the damage per second); while it forms (1.5 s) 3 half ticks (wiki notes: 1.5 ticks in all),
    // then ×3 (game data BonusMultiplier 300)
    R: {opts:{seconds:{min:0, max:30, dflt:3, what:"seconds the target stays in the storm (1.5 s forming, then empowered ×3 ticks every 0.5 s)"}},
      parts(x){ const tk=x.part("totaldamagepersecond","magic"), per=tk.v/2, s=x.o.seconds, form=1.5*per*Math.min(1, s/1.5), n=Math.max(0, Math.floor((s-1.5)/0.5+1e-9));
        return [{label:`Glacial Storm: ${fmt(s)} s (forming 1.5 half ticks, then ${n} empowered ticks)`, v:form+n*3*per, s:`(${tk.s}) / 2 × (${fmt(1.5*Math.min(1,s/1.5))} + 3 × ${n})`, type:"magic"}]; }},
    // Flash Frost slows 20% + 10% per Glacial Storm rank after the first (game data R SlowAmount; wiki) for 3 s; Crystallize knocks
    // champions 120 units (game data ChampPushDistance; the wall itself isn't modelled)
    cc: {Q:(S,r,c)=>{ const R=CALC.champs.Anivia.R, rr=c ? rankOf(c,"R") : 0; return [{type:"stun", dur:dvOf(S,"stunduration",r)||1.5, src:{dur:"dv:StunDuration"}, text:"stunned by the detonation"},
           {type:"slow", pct:(dvOf(R,"slowamount",Math.max(1,rr))||20)/100, dur:dvOf(S,"slowduration",r)||3, src:{pct:"dv:R SlowAmount", dur:"dv:SlowDuration"}, text:"slowed 20% + 10% per Glacial Storm rank after the first, 3 s"}]; },
         W:(S,r)=>[{type:"knockback", dist:dvOf(S,"champpushdistance",r)||120, src:{dist:"dv:ChampPushDistance"}, text:"knocked 120 units aside by the wall (the wall isn't modelled)"}]},
  },
  Renekton: {
    P: {none:"Reign of Anger has no damage: Fury (fight(): 5 per attack, 10 per champion hit by Q/W/E, ×1.5 below 50% health); at 50 his next Q or W, or the E recast, is empowered"},
    Q: {opts:{empowered:{bool:true, dflt:false, what:"empowered at 50 Fury (90–270 + 140% bonus AD)"}}, sim:(u)=>({empowered:(u.kit.fury||0)>=50}),
      parts(x){ return [x.o.empowered ? {...x.part("empdamage","physical"), label:"Cull the Meek (empowered)"} : x.part("basicdamage","physical")]; }},
    // Ruthless Predator: his next attack strikes twice (3 times empowered: shields broken, stun 1.5 s), each 5–65 (+75% AD)
    W: {opts:{empowered:{bool:true, dflt:false, what:"empowered at 50 Fury (3 strikes, stun 1.5 s)"}}, sim:(u)=>({empowered:(u.kit.fury||0)>=50}),
      parts(x){ return [x.o.empowered ? {...x.part("emptotaldamage","physical"), label:"Ruthless Predator (empowered, 3 strikes)"} : {...x.part("basictotaldamage","physical"), label:"Ruthless Predator (2 strikes)"}]; }},
    // Slice and Dice: the dash, then the recast (Dice) within 4 s; the empowered Dice adds 70–250 (+135% bonus AD) and −25–35% armor 4 s
    E: {opts:{recast:{bool:true, dflt:true, what:"the recast (Dice) within 4 s"}, empowered:{bool:true, dflt:false, what:"Dice empowered at 50 Fury (+70–250 + 135% bonus AD, armor reduction)"}},
      sim:(u)=>({recast:false, empowered:false}),
      parts(x){ if (x.u){ const R=x.u.kit.recastE, n=(R && R.until>x.u.kitT ? R.n : 0)+1, r=[{...x.part("basicdamage","physical"), label:n>1?"Dice (recast)":"Slice"}];
          if (n>1 && (x.u.kit.fury||0)>=50) r.push({...x.part("empdamage","physical"), label:"Dice empowered (50 Fury)"}); return r; }
        const r=[{...x.part("basicdamage","physical"), label:"Slice"}]; if (x.o.recast){ r.push({...x.part("basicdamage","physical"), label:"Dice (recast)"}); if (x.o.empowered) r.push({...x.part("empdamage","physical"), label:"Dice empowered (50 Fury)"}); } return r; }},
    // Dominus: 15 s, a tick every 0.5 s to enemies within 375: 30–120 (+5% bonus AD +5% AP) (game data AuraDamagePerSecond / 2); wiki Total ×30
    R: {opts:{seconds:{min:0, max:15, dflt:15, what:"seconds the target stays within 375 (a tick every 0.5 s)"}},
      parts(x){ const p=x.part("totaldamagepersecond","magic"), n=Math.floor(x.o.seconds*2+1e-9); return [{label:`Dominus: ${n} ticks (${fmt(x.o.seconds)} s)`, v:p.v/2*n, s:`(${p.s}) / 2 × ${n} ticks`, type:"magic"}]; }},
    cc: {W:(S,r)=>[{type:"stun", dur:dvOf(S,"stunduration",r)||0.75, src:{dur:"dv:StunDuration"}, text:"stunned 0.75 s (1.5 s empowered: fight())"}]},
  },
  Fiora: {
    // Duelist's Dance: a Vital deals 3% (+4% per 100 bonus AD) of maximum health true damage and heals 35–100 by level
    P: {parts(x){ return [{...x.part("passivedamagetotal","true",null,x.P,1), pctOf:"max", label:"a Vital (fight(): one every 1.75 s, perfect positioning)", later:"vital"}]; }},
    // Bladework: the two empowered attacks: 100% AD (no crit, slows 30% 1 s) and 160–200% AD (a guaranteed crit; game data
    // AttackOnePercentTAD, AttackTwoPercentTAD), +50–90% attack speed
    E: {opts:{attacks:{min:1, max:2, dflt:2, what:"empowered attacks (the second is a 160–200% AD crit)"}},
      parts(x){ const ad=x.st.ad, a1=x.dv("attackonepercenttad")||1, a2=x.dv("attacktwopercenttad")||2, k=(x.st.critdmg||2)/2, r=[{label:"first empowered attack (no crit)", v:ad*a1, s:`${fmt(a1)} × AD ${fmt(ad)}`, type:"physical", later:"attack"}];
        if (x.o.attacks>1) r.push({label:`second empowered attack (${fmt(a2*100)}% AD crit${k!==1?`, × ${fmt(k)} crit damage items`:""})`, v:ad*a2*k, s:`${fmt(a2)} × AD ${fmt(ad)}${k!==1?` × ${fmt(k)}`:""}`, type:"physical", later:"attack"}); return r; }},
    // Riposte: slow 50% and cripple 25% for 2 s (game data MSSlowPercent −0.5, AttackSlowPercent; the wiki says 25% slow); a stun for the
    // same 2 s only if it parried an immobilizing effect (fight())
    // Grand Challenge: the 4 Vitals (3% each: 12% of maximum health); fight() deals them through Duelist's Dance, one per hit
    R: {parts(x){ return [{...scale(x.part("passivedamagetotal","true",null,x.P,1), 4, "Vitals"), pctOf:"max", label:"Grand Challenge: 4 Vitals (fight(): one per hit after 0.5 s, 8 s)", later:"vitals"}]; }},
    cc: {W:(S,r)=>[{type:"slow", pct:-(dvOf(S,"msslowpercent",r)||-0.5), dur:dvOf(S,"ccduration",r)||2, src:{pct:"dv:MSSlowPercent", dur:"dv:CCDuration"}, text:"slowed 50% 2 s (a stun instead if Riposte parried an immobilizing effect: fight())"}]},
  },
  Orianna: {
    // Clockwork Windup: 10–50 by level (+15% AP) magic on each attack, +15% per consecutive attack on the same target (2 stacks, 4 s)
    P: {opts:{stacks:{min:0, max:2, dflt:0, what:"Clockwork Winding stacks from her last attacks on this target (+15% each)"}},
      parts(x){ const p=x.part("totaldamage","magic",null,x.P,1), m=1+(dvOf(x.P,"stackmult",1)||0.15)*x.o.stacks; return [{...(m===1 ? p : scale(p, m, `(${x.o.stacks} stacks)`)), label:"Clockwork Windup: bonus magic on each attack", later:"attack"}]; }},
    // Command: Dissonance: slow 20–40% decaying over 2 s (game data SlowAmount, SlowAndHasteDuration)
    cc: {W:(S,r)=>[{type:"slow", pct:dvOf(S,"slowamount",r)||0.4, dur:dvOf(S,"slowandhasteduration",r)||2, decay:true, src:{pct:"dv:SlowAmount", dur:"dv:SlowAndHasteDuration"}, text:"slowed 20–40% decaying over 2 s"}]},
  },
  Lux: {
    // Illumination: her ability hits mark the target 6 s; her next attack or Final Spark deals 30–200 by level (+35% AP) and consumes it
    P: {parts(x){ return [{...x.part("totaldamage","magic",null,x.P,1), label:"Illumination: consumed by her next attack or Final Spark (fight())", later:"attack"}]; }},
    // Lucent Singularity: slow 25–45% (game data SlowPercent), 1 s after the detonation (the zone's slow while inside isn't modelled)
    cc: {E:(S,r)=>[{type:"slow", pct:(dvOf(S,"slowpercent",r)||45)/100, dur:dvOf(S,"slowlingerduration",r)||1, src:{pct:"dv:SlowPercent", dur:"dv:SlowLingerDuration"}, text:"slowed 25–45% for 1 s by the detonation"}]},
  },
  Rengar: {
    // Bonetooth Necklace: Trophies give (Trophies)² % bonus AD (wiki), up to 6 with the Head of Kha'Zix
    stacks: {name:"Bonetooth Necklace trophies", max:6, dflt:()=>0, why:"one per unique champion takedown (up to 5, 6 with the Head of Kha'Zix); none in the practice tool"},
    statsFinal(c, st, notes){ const n=kitStacks(c); if (!(n>0)) return; const add=st.bonusad*n*n/100; st.bonusad+=add; st.ad+=add; notes.push(`Rengar: ${fmt(n)} trophies +${fmt(n*n)}% bonus AD (+${fmt(add)})`); },
    P: {none:"Unseen Predator has no damage: Ferocity (1 per basic ability, 4 max; fight()): at 4 his next basic ability is empowered and can be cast again"},
    // Savagery: his next attack deals 20–160 (+5% AD) more (tooltip total with the attack: AD + 20–160 + 5% AD); empowered 35–240 by level
    // (+20% AD) (game data EmpoweredQTotalDamage)
    Q: {opts:{empowered:{bool:true, dflt:false, what:"empowered at 4 Ferocity (35–240 by level + 20% AD, more attack speed)"}}, sim:(u)=>({empowered:(u.kit.ferocity||0)>=4}),
      parts(x){ return [x.o.empowered ? {...x.part("empoweredqtotaldamage","physical"), label:"Savagery empowered: the attack in all", later:"attack"} : {...x.part("qtotaldamage","physical"), label:"Savagery: the empowered attack in all", later:"attack"}]; }},
    W: {opts:{empowered:{bool:true, dflt:false, what:"empowered at 4 Ferocity (50–220 by level + 80% AP, cleanse)"}}, sim:(u)=>({empowered:(u.kit.ferocity||0)>=4}),
      parts(x){ return [x.o.empowered ? {...x.part("totaldamageempowered","magic"), label:"Battle Roar (empowered)"} : x.part("totaldamage","magic")]; }},
    E: {opts:{empowered:{bool:true, dflt:false, what:"empowered at 4 Ferocity (50–305 by level + 80% bonus AD, root)"}}, sim:(u)=>({empowered:(u.kit.ferocity||0)>=4}),
      parts(x){ return [x.o.empowered ? {...x.part("totalempowereddamage","physical"), label:"Bola Strike (empowered)"} : x.part("totaldamage","physical")]; }},
    R: {parts(x){ return [{...x.part("bonusdamage","physical"), label:"Thrill of the Hunt: his next attack +100% AD (and −15–25 armor 4 s)", later:"attack"}]; }},
    // Bola Strike: slow 30–90% 1.75 s (game data SlowAmount, CCDuration); empowered: root 1.75 s instead (fight())
    cc: {E:(S,r)=>[{type:"slow", pct:(dvOf(S,"slowamount",r)||90)/100, dur:dvOf(S,"ccduration",r)||1.75, src:{pct:"dv:SlowAmount", dur:"dv:CCDuration"}, text:"slowed 1.75 s (rooted instead when empowered: fight())"}]},
  },
  Vi: {
    P: {none:"Blast Shield has no damage: her next ability hit shields her for 10% of her maximum health (3 s; 16–12 s cooldown, −4 s per Denting Blows; fight())"},
    // Vault Breaker charged 1.25 s: ×2.5 (game data MaxDamageMult); the charge time itself isn't modelled in fight()
    Q: {opts:{charged:{bool:true, dflt:true, what:"charged the full 1.25 s (×2.5)"}},
      parts(x){ return [x.o.charged ? {...x.part("maxdamagetooltip","physical"), label:"Vault Breaker (charged 1.25 s, ×2.5)"} : x.part("totaldamage","physical")]; }},
    // Denting Blows: every third hit of her attacks (and Relentless Force) deals 4–8% (+3.5% per 100 bonus AD) of maximum health, −20% armor 4 s
    W: {parts(x){ return [{...x.part("totaldamagetooltip","physical"), pctOf:"max", label:"Denting Blows: every third attack (fight())", later:"attack"}]; }},
    // Relentless Force: her next attack deals 10–90 (+110% AD) (+100% AP) in all (game data TotalDamageTooltip), attack reset
    E: {parts(x){ return [{...x.part("totaldamagetooltip","physical"), label:"Relentless Force: the empowered attack in all", later:"attack"}]; }},
    // Vault Breaker: champions are knocked back over 0.75 s (game data KnockbackDuration; the pull is for non-champions, distance not in
    // the data); Cease and Desist: the target is knocked up 1.3 s (game data RStunDuration); the 350-unit knock aside and 0.75 s stun are
    // for enemies she dashes through
    cc: {Q:(S,r)=>[{type:"knockback", dur:dvOf(S,"knockbackduration",r)||0.75, src:{dur:"dv:KnockbackDuration"}, text:"knocked back over 0.75 s (distance not in the data)"}],
         R:(S,r)=>[{type:"knockup", dur:dvOf(S,"rstunduration",r)||1.3, src:{dur:"dv:RStunDuration"}, text:"the target is knocked up 1.3 s"}]},
  },
  /* ---- champion audit batch 7 (2026-09-24): the next most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<ability> and the game files (data/raw/cdragon_bins); game files win where they disagree ---- */
  Malphite: {
    // Thunderclap passive: + 10–30% of his armor as bonus armor (game data BonusArmorPassive), ×3 while Granite Shield holds (fight(): mod malphGS)
    statsFinal(c, st, notes, e){ const r=rankOf(c,"W"); if (!r) return; const W=CALC.champs.Malphite.W, m=e && e.m && e.m.malphGS ? (dvOf(W,"bonusarmorpassivemultiplier",r)||3) : 1, add=st.armor*(dvOf(W,"bonusarmorpassive",r)||0)*m;
      st.bonusarmor+=add; st.armor+=add; notes.push(`Malphite: Thunderclap passive +${fmt(add)} armor (${fmt(100*(dvOf(W,"bonusarmorpassive",r)||0)*m)}%${m>1?", Granite Shield up":""})`); },
    P: {none:"Granite Shield has no damage: a shield of 10% of his maximum health, again after 8/7/6 s (by level) without taking damage (fight())"},
    // Thunderclap active: his next attack + 30–70 (+20% AP +15% armor); for 5 s every attack also deals the cone, 15–55 (+30% AP +15% armor) (fight())
    W: {parts(x){ return [{...x.part("totalbonusdamage","physical"), label:"Thunderclap: his next attack's bonus (fight(): + the cone on every attack for 5 s)", later:"attack"}]; }},
    // Seismic Shard: slow 20–40% for 3 s (game data SpeedSteal, SlowDuration; he gains the speed); Ground Slam: cripple 30–50% for 3 s
    // (game data ASReduction, Duration)
    cc: {Q:(S,r)=>[{type:"slow", pct:(dvOf(S,"speedsteal",r)||40)/100, dur:dvOf(S,"slowduration",r)||3, src:{pct:"dv:SpeedSteal", dur:"dv:SlowDuration"}, text:"slowed 20–40% for 3 s (Malphite gains the speed; not modelled)"}],
         E:(S,r)=>[{type:"cripple", pct:(dvOf(S,"asreduction",r)||50)/100, dur:dvOf(S,"duration",r)||3, src:{pct:"dv:ASReduction", dur:"dv:Duration"}, text:"attack speed −30–50% for 3 s"}]},
  },
  Karthus: {
    P: {none:"Death Defied has no damage: fatal damage leaves him 7 s as a zombie (untargetable, casting; fight())"},
    // Lay Waste: ×2 when it hits only one enemy (game data QSingleTargetDamage)
    Q: {opts:{isolated:{bool:true, dflt:true, what:"hits only one enemy (×2)"}}, sim:()=>({isolated:false}),
      parts(x){ const p=x.part("qdamage","magic"); return [x.o.isolated ? {...scale(p, 2, "(one enemy hit)"), label:"Lay Waste on a lone enemy (×2)"} : p]; }},
    // Defile: a toggle; the damage per second in 4 ticks (every 0.25 s) while an enemy stays within 550
    E: {opts:{seconds:{min:0, max:60, dflt:1, what:"seconds an enemy stays in Defile (a tick every 0.25 s)"}}, sim:()=>({seconds:1}),
      parts(x){ const p=x.part("totaldps","magic"); return [{...scale(p, x.o.seconds, "s"), label:`Defile: ${fmt(x.o.seconds)} s`}]; }},
  },
  Poppy: {
    // Stubborn to a Fault (W passive): +16% total armor and magic resist, 32% below 40% health (game data PassiveResistPercent; fight(): mod poppyLow)
    statsFinal(c, st, notes, e){ const r=rankOf(c,"W"); if (!r) return; const W=CALC.champs.Poppy.W, f=(dvOf(W,"passiveresistpercent",r)||0.16)*(e && e.m && e.m.poppyLow ? 2 : 1), a=st.armor*f, m=st.mr*f;
      st.bonusarmor+=a; st.armor+=a; st.bonusmr+=m; st.mr+=m; notes.push(`Poppy: Stubborn to a Fault +${fmt(100*f)}% armor and magic resist (+${fmt(a)}, +${fmt(m)})`); },
    // Iron Ambassador: the buckler attack's bonus magic (20–180 by level); every 16/12/8 s (fight())
    P: {parts(x){ return [{...x.part("totaldamage","magic",null,x.P,1), label:"Iron Ambassador: the buckler attack's bonus (fight(): every 16/12/8 s by level)", later:"attack"}]; }},
    // Hammer Shock: the hit, then the field ruptures 1 s later for the same (game data DelayBetweenTwoHits; wiki Total ×2)
    Q: {opts:{rupture:{bool:true, dflt:true, what:"the field's rupture 1 s later (the same damage again)"}},
      parts(x){ const h=[x.part("basedamage","physical"), x.part("healthdamagepercent","physical")]; return x.o.rupture ? h.concat(h.map(p=>({...p, label:p.label+" (rupture 1 s later)", later:"rupture"}))) : h; }},
    // Steadfast Presence: the damage and crowd control only hit an enemy dashing into the aura (fight(): none at the cast)
    W: {parts(x){ return [{...x.part("interruptdamage","magic"), label:"Steadfast Presence: only to an enemy dashing into the aura (not modelled in fights)", later:"dash"}]; }},
  },
  Gangplank: {
    // Trial by Fire: the empowered attack burns 50–250 by level (+100% bonus AD) true over 2.5 s; every 15 s, reset by a keg (fight())
    P: {parts(x){ return [{...x.part("totaldamage","true",null,x.P,1), label:"Trial by Fire: the burn from his empowered attack (fight(): every 15 s)", later:"attack"}]; }},
    // Powder Keg set off by Parrrley: the shot's damage + 75–155 to champions (game data BonusDamageToChampions), ignoring 40% armor
    E: {parts(x){ const Q=CALC.champs.Gangplank.Q, qr=rankOf(x.c,"Q"), shot = qr ? x.part("shotdamage","physical",null,Q,qr) : {label:"attack", v:x.st.ad, s:`AD ${fmt(x.st.ad)}`, type:"physical", pctOf:null};
      x.note("the explosion ignores 40% of the target's armor (fight(); not in this number)"); return [{...shot, label:"the Parrrley that sets the keg off"}, {...x.part("bonusdamagetochampions","physical"), label:"bonus to champions"}]; }},
    // Cannon Barrage: 12 waves (game data TotalWavesTooltip; wiki Total)
    R: {opts:{waves:{min:1, max:18, dflt:(x)=>x.dv("totalwavestooltip")||12, what:"waves that hit the target (12; 18 with Fire at Will)"}}, sim:()=>({waves:1}),
      parts(x){ return [{...scale(x.part("onewavedamage","magic"), x.o.waves, "waves"), label:`Cannon Barrage: ${x.o.waves} waves`}]; }},
  },
  Gnar: {
    P: {none:"Rage Gene: Mega Gnar (at 100 Rage) isn't modelled; Mini Gnar's abilities only"},
    // Hyper: the third hit on a target: 0–40 (+100% AP) + 6–14% of its maximum health (game data MiniTotalDamage, MiniPercentHPDamage)
    W: {parts(x){ return [{...x.part("minitotaldamage","magic"), label:"Hyper: the third hit on a target", later:"attack"},
      {label:"Hyper: % of the target's maximum health", v:x.dv("minipercenthpdamage")||0.14, s:`${fmt(100*(x.dv("minipercenthpdamage")||0.14))}%`, type:"magic", pctOf:"max", later:"attack"}]; }},
    // Boomerang Throw: slow 15–35% 2 s (game data SlowAmount, SlowDuration); Hop: slow 80% 0.5 s (MoveSpeedMod, SlowDuration); GNAR!:
    // knocked away 500 (game data RKnockbackDistance; wiki 590), then slowed 45% for 1.25–1.75 s (RSlowPercent, RCCDuration); a stun only
    // against a wall (not on the 1-D line)
    cc: {Q:(S,r)=>[{type:"slow", pct:dvOf(S,"slowamount",r)||0.35, dur:dvOf(S,"slowduration",r)||2, src:{pct:"dv:SlowAmount", dur:"dv:SlowDuration"}, text:"slowed 15–35% for 2 s"}],
         E:(S,r)=>[{type:"slow", pct:-(dvOf(S,"movespeedmod",r)||-0.8), dur:dvOf(S,"slowduration",r)||0.5, src:{pct:"dv:MoveSpeedMod", dur:"dv:SlowDuration"}, text:"slowed 80% for 0.5 s"}],
         R:(S,r)=>[{type:"knockback", dist:dvOf(S,"rknockbackdistance",r)||500, src:{dist:"dv:RKnockbackDistance"}, text:"knocked away"},
           {type:"slow", pct:(dvOf(S,"rslowpercent",r)||45)/100, dur:dvOf(S,"rccduration",r)||1.75, src:{pct:"dv:RSlowPercent", dur:"dv:RCCDuration"}, text:"slowed 45% (a stun instead against a wall)"},
           {type:"stun", dur:dvOf(S,"rccduration",r)||1.75, cond:"terrain"}]},
  },
  Zilean: {
    // Time Warp on an enemy: slow 40–99% for 2.5 s (game data SpeedAmount, Duration)
    cc: {E:(S,r)=>[{type:"slow", pct:(dvOf(S,"speedamount",r)||99)/100, dur:dvOf(S,"duration",r)||2.5, src:{pct:"dv:SpeedAmount", dur:"dv:Duration"}, text:"slowed 40–99% for 2.5 s"}]},
  },
  Braum: {
    // Unbreakable has no damage (fight(): it blocks the first champion hit, then 35–55% less damage for 3–4 s)
    E: {parts(x){ return [{label:"Unbreakable (no damage: blocks the first hit, then less damage taken)", v:0, s:"0", type:"physical", later:"buff"}]; }},
    // Glacial Fissure: the first target knocked up 0.6 → 1–2 s by distance (game data MinKnockup, MaxKnockup); the field slows 40–60% (game
    // data MoveSpeedMod) while inside, taken as the field's 4 s (SlowZoneDuration)
    cc: {R:(S,r)=>[{type:"knockup", dur:dvOf(S,"maxknockup",r)||2, durMin:dvOf(S,"minknockup",r)||0.6, src:{dur:"dv:MaxKnockup", durMin:"dv:MinKnockup"}, text:"knocked up 0.6 s, more farther away"},
         {type:"slow", pct:(dvOf(S,"movespeedmod",r)||60)/100, dur:dvOf(S,"slowzoneduration",r)||4, src:{pct:"dv:MoveSpeedMod", dur:"dv:SlowZoneDuration"}, text:"slowed by the ice field (taken as its 4 s)"}]},
  },
  MonkeyKing: {
    // Stone Skin: +6–10 bonus armor by level (game data BonusArmor); ×6 at 5 Strength of Stone stacks (fight())
    statsFinal(c, st, notes){ const v=evalCalc({S:CALC.champs.MonkeyKing.P, rank:1, st, flags:new Set()},"bonusarmor").v; if (!(v>0)) return; st.bonusarmor+=v; st.armor+=v; notes.push(`Wukong: Stone Skin +${fmt(v)} armor`); },
    // Crushing Blow: his next attack's bonus (then −10–30% armor 3 s: fight())
    Q: {parts(x){ return [{...x.part("totaldamage","physical"), label:"Crushing Blow: his next attack's bonus (fight(): then −10–30% armor 3 s)", later:"attack"}]; }},
    // Cyclone: per cast 8–16% of the target's maximum health (+275% AD) over 2 s; the second cast (within 8 s) the same again
    R: {opts:{casts:{min:1, max:2, dflt:2, what:"Cyclone casts (the second within 8 s of the first)"}}, sim:()=>({casts:1}),
      parts(x){ const n=x.o.casts, r=[x.part("totaldamagett","physical"), x.part("percenthpdamagett","physical")]; return n===1 ? r : r.map(p=>({...scale(p, n, "casts"), pctOf:p.pctOf})); }},
  },
  Xerath: {
    // Eye of Destruction in the centre: ×1.667 (game data SweetSpotTotalDamage) and a 60–80% slow decaying over 2.5 s (SweetSpotSlowAmount)
    W: {opts:{sweetspot:{bool:true, dflt:true, what:"the target in the centre (×1.667, stronger slow)"}},
      parts(x){ return [x.o.sweetspot ? {...x.part("sweetspottotaldamage","magic"), label:"Eye of Destruction (centre)"} : x.part("totaldamage","magic")]; }},
    // Rite of the Arcane: 4/5/6 barrages (game data NumberOfShots); Arcane Perfection +20–30 (+5% AP) per stack from the second (3–5 stacks)
    R: {opts:{shots:{min:1, max:9, dflt:(x)=>x.dv("numberofshots")||6, what:"barrages that hit the target (4/5/6 by rank)"}}, sim:()=>({shots:1}),
      parts(x){ const n=x.o.shots, b=x.part("tooltiptotaldamage","magic"), g=x.part("rampdamagecalc","magic"), mx=x.rank+2; let st=0; for (let k=1;k<n;k++) st+=Math.min(k, mx);
        return [{...scale(b, n, "barrages"), label:`${n} Arcane Barrages`}, ...(st ? [{...scale(g, st, "stacks"), label:`Arcane Perfection: ${st} stacks over the later barrages`}] : [])]; }},
    cc: {W:(S,r)=>[{type:"slow", pct:dvOf(S,"sweetspotslowamount",r)||0.8, dur:dvOf(S,"slowduration",r)||2.5, decay:true, src:{pct:"dv:SweetSpotSlowAmount", dur:"dv:SlowDuration"}, text:"slowed 60–80% decaying (centre)"}]},
  },
  Draven: {
    // Spinning Axe: the empowered attack's bonus (fight(): caught axes empower again)
    Q: {parts(x){ return [{...x.part("totaldamage","physical"), label:"Spinning Axe: an empowered attack's bonus (fight(): up to 2 axes, caught 1.4 s later)", later:"attack"}]; }},
    W: {parts(x){ return [{label:"Blood Rush (no damage: +20–40% attack speed 3 s)", v:0, s:"0", type:"physical", later:"buff"}]; }},
    // Whirling Death: the axes turn back and hit again (wiki Total ×2)
    R: {opts:{recast:{bool:true, dflt:true, what:"the return pass hits the target too"}}, sim:()=>({recast:false}),
      parts(x){ const p=x.part("rcalculateddamage","physical"); return x.o.recast ? [p, {...p, label:p.label+" (return)"}] : [p]; }},
  },
  Hwei: {
    // Signature of the Visionary: a damaging ability on a target his abilities marked (4 s): 40–285 by level (+35% AP) 0.85 s later
    P: {parts(x){ return [{...x.part("totaldamage","magic",null,x.P,1), label:"Signature of the Visionary: a second ability hit on the marked target (0.85 s later)", later:"mark"}]; }},
    // Subject: Disaster: QQ Devastating Fire (default), QW Severing Bolt (×1 → ×2–3.5 by missing health), QE Molten Fissure (one explosion
    // + the fissure's 2.5 s)
    Q: {opts:{qw:{bool:true, dflt:false, what:"Severing Bolt (QW) instead of Devastating Fire"}, qe:{bool:true, dflt:false, what:"Molten Fissure (QE) instead of Devastating Fire"}, missing:{min:0, max:100, dflt:0, what:"QW: the target's missing health in %"}},
      parts(x){ if (x.o.qw){ const p=x.part("tooltip_qwdamage","magic"), mx=x.dv("tooltip_qwbonusdamagemult")||3.5, m=1+(mx-1)*Math.min(1, x.o.missing/100); return [{...(m===1?p:scale(p, m, `(${fmt(x.o.missing)}% missing health)`)), label:"QW Severing Bolt"}]; }
        if (x.o.qe){ const d=x.part("tooltip_qedamagepersecond","magic"); return [{...x.part("tooltip_qedamage","magic"), label:"QE Molten Fissure: one explosion"}, {...scale(d, 2.5, "s"), label:"QE: the fissure for 2.5 s"}]; }
        return [{...x.part("tooltip_qqdamage","magic"), label:"QQ Devastating Fire"}, {...x.part("tooltip_qqbonusdamage","magic"), pctOf:"max", label:"QQ: % maximum health"}]; }},
    // Subject: Serenity: WE Stirring Lights: his next 3 attacks or ability hits within 9 s each deal 20–60 (+15% AP)
    W: {opts:{hits:{min:0, max:3, dflt:3, what:"WE empowered attacks or ability hits (3 within 9 s)"}},
      parts(x){ return [{...scale(x.part("tooltip_weonhitdamage","magic"), x.o.hits, "hits"), label:`WE Stirring Lights: ${x.o.hits} empowered hits`, later:"attack"}]; }},
    // Subject: Torment as Grim Visage (EQ): fear 1–1.5 s (game data Tooltip_EQFleeDuration) and a 70–99% slow by distance for the same
    // time (the 70% at point blank taken; game data MinSlow/MaxSlow). (It had no crowd control: the mood spell has none of its own.)
    cc: {E:(S,r)=>{ const d=dvOf(S,"tooltip_eqfleeduration",r)||1.5; return [{type:"fear", dur:d, src:{dur:"dv:Tooltip_EQFleeDuration"}, text:"feared 1–1.5 s (EQ Grim Visage)"},
          {type:"slow", pct:0.7, dur:d, src:{pct:"wiki", dur:"dv:Tooltip_EQFleeDuration"}, text:"slowed 70% (up to 99% by distance) while feared"}]; }},
  },
  /* ---- champion audit batch 8 (2026-09-24): the next most-played champions in solo queue without a test file (draft_stats.json);
     live wiki Template:Data_<Champ>/<ability>, the game files (data/raw/cdragon_bins) and data/interactions/<Champ>.json ---- */
  Shaco: {
    // Backstab: attacks from behind + 20–35 by level (+20% bonus AD) physical (game data BasicAttackDamage; the export read the monster
    // crit tooltip). fight(): the attack out of Deceive (perfect play: from behind), crit-affected
    P: {parts(x){ return [{...x.part("basicattackdamage","physical",null,x.P,1), label:"Backstab: an attack from behind (fight(): the attack out of Deceive)", later:"attack"}]; }},
    // Deceive: the next attack + 25–65 (+60% bonus AD), critically striking for 1 + 60% × (crit damage − 1) (game data QCritDamageMod)
    Q: {parts(x){ return [{...x.part("totaldamage","physical"), label:"Deceive: his next attack's bonus (fight(): a 160% crit with Backstab)", later:"attack"}]; }},
    // Jack in the Box: one shot on a lone target 25–85 (+18% AP) (game data STDamage), 10–30 (+12% AP) when it attacks several (AoEDamage);
    // the shots every 0.5 s for 5 s aren't modelled (one shot)
    W: {opts:{isolated:{bool:true, dflt:true, what:"the box attacks only one target (STDamage)"}}, sim:()=>({isolated:false}),
      parts(x){ return [x.o.isolated ? {...x.part("stdamage","magic"), label:"Jack in the Box: a shot on a lone target"} : {...x.part("aoedamage","magic"), label:"Jack in the Box: a shot on several targets"}]; }},
    // Jack in the Box: fear 0.5–1.5 s and a root of the same length on champions (game data FearDuration; sheet); Two-Shiv Poison active:
    // slow 20–30% for 3 s (game data SlowAmount, SlowDurationActive; the 2 s is the attacks' passive slow)
    cc: {W:(S,r)=>[{type:"fear", dur:dvOf(S,"fearduration",r)||1.5, src:{dur:"dv:FearDuration"}, text:"feared 0.5–1.5 s"},
           {type:"root", dur:dvOf(S,"fearduration",r)||1.5, src:{dur:"dv:FearDuration"}, text:"rooted as long (champions)"}],
         E:(S,r)=>[{type:"slow", pct:-(dvOf(S,"slowamount",r)||-0.3), dur:dvOf(S,"slowdurationactive",r)||3, src:{pct:"dv:SlowAmount", dur:"dv:SlowDurationActive"}, text:"slowed 20–30% for 3 s"}]},
  },
  Varus: {
    // Piercing Arrow: fully charged (1.25 s) 80–360 (+120% bonus AD) (game data TotalDamageMax); uncharged two thirds (ChargeMultiplierInverse)
    Q: {opts:{charged:{bool:true, dflt:true, what:"fully charged (1.25 s; uncharged: two thirds)"}}, sim:()=>({charged:true}),
      parts(x){ return [x.o.charged ? {...x.part("totaldamagemax","physical"), label:"Piercing Arrow (fully charged)"} : {...x.part("totaldamagemintooltip","physical"), label:"Piercing Arrow (uncharged)"}]; }},
    // Blighted Quiver: his attacks deal 4–40 (+15% bonus AD) (+25% AP) bonus magic on-hit (game data OnHitDamage) and add a Blight stack
    // (6 s, 3 max); Q/E/R hits pop them: 3–5% (+1.3% per 100 AP) of maximum health each, +50% with a charged Q (fight())
    W: {parts(x){ return [{...x.part("onhitdamage","magic"), label:"Blighted Quiver: on-hit on each attack (fight(): + Blight stacks popped by Q/E/R)", later:"attack"}]; }},
    // Hail of Arrows: the field slows 25–50% for 4 s (game data SlowPercent, GroundDuration; the enemy stays in it), lingering 0.25 s after
    // leaving it (wiki notes: "Slow lingers for 0.25 seconds after leaving the marked area"; sheet 4.25), and applies Grievous Wounds (fight())
    cc: {E:(S,r)=>[{type:"slow", pct:-(dvOf(S,"slowpercent",r)||-0.5), dur:(dvOf(S,"groundduration",r)||4)+0.25, src:{pct:"dv:SlowPercent", dur:"dv:GroundDuration + 0.25 s linger (wiki)"}, text:"slowed 25–50% by the field (its 4 s + 0.25 s linger)"}]},
  },
  Darius: {
    // Apprehend passive: 20–40% armor penetration (game data PassivePercentArmorPen; multiplicative with other % penetration: wiki)
    statsFinal(c, st, notes){ const r=rankOf(c,"E"); if (!r) return; const f=(dvOf(CALC.champs.Darius.E,"passivepercentarmorpen",r)||0)/100; if (!(f>0)) return;
      st.armorpenpct=1-(1-(st.armorpenpct||0))*(1-f); notes.push(`Darius: Apprehend passive ${fmt(100*f)}% armor penetration`); },
    // Hemorrhage: one stack bleeds 13–30 by level (+30% bonus AD) physical over 5 s (game data BleedDamagePerStack); fight(): attacks, the
    // Decimate blade and Noxian Guillotine add stacks (5 max), Noxian Might at 5 on a champion
    P: {parts(x){ return [{...x.part("bleeddamageperstack","physical",null,x.P,1), label:"Hemorrhage: one stack's bleed over 5 s (fight(): up to 5 stacks)", later:"bleed"}]; }},
    // Crippling Strike: his next attack deals 140–160% AD in all (game data ADRatio): the bonus over the attack; slow 90% 1 s (EMPOWER_NEXT)
    W: {parts(x){ const m=(x.dv("adratio")||1.6)-1; return [{label:`Crippling Strike: the next attack's bonus (${fmt(100*m)}% AD)`, v:m*x.st.ad, s:`${fmt(m)} × AD ${fmt(x.st.ad)}`, type:"physical", pctOf:null}]; }},
    // Noxian Guillotine: +20% per Hemorrhage stack on the target (game data RDamagePercentPerHemoStack), ×2 at 5
    R: {opts:{stacks:{min:0, max:5, dflt:0, what:"Hemorrhage stacks on the target (+20% each)"}}, sim:()=>({stacks:0}),
      parts(x){ const p=x.part("damage","true"), n=x.o.stacks, m=1+(x.dv("rdamagepercentperhemostack")||0.2)*n; return [n ? {...scale(p, m, `(${n} Hemorrhage stacks)`), label:`Noxian Guillotine (${n} stacks)`} : p]; }},
  },
  Ashe: {
    // Frost Shot: her crits deal no bonus damage (record 1.0); instead every attack deals × (1 + crit chance × (100% + bonus crit damage))
    // (game data DamageBonus; wiki). Kept as st.asheFrost for fight()
    statsFinal(c, st, notes, e){ const cd=(e && e.it && e.it.critdmg) || 0; st.asheFrost=1+st.crit*(1+cd);
      for (let i=notes.length-1;i>=0;i--) if (/Frost Shot bonus is not modelled/.test(notes[i])) notes.splice(i, 1);
      if (st.crit>0) notes.push(`Ashe: Frost Shot — her crits deal no bonus damage; attacks deal ×${fmt(st.asheFrost)} instead (1 + crit ${fmt(st.crit)} × (1 + bonus crit damage ${fmt(cd)}))`); },
    P: {none:"Frost Shot has no damage of its own: attacks slow 20–30% by level for 2 s and deal × (1 + crit chance × (1 + bonus crit damage)) instead of critting (fight())"},
    // Ranger's Focus: each attack for 6 s is a flurry of 5 arrows for 110–130% AD in all (game data EmpoweredDamage); the first flurry
    // fires a sixth arrow: +20% (wiki notes); ready at 4 Focus stacks (fight(): no cooldown)
    Q: {simCd:()=>0.5, simCdWhy:"Ranger's Focus has no cooldown: it's ready at 4 Focus stacks (one per attack while it's inactive; fight() and perform() wait for them)",
      parts(x){ return [{...x.part("empowereddamage","physical"), label:"Ranger's Focus: each empowered attack (a flurry; fight(): the first +20%)", later:"attack"}]; }},
    // Frost Shot: slow 20–30% by level 2 s (game data SlowAmount, SlowDuration); Volley: Critical Slow 40–60% by level 2 s
    // (EmpoweredSlowAmount); Enchanted Crystal Arrow: stun 1 s up to 800 units flown, +0.25 s per 200 beyond, 3.5 s at 2800 (wiki;
    // fight(): the distance at the cast), and Frost Shot's slow around
    cc: {P:(S,r,c)=>[{type:"slow", pct:kitAsheSlow(c, false), dur:dvOf(CALC.champs.Ashe.P,"slowduration",1)||2, src:{pct:"dv:SlowAmount", dur:"dv:SlowDuration"}, text:"slowed 20–30% by level for 2 s"}],
         W:(S,r,c)=>[{type:"slow", pct:kitAsheSlow(c, true), dur:dvOf(CALC.champs.Ashe.P,"slowduration",1)||2, src:{pct:"dv:EmpoweredSlowAmount", dur:"dv:SlowDuration"}, text:"Critical Slow 40–60% by level for 2 s"}],
         R:(S,r,c)=>[{type:"stun", dur:dvOf(S,"minstunduration",r)||1, src:{dur:"dv:MinStunDuration"}, text:"stunned 1 s up to 800 units flown, +0.25 s per 200 beyond (3.5 s at 2800; fight(): by distance)"},
           {type:"slow", pct:kitAsheSlow(c, false), dur:dvOf(CALC.champs.Ashe.P,"slowduration",1)||2, src:{pct:"dv:SlowAmount", dur:"dv:SlowDuration"}, text:"Frost Shot's slow"}]},
  },
  Fizz: {
    P: {none:"Nimble Fighter has no damage: every damage instance he takes is 4 (+1% AP) lower before resistances, at most 50% (not modelled yet: needs a pre-mitigation hook in fight())"},
    // Seastone Trident: the active's bonus magic on his next attack (50–150 + 45% AP, game data ActiveDamage; attack reset), then 20–40
    // (+30% AP) on-hit for 5 s (OnHitBuffDamage); passive: his attacks bleed 30–90 (+25% AP) magic over 3 s (DoTDamage; fight())
    W: {parts(x){ return [{...x.part("activedamage","magic"), label:"Seastone Trident: his next attack's bonus (fight(): + the on-hit for 5 s; attacks bleed)", later:"attack"}]; }},
    // Chum the Waters: Guppy (lure flew < 455) ×1, Chomper (455–910) ×1.25, Gigalodon (> 910) ×1.5 (game data MidDamageMulti,
    // LargeDamageMulti; wiki); fight(): the distance to the target, slow 40/60/80% by size
    R: {opts:{distance:{min:0, max:1300, dflt:0, what:"units the lure flew (< 455 Guppy, 455–910 Chomper ×1.25, > 910 Gigalodon ×1.5)"}}, sim:()=>({distance:0}),
      parts(x){ const d=x.o.distance, p=x.part("smallsharkdamage","magic"), m=kitFizzShark(d, x.S, x.rank).m; return [m===1 ? {...p, label:"Chum the Waters (Guppy)"} : {...scale(p, m, d>910?"(Gigalodon)":"(Chomper)"), label:`Chum the Waters (${d>910?"Gigalodon":"Chomper"})`}]; }},
    // Playful: the splash slows 35–60% for 2 s (game data SlowAmount, SlowDuration)
    cc: {E:(S,r)=>[{type:"slow", pct:dvOf(S,"slowamount",r)||0.6, dur:dvOf(S,"slowduration",r)||2, src:{pct:"dv:SlowAmount", dur:"dv:SlowDuration"}, text:"slowed 35–60% for 2 s by the splash"}]},
  },
  Sion: {
    P: {none:"Glory in Death has no damage of its own: on death 1.5 s of stasis, then he fights on at full health that drains away (fight(): 100% life steal, attacks + 10% of the target's maximum health, no abilities)"},
    // Decimating Smash: 2 s charge in 0.25 s steps, base 30–90 → 90–350 and AD ratio 40–80% → 120–240% (game data LowDamage/HighDamage,
    // ADRatioMin/ADRatioMax); default: the 1 s charge of the default cast (castTime 1, its 1 s crowd control): halfway
    Q: {opts:{charged:{bool:true, dflt:null, what:"false: released at once (minimum); true: the full 2 s (maximum); default: the 1 s charge (halfway)"}}, sim:()=>({charged:null}),
      parts(x){ const c=x.o.charged; if (c===false) return [{...x.part("mindamagetotal","physical"), label:"Decimating Smash (uncharged)"}];
        if (c===true) return [{...x.part("maxdamagetotal","physical"), label:"Decimating Smash (charged 2 s)"}];
        const lo=x.part("mindamagetotal","physical"), hi=x.part("maxdamagetotal","physical"), v=(lo.v+hi.v)/2;
        return [{...lo, v, s:`(${lo.s} + ${hi.s}) / 2`, label:"Decimating Smash (charged 1 s: halfway)"}]; }},
    // Unstoppable Onslaught: 150–450 (+60% bonus AD) → 400–1200 (+120% bonus AD) after 3 s of charging (game data MaxDamageTotal)
    R: {opts:{charged:{bool:true, dflt:false, what:"charged 3 s or more (the maximum)"}}, sim:()=>({charged:false}),
      parts(x){ return [x.o.charged ? {...x.part("maxdamagetotal","physical"), label:"Unstoppable Onslaught (charged 3 s)"} : x.part("mindamagetotal","physical")]; }},
    // Roar of the Slayer on a champion: slow 35–60% 2.5 s (game data SlowAmount, SlowDuration) and −25% armor 4 s (fight()); the 0.75 s
    // stun and the 1350 knock-back are for minions and monsters only (wiki)
    cc: {E:(S,r)=>[{type:"slow", pct:(dvOf(S,"slowamount",r)||60)/100, dur:dvOf(S,"slowduration",r)||2.5, src:{pct:"dv:SlowAmount", dur:"dv:SlowDuration"}, text:"slowed 35–60% for 2.5 s (champions; −25% armor 4 s: fight())"}]},
  },
  Gragas: {
    P: {none:"Happy Hour has no damage: after an ability cast he heals 5.5% of his maximum health, every 12/10/8/6 s (levels 1/6/11/16; fight())"},
    // Barrel Roll: fermented 2 s: ×1.5 (game data MaxDamage, BarrelCookMaxAmp); default: exploded on arrival (perfect play for the hit)
    Q: {opts:{charged:{bool:true, dflt:false, what:"fermented the full 2 s (×1.5)"}}, sim:()=>({charged:false}),
      parts(x){ return [x.o.charged ? {...x.part("maxdamage","magic"), label:"Barrel Roll (fermented 2 s, ×1.5)"} : x.part("mindamage","magic")]; }},
    // Drunken Rage: after the 0.75 s drink, his next attack within 5 s deals 20–140 (+70% AP) + 7% of the target's maximum health magic
    // to enemies within 250 of the target (fight())
    W: {parts(x){ return [{...x.part("totaldamage","magic"), label:"Drunken Rage: his next attack after the 0.75 s drink", later:"attack"},
      {...x.part("maxhppercentdamage","magic"), label:"Drunken Rage: % of the target's maximum health", later:"attack"}]; }},
  },
};
/* Ashe, Frost Shot slow by level (game data SlowAmount 20–30%, EmpoweredSlowAmount 40–60% for Critical Slow; ByCharLevelInterpolation) */
function kitAsheSlow(c, emp){ if (!c || !c.champ) return emp ? 0.6 : 0.3; return evalCalc({S:CALC.champs.Ashe.P, rank:1, st:stats(c), flags:new Set()}, emp ? "empoweredslowamount" : "slowamount").v || (emp ? 0.6 : 0.3); }
/* Fizz R shark size by the lure's flight (wiki Chum the Waters): Guppy < 455 (×1, slow 40%), Chomper 455–910 (×1.25, 60%), Gigalodon > 910 (×1.5, 80%) */
function kitFizzShark(d, S, r){ return d>910 ? {m:(S && dvOf(S,"largedamagemulti",r))||1.5, slow:0.8} : d>=455 ? {m:(S && dvOf(S,"middamagemulti",r))||1.25, slow:0.6} : {m:1, slow:0.4}; }
/* Irelia, Ionian Fervor on-hit (game data OnHitBonus: OnHitBaseDamage 10 + OnHitPerLevel 3 per level after the first, + 20% bonus AD;
   the per-level part is a calc type the evaluator doesn't read; wiki 10–61 by level) */
function kitIreliaOnHit(st){ const P=CALC.champs.Irelia.P, b=dvOf(P,"onhitbasedamage",1)||10, pl=dvOf(P,"onhitperlevel",1)||3, L=st.level||1, v=b+pl*(L-1)+0.2*st.bonusad;
  return {label:"Ionian Fervor", v, s:`${fmt(b)} + ${fmt(pl)} × ${L-1} levels + 0.2 × bonus AD ${fmt(st.bonusad)}`, type:"magic", pctOf:null}; }
/* Zoe Q (wiki Paddle Star!): damage ×(1 + bonus) by distance travelled: +0% up to 800, +25% at 950, +50% at 1350, +75% at 1650, +100% at 1950,
   +125% at 2250, +150% at 2550 (linear between the listed distances, assumed; the game data's maximum is ×2.5; the wiki notes a bug at +146.6%) */
function zoeQMult(d){ const P=[[800,0],[950,0.25],[1350,0.5],[1650,0.75],[1950,1],[2250,1.25],[2550,1.5]]; if (d<=800) return 1; if (d>=2550) return 2.5;
  for (let i=1;i<P.length;i++) if (d<=P[i][0]) return 1+P[i-1][1]+(P[i][1]-P[i-1][1])*(d-P[i-1][0])/(P[i][0]-P[i-1][0]);
  return 2.5; }
/* Yasuo / Yone Intent (game data P: CritChanceMultiplier 1 = doubled, <Champ>CritToAD 50 AD per 100% crit over 100%,
   CritDamageMod 0.95; wiki Way of the Wanderer / Way of the Hunter). */
function kitIntent(c, st, notes, e, P){
  const raw=(e.it.crit||0)+(e.m.crit||0); if (!(raw>0)) { st.critdmg *= dvOf(P,"critdamagemod",1) ?? 0.95; return; }
  const dbl=raw*(1+(dvOf(P,"critchancemultiplier",1) ?? 1)), over=Math.max(0, dbl-1), toAD=dvOf(P, c.champ==="Yone"?"yonecrittoad":"yasuocrittoad",1) ?? 50;
  st.crit=Math.min(1, dbl); st.critdmg *= dvOf(P,"critdamagemod",1) ?? 0.95;
  if (over>0){ st.bonusad += over*toAD; st.ad += over*toAD; }
  notes.push(`${champName(c)} Intent: crit chance ${fmt(raw*100)}% doubled to ${fmt(Math.min(1,dbl)*100)}%${over>0?`, the ${fmt(over*100)}% over 100% gives +${fmt(over*toAD)} AD`:""}; crits deal ${fmt((dvOf(P,"critdamagemod",1) ?? 0.95)*100)}% of normal critical damage`);
}
/* Yasuo Q, Yone Q/W: cooldown 4 / 14 s reduced by bonus attack speed, not by ability haste (wiki "static"; Yone game data
   q/wattackspeedcdpercent 0.6 per 100% bonus AS, capped at 66.7% / 57.1%). */
function kitAsCd(x, base, per, cap){ const red=Math.min(cap, per*x.st.bonusas), v=base*(1-red);
  line(`${label(x.c)}.${x.slot}.cd = ${fmt(base)}s × (1 − min(${fmt(cap)}, ${fmt(per)} × bonus attack speed ${fmt(x.st.bonusas)})) = ${fmt(v)}s (bonus attack speed, not ability haste)`); return v; }
const kitSamiraP = x => ({...x.part("bonusmeleedamage","magic",null,x.P,1), ampMissing:1, ampCap:1, label:"Daredevil Impulse melee bonus (up to ×2 by missing health)"});
// Samira Q: crits deal 150% (CritDamageMod 0.5 of the bonus); R: affected by crit modifiers (× crit damage)
const kitSamiraCrit = (x, key, critKey) => kitCrit(x, key, critKey, "physical");
const kitShadows = u => (u.kit.shadows||[]).filter(s=>s.until>u.kitT && !(s.from>u.kitT));   // landed shadows only (a W shadow in flight doesn't mimic yet)
/* Sylas R, Hijack (wiki): Sylas casts the target's ultimate at his Hijack rank with his own stats; an ultimate with no AP ratio has
   its AD ratios converted: 0.6% AP per 1% total AD, 0.4% AP per 1% bonus AD. Generic tooltip formulas only (the target's own kit
   extras, crowd control and recasts are not copied). */
function kitHijack(x, e){ const S=(CALC.champs[e.champ]||{}).R||{}, keys=S.mainparts&&S.mainparts.length ? S.mainparts : (S.main?[S.main]:[]), nm=champName(e);
  if (!keys.length){ x.note(`${nm}'s ultimate has no damage formula`); return [{label:`hijacked ${nm} R (no damage)`, v:0, s:"0", type:"magic"}]; }
  let ap=false; const walk=p=>{ if (!p || typeof p!=="object") return; if (Array.isArray(p)) return p.forEach(walk); if (/^StatBy/.test(p.__type||"") && (p.mStat||0)===0) ap=true; Object.values(p).forEach(walk); };
  for (const k of keys) if (S.calcs[k]) walk(S.calcs[k][1]);
  const st = ap ? x.st : {...x.st, ad:0.6*x.st.ap, basead:0.6*x.st.ap, bonusad:0.4*x.st.ap};
  x.note(ap ? `hijacked ${nm} R scales with AP: Sylas' own stats` : `hijacked ${nm} R has no AP ratio: its AD ratios become AP (0.6% AP per 1% total AD, 0.4% per 1% bonus AD; wiki Hijack); Sylas' Hijack rank ${x.rank}`);
  return keys.map(k=>{ const r=partRaw(S, k, x.rank, st, x.flags); return {label:`hijacked ${nm} R: ${r.name}`, v:r.v, s:r.s, type:(S.types||{})[k]||(S.calcs[k]?guessType(S.calcs[k]):"magic"), pctOf:r.pctOf||null}; }); }
/* .damage for a kit ability: its parts (raw), each mitigated separately against vs:. %-health parts need vs:. */
function kitDamage(c, slot, vs, opt){
  const spec=kitSpec(c, slot), st=stats(c), rank=rankOf(c, slot), who=`${label(c)}.${slot}`;
  if (spec.none) throw new Error(`${who}: ${spec.none}`);
  if (rank===0){ line(`${who}: not learned at level ${c.level} → 0`); return 0; }
  const x=kitCtx(c, slot, rank, st, null, kitOptions(spec, opt, c, slot, st, rank), null);
  x.vs = vs || null;   // Sylas R: the hijacked ultimate is the target's
  const k=KIT[c.champ];
  if (k.stacks && TR) TR.notes.add(`${label(c)}: ${fmt(x.stacks)} ${k.stacks.name}${kitOptsOf(c)["@stacks"]!=null?" (set)":` (default: ${k.stacks.why}; set ${label(c)}.stacks = n)`}`);
  if (k.evolved && TR) TR.notes.add(`${label(c)}: ${k.evolved.name}: ${x.evolved?x.evolved.split("").join(", "):"none"}${kitOptsOf(c)["@evolved"]!=null?" (set)":` (default: ${k.evolved.why}; set ${label(c)}.evolved = {Q, E})`}`);
  for (const [n,d] of Object.entries(spec.opts||{})) if (!opt || opt[n]==null) { if (TR) TR.notes.add(`${who}: ${d.what}: ${d.bool ? (x.o[n]?"yes":"no") : fmt(x.o[n])} (perfect play; damage(${n}: …) to change)`); }
  const parts=spec.parts(x); let total=0, pctRaw=[];
  for (const p of parts){
    line(`${who}.${p.label} (rank ${rank}) = ${p.s} = ${p.pctOf?fmt(p.v*100)+"% of the target's "+p.pctOf+" health":fmt(p.v)} ${p.type}${p.floor?` (at least ${fmt(p.floor)})`:""}`);
    if (!vs){ if (p.pctOf) pctRaw.push(p); else total+=p.v; continue; }
    let raw=p.v;
    if (p.pctOf){ const th=stats(vs).hp; raw=p.v*(p.pctOf==="missing"?0:th); line(`  ${fmt(p.v*100)}% of ${label(vs)}'s ${p.pctOf} health ${fmt(p.pctOf==="missing"?0:th)} = ${fmt(raw)}`);
      if (TR && p.pctOf!=="max") TR.notes.add(`${who}: ${label(vs)} is taken at full health — perform()/fight() use the live value`); }
    if (p.floor && raw<p.floor){ raw=p.floor; line(`  minimum ${fmt(p.floor)}`); }
    if (p.ampMissing && TR) TR.notes.add(`${who}: ${p.label}: ${label(vs)} at full health (no missing-health bonus); perform()/fight() use the live value`);
    const m=mitigate(raw, p.type, st, stats(vs)); line(`  vs ${label(vs)}: ${m.s} = ${fmt(m.v)}`); total+=m.v;
  }
  if (!vs && pctRaw.length){
    if (total>0){ if (TR) TR.notes.add(`${who}: the %-health part isn't added without a target; use damage(vs: …)`); }
    else { total=pctRaw.reduce((s,p)=>s+p.v,0); if (TR) TR.notes.add(`${who}: a share of the target's health; add vs: to get damage`); }
  }
  if (parts.length>1) line(`${who}.damage = ${fmt(total)}${!vs&&pctRaw.length&&total>0?" plus the %-health part":""}`);
  return total;
}
/* named options of a kit ability, with defaults (perfect play) */
function kitOptions(spec, opt, c, slot, st, rank){
  const o={}; const x0=()=>kitCtx(c, slot, rank, st, null, {}, null);
  for (const [n,d] of Object.entries(spec.opts||{})){
    const v = opt && opt[n]!=null ? opt[n] : opt && d.alias && opt[d.alias]!=null ? opt[d.alias] : null;
    o[n] = v!=null ? v : (typeof d.dflt==="function" ? d.dflt(x0()) : d.dflt);
  }
  return o;
}
/* fight()/perform(): the kit ability's parts with live options (spec.sim) */
function kitSimParts(u, a, flags){
  const spec=kitSpec(u.c, a.slot); if (!spec || spec.none || !spec.parts) return null;
  const o=kitOptions(spec, spec.sim ? spec.sim(u, a) : null, u.c, a.slot, u.st, a.rank);
  const x=kitCtx(u.c, a.slot, a.rank, u.st, flags, o, u), parts=spec.parts(x);
  a.later=parts.filter(p=>p.later);
  return parts.filter(p=>!p.later);
}
/* damage(passes: 1): only the first pass of a multi-pass ability (Ahri Q out, not back; Yone W/R physical half).
   damage(count: n) or damage(<unit>: n): n units for abilities whose .damage is a guaranteed minimum count
   (Syndra R: spheres, 3 to 7). */
/* Ability haste one ability gives another, per rank (game data grantsHaste; Syndra R passive: Dark Sphere +10 per R rank). */
function grantedHaste(c, slot){
  let h=0; const C=CALC.champs[c.champ]||{};
  for (const x of ["Q","W","E","R"]){ const g=C[x]&&C[x].grantsHaste; if (!g || g.slot!==slot) continue; const r=rankOf(c,x); if (r) h += (dvOf(C[x], g.key, r)||0)*(g.perRank?r:1); }
  return h;
}
function damageOpts(c, slot, named){
  const S=CALC.champs[c.champ][slot]||{}, o={}, who=`${label(c)}.${slot}`;
  const ks=kitSpec(c, slot);
  if (ks && (ks.parts || ks.none)){ const d=ks.opts||{}, names=Object.keys(d);   // champion kit abilities: their own options
    for (const [k,v] of Object.entries(named||{})){ if (k==="vs") continue;
      const n=names.find(m=>m===k || d[m].alias===k);
      if (!n) throw new Error(`${who}.damage takes ${["vs",...names].map(x=>x+":").join(", ")}, not “${k}:”.${hint(k, ["vs",...names])}`);
      const D=d[n];
      if (D.bool){ if (typeof v!=="boolean") throw new Error(`${who}: ${k}: is true or false`); }
      else if (typeof v!=="number" || v!==Math.floor(v) || v<D.min || v>D.max) throw new Error(`${who}: ${k}: is a whole number from ${fmt(D.min)} to ${fmt(D.max)}`);
      o[n]=v; }
    return o; }
  for (const [k,v] of Object.entries(named||{})){
    if (k==="vs") continue;
    if (k==="passes"){ const has=(S.mainparts||[]).some(x=>x.includes("#")); if (!has) throw new Error(`${who} has only one pass`); if (v!==1 && v!==2) throw new Error(`passes: is 1 or 2`); o.passes=v; continue; }
    if (S.count && (k==="count" || k===S.count.unit)){ const lo=dvOf(S,S.count.min,1)||1, hi=S.count.max?dvOf(S,S.count.max,1):lo;
      if (typeof v!=="number" || v<lo || v>hi || v!==Math.floor(v)) throw new Error(`${who}: ${k}: is a whole number from ${fmt(lo)} to ${fmt(hi)}`); o.count=v; continue; }
    const opts=["vs", ...((S.mainparts||[]).some(x=>x.includes("#"))?["passes"]:[]), ...(S.count?["count", S.count.unit]:[])];
    throw new Error(`${who}.damage takes ${opts.map(x=>x+":").join(", ")}, not “${k}:”.${hint(k, opts)}`);
  }
  return o;
}
function abilityValue(c, slot, field, vs, opt){
  const S=CALC.champs[c.champ][slot];
  if (!S) throw new Error(`${label(c)} ${slot}: no data in the game files`);
  const st=stats(c), rank=rankOf(c, slot), f=field.toLowerCase(), who=`${label(c)}.${slot}`;
  if (f==="rank") return rank;
  if (f==="cd"||f==="cdbase"){
    const w=WORLD.champ(c.champ); let base;
    const ksc=kitSpec(c, slot); if (f==="cd" && ksc && ksc.cd && !(w.cdOver && w.cdOver[slot])) return ksc.cd(kitCtx(c, slot, rank, st));
    if (w.cdOver && w.cdOver[slot]){ base=w.cdOver[slot].v; if(TR) TR.asm.add(`line ${w.cdOver[slot].f.line}: ${w.cdOver[slot].f.text}`); }
    else if (S.cdFromAS){ const v=Math.max(1/st.as, dvOf(S,"mincooldown",rank)||0); line(`${who}.cd = 1 / attack speed ${fmt(st.as)} = ${fmt(v)}s (not reduced by ability haste)`); return v; }
    else { if(!S.cd) throw new Error(`${who} has no cooldown`); base=S.cd[rank] ?? S.cd[1]; }
    if (S.cdSource && TR) TR.notes.add(`${who}: cooldown from the script value ${S.cdSource} (the spell's own cooldown is 0)`);
    if (S.staticCd && TR) TR.notes.add(`${who}: cooldown is the ammo recharge (${fmt(base)}s); the spell's static lockout is ${fmt(S.staticCd[rank] ?? S.staticCd[1])}s`);
    if (S.charges && TR) TR.notes.add(`${who}: holds ${S.charges} charges, one every ${fmt((S.recharge||[])[rank] ?? 0)}s; the cooldown shown is the lockout between casts`);
    if (f==="cdbase"){ line(`${who}.cdbase = ${fmt(base)}s (rank ${rank})`); return base; }
    if (!(base>=0.5) && TR) TR.notes.add(`${who}: cooldown is ${fmt(base||0)} in the game data (passive, toggle or ammo ability); set a real one with setCooldown(…) before dividing by it`);
    const tags=WORLD.champ(c.champ).slots[slot].tags, mandate = c.items.includes("imperialmandate") && IMMOB_TAGS.some(x=>tags[x]!==undefined) ? idv("imperialmandate","ImmobilizingAbilityAH",20) : 0;
    const own=grantedHaste(c, slot), extra=(slot==="R"?st.rhaste:st.basichaste)+mandate, h=st.haste+extra+own;
    const v=base*100/(100+h); line(`${who}.cd = ${fmt(base)}s × 100/(100 + ${fmt(h)} haste${extra?` incl. ${fmt(extra)} ${slot==="R"?"ultimate":"basic ability"}${mandate?"/immobilizing":""} haste`:""}${own?`${extra?",":" incl."} ${fmt(own)} from ${ ["Q","W","E","R"].filter(x=>(CALC.champs[c.champ][x]||{}).grantsHaste?.slot===slot).map(x=>`${label(c)}.${x}`).join(", ") }`:""}) = ${fmt(v)}s`); return v;
  }
  // costs: the spell data's mana array is indexed from rank 1 (Akali Q [110,100,90,80,70,60]: rank 1 = 110, wiki "110 to 70"),
  // unlike cd/range (index 0 = rank 0); the old [rank] read the next rank's cost (viktor-akali, item 26)
  if (f==="cost"){ const v=(S.cost||[])[Math.max(1,rank)-1]??0; line(`${who}.cost = ${fmt(v)}`); return v; }
  if (f==="range" && S.phys && S.phys.attackRangeBonus!=null && !c.dummy){ const ar=stats(c).range, v=ar+S.phys.attackRangeBonus;
    line(`${who}.range = attack range ${fmt(ar)} + ${fmt(S.phys.attackRangeBonus)} = ${fmt(v)} (its hits are basic attacks; wiki target range: the attack range)`); return v; }
  if (f==="range"){ const v0=(S.range||[])[Math.max(1,rank)]??0, rb=levelRangeBonus(c, slot), v=v0+(rb ? rb.v : 0);
    line(`${who}.range = ${rb ? `${fmt(v0)} + ${rb.why} = ` : ""}${fmt(v)}${S.minRange?" (fully charged)":""}`); return v; }
  if (f==="minrange"){ const v=((S.minRange||S.range)||[])[Math.max(1,rank)]??0; line(`${who}.minRange = ${fmt(v)}${S.minRange?" (uncharged)":" (not a charged ability)"}`); return v; }
  if (f==="chargetime"){ const v=S.chargeTime||0; line(`${who}.chargeTime = ${fmt(v)}s${S.chargeTime?` to grow from ${fmt((S.minRange||[])[Math.max(1,rank)]??0)} to ${fmt((S.range||[])[Math.max(1,rank)]??0)}`:" (not a charged ability)"}`); return v; }
  if (f==="damage"){
    { const ks=kitSpec(c, slot); if (ks && (ks.parts || ks.none)){ const kv=kitDamage(c, slot, vs, opt);
        if (slot==="R" && st.ramp && kv){ const aoe=WORLD.champ(c.champ).slots.R.tags.aoe!==undefined, ax=aoe?0.08:st.ramp; line(`  × ${fmt(1+ax)} (Axiom Arcanist${aoe?", area of effect":""}) = ${fmt(kv*(1+ax))}`); return kv*(1+ax); }
        return kv; } }
    const keys = S.mainparts&&S.mainparts.length ? S.mainparts : (S.main?[S.main]:[]);
    if (!keys.length) throw new Error(`${who} has no damage formula in the game data. Its values: ${Object.values(S.calcs).map(x=>x[0]).concat(Object.values(S.dv).map(x=>x[0])).slice(0,12).join(", ")}`);
    if (rank===0){ line(`${who}: not learned at level ${c.level} → 0`); return 0; }
    let useKeys=keys;
    if (opt && opt.passes===1){ useKeys=keys.filter(k=>!k.includes("#")); line(`${who}: first pass only (passes: 1)`); }
    else if (TR && keys.some(k=>k.includes("#"))) TR.notes.add(`${who}: both passes counted (the tooltip deals the same formula twice, as ${[...new Set(keys.map(k=>S.types[k]))].join(" and ")} damage); damage(passes: 1) for the first only`);
    if (S.count && TR && !(opt && opt.count)) TR.notes.add(`${who}: the guaranteed minimum of ${fmt(dvOf(S,S.count.min,rank))} ${S.count.unit}${S.count.max?` (up to ${fmt(dvOf(S,S.count.max,rank))})`:""}; damage(${S.count.unit}: n) for more`);
    const rs=useKeys.map(k=>{ if (opt && opt.count && S.count && S.calcs[k] && S.calcs[k][1].mModifiedGameCalculation===S.calcs[S.count.per][0]){
        const r=damagePart(c, slot, S.count.per, vs); line(`  × ${opt.count} ${S.count.unit} = ${fmt(r.v*opt.count)}`); return {...r, v:r.v*opt.count}; }
      return damagePart(c, slot, k, vs); });
    // Axiom Arcanist (wiki): ultimate damage +12%, +8% for area-of-effect ultimates
    if (slot==="R" && st.ramp){ const aoe=WORLD.champ(c.champ).slots.R.tags.aoe!==undefined, ax=aoe?0.08:st.ramp; for (const r of rs) r.v*=1+ax;
      line(`  × ${fmt(1+ax)} (Axiom Arcanist${aoe?", area of effect":""})`); }
    if (!vs){
      const flat=rs.filter(r=>!r.pctOf), pct=rs.filter(r=>r.pctOf);
      if (flat.length && pct.length){
        const total=flat.reduce((x,r)=>x+r.v,0);
        line(`${who}.damage = ${flat.map(r=>fmt(r.v)).join(" + ")}${flat.length>1?` = ${fmt(total)}`:""}, plus ${pct.map(r=>`${fmt(r.v*100)}% of the target's ${r.pctOf} health`).join(" and ")} (add vs: to include it)`);
        if (TR) TR.notes.add(`${who}: the %-health part isn't added without a target; use damage(vs: …)`);
        return total;
      }
      const total=rs.reduce((x,r)=>x+r.v,0);
      if (rs.length>1) line(`${who}.damage = ${rs.map(r=>fmt(r.v)).join(" + ")} = ${fmt(total)} (the tooltip adds these)`);
      return total;
    }
    const total=rs.reduce((x,r)=>x+r.v,0);
    if (rs.length>1) line(`${who}.damage = ${rs.map(r=>fmt(r.v)).join(" + ")} = ${fmt(total)} (the tooltip adds these)`);
    return total;
  }
  if (rank===0){ line(`${who}: not learned at level ${c.level} → 0`); return 0; }
  if (S.calcs[f] || S.dv[f]) return damagePart(c, slot, f, vs, true);
  return undefined;
}
/* One formula of an ability at its rank: a calc or a data value, with the tooltip's multiplier ("{{ x*4 }}"),
   duration ("each second for {{ duration }} seconds") and %-health reading. Without vs: the raw value
   (a fraction for %-health parts); with vs: the damage after the target's health and resistances. */
function partRaw(S, key, rank, st, flags){
  const info=(S.partinfo||{})[key]||{};
  let v, s, name;
  if (S.calcs[key]){ const r=evalCalc({S, rank, st, flags}, key); v=r.v; s=r.s; name=S.calcs[key][0]; }
  else if (S.dv[key]){ const arr=S.dv[key][1]; v=Array.isArray(arr)?(arr[rank]??arr[arr.length-1]):arr; s=fmt(v); name=S.dv[key][0]; }
  else { flags.add(`formula “${key}” could not be resolved (counted as 0)`); return {v:0, s:"?", name:key, pctOf:null}; }
  if (info.mult && info.mult!==1){ v*=info.mult; s=`(${s}) × ${fmt(info.mult)}`; }
  if (info.times){ const d=S.dv[info.times]; const t=d?(d[1][rank]??d[1][d[1].length-1]):1; v*=t; s=`(${s}) × ${fmt(t)}s`; }
  if (info.pctUnits){ v/=100; s=`${s}%`; }
  let pctOf = info.pctOf || null;
  // no tooltip tag: a formula shown as a percentage and named after health is a share of max health
  if (!pctOf && !S.partinfo?.[key] && S.calcs[key] && S.calcs[key][1].mDisplayAsPercent && /health|hp/i.test(name)) pctOf="max";
  return {v, s, name, pctOf};
}
function damagePart(c, slot, key, vs, single){
  const S=CALC.champs[c.champ][slot], st=stats(c), rank=rankOf(c, slot), who=`${label(c)}.${slot}`;
  const flags=new Set(); const r=partRaw(S, key, rank, st, flags);
  if (TR) for (const fl of flags) TR.notes.add(`${who}: ${fl}`);
  let type=S.types && S.types[key];
  const tov = WORLD.champ(c.champ).typeOver && WORLD.champ(c.champ).typeOver[slot];
  if (tov){ type = tov.v; if (TR) TR.asm.add(`line ${tov.f.line}: ${tov.f.text}`); }
  else if (!type){ type = S.calcs[key] ? guessType(S.calcs[key]) : "magic"; if(TR && !single) TR.notes.add(`${who}: damage type not in tooltip, assumed ${type} (correct it with ${champName(c)}.${slot}.setDamageType("magic"))`); }
  if (single && !S.calcs[key]){ line(`${who}.${r.name} (rank ${rank}) = ${r.s}`); return r.v; }
  line(`${who}.${r.name} (rank ${rank}) = ${r.s} = ${r.pctOf?fmt(r.v*100)+"% of the target's "+r.pctOf+" health":fmt(r.v)} ${type}`);
  if (!vs){ if (r.pctOf && TR) TR.notes.add(`${who}: ${r.name} is a share of the target's ${r.pctOf} health; add vs: to get damage`); return single ? r.v : {v:r.v, pctOf:r.pctOf}; }
  let raw=r.v;
  if (r.pctOf){
    const th=stats(vs).hp, base = r.pctOf==="missing" ? 0 : th;
    raw=r.v*base;
    line(`  ${fmt(r.v*100)}% of ${label(vs)}'s ${r.pctOf} health ${fmt(base)} = ${fmt(raw)}`);
    if (TR && r.pctOf!=="max") TR.notes.add(`${who}: ${r.name} uses the target's ${r.pctOf} health; ${label(vs)} is taken at full health (${r.pctOf==="missing"?"0 missing":"current = max"}) — perform()/fight() use the live value`);
  }
  const m=mitigate(raw, type, st, stats(vs)); line(`  vs ${label(vs)}: ${m.s} = ${fmt(m.v)}`);
  return single ? m.v : {v:m.v, pctOf:null};
}
function supportValue(c, slot, kind, target){
  const S=CALC.champs[c.champ][slot], key=S&&S[kind], who=`${label(c)}.${slot}`;
  if (!key) throw new Error(`${who} has no ${kind} in its tooltip`);
  const tt=S[kind+"Target"];
  if (target){
    if (target.t!=="champ") throw new Error(`target: needs a Champion`);
    const self = champKey(target)===champKey(c) && (target.label||"")===(c.label||"");
    if (tt==="self" && !self) throw new Error(`${who} only ${kind}s ${champName(c)}`);
    if (tt==="ally" && self) throw new Error(`${who} can't ${kind} ${champName(c)} (it targets another ally)`);
  }
  const st=stats(c), rank=rankOf(c,slot);
  if (!rank){ line(`${who}: not learned at level ${c.level} → 0`); return 0; }
  const ctx={S,rank,st,flags:new Set()}; const r=evalCalc(ctx,key);
  if (TR) for (const f of ctx.flags) TR.notes.add(`${who}: ${f}`);
  let v=r.v*(slot==="R"?1+st.ramp:1);
  line(`${who}.${S.calcs[key][0]} (rank ${rank}) = ${r.s} = ${fmt(v)} ${kind} (${ {self:"caster only", ally:"another ally", ally_or_self:"an ally or self", self_and_ally:"caster and one ally", team:"every ally"}[tt] })`);
  { const ks=kitSpec(c, slot), m = kind==="shield" && ks && ks.shieldMult ? ks.shieldMult(c, st, rank) : 1;   // Viktor Turbocharge
    if (m!==1){ v*=m; line(`  × ${fmt(m)} (${ks.shieldWhy||"augment"}) = ${fmt(v)}`); } }
  const pw=1+st.healpower, inc = target ? 1+(kind==="heal"?stats(target).healIn:stats(target).shieldIn) : 1;
  if (pw!==1 || inc!==1){ v*=pw*inc; line(`  × ${fmt(pw)} heal & shield power${inc!==1?` × ${fmt(inc)} received by ${label(target)}`:""} = ${fmt(v)}`); }
  return v;
}
/* Damage type when the tooltip doesn't say: physical only if the formula scales with AD and not AP. */
function guessType(calc){
  let ad=false, ap=false;
  const walk = p => { if (!p || typeof p!=="object") return; if (Array.isArray(p)) return p.forEach(walk);
    if (/^StatBy/.test(p.__type||"")) { const st=p.mStat||0; if (st===2) ad=true; if (st===0) ap=true; }
    Object.values(p).forEach(walk); };
  walk(calc);
  return ad && !ap ? "physical" : "magic";
}
/* ---- physics: projectile speed, width, cast time, reach ---- */
const HITBOX = 65;
/* Gameplay radius (hitbox) per champion: the character record's overrideGameplayCollisionRadius, else 65
   (calc.json base.radius; wiki "Hitbox" table agrees for every champion; Warwick 74.75 = 65 + 15% innate size). */
function hitboxOf(c){ if (c.dummy) return dummyRadius(c); const b=CALC.champs[c.champ] && CALC.champs[c.champ].base; return (b && b.radius) || HITBOX; }
/* Size modifiers scale the gameplay radius (wiki "Size"); not simulated, noted when they apply. */
const SIZE_NOTES = {Chogath:"Feast stacks add 6/8/10% size each, up to +100%", Nasus:"Fury of the Sands (R) +30/35/40% size", Renekton:"Dominus (R) +20% size",
  Volibear:"Stormbringer (R) +35% size", Aatrox:"World Ender (R) +5% size", Kayle:"Divine Ascent +10% size", Olaf:"Ragnarok (R) +10% size",
  Shyvana:"Dragon's Descent (R) +0/8.5/16% size", Zac:"innate: −30% size at 0% health, up to +35% from bonus health", Malphite:"innate: up to +35% size from armor",
  Warwick:"innate +15% size (included: 65 × 1.15 = 74.75)", Gnar:"Mega Gnar has an 80 radius (Gnar's record: 55)", Sion:"Sion's record radius 80 already; W/R don't change it in the data"};
/* ---- summoner spells (game files: shared bin, CALC.summoners; checked against the wiki pages) ---- */
const SUMM = CALC.summoners || {};
// cast ranges of the targeted summoner spells (data/raw/ddragon_summoner.json range: Exhaust 650, Ignite 600; wiki agrees).
// Measured centre to centre like other point-and-click spells without the bounding-box flag (the flag isn't in our data for summoners).
const SUMM_RANGE = {exhaust:650, ignite:600};
/* Basic-attack timing in fight()/perform() (backlog 25 step 7): windup, ranged missiles, empowered attacks riding the attack.
   false restores the attack model before it (every attack lands at the press, empowered abilities hit at their press). */
const ATTACK_TIMING = true;
/* A champion's basic-attack windup (s) at attack speed st.as and its missile speed (0: melee or instant); the rule in autoAttack's
   comment (wiki "Attack speed"). */
function attackTiming(champ, st, ranged){ const B=(CALC.champs[champ] && CALC.champs[champ].base) || {}, wu=B.wu ?? 0.3, wm=B.wm ?? 1, as=st.as, b=wu/(st.baseas||as);
  return {wu, wm, base:b, windup:Math.max(0, b + wm*(wu/as - b)), msl:(ranged || st.range>=300) && B.msl>0 ? B.msl : 0}; }
/* Abilities whose damage is an empowered next basic attack and that have no kit of their own for it (wiki ability pages:
   "empowers his next basic attack within N seconds"; reset = the page's {{tip|basic attack reset}} note). The press arms them;
   the ability resolves (damage, crowd control, on-hit) on the next attack's target when that attack lands. Not modelled: their
   bonus attack range, the uncancellable windup, Volibear Q's modified windup and pounce. */
const EMPOWER_NEXT = {
  // (Wukong Q, Draven Q and Malphite W have kits of their own: champion audit batch 7, CHAMP_MECH attack hooks at the landing)
  Nasus:{Q:{win:10, reset:true}},
  Garen:{Q:{win:4.5, reset:true}}, Darius:{W:{win:4, reset:true}}, Jax:{W:{win:10, reset:true}}, Leona:{Q:{win:6, reset:true}},
  Trundle:{Q:{win:7, reset:true}}, Kassadin:{W:{win:5, reset:true}}, Yorick:{Q:{win:5, reset:true}}, Volibear:{Q:{win:4, reset:true}},
};
/* ===== SIM_INTERIM_P3 (P3 of the interaction audit, 2026-09-24): RESIDUAL per-ability data for fight()/perform() =====
   P1 now exports the sheets' fields into calc.json phys (which wins in physOf → simInterim: defaults < this table < P2's SIM_INTERIM
   < calc.json phys). Only what the sheets have no field for stays here (outputs/interactions/P1_DIFF.md): shieldHits "first" (Ahri Q)
   and "spheres" (Syndra R). Move them to the sheets' sim blocks and delete this table.
   The phys fields fight() reads (the P1 names):
     spellShield   how a spell shield (Banshee's, Edge of Night, Verdant Barrier, Sivir E, Nocturne W) meets the cast on one target:
                   "blocks" (default: the whole cast) | "not" (never blocked; the shield isn't used up) | "oneHit" (the shield takes one
                   hit / sphere / dagger / pass / tick, the rest land) | "ccOnly" (only the crowd control is blocked, the damage lands) |
                   "damageOnly" (the damage is blocked, the crowd control lands)
     shieldHits    "oneHit" where fight() deals the hits as one number: N (1/N of it is blocked) or "first" (the first damage part is one
                   pass). Otherwise: a kit's per-hit count (scale(…).hitsN: Syndra R spheres), a channel's separate hits (Katarina R
                   daggers), else the one hit fight() deals is blocked (a kit deals the later hits: Draven R / Ekko Q returns)
     shieldConsumed:true   with "not": the shield is used up although nothing is blocked (documented bug)
     cancelOn      what cancels a unit-targeted cast during its cast time (DECISIONS 3; default untargetable, stasis, invisible, range)
     cancelSpends:true     a cancelled cast still goes on cooldown and pays its cost (documented bug, DECISIONS 1)
     inFlight      "invalidated" | "destroyed" (no hit if the target is untargetable/in stasis at any step between launch and landing;
                   the default for unit-targeted missiles) | "hits"
     leapTo:"press"   a targeted leap lands where the target stood at the press (DECISIONS 21)
     grants        the caster's own windows, s from the press (where P2's table has none)
     untargetableDash:true  untargetable from the press until the dash arrives (the window depends on the distance)
     invulnFar     {from, until, beyond}: invulnerable only to enemy champions farther than `beyond` (Xin Zhao R) */
const SIM_INTERIM_P3 = {
  "Ahri.Q":{shieldHits:"first"},      // sheet: 'a shield blocks one pass, the other pass still hits' — the out pass (magic) is the first part
  "Syndra.R":{shieldHits:"spheres"},  // wiki: 'Spell shield will only block the damage of a single sphere.' — the kit's sphere count
};
/* Caster windows that the kits set themselves (the generic grant code in cast() skips them): Zed R, Pantheon E, Naafiri W and Olaf R,
   Fiora W in CHAMP_MECH; Lissandra R's stasis is only for a self-cast (fight() casts it on an enemy). */
const KIT_OWN_GRANTS = new Set(["Zed.R","Pantheon.E","Naafiri.W","Olaf.R","Fiora.W","Lissandra.R"]);
/* a grants window [start, end] (seconds from the press) as numbers, or null. The sheets write an end that depends on something as
   null (ends on an event: Kayn R) or {min, max, by}: by "rank" → the value at this rank; otherwise the documented lower bound (min;
   Maokai W "dash length / 1300": its dash code covers the real window). A null end takes GRANT_NOTES' `until` (a documented bound). */
function grantWin(w, key, rank, slot){ if (!Array.isArray(w)) return null;
  const val = (v, isEnd) => { if (typeof v==="number") return v;
    if (v==null) return isEnd ? ((GRANT_NOTES[key]||{}).until ?? null) : null;
    if (typeof v==="object" && typeof v.min==="number" && typeof v.max==="number"){ const n = slot==="R" ? 3 : 5;
      return v.by==="rank" && rank ? v.min+(v.max-v.min)*Math.min(1, Math.max(0, (rank-1)/(n-1))) : v.min; }
    return null; };
  const s=val(w[0], false), e=val(w[1], true); return s!=null && e!=null && e>s ? [s, e] : null; }
/* extra lockout and log text for cast windows (the windows themselves come from the grants data) */
const GRANT_NOTES = {
  "Fizz.E":{lock:1.25, why:"Playful: untargetable at once, 0.75 s on the trident then 0.5 s hopping off (wiki; the Trickster recast isn't modelled)"},
  "Vladimir.W":{lock:2, why:"Sanguine Pool: untargetable for 2 s from the cast (wiki: cast time none); he can't attack or cast meanwhile (he can move in the game; here he stays put)"},
  "MasterYi.Q":{lock:1.087, why:"Alpha Strike: vanishes at once; 4 marks 0.2 s apart, reappears at 0.94 s and acts again 1.087 s after the cast (wiki, one target)"},
  "Kayn.R":{lock:1.35, until:1.35, why:"Umbral Trespass: vanishes at once (0.25 s dash, 0.5 s before the channel, recast after 0.1 s, recast delay 0.5 s: 1.35 s at the earliest; wiki); the exit dash isn't modelled"},
  "Xayah.R":{why:"Featherstorm: untargetable for 1.5 s from the cast (wiki; DECISIONS 12); she can't attack or cast meanwhile"},
  "Evelynn.R":{why:"Last Caress: untargetable from the start of the cast time until the blink 0.85 s after the press (wiki)"},
  "Camille.R":{why:"The Hextech Ultimatum: untargetable during the 0.5 s leap (wiki)"},
  "Ekko.R":{why:"Chronobreak: stasis from the start of the cast time until he arrives (1 s; wiki)"},
  "Shaco.R":{why:"Hallucinate: vanishes (untargetable) for 0.5 s after the 0.25 s cast (DECISIONS 14)"},
  "RekSai.R":{why:"Void Rush: vanished (untargetable) about 0.25–1.15 s after the press (wiki, estimated)"},
  "Galio.R":{why:"Hero's Entrance: untargetable during the leap, about 1.25–2.25 s after the press (wiki, estimated)"},
  "Kayle.R":{why:"Divine Judgment: invulnerable (0 damage taken, still targetable, crowd control still applies) for 2.5 s from the start of the cast time (wiki)"},
};
/* Cast-start untargetability (AUTOPILOT item 24, syndra-zed r-04): abilities with no cast time that make the caster untargetable
   from the cast (wiki, checked 2026-09-24). In fight()/perform() their casters act first in a step, and the state applies to the
   whole step: a hit resolving on the cast step doesn't land, and can't start or cancel First Strike. Zed R (Death Mark) and
   Pantheon E (Aegis Assault, modelled as untargetable) set theirs in their kits; the rest (no kit of their own) use this table:
     P3 (interaction audit, 2026-09-24): the hand table CAST_UNTARGETABLE (Fizz E, Vladimir W, Master Yi Q, Kayn R) is replaced by the
   sheets' grants windows (a.p.grants: SIM_INTERIM / SIM_INTERIM_P3 until P1 exports them; castGrants in simulate) — which adds Ekko R,
   Evelynn R, Xayah R, Camille R (from the press) and Shaco R, Rek'Sai R, Galio R (later windows); GRANT_NOTES keeps the lockouts.
   Not modelled: Elise's spider-form E (Rappel, untargetable at once for up to 1.95 s): fight() has no spider form.
   castStartSlot(champ): the champions with a window from the press act first in a step (lazily built: the interim tables are
   declared further down). */
let CAST_START_MAP = null;
function castStartSlot(champ){
  if (!CAST_START_MAP){ CAST_START_MAP = {Zed:"R", Pantheon:"E"};
    for (const [c, C] of Object.entries(CALC.champs)) for (const s of ["Q","W","E","R"]){ if (!C[s] || KIT_OWN_GRANTS.has(`${c}.${s}`)) continue;
      const g={...simInterim(c, s), ...(C[s].phys||{})}.grants || {};
      if (["untargetable","stasis"].some(k=>{ const w=grantWin(g[k], `${c}.${s}`, 1, s); return w && w[0]===0; }) || ({...simInterim(c, s), ...(C[s].phys||{})}).untargetableDash) CAST_START_MAP[c]=s; } }
  return CAST_START_MAP[champ] || null; }
/* Unstoppable (AUTOPILOT item 28; wiki "Crowd control" § Immunity, checked 2026-09-24). "Unstoppable" in the game is displacement
   immunity (its buff icon): immune to airborne (knock-up, knockback, pull), knockdown, sleep, enemy stasis and the special-cased
   suppressions (Ambessa R, Skarner E/R, Sett R, Tahm Kench R); stuns and other CC still apply (wiki Vi R / Nautilus R notes) but
   can't stop the dash ("The dash cannot be deterred by crowd control", wiki Malphite R / Vi R; their dash tables: interrupts=death).
   Total CC immunity ("cc") ignores every crowd control. Spell shields still block the ability's effects (spellshield = True on the
   pages). imm: "displacement" | "cc"; from: when the immunity starts — "press" (the wiki's "take effect at the start of the cast
   time" list, wiki Cast time), "dash" (the end of the cast time: the dash's start), or seconds after the press (Galio R: its
   channel can only be interrupted in the first 1.25 s); it lasts until the ability lands (a dash's arrival). Abilities on the
   wiki lists that fight() doesn't model as one cast (Vex R / Nocturne R / Yone E recasts, Kalista R on the Oathsworn, Briar R,
   Pantheon R, Udyr E, Karthus / Kog'Maw passives) aren't listed; Olaf R, Fiora W and Morgana E have their own immunity code.
   P3 (interaction audit, 2026-09-24; sheet_checks.py §5 listed 19 sheet immunities missing here): added Zaahen R and Nocturne R;
   any other ability whose data (a.p.grants) has a ccImmune / displacementImmune window with numbers gets it from there (unstopOf:
   Briar R's 1–2.25 s, …). Still not modelled (no such cast in fight(), or not CC immunity): Briar R's dash, Dr. Mundo P, Karthus P,
   Kled P, Kog'Maw P, Malzahar P (CC immunity + 90% damage reduction while Void Shift is up: a kit mechanic, P6), Master Yi R and
   Sejuani P (slow immunity only), Pantheon R, Udyr E (Awaken), Vex R, Yone E and Yuumi W (recasts / attach). Tahm Kench R removed. */
const UNSTOPPABLE = {
  Malphite:{R:{imm:"displacement", from:"dash", why:"Unstoppable Force: dashes with displacement immunity; the dash can't be deterred by crowd control (wiki)"}},
  Vi:      {R:{imm:"displacement", from:"dash", why:"Cease and Desist: dashes with displacement immunity; the dash can't be deterred by crowd control, stuns still apply (wiki)"}},
  Hecarim: {R:{imm:"displacement", from:"dash", why:"Onslaught of Shadows: dashes with displacement immunity (wiki)"}},
  JarvanIV:{R:{imm:"displacement", from:"dash", why:"Cataclysm: leaps with displacement immunity (wiki)"}},
  Camille: {R:{imm:"displacement", from:"dash", why:"The Hextech Ultimatum: leaps with displacement immunity (wiki)"}},
  Volibear:{R:{imm:"displacement", from:"dash", why:"Stormbringer: leaps with displacement immunity (wiki)"}},
  Aurora:  {R:{imm:"displacement", from:"dash", why:"Between Worlds: displacement immunity (wiki)"}},
  Ambessa: {R:{imm:"displacement", from:"dash", why:"Public Execution: displacement immunity (wiki)"}},
  Sett:    {R:{imm:"displacement", from:"dash", why:"The Show Stopper: displacement immunity (wiki)"}},
  KSante:  {W:{imm:"displacement", from:"press", why:"Path Maker: displacement immunity while charging and dashing (wiki)"},
            R:{imm:"displacement", from:"press", why:"All Out: displacement immunity over the cast time (wiki)"}},
  RekSai:  {R:{imm:"displacement", from:"press", why:"Void Rush: displacement immunity from the start of the cast time (wiki Cast time)"}},
  Shyvana: {R:{imm:"displacement", from:"press", why:"Dragon's Descent: displacement immunity from the start of the cast time (wiki Cast time)"}},
  Viego:   {R:{imm:"displacement", from:"press", why:"Heartbreaker: displacement immunity from the start of the cast time (wiki Cast time)"}},
  Illaoi:  {R:{imm:"displacement", from:"press", why:"Leap of Faith: displacement immunity from the start of the cast time (wiki Cast time)"}},
  // P3: Tahm Kench R removed — his sheet quotes 'The untargetability and displacement immunity is granted to the TARGET during
  // Devour's cast time' (the devoured unit, not Tahm Kench)
  Zaahen:  {R:{imm:"displacement", from:"press", ccFor:0.5, why:"Grim Deliverance: crowd control immune over the 0.5 s cast, then displacement immune through the dash and the 0.6 s delay (wiki)"}},
  Nocturne:{R:{imm:"displacement", from:"dash", why:"Paranoia: the recast dash has displacement immunity (wiki)"}},
  Ornn:    {W:{imm:"displacement", from:"press", why:"Bellows Breath: displacement immunity (wiki)"}},
  Warwick: {Q:{imm:"displacement", from:"dash", why:"Jaws of the Beast: displacement immunity (wiki)"},
            R:{imm:"cc", from:"press", why:"Infinite Duress: crowd control immunity from the start of the cast time (wiki)"}},
  Sion:    {R:{imm:"cc", from:"press", why:"Unstoppable Onslaught: crowd control immunity (wiki)"}},
  Kled:    {R:{imm:"cc", from:"press", why:"Chaaaaaaaarge!!!: crowd control immunity while charging (wiki)"}},
  Rammus:  {R:{imm:"cc", from:"press", why:"Soaring Slam: crowd control immunity (wiki)"}},
  Galio:   {R:{imm:"cc", from:1.25, why:"Hero's Entrance: crowd control immunity after the first 1.25 s of the channel, which is interruptible only before then (wiki)"}},
};
/* Displacement immunity also resists these suppressions (wiki Crowd control § Displacement Immunity) and the stun of these
   knock-up + stun abilities (same section, Notes). */
const DISP_SUPPRESS = {Ambessa:["R"], Skarner:["E","R"], Sett:["R"], TahmKench:["R"]};
const DISP_STUN = {Alistar:["Q"], Ivern:["R"], Maokai:["Q"], Ornn:["E","R"], Rammus:["Q"], Sion:["Q","R"], Tristana:["R"], Velkoz:["E"], XinZhao:["R"], Zac:["Q","E"]};
/* Dashes (wiki Dash): a displacement (airborne) or a knockdown stops a dash in progress — the newest movement overrides the older
   ("move blocks", wiki Types of Crowd Control § Airborne) — unless the dasher is displacement or CC immune (or spell shielded /
   untargetable, which blocks the ability itself). Stuns, roots, silences and the rest don't stop a dash already under way, except
   for these dashes, which immobilizing effects and polymorph also interrupt (wiki Dash § Dashes that are interruptible by CC). */
const DASH_CC_STOPS = {Akshan:["E"], Camille:["E"], Kalista:["P"], Rakan:["W","E"], Yasuo:["E"], Yuumi:["W"]};
const KNOCKDOWN = {Ahri:["E"], Amumu:["R"], Jinx:["E"], Lissandra:["R"], Malzahar:["R"], Veigar:["E"], Vex:["E"], Viktor:["W"], Warwick:["R"], Yone:["R"], Zac:["Q"]};
/* charges the engine models as a cast time (the wiki's channel-type table for them is "charge", which crowd control interrupts:
   Vi Q interrupts = death, ground, root, silence; Sion Q default = silence, death; wiki Template:Channel type): interruptible from the press */
const CHARGE_CAST = {Vi:["Q"], Sion:["Q"]};
const inTable = (T, champ, slot) => !!(T[champ] && T[champ].includes(slot));
/* Energy (AUTOPILOT item 24): game data CharacterRecord primaryAbilityResource arType 1 = energy: 200 maximum (Shen 400),
   10 per second (wiki: 50 per 5 s), no growth. Ability costs are the spell data costs (a.S.cost, by rank). Restores (wiki + game data):
   Zed W passive 30–50 (W rank; rank 1 if unlearned) when Zed and a shadow (or two shadows) hit the same target with one Q or E;
   Lee Sin Flurry: the next 2 attacks after a cast restore 2x / 1x 10/15/20 (levels 1/7/13), Q2 costs 25;
   Kennen E +40 when it damages an enemy, Mark of the Storm stun +25; Shen Q and E +30/40/50 (levels 1/4/12) once per cast that damages;
   Akali W +100 (and +100 maximum while the shroud lasts). fight() Akali keeps her own kit's energy (the same numbers). */
const ENERGY_CHAMPS = {Zed:{max:200, regen:10}, LeeSin:{max:200, regen:10}, Kennen:{max:200, regen:10}, Shen:{max:400, regen:10}, Akali:{max:200, regen:10}};
const SUMM_NAMES = {Flash:"flash", Ghost:"ghost", Heal:"heal", Barrier:"barrier", Ignite:"ignite", Exhaust:"exhaust", Cleanse:"cleanse"};
/* ByCharLevelInterpolation: start → end linearly over levels 1–18; ByCharLevelBreakpoints: level-1 value + per-level bonus */
function summCalc(k, name, L){
  const c=(SUMM[k]||{}).calcs && SUMM[k].calcs[name]; if (!c) return 0;
  if (c.lerp) return c.lerp[0] + (c.lerp[1]-c.lerp[0])*(L-1)/17;
  if (c.bp){ let v=c.bp.l1, per=c.bp.per; for (let l=2;l<=L;l++){ for (const [bl,bper] of c.bp.breaks) if (l===bl) per=bper; v+=per; } return v; }
  return 0;
}
function summNums(k, L){
  const S=SUMM[k]||{}, dv=S.dv||{};
  switch (k){
    case "flash": return {distance:(S.effect||[])[0] ?? 400};
    case "ghost": return {ms:summCalc(k,"movespeedmod",L), duration:dv.duration ?? 10};
    case "heal": return {heal:summCalc(k,"totalheal",L), ms:dv.movespeed ?? 0.3, msDuration:dv.movespeedduration ?? 1, range:dv.allyrange};
    case "barrier": return {shield:summCalc(k,"shieldstrength",L), duration:dv.shieldduration ?? 2.5};
    case "ignite": return {damage:summCalc(k,"tooltiptruedamagecalculation",L), duration:dv.dotduration ?? 5, grievous:dv.grievousamount ?? 0.4};
    case "exhaust": return {slow:(dv.slow ?? 40)/100, damageReduction:(dv.damagereduction ?? 35)/100, duration:dv.debuffduration ?? 3};
    case "cleanse": return {tenacity:dv.tenacityvalue ?? 0.75, duration:dv.tenacityduration ?? 3};
  }
  return {};
}
/* Summoner spell haste: items (data value SummonerHaste: Ionian Boots of Lucidity 10, Crimson Lucidity 20) and
   Cosmic Insight (rune text: 18). Cooldown = base × 100 / (100 + summoner haste). */
function summonerHaste(c){
  let h=0;
  for (const k of c.items||[]){ const v=ITEMS[k] && ITEMS[k].dv && ITEMS[k].dv.summonerhaste; if (v) h+=v[1]; }
  for (const r of c.runes||[]){ const m=/(\d+)\s*Summoner Spell Haste/i.exec((CALC.runes[r]||{}).desc||""); if (m) h+=Number(m[1]); }
  return h;
}
function summCd(k, c){ const base=(SUMM[k]||{}).cd||0; return c ? base*100/(100+summonerHaste(c)) : base; }
/* Nimbus Cloak (wiki, V25.22): +15% / 35% / 45% move speed decaying over 2 s by the summoner's cooldown bracket (up to 100 s,
   up to 250 s, above; summoner haste can drop a spell a bracket: Flash 300 s → 45%, Ghost/Heal/Exhaust 240 s → 35%) */
function nimbusPct(k, c){ const cd=summCd(k, c); return cd<=100 ? 0.15 : cd<=250 ? 0.35 : 0.45; }
function summName(k){ return (SUMM[k]&&SUMM[k].name) || k; }
function setSummoners(c, keys){
  const u=[...new Set(keys)];
  if (u.length>2) throw new Error(`${label(c)} can take two summoner spells, not ${u.map(summName).join(", ")}`);
  return u;
}
/* Ability range that grows with the champion's level (backlog 23): Tristana's Draw a Bead (+0 to 150 over levels 1–18, game data
   P BonusPassiveRange) applies to Explosive Charge and Buster Shot too (wiki Tristana_E / Tristana_R target range "550 to 700"). */
function levelRangeBonus(c, slot){
  if (c.champ==="Tristana" && (slot==="E" || slot==="R") && !c.dummy){
    const v=evalCalc({S:CALC.champs.Tristana.P, rank:1, st:stats(c), flags:new Set()}, "bonuspassiverange").v;
    return v>0 ? {v, why:`Draw a Bead +${fmt(v)} (0 to 150 over levels 1–18, game data BonusPassiveRange; wiki: 550 to 700)`} : null; }
  return null;
}
/* ===== SIM_INTERIM (P2 of the interaction audit, 2026-09-24): INTERIM per-ability data, DELETE when P1 lands =====
   Until src/interactions_export.py (P1) exports the sheets' typed `sim` blocks (data/interactions/<C>.json) into calc.json phys,
   this hand-copied table supplies the fields canDodge needs, with each sheet's wiki evidence in the sheet itself. physOf is the ONE
   merge point: calc.json phys wins, then this table, then P3's SIM_INTERIM_P3 (region T). Field names are the P1 phys names:
     hostile:false            the ability has no effect on enemies (heal / buff / ally / self): canDodge says "no enemy effect"
     reactFrom:"castEnd"      the aim follows the cursor during the cast (DECISIONS 27); otherwise every cast is seen from the press (28)
     cancelOn:[…]             what cancels a unit-targeted cast during its cast time (DECISIONS 3; default untargetable, stasis,
                              invisible, range); a rule-27 page can drop one (Fiddlesticks Q keeps casting on an unseen target)
     inFlight                 "invalidated" | "destroyed" | "hits": what untargetability does to a unit-targeted hit already launched
     flightFrom:"press", pressMissile   the missile leaves at the key press (Syndra R, DECISIONS 5: initial 1, accel 7500, max 10000)
     delayMax                 the upper end of a documented delay range (Karthus Q 0.5–0.75 s, DECISIONS 9; the dodge must work at 0.5)
     grants{kind:[start,end]} the DEFENDER's windows, seconds from its own press (end null = until broken / unknown):
                              untargetable | stasis | invulnerable | parry (voids hits), invisible | camouflage (can't be targeted),
                              ccImmune | displacementImmune (cc: option)
     camouflageDetect         camouflage detection radius (wiki Camouflage: an enemy champion within it sees the unit)
     destroysInbound:false    untargetability that lets projectiles already in flight hit (wiki Untargetable asterisk list)
     requires                 a dash/blink that needs a target: "enemy" | "unit" (the attacker can be that target, but the move goes
                              toward it, so it isn't counted as an escape) | "ally" | "terrain" | "airborne" (not assumed at all) */
const SIM_INTERIM = (()=>{
  const T={
    "Syndra.R":{flightFrom:"press", pressMissile:{speed:1, accel:7500, maxSpeed:10000}, inFlight:"invalidated"},
    "Karthus.Q":{delayMax:0.75},
    "Cassiopeia.R":{reactFrom:"castEnd"},
    "Kennen.W":{fixedTravel:0, cancelOn:["untargetable","stasis"], inFlight:"invalidated"},
    "Fiddlesticks.Q":{cancelOn:["untargetable","stasis","range"]},
    // "still hits" pages (wiki): Irelia Q and Diana E hit a target that turns untargetable during the dash
    "Irelia.Q":{inFlight:"hits"}, "Diana.E":{inFlight:"hits"},
    "Lissandra.R":{inFlight:"invalidated", grants:{untargetable:[0,2.5], stasis:[0,2.5]}},
    "MasterYi.Q":{inFlight:"invalidated", grants:{untargetable:[0,0.937]}, requires:"enemy"},
    "Fizz.E":{grants:{untargetable:[0,1.25]}}, "Vladimir.W":{grants:{untargetable:[0,2]}}, "Zed.R":{grants:{untargetable:[0,0.95]}, requires:"enemy"},
    "Ekko.R":{grants:{stasis:[0,1]}}, "Olaf.R":{grants:{ccImmune:[0,3]}}, "Fiora.W":{grants:{parry:[0,0.75], ccImmune:[0,0.75]}},
    "Evelynn.R":{grants:{untargetable:[0,0.85]}}, "Xayah.R":{grants:{untargetable:[0,1.5]}}, "Kayle.R":{grants:{invulnerable:[0,2.5]}},
    "Camille.R":{grants:{untargetable:[0,0.5], displacementImmune:[0,0.5]}, requires:"enemy"},
    "Galio.R":{grants:{untargetable:[1.25,2.25], ccImmune:[1.25,2.75]}, requires:"ally"},
    "RekSai.R":{grants:{untargetable:[0.25,1.15]}, requires:"enemy"}, "Naafiri.W":{grants:{untargetable:[0.75,1.75]}, requires:"enemy"},
    "Shaco.R":{grants:{untargetable:[0.25,0.75]}},
    "Akali.W":{grants:{invisible:[0,5]}}, "Khazix.R":{grants:{invisible:[0,1.25]}}, "MonkeyKing.W":{grants:{invisible:[0,1]}}, "Neeko.W":{grants:{invisible:[0,0.5]}},
    "Evelynn.P":{grants:{camouflage:[0,null]}, camouflageDetect:700}, "Akshan.W":{grants:{camouflage:[0.5,null]}, camouflageDetect:800},
    "Viego.E":{grants:{camouflage:[0,null]}, camouflageDetect:450}, "Rengar.R":{grants:{camouflage:[2,14]}, camouflageDetect:710},
    "Senna.E":{grants:{camouflage:[1,null]}, camouflageDetect:400}, "Twitch.Q":{grants:{camouflage:[1,null]}, camouflageDetect:500},
    "Pyke.W":{grants:{camouflage:[0,5]}},
    "Ambessa.R":{grants:{displacementImmune:[0,1.45]}, requires:"enemy"}, "Illaoi.R":{grants:{displacementImmune:[0,0.5]}},
    "Ornn.W":{grants:{displacementImmune:[0,0.75]}}, "Volibear.R":{grants:{displacementImmune:[0,1]}}, "Briar.R":{grants:{ccImmune:[1,2.25]}},
  };
  // dashes and blinks that need a target (sheets' grantsSelf.dash/blink; P0 sim dash/blink.requires)
  for (const [req, list] of [["enemy","Akali.R Alistar.W Diana.E Evelynn.E Fizz.Q Hecarim.E JarvanIV.R Jayce.Q Kayn.R Maokai.W MonkeyKing.E Nocturne.R Pantheon.W Poppy.E Qiyana.E Quinn.E Sylas.W Talon.Q Vi.R XinZhao.E"],
                             ["unit","Irelia.Q Jax.Q Katarina.E Nilah.E Samira.E Yasuo.E"], ["ally","LeeSin.W Braum.W Rakan.E Yuumi.W"],
                             ["terrain","Akshan.E Camille.E Bard.E"], ["airborne","Yasuo.R"]])
    for (const k of list.split(" ")) T[k] = {...(T[k]||{}), requires:req};
  // no effect on enemy champions (P0 sim hostile:false: heals, shields, buffs, ally and self abilities; left out here: the ones
  // whose empowered attacks, summons, landings or recasts do hit enemies, e.g. Nasus Q, Heimerdinger Q, Tahm Kench W, Zed W)
  for (const k of ("Aatrox.E Aatrox.R Akali.W Akshan.W Alistar.R Annie.E Aphelios.W Aphelios.E Ashe.E AurelionSol.W Aurora.W Bard.W Bard.E Blitzcrank.W Braum.W Braum.E "+
    "DrMundo.R Draven.W Elise.R Gangplank.W Garen.W Graves.E Gwen.W Heimerdinger.R Ivern.W Janna.E Jayce.R "+
    "KSante.E Kaisa.E Kaisa.R Karma.E Karma.R Katarina.W Kayle.W Kayle.R Kayn.E Khazix.R LeeSin.W Lucian.E Lux.W MasterYi.W "+
    "MasterYi.R Milio.W Milio.E Milio.R MissFortune.W Mordekaiser.W Morgana.E Nami.E Nasus.R Neeko.W Nidalee.R Nilah.W Nocturne.W "+
    "Olaf.W Olaf.R Pyke.W Qiyana.W Quinn.W Quinn.R Rakan.E Renata.W Riven.E Rumble.W Ryze.R Senna.E Seraphine.W Shen.W "+
    "Shen.R Singed.R Sivir.E Sivir.R Sona.W Sona.E Soraka.W Soraka.R TahmKench.E Talon.E Taric.Q Taric.W Taric.R Teemo.W Thresh.W Tristana.Q "+
    "Trundle.W Tryndamere.Q Tryndamere.R Twitch.Q Udyr.W Vayne.R Viego.E Xayah.W Yasuo.W Yunara.E Yunara.R Yuumi.W Yuumi.E "+
    "Zilean.W Zilean.R Zoe.R").split(" ")) T[k] = {...(T[k]||{}), hostile:false};
  return T; })();
/* read accessor (one interim path, shared with P3): the interim fields for champ.slot, P2's over P3's */
function simInterim(champ, slot){ const k=`${champ}.${slot}`, p3=(typeof SIM_INTERIM_P3!=="undefined" && SIM_INTERIM_P3[k]) || {};
  return {...p3, ...(SIM_INTERIM[k]||{})}; }
function physOf(c, slot){
  const S=CALC.champs[c.champ][slot]||{}, w=WORLD.champ(c.champ), sl=w.slots[slot]||{tags:{}};
  const p={speed:0, castTime:0.25, delay:0, ...simInterim(c.champ, slot), ...(S.phys||{})};
  // the ability's rank at this level (auto-allocated like .damage and .range), not rank 1: Nocturne R reaches 4000 at rank 3
  const rank=Math.max(1, (c.ranks && c.ranks[slot]!=null ? c.ranks[slot] : c.dummy ? 1 : rankOf(c, slot)) || 1);
  p.range = sl.range && sl.range.length ? (sl.range[rank-1] ?? sl.range[0]) : 0;
  { const rb=levelRangeBonus(c, slot); if (rb) p.range += rb.v; }
  // hits that are basic attacks (Twitch R): the target range is the attack range + the bonus (wiki "Twitch's attack range"), not the files' bolt travel
  if (p.attackRangeBonus!=null && !c.dummy) p.range = stats(c).range + p.attackRangeBonus;
  if (S.minRange){ p.minRange = S.minRange[rank] ?? S.minRange[1]; p.chargeTime = S.chargeTime; }
  const ov = w.physOver && w.physOver[slot];
  const originText = p.origin;
  if (ov){ Object.assign(p, ov.v); if (ov.v.width!=null) p.halfWidth=ov.v.width/2; if (TR) TR.asm.add(`line ${ov.f.line}: ${ov.f.text}`);
    if (ov.v.origin!=null){ p.originDist=ov.v.origin; p.origin=originText||"another object"; p.originSet=true; }
    if (ov.v.reveal!=null) p.revealAt=ov.v.reveal; }
  // where the ability comes from (calc.json phys.delivery, from the game files' targeting type + data/delivery_overrides.json)
  if (!p.delivery) p.delivery = sl.tags.targeted!==undefined && !p.halfWidth ? "unit" : p.halfWidth ? "skillshot" : p.coneAngle ? "cone" : (p.radius && p.range) ? "placed" : "self";
  else if (!(ov && ov.v.delivery) && p.aim==="TargetOrLocation" && sl.tags.targeted!==undefined && p.delivery!=="remote") p.delivery="unit";
  // a self-cast stance whose tooltip names a target (Darius W, Nasus Q: the next attack): point-and-click
  else if (!(ov && ov.v.delivery) && !p.deliveryNote && p.delivery==="self" && sl.tags.targeted!==undefined) p.delivery="unit";
  if (p.delivery==="remote" && p.originDist==null) p.originDist=0;
  if (!p.kind){ const dl=p.delivery;
    p.kind = dl==="unit" ? "targeted" : dl==="self" ? "self" : dl==="cone" ? "cone" : dl==="vector" ? "line"
      : (dl==="lobbed"||dl==="placed") ? (p.halfWidth && !p.radius ? "line" : "area") : p.halfWidth ? "line" : p.coneAngle ? "cone" : p.radius ? "area" : "line"; }
  return p;
}
const DELIVERIES = {skillshot:"skillshot", lobbed:"lobbed", placed:"placed", vector:"vector", remote:"remote", unit:"point-and-click", self:"centred on the caster", cone:"cone"};
/* THE REACH RULE — one rule for canDodge, fight() and combos. The greatest centre-to-centre distance at which
   something hits a target, given the caster's gameplay radius rc and the target's rt (wiki "Range", Calculations
   + "Targeted abilities"; game data: the spell record's castRangeUseBoundingBoxes flag, calc.json phys.edgeRange):
   - basic attacks: edge range, always: attack range + rc + rt (Annie 625 + 65 + 65 = 755 vs a 65-radius target)
   - point-and-click spells: centred range: the cast range itself (Annie Q 625 reaches a centre 625 away,
     whatever the target's size; wiki: "Annie q and normal attack same 625 range, but normal attack range longer")
     — except the spells whose record sets castRangeUseBoundingBoxes (Tristana E/R, Vayne E, Viktor Q, Ryze W/E,
     Anivia E, Lucian Q, …; the same list as the wiki's edge-range table): edge range, range + rc + rt
   - everything else (skillshots, areas, cones): centre to edge: its reach (reachOf) + rt; except skillshots whose wiki
     range icon marks the files' number (calc.json phys.reachMode): {{tip|cr}} centred (reach), {{tip|er}} edge (reach + rc + rt)
   - abilities whose hits are basic attacks (p.attackRangeBonus: Twitch R): attack range + bonus + rc + rt
   A point-and-click ability without a cast range of its own (an empowered attack) uses the attack reach. */
function attackReach(range, rc, rt){ return range + rc + rt; }
function hitReach(p, rc, rt, atkRange){
  // p.attackRangeBonus (data/delivery_overrides.json): the ability's hits are basic attacks at the attack range + a bonus (Twitch R +300): edge range
  if (p.attackRangeBonus!=null) return attackReach((atkRange||0) + p.attackRangeBonus, rc, rt);
  // p.reach (data/delivery_overrides.json): a dash or orbit before the homing bolt (Ahri W/R, Ezreal E, Kindred Q): centred too
  if (p.delivery==="unit"){ const r=p.reach ?? p.range; return !(r>0) ? attackReach(atkRange||0, rc, rt) : p.edgeRange ? r + rc + rt : r; }
  const r=reachOf(p); if (!(r>0)) return attackReach(atkRange||0, rc, rt);
  // skillshots: the wiki's range icon per ability (calc.json phys.reachMode, backlog 23): {{tip|cr}} centred (the target's centre
  // must be within the range: wiki Range, "in most cases the target's center has to be within the maximum range"), {{tip|er}} edge
  // range (range + both hitboxes); without an icon centre to edge (range + the target's hitbox)
  if (p.delivery==="skillshot" && p.reachMode==="centre") return r;
  if (p.delivery==="skillshot" && p.reachMode==="edge") return r + rc + rt;
  return r + rt;
}
// the working for hitReach, in words
function reachWhy(p, rc, rt, atkRange){ const v=hitReach(p, rc, rt, atkRange), r = p.delivery==="unit" ? p.reach ?? p.range : reachOf(p);
  if (p.attackRangeBonus!=null) return `its hits are basic attacks: attack range ${fmt(atkRange||0)} + ${fmt(p.attackRangeBonus)} + ${fmt(rc)} + ${fmt(rt)} hitboxes = ${fmt(v)} (edge range, wiki Range)`;
  if (!(r>0)) return `attack range ${fmt(atkRange||0)} + ${fmt(rc)} + ${fmt(rt)} hitboxes = ${fmt(v)} (edge range, wiki Range)`;
  if (p.delivery==="skillshot" && p.reachMode==="centre") return `reach ${fmt(r)}, centre to centre (the wiki marks its range {{tip|cr}}: the target's centre must be within it)`;
  if (p.delivery==="skillshot" && p.reachMode==="edge") return `reach ${fmt(r)} + ${fmt(rc)} caster hitbox + ${fmt(rt)} hitbox = ${fmt(v)} (the wiki marks its range {{tip|er}}: edge range)`;
  if (p.delivery!=="unit") return `reach ${fmt(r)} + ${fmt(rt)} hitbox = ${fmt(v)} (centre to edge, wiki Range)`;
  if (p.edgeRange) return `${fmt(r)} + ${fmt(rc)} caster hitbox + ${fmt(rt)} hitbox = ${fmt(v)} (edge range: the game files' castRangeUseBoundingBoxes; wiki Range "Targeted abilities")`;
  return `${fmt(v)}, centre to centre (point-and-click spells use centred range, wiki Range: the hitboxes don't extend it)`; }
/* How far from the caster the ability can hit (to the edge of its area). */
function reachOf(p){
  if (p.reach!=null) return p.reach;
  switch (p.delivery){
    case "lobbed": case "placed": return p.range + (p.radius||0);       // lands anywhere within range; the area reaches past it
    case "vector": return p.range + (p.length||0);                      // starts anywhere within range, then runs its length
    case "remote": return (p.originRange ?? p.range) + (p.kind==="area" ? (p.radius||0) : 0);
    case "self": return p.radius || p.range;
    case "cone": return p.coneLength || p.range;
    default: return p.range + (p.kind==="area" && p.delivery!=="skillshot" ? (p.radius||0) : 0);
  }
}
/* Units the ability travels before it reaches a target d units away, aimed perfectly. */
function travelDist(p, d){
  switch (p.delivery){
    case "placed": return 0;
    case "lobbed": return Math.min(d, p.range||d);
    case "vector": return p.originDist ?? Math.max(0, d - (p.range||0));
    case "remote": return p.originDist ?? 0;
    case "self": return p.speed ? d : 0;
    default: return d;
  }
}
function describePhys(who, p){
  return `${who}: ${DELIVERIES[p.delivery]||p.delivery} (${p.kind}), range ${fmt(p.range)}${p.minRange?` (charged from ${fmt(p.minRange)} over ${fmt(p.chargeTime)}s)`:""}${p.delivery==="vector"&&p.length?` + ${fmt(p.length)} length`:""}${p.delivery==="remote"?`, from ${p.origin||"another object"}`:""}, cast time ${fmt(p.castTime)}s${p.speed?`, speed ${fmt(p.speed)}/s${p.accel?` accelerating ${p.maxSpeed||p.minSpeed?`to ${fmt(p.maxSpeed||p.minSpeed)}`:`by ${fmt(p.accel)}/s²`}`:""}`:""}${p.halfWidth?`, width ${fmt(2*p.halfWidth)}`:""}${p.kind!=="line"&&p.radius?`, radius ${fmt(p.radius)}`:""}${p.delay?`, delay ${fmt(p.delay)}s`:""}`;
}
/* One line saying where the ability comes from and what the distance does to its timing. */
function deliveryLine(c, p, d, tr, travel){
  const who=label(c), sp = p.speed ? ` at ${fmt(p.speed)}/s${p.accel?` (accelerating)`:""}` : "", after = p.delay ? ` ${fmt(p.delay)}s after the cast` : " when the cast ends";
  switch (p.delivery){
    case "placed": return `placed: appears at the target point${after}; distance doesn't matter`;
    case "lobbed": return `lobbed: thrown from ${who} to the target point, flies ${fmt(travel)} units${sp} (${fmt(tr)}s), then hits a ${fmt(p.radius||0)} radius there`;
    case "vector": return `vector: starts anywhere within ${fmt(p.range)} and runs ${fmt(p.length||0)} in a chosen direction; aimed perfectly its start sits ${fmt(travel)} units from the target${p.speed?`, so ${fmt(travel)}/${fmt(p.speed)} = ${fmt(tr)}s of travel`:""}`;
    case "remote": return `remote: comes from ${p.origin||"another object"}, ${fmt(travel)} units from the target (${p.originSet?"set":"perfect play: already on it"}; set with setPhysics(origin: units))${p.speed&&travel?`, ${fmt(tr)}s of travel${sp}`:""}`;
    case "self": return `centred on ${who}: radius ${fmt(p.radius||p.range)}${p.speed?`, expanding${sp}: reaches ${fmt(d)} units in ${fmt(tr)}s`:""}`;
    case "unit": return `point-and-click${p.speed?`: travels ${fmt(travel)} units${sp}`:": no travel time"}`;
    case "cone": return `cone from ${who}${p.speed?`, travels ${fmt(travel)} units${sp}`:""}`;
    default: return `skillshot: fired from ${who}, travels ${fmt(travel)} units${sp}`;
  }
}
/* Flight time over d units. Accelerating missiles (Ashe R, Shen Q, …) speed up (or slow down) from their
   initial speed at `accel` units/s² until they reach their top (or bottom) speed. */
function travelTime(p, d){
  if (!p.speed) return 0;
  const a=p.accel||0;
  if (!a) return d/p.speed;
  const lim = a>0 ? (p.maxSpeed||Infinity) : (p.minSpeed||0);
  const t1 = Number.isFinite(lim) ? (lim-p.speed)/a : Infinity, d1 = p.speed*t1 + a*t1*t1/2;
  if (d <= d1 || !Number.isFinite(t1)) return (-p.speed + Math.sqrt(Math.max(0, p.speed*p.speed + 2*a*d)))/a;
  return t1 + (d-d1)/lim;
}
function delayNote(c, slot, p){
  if (TR && p.delay && p.delaySource==="wiki") TR.notes.add(`${label(c)}.${slot}: appear-delay ${fmt(p.delay)}s is from the wiki, not the game files (an assumption; override with setPhysics(delay: …))`);
}
/* When an ability's effect lands, from the key press (backlog 25): the cast time, then the flight over its travel distance to a
   target d units away, then any appear-delay (ground, arm, effect, launch; they start once the missile, if any, has landed).
   One rule for .arrival, canDodge, fight() and perform() (fight() adds the per-kit exceptions in its landOf). */
function abilityHits(c, slot){ const S=(CALC.champs[c.champ]||{})[slot]||{}, k=kitSpec(c, slot);
  return !!(S.main || (S.mainparts||[]).length || (S.cc||[]).length || (k && k.parts) || S.heal || S.shield); }
// a missile that leaves at the key press (phys.flightFrom "press": Syndra R's spheres, DECISIONS 5) doesn't wait for the cast time
function landTime(p, d){ return (p.flightFrom==="press" ? 0 : (p.castTime||0)) + chargeTime(p, d) + flightTime(p, d) + (p.delay||0); }
/* The flight to a target d units away: a fixed-time missile (phys.fixedTravel: Zilean Q 0.45 s), a missile with a minimum flight
   (phys.minTravel: Corki Q 0.227 s), a dash with no missile (phys.dashSpeed: Poppy E, Wukong E), else the missile's own travel */
function flightTime(p, d){ if (p.fixedTravel!=null) return p.fixedTravel;
  if (p.flightFrom==="press" && p.pressMissile && !p.speed) return travelTime({...p, ...p.pressMissile}, travelDist({...p, ...p.pressMissile}, d));
  const tr = !p.speed && p.dashSpeed ? travelTime({...p, speed:p.dashSpeed}, d) : travelTime(p, travelDist(p, d));   // a dash covers the whole distance
  return p.minTravel ? Math.max(p.minTravel, tr) : tr; }
/* A charged ability (phys.charge, Xerath Q; data/delivery_overrides.json): the range grows by `per` every `step` seconds after an
   initial `init`, from `base` up to `max`; the charge ends at the first step whose range reaches the target (d units, centre) */
function chargeTime(p, d){ const C=p.charge; if (!C) return 0;
  return Math.max(C.min||0, C.init + Math.ceil(Math.max(0, Math.min(d, C.max)-C.base)/C.per - 1e-9)*C.step); }
function arrivalTime(c, slot, d, p0){
  const p=p0||physOf(c, slot);
  const travel = travelDist(p, d), tr = flightTime(p, d);
  // a self-buff with nothing to hit (Kai'Sa E, Rengar R: no damage, no crowd control) "arrives" when its cast time ends, as in
  // fight()/perform() (backlog 25); its missile/delay fields describe something else (an animation, the stealth's onset)
  if (!p0 && !abilityHits(c, slot)){ line(`${describePhys(`${label(c)}.${slot}`, p)}`);
    line(`  no damage or crowd control to deliver (a self-buff): its effect starts when the ${fmt(p.castTime)}s cast time ends`); return p.castTime||0; }
  const t = landTime(p, d);
  line(`${describePhys(`${label(c)}.${slot}`, p)}`);
  line(`  ${deliveryLine(c, p, d, tr, travel)}`);
  const how = p.fixedTravel!=null ? (p.fixedTravel ? ` + ${fmt(p.fixedTravel)}s fixed flight` : "") : !p.speed || !travel ? "" : p.accel ? ` + ${fmt(tr)}s travel (accelerating ${fmt(p.speed)}→${fmt(p.maxSpeed||p.minSpeed||(p.speed+p.accel*tr))}, average ${fmt(travel/Math.max(tr,1e-9))}/s)` : ` + ${fmt(travel)}/${fmt(p.speed)} travel`;
  const ch = p.charge ? ` + ${fmt(chargeTime(p, d))}s charging to reach ${fmt(Math.min(d, p.charge.max))} (${fmt(p.charge.base)} + ${fmt(p.charge.per)} per ${fmt(p.charge.step)}s after ${fmt(p.charge.init)}s)` : "";
  if (p.flightFrom==="press"){ const M=p.pressMissile||p;
    line(`  launched at the key press (the ${fmt(p.castTime)}s cast time runs alongside): ${fmt(travel)} units at ${fmt(M.speed)}/s accelerating ${fmt(M.accel)}/s² to ${fmt(M.maxSpeed)} = ${fmt(tr)}s${p.delay?` + ${fmt(p.delay)}s`:""} = ${fmt(t)}s after the press`);
    if (TR) TR.notes.add(`${label(c)}.${slot}: the missile leaves at the key press and accelerates (DECISIONS 5; game files initial ${fmt(M.speed)}, accel ${fmt(M.accel)}, max ${fmt(M.maxSpeed)}): lands √(2d/${fmt(M.accel)}) s after the press`);
    return t; }
  line(`  arrives at ${fmt(d)} units after ${fmt(p.castTime)}s cast${ch}${how}${p.delay?` + ${fmt(p.delay)}s ${p.delayKind==="missile_travel"?"flight time":p.delayKind==="arm"?"arming delay":p.delayKind==="channel"?"channel":p.delayKind==="lockout"?"release lockout":"appear-delay"}`:""} = ${fmt(t)}s from the start of the cast`);
  delayNote(c, slot, p);
  const who=`${label(c)}.${slot}`;
  if (TR && p.deliveryNote) TR.notes.add(`${who} (${p.delivery}): ${p.deliveryNote}`);
  for (const [k,n] of [["radiusSource","radius"],["speedSource","speed"],["halfWidthSource","width"],["castTimeSource","cast time"]])
    if (TR && p[k]==="wiki") TR.notes.add(`${who}: ${n} is from the wiki, not the game files (override with setPhysics)`);
  if (TR && p.delivery==="placed" && !p.delay) TR.notes.add(`${who}: no appear-delay is known for this placed ability (counted as 0); set one with ${champName(c)}.${slot}.setPhysics(delay: …)`);
  return t;
}
/* When the defender can first react, from the attacker's key press (DECISIONS 3/4/18/19/24/28, 2026-09-24): EVERY cast can be
   reacted to from the press (the wind-up, the locked aim or the unit-targeted cast is visible), unless the aim follows the cursor
   during the cast (phys.reactFrom "castEnd", a rule-27 page: Cassiopeia R), when it's the end of the cast; a telegraph the data says
   shows later still wins (Rumble R, Tahm Kench W; setPhysics(reveal: seconds)). */
function revealOf(p){ return p.revealAt ?? (p.reactFrom==="castEnd" ? (p.castTime||0) : 0); }
function revealWhy(p){ return p.revealAt!=null ? "when the first of it shows" : p.reactFrom==="castEnd" ? "the end of the cast time: its aim follows the cursor during the cast (wiki; DECISIONS 27)"
  : p.flightFrom==="press" ? "the key press: the missile leaves then (DECISIONS 5)" : (p.castTime||0)>0 ? "the key press: the wind-up shows where it's going (DECISIONS 3/4/19/28)" : "the key press: no cast time"; }
function dashInfo(c, slot){
  const p=physOf(c, slot), tags=WORLD.champ(c.champ).slots[slot].tags;
  const blink = tags.blink!==undefined && tags.dash===undefined;
  let speed = p.dashSpeed;
  if (!blink && !speed){ speed = 1200; if (TR) TR.notes.add(`${label(c)}.${slot}: dash speed isn't in the game data; assumed 1200 units/s (set with setPhysics(dashSpeed: …))`); }
  const dist = p.dashRange ?? p.range;
  return {dist, time: p.castTime + (blink ? 0 : dist/speed), blink, castTime:p.castTime};
}
function canDodge(def, ab, named){
  if (!def || def.t!=="champ") throw new Error("canDodge(defender, ability, distance: …) needs a Champion first");
  if (def.dummy) throw new Error("canDodge: the practice-tool Target Dummy never moves, so it dodges nothing. Use a champion as the defender (its move speed decides the dodge)");
  if (ab && ab.t==="ability" && ab.owner.dummy) throw new Error("canDodge: the Target Dummy has no abilities");
  if (!ab || ab.t!=="ability") throw new Error("the second argument is an ability, e.g. syndra.E");
  checkNamed(named, ["distance","using","reaction","preBuff","hitbox","recast","cc"], "canDodge(…)");
  const d=named.distance; if (typeof d!=="number" || !(d>=0) || !Number.isFinite(d)) throw new Error("canDodge needs distance: (units between the two champions, 0 or more)");
  if (named.reaction!=null && !(typeof named.reaction==="number" && named.reaction>=0 && Number.isFinite(named.reaction))) throw new Error("reaction: is a reaction time in seconds (0 or more)");
  if (named.hitbox!=null && !(typeof named.hitbox==="number" && named.hitbox>=0)) throw new Error("hitbox: is the defender's gameplay radius in units, e.g. hitbox: 90");
  if (named.cc!=null && typeof named.cc!=="boolean") throw new Error("cc: is true (ask whether the ability's crowd control lands) or false");
  const react=named.reaction ?? 0, a=ab.owner, s=ab.slot, p=physOf(a,s), who=`${label(a)}.${s}`;
  const HB = named.hitbox ?? hitboxOf(def), hbFrom = named.hitbox!=null ? "set with hitbox:" : "game files: character record";
  if (TR){ TR.notes.add(`${label(def)}'s gameplay radius (hitbox) is ${fmt(HB)} units (${hbFrom}); the ability is aimed perfectly at the defender`);
    if (named.hitbox==null && SIZE_NOTES[def.champ]) TR.notes.add(`${label(def)}: size modifiers scale the hitbox (wiki "Size"): ${SIZE_NOTES[def.champ]}; test a bigger one with hitbox:`); }
  // heals, shields, buffs, ally and self abilities (phys.hostile false; interaction sheets): nothing reaches the enemy
  if (p.hostile===false){ line(`${describePhys(who,p)}`); line(`  no enemy effect: ${who} is a heal, shield, buff or ally/self ability (interaction sheet data/interactions/${a.champ}.json), so there is nothing to dodge`); return true; }
  const selfArea = p.delivery==="self" && (p.radius || p.speed);
  const edge = p.kind==="line" ? (p.halfWidth||0) : p.kind==="cone" ? Math.min(p.coneLength||p.range, d)*Math.tan((p.coneAngle||30)*Math.PI/360) : (p.radius||0);
  const RC = hitboxOf(a), reach = hitReach(p, RC, HB, stats(a).range);   // the shared reach rule (see hitReach)
  const reachText = reachWhy(p, RC, HB, stats(a).range);
  if (p.kind==="self" && !selfArea){ line(`${describePhys(who,p)}; it isn't a projectile or area ability, so dodging doesn't apply`); return false; }
  if (d > reach + 1e-6){ line(`${describePhys(who,p)}`); line(`  ${fmt(d)} units is beyond its reach (${reachText}): dodged by standing still`); return true; }
  let T = arrivalTime(a, s, d, p);
  if (p.delayMax!=null){ line(`  its delay is a documented range ${fmt(p.delay)}–${fmt(p.delayMax)}s (wiki; DECISIONS 9): a dodge counts only if it works at ${fmt(p.delay)}s, the earliest`);
    if (TR) TR.notes.add(`${who}: the wiki documents an inconsistent delay of ${fmt(p.delay)}–${fmt(p.delayMax)} s; canDodge uses ${fmt(p.delay)} s (DECISIONS 9)`); }
  // a stacking field (Viktor W, phys.stackStun): what must be dodged is the stun on the last stack, (stacks − 1) × every after it activates;
  // the defender only needs to be outside by then, and is slowed while inside the active field (viktor-akali G3)
  const G=p.stackStun; let slowSpec=null;
  if (G){ const act=T, rank=Math.max(1, rankOf(a,s)||1), se=(ccList(a, s, rank).list||[]).find(e=>e.type==="slow"), pct=se ? se.pct : 0;
    T = act + (G.stacks-1)*G.every;
    line(`  active at ${fmt(act)}s: a stack every ${fmt(G.every)}s inside (slowed ${fmt(100*pct)}% while inside), the ${G.stacks}th stuns at ${fmt(T)}s; ${label(def)} dodges the stun by being outside the field then (stacks drop ${fmt(G.debuff)}s after leaving)`);
    if (TR) TR.notes.add(`${who}: the stun lands on the ${G.stacks}th stack, ${fmt(T)} s after the cast starts (wiki Viktor_W); the field is placed on the defender (perfect aim); walking out needs its radius + the hitbox, slowed once the field is active`);
    slowSpec={pct, need:0, atAbs:act}; }
  const reveal = Math.min(revealOf(p), T), tp0 = reveal + react, win = T - reveal, avail = win - react;
  line(`  ${label(def)} can react from ${fmt(reveal)}s (${revealWhy(p)}); it ${G?"stuns":"lands"} ${fmt(win)}s later: ${fmt(win)}s − ${fmt(react)}s reaction = ${fmt(avail)}s to respond`);
  const ds=stats(def), Y=named.using;
  const acts = Y ? (Y.t==="list" ? Y.items : [Y]).map(y=>dodgeAction(def, y, !!named.preBuff, ds, !!named.recast, a, d)) : [];
  const fmtW = w => `${fmt(w.s)}–${Number.isFinite(w.e) ? fmt(w.e) : "…"}s`;
  // the hit lands: does its crowd control? (cc: true asks exactly that; otherwise the answer is the hit, with the CC note in the trace)
  const hit = why => { line(`  → ${why||"hit"}`); stormLine(def, a, s, p, d, HB, ds);
    const rank=Math.max(1, rankOf(a,s)||1), types=[...new Set((ccList(a, s, rank).list||[]).map(e=>e.type).filter(Boolean))];
    if (!types.length){ if (named.cc){ line(`  ${who} has no crowd control: none lands`); return true; } return false; }
    const imm=[]; for (const x of acts) for (const w of x.ccImm||[]) if (tp0 + w.s <= T + 1e-9) imm.push({x, w});
    const covers = t => imm.some(({w}) => w.kind==="cc" || (w.kind==="displacement" && (DISP_CC_TYPES.has(t) || (t==="suppression" && inTable(DISP_SUPPRESS, a.champ, s)) || (t==="stun" && inTable(DISP_STUN, a.champ, s)))));
    const stopped=types.filter(covers), lands=types.filter(t=>!covers(t));
    if (stopped.length) line(`  the ${stopped.join(" and ")} doesn't apply: ${imm.map(({x,w})=>`${x.label} ${w.kind==="cc"?"crowd control":"displacement"} immunity ${fmtW(w)} after its press`).join("; ")} covers the landing at ${fmt(T)}s (wiki Crowd control § Immunity)`);
    if (named.cc){ if (lands.length){ line(`  its ${lands.join(" and ")} lands`); return false; } line(`  → none of its crowd control lands`); return true; }
    return false; };
  const targeted = p.kind==="targeted";
  // already unseen (preBuff: true with an invisibility / camouflage tool): a point-and-click spell can't be cast on a unit its caster
  // can't see (wiki Invisibility) — unless camouflage is within its detection radius of the caster (wiki Camouflage)
  if (targeted && named.preBuff) for (const x of acts) if (x.unseen && x.unseen.pre){
    if (x.unseen.kind==="camouflage" && !(d > (x.unseen.detect ?? Infinity))){
      line(`  ${x.label}: camouflage, but ${label(a)} is ${fmt(d)} units away, within its ${x.unseen.detect!=null?`${fmt(x.unseen.detect)} detection radius`:"detection radius (unknown: assumed seen)"} (wiki Camouflage), so ${label(def)} can be targeted`); continue; }
    line(`  ${x.label}: ${label(def)} is already ${x.unseen.kind==="camouflage"?`camouflaged beyond its ${fmt(x.unseen.detect)} detection radius`:"invisible"}, so ${who} (point-and-click) can't be cast on her → dodged (reaction time doesn't matter: there is nothing to target)`); return true; }
  if (avail<=0) return hit("hit: no time to respond");
  // void windows (untargetable / stasis / invulnerable / parry), pressed at tp0 or later: it covers the landing at T iff tp0 + start ≤ T
  const voids=[]; for (const x of acts) for (const w of x.void||[]) voids.push({x, w, ok: tp0 + w.s <= T + 1e-9, press: Math.max(tp0, T - w.e)});
  if (targeted){
    const cancelOn = p.cancelOn || ["untargetable","stasis","invisible","range"];
    const L = p.flightFrom==="press" ? 0 : (p.castTime||0), cw = L - tp0;
    const cxl = p.cancelSpends ? " (a documented bug: it still goes on cooldown and pays its cost)" : "";
    if (L>0){
      line(`  unit-targeted with a ${fmt(L)}s cast time: going untargetable, into stasis, unseen or out of range before it ends cancels it (DECISIONS 3; no cooldown, no cost); ${label(def)} has ${fmt(L)}s − ${fmt(tp0)}s = ${fmt(cw)}s for that`);
      if (cw >= -1e-9){
        for (const {x, w} of voids) if ((w.kind==="untargetable" || w.kind==="stasis") && cancelOn.includes(w.kind) && tp0 + w.s <= L + 1e-9){
          line(`  ${x.label}: ${w.kind} ${fmtW(w)} after its press, from ${fmt(tp0 + w.s)}s ≤ ${fmt(L)}s → ${who} is cancelled${cxl} (dodged)`); return true; }
        for (const x of acts) if (x.unseen && !x.unseen.pre && tp0 + x.unseen.s <= L + 1e-9){
          if (x.unseen.kind==="camouflage" && !(d > (x.unseen.detect ?? Infinity))){ line(`  ${x.label}: camouflage within ${label(a)}'s reach of its ${x.unseen.detect!=null?fmt(x.unseen.detect):"unknown"} detection radius: still seen`); continue; }
          if (!cancelOn.includes("invisible")){ line(`  ${x.label}: unseen from ${fmt(tp0 + x.unseen.s)}s, but ${who} still casts on a target it loses sight of (its wiki page; DECISIONS 27)`); continue; }
          line(`  ${x.label}: ${x.unseen.kind==="camouflage"?"camouflaged (beyond the detection radius)":"invisible"} from ${fmt(tp0 + x.unseen.s)}s ≤ ${fmt(L)}s → ${who} is cancelled${cxl} (dodged)`); return true; }
        if (cancelOn.includes("range")){ const gap = reach - d, mv = bestMove(def, acts, ds, cw, null);
          line(`  out of range: ${fmt(gap)} more units puts it beyond its reach (${reachText}); in ${fmt(cw)}s: ${mv.plan} → ${fmt(mv.dist)} units`);
          if (mv.dist > gap + 1e-6){ line(`  → ${who} is cancelled${cxl}: ${label(def)} leaves its range during the cast (dodged)`); return true; } }
      } else line(`  too late to cancel it during the cast (${fmt(tp0)}s > ${fmt(L)}s)`);
    }
    // cast: the hit is on its way. What untargetability does to it now (phys.inFlight; wiki Untargetable: "most untargetabilities destroy
    // inbound projectiles"; the abilities whose page says they still hit, e.g. Irelia Q, Diana E)
    const flying = p.speed>0 || p.flightFrom==="press" || p.fixedTravel>0;
    const inF = p.inFlight || (flying ? "destroyed" : "lands");
    for (const {x, w, ok, press} of voids){
      if (!ok){ line(`  ${x.label}: ${w.kind} from ${fmt(tp0 + w.s)}s at the earliest, after it lands at ${fmt(T)}s`); continue; }
      if (w.kind!=="untargetable"){ line(`  ${x.label}: ${w.kind} ${fmtW(w)} after its press; pressed at ${fmt(press)}s it covers the landing at ${fmt(T)}s: ${who} does nothing → dodged`); return true; }
      if (inF==="hits"){ line(`  ${x.label}: untargetable, but ${who} was already cast and still hits an untargetable target (its wiki page)`); continue; }
      if (inF==="destroyed" && w.destroys===false){ line(`  ${x.label}: untargetable, but it doesn't destroy projectiles already in flight (wiki Untargetable), so ${who} still hits`); continue; }
      const how = inF==="invalidated" ? `untargetable while it is in flight voids it (wiki; phys.inFlight)` : inF==="destroyed" ? `going untargetable destroys the inbound projectile (wiki Untargetable)` : `untargetable when it lands, so it isn't applied`;
      line(`  ${x.label}: untargetable ${fmtW(w)} after its press, from ${fmt(tp0 + w.s)}s ≤ ${fmt(T)}s: ${how} → dodged`); return true; }
    for (const x of acts) if (x.unseen && !x.unseen.pre && tp0 + x.unseen.s > (p.flightFrom==="press" ? 0 : (p.castTime||0)) + 1e-9) line(`  ${x.label}: unseen only after ${who} was cast; a point-and-click spell already cast still lands (set preBuff: true if ${label(def)} was already unseen)`);
    line(`  ${who} is point-and-click: once cast, walking can't dodge it`);
    return hit();
  }
  const need = selfArea ? Math.max(0, (p.radius||reachOf(p)) + HB - d) : edge + HB;
  if (slowSpec){ slowSpec.need=need; slowSpec.at=slowSpec.atAbs-reveal-react; }
  const needText = selfArea ? `${fmt(need)} units outward (${fmt(p.radius||reachOf(p))} radius + ${fmt(HB)} hitbox − ${fmt(d)} already between them)`
    : G ? `${fmt(need)} units out (${fmt(edge)} radius + ${fmt(HB)} hitbox)` : `${fmt(need)} units sideways (${fmt(edge)} ${p.kind==="line"?"half-width":p.kind==="cone"?"cone half-width here":"radius"} + ${fmt(HB)} hitbox)`;
  const walk = slowSpec ? walkWith(ds, [], 0, avail, slowSpec).dist : ds.ms*avail;
  line(`  must move ${needText}; walking at ${fmt(ds.ms)}${slowSpec&&slowSpec.pct?` (${fmt(msCap((ds.msuncapped||ds.ms)*(1-slowSpec.pct)))} once slowed inside)`:""} covers ${fmt(walk)} (needs ${fmt(need/avail)} move speed${slowSpec?" unslowed":""})`);
  if (walk>=need){ line("  → dodged by walking"); stormLine(def, a, s, p, d, HB, ds); return true; }
  for (const {x, w, ok, press} of voids){
    line(`  ${x.label}: ${w.kind} ${fmtW(w)} after its press${ok?`; pressed at ${fmt(press)}s it covers the landing at ${fmt(T)}s`:`: from ${fmt(tp0 + w.s)}s at the earliest, after it lands at ${fmt(T)}s`}`);
    if (ok){ line("  → dodged"); return true; } }
  if (acts.length){
    for (const x of acts) line(`  ${x.text}`);
    if (acts.some(x=>(x.buff||x.dash) && !x.noMove)){
      const best=bestMove(def, acts, ds, avail, slowSpec);
      line(`  best use: ${best.plan} → ${fmt(best.dist)} units in ${fmt(avail)}s${best.top>ds.ms+0.01?` (up to ${fmt(best.top)} move speed)`:""}; needs ${fmt(need)}`);
      if (TR && best.top>415) TR.notes.add(`move speed above 415 is soft-capped (×0.8 from 415, ×0.5 from 490)`);
      if (TR && acts.some(x=>x.buff && !x.buffPre && x.buff.cast>0)) TR.notes.add(`canDodge: ${label(def)} stands still while casting a speed boost; perfect play skips the boost when walking without it goes farther (set preBuff: true if it was cast before the ability appeared)`);
      if (TR && best.partial) TR.notes.add(`canDodge: a dash still under way when the ability lands counts the distance covered by then (dash distance × elapsed / dash time)`);
      if (best.dist>=need){ line(best.buffed ? "  → dodged by walking with the speed boost" : "  → dodged"); stormLine(def, a, s, p, d, HB, ds); return true; }
    }
  }
  return hit();
}
/* crowd control a displacement immunity stops (wiki Crowd control § Displacement immunity; the special-cased suppressions and
   knock-up stuns are DISP_SUPPRESS / DISP_STUN) */
const DISP_CC_TYPES = new Set(["airborne","knockup","knockback","pull","knockdown","sleep","stasis"]);
/* The farthest the defender can move in `avail` seconds with the `using:` tools (perfect play; using nothing = walking). Dashes run
   one after another; the last one may still be under way at `avail` and counts the distance covered by then (partial dash). */
function bestMove(def, acts, ds, avail, slowSpec){
  const walk = slowSpec ? walkWith(ds, [], 0, avail, slowSpec).dist : ds.ms*Math.max(0, avail);
  let best={dist:walk, plan:"walking only", top:ds.ms};
  if (!(avail>0)) return {dist:0, plan:"no time", top:ds.ms};
  const mv=acts.filter(x=>(x.buff||x.dash) && !x.noMove);
  for (let mask=1; mask<(1<<Math.min(mv.length,6)); mask++){
    const pick=mv.filter((_,i)=>mask&(1<<i)); let t=0, disp=0, bad=false, partial=false; const buffs=[];
    for (const x of pick) if (x.buff && !x.dash){ if (!x.buffPre) t+=x.buff.cast; buffs.push({spec:x.buff, start:x.buffPre?0:t}); }
    const dashes=pick.filter(x=>x.dash);
    dashes.forEach((x, i) => { if (bad) return;
      const room=avail-t, D=x.dash, cast=D.cast||0;
      if (D.time <= room+1e-9){ t+=D.time; disp+=D.dist; if (x.buff) buffs.push({spec:x.buff, start:t}); }
      else if (i===dashes.length-1 && !D.blink && room>cast && D.time>cast){ disp+=D.dist*(room-cast)/(D.time-cast); t=avail; partial=true; }
      else bad=true; });
    if (bad || t>avail+1e-9) continue;
    const w=walkWith(ds, buffs, t, avail, slowSpec && {...slowSpec, from:disp}); disp+=w.dist;
    if (disp>best.dist+1e-9) best={dist:disp, top:w.top, plan:pick.map(x=>x.short).join(" + ")+(partial?" (the dash still under way)":""), still:pick.some(x=>x.buff && !x.buffPre && x.buff.cast>0), buffed:buffs.length>0, partial};
  }
  return best;
}
/* Viktor R (wiki Viktor_R): the storm then follows the nearest champion hit at 300/s within 300 of Viktor down to 200/s at 900+ (linear;
   ×1.25 with Perfect Storm) and strikes once a second, 6 times. canDodge adds how many strikes land if the defender walks straight
   away from Viktor at its move speed (the storm starts on it; Viktor stands still), as information (the answer is about the initial hit). */
function stormLine(def, a, s, p, d, HB, ds){
  if (a.champ!=="Viktor" || s!=="R") return;
  const S=CALC.champs.Viktor.R, rank=Math.max(1, rankOf(a,"R")||1), boost=kitEvolved(a).includes("R") ? 1+(dvOf(S,"augmentboost",rank) ?? 0.25) : 1, r=p.radius||325;
  const sp = x => (x<=300 ? 300 : x>=900 ? 200 : 300-100*(x-300)/600)*boost;
  let me=d, st=d, n=0; const h=0.005, hits=[];
  for (let k=1; k<=Math.round(6/h); k++){ me+=ds.ms*h; const v=sp(st)*h; st += Math.min(v, me-st);
    if (k%Math.round(1/h)===0){ const ok = me-st <= r+HB+1e-6; if (ok) n++; hits.push(ok?"hit":"miss"); } }
  line(`  if hit, walking straight away from ${label(a)} at ${fmt(ds.ms)}: the storm (${fmt(200*boost)}–${fmt(300*boost)}/s) lands ${n} of 6 strikes (${hits.join(", ")})`);
  if (TR) TR.notes.add(`${label(a)}.R storm: follows the target at 300/s within 300 of Viktor, 200/s from 900 (linear; ×1.25 augmented; wiki Viktor_R), radius ${fmt(r)} + hitbox; the strike count assumes the defender walks straight away and Viktor stands still`);
}
/* One `using:` entry of canDodge: an ability of the defender or a summoner spell → what it does for dodging. */
/* Nimbus Cloak on a summoner used in canDodge: its decaying speed (nimbusPct) adds to the summoner's own effect, starting when it's cast */
function withNimbus(def, y, r){
  if (!(def.runes||[]).includes("nimbuscloak")) return r;
  const p=nimbusPct(y.key, def), f=r.buff && r.buff.mk;
  r.buff={unit:"frac", cast:0, mk:()=>{ const g=f ? f() : null; return (u,w)=>(g ? g(u,w) : 0) + (u<=2 ? p*(1-u/2) : 0); }};
  r.text+=`; Nimbus Cloak +${fmt(100*p)}% move speed decaying over 2s`;
  if (TR) TR.notes.add(`Nimbus Cloak: +${fmt(100*p)}% move speed after ${summName(y.key)} (cooldown ${fmt(summCd(y.key, def))}s bracket: ≤100 s 15%, ≤250 s 35%, above 45%; wiki), decaying linearly over 2s`);
  return r;
}
/* a sheet window bound: a number, or {min,max} (by rank / charge): the later start and the earlier end (conservative); no end = open */
function winBound(v, end){ if (v==null) return end ? Infinity : 0; if (typeof v==="number") return v; if (typeof v==="object" && v.min!=null) return end ? v.min : v.max; return end ? Infinity : 0; }
/* stasis items in using: (DECISIONS / P2): Zhonya's Hourglass and the Stopwatch line (Seeker's Armguard here): stasis from the press */
const STASIS_ITEMS = {zhonyashourglass:"Zhonya's Hourglass", seekersarmguard:"Stopwatch (Seeker's Armguard)"};
function dodgeAction(def, y, preBuff, ds, recast, att, dist){
  if (y && (y.t==="item" || typeof y==="string")){
    const key = typeof y==="string" ? (/^\s*stop\s*watch\s*$/i.test(y) ? "seekersarmguard" : /zhonya/i.test(y) ? "zhonyashourglass" : null) : y.key;
    if (!key || !STASIS_ITEMS[key]) throw new Error(`using: ${typeof y==="string"?`"${y}"`:(ITEMS[y.key]||{}).name||y.key} isn't a dodge tool; the items canDodge knows are Zhonya's Hourglass and the Stopwatch ("Stopwatch" or SeekersArmguard): stasis from the press`);
    const dv=((CALC.items[key]||{}).dv||{}).duration, dur=(dv && dv[1]) || 2.5, nm=STASIS_ITEMS[key];
    if (TR){ TR.notes.add(`${nm}: stasis for ${fmt(dur)} s from the press (game files Duration; wiki Stasis: untargetable and invulnerable)`);
      if (!(def.items||[]).includes(key)) TR.notes.add(`${label(def)} is assumed to have ${nm} ready (it isn't in its items)`); }
    return {label:nm, short:nm, void:[{kind:"stasis", s:0, e:dur, destroys:true}], ccImm:[], text:`${nm}: stasis 0–${fmt(dur)}s from the press`}; }
  if (y && y.t==="summoner") return withNimbus(def, y, (()=>{
    if (y.owner && y.owner.champ!==def.champ) throw new Error(`using: ${label(y.owner)}.${summName(y.key)} belongs to another champion; use the defender's (or plain ${summName(y.key)})`);
    if (def.summoners && def.summoners.length && !def.summoners.includes(y.key)) throw new Error(`using: ${label(def)} took ${def.summoners.map(summName).join(" and ")}, not ${summName(y.key)}`);
    const L=stats(def).level, n=summNums(y.key, L), nm=summName(y.key);
    if (TR && !(def.summoners && def.summoners.length)) TR.notes.add(`${label(def)} is assumed to have ${nm} ready (set ${label(def)}.summoners = {…} to restrict)`);
    if (y.key==="flash"){ if (TR) TR.notes.add(`Flash: ${fmt(n.distance)}-unit blink, no cast time (game files: effect amount 1; wiki Flash)`);
      return {label:nm, short:"Flash", dash:{dist:n.distance, time:0, blink:true}, text:`Flash blinks ${fmt(n.distance)} units instantly`}; }
    if (y.key==="ghost"){ if (TR) TR.notes.add(`Ghost: +${fmt(100*n.ms)}% move speed at level ${L} (24% → 48% over levels 1–18, game files; wiki "24 – 50.82%" to level 20) for ${fmt(n.duration)}s, no cast time and no ramp-up (wiki)`);
      const b=n.ms, dur=n.duration;
      return {label:nm, short:preBuff?"Ghost (pre-applied)":"Ghost", buffPre:preBuff, buff:{unit:"frac", cast:0, mk:()=>u=>u<=dur?b:0}, text:`Ghost: +${fmt(100*b)}% move speed for ${fmt(dur)}s (level ${L})`}; }
    if (y.key==="heal"){ if (TR) TR.notes.add(`Heal: +${fmt(100*n.ms)}% move speed for ${fmt(n.msDuration)}s (game files; wiki "30% bonus total movement speed for 1 second"), counted as an additive % bonus`);
      const b=n.ms, dur=n.msDuration;
      return {label:nm, short:preBuff?"Heal (pre-applied)":"Heal", buffPre:preBuff, buff:{unit:"frac", cast:0, mk:()=>u=>u<=dur?b:0}, text:`Heal: +${fmt(100*b)}% move speed for ${fmt(dur)}s`}; }
    return {label:nm, short:nm, text:`${nm} doesn't move ${label(def)} or make it untargetable`};
  })());
  if (!y || y.t!=="ability" || y.owner.champ!==def.champ) throw new Error("using: must be the defender's abilities, summoner spells or a stasis item, e.g. using: fizz.E, using: Flash, using: Zhonyas or using: {orianna.W, Flash}");
  const tags=WORLD.champ(def.champ).slots[y.slot].tags, py=physOf(def, y.slot), lb=`${label(def)}.${y.slot}`, x={label:lb, short:lb, text:"", void:[], ccImm:[]}, bits=[];
  // what it does for the defender, as windows in seconds from ITS press (phys.grants from the interaction sheets; the kb tags only
  // when an ability has no sheet data yet: then untargetable from the end of its cast, open-ended, as before)
  const Gr=py.grants;
  if (Gr){
    for (const k of ["untargetable","stasis","invulnerable","parry"]) if (Gr[k]) x.void.push({kind:k, s:winBound(Gr[k][0]), e:winBound(Gr[k][1], true), destroys: py.destroysInbound!==false});
    for (const k of ["invisible","camouflage"]) if (Gr[k] && !x.unseen) x.unseen={kind:k, s:winBound(Gr[k][0]), e:winBound(Gr[k][1], true), detect:py.camouflageDetect, pre:!!preBuff};
    if (Gr.ccImmune) x.ccImm.push({kind:"cc", s:winBound(Gr.ccImmune[0]), e:winBound(Gr.ccImmune[1], true)});
    if (Gr.displacementImmune) x.ccImm.push({kind:"displacement", s:winBound(Gr.displacementImmune[0]), e:winBound(Gr.displacementImmune[1], true)});
    for (const w of x.void) bits.push(`${w.kind} ${fmt(w.s)}–${Number.isFinite(w.e)?fmt(w.e):"…"}s after its press${w.kind==="untargetable"&&!w.destroys?" (doesn't destroy projectiles already in flight)":""}`);
    for (const w of x.ccImm) bits.push(`${w.kind==="cc"?"crowd control":"displacement"} immune ${fmt(w.s)}–${Number.isFinite(w.e)?fmt(w.e):"…"}s`);
  } else if (tags.untargetable!==undefined || tags.invuln!==undefined){ x.void.push({kind:"untargetable", s:py.castTime||0, e:Infinity, destroys:true, fromTags:true}); bits.push(`untargetable after its ${fmt(py.castTime||0)}s cast (kb tag; no sheet window yet)`); }
  // displacement / CC immunity from the UNSTOPPABLE table when the sheet data has none
  const U=UNSTOPPABLE[def.champ] && UNSTOPPABLE[def.champ][y.slot];
  if (U && !x.ccImm.length){ x.ccImm.push({kind:U.imm, s: typeof U.from==="number" ? U.from : U.from==="press" ? 0 : (py.castTime||0), e:Infinity}); bits.push(`${U.imm==="cc"?"crowd control":"displacement"} immune (${U.why})`); }
  // a dash or blink that needs a target (phys.requires): the attacker can be the enemy it needs if in range, but that move goes toward
  // it (not an escape); an ally, a wall or an airborne target isn't assumed, and then nothing of the ability is usable
  const R=recast ? null : py.requires;   // a recast dash (Akali R2) goes anywhere
  if (R){ x.noMove=true; const inR=(R==="enemy"||R==="unit") && att && dist!=null && dist <= (py.range||0)+1e-6;
    if (!inR){ x.void=[]; x.unseen=null; x.ccImm=[]; }
    bits.push(R==="enemy"||R==="unit" ? `needs ${R==="enemy"?"an enemy":"a unit"} to target: ${inR?`${label(att)} is within its ${fmt(py.range)} range, but the move goes toward it, so it isn't counted as an escape`:`${label(att)||"the attacker"} is beyond its ${fmt(py.range||0)} range and no other target is assumed, so it can't be used`}`
      : `needs ${R==="ally"?"an ally":R==="terrain"?"a wall":R==="airborne"?"an airborne enemy":"a "+R} to use (not assumed): not a free escape`); }
  // recast: the ability's second cast (phys.recastDash: Akali R2, 800 units at 3000/s with no cast time)
  if (recast){ if (!py.recastDash) throw new Error(`recast: ${lb} has no recast dash in the engine (only abilities with one, e.g. Akali R)`);
    const P=py.recastDash, time=(P.castTime||0)+P.dist/P.speed; x.short=x.label=`${lb} recast`; x.dash={dist:P.dist, time};
    bits.push(`dashes ${fmt(P.dist)} units in ${fmt(time)}s (${fmt(P.speed)}/s${P.castTime?"":", no cast time"}; ready ${fmt(P.lockout)}–${fmt(P.window)}s after the first cast)`);
    if (TR) TR.notes.add(`${lb} recast: ${fmt(P.dist)}-unit dash at ${fmt(P.speed)}/s in any direction, no cast time, usable ${fmt(P.lockout)}–${fmt(P.window)} s after the first cast (wiki; assumed ready)`);
    x.text=`${x.label} ${bits.join("; ")}`; return x; }
  // Shuriken Flip (phys.flipBack): the first cast flips her back `dist` units from `at` s into the cast, at the dash speed (any
  // direction: she aims the throw the other way); the gap-closing recast is a dash to the mark, not a dodge
  if (py.flipBack){ const F=py.flipBack, sp=py.dashSpeed||1500, time=F.at+F.dist/sp; x.dash={dist:F.dist, time, cast:F.at};
    bits.push(`flips back ${fmt(F.dist)} units from ${fmt(F.at)}s at ${fmt(sp)}/s (done at ${fmt(time)}s; she throws the shuriken the other way)`);
    if (TR) TR.notes.add(`${lb}: the first cast flips ${label(def)} back ${fmt(F.dist)} units starting ${fmt(F.at)} s into the cast at ${fmt(sp)}/s (wiki); the recast dashes to the marked target instead`); }
  else if (tags.dash!==undefined || tags.blink!==undefined){ const di=dashInfo(def, y.slot); x.dash={dist:di.dist, time:di.time, blink:di.blink, cast:di.castTime||0}; bits.push(`${di.blink?"blinks":"dashes"} ${fmt(di.dist)} units in ${fmt(di.time)}s`); }
  // invisibility (tag stealth; wiki Invisibility): point-and-click spells and attacks can't be cast on her once she's unseen
  if (x.unseen) bits.push(`${x.unseen.kind==="camouflage"?`camouflaged (enemies within ${x.unseen.detect!=null?fmt(x.unseen.detect):"its detection radius (unknown)"} see it)`:"invisible"} ${preBuff?"(already)":`${fmt(x.unseen.s)}–${Number.isFinite(x.unseen.e)?fmt(x.unseen.e):"…"}s after its press`}: can't be targeted by point-and-click spells or attacks it hides from (skillshots and areas still hit)`);
  else if (!Gr && tags.stealth!==undefined){ const at=(py.castTime||0)+(def.champ==="Akali" ? 0.25 : 0); x.unseen={kind:"invisible", s:at, e:Infinity, pre:!!preBuff};
    bits.push(`invisible ${preBuff?"(already, in the shroud)":`from ${fmt(at)}s`}: can't be targeted by point-and-click spells or attacks (skillshots and areas still hit)`);
    if (TR && def.champ==="Akali") TR.notes.add(`${lb}: invisible once in the shroud: the smoke bomb lands 250 units away 0.25 s after the 0.25 s cast (missile 1000/s; wiki target range 250), so from 0.5 s (an assumption); revealed while dashing and for 1–0.625 s after attacking or casting (wiki)`); }
  if (py.msBuff && KIT[def.champ] && KIT[def.champ].evolved && /augment/i.test(String(py.msBuff.key||"")) && !kitEvolved(def).includes(y.slot)){
    bits.push(`no move speed: the boost needs the ${y.slot} augment (set ${label(def)}.evolved)`); }
  else if (py.msBuff){ x.buff=buffSpec(def, y.slot, py); x.buffPre = preBuff || x.buff.passive;
    if (x.buffPre && !x.buff.passive) x.short=`${lb} (pre-applied)`;
    bits.push(`${x.buff.desc}${x.buff.passive?" (passive, already active)":x.buffPre?" (pre-applied: active when the window opens)":x.buff.cast>0?` after its ${fmt(x.buff.cast)}s cast`:""}`);
    if (TR) TR.notes.add(x.buff.note); }
  if (!bits.length) bits.push("has no dash, blink, untargetability or move-speed boost");
  x.text=`${lb} ${bits.join("; ")}`;
  return x;
}
/* League's move-speed soft caps (above 415 and 490, below 220). */
function msCap(v){ return v>490 ? v*0.5+230 : v>415 ? v*0.8+83 : v<220 ? v*0.5+110 : v; }
/* A move-speed ability (phys.msBuff: amount per rank from a data value, unit frac | pct | flat, optional
   duration / linear decay / ramp / field radius it holds in) → {unit, cast, mk: () => bonus(u, walked)}. */
function buffSpec(def, slot, py){
  const mb=py.msBuff, S=CALC.champs[def.champ][slot]||{}, rank=Math.max(1, rankOf(def, slot)||1);
  const val = (k, v) => v!=null ? v : k ? (dvOf(S, String(k).toLowerCase(), rank) ?? 0) : 0;
  const conv = x => mb.unit==="pct" ? x/100 : x;
  const b0 = conv(val(mb.key, mb.value)), b1 = mb.rampTo!=null || mb.rampToValue!=null ? conv(val(mb.rampTo, mb.rampToValue)) : null;
  const rampT = val(mb.rampOver, mb.rampOverValue) || 0, dur = mb.duration ? val(mb.duration) : 0;
  const mk = () => { let left=null; return (u, walked) => {                 // u = seconds since the buff started
    let b = b1!=null && rampT ? b0 + (b1-b0)*Math.min(1, u/rampT) : b0;
    if (mb.holdRadius){ if (walked < mb.holdRadius) return b; if (left==null) left=u; return mb.decay && dur ? b*Math.max(0, 1-(u-left)/dur) : 0; }
    if (dur && mb.decay) return b*Math.max(0, 1-u/dur);
    if (dur && u>dur) return 0;
    return b; }; };
  const amount = mb.unit==="flat" ? `+${fmt(b0)} move speed` : `+${fmt(100*b0)}% move speed${b1!=null?` ramping to ${fmt(100*b1)}% over ${fmt(rampT)}s`:""}`;
  const shape = mb.holdRadius ? ` while within its ${fmt(mb.holdRadius)} field, then decaying over ${fmt(dur)}s` : mb.decay && dur ? `, decaying over ${fmt(dur)}s` : dur ? ` for ${fmt(dur)}s` : "";
  return {unit: mb.unit==="flat" ? "flat" : "frac", cast: mb.passive || mb.fromCastStart ? 0 : Math.max(0, py.castTime||0), passive:!!mb.passive, mk, desc:`${amount}${shape}${mb.fromCastStart?" from the start of its cast (she moves while casting)":""}`,
    note:`${label(def)}.${slot}: move-speed boost from ${mb.source||"the game data"}${mb.condition?`; assumes ${mb.condition}`:""}`};
}
/* Distance walked from t0 to `avail` with boosts [{spec, start}] (flat bonuses add to base + item speed,
   % bonuses add to the item/rune %; then the soft caps). */
function walkWith(ds, buffs, t0, avail, slow){
  // slow {at, pct, need, from}: a field's slow from time `at` while the defender is still inside it (from + walked < need; Viktor W)
  const raw = ds.msraw || ds.basems || ds.ms, pct = ds.mspct ?? (ds.ms/raw - 1), fs=buffs.map(b=>({b, f:b.spec.mk()}));
  let dist=0, t=t0, top=ds.ms; const dt=0.005;
  while (t < avail-1e-9){ budgetTime(); const h=Math.min(dt, avail-t); let flat=0, frac=0;
    for (const {b,f} of fs){ if (t<b.start-1e-9) continue; const v=f(t-b.start, dist); if (b.spec.unit==="flat") flat+=v; else frac+=v; }
    const slowed = slow && slow.pct>0 && t>=slow.at-1e-9 && (slow.from||0)+dist < slow.need;
    const sp = slowed ? msCap((raw+flat)*(1+pct+frac)*(1-slow.pct)) : fs.length ? msCap((raw+flat)*(1+pct+frac)) : ds.ms; if (sp>top) top=sp; dist+=sp*h; t+=h; }
  return {dist, top};
}
function threatRange(c){
  const st=stats(c); let best=st.range, from="attack range";
  for (const s of ["Q","W","E","R"]){ const S=CALC.champs[c.champ][s]; if (!S || !(S.main)) continue; const p=physOf(c,s); const r=reachOf(p); if (r>best && r<5000){ best=r; from=`${s} reach (${p.delivery})`; } }
  line(`${label(c)}.threatRange = ${fmt(best)} (${from})`); return best;
}
function gapClose(c){
  let total=0; const parts=[];
  for (const s of ["Q","W","E","R"]){ const tags=WORLD.champ(c.champ).slots[s].tags; if (tags.dash===undefined && tags.blink===undefined) continue; if (!rankOf(c,s)) continue; const di=dashInfo(c,s); if (!(di.dist>0)) continue; total+=di.dist; parts.push(`${s} ${fmt(di.dist)}`); }
  line(`${label(c)}.gapClose = ${parts.join(" + ")||"0"} = ${fmt(total)} units of dashes and blinks`); return total;
}
function closeGap(c, d){
  let left=d, t=0; const st=stats(c), steps=[];
  for (const s of ["Q","W","E","R"]){ if (left<=0) break; const tags=WORLD.champ(c.champ).slots[s].tags; if (tags.dash===undefined && tags.blink===undefined) continue; if (!rankOf(c,s)) continue;
    const di=dashInfo(c,s); if (!(di.dist>0)) continue;   // no dash distance in the data (Yunara, Warwick, Kha'Zix): used to give NaN
    const used=Math.min(di.dist,left), move=Math.max(0, di.time-di.castTime); t+=(di.castTime||0) + (di.blink?0:used*move/di.dist); left-=used; steps.push(`${s} ${fmt(used)}`); }
  if (left>0){ t+=left/st.ms; steps.push(`walk ${fmt(left)} at ${fmt(st.ms)}`); }
  line(`${label(c)}.closeGap(${fmt(d)}) = ${steps.join(", ")} → ${fmt(t)}s`);
  if (TR) TR.notes.add("closeGap: dashes are used in Q, W, E, R order, all toward the target, nothing blocks them");
  return t;
}
function hasTag(c, tag, slot){
  const w=WORLD.champ(c.champ), hits=[];
  for (const s of (slot?[slot]:SLOTS)){ const ev=w.slots[s].tags[tag]; if(ev!==undefined) hits.push({s,ev}); }
  if (!hits.length){ line(`no ${slot?label(c)+" "+slot:label(c)+" ability"} text mentions ${tag}`); return false; }
  const h=hits[0], sl=w.slots[h.s];
  if (h.ev && h.ev.asserted){ line(`${label(c)} ${h.s} (${sl.name}): ${tag}, asserted on line ${h.ev.asserted.line}`); if(TR) TR.asm.add(`line ${h.ev.asserted.line}: ${h.ev.asserted.text}`); }
  else line(`${label(c)} ${h.s} · ${sl.name}: “${h.ev}”`);
  return true;
}
function byTag(c, tag, fld){
  const w=WORLD.champ(c.champ);
  const cands=SLOTS.filter(s=>w.slots[s].tags[tag]!==undefined);
  // no such ability is an error, not NaN (a NaN compared with < is silently false); rules check a.has(tag) first
  if (!cands.length) throw new Error(`${label(c)} has no ${tag} ability (check with ${label(c)}.has(${tag}) first)`);
  const vals=cands.map(s=>{ const sl=w.slots[s]; let arr=fld==="range"?sl.range:sl.cd; if(w.cdOver&&w.cdOver[s]&&fld!=="range") arr=[w.cdOver[s].v];
    if(!arr||!arr.length) return null; return {s, v: (fld==="cdmax" ? arr[arr.length-1] : arr[0]) + (fld==="range" ? (levelRangeBonus(c, s)||{}).v||0 : 0)}; }).filter(Boolean);
  if (!vals.length) throw new Error(`${label(c)}'s ${tag} is a passive (no ${fld==="range"?"range":"cooldown"})`);
  const best = fld==="range" ? vals.reduce((a,x)=>x.v>a.v?x:a) : vals.reduce((a,x)=>x.v<a.v?x:a);
  line(`${label(c)} ${best.s} (${w.slots[best.s].name}) ${fld==="cdmax"?"max-rank cooldown":fld==="cd"?"rank-1 cooldown":"range"} ${fmt(best.v)}`);
  return best.v;
}

/* ================= values ================= */
const mkChamp = (id, level) => ({t:"champ", champ:id, level, ranks:{}, items:[], runes:[], opts:{}});
/* Dummy(hp: 3000, armor: 80, mr: 60) or Dummy(hp: 3000, resists: 70): the practice-tool target dummy with its cheat settings */
function mkDummy(args, named){
  if (args.length) throw new Error("Dummy(…) takes named settings: Dummy(hp: 3000, armor: 80, mr: 60), or resists: to set armor and MR together");
  const ok=["hp","armor","mr","resists"]; for (const k of Object.keys(named)) if (!ok.includes(k)) throw new Error(`Dummy(…) takes hp:, armor:, mr: and resists:, not “${k}:”.${hint(k, ok)}`);
  for (const [k,v] of Object.entries(named)) if (typeof v!=="number" || !Number.isFinite(v)) throw new Error(`Dummy ${k}: must be a number`);
  if (named.resists!=null && (named.armor!=null || named.mr!=null)) throw new Error("Dummy(…): give resists: or armor:/mr:, not both");
  const hp=named.hp ?? 1000, armor=named.resists ?? named.armor ?? 0, mr=named.resists ?? named.mr ?? 0;
  if (!(hp>=1)) throw new Error("Dummy hp: must be at least 1");
  const warn=[];
  if (hp<1000 || Math.abs((hp-1000)/100-Math.round((hp-1000)/100))>1e-9) warn.push(`hp ${fmt(hp)} (the tool gives 1000 + 100 per “Add 100 Max HP”)`);
  if (armor!==mr) warn.push(`armor ${fmt(armor)} ≠ MR ${fmt(mr)} (“Add 10 Resistances” raises both together)`);
  if (armor<0 || mr<0 || [armor,mr].some(x=>Math.abs(x/10-Math.round(x/10))>1e-9)) warn.push(`resists ${fmt(armor)}/${fmt(mr)} (the tool changes them in steps of 10 from 0)`);
  return {t:"champ", champ:DUMMY_ID, level:1, ranks:{}, items:[], runes:[], opts:{passive:true}, dummy:{hp, armor, mr, warn}};
}
const dummyText = c => `Target Dummy (practice tool: ${fmt(c.dummy.hp)} health, ${fmt(c.dummy.armor)} armor, ${fmt(c.dummy.mr)} magic resist${c.dummy.warn.length?`; not settable in the practice tool: ${c.dummy.warn.join("; ")}`:""})`;
function copy(v){
  if (!v || typeof v!=="object") return v;
  if (v.t==="champ"){ budgetValues(1); return {...v, ranks:{...v.ranks}, items:[...v.items], runes:[...(v.runes||[])], opts:{...(v.opts||{})}}; }
  if (v.t==="set") return {t:"set", items:[...v.items]};
  if (v.t==="comp"){ budgetValues(v.champs.length); return {t:"comp", champs:v.champs.map(copy)}; }
  if (v.t==="list"){ budgetValues(v.items.length); return {t:"list", items:v.items.map(copy)}; }
  return v;
}
function typeName(v){
  if (typeof v==="number") return "number"; if (typeof v==="boolean") return "bool"; if (typeof v==="string") return "string";
  return {champ:"Champion", ability:"Ability", item:"Item", set:"ItemSet", comp:"TeamComp", list:"list", tag:"tag", cls:"class", slot:"ability slot", fn:"function", builtin:"function", pred:"claim", rune:"Rune", fight:"Fight", fights:"Fights", combo:"Combo", comboresult:"ComboResult", summoner:"Summoner"}[v&&v.t] || "value";
}
function show(v){
  if (typeof v==="number") return fmt(v);
  if (typeof v==="boolean") return v?"true":"false";
  if (typeof v==="string") return v;
  if (!v) return "nothing";
  switch(v.t){
    case "champ": if (v.dummy) return dummyText(v); return `${champName(v)} (level ${v.level}${v.items.length?", "+v.items.map(k=>ITEMS[k].name).join(", "):""}${(v.runes||[]).length?"; "+v.runes.map(runeName).join(", "):""})`;
    case "item": return ITEMS[v.key].name;
    case "summoner": return v.owner ? `${label(v.owner)}.${summName(v.key)}` : summName(v.key);
    case "set": return `{${v.items.map(k=>ITEMS[k].name).join(", ")}}`;
    case "comp": return `{${v.champs.map(c=>champName(c)).join(", ")}}`;
    case "list": return `[${v.items.length} items]`;
    case "ability": return `${label(v.owner)}.${v.slot}`;
    case "rune": return runeName(v.key);
    case "combo": return v.steps.join(" → ") || "empty combo";
    case "comboresult": {
      const n=v.combo.steps.length, done=v.steps.length;
      if (v.killed && v.dummy) return `${fmt(v.damage)} damage over ${fmt(v.time)}s (the dummy's ${fmt(v.hpMax)} health was used up at ${fmt(v.killTime)}s; a champion would die there, the dummy keeps counting)`;
      if (v.killed) return `${fmt(v.damage)} damage: ${v.target} dies at ${fmt(v.killTime)}s, during step ${done}/${n} (${v.combo.steps[done-1]})${done<n?`; steps ${done+1}–${n} never happen`:""}`;
      return `${fmt(v.damage)} damage over ${fmt(v.time)}s; ${v.target} left on ${fmt(v.hpLeft)}/${fmt(v.hpMax)}`;
    }
    case "fight": { const a=v.units.filter(u=>u.side===0&&u.alive).length, b=v.units.filter(u=>u.side===1&&u.alive).length; return `fight: side 1 has ${a} alive, side 2 has ${b} alive after ${fmt(v.end)}s`; }
    case "fights": return sweepLine(v);
    case "tag": case "cls": case "slot": return v.name;
    default: return typeName(v);
  }
}
const truthy = v => typeof v==="boolean" ? v : typeof v==="number" ? v!==0 : !!v;
/* Item ownership limits from items.bin (ItemGroup.mMaxGroupOwnable, exported as ITEMS[k].limits = [[group, max, name]]):
   "Limited to 1 Blight item" (Void Staff, Cryptbloom, Terminus, Blighting Jewel, Bloodletter's Curse), one pair of
   boots, one Hydra, no two copies of a legendary, … Throws with the items that clash. */
const GROUP_MEMBERS = {};
for (const k of ITEMKEYS) for (const [g] of ITEMS[k].limits||[]) (GROUP_MEMBERS[g] ||= []).push(k);
function checkItemLimits(items, where){
  const n={};
  for (const k of items) for (const [g,max,name] of (ITEMS[k]&&ITEMS[k].limits)||[]){ (n[g] ||= {max, name, ks:[]}).ks.push(k); }
  for (const [g,{max,name,ks}] of Object.entries(n)){
    if (ks.length<=max) continue;
    const names=ks.map(k=>ITEMS[k].name), uniq=[...new Set(names)];
    const why = uniq.length===1 ? `a build can hold only ${max===1?"one":max} ${uniq[0]}`
      : name ? `${uniq.join(" and ")} are ${uniq.length===2?"both":"all"} ${name} items, limited to ${max} per build`
      : `${uniq.join(" and ")} share an item limit (${max} of: ${GROUP_MEMBERS[g].map(k=>ITEMS[k].name).join(", ")})`;
    throw new Error(`${where}: ${why} (game item data).${uniq.length>1?` Did you mean just one of them: ${uniq.join(" or ")}?`:""}`);
  }
  return items;
}
function toItems(v, where){
  if (v && v.t==="item") return [v.key];
  if (v && v.t==="set") return v.items;
  if (v && v.t==="list") return v.items.flatMap(x=>toItems(x, where));
  throw new Error(`${where} takes items or item sets, not ${typeName(v)}`);
}
function comboOf(v, where){
  const steps=[];
  const add = x => { if (x && x.t==="slot") steps.push(x.name); else if (x && x.t==="combo"){ checkSize(steps.length+x.steps.length, "Combo", undefined, x.steps.length); for (const s of x.steps) steps.push(s); } else if (x && x.t==="list") x.items.forEach(add);
    else if (x && x.t==="summoner") steps.push(summName(x.key));
    else if (x && x.t==="item"){ if (!ITEM_ACTIVE_CD[x.key]) throw new Error(`${where}: ${ITEMS[x.key].name} has no active to press in a combo`); steps.push(ITEMS[x.key].name); }
    else throw new Error(`${where}: a combo holds abilities, AA and item actives, not ${typeName(x)}`); };
  add(v); return {t:"combo", steps, ...(v && v.t==="combo" && v.start ? {start:v.start} : {})};
}
// a library combo (KB.combos) as a Combo: guide steps → engine steps (item identifiers → item names, recast indices → "E recast")
function libCombo(champ, name){
  const lib=COMBO_LIB[champ]||[], who=(KB.champs[champ]||{}).name||champ;
  if (!lib.length) throw new Error(`the combo library has no combos for ${who} yet (champions with combos: ${Object.keys(COMBO_LIB).map(k=>KB.champs[k]?KB.champs[k].name:k).join(", ")})`);
  const e=lib.find(x=>norm(x.name)===norm(name));
  if (!e) throw new Error(`${who} has no library combo “${name}”. Library combos: ${lib.map(x=>`"${x.name}"`).join(", ")}`);
  const rc=new Set(e.recasts||[]);
  const steps=e.steps.map((s,i)=>{ if (rc.has(i)) return `${s} recast`; if (s==="AA" || SLOTS.includes(s) || SUMM_NAMES[s]) return s;
    const k=norm(s); if (ITEM_ACTIVE_CD[k]) return ITEMS[k] ? ITEMS[k].name : k;
    throw new Error(`combo library: ${who} “${e.name}” step ${i+1} “${s}” is not an ability, AA, summoner spell or item active`); });
  // e.start.stacks: the combo opens with the champion's own stacks (Yasuo/Yone Q3: 2 Gathering Storm; data/combos.json "start")
  return {t:"combo", steps, lib:e, ...(e.start ? {start:e.start} : {})};
}
function coerce(type, v, line){
  if (type==="Combo"){ try { return comboOf(v, "Combo"); } catch(e){ throw e instanceof LangError ? e : new LangError(e.message, line); } }
  if (type==="auto" && v && v.t==="list" && v.items.length && v.items.every(x=>x&&x.t==="slot")) return comboOf(v, "Combo");
  if (v && v.t==="list"){
    if (type==="ItemSet") return {t:"set", items:checkItemLimits(toItems(v,"ItemSet"), "ItemSet")};
    if (type==="TeamComp"){ for (const x of v.items) if(!x||x.t!=="champ") throw new LangError(`a TeamComp holds champions, not ${typeName(x)}`, line); return {t:"comp", champs:v.items.map(copy)}; }
    if (type==="auto"){ if (v.items.length && v.items.every(x=>x&&x.t==="item")) return {t:"set", items:v.items.map(x=>x.key)};
      if (v.items.length && v.items.every(x=>x&&x.t==="champ")) return {t:"comp", champs:v.items.map(copy)}; }
  }
  if (type==="int" && typeof v==="number") return Math.trunc(v);
  if ((type==="double"||type==="float"||type==="int") && typeof v!=="number") throw new LangError(`expected a number but got ${typeName(v)}`, line);
  if (type==="bool" && typeof v!=="boolean") return truthy(v);
  if (type==="Dummy" && !(v&&v.t==="champ"&&v.dummy)) throw new LangError(`expected a Dummy (the practice-tool target dummy, e.g. Dummy(hp: 3000)) but got ${v&&v.t==="champ"?champName(v):typeName(v)}`, line);
  if (type==="Champion" && !(v&&v.t==="champ")) throw new LangError(`expected a Champion but got ${typeName(v)}`, line);
  if (type==="string" && typeof v!=="string") return show(v);
  if (type==="Item" && !(v&&v.t==="item")) throw new LangError(`expected an Item but got ${typeName(v)}`, line);
  return copy(v);
}
function defaultOf(type){ return {int:0,double:0,float:0,bool:false,string:"",ItemSet:{t:"set",items:[]},TeamComp:{t:"comp",champs:[]},List:{t:"list",items:[]}}[type] ?? null; }

/* ================= interpreter ================= */
class Env { constructor(parent){ this.parent=parent; this.vars=new Map(); }
  get(n){ let e=this; while(e){ if(e.vars.has(n)) return e.vars.get(n); e=e.parent; } return undefined; }
  has(n){ let e=this; while(e){ if(e.vars.has(n)) return true; e=e.parent; } return false; }
  set(n,v){ let e=this; while(e){ if(e.vars.has(n)){ e.vars.set(n,v); return; } e=e.parent; } throw new Error(`“${n}” is not declared`); }
  def(n,v){ this.vars.set(n,v); } }
class Ret { constructor(v){ this.v=v; } }
const BREAK={}, CONTINUE={};

function Interpreter(ast, emitRaw){
  let quiet = false;
  const emit = it => { if (it.kind==="error" && quiet) it.msg = `in imported file: ${it.msg}`;
    if (it.kind!=="error" && !quiet && ++BUDGET.results > LIMITS.maxResults) throw new BudgetError(`program stopped after ${big(LIMITS.maxResults)} results (print, assert, prove) — printing in an endless loop?`, it.line);
    if (!quiet || it.kind==="error") emitRaw(it); };
  const globals=new Env(null), funcs={}, rules=[];
  globals.def("defaultLevel", 11);
  globals.def("gameMinute", 20); GAME.minute = 20;
  for (const d of ast){ if (d.k==="func") funcs[d.name]=d; if (d.k==="rule") rules.push(d); }
  const preds=new Set(rules.map(r=>r.pred));
  const tick=budgetStep;

  function lookup(name, env, line){
    if (env.has(name)) return env.get(name);
    if (own(funcs, name)) return {t:"fn", decl:funcs[name]};
    if (preds.has(name)) return {t:"pred", name};
    if (own(BUILTINS, name)) return {t:"builtin", name, fn:BUILTINS[name]};
    if (/^[PQWER]$/.test(name) || name==="AA") return {t:"slot", name};
    if (CLASSES.includes(name)) return {t:"cls", name};
    if (TAGS.has(name)) return {t:"tag", name};
    if (own(SUMM_NAMES, name)) return {t:"summoner", key:SUMM_NAMES[name]};
    const id=IDX[norm(name)];
    if (id && /^[A-Z]/.test(name)) return mkChamp(id, globals.get("defaultLevel"));
    if (/^[A-Z]/.test(name)){
      const rk=findRune(name,false); if (rk) return {t:"rune", key:rk};
      let key=null; try{ key=findItem(name); }catch(e){ throw new LangError(e.message, line); } if (key) return {t:"item", key};
      let r2=null; try{ r2=findRune(name,true); }catch(e){ throw new LangError(e.message, line); } if (r2) return {t:"rune", key:r2};
    }
    const known = [...env.vars.keys(), ...(env.parent ? [...env.parent.vars.keys()] : []), ...Object.keys(funcs), ...Object.keys(BUILTINS), "Dummy", ...Object.keys(SUMM_NAMES), ...CLASSES, ...TAGS, ...Object.values(KB.champs).map(c=>c.name.replace(/[^A-Za-z0-9]/g,""))];
    throw new LangError(`“${name}” is not declared, and it isn't a champion, item, rune, class or tag.${hint(name, known)}`, line);
  }

  /* ---- member access ---- */
  function member(obj, name, called, ln){
    if (obj==null) throw new LangError(`can't read “.${name}” of nothing`, ln);
    if (name in Object.prototype) throw new LangError(`${typeName(obj)} has no “.${name}”`, ln);   // constructor, toString, __proto__: not Rift Logic members
    const M = (fn) => ({t:"method", fn, name});
    if (typeof obj==="string"){ if(name==="size"||name==="length") return M(()=>obj.length); }
    switch (obj.t){
      case "summoner": {
        const k=obj.key, nm=summName(k), L=obj.owner ? stats(obj.owner).level : globals.get("defaultLevel"), n=summNums(k, L);
        if (name==="name") return nm;
        if (name==="cooldown"||name==="cd"){ const sh=obj.owner?summonerHaste(obj.owner):0, v=summCd(k, obj.owner);
          line(`${show(obj)}.cooldown = ${fmt(SUMM[k].cd)}s${sh?` × 100/(100 + ${fmt(sh)} summoner haste)`:""} = ${fmt(v)}s`); return v; }
        if (name==="summonerHaste"){ const v=obj.owner?summonerHaste(obj.owner):0; line(`${show(obj)}.summonerHaste = ${fmt(v)}`); return v; }
        const f={speed:"ms", moveSpeed:"ms"}[name] || name;
        if (Object.prototype.hasOwnProperty.call(n, f) && n[f]!=null){ const v=n[f], lv=["heal","shield","damage"].includes(f) || (k==="ghost" && f==="ms");
          line(`${show(obj)}.${name} = ${fmt(v)}${lv?` (level ${L}${obj.owner?"":", defaultLevel"})`:""}`); return v; }
        throw new LangError(`${nm} has ${["name","cooldown",...Object.keys(n)].join(", ")}${hint(name,["name","cooldown",...Object.keys(n)])}`, ln);
      }
      case "champ": {
        const c=obj;
        if (c.dummy && /^[PQWER]$/.test(name)) throw new LangError(`the Target Dummy has no abilities`, ln);
        if (/^[PQWER]$/.test(name)) return {t:"ability", owner:c, slot:name};
        if (name==="name") return champName(c);
        if (name==="level") return c.level;
        if (name==="items") return {t:"set", items:c.items, live:true};
        if (name==="classes") return {t:"list", items:WORLD.champ(c.champ).classes.slice()};
        if (name==="runes") return {t:"runes", owner:c};
        if (name==="threatRange") return threatRange(c);
        if (name==="gapClose") return gapClose(c);
        if (name==="hitbox"){ if (c.dummy){ const v=dummyRadius(c); line(`Target Dummy gameplay radius = 65 × (1 + min(1, bonus health ${fmt(c.dummy.hp-1000)} / 9000)) = ${fmt(v)}`); if (TR) TR.notes.add("Target Dummy radius: the wiki gives 65 at base and 130 at 10,000 health; linear growth in between is an assumption"); return v; } const v=hitboxOf(c), n=(CALC.champs[c.champ].base||{}).radiusNote; line(`${label(c)} gameplay radius = ${fmt(v)} (${n||"character record overrideGameplayCollisionRadius, default 65"})`); if (TR && SIZE_NOTES[c.champ]) TR.notes.add(`${label(c)}: size modifiers scale the hitbox (wiki "Size"): ${SIZE_NOTES[c.champ]}`); return v; }
        if (own(SUMM_NAMES, name)) return {t:"summoner", key:SUMM_NAMES[name], owner:c};
        if (name==="summoners") return {t:"list", items:(c.summoners||[]).map(k=>({t:"summoner", key:k, owner:c}))};
        if (name==="combos"){ const lib=COMBO_LIB[c.champ]||[]; for (const e of lib) line(`${champName(c)} “${e.name}”: ${e.steps.join(" → ")}${e.use?` (${e.use})`:""}`);
          if (!lib.length) line(`${champName(c)}: no library combos yet`); return {t:"list", items:lib.map(e=>e.name)}; }
        if (name==="summonerHaste"){ const v=summonerHaste(c); line(`${label(c)}.summonerHaste = ${fmt(v)} (items' SummonerHaste data value; Cosmic Insight 18)`); return v; }
        if (c.dummy && ["with","stacks","perform","combo","proc","closeGap","addClass","removeClass","is","has","cdOf","cdmaxOf","rangeOf","threatRange","gapClose"].includes(name))
          throw new LangError(`the Target Dummy can't use .${name}: it has no items, runes or abilities and never attacks or moves. Use it as the target: x.Q.damage(vs: d), x.proc(Item, vs: d), x.perform(combo, vs: d)`, ln);
        if (c.dummy && name==="resists"){ line(`Target Dummy armor ${fmt(c.dummy.armor)}, MR ${fmt(c.dummy.mr)}`); if (c.dummy.armor!==c.dummy.mr) throw new LangError(`this dummy's armor (${fmt(c.dummy.armor)}) and MR (${fmt(c.dummy.mr)}) differ; read .armor and .mr`, ln); return c.dummy.armor; }
        if (["target","healPolicy","passive","rotation","souls","skillOrder","role","stasis","exhaustAt"].includes(name)){ const o=c.opts||{}; const d={target:null, healPolicy:"lowest", passive:false, rotation:"RQEW", souls:0, skillOrder:"QEW", role:stats(c).ranged?"kite":"dive", stasis:"low", exhaustAt:"default"}; return o[name] ?? d[name]; }
        if (name==="oathsworn"){ if (c.champ!=="Kalista") throw new LangError(`only Kalista has an Oathsworn`, ln); const o=(c.opts||{}).oathsworn||null;
          line(`${label(c)}.oathsworn = ${o ? label(o) : "not set (fight() default: the Support-class ally, else the ally with the least AD + AP)"}`); return o; }
        if (name==="evolved"){ const k=KIT[c.champ]; if (!k || !k.evolved) throw new LangError(`${champName(c)} has no evolved or augmented abilities`, ln);
          const v=kitEvolved(c); line(`${label(c)}.evolved = ${v?v.split("").join(", "):"none"} (${k.evolved.name}${kitOptsOf(c)["@evolved"]!=null?"":`; default: ${k.evolved.why}`})`); return v; }
        const methods = {
          with: (args)=>{ const n=copy(c); for (const a of args.flatMap(x=>x&&x.t==="list"?x.items:[x])){ if (a&&a.t==="rune") n.runes.push(a.key); else if (a&&a.t==="summoner") n.summoners=setSummoners(c, [...(n.summoners||[]), a.key]); else n.items.push(...toItems(a,"with()")); } checkItemLimits(n.items, "with()"); return n; },
          at: (args)=>{ const L=args[0]; if(!(L>=1&&L<=18)) throw new Error("level must be 1–18"); const n=copy(c); n.level=Math.round(L); return n; },
          is: (args)=>{ const cl=args[0]; if(!cl||cl.t!=="cls") throw new Error(`is() takes a class: ${CLASSES.join(", ")}`); const w=WORLD.champ(c.champ); const ok=w.classes.includes(cl.name);
                        line(`${label(c)} is ${w.classes.join(" / ")}`); if (w.clsOver&&w.clsOver[cl.name]&&TR) TR.asm.add(`line ${w.clsOver[cl.name].line}: ${w.clsOver[cl.name].text}`); return ok; },
          has: (args)=>{ const tg=args[0]; if(!tg||tg.t!=="tag") throw new Error(`has() takes a tag, e.g. has(stun)`); return hasTag(c, tg.name); },
          cdOf: (args)=>byTag(c, tagArg(args[0]), "cd"), cdmaxOf: (args)=>byTag(c, tagArg(args[0]), "cdmax"), rangeOf: (args)=>byTag(c, tagArg(args[0]), "range"),
          perform: (args, named)=>perform(c, args[0], named),
          combo: (args, named)=>{ if (typeof args[0]==="string"){ const cb=libCombo(c.champ, args[0]), e=cb.lib;
                     line(`${label(c)}.combo("${e.name}") = ${cb.steps.join(" → ")}${e.use?` (${e.use})`:""}`);
                     if (TR){ TR.notes.add(`combo library, ${champName(c)} “${e.name}”: ${(e.src||[]).join(", ")}${e.notes?` (${e.notes})`:""}`); }
                     return cb; }
                   if (args[0] && (args[0].t==="combo" || (args[0].t==="list" && args.length===1))) return perform(c, args[0], named).damage;
                   checkNamed(named, ["vs"], "combo(Q, W, …)"); const vs=vsArg(named); let total=0; const vals=[]; const sl=args.map(a=>{ if(!a||a.t!=="slot") throw new Error("combo() takes abilities: Q, W, E, R, P"); return a.name; });
                   for (const s of sl){ let v; try { v=abilityValue(c, s, "damage", vs); } catch(err){ if(!/no damage formula|no data/.test(err.message)) throw err; v=0; if(TR) TR.notes.add(`${label(c)} ${s}: no damage formula, counted as 0 in combo()`); } total+=v; vals.push(fmt(v)); }
                   line(`${label(c)}.combo(${sl.join(",")})${vs?" vs "+label(vs):""} = ${vals.join(" + ")} = ${fmt(total)}`); return total; },
          proc: (args, named)=>{ checkNamed(named, ["vs"], "proc(…)"); const it=args[0]; if(!it||it.t!=="item") throw new Error("proc() takes an item, e.g. proc(Ludens)"); const I=ITEMS[it.key];
                   const Q=ITEM_PROC_PCT[it.key];
                   if (Q){ const st=stats(c), q=Q(st), vs=vsArg(named), hp=vs?stats(vs).hp:0;
                     if (TR) TR.notes.add(`${I.name} proc: ${q.what}${vs&&q.pct&&q.of!=="max"?`; ${label(vs)} taken at full health (current = max)`:""}`);
                     const raw=q.flat+q.pct*hp;
                     line(`${label(c)}.proc(${I.name}) = ${[q.flat?fmt(q.flat):"", q.pct?`${fmt(q.pct*100)}% × ${vs?`${label(vs)} ${q.of} health ${fmt(hp)}`:`target's ${q.of} health`}`:""].filter(Boolean).join(" + ")||"0"} = ${fmt(raw)} ${q.type}`);
                     if (!vs){ if (q.pct && TR) TR.notes.add(`${I.name} proc: a share of the target's health; add vs: to get damage`); return raw; }
                     const m=mitigate(raw,q.type,st,stats(vs)); line(`  vs ${label(vs)}: ${m.s} = ${fmt(m.v)}`); return m.v; }
                   if (!I.calcs) throw new Error(`${I.name} has no damage formula in the game data`);
                   const P=ITEM_PROC[it.key], ck=P ? P[0] : I.calcs.damage?"damage":Object.keys(I.calcs)[0], type=P ? P[1] : "magic", st=stats(c), ctx={S:{calcs:I.calcs, dv:I.dv||{}}, rank:1, st, flags:new Set()};
                   const r=evalCalc(ctx, ck); if (TR){ for (const fl of ctx.flags) TR.notes.add(`${I.name}: ${fl}`); TR.notes.add(P ? `${I.name} proc: ${P[2]} (${I.calcs[ck][0]})` : `${I.name} proc: its first formula (${I.calcs[ck][0]}), treated as magic damage`); }
                   line(`${label(c)}.proc(${I.name}) = ${r.s} = ${fmt(r.v)} ${type}`); const vs=vsArg(named); if(!vs || type==="heal") return r.v;
                   const m=mitigate(r.v,type,st,stats(vs)); line(`  vs ${label(vs)}: ${m.s} = ${fmt(m.v)}`); return m.v; },
          stacks: (args)=>{ const it=args[0];
                   if (!args.length){ const k=KIT[c.champ]; if (!k || !k.stacks) throw new Error(`${champName(c)} has no stacks of its own; item stacks are set with .stacks(Item, n)`);
                     const v=kitStacks(c); line(`${label(c)}.stacks = ${fmt(v)} ${k.stacks.name}${kitOptsOf(c)["@stacks"]!=null?"":` (default: ${k.stacks.why})`}`); return v; }
                   if (it && it.t==="rune"){ if (typeof args[1]!=="number") throw new Error("stacks(Rune, n), e.g. .stacks(LegendAlacrity, 10)");
                     if (!RUNE_STACKS[it.key]) throw new Error(`${runeName(it.key)} has no stacks from outside the fight. Runes that do: ${Object.keys(RUNE_STACKS).map(runeName).join(", ")}`);
                     const n=copy(c); n.opts={...n.opts, stacks:{...((n.opts||{}).stacks||{}), [it.key]:args[1]}}; if (it.key==="darkharvest") n.opts.souls=args[1]; return n; }
                   if(!it||it.t!=="item"||typeof args[1]!=="number") throw new Error("stacks(Item, n), e.g. .stacks(Heartsteel, 400), or stacks(Rune, n), e.g. .stacks(LegendAlacrity, 10)");
                   if (!ITEM_STACKS[it.key]) throw new Error(`${ITEMS[it.key].name} has no stacks from outside the fight. Items that do: ${Object.keys(ITEM_STACKS).map(k=>ITEMS[k].name).join(", ")}`);
                   const n=copy(c); n.opts={...n.opts, stacks:{...((n.opts||{}).stacks||{}), [it.key]:args[1]}}; return n; },
          closeGap: (args)=>{ if (typeof args[0]!=="number") throw new Error("closeGap(distance)"); return closeGap(c, args[0]); },
          addClass: (args)=>{ WORLD.addClass(c.champ, args[0].name, true, ln, `${champName(c)}.addClass(${args[0].name})`); return null; },
          removeClass: (args)=>{ WORLD.addClass(c.champ, args[0].name, false, ln, `${champName(c)}.removeClass(${args[0].name})`); return null; },
        };
        if (methods[name]) return M(methods[name]);
        if (STATKEYS.includes(name)){ const v=stats(c)[name]; line(`${label(c)}.${name} = ${fmt(v)}`); return v; }
        // basic-attack windup and missile speed (backlog 25 step 7; fight() and perform() use them)
        if (name==="windup"){ const st=stats(c), A=attackTiming(c.champ, st, st.ranged);
          line(`${label(c)}.windup = ${fmt(A.base)} + ${fmt(A.wm)} × (${fmt(A.wu)} / ${fmt(st.as)} − ${fmt(A.base)}) = ${fmt(A.windup)}s (windup ${fmt(A.wu*100)}% of the attack time; base windup ${fmt(A.wu)} / ${fmt(st.baseas)} base attack speed${A.wm!==1?`; windup modifier ${fmt(A.wm)}`:""})`); return A.windup; }
        if (name==="missileSpeed"){ const st=stats(c), A=attackTiming(c.champ, st, st.ranged); line(`${label(c)}.missileSpeed = ${fmt(A.msl)}${A.msl?"/s":" (melee or instant: the attack lands when its windup ends)"}`); return A.msl; }
        const w=WORLD.champ(c.champ);
        if (name==="melee"){ const v=w.stats.melee===1; line(`${label(c)} attack range ${w.stats.range} → melee ${v}`); return v; }
        if (name in w.stats){ line(`${label(c)}.${name} = ${w.stats[name]}`); return w.stats[name]; }
        throw new LangError(`a Champion has no “${name}”.${hint(name, [...STATKEYS, ...Object.keys(methods), "Q","W","E","R","P","name","level","items","runes","classes","stacks","combos","melee","threatRange","gapClose","hitbox","target","healPolicy","passive","rotation","souls","skillOrder","stasis","exhaustAt","attack","defense","magic","difficulty"])} See “What a Champion can tell you” in the cheatsheet.`, ln);
      }
      case "ability": {
        const c=obj.owner, s=obj.slot, S=CALC.champs[c.champ][s];
        if (name==="name") return WORLD.champ(c.champ).slots[s].name || s;
        if (name==="rank") return rankOf(c, s);
        if (["speed","width","radius","castTime","delay","kind","reach","delivery","length","origin"].includes(name)){ const p=physOf(c,s);
          const v = name==="width" ? 2*(p.halfWidth||0) : name==="reach" ? reachOf(p) : name==="origin" ? (p.delivery==="remote" ? p.originDist : 0) : p[name] ?? 0;
          if (name==="delay") delayNote(c, s, p);
          line(`${label(c)}.${s}.${name} = ${fmt(v)}`); return v; }
        if (name==="ccTypes" || name==="knockback" || name==="slowAmount"){ const r=Math.max(1, rankOf(c,s)||1), cl=ccList(c, s, r);
          for (const e of cl.list) line(`${label(c)}.${s} (rank ${r}): ${ccDescribe(e)} — ${ccSrc(e)}`); for (const k of cl.skipped) line(`${label(c)}.${s}: ${k}: not used by fight()`);
          if (name==="ccTypes") return cl.list.map(e=>e.type).join(", ");
          if (name==="knockback"){ const e=cl.list.find(e=>e.type==="knockback"||e.type==="pull"); if (e && e.mode==="to" && TR) TR.notes.add(`${label(c)}.${s}: knocks back TO ${fmt(e.dist)} units from the caster (the push is ${fmt(e.dist)} − the distance)`); return e && e.dist ? e.dist : 0; }
          const e=cl.list.find(e=>e.type==="slow"); return e ? e.pct : 0; }
        if (name==="healTarget" || name==="shieldTarget"){ const k=S&&S[name]; return k ? {self:"self", ally:"another ally", ally_or_self:"an ally or self", self_and_ally:"self and an ally", team:"every ally"}[k] : "none"; }
        const methods = {
          damage: (args,named)=>abilityValue(c, s, "damage", vsArg(named), damageOpts(c, s, named)),
          heal: (args,named)=>{ checkNamed(named, ["target"], `${s}.heal(…)`); return supportValue(c, s, "heal", named.target); },
          shield: (args,named)=>{ checkNamed(named, ["target"], `${s}.shield(…)`); return supportValue(c, s, "shield", named.target); },
          cd: ()=>abilityValue(c, s, "cd"), cdbase: ()=>abilityValue(c, s, "cdbase"),
          cost: ()=>abilityValue(c, s, "cost"), range: ()=>abilityValue(c, s, "range"),
          minRange: ()=>abilityValue(c, s, "minrange"), chargeTime: ()=>abilityValue(c, s, "chargetime"),
          value: (args,named)=>{ checkNamed(named, ["vs"], `${s}.value(…)`); const v=abilityValue(c, s, String(args[0]), vsArg(named)); if (v===undefined) throw new Error(`${label(c)}.${s} has no value “${args[0]}”. It has: ${fieldsOf(S).join(", ")}`); return v; },
          has: (args)=>hasTag(c, tagArg(args[0]), s),
          addTag: (args)=>{ WORLD.addTag(c.champ, s, tagArg(args[0], true), ln, `${champName(c)}.${s}.addTag(${tagName(args[0])})`); return null; },
          removeTag: (args)=>{ WORLD.removeTag(c.champ, s, tagArg(args[0], true), ln, `${champName(c)}.${s}.removeTag(${tagName(args[0])})`); return null; },
          setPhysics: (args,named)=>{ const ok=["speed","width","radius","castTime","delay","dashSpeed","dashRange","kind","delivery","origin","originRange","length","reveal","reach"]; for (const k of Object.keys(named)) if (!ok.includes(k)) throw new Error(`setPhysics takes ${ok.join(", ")}`);
            if (named.delivery!=null && !Object.keys(DELIVERIES).includes(String(named.delivery))) throw new Error(`delivery is one of ${Object.keys(DELIVERIES).map(x=>`"${x}"`).join(", ")}`);
            if (named.origin!=null && typeof named.origin!=="number") throw new Error("origin: is a distance in units, from the object the ability comes from (e.g. Orianna's ball) to the target");
            WORLD.setPhys(c.champ, s, named, ln, `${champName(c)}.${s}.setPhysics(${Object.entries(named).map(([k,v])=>`${k}: ${show(v)}`).join(", ")})`); return null; },
          ccDuration: (args,named)=>{ checkNamed(named, ["vs"], `${s}.ccDuration(…)`); const ty=String(args[0]||"").toLowerCase(), r=Math.max(1, rankOf(c,s)||1), cl=ccList(c, s, r);
            // "airborne" = any knock-up, knockback or pull (wiki Airborne): the longest one, as fight() applies it
            const e = ty==="airborne" ? cl.list.filter(e=>AIRBORNE.has(e.type)).sort((x,y)=>y.dur-x.dur)[0] : cl.list.find(e=>e.type===ty);
            { const S=CALC.champs[c.champ][s]||{}, ck=dvOf(S,"chargeknockup",r), md=dvOf(S,"maxduration",r);   // Janna Q: longer when charged
              if (e && AIRBORNE.has(e.type) && ck && md) line(`${label(c)}.${s}: uncharged ${fmt(e.dur)}s (what fight() uses); +${fmt(ck)}s per second charged, up to ${fmt(e.dur+ck*md)}s after ${fmt(md)}s (game data ChargeKnockup, MaxDuration; wiki 0.5–1.25 s)`); }
            if (!e){ line(`${label(c)}.${s} (rank ${r}) has no ${ty}${cl.list.length?` (it has ${cl.list.map(e=>e.type).join(", ")})`:""}`); return 0; }
            line(`${label(c)}.${s} (rank ${r}): ${ccDescribe(e)} — ${ccSrc(e)}`);
            const vs=vsArg(named); if (!vs) return e.dur;
            const ten=stats(vs).tenacity||0, d=ccDuration(e, ten);
            line(NO_TENACITY.has(e.type) ? `  vs ${label(vs)}: ${e.type} ignores tenacity → ${fmt(d)}s` : `  vs ${label(vs)}: ${fmt(e.dur)} × (1 − ${fmt(100*ten)}% tenacity) = ${fmt(d)}s${d>e.dur*(1-ten)+1e-9?" (floor 0.3s)":""}`);
            return d; },
          reachTo: (args)=>{ const x=args[0]; if (!x || x.t!=="champ") throw new Error(`${s}.reachTo(target) takes a Champion or Dummy, e.g. annie.Q.reachTo(syndra)`);
            const p=physOf(c,s), rc=hitboxOf(c), rt=hitboxOf(x), v=hitReach(p, rc, rt, stats(c).range);
            line(`${label(c)}.${s}.reachTo(${label(x)}) = ${fmt(v)} units centre to centre: ${reachWhy(p, rc, rt, stats(c).range)}`);
            return v; },
          arrival: (args,named)=>{ checkNamed(named, ["distance"], `${s}.arrival(…)`); if (typeof named.distance!=="number" || !(named.distance>=0)) throw new Error("arrival(distance: …) takes a distance in units (0 or more)"); return arrivalTime(c, s, named.distance); },
          setDamageType: (args)=>{ const t=String(args[0]||"").toLowerCase(); if (!["magic","physical","true"].includes(t)) throw new Error(`setDamageType takes "magic", "physical" or "true"`);
            WORLD.setType(c.champ, s, t, ln, `${champName(c)}.${s}.setDamageType("${t}")`); return null; },
          setCooldown: (args)=>{ WORLD.setCd(c.champ, s, args[0], ln, `${champName(c)}.${s}.setCooldown(${args[0]})`); return null; },
        };
        if (methods[name]) return M(methods[name]);
        if (S){ const v=abilityValue(c, s, name, null); if (v!==undefined) return v; }
        { const opts=["damage","cd","cdbase","cost","range","minRange","chargeTime","rank","name","heal","shield","healTarget","shieldTarget","value","speed","width","radius","castTime","delay","kind","reach","delivery","length","origin","arrival","reachTo","has","addTag","removeTag","setCooldown","setPhysics","setDamageType", ...(S?fieldsOf(S):[])];
          throw new LangError(`${label(c)}.${s} has no “${name}”.${hint(name, opts)} It has: damage, cd, cdbase, cost, range, rank${S?", "+fieldsOf(S).join(", "):""}`, ln); }
      }
      case "item": {
        const I=ITEMS[obj.key], n=name.toLowerCase();
        if (n==="name") return I.name;
        if (n==="gold"){ line(`${I.name}.gold = ${I.gold}`); return I.gold; }
        if (n in I.stats){ line(`${I.name}.${n} = ${fmt(I.stats[n])}`); return I.stats[n]; }
        if (I.dv && I.dv[n]){ line(`${I.name}.${I.dv[n][0]} = ${fmt(I.dv[n][1])}`); return I.dv[n][1]; }
        if (STATKEYS.includes(n)) return 0;
        throw new LangError(`${I.name} has no “${name}”. It has: name, gold, ${Object.keys(I.stats).join(", ")}${I.dv?", "+Object.values(I.dv).map(x=>x[0]).join(", "):""}`, ln);
      }
      case "set": {
        const methods = {
          add: (args)=>{ const next=[...obj.items]; for (const a of args) next.push(...toItems(a,"add()")); checkItemLimits(next, "items.add()"); obj.items.push(...next.slice(obj.items.length)); statMemo.clear(); return null; },
          remove: (args)=>{ for (const a of args) for (const k of toItems(a,"remove()")){ const i=obj.items.indexOf(k); if(i>=0) obj.items.splice(i,1); } return null; },
          contains: (args)=>toItems(args[0],"contains()").every(k=>obj.items.includes(k)),
          size: ()=>obj.items.length,
        };
        if (methods[name]) return M(methods[name]);
        if (name==="gold"){ const v=obj.items.reduce((s,k)=>s+ITEMS[k].gold,0); line(`items.gold = ${obj.items.map(k=>ITEMS[k].gold).join(" + ")||0} = ${v}`); return v; }
        if (STATKEYS.includes(name)||Object.values(ITEMS).some(I=>name in I.stats)){ const v=obj.items.reduce((s,k)=>s+(ITEMS[k].stats[name]||0),0); line(`items.${name} = ${fmt(v)} (sum of item stats)`); return v; }
        throw new LangError(`an ItemSet has no “${name}”`, ln);
      }
      case "runes": {
        const c=obj.owner;
        const methods = {
          add: (args)=>{ for (const a of args.flatMap(x=>x&&x.t==="list"?x.items:[x])){ if(!a||a.t!=="rune") throw new Error(`runes.add() takes runes, not ${typeName(a)}`); c.runes.push(a.key); } statMemo.clear(); return null; },
          remove: (args)=>{ for (const a of args){ const i=c.runes.indexOf(a&&a.key); if (i>=0) c.runes.splice(i,1); } return null; },
          contains: (args)=>c.runes.includes(args[0]&&args[0].key), size: ()=>c.runes.length,
        };
        if (methods[name]) return M(methods[name]);
        throw new LangError(`runes has add(), remove(), contains(), size()`, ln);
      }
      case "fights": {
        const v=obj;
        if (TR && !(TR.seenFights ||= new WeakSet()).has(v)){ TR.seenFights.add(v); sweepTrace(v); }
        const sub = (keep, what) => { const rec=v.rec.filter(keep); if (!rec.length) throw new Error(`this sweep has no fights ${what}`); return {...v, rec}; };
        const num1 = (x, fn) => { if (typeof x!=="number") throw new Error(`${fn}() takes a number`); return x; };
        const methods = {
          byStart:(a)=>{ const s=num1(a[0],"byStart"); return sub(x=>Math.abs(x.s-s)<1e-9, `at start ${fmt(s)} (starts: ${[...new Set(v.rec.map(x=>x.s))].map(fmt).join(", ")})`); },
          byLevel:(a)=>{ const L=num1(a[0],"byLevel"); if (v.rec[0] && v.rec[0].L==null) throw new Error("this sweep kept the champions' own levels (no levels: given)"); return sub(x=>x.L===L, `at level ${fmt(L)}`); },
          byRoles:(a)=>{ const i=num1(a[0],"byRoles"); return sub(x=>x.r===i, `for role set ${fmt(i)} (role sets count from 1 to ${v.nroles})`); },
          bySide:(a)=>{ const i=num1(a[0],"bySide"); if (i!==1 && i!==2) throw new Error("bySide(1): team 1 on side 1 as given; bySide(2): the swapped fights (bothSides: true)"); return sub(x=>x.o===i-1, i===2 ? "with the sides swapped (add bothSides: true)" : "as given"); },
        };
        if (methods[name]) return M(methods[name]);
        const st=sweepStats(v.rec);
        if (own(st, name)) return st[name];
        throw new LangError(`a Fights sweep has: wins, draws, losses, total, share, low, high, meanTime, margin, sideMismatches, byStart(d), byLevel(L), byRoles(i), bySide(1|2)`, ln);
      }
      case "fight": {
        const f=obj;
        if (TR && !TR.seenFights) TR.seenFights=new WeakSet();
        if (TR && !TR.seenFights.has(f)){ TR.seenFights.add(f); fightSummary(f).forEach(l=>TR.lines.push(l)); (f.notes||[]).forEach(n=>TR.notes.add(n)); }
        const U = x => { if (!x||x.t!=="champ") throw new Error(`expected a Champion from this fight`); const same=f.units.filter(u=>champKey(u.c)===champKey(x)); const u=same.find(u=>x.label && u.c.label===x.label) || same[0] || f.units.find(u=>u.c.champ===x.champ); if(!u) throw new Error(`${label(x)} wasn't in this fight`); return u; };
        const side = x => typeof x==="number" ? (x===1 || x===2 ? x-1 : (()=>{ throw new Error(`a fight has sides 1 and 2, not ${fmt(x)}`); })()) : (x&&x.t==="comp" ? f.units.find(u=>x.champs.some(c=>champKey(c)===champKey(u.c)))?.side : x&&x.t==="champ" ? U(x).side : null);
        const methods = {
          alive:(a)=>U(a[0]).alive, dead:(a)=>!U(a[0]).alive, hp:(a)=>Math.max(0,U(a[0]).hp), hpPercent:(a)=>Math.max(0,U(a[0]).hp)/U(a[0]).max,
          deathTime:(a)=>{ const u=U(a[0]); if (u.dummy) return u.wouldDieAt ?? Infinity; return u.alive?Infinity:u.deathAt; }, dealt:(a)=>U(a[0]).dealt, healed:(a)=>U(a[0]).healDone,
          shielded:(a)=>U(a[0]).shieldDone, received:(a)=>U(a[0]).healRecv, taken:(a)=>U(a[0]).taken,
          ccTime:(a)=>{ const u=U(a[0]), v=Math.round((u.lockTime||0)*1000)/1000; line(`${u.name} spent ${fmt(v)}s unable to act (stunned, airborne, suppressed, asleep or forced)`); return v; },
          blocks:(a)=>U(a[0]).blocks||0, position:(a)=>U(a[0]).x,
          // casts(x, Q): times x started that ability (first casts; recasts played by kits aren't counted); bySource(x, "name"): x's damage
          // after resistances from hits labelled name ("E Aftershock", "R storm", "Q", "Ignite"; exact, see srcMatch; prefix: true = starts with)
          casts:(a)=>{ const u=U(a[0]), s=a[1] && a[1].t==="slot" ? a[1].name : String(a[1]||""); if (!/^[QWER]$/.test(s)) throw new Error("casts(x, Q): the second argument is Q, W, E or R");
            const v=(u.castsBy||{})[s]||0; line(`${u.name} cast ${s} ${v} time${v===1?"":"s"}`); return v; },
          bySource:(a, nm)=>{ const u=U(a[0]), want=norm(String(a[1]??"")); if (!want) throw new Error(`bySource(x, "E Aftershock"): name a source`);
            checkNamed(nm, ["prefix"], "bySource(x, name)"); const pre=!!(nm&&nm.prefix);
            const hs=u.hits.filter(h=>srcMatch(h.what, want, pre)), v=hs.reduce((s,h)=>s+h.v,0); line(`${u.name}: ${a[1]}${pre?" (every label starting with it)":""}: ${hs.length} hits, ${fmt(v)} damage after resistances${srcHint(u.hits, want, hs.length)}`); return v; },
          distance:(a)=>{ const v=Math.abs(U(a[0]).x-U(a[1]).x); line(`distance ${U(a[0]).name} – ${U(a[1]).name} at the end: ${fmt(v)} units`); return v; },
          survivors:(a)=>{ const s=side(a[0]); if (s==null) throw new Error("survivors() takes 1, 2 or a TeamComp from the fight"); return f.units.filter(u=>u.side===s&&u.alive).length; },
          deaths:(a)=>{ const s=side(a[0]); return f.units.filter(u=>u.side===s&&!u.alive).length; },
          totalHealing:(a)=>{ const s=side(a[0]); return f.units.filter(u=>u.side===s).reduce((x,u)=>x+u.healDone+u.shieldDone,0); },
        };
        if (name==="winner"){ const a=f.units.some(u=>u.side===0&&u.alive), b=f.units.some(u=>u.side===1&&u.alive); return a&&!b?1:b&&!a?2:0; }
        if (name==="duration") return f.end;
        if (name==="log"){ return f.log.join("\n"); }
        if (methods[name]) return M(methods[name]);
        throw new LangError(`a Fight has: winner, duration, log, alive(x), dead(x), hp(x), hpPercent(x), deathTime(x), dealt(x), healed(x), shielded(x), received(x), taken(x), ccTime(x), blocks(x), position(x), distance(x, y), casts(x, Q), bySource(x, "name"), survivors(side), deaths(side), totalHealing(side)`, ln);
      }
      case "combo": {
        const methods = { size: ()=>obj.steps.length, add: (args)=>{ const more=comboOf({t:"list", items:args}, "add()").steps; checkSize(obj.steps.length+more.length, "Combo", ln, more.length); for (const x of more) obj.steps.push(x); return null; } };
        if (methods[name]) return M(methods[name]);
        if (name==="steps") return obj.steps.join(" → ");
        throw new LangError(`a Combo has size(), add(…) and steps`, ln);
      }
      case "comboresult": {
        const r=obj;
        const nth = (arr, i, what) => { if (!(Number.isInteger(i) && i>=1 && i<=arr.length)) throw new Error(`${what}(i) counts from 1 to ${arr.length}`); return arr[i-1]; };
        const cm = {
          stepDamage: (a)=>{ const x=nth(r.steps, a[0], "stepDamage"); if (x.skipped) throw new Error(`step ${a[0]} (${x.step}) was skipped: ${x.skipped}`); line(`step ${a[0]} ${x.step} at ${x.t.toFixed(2)}s = ${fmt(x.dmg)}`); return x.dmg; },
          hit: (a)=>{ const h=nth(r.hits, a[0], "hit"); line(`hit ${a[0]}: ${h.what} at ${h.t.toFixed(2)}s = ${fmt(h.v)} ${h.type}`); return h.v; },
          // when step i was pressed and when hit i landed (backlog 25: an attack or ability lands after its press)
          stepTime: (a)=>{ const x=nth(r.steps, a[0], "stepTime"); line(`step ${a[0]} ${x.step} pressed at ${x.t.toFixed(2)}s`); return x.t; },
          hitTime: (a)=>{ const h=nth(r.hits, a[0], "hitTime"); line(`hit ${a[0]}: ${h.what} lands at ${h.t.toFixed(2)}s`); return h.t; },
          // total post-mitigation damage from one source (an item's "damage dealt" counter): hits whose label starts with it
          bySource: (a, nm)=>{ checkNamed(nm, ["prefix"], "bySource(name)"); const pre=!!(nm&&nm.prefix), want=norm(String(a[0]??"")), hs=r.hits.filter(h=>srcMatch(h.what, want, pre));
            if (!want) throw new Error(`bySource("Kraken Slayer"): name a source. This result has: ${[...new Set(r.hits.map(h=>String(h.what).replace(/ \(×.*\)$| hit \d+\/\d+$/,"")))].join(", ")}`);
            const v=hs.reduce((s,h)=>s+h.v,0); line(`${a[0]}${pre?" (every label starting with it)":""}: ${hs.length} hits, ${fmt(v)} damage after resistances${srcHint(r.hits, want, hs.length)}`); return v; },
        };
        if (cm[name]) return M(cm[name]);
        if (name==="hitCount") return r.hits.length;
        if (name==="floatingText") return floatingText(r);
        const v = {damage:r.damage, time:r.time, killed:r.killed, killTime:r.killTime, hpLeft:r.hpLeft, hpPercent:r.hpLeft/r.hpMax,
          dps:r.damage/Math.max(r.time,0.25), lingering:r.lingering, healed:r.healed, shielded:r.shielded, steps:r.steps.map(x=>`${x.step}${x.skipped?" (skipped)":` ${fmt(x.dmg)}`}`).join(", "), log:r.log.join("\n")}[name];
        if (v===undefined) throw new LangError(`a ComboResult has damage, time, killed, killTime, hpLeft, hpPercent, dps, lingering, healed, shielded, steps, log, floatingText, hitCount, hit(i), hitTime(i), stepDamage(i), stepTime(i), bySource("name")`, ln);
        if (TR && ["damage","time","killed","killTime","hpLeft","hpPercent","dps"].includes(name) && !(TR.seenFights ||= new WeakSet()).has(r)){
          TR.seenFights.add(r);
          TR.lines.push(`${r.who} performs ${r.combo.steps.join(" → ")} on ${r.target}`);
          for (const x of r.steps) TR.lines.push(`  ${x.t.toFixed(2)}s  ${x.step}${x.skipped?`: skipped (${x.skipped})`:`: ${fmt(x.dmg)}`}`);
          if (r.lingering>0.5) TR.lines.push(`  after the last step: ${fmt(r.lingering)}`);
        }
        return v;
      }
      case "rune": { if (name==="name") return runeName(obj.key); if (name==="description") return CALC.runes[obj.key].desc; throw new LangError(`a Rune has name and description`, ln); }
      case "comp": case "list": {
        const arr = obj.t==="comp" ? obj.champs : obj.items;
        const methods = {
          size: ()=>arr.length, add: (args)=>{ checkSize(arr.length+args.length, typeName(obj), ln, args.length); for(const a of args) arr.push(copy(a)); return null; }, push_back: (args)=>{ checkSize(arr.length+args.length, typeName(obj), ln, args.length); for(const a of args) arr.push(copy(a)); return null; },
          contains: (args)=>arr.some(x=>x&&args[0]&&x.t==="champ"&&args[0].t==="champ"&&x.champ===args[0].champ),
        };
        if (methods[name]) return M(methods[name]);
        throw new LangError(`a ${typeName(obj)} has no “${name}”. It has: size(), add(), contains(), [i]`, ln);
      }
    }
    throw new LangError(`${typeName(obj)} has no “.${name}”`, ln);
  }
  const tagName = a => a && (a.t==="tag"||a.t==="slot"||a.t==="cls") ? a.name : String(a);
  function tagArg(a, allowNew){ if (a && a.t==="tag") return a.name; if (typeof a==="string") return a.toLowerCase(); throw new Error(`expected a tag such as stun, dash, untargetable`); }
  function vsArg(named){ const v=named && named.vs; if (v==null) return null; if (v.t!=="champ") throw new Error(`vs: needs a Champion, not ${typeName(v)}`); return v; }
  function fieldsOf(S){ return [...new Set(Object.values(S.calcs).map(x=>x[0]).concat(Object.values(S.dv).map(x=>x[0])))].slice(0,16); }

  /* ---- builtins ---- */
  const num = (a, fn) => { if (typeof a!=="number") throw new Error(`${fn}() takes numbers`); return a; };
  const BUILTINS = {
    min:(a)=>Math.min(...a.map(x=>num(x,"min"))), max:(a)=>Math.max(...a.map(x=>num(x,"max"))), abs:(a)=>Math.abs(num(a[0],"abs")),
    floor:(a)=>Math.floor(num(a[0],"floor")), ceil:(a)=>Math.ceil(num(a[0],"ceil")), round:(a)=>Math.round(num(a[0],"round")),
    sqrt:(a)=>Math.sqrt(num(a[0],"sqrt")), pow:(a)=>Math.pow(num(a[0],"pow"), num(a[1],"pow")),
    champions:(a)=>{ const L=globals.get("defaultLevel"); let ids=Object.keys(KB.champs).filter(id=>!KB.champs[id].dummy); if (a[0]){ if(a[0].t!=="cls") throw new Error("champions() takes a class, e.g. champions(Mage)"); ids=ids.filter(id=>WORLD.champ(id).classes.includes(a[0].name)); } return {t:"list", items:ids.map(id=>mkChamp(id,L))}; },
    items:()=>({t:"list", items:ITEMKEYS.filter(k=>ITEMS[k].complete).map(k=>({t:"item", key:k}))}),
    runes:()=>({t:"list", items:RUNE_KEYS.map(k=>({t:"rune", key:k}))}),
    canDodge:(a, named)=>canDodge(a[0], a[1], named),
    fight:(a, named)=>{ if (a.length<3 || typeof a[2]!=="number") throw new Error("fight(side1, side2, seconds, start: distance)"); return runFight([teamOf(a[0]), teamOf(a[1])], a[2], fightOpts(named)); },
    fights:(a, named)=>sweep(a, named),
    range:(a)=>{ if (a.length<2 || a.length>3 || a.some(x=>typeof x!=="number")) throw new Error("range(from, to) or range(from, to, step): numbers from “from” to “to”, both included, e.g. range(0, 1200, 50)");
      return {t:"list", items:rangeList(a[0], a[1], a.length>2 ? a[2] : (a[1]>=a[0] ? 1 : -1))}; },
    canKill:(a, named)=>{ const f=killFight(a, named, a[2]); const u=f.units[1]; return u.dummy ? u.wouldDieAt!=null : !u.alive; },
    timeToKill:(a, named)=>{ const f=killFight(a, named, named.within ?? 60); const u=f.units[1]; const dead = u.dummy ? u.wouldDieAt!=null : !u.alive;
      if (TR && !dead) TR.lines.push(`${u.name} survives the full ${fmt(named.within ?? 60)}s`); if (TR && u.dummy) TR.notes.add(`${u.name}: the dummy can't die; the time is when its damage taken reached its max health`); return !dead ? Infinity : u.dummy ? u.wouldDieAt : u.deathAt; },
  };
  function teamOf(v){ if (v&&v.t==="champ") return [v]; if (v&&v.t==="comp") return v.champs; if (v&&v.t==="list") return v.items; throw new Error(`a fight side is a Champion or TeamComp, not ${typeName(v)}`); }
  function rangeList(from, to, step){
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step===0 || (to-from)*step<0) throw new Error(`range(${fmt(from)}, ${fmt(to)}, ${fmt(step)}): the step must be non-zero and point from “from” towards “to”`);
    const n=Math.floor((to-from)/step + 1e-9) + 1; checkSize(n, "range", undefined, n); budgetValues(n);
    return Array.from({length:n}, (_, i)=>Math.round((from + i*step)*1e9)/1e9);
  }
  /* fights(a, b, seconds, starts:, levels:, roles:, bothSides:, kite:, room:, formation:): fight() over every start × level ×
     role set (× both side orders), results only. Each role function runs once per level and team (not per fight), and the
     fights themselves cost no interpreter steps (they count against the time limit only), so a sweep is far cheaper than
     the same loop written in Rift Logic. Fight objects are dropped after scoring: memory stays at one record per fight. */
  const SWEEP_MAX = 5000;
  function sweep(a, named){
    if (a.length!==3 || typeof a[2]!=="number") throw new Error("fights(team1, team2, seconds, starts: range(0, 1200, 50), levels: {9, 13, 16}, roles: f, bothSides: true)");
    checkNamed(named, ["starts","levels","roles","bothSides","kite","room","formation"], "fights(…)");
    if (!(a[2]>0 && a[2]<=120)) throw new Error("a fight lasts between 0 and 120 seconds");
    const nums = (v, what, eg) => { const xs = v&&v.t==="list" ? v.items : typeof v==="number" ? [v] : null;
      if (!xs || !xs.length || xs.some(x=>typeof x!=="number")) throw new Error(`fights(…, ${what} …) takes a number or a list of numbers, e.g. ${what} ${eg}`); return xs; };
    const starts = named.starts==null ? rangeList(0, 1200, 50) : nums(named.starts, "starts:", "range(0, 1200, 50)");
    if (starts.some(s=>!(s>=0))) throw new Error("starts: are distances between the two sides in units (0 or more)");
    const levels = named.levels==null ? [null] : nums(named.levels, "levels:", "{9, 13, 16}").map(L=>{ if (!(L>=1 && L<=18)) throw new Error(`levels: are 1–18, not ${fmt(L)}`); return Math.round(L); });
    const fns = named.roles==null ? [null] : named.roles.t==="list" ? named.roles.items : [named.roles];
    for (const f of fns) if (f!==null && !(f && f.t==="fn" && f.decl.params.length>=1 && f.decl.params.length<=3))
      throw new Error(`roles: takes a function you wrote (or a list of them): TeamComp f(TeamComp t), f(TeamComp t, int level) or f(TeamComp t, int level, int team); got ${typeName(f)}`);
    const both = named.bothSides!=null && truthy(named.bothSides);
    const fo = fightOpts({kite:named.kite, room:named.room, formation:named.formation});
    for (const k of ["kite","room","formation"]) if (named[k]==null) delete fo[k];
    const n = starts.length*levels.length*fns.length*(both?2:1);
    if (n > SWEEP_MAX) throw new Error(`fights(…) runs at most ${big(SWEEP_MAX)} fights (this one would run ${big(n)}): use fewer starts, levels or role sets`);
    const teams=[teamOf(a[0]), teamOf(a[1])];
    if (!teams[0].length || !teams[1].length) throw new Error("fights(…): each team needs at least one champion");
    // a team at one level under one role set: level first, then the role function (which may also change items, ranks, …)
    const prep = (i, L, f) => {
      let champs = teams[i].map(c=>{ const x=copy(c); if (L!=null) x.level=L; return x; });
      if (f){ const d=f.decl, lv = L ?? champs[0].level;
        const out = invoke(d, [{t:"comp", champs}, lv, i+1].slice(0, d.params.length));
        champs = out && ["comp","champ","list"].includes(out.t) ? teamOf(out).map(copy) : [];
        if (!champs.length || champs.some(c=>!c||c.t!=="champ")) throw new Error(`roles: ${d.name}() must return the team (a TeamComp of champions)`); }
      return champs; };
    const rec=[], notes=new Set(), saved=TR; TR=null;
    try {
      for (let ri=0; ri<fns.length; ri++) for (const L of levels){
        const A=prep(0, L, fns[ri]), B=prep(1, L, fns[ri]);
        for (const o of both ? [0, 1] : [0]) for (const s of starts){
          const f=runFight(o ? [B, A] : [A, B], a[2], {...fo, start:s});
          let a1=0, a2=0; for (const u of f.units) if (u.alive){ if ((u.side===0) === !o) a1++; else a2++; }
          rec.push({s, L, r:ri+1, o, w: a1&&!a2 ? 1 : a2&&!a1 ? -1 : 0, end:f.end, m:a1-a2});
          for (const x of f.notes) if (notes.size<300 && !/^fight\(\): the sides start /.test(x)) notes.add(x);
        }
      }
    } finally { TR=saved; }
    const nm = t => t.length===1 ? label(t[0]) : t.map(c=>champName(c)).join("/");
    const v={t:"fights", rec, secs:a[2], nroles:fns.length, both, names:[nm(teams[0]), nm(teams[1])], notes:[...notes]};
    if (TR){ (TR.seenFights ||= new WeakSet()).add(v); sweepTrace(v); }
    return v;
  }
  function sweepTrace(v){
    TR.lines.push(`fights(): ${v.rec.length} fights of up to ${fmt(v.secs)}s — ${sweepLine(v)}`);
    sweepGrid(v).forEach(l=>TR.lines.push(l));
    TR.notes.add("fights(): share = (wins + draws/2) / fights, from team 1's side (a draw: neither team wiped); the 95% interval is Wilson's score interval over the swept cells — fights are deterministic, so it measures how the result spreads across starts, levels and role sets, not luck");
    v.notes.forEach(n=>TR.notes.add(n));
  }
  function perform(c, combo, named){
    if (combo && combo.t==="list") combo = comboOf(combo, "perform()");
    if (!combo || combo.t!=="combo") throw new Error("perform(combo, vs: target) takes a Combo, e.g. Combo q = {Q, AA, E, R};");
    checkNamed(named, ["vs","within","distance","wait","fightBack","healers"], "perform(…)");
    const tgt=named.vs; if (!tgt || tgt.t!=="champ") throw new Error("perform needs vs: a target Champion");
    if (!combo.steps.length) throw new Error("the combo is empty");
    if (combo.steps.length > PERFORM_MAX_STEPS) throw new Error(`perform plays at most ${big(PERFORM_MAX_STEPS)} combo steps (this combo has ${big(combo.steps.length)})`);
    const att=copy(c); att._script=combo.steps.slice(); att._scriptWait = named.wait !== false; att._scriptTravel = named.distance!=null; att.opts={...att.opts, target:null};
    // a library combo that opens with stacks (Yasuo/Yone Q3): start with them unless the champion's .stacks was set
    if (combo.start && combo.start.stacks!=null && KIT[c.champ] && KIT[c.champ].stacks && kitOptsOf(c)["@stacks"]==null){
      att.opts={...att.opts, stacks:{...((att.opts||{}).stacks||{}), "@stacks":combo.start.stacks}};
      if (TR) TR.notes.add(`${label(c)} starts the combo with ${fmt(combo.start.stacks)} ${KIT[c.champ].stacks.name} stack${combo.start.stacks===1?"":"s"} (the library combo opens with them; set ${label(c)}.stacks to override)`); }
    const t2=copy(tgt); t2.opts={...t2.opts, passive: !named.fightBack};
    const helpers = named.healers ? teamOf(named.healers).map(h=>{ const x=copy(h); x.opts={...x.opts, passive:true}; return x; }) : [];
    if (named.distance!=null && !(typeof named.distance==="number" && named.distance>=0)) throw new Error("perform(…, distance: n): n is the units between the two champions' centres");
    if (named.within!=null && !(typeof named.within==="number" && named.within>0)) throw new Error("perform(…, within: n): n is the time limit in seconds (more than 0)");
    // distance: puts the two champions that many units apart (centre to centre) for distance-based effects (Arcane Comet, Aftershock's radius);
    // the combo's steps still ignore range, but dashes toward the target travel it (their hits land on arrival, as in fight(); item 26)
    const notes=new Set(); const f=simulate([[att],[t2,...helpers]], named.within ?? 30, notes, named.distance!=null ? {start:named.distance, formation:false} : undefined);
    const A=f.units[0], T=f.units[1];
    const steps=A.stepLog, last=steps.length ? steps[steps.length-1].t : 0, immediate=steps.reduce((x,y)=>x+y.dmg,0);
    const dk = T.dummy ? T.wouldDieAt!=null : !T.alive;
    const hitsT=A.hits.filter(h=>h.tgt===T.name), lastHit=hitsT.length ? Math.max(...hitsT.map(h=>h.t??0)) : last;
    const r={t:"comboresult", who:label(c), target:label(tgt), combo, damage:A.dealt, time:Math.max(last, lastHit), killed:dk, killTime:dk?(T.dummy?T.wouldDieAt:T.deathAt):Infinity,
             hpLeft:dk?0:Math.max(0,T.hp), hpMax:T.max, steps, lingering:A.dealt-immediate, log:f.log, notes:[...notes], healed:A.healDone, shielded:A.shieldDone,
             hits:A.hits.filter(h=>h.tgt===T.name), dummy:T.dummy};
    if (TR && T.dummy){ TR.notes.add(`${r.target}: the practice-tool dummy can't die (stays at 1 health, restores after ${DUMMY_RESET}s without damage); killed/killTime say when the damage taken reached its ${fmt(T.max)} health, as a champion with these stats would die`);
      if (dk) TR.notes.add(`${r.target}: after the would-be kill the dummy sits at 1 health, so later current-health effects are smaller than on a champion`); }
    if (TR){
      (TR.seenFights ||= new WeakSet()).add(r);
      TR.lines.push(`${r.who} performs ${combo.steps.join(" → ")} on ${r.target}${named.wait===false?" (skipping abilities on cooldown)":""}`);
      for (const x of steps) TR.lines.push(`  ${x.t.toFixed(2)}s  ${x.step}${x.skipped?`: skipped (${x.skipped})`:`: ${fmt(x.dmg)}${x.spread?` (over ${fmt(x.spread)}s)`:""}${x.note?` (${x.note})`:""}`}`);
      if (r.lingering>0.5) TR.lines.push(`  after the last step (burns, delayed procs): ${fmt(r.lingering)}`);
      TR.lines.push(`  total ${fmt(r.damage)} in ${fmt(r.time)}s → ${r.target} ${r.killed?`dies at ${fmt(r.killTime)}s`:`left on ${fmt(r.hpLeft)}/${fmt(r.hpMax)}`}`);
      TR.notes.add(`perform(): ${r.target} ${named.fightBack?"fights back":"doesn't fight back (add fightBack: true)"}; abilities on cooldown are ${named.wait===false?"skipped":"waited for"}; every step hits; each lands after its cast time${named.distance!=null?`, flight over the ${fmt(named.distance)} units and appear-delay; dashes toward ${r.target} travel them (edge gap / dash speed) and hit on arrival, and the next step waits for a dash`:" and appear-delay; positions are ignored (no flight or dash travel; give distance: to have missiles fly and dashes travel it)"}`);
      notes.forEach(n=>{ if (!/fight\(\): attacks without a set target/.test(n)) TR.notes.add(n); });
    }
    return r;
  }
  function fightOpts(named){ const o={}; named=named||{};
    for (const k of Object.keys(named)) if (!["start","kite","room","formation","fightBack","healers","within"].includes(k)) throw new Error(`fight options are start: (distance between the two front lines, default 0), kite: (false = nobody kites, even with role "kite"), room: (how far a unit can back off; default unlimited), formation: (false = everyone on the front line)`);
    if (named.formation!=null) o.formation=truthy(named.formation);
    if (named.start!=null){ if (typeof named.start!=="number" || named.start<0) throw new Error("start: is the distance between the two sides in units (0 or more)"); o.start=named.start; }
    if (named.kite!=null) o.kite=truthy(named.kite);
    if (named.room!=null){ if (typeof named.room!=="number" || named.room<0) throw new Error("room: is a distance in units"); o.room=named.room; }
    return o; }
  function runFight(sides, T, fo){
    if (!(T>0 && T<=120)) throw new Error("a fight lasts between 0 and 120 seconds");
    const notes=new Set(); const f=simulate(sides.map(s=>s.map(copy)), T, notes, fo||{}); f.notes=[...notes];
    if (fo && fo.start) notes.add(`fight(): the sides start ${fmt(fo.start)} units apart`), f.notes=[...notes];
    if (TR){ if (!TR.seenFights) TR.seenFights=new WeakSet(); TR.seenFights.add(f); fightSummary(f).forEach(l=>TR.lines.push(l)); f.log.slice(0,40).forEach(l=>TR.lines.push("    "+l)); if (f.log.length>40) TR.lines.push(`    … ${f.log.length-40} more events (print(f.log) shows them all)`); notes.forEach(n=>TR.notes.add(n)); }
    return f;
  }
  function killFight(a, named, T){
    checkNamed(named, ["within","fightBack","healers","start"], "canKill(…) / timeToKill(…)");
    const [att, tgt]=a; if (!att||att.t!=="champ"||!tgt||tgt.t!=="champ") throw new Error("canKill(attacker, target, seconds) and timeToKill(attacker, target) take two Champions");
    const t2=copy(tgt); if (!named.fightBack) t2.opts={...t2.opts, passive:true};
    const helpers = named.healers ? teamOf(named.healers).map(h=>{ const x=copy(h); x.opts={...x.opts, passive:true, healPolicy:x.opts&&x.opts.healPolicy||"lowest"}; return x; }) : [];
    if (TR) TR.notes.add(`${label(tgt)} ${named.fightBack?"fights back":"does not attack back (add fightBack: true)"}${helpers.length?`; healers only heal and shield: ${helpers.map(label).join(", ")}`:""}`);
    return runFight([[att], [t2, ...helpers]], T, fightOpts({start:named.start}));
  }

  /* ---- expressions ---- */
  function evalE(e, env){
    tick(e.line);
    switch (e.k){
      case "num": case "str": case "bool": return e.v;
      case "id": return lookup(e.name, env, e.line);
      case "list": checkSize(e.items.length, "list", e.line); return {t:"list", items:e.items.map(x=>copy(evalE(x,env)))};
      case "typed": return coerce(e.type, evalE(e.list, env), e.line);
      case "member": {
        const obj=evalE(e.obj, env);
        let v; try { v=member(obj, e.name, e.called, e.line); } catch(err){ throw err instanceof LangError ? err : new LangError(err.message, e.line); }
        if (v && v.t==="method" && !e.called){ try { return v.fn([], {}); } catch(err){ throw err instanceof LangError ? err : new LangError(err.message, e.line); } }
        return v;
      }
      case "index": {
        const o=evalE(e.obj,env), i=evalE(e.i,env);
        const arr = o&&o.t==="comp" ? o.champs : o&&o.t==="list" ? o.items : o&&o.t==="set" ? o.items.map(k=>({t:"item",key:k})) : null;
        if (!arr) throw new LangError(`can't index a ${typeName(o)}`, e.line);
        if (typeof i!=="number" || !(i>=0 && i<arr.length)) throw new LangError(`index ${typeof i==="number"?fmt(i):show(i)} is out of range (size ${arr.length})`, e.line);
        return arr[Math.trunc(i)];
      }
      case "call": return call(e, env);
      case "un": { const v=evalE(e.e,env); if (e.op==="!") return !truthy(v); if (typeof v!=="number") throw new LangError(`can't negate a ${typeName(v)}`, e.line); return -v; }
      case "incr": { const old=evalE(e.e,env); if(typeof old!=="number") throw new LangError("++ and -- work on numbers", e.line); const nv=old+(e.op==="++"?1:-1); store(e.e, nv, env, e.line); return e.pre?nv:old; }
      case "assign": {
        let v=evalE(e.value, env);
        if (e.op!=="="){ const old=evalE(e.target, env); v=arith(e.op[0], old, v, e.line); }
        store(e.target, copy(v), env, e.line, e.value); return v;
      }
      case "bin": {
        if (e.op==="&&"){ const a=evalE(e.a,env); return truthy(a) ? truthy(evalE(e.b,env)) : false; }
        if (e.op==="||"){ const a=evalE(e.a,env); return truthy(a) ? true : truthy(evalE(e.b,env)); }
        const a=evalE(e.a,env), b=evalE(e.b,env);
        return binop(e.op, a, b, e.line);
      }
    }
    throw new LangError(`can't evaluate ${e.k}`, e.line);
  }
  function binop(op, a, b, ln){
    if (["==","!="].includes(op)){ let eq; if (a&&b&&a.t==="champ"&&b.t==="champ") eq=champKey(a)===champKey(b); else if (a&&b&&a.t==="item"&&b.t==="item") eq=a.key===b.key; else if (typeof a==="number"&&typeof b==="number") eq=Math.abs(a-b)<1e-9; else eq=a===b; return op==="=="?eq:!eq; }
    if (["<","<=",">",">="].includes(op)){ if(typeof a!=="number"||typeof b!=="number") throw new LangError(`can only compare numbers, not ${typeName(a)} and ${typeName(b)}`, ln); return {"<":a<b,"<=":a<=b,">":a>b,">=":a>=b}[op]; }
    return arith(op, a, b, ln);
  }
  function arith(op, a, b, ln){
    if (op==="+" && (typeof a==="string"||typeof b==="string")){ const r=show(a)+show(b); if (r.length>1e6) throw new LangError("string longer than 1,000,000 characters (a string doubling in a loop?)", ln); return r; }
    if (op==="+" && a&&a.t==="set") return {t:"set", items:checkItemLimits([...a.items, ...toItems(b,"+")], "+")};
    if (op==="+" && a&&a.t==="comp"){ if(!b||b.t!=="champ") throw new LangError("add a Champion to a TeamComp", ln); checkSize(a.champs.length+1, "TeamComp", ln, 0); return {t:"comp", champs:[...a.champs.map(copy), copy(b)]}; }
    if (op==="+" && a&&a.t==="combo"){ try { const more=comboOf(b,"+").steps; checkSize(a.steps.length+more.length, "Combo", ln); return {t:"combo", steps:a.steps.concat(more)}; } catch(e){ throw e instanceof LangError ? e : new LangError(e.message, ln); } }
    if (op==="+" && a&&a.t==="slot" && b&&(b.t==="slot"||b.t==="combo")) return {t:"combo", steps:[a.name, ...comboOf(b,"+").steps]};
    if (op==="+" && a&&a.t==="item") return {t:"set", items:checkItemLimits([a.key, ...toItems(b,"+")], "+")};
    if (typeof a!=="number"||typeof b!=="number") throw new LangError(`“${op}” needs numbers, not ${typeName(a)} and ${typeName(b)}`, ln);
    if ((op==="/" || op==="%") && b===0) throw new LangError(`division by zero (${fmt(a)} ${op} 0)`, ln);
    { const r = op==="+" ? a+b : op==="-" ? a-b : op==="*" ? a*b : op==="/" ? a/b : op==="%" ? a%b : undefined;
      if (r!==undefined){ if (Number.isNaN(r)) throw new LangError(`${fmt(a)} ${op} ${fmt(b)} is not a number`, ln); return r; } }
    throw new LangError(`unknown operator ${op}`, ln);
  }
  function store(target, v, env, ln, rhs){
    if (target.k==="id"){ if(!env.has(target.name)) throw new LangError(`“${target.name}” is not declared; declare it first, e.g. auto ${target.name} = …;`, ln); const old=env.get(target.name); if (v && v.t==="champ" && !(rhs && (rhs.k==="id" || rhs.k==="index") && !v.label)) v.label = target.name; if (target.name==="defaultLevel" && !(typeof v==="number" && v>=1 && v<=18)) throw new LangError("defaultLevel must be 1–18", ln);
      if (target.name==="gameMinute" && !(typeof v==="number" && v>=0 && Number.isFinite(v))) throw new LangError("gameMinute is a number of minutes (0 or more)", ln);
      env.set(target.name, target.name==="defaultLevel" ? Math.round(v) : v); if (target.name==="defaultLevel") statMemo.clear(); if (target.name==="gameMinute"){ GAME.minute=v; statMemo.clear(); } return; }
    if (target.k==="member"){
      const obj=evalE(target.obj, env);
      if (obj&&obj.t==="champ" && ["target","healPolicy","passive","rotation","souls","skillOrder","role","stasis","exhaustAt"].includes(target.name)){
        if (target.name==="exhaustAt" && !(typeof v==="number" && v>=0 && Number.isFinite(v)) && !(typeof v==="string" && /^(arrival(\+[0-9]*\.?[0-9]+)?|never|default)$/.test(v))) throw new LangError(`exhaustAt (when Exhaust is pressed) is "arrival" (the first step an enemy is targetable in range), "arrival+0.25" (that much later), a time in seconds, "never", or "default" (on its target once it fights)`, ln);
        if (target.name==="exhaustAt" && v==="default") v=null;
        if (target.name==="stasis" && !(typeof v==="number" && v>=0 && Number.isFinite(v)) && !["low","dash","pop","cover","never"].includes(v)) throw new LangError(`stasis (when Zhonya's / Seeker's is pressed) is "low" (below 30% health, the default), "dash" (as Zed's Death Mark dash ends), "pop" (just before a Death Mark pops), "cover" (as early as the stasis still covers the pop), "never", or a time in seconds`, ln);
        if (target.name==="role" && !["kite","dive","peel","engage","fight"].includes(v)) throw new LangError(`role is "kite", "dive", "peel", "engage" or "fight"`, ln);
        if (target.name==="rotation" && !(typeof v==="string" && /^[QWERqwer]+$/.test(v))) throw new LangError(`rotation is the order to cast abilities in, e.g. "RQEW"`, ln);
        if (target.name==="souls" && !(typeof v==="number" && v>=0 && Number.isFinite(v))) throw new LangError(`souls is a number of Dark Harvest souls (0 or more)`, ln);
        if (target.name==="skillOrder" && !/^[QWEqwe]{1,3}$/.test(String(v))) throw new LangError(`skillOrder is the order to max basic abilities, e.g. "QEW"`, ln);
        if (target.name==="healPolicy" && !(v&&v.t==="champ") && !["lowest","save","self"].includes(v)) throw new LangError(`healPolicy is "lowest", "save", "self" or a Champion`, ln);
        if (target.name==="target" && !(v&&v.t==="champ")) throw new LangError(`target must be a Champion`, ln);
        obj.opts = {...(obj.opts||{}), [target.name]: target.name==="passive" ? truthy(v) : v}; return; }
      if (obj&&obj.t==="champ" && target.name==="oathsworn"){   // Kalista's Oathsworn (wiki The Black Spear): an ally in her fight() team
        if (obj.champ!=="Kalista") throw new LangError(`only Kalista has an Oathsworn`, ln);
        if (!(v&&v.t==="champ") || v.dummy) throw new LangError(`oathsworn must be an allied Champion, e.g. kalista.oathsworn = rakan;`, ln);
        obj.opts = {...(obj.opts||{}), oathsworn: v}; return; }
      if (obj&&obj.t==="champ" && target.name==="summoners"){ const arr=v&&v.t==="list"?v.items:v&&v.t==="summoner"?[v]:null; if (!arr || arr.some(x=>!x||x.t!=="summoner")) throw new LangError(`summoners is a list of summoner spells, e.g. ${label(obj)}.summoners = {Flash, Ignite}`, ln);
        try { obj.summoners=setSummoners(obj, arr.map(x=>x.key)); } catch(e){ throw new LangError(e.message, ln); } return; }
      if (obj&&obj.t==="champ" && (target.name==="stacks" || target.name==="evolved")){   // champion kits: own stacks, evolved abilities
        const k=KIT[obj.champ], nm=champName(obj);
        if (target.name==="stacks"){ if (!k || !k.stacks) throw new LangError(`${nm} has no stacks of its own${Object.keys(KIT).some(x=>KIT[x].stacks)?` (champions with stacks: ${Object.keys(KIT).filter(x=>KIT[x].stacks).map(x=>KB.champs[x].name).join(", ")})`:""}; item stacks are set with .stacks(Item, n)`, ln);
          if (typeof v!=="number" || v<0 || v>k.stacks.max || v!==Math.floor(v)) throw new LangError(`${nm}.stacks (${k.stacks.name}) is a whole number from 0${k.stacks.max<Infinity?` to ${k.stacks.max}`:""}`, ln);
          obj.opts={...(obj.opts||{}), stacks:{...((obj.opts||{}).stacks||{}), "@stacks":v}}; return; }
        if (!k || !k.evolved) throw new LangError(`${nm} has no evolved or augmented abilities (champions with them: ${Object.keys(KIT).filter(x=>KIT[x].evolved).map(x=>KB.champs[x].name).join(", ")})`, ln);
        const sl = v && v.t==="list" ? v.items.map(x=>x && x.t==="slot" ? x.name : String(x)) : v && v.t==="combo" ? v.steps : typeof v==="string" ? v.toUpperCase().split("") : null;
        if (!sl || sl.some(x=>!k.evolved.slots.includes(x))) throw new LangError(`${nm}.evolved takes abilities from ${k.evolved.slots.split("").join(", ")}, e.g. ${nm}.evolved = {${k.evolved.slots.slice(0,2).split("").join(", ")}};`, ln);
        obj.opts={...(obj.opts||{}), stacks:{...((obj.opts||{}).stacks||{}), "@evolved":[...new Set(sl)].sort((a,b)=>"QWER".indexOf(a)-"QWER".indexOf(b)).join("")}}; return; }
      if (obj&&obj.t==="champ" && target.name==="level"){ if(!(v>=1&&v<=18)) throw new LangError("level must be 1–18", ln); obj.level=Math.round(v); return; }
      if (obj&&obj.t==="ability" && target.name==="rank"){ const max=maxRankOf(obj.owner, obj.slot); if(!(v>=0&&v<=max)) throw new LangError(`${obj.slot} rank must be 0–${max}`, ln); obj.owner.ranks[obj.slot]=Math.round(v); return; }
      throw new LangError(`you can set a champion's level, skillOrder, target, healPolicy, passive, rotation, role, stasis, exhaustAt and souls, and an ability's rank; “${target.name}” is calculated.${hint(target.name, ["level","rank","skillOrder","target","healPolicy","passive","rotation","souls","stasis","exhaustAt"])}`, ln);
    }
    if (target.k==="index"){ const o=evalE(target.obj,env), i=evalE(target.i,env); const arr=o&&o.t==="comp"?o.champs:o&&o.t==="list"?o.items:null; if(!arr) throw new LangError("can't assign into that", ln);
      if (typeof i!=="number" || !Number.isInteger(i) || i<0 || i>=arr.length) throw new LangError(`index ${typeof i==="number"?fmt(i):show(i)} is out of range (size ${arr.length}; use .add(…) to grow a list)`, ln);
      if (o.t==="comp" && !(v&&v.t==="champ")) throw new LangError(`a TeamComp holds champions, not ${typeName(v)}`, ln);
      arr[i]=v; return; }
  }
  function call(e, env){
    if (e.fn.k==="id" && (e.fn.name==="assert"||e.fn.name==="print")) return special(e, env);
    if (e.fn.k==="id" && TYPES.has(e.fn.name)){ // Champion(Syndra, 11), ItemSet(...)
      const args=e.args.map(a=>evalE(a,env));
      if (e.fn.name==="Dummy"){ const named={}; for (const [k,v] of Object.entries(e.named||{})) named[k]=evalE(v,env); try { return mkDummy(args, named); } catch(err){ throw new LangError(err.message, e.line); } }
      if (e.fn.name==="Champion"){ const c=args[0]; if(!c||c.t!=="champ") throw new LangError("Champion(…) takes a champion, e.g. Champion(Syndra, 11)", e.line); const n=copy(c); if(args[1]!=null){ if(!(typeof args[1]==="number" && args[1]>=1 && args[1]<=18)) throw new LangError("level must be 1–18", e.line); n.level=Math.round(args[1]); } return n; }
      if (e.fn.name==="ItemSet") return {t:"set", items:checkItemLimits(args.flatMap(a=>toItems(a,"ItemSet")), "ItemSet(…)")};
      if (e.fn.name==="Combo") return comboOf({t:"list", items:args}, "Combo(…)");
      if (e.fn.name==="TeamComp") return {t:"comp", champs:args.map(copy)};
      throw new LangError(`${e.fn.name}(…) isn't a constructor here`, e.line);
    }
    const f=evalE(e.fn, env);
    const args=e.args.map(a=>evalE(a,env)), named={};
    for (const [k,v] of Object.entries(e.named)) named[k]=evalE(v,env);
    try {
      if (f && f.t==="method") return f.fn(args, named);
      if (f && f.t==="builtin"){ const r=f.fn(args, named); if (typeof r==="number" && Number.isNaN(r)) throw new Error(`${f.name}(${args.map(show).join(", ")}) is not a number`); return r; }
      if (f && f.t==="champ"){ if(typeof args[0]!=="number") throw new Error(`${champName(f)}(…) takes a level, e.g. ${champName(f)}(11)`); if (f.dummy) throw new Error(`the Target Dummy has no level; set it up with Dummy(hp: …, armor: …, mr: …)`);
        if (!(args[0]>=1 && args[0]<=18)) throw new Error(`level must be 1–18 (${champName(f)}(${fmt(args[0])}))`); const n=copy(f); n.level=Math.round(args[0]); return n; }
      if (f && f.t==="pred"){ const q=query(f.name, args, e.line); if (TR){ TR.subs.push(q); TR.lines.push(`${f.name}(${args.map(show).join(", ")}) is ${q.status==="none"?"not established (no rule applies)":q.status}`); } return q.status==="holds"; }
      if (f && f.t==="fn") return invoke(f.decl, args, e.line);
    } catch(err){ if (err instanceof LangError || err instanceof Ret || err===BREAK || err===CONTINUE) throw err; throw new LangError(friendlyMsg(err), e.line); }
    if (e.fn.k==="member" && ["rank","level","target","healPolicy","passive","rotation","souls","skillOrder"].includes(e.fn.name))
      throw new LangError(`${e.fn.name} is a field, not a function: set it with ${e.fn.src.replace(/\($/,"")} = ${e.args[0] && e.args[0].src ? e.args[0].src : "…"};`, e.line);
    throw new LangError(`${show(f)} is not something you can call`, e.line);
  }
  function invoke(d, args, ln){
    if (args.length!==d.params.length) throw new LangError(`${d.name} takes ${d.params.length} argument${d.params.length===1?"":"s"}, got ${args.length}`, ln);
    const env=new Env(globals);
    d.params.forEach((q,i)=>env.def(q.name, q.ref ? args[i] : coerce(q.type, args[i], ln)));
    if (++BUDGET.depth > BUDGET.maxDepth){ BUDGET.depth--; throw new BudgetError(`program stopped: ${d.name}() is ${BUDGET.maxDepth} calls deep — does it call itself forever?`, ln); }
    try { exec(d.body, env); } catch(r){ if (r instanceof Ret) return d.type==="auto"||d.type==="void" ? r.v : coerce(d.type, r.v, ln);
      if (r===BREAK || r===CONTINUE) throw new LangError(`${r===BREAK?"break":"continue"} outside a loop (in ${d.name})`, ln); throw r; }
    finally { BUDGET.depth--; }
    if (d.type!=="void") throw new LangError(`${d.name} ended without returning a ${d.type}`, ln);
    return null;
  }

  /* ---- rules ---- */
  const memo=new Map(), busy=new Set();
  function query(pred, args, ln){
    for (const a of args) if (!a || a.t!=="champ") throw new LangError(`${pred}(…) takes champions, got ${typeName(a)}`, ln);
    const key=pred+"|"+args.map(champKey).join(",");
    if (memo.has(key)) return memo.get(key);
    if (busy.has(key)) return {status:"none", pred, args, fired:[], idle:[], asm:[]};
    busy.add(key);
    const outer=TR, fired=[], idle=[];
    for (const r of rules){
      if (r.pred!==pred || r.args.length!==args.length) continue;
      const env=new Env(globals);
      r.params.forEach(q=>env.def(q.name, undefined));
      r.args.forEach((a,i)=>env.def(a, copy(args[i])));
      for (const q of r.params) if (env.get(q.name)===undefined) throw new LangError(`rule ${r.name}: parameter ${q.name} is not used in its claim`, r.line);
      const results=[]; let ok=true;
      const conj = conjuncts(r.body);
      if (conj){
        for (const c of conj){
          TR=newTrace();
          let v; try { v=truthy(evalE(c, env)); } catch(err){ if (err instanceof BudgetError) throw err; TR.lines.push(friendlyMsg(err)); v=false; }
          results.push({text:c.src, ok:v, tr:TR});
          if (!v){ ok=false; break; }
        }
      } else {
        TR=newTrace();
        let v=false; try { exec(r.body, env); } catch(x){ if (x instanceof Ret) v=truthy(x.v); else if (x instanceof BudgetError) throw x; else TR.lines.push(x===BREAK||x===CONTINUE ? `${x===BREAK?"break":"continue"} outside a loop` : friendlyMsg(x)); }
        results.push({text:"rule body", ok:v, tr:TR}); ok=v;
      }
      TR=outer;
      (ok ? fired : idle).push({r, results});
    }
    const best = side => fired.filter(f=>f.r.neg===side).reduce((m,f)=>Math.max(m,f.r.strength), -Infinity);
    const pos=best(false), neg=best(true);
    const status = !fired.length ? "none" : pos>neg ? "holds" : neg>pos ? "fails" : "contested";
    const top = status==="holds"?pos: status==="fails"?neg: Math.max(pos,neg);
    for (const f of fired){
      const winSide = status==="holds"?false: status==="fails"?true:null;
      f.win = winSide===null ? f.r.strength===top : f.r.neg===winSide;
      if (!f.win){ const beat=fired.find(g=>g.r.neg!==f.r.neg && g.r.strength>=f.r.strength && (winSide===null||g.r.neg===winSide)); f.beatenBy=beat?beat.r.name:null; }
    }
    const asm=new Set(), notes=new Set();
    for (const f of fired.filter(f=>f.win)) for (const x of f.results){ x.tr.asm.forEach(a=>asm.add(a)); x.tr.notes.forEach(n=>notes.add(n)); }
    const out={status, pred, args:args.map(copy), fired, idle, asm:[...asm], notes:[...notes]};
    busy.delete(key); memo.set(key,out);
    if (TR){ asm.forEach(a=>TR.asm.add(a)); }
    return out;
  }
  function conjuncts(body){
    if (body.body.length!==1 || body.body[0].k!=="return" || !body.body[0].e) return null;
    const out=[]; const walk=e=>{ if(e.k==="bin"&&e.op==="&&"){ walk(e.a); walk(e.b); } else out.push(e); };
    walk(body.body[0].e); return out;
  }

  /* ---- statements ---- */
  function special(e, env){
    const name=e.fn.name;
    if (name==="print"){
      const seen=new WeakSet();
      const rows=e.args.map(a=>{ const outer=TR; TR=newTrace(seen); let v; try { v=evalE(a,env); } finally { var tr=TR; TR=outer; } return {text:a.src, v, tr}; });
      emit({kind:"print", rows, line:e.line}); return null;
    }
    // assert
    if (!e.args.length) throw new LangError("assert needs a condition", e.line);
    const c=e.args[0], title = e.args[1] ? evalE(e.args[1], env) : c.src;
    const outer=TR;
    try {
      if (c.k==="bin" && ["<","<=",">",">=","==","!="].includes(c.op)){
        const seen=new WeakSet();
        TR=newTrace(seen); const a=evalE(c.a,env); const ta=TR;
        TR=newTrace(seen); const b=evalE(c.b,env); const tb=TR;
        const ok=binop(c.op, a, b, e.line);
        emit({kind:"assert", title, ok, cmp:{op:c.op, a:{text:c.a.src, v:a, tr:ta}, b:{text:c.b.src, v:b, tr:tb}}, line:e.line});
        return ok;
      }
      TR=newTrace(); const v=truthy(evalE(c,env)); const t=TR;
      emit({kind:"assert", title, ok:v, single:{text:c.src, v, tr:t}, line:e.line}); return v;
    } finally { TR=outer; }
  }
  function exec(s, env){
    tick(s.line);
    switch (s.k){
      case "block": { const inner=new Env(env); for (const x of s.body) exec(x, inner); return; }
      case "empty": return;
      case "expr": evalE(s.e, env); return;
      case "var": for (const d of s.decls){
        let v = d.init ? evalE(d.init.k==="ctor" ? {k:"call", fn:{k:"id",name:s.type,line:s.line}, args:d.init.args, named:{}, line:s.line} : d.init, env) : defaultOf(s.type);
        if (s.type==="Champion" && d.init && d.init.k==="list") throw new LangError("write a champion as Syndra(11), not in braces", s.line);
        v = s.ref ? v : coerce(s.type, v, s.line);
        // a fresh champion takes the variable's name (logs, lookups); a copy of an unnamed one (a TeamComp or list element, a
        // loop variable) keeps showing the champion's name, so fights with the original team still read the same
        if (v && v.t==="champ" && !s.ref && !(d.init && (d.init.k==="id" || d.init.k==="index") && !v.label)) v.label = d.name;
        env.def(d.name, v); } return;
      case "if": if (truthy(evalE(s.c,env))) exec(s.a, env); else if (s.b) exec(s.b, env); return;
      case "while": while (truthy(evalE(s.c,env))){ try { exec(s.body, env); } catch(x){ if(x===BREAK) break; if(x===CONTINUE) continue; throw x; } } return;
      case "for": { const inner=new Env(env); if (s.init) exec(s.init, inner);
        while (!s.c || truthy(evalE(s.c, inner))){ try { exec(s.body, inner); } catch(x){ if(x===BREAK) break; if(x!==CONTINUE) throw x; } if (s.step) evalE(s.step, inner); } return; }
      case "forin": { const it=evalE(s.it, env);
        const arr = it&&it.t==="comp" ? it.champs : it&&it.t==="list" ? it.items : it&&it.t==="set" ? it.items.map(k=>({t:"item",key:k})) : null;
        if (!arr) throw new LangError(`can't loop over a ${typeName(it)}`, s.line);
        for (const x of arr.slice()){ const inner=new Env(env); inner.def(s.name, s.ref ? x : coerce(s.type, x, s.line));
          try { exec(s.body, inner); } catch(y){ if(y===BREAK) break; if(y!==CONTINUE) throw y; } }
        return; }
      case "return": throw new Ret(s.e ? evalE(s.e, env) : null);
      case "break": throw BREAK;
      case "continue": throw CONTINUE;
      case "prove": {
        const c=s.claim;
        if (c.k==="call" && c.fn.k==="id" && preds.has(c.fn.name)){
          const args=c.args.map(a=>evalE(a,env)); emit({kind:"prove", q:query(c.fn.name, args, s.line), line:s.line, src:s.src}); return;
        }
        special({fn:{name:"assert"}, args:[c], line:s.line}, env); return;
      }
      case "proveall": {
        const it=evalE(s.it, env); const arr = it&&it.t==="comp" ? it.champs : it&&it.t==="list" ? it.items : null;
        if (!arr) throw new LangError(`forall needs a list of champions`, s.line);
        const c=s.claim; if (!(c.k==="call" && c.fn.k==="id" && preds.has(c.fn.name))) throw new LangError("prove forall needs a claim defined by rules, e.g. beats(c, Syndra)", s.line);
        const qs=[];
        for (const x of arr){ const inner=new Env(env); inner.def(s.name, copy(x)); const args=c.args.map(a=>evalE(a,inner));
          if (args.length===2 && args[0].champ===args[1].champ) continue; qs.push(query(c.fn.name, args, s.line)); }
        emit({kind:"proveall", qs, line:s.line, src:s.src}); return;
      }
      case "func": case "rule": return;
    }
    throw new LangError(`can't run ${s.k}`, s.line);
  }
  return {
    run(){
      for (const s of ast){
        quiet = !!s.lib;
        try { exec(s, globals); }
        catch(err){ if (err instanceof Ret) continue;
          const msg = err===BREAK || err===CONTINUE ? `${err===BREAK?"break":"continue"} outside a loop` : friendlyMsg(err);
          emit({kind:"error", msg, line: (err && err.line) ?? s.line}); if (err instanceof BudgetError) return; }
      }
    }
  };
}


/* ================= public API ================= */
/* opts: maxSteps (interpreter steps, default 3,000,000), maxDepth (nested function calls, default 200),
   maxMs (wall-clock time limit in ms, default none; the page passes one), maxValues (values created, default LIMITS.maxValues).
   The result's usage says how much of each budget the program used. */
function run(text, libs, opts){
  opts = opts || {};
  statMemo.clear(); rankMemo.clear(); WORLD=World(); TR=null; GAME.minute=20;
  BUDGET = {steps:0, maxSteps:opts.maxSteps ?? 3e6, depth:0, maxDepth:opts.maxDepth ?? 200, t0:Date.now(), maxMs:opts.maxMs ?? Infinity, polls:0,
            values:0, maxValues:opts.maxValues ?? LIMITS.maxValues, results:0, lines:0};
  const items=[]; let ast=[];
  for (const lib of (libs||[])){
    try { const la=parse(lib.text.replace(/^\s*import\s+"[^"]*"\s*;?/gm, "")); for (const st of la) st.lib=lib.name; ast.push(...la); }
    catch(e){ return {items:[{kind:"error", line:e.line??null, msg:`in ${lib.name}: ${friendlyMsg(e)}`}], functions:0, rules:0}; }
  }
  if (/^\s*import\s+"/m.test(text) && !(libs && libs.length)) items.push({kind:"error", line:null, msg:"import only works from the command line (node tools/rl.js); the editor ignores it"});
  text = text.replace(/^\s*import\s+"[^"]*"\s*;?/gm, "");
  try { ast.push(...parse(text)); }
  catch(e){ return {items:[{kind:"error", line:e.line??null, msg:friendlyMsg(e)}], functions:0, rules:0}; }
  try { Interpreter(ast, it=>items.push(it)).run(); }
  catch(e){ items.push({kind:"error", line:(e && e.line) ?? null, msg:friendlyMsg(e)}); }   // never let a JS exception escape to the page
  finally { TR=null; BUDGET.maxValues=Infinity; }   // copies made outside a run (the page's Inspect tab) aren't budgeted
  return {items, functions:ast.filter(s=>s.k==="func").length, rules:ast.filter(s=>s.k==="rule").length,
          usage:{steps:BUDGET.steps, values:BUDGET.values, results:BUDGET.results, traceLines:BUDGET.lines, ms:Date.now()-BUDGET.t0}};
}
return {run, parse, KB, CALC, ITEMS, ITEMKEYS, CLASSES, SLOTS, IDX, TAGS, KEYWORDS, TYPES, STATLABEL, RUNE_KEYS,
        norm, fmt, fmtc, show, label, champName, runeName, findItem, findRune, typeName, sweepStats, sweepGrid,
        _internals:{itemCalc, stats, MODELLED_ITEMS, simInterim}};
}
if (typeof module !== "undefined") module.exports = createRiftLogic;
