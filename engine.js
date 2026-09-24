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
const IDX = {};
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
/* practice-tool gameplay radius: 65, up to +100% size from bonus health, capped at 10,000 health = 130 (wiki). Linear growth is an assumption. */
const dummyRadius = c => 65*(1 + Math.min(1, Math.max(0, c.dummy.hp-1000)/9000));
const fmt = x => typeof x!=="number" ? String(x) : !Number.isFinite(x) ? "n/a" : Math.abs(x) >= 100 ? (Math.round(x*10)/10).toString() : (Math.round(x*100)/100).toString();
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
class LangError extends Error { constructor(msg, line){ super(msg); this.line=line; } }

function findItem(tok){
  const n = norm(tok);
  if (ITEMS[n]) return n;
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
const TYPES = new Set(["auto","int","double","float","bool","string","void","Champion","Item","ItemSet","TeamComp","Ability","List","Rune","Fight","Combo","ComboResult","Dummy","Summoner"]);
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
  if (CALC.runes[n]) return n;
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
    if (statMemo.size > 40000) statMemo.clear();
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
    st.range=B.range+(it.range||0);
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
function kitRankKey(c){ const k=KIT[c.champ]; return k && k.stats && k.rankStats ? "{"+Object.entries(c.ranks||{}).map(([s,r])=>s+r).join("")+"}" : ""; }

/* ================= fight simulator ================= */
const SIM_ASSUMPTIONS = [
  "fight(): positions on one line (1-D): side 1's front at 0, side 2's front at start: units (default 0 = contact); each unit stands max(0, attack range − 175) behind its front (formation: false = all on the front); no terrain, walls or body blocking; attacks need edge range (range + both gameplay radii), point-and-click abilities centred range, other abilities their reach + the target's hitbox (wiki Range)",
  "fight(): every ability and attack in range hits (perfect aim, no dodging in fight(); use canDodge for that); abilities land when cast (no travel time)",
  "fight(): abilities are cast as soon as they're off cooldown (0.25s cast lock); mana is ignored",
  "fight(): crowd control per ability from the game data checked against the wiki (Rift Logic docs: Crowd control); stun, airborne, suppression, sleep and forced actions stop everything, root stops moving, silence stops casting, polymorph stops attacking and casting, disarm stops attacking, ground stops dashes, slows cut move speed (only the strongest applies; slow resist; soft caps). Tenacity shortens all but airborne, suppression and drowsy (floor 0.3s); every CC interrupts channels",
  "fight(): default roles: ranged = kite (keep max attack range from shorter-ranged enemies, peel them with hard CC, knockbacks held for peel, dashes/blinks used to escape), melee = dive (walk or dash to the lowest-health enemy, use everything on it but knockbacks); knockbacks are held to peel an enemy that dives an ally (except role engage); set x.role = \"kite\" | \"dive\" | \"peel\" | \"engage\" | \"fight\"",
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
  zhonyashourglass:"Zhonya's Hourglass: fighters use it below 30% health; in combos only when listed as a step",
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
  bansheesveil:"Banshee's Veil: the spell shield is up when the fight starts and blocks a whole ability cast (all its damage and effects on you)",
  edgeofnight:"Edge of Night: the spell shield is up when the fight starts and blocks a whole ability cast (all its damage and effects on you)",
  verdantbarrier:"Verdant Barrier: the spell shield is up when the fight starts and blocks a whole ability cast (all its damage and effects on you)",
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
const QSS_CLEANSES = t => !AIRBORNE.has(t);                                        // Quicksilver: all but airborne (wiki)
const MIKAEL_CLEANSES = t => ["stun","root","silence","polymorph","charm","fear","taunt","berserk","sleep","slow","drowsy"].includes(t);
/* The ability's crowd control at its rank: [{type, dur, dist, mode, pct, decay, durMin, src, note}]. Effects the wiki makes
   conditional on terrain are left out (no terrain in fight()); effects with no known duration are left out and listed in skipped. */
function ccList(c, slot, rank){
  const S=CALC.champs[c.champ][slot]; const out=[], skipped=[];
  const ov = WORLD.champ(c.champ).ccOver && WORLD.champ(c.champ).ccOver[slot];
  const list = ov ? ov.v : (S && S.cc) || [];
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
  const dt=0.05, U=[], log=[], events=[];
  const say=(t,s)=>{ if (log.length<600) log.push(`${t.toFixed(2)}s  ${s}`); };
  SIM_ASSUMPTIONS.forEach(n=>simNotes.add(n));
  const has=(u,k)=>u.items.has(k);
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
    a.parts = kp ? kp.map(p=>({v:p.v*amp, type:p.type, pct:!!p.pctOf, pctOf:p.pctOf, floor:p.floor, ampMissing:p.ampMissing, ampCap:p.ampCap}))
                 : a.keys.map(k=>{ const r=partRaw(S,k,a.rank,st,u.flags); return {v:r.v*amp, type:a.types[k], pct:!!r.pctOf, pctOf:r.pctOf}; });
    if (S.heal) a.heal=evalCalc({S,rank:a.rank,st,flags:u.flags},S.heal).v*hamp;
    if (S.shield) a.shield=evalCalc({S,rank:a.rank,st,flags:u.flags},S.shield).v*hamp;
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
      script: c._script ? c._script.slice() : null, si:0, stepLog:[], scriptWait: c._scriptWait !== false};
    u.ranged = st.ranged;
    // position on the line (side 1 faces +x from 0, side 2 faces −x from fo.start) and crowd control state
    // formation (default): each unit stands max(0, attack range − 175) behind its side's front, i.e. ranged units at their
    // attack range from where the enemy front will stand; fight(..., formation: false) puts everyone on the front line
    u.depth = fo.formation===false ? 0 : Math.max(0, st.range-175);
    u.x = side===0 ? -u.depth : (fo.start||0)+u.depth; u.x0=u.x; u.ccs=[]; u.slows=[]; u.move=null; u.role=o.role||null; u.walk=null; u.chan=null;
    u.flags=new Set(); u.kit={};
    for (const s of ["P","Q","W","E","R"]){
      const S=CALC.champs[c.champ][s]; if (!S) continue;
      if (s==="P" && !u.script) continue;      // the passive is only triggered explicitly, in combos
      const rank=rankOf(c,s); if (!rank) continue;
      const tags=WORLD.champ(c.champ).slots[s].tags;
      const a={slot:s, rank, S, parts:[], heal:0, shield:0, aoe:tags.aoe!==undefined, hardcc:tags.hardcc!==undefined, mobile:tags.mobile!==undefined,
        immob:IMMOB_TAGS.some(x=>tags[x]!==undefined), slows:tags.slow!==undefined, range:(S.range||[])[rank]||0};
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
      { const ks=kitSpec(c,s); if (ks && ks.simCd && a.cdFixed==null){ a.cdFixed=ks.simCd(kitCtx(c,s,rank,st,u.flags,null,u)); simNotes.add(`${u.name} ${s}: in a fight it recasts on the same target only every ${fmt(a.cdFixed)}s (per-target lockout; the ability's own cooldown is shorter)`); } }
      a.base = a.cdFixed!=null ? a.cdFixed : (S.cd ? (S.cd[rank] ?? S.cd[1]) : 10);
      if (!(a.base>=0.5)){ a.passiveOnly=true; u.abAll[s]=a; if (!u.script) simNotes.add(`${u.name} ${s}: cooldown is ${fmt(a.base||0)} in the game data (a passive, toggle or ammo ability), so fight() doesn't cast it; set one with ${champName(c)}.${s}.setCooldown(…)`); continue; }
      a.cd = abCd(u,a);
      u.abAll[s]=a;
      if (!a.parts.length && !a.heal && !a.shield && !a.cc.length && !(a.later && a.later.length)) continue;
      u.ab[s]=a;
    }
    for (const f of u.flags) simNotes.add(`${u.name}: ${f}`);
    return u;
  }
  const enemiesOf = (u,t) => U.filter(x=>x.alive && x.side!==u.side && t>=x.stasisUntil);
  const partDmg = (p, x) => { let v = !p.pct ? p.v : p.v*(p.pctOf==="current" ? Math.max(0,x.hp) : p.pctOf==="missing" ? Math.max(0,x.max-x.hp) : x.max);
    if (p.floor && v<p.floor) v=p.floor;                                                              // champion kits: Dr. Mundo Q minimum
    if (p.ampMissing) v*=1+Math.min(p.ampCap??1, p.ampMissing*Math.max(0,1-x.hp/x.max));             // Akali R recast, Samira passive
    return v; };
  const alliesOf = (u) => U.filter(x=>x.alive && x.side===u.side);
  const pct = x => x.hp/x.max;
  const incoming = (x,t,w=1.5) => x.dmgIn.filter(d=>d.t>t-w).reduce((s,d)=>s+d.v,0)/w;
  const sameChamp = (u, c) => !!c && champKey(u.c)===champKey(c);
  /* ---- positions, movement and crowd control (fight(); scripted combos ignore range) ---- */
  const RAD = u => hitboxOf(u.c);                       // gameplay radius per champion (character record; dummy grows with health)
  const face = u => u.side===0 ? 1 : -1;                // the direction of the enemy side
  const gap = (a,b) => Math.abs(a.x-b.x);
  const ccOn = (u,t,type) => u.ccs.some(c=>c.type===type && c.until>t);
  const LOCKS = ["stun","suppress","sleep","knockup","knockback","pull","charm","fear","taunt","berserk"];
  const locked = (u,t) => u.ccs.some(c=>c.until>t && LOCKS.includes(c.type));
  const canCast = (u,t) => !locked(u,t) && !ccOn(u,t,"silence") && !ccOn(u,t,"polymorph");
  const canAttack = (u,t) => !locked(u,t) && !ccOn(u,t,"disarm") && !ccOn(u,t,"polymorph");
  const canMove = (u,t) => !locked(u,t) && !ccOn(u,t,"root") && !(u.move && u.move.t1>t);
  const canDash = (u,t) => canMove(u,t) && !ccOn(u,t,"ground");
  const ccImmune = (u,t) => u.shields.some(s=>s.ccImmune && s.until>=t && shieldLeft(s,t)>0.01);
  // wiki Movement speed: only the strongest slow counts; slow resist scales it; soft caps after
  function slowNow(u,t){ let best=0; for (const s of u.slows){ if (s.until<=t) continue; const v = s.decay ? s.pct*(s.until-t)/Math.max(1e-9,s.until-s.t0) : s.pct; if (v>best) best=v; } return best*(1-(u.st.slowresist||0)); }
  const msNow = (u,t) => msCap((u.st.msuncapped||u.st.ms)*(1-slowNow(u,t)));
  // Cheap Shot's crowd control (wiki Rune_data_Cheap_Shot): immobilize, blind, disarm, ground, nearsight, polymorph, silence, slow
  const CHEAP_CC = ["stun","root","knockup","knockback","pull","suppress","sleep","charm","fear","taunt","berserk","blind","disarm","ground","nearsight","polymorph","silence"];
  const cheapShotImpaired = (x,t) => x.ccs.some(c=>c.until>t && CHEAP_CC.includes(c.type)) || x.slows.some(s=>s.until>t) || x.impairedUntil>t;
  // Approach Velocity (wiki): +7.5% move speed walking toward a movement-impaired enemy within 1000, +15% toward one you impaired (any distance)
  function msWalk(u,t,dir){
    if (!u.runes.has("approachvelocity") || !dir) return msNow(u,t);
    let b=0; for (const e of U){ if (!e.alive || e.side===u.side || Math.sign(e.x-u.x)!==dir) continue;
      const imp = e.slows.some(s=>s.until>t) || e.ccs.some(c=>c.until>t && ["stun","root","knockup","suppress","sleep","charm","fear","taunt","ground"].includes(c.type));
      if (!imp) continue; const mine = e.slows.some(s=>s.until>t && s.by===u) || e.ccs.some(c=>c.until>t && c.src===u) || e.impairedBy===u && e.impairedUntil>t;
      b=Math.max(b, mine ? 0.15 : gap(u,e)<=1000 ? 0.075 : 0); }
    if (!b) return msNow(u,t);
    return msCap(u.st.msraw*(1+u.st.mspct+b)*(1-slowNow(u,t))); }
  const aaReach =(u,x) => u.st.range + RAD(u) + RAD(x);          // wiki Range: basic attacks use edge range
  function abReach(u,a,x){ const p=a.p||{};
    if (p.delivery==="unit") return p.range>0 && p.range<20000 ? p.range : p.range>=20000 ? Infinity : aaReach(u,x);   // wiki Range: unit-targeted = centred
    const r=reachOf(p); return r>=20000 ? Infinity : r>0 ? r + RAD(x) : aaReach(u,x); }
  const inReach = (u,a,x) => gap(u,x) <= abReach(u,a,x) + 1e-6;
  const roleOf = u => u.role || (u.ranged ? (fo.kite===false ? "fight" : "kite") : "dive");
  function displace(x, to, dur, t){ x.move={x0:x.x, x1:to, t0:t, t1:t+Math.max(dur,1e-3)}; }
  function stepMove(u,t){ const m=u.move; if (!m) return; const f=Math.min(1,(t-m.t0)/(m.t1-m.t0)); u.x=m.x0+(m.x1-m.x0)*f; if (f>=1) u.move=null; }
  const clampRoom = (u, x) => fo.room==null ? x : u.side===0 ? Math.max(u.x0-fo.room, x) : Math.min(u.x0+fo.room, x);
  function walk(u, toX, t, why){
    const d=toX-u.x, step=msWalk(u,t,Math.sign(d))*dt; if (Math.abs(d)<1e-6) return;
    const nx=clampRoom(u, u.x + Math.sign(d)*Math.min(step, Math.abs(d))); if (Math.abs(nx-u.x)<1e-9) return;
    const state=`${why}`; if (u.walk!==state){ u.walk=state; say(t, `${u.name} ${why} (move speed ${fmt(msNow(u,t))})`); }
    u.x=nx;
  }
  const holdStill = u => { u.walk=null; };
  // an enemy diving an ally that outranges it (or u itself): the peel target
  function threat(u,t){ let best=null, bd=Infinity;
    for (const e of enemiesOf(u,t)){ if (e.passive) continue;
      for (const A of alliesOf(u)){ const g=gap(e,A); if (g<=aaReach(e,A)+50 && aaReach(e,A)<aaReach(A,e) && g<bd){ bd=g; best=e; best.victim=A; } } }
    return best; }
  function chaser(u,t){ let best=null, bd=Infinity;
    for (const e of enemiesOf(u,t)){ if (e.passive) continue; const g=gap(u,e); if (aaReach(e,u)<aaReach(u,e) && g<aaReach(u,e)-5 && g<bd){ bd=g; best=e; } } return best; }
  function interrupt(x,t){
    if (x.chan && x.chan.until>t){ for (const y of U) y.dots=y.dots.filter(d=>!(d.u===x && d.ability && d.ability.channel)); say(t, `  ${x.name}'s ${x.chan.slot} channel is interrupted`); x.chan=null; }
    x.nextAct=Math.min(x.nextAct, t);
  }
  // spell shields: items (Banshee's, Edge of Night, Verdant Barrier) and abilities (Sivir E, Nocturne W: cast as the ability lands, perfect play)
  function blocked(u,a,x,t){
    const ss=["bansheesveil","edgeofnight","verdantbarrier"].find(k=>has(x,k));
    if (ss && t>=(x.annulAt??0)){ x.annulAt=t+idv(ss,"Cooldown",40); x.blocks=(x.blocks||0)+1; say(t, `  ${ITEMS[ss].name} blocks ${u.name}'s ${a.slot} on ${x.name}`); return true; }
    if (!x.passive && !x.script) for (const s of ["Q","W","E","R"]){ const b=x.abAll[s]; if (!b || b.spellShield==null || (x.cd[s]||0)>t || !canCast(x,t)) continue;
      x.cd[s]=t+abCd(x,b); x.blocks=(x.blocks||0)+1; say(t, `  ${x.name} blocks ${u.name}'s ${a.slot} with ${s} (spell shield raised as it lands: perfect play)`);
      simNotes.add(`${x.name} ${s}: spell shield raised just as a hostile ability lands (perfect reaction); blocks all of that ability's damage and crowd control (wiki)`);
      if (b.heal) heal(x,x,b.heal,t,`${s} spell shield block`); return true; }
    return false;
  }
  function applyCC(u, a, x, t, d0){
    if (!a.cc || !a.cc.length || !x.alive || t<x.stasisUntil) return;
    // a crowd-control-immunity shield (Morgana E) is cast on the ally just as the hard CC lands (perfect play)
    if (a.hard && !ccImmune(x,t)) for (const y of alliesOf(x)){ if (y.passive || y.script || !canCast(y,t)) continue;
      for (const s of ["Q","W","E","R"]){ const b=y.abAll[s]; if (!b || !b.ccImmune || !b.shield || (y.cd[s]||0)>t) continue; const r=b.p&&b.p.range||0; if (y!==x && gap(y,x)>r+RAD(x)) continue;
        refresh(y,t); abNums(y,b); y.cd[s]=t+abCd(y,b); say(t, `  ${y.name} casts ${s} on ${x===y?"self":x.name} as ${u.name}'s ${a.slot} lands (perfect reaction)`);
        shield(y,x,b.shield,b.shieldDur,t,`${s}`); if (x.shields.length) x.shields[x.shields.length-1].ccImmune=true;
        simNotes.add(`${y.name} ${s}: the crowd-control-immunity shield is cast just as enemy hard CC lands on an ally in range (perfect reaction)`); break; }
      if (ccImmune(x,t)) break; }
    if (ccImmune(x,t)){ say(t, `  ${x.name} ignores ${u.name}'s ${a.slot} crowd control (crowd control immunity)`); return; }
    const ten=x.st.tenacity||0;
    for (const e of a.cc){
      let dur=e.dur;
      if (e.durMin!=null){ const r=Math.min(abReach(u,a,x), 5000)||1; dur=e.durMin+(e.dur-e.durMin)*Math.min(1, d0/r);
        simNotes.add(`${u.name} ${a.slot}: ${e.type} lasts ${fmt(e.durMin)}–${fmt(e.dur)}s growing with distance (wiki); assumed linear from 0 to the ability's reach`); }
      const eff=ccDuration({...e, dur}, ten), why = eff<dur-1e-9 ? ` (${fmt(dur)}s, −${fmt(100*ten)}% tenacity)` : "";
      if (e.type==="slow"){ x.slows.push({pct:e.pct, until:t+eff, t0:t, decay:e.decay, by:u});
        say(t, `  ${x.name} is slowed ${fmt(100*e.pct)}%${e.decay?" (decaying)":""}${x.st.slowresist?` × (1 − ${fmt(100*x.st.slowresist)}% slow resist)`:""} for ${fmt(eff)}s${why}: move speed ${fmt(msNow(x,t))}`); continue; }
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
        x.ccs.push({type:e.type, until:t+e.dur, src:u}); displace(x, to, e.dur, t); x.walk=null; interrupt(x,t);
        say(t, `  ${x.name} is ${what} over ${fmt(e.dur)}s (airborne; tenacity doesn't apply): ${fmt(gap(u,x))} → ${fmt(Math.abs(to-u.x))} units from ${u.name}`); continue; }
      x.ccs.push({type:e.type, until:t+eff, src:u});
      if (LOCKS.includes(e.type) || ["silence","polymorph"].includes(e.type)) interrupt(x,t);
      say(t, `  ${x.name} is ${CC_VERB[e.type]||e.type} for ${fmt(eff)}s${why}${NO_TENACITY.has(e.type)&&ten>0?" (tenacity doesn't apply)":""}`);
      if (e.type==="knockup" || e.type==="stun" || e.type==="suppress"){ x.impairedBy=u; x.impairedUntil=Math.max(x.impairedUntil, t+eff); }
    }
  }
  // charm, fear, taunt, berserk: the unit walks (and taunt/berserk attack) on its own
  function forcedAct(u,t){
    if (u.ccs.some(c=>c.until>t && ["stun","suppress","sleep","knockup","knockback","pull"].includes(c.type))) return;
    const c=u.ccs.find(c=>c.until>t && ["charm","fear","taunt","berserk"].includes(c.type)); if (!c || !c.src) return;
    if ((c.type==="taunt"||c.type==="berserk") && c.src.alive && t>=u.nextAA && gap(u,c.src)<=aaReach(u,c.src)){ autoAttack(u,c.src,t); return; }
    if (!(u.move && u.move.t1>t) && !ccOn(u,t,"root")) walk(u, c.type==="fear" ? u.x+(u.x===c.src.x?-face(u):Math.sign(u.x-c.src.x))*1000 : c.src.x, t, c.type==="fear"?`flees from ${c.src.name}`:`walks to ${c.src.name} (${c.type})`);
  }
  function pickTarget(u, foes, role, t){
    let tgt = u.target ? foes.find(x=>sameChamp(x,u.target)) : null;
    if (tgt) return tgt;
    if (role==="dive" || role==="engage") return foes.slice().sort((a,b)=>a.hp-b.hp)[0];
    const reach = x => Math.max(aaReach(u,x), ...Object.values(u.ab).filter(a=>a.parts.length).map(a=>Math.min(abReach(u,a,x), 3000)));
    const near = foes.filter(x=>gap(u,x)<=reach(x));
    if (near.length) return near.sort((a,b)=>a.hp-b.hp)[0];
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
    for (const b of u.buffs) for (const [k,v] of Object.entries(b.mods)) (k.endsWith("penpct")?pen:add)(k,v);
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
    // runes with in-fight stats (wiki Rune_data_*): Conqueror 1.8–4 adaptive per stack (AP = AD / 0.6), Absolute Focus
    // off below 70% health, Unflinching +10 armor/MR while crowd controlled and 2 s after, Nimbus Cloak decaying speed
    if (u.runes.has("conqueror") && u.conq.until>t && u.conq.n>0){ const per=lerpL(1.8,4,L(u))*u.conq.n; if (u.base.adaptiveType==="physical") add("bonusad",per); else add("ap",per/0.6); }
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
    if (has(tgt,"guardianangel") && !tgt.gaUsed){ tgt.gaUsed=true; tgt.hp=1; tgt.stasisUntil=t+4; tgt.reviveAt=t+4; say(t, `${tgt.name} would die: Guardian Angel revives in 4s`); return; }
    tgt.alive=false; tgt.deathAt=t; tgt.hp=0; say(t, `☠ ${tgt.name} dies${att?` (killed by ${att.name})`:""}`);
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
    if (!tgt.alive || t<tgt.stasisUntil || raw<=0) return 0;
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
      if (!magic && t<tgt.cleaver.until) R*=1-idv("blackcleaver","ShredPerStack",0.06)*tgt.cleaver.n;
      if (magic && tgt.bloodlet.until>t) R*=1-idv("bloodletterscurse","ShredPerStack",0.075)*tgt.bloodlet.n;
      if (t<tgt.after.until) R+= magic ? tgt.after.mr : tgt.after.armor;
      const p=magic?att.st.magicpenpct:att.st.armorpenpct, f=magic?att.st.magicpen:att.st.lethality+att.st.armorpen;
      let r=R>0 ? R*(1-p) : R; r = R>0 ? Math.max(0,r-f) : r;
      v *= r>=0 ? 100/(100+r) : 2-100/(100-r);
    }
    // damage taken modifiers (post-mitigation, from all sources)
    if (tgt.expose && tgt.expose.until>t) v*=1+tgt.expose.amp;
    if (tgt.vuln && tgt.vuln.until>t) v*=1+idv("imperialmandate","DamageAmp",0.07);
    if (kind==="aa"){
      if (has(tgt,"platedsteelcaps")||has(tgt,"armoredadvance")) v*=0.9;   // Plating: item text, 10%
      if (has(tgt,"wardensmail")) v-=Math.min(idv("wardensmail","BlockBase",15), idv("wardensmail","WardenDamageMax",0.2)*v);
    }
    if (tgt.blue && tgt.blue.until>t && (kind==="aa"||kind==="ability")){ v=Math.max(0, v-tgt.blue.amt); tgt.blue=null; }
    if (tgt.plating && tgt.plating.from===att && tgt.plating.n>0 && t<tgt.plating.until){ v=Math.max(0, v-tgt.plating.amt); tgt.plating.n--; }
    else if (tgt.runes.has("boneplating") && ready(tgt,"boneplating",t) && kind!=="dot"){ tgt.plating={from:att, n:3, until:t+1.5, amt:lerpL(30,60,L(tgt))}; setcd(tgt,"boneplating",t,55); }
    { const k1=CHAMP_MECH[tgt.c.champ], k2=CHAMP_MECH[att.c.champ];   // champion kits: damage taken / dealt (Yasuo shield, Zed and Yone marks)
      if (k1 && k1.onHurt && !o.redirect) k1.onHurt(tgt, att, v, type, t, kind); if (k2 && k2.onDealt && !o.redirect) k2.onDealt(att, tgt, v, pre, type, t, kind); }
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
    if (tgt.hp<=0) kill(tgt, att, t);
    else if (has(att,"thecollector") && pct(tgt)<idv("thecollector","ExecuteThreshold",0.05) && !o.redirect){ say(t, `${att.name} executes ${tgt.name} (The Collector)`); tgt.hp=0; kill(tgt, att, t); }
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
    const e=o.eff ?? 1, hpB = o.hp0 ?? x.hp;
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
  function autoAttack(u, tgt, t){
    refresh(u,t);
    // on-attack effects first: they change this attack's timer
    if (has(u,"guinsoosrageblade")){ const R=u.rage, max=idv("guinsoosrageblade","MaxStacks",4); let phantom=false;
      if (R.until>t && R.n>=max){ if (R.ph>=2){ R.ph=0; phantom=true; } else R.ph++; } else R.ph=0;
      R.n=Math.min(max,(R.until>t?R.n:0)+1); R.until=t+idv("guinsoosrageblade","BuffDuration",4);
      if (phantom) events.push({at:t+0.15, fn:(tt)=>{ say(tt, `  ${u.name}: Guinsoo's Phantom Hit`); applyOnHit(u,tgt,tt,{basic:true}); }}); }
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
    u.nextAA=t+1/as; u.nextAct=t+Math.min(0.25,0.4/as); u.lastAAt=t; u.walk=null;
    if (ccOn(u,t,"blind")){ say(t, `${u.name}'s attack on ${tgt.name} misses (blinded)`); return; }
    // the attack's damage (critical strikes at their expected value)
    const hp0=tgt.hp, crit=u.st.crit, cdm=u.st.critdmg*(has(tgt,"randuinsomen")?1-idv("randuinsomen","PercentCritDamageReduction",0.3):1);
    let mult=1+crit*(cdm-1), what=crit?"attack, expected crit":"attack", trueX=0;
    if (has(u,"sunderedsky") && !(u.sunder[tgt.name]>t)){ u.sunder[tgt.name]=t+idv("sunderedsky","Cooldown",10); mult=cdm*idv("sunderedsky","CritModifier",0.8); what="attack, Sundered Sky crit"; }
    else if (fh){ const fm=idv("fiendhunterbolts","CritModifier",0.8);
      mult=(1-crit)*cdm*fm + crit*cdm; trueX=crit*idv("fiendhunterbolts","BonusTrueDamage",0.15)*u.st.ad*cdm; what="attack, Opening Barrage crit"; }
    const kam=CHAMP_MECH[u.c.champ], am = kam && kam.attack ? kam.attack(u,tgt,t,mult) : null;   // champion kits: empowered attacks
    if (am && am.replace) deal(u,tgt,am.replace.v,am.replace.type,t,"aa",am.replace.what); else deal(u,tgt,u.st.ad*mult,"physical",t,"aa",what);
    if (am && am.bonus) for (const b of am.bonus) deal(u,tgt,b.v,b.type,t,"aa",b.what);
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
    if (has(u,"runaanshurricane")) for (const y of enemiesOf(u,t).filter(y=>y!==tgt).slice(0,2)){ deal(u,y,itemCalc(u.st,"runaanshurricane","boltdamage")*(1+crit*(u.st.critdmg-1)),"physical",t,"onhit","Runaan's bolt"); applyOnHit(u,y,t,{}); }
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
  function hitList(u,a,tgt,t){
    if (u.script) return a.aoe ? enemiesOf(u,t) : (tgt ? [tgt] : []);
    if (!a.aoe) return tgt && tgt.alive && t>=tgt.stasisUntil && inReach(u,a,tgt) ? [tgt] : [];
    const p=a.p||{}, r=p.radius||0, foes=enemiesOf(u,t);
    let list;
    if (p.delivery==="self") list = foes.filter(x=>gap(u,x)<=abReach(u,a,x)+1e-6);
    else if (tgt && r>0 && (p.kind==="area" || ["placed","lobbed","remote"].includes(p.delivery))) list = foes.filter(x=>Math.abs(x.x-tgt.x)<=r+RAD(x)+1e-6 && gap(u,tgt)<=abReach(u,a,tgt)+1e-6);
    else list = foes.filter(x=>gap(u,x)<=abReach(u,a,x)+1e-6);        // lines and cones: on one line, everything within reach
    return list;
  }
  function cast(u, a, tgt, t, o={}){
    refresh(u,t); u.kitT=t; abNums(u,a); a.cd=abCd(u,a);
    let cdv=a.cd;
    if (has(u,"actualizer") && u.actUntil>t && a.slot!=="R"){ const win=u.actUntil-t, f=1+idv("actualizer","CooldownTick",0.3); cdv = cdv<=win*f ? cdv/f : win+(cdv-win*f); }
    u.cd[a.slot]=t+cdv; u.nextAct=t+(a.channel ? a.spread : 0.25); u.casts++;
    if (a.channel){ u.nextAA=Math.max(u.nextAA, t+a.spread); simNotes.add(`${u.name} ${a.slot}: channel — its damage is spread over ${fmt(a.spread)}s and the caster does nothing else meanwhile`); }
    if (a.mobile) u.mobileUntil=t+4;
    if (a.channel) u.chan={id:u.casts, slot:a.slot, until:t+a.spread};
    // dashes and blinks move the caster: toward the target (to touching distance, at most the dash range) or away from a chaser (o.away)
    const d0 = tgt ? gap(u,tgt) : 0; let arrive=0;
    if (a.dash && !u.script && (tgt || o.away) && canDash(u,t)){
      if (!a.di){ try { a.di=dashInfo(u.c, a.slot); } catch(err){ a.di={dist:0, time:0, castTime:0, blink:a.blink}; } }
      const di=a.di, ref=o.away||tgt, dir = o.away ? (u.x===ref.x ? -face(u) : Math.sign(u.x-ref.x)) : (ref.x===u.x ? face(u) : Math.sign(ref.x-u.x));
      let to = o.away ? clampRoom(u, u.x+dir*di.dist) : u.x+dir*Math.min(di.dist, Math.max(0, gap(u,tgt)-RAD(u)-RAD(tgt)));
      const by=Math.abs(to-u.x);
      if (by>1){ if (a.blink) u.x=to; else { arrive=Math.max(0.05, (di.time-di.castTime)*by/Math.max(1,di.dist)); displace(u, to, arrive, t); }
        say(t, `${u.name} ${a.blink?"blinks":"dashes"} ${fmt(by)} units ${o.away?`away from ${o.away.name}`:`toward ${tgt.name}`} (${a.slot})${a.blink?"":` in ${fmt(arrive)}s`}`);
        simNotes.add(`fight(): dashes and blinks use the game data dash range and speed (dashInfo); a dash's hits land when it arrives, a blink's at once`); }
    }
    if (arrive>0){ events.push({at:t+arrive, fn:(tt)=>{ if (u.alive && !locked(u,tt)) resolveCast(u,a,tgt,tt,d0); }}); }
    else resolveCast(u,a,tgt,t,d0);
    if (a.heal){ const ts = supportTargets(u,a,t,true) || [u]; if (!a.parts.length && a.saidAt!==t) say(t, `${u.name} casts ${a.slot}`); for (const x of ts) heal(u,x,a.heal,t,`${a.slot}`); }
    if (a.shield){ const ts = supportTargets(u,{...a, heal:0},t,true) || [u]; if (!a.parts.length && !a.heal && a.saidAt!==t) say(t, `${u.name} casts ${a.slot}`);
      for (const x of ts){ shield(u,x,a.shield,a.shieldDur,t,`${a.slot}`); if (a.ccImmune && x.shields.length){ x.shields[x.shields.length-1].ccImmune=true; say(t, `  ${x.name} is immune to crowd control while the shield holds`); } } }
  }
  function resolveCast(u, a, tgt, t, d0){
    const km=CHAMP_MECH[u.c.champ], ktg=tgt||enemiesOf(u,t)[0]||null; if (km && km.onCast) km.onCast(u, a, ktg, t);
    // Spellblade: an ability cast empowers the next attack (not while Spellblade is on cooldown)
    if (SPELLBLADE.some(k=>has(u,k)) && t>=u.sb.cd){ const k=SPELLBLADE.find(k=>has(u,k)); u.sb.ready=true; u.sb.until=t+idv(k,"SpellBladeDuration",10);
      if (k==="lichbane" && u.lastAAt>-10){ const as=asOf(u, idv("lichbane","SheenASBuff",0.5)); u.nextAA=Math.min(u.nextAA, u.lastAAt+1/as); } }
    // mana spent heals (Rod of Ages / Catalyst Eternity)
    if (has(u,"rodofages")||has(u,"catalystofaeons")){ const k=has(u,"rodofages")?"rodofages":"catalystofaeons"; const cost=(a.S.cost||[])[a.rank]||0; if (cost>0) heal(u,u,Math.min(idv(k,"EternityMaxHealPerCast",20), idv(k,"EternityHealthRestore",0.25)*cost),t,null); }
    if (a.slot==="R"){
      if (has(u,"experimentalhexplate") && ready(u,"hexplate",t)){ setcd(u,"hexplate",t,idv("experimentalhexplate","Cooldown",30)); addBuff(u,"overdrive",t+idv("experimentalhexplate","HasteDuration",8),{bonusAS:(u.ranged?idv("experimentalhexplate","BonusASRanged",35):idv("experimentalhexplate","BonusASMelee",50))/100},t); say(t, `  ${u.name}: Hexplate Overdrive`); }
      if (has(u,"fiendhunterbolts") && ready(u,"fiend",t)){ setcd(u,"fiend",t,idv("fiendhunterbolts","Cooldown",45)); u.fiend={n:idv("fiendhunterbolts","NumberOfAttacks",3), until:t+idv("fiendhunterbolts","Duration",8)};
        if (u.lastAAt>-10) u.nextAA=Math.min(u.nextAA, u.lastAAt+1/asOf(u, idv("fiendhunterbolts","BonusAS",0.5))); }
      if (has(u,"zekesconvergence") && ready(u,"zeke",t)){ setcd(u,"zeke",t,idv("zekesconvergence","Cooldown",45)); for (const x of enemiesOf(u,t)) addDot(u,x,t,"zeke","Frostfire Tempest",idv("zekesconvergence","DamagePerSecond",30),idv("zekesconvergence","Duration",5),0); }
    }
    if (a.parts.length && tgt){
      const targets = hitList(u,a,tgt,t);
      if (!targets.length && !u.script) say(t, `${u.name}'s ${a.slot} misses: ${tgt.name} is out of reach (${fmt(gap(u,tgt))} > ${fmt(abReach(u,a,tgt))})`);
      say(t, `${u.name} casts ${a.slot}${a.aoe&&targets.length>1?` (area, ${targets.length} targets)`:""}`);
      targets.forEach((x, i)=>{
        if (blocked(u,a,x,t)) return;
        const tps = a.spread > 0 && a.S.onHit ? dvOf(a.S, "tickspersecond", a.rank) : 0, cid=u.casts;
        if (tps > 0){
          // a channel of separate hits that apply on-hit effects (Katarina R: a dagger every 1/6 s, wiki 0.166 s; each dagger is
          // its own hit for runes and on-hit items, wiki Death Lotus notes): one event per hit, damage split evenly
          const n=Math.round(a.spread*tps), step=u.curStep ?? null, raw=a.parts.map(p=>p);
          simNotes.add(`${u.name} ${a.slot}: ${n} separate hits over ${fmt(a.spread)}s (one every ${fmt(1/tps)}s, the first at cast), each 1/${n} of the channel's damage`);
          for (let k=0;k<n;k++) events.push({at:t+k/tps, fn:(tt)=>{ if (!x.alive || !u.alive) return; if (a.channel && !u.script && !(u.chan && u.chan.id===cid)) return; const prev=u.curStep, b=u.dealt; u.curStep=step;
            const hp0=x.hp; for (const p of raw) deal(u,x,partDmg(p,x)/n,p.type,tt,"ability",`${a.slot} hit ${k+1}/${n}`);
            if (k===0) abilityItems(u,x,tt,a,i===0);
            onHit(u,x,tt,"ability",a); abilityOnHit(u,x,tt,a,hp0);
            u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }});
        }
        else if (a.spread > 0){ a.parts.forEach((p,j) => x.dots.push({id:`${a.slot}-spread-${j}`, u, what:`${a.slot} over ${fmt(a.spread)}s`, dps:partDmg(p,x)/a.spread, type:p.type, until:t+a.spread, start:t, next:t+0.5, rampAfter:0, step:u.curStep ?? null, ability:a, abilityDot:true})); }
        else for (const p of a.parts) deal(u,x,partDmg(p,x),p.type,t,"ability",a.slot);
        say(t, `  ${a.slot} hits ${x.name}${x.alive?` → ${fmt(x.hp)}/${fmt(x.max)}`:""}`);
        if (a.hardcc){ x.impairedBy=u; x.impairedUntil=t+1; }
        applyCC(u,a,x,t,d0);
        if (tps > 0) return;
        abilityItems(u,x,t,a,i===0);
        onHit(u,x,t,"ability",a);
        abilityOnHit(u,x,t,a);
      });
    }
    if (!a.parts.length && (tgt || (a.p && a.p.delivery==="self")) && (a.immob || a.slows || (a.cc && a.cc.length))){ say(t, `${u.name} casts ${a.slot}`); a.saidAt=t;
      for (const x of hitList(u,a,tgt,t)){ if (blocked(u,a,x,t)) continue; if (a.hardcc){ x.impairedBy=u; x.impairedUntil=t+1; } ccItems(u,x,t,a); applyCC(u,a,x,t,d0); } }
    else if (!a.parts.length && !a.heal && !a.shield) say(t, `${u.name} casts ${a.slot}`);
    if (km && km.afterCast) km.afterCast(u, a, ktg, t);
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
      case "redemption": { go(cdOf(90)); const h=itemCalc(u.st,k,"healamount"); events.push({at:t+2.5, fn:(tt)=>{ for (const x of alliesOf(u)) heal(u,x,h,tt,"Redemption"); for (const x of enemiesOf(u,tt)) deal(u,x,idv("redemption","DamageToChampions",0.1)*x.max,"true",tt,"proc","Redemption"); }}); return true; }
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
  // Yasuo / Yone Steel Tempest / Mortal Steel: a hit gives a Gathering Storm stack (6 s, max 2); the cast at 2 stacks is the
  // empowered third cast, the only one that knocks up (wiki). onCast: before the hit (choose the crowd control); after: stack.
  function kitGatheringStorm(u, a, t, after){ const K=u.kit, G=K.storm && K.storm.until>t ? K.storm : {n:0};
    if (!after){ a.ccAll ??= a.cc||[]; K.q3 = G.n>=2; a.cc = K.q3 ? a.ccAll : a.ccAll.filter(e=>!AIRBORNE.has(e.type)); if (K.q3) K.storm=null;
      simNotes.add(`${u.name} Q: two hits give Gathering Storm; only the third, empowered cast knocks up (wiki)`); return; }
    if (!K.q3) K.storm={n:Math.min(2, G.n+1), until:t+(dvOf(a.S,"gatheringstormduration",a.rank)||dvOf(a.S,"buffduration",a.rank)||6)}; }
  const kitAirborne = (u, t) => enemiesOf(u,t).some(x=>(x.ccs||[]).some(c=>c.until>t && AIRBORNE.has(c.type)));
  // a kit part dealt later (recasts, delayed explosions, ticks), counted on the step that started it
  function kitLater(u, x, at, p, what){ const step=u.curStep ?? null;
    events.push({at, fn:(tt)=>{ if (!x.alive || !u.alive) return; const prev=u.curStep, b=u.dealt; u.curStep=step;
      deal(u,x,partDmg({...p, pct:!!p.pctOf},x),p.type,tt,"ability",what);
      if (u.c.champ==="Smolder") kitSmolderExecute(u, x, tt);
      u.curStep=prev; if (step!=null && u.stepLog[step]) u.stepLog[step].dmg += u.dealt-b; }}); }
  const kitShadowsAt = (u, t) => (u.kit.shadows||[]).filter(s=>s.until>t);
  // Kai'Sa Plasma (wiki Second Skin; game data P): each application deals base + per existing stack (up to 4); the 5th stack ruptures
  function kitPlasma(u, x, t, k){ if (!x.alive) return; const P=CALC.champs.Kaisa.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
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
  // champion-specific mechanics that live in scripts, not in the formula data
  const CHAMP_MECH = {
    Katarina: { onTakedown(u, x, t){   // Voracity: a champion takedown within 3 s of damaging them cuts current cooldowns by 15 s (wiki)
      if (x.dummy) return; for (const s of ["Q","W","E","R"]) if ((u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-15); say(t, `  ${u.name}: Voracity −15 s on every cooldown`); },
      onPassiveStep(u, t){   // picking up a Dagger cuts Shunpo's cooldown (tooltip: daggercooldownreduction)
      const S=CALC.champs.Katarina.E; if (!S || !S.calcs.daggercooldownreduction) return;
      const v=evalCalc({S, rank:rankOf(u.c,"E"), st:u.st, flags:new Set()}, "daggercooldownreduction").v;
      if ((u.cd.E||0) > t){ u.cd.E=Math.max(t, u.cd.E - v); say(t, `  dagger picked up: Shunpo cooldown −${fmt(v)}s`); }
      simNotes.add("Katarina: picking up a Dagger (P step) reduces Shunpo's cooldown by the tooltip's daggercooldownreduction");
    } },
    /* ---- champion audit (backlog 10): own-ability mechanics in fights; static numbers live in KIT ---- */
    Syndra: {
      onCast(u, a, tgt, t){ const K=u.kit, n=kitStacks(u.c), P=CALC.champs.Syndra.P;
        if (a.slot==="Q"){
          K.spheres=(K.spheres||[]).filter(s=>s.until>t); K.spheres.push({from:t+0.6, until:t+0.6+(dvOf(a.S,"sphereduration",a.rank)||6)});
          if (n >= (dvOf(P,"q1upgradethreshold",1)||40)){   // Transcendent: Dark Sphere holds 2 charges; recharge = its cooldown, 1.25 s between casts (wiki Dark Sphere)
            const cd=abCd(u,a), max=dvOf(a.S,"upgrade1maxammo",a.rank)||2, A=K.ammo ||= {n:max, at:null};
            while (A.at!=null && t>=A.at-1e-9){ A.n++; A.at = A.n<max ? A.at+cd : null; }
            A.n--; if (A.at==null) A.at=t+cd;
            u.cd.Q = A.n>0 ? t+1.25 : A.at;
            simNotes.add(`${u.name} Q: ${fmt(n)} Splinters of Wrath (≥ 40): ${max} charges, one every ${fmt(cd)}s, 1.25 s between casts (wiki Dark Sphere)`); } }
        if (a.slot==="R"){ const used=3+Math.min(4, (K.spheres||[]).filter(s=>s.from<=t && s.until>t).length);
          K.spheres=[]; for (let i=0;i<used;i++) K.spheres.push({from:t, until:t+6});    // the spheres stay on the ground for 6 s (wiki)
          simNotes.add(`${u.name} R: 3 conjured spheres plus the live Dark Spheres (up to 4) from earlier Q casts in this fight`); } },
      afterCast(u, a, tgt, t){
        if (a.slot==="R" && tgt && tgt.alive && kitStacks(u.c) >= (dvOf(CALC.champs.Syndra.P,"rupgradethreshold",1)||100) && tgt.hp < (dvOf(a.S,"upgradeexecutethreshold",a.rank)||0.15)*tgt.max){
          say(t, `  ${u.name}: Unleashed Power executes ${tgt.name} (below 15% health, 100+ Splinters)`); deal(u,tgt,tgt.hp,"true",t,"proc","Unleashed Power execute"); } },
    },
    Viktor: {
      onCast(u, a, tgt, t){ const L=a.later||[];
        if (a.slot==="Q"){ const d=L.find(p=>p.later==="attack"); if (d){ u.kit.discharge={until:t+4, v:d.v}; simNotes.add(`${u.name} Q: Discharge makes the next attack within 4 s deal ${fmt(d.v)} magic damage instead of its physical damage`); } }
        if (a.slot==="E" && tgt){ const d=L.find(p=>p.later==="delay"); if (d) kitLater(u, tgt, t+(dvOf(a.S,"delay",a.rank)||1), d, "E Aftershock"); }
        if (a.slot==="R" && tgt){ const d=L.find(p=>p.later==="ticks"); if (d){ const n=Math.round(d.v/d.per); for (let i=1;i<=n;i++) kitLater(u, tgt, t+i, {...d, v:d.per}, `R storm ${i}/${n}`);
          simNotes.add(`${u.name} R: the storm follows its target and strikes once a second, ${n} times after the initial burst (assumed: the target stays in it)`); } } },
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
      onHit(u, x, t, o){ if (o.basic && o.primary){ kitPlasma(u, x, t, 1); if ((u.cd.E||0)>t) u.cd.E=Math.max(t, u.cd.E-0.5); } },   // Supercharge: −0.5 s per attack (wiki)
      onCast(u, a, tgt, t){
        if (a.slot==="E"){ const as=[0.4,0.5,0.6,0.7,0.8][a.rank-1]||0.4;   // wiki Supercharge 40–80% (not in the exported game data)
          addBuff(u,"kaisaE",t+4,{bonusAS:as},t); simNotes.add(`${u.name} E: +${fmt(as*100)}% attack speed for 4 s at once (the charge-up cast time is not waited for; wiki value, one source)`); }
        if (a.slot==="R") u.nextAA=Math.min(u.nextAA,t);
        if (a.slot==="Q") simNotes.add(`${u.name} Q: every missile hits the one target (${kitEvolved(u.c,u.st).includes("Q")?12:6}; first full, the rest 25%)`); },
      afterCast(u, a, tgt, t){ if (a.slot==="W" && tgt && tgt.alive){ const ev=kitEvolved(u.c,u.st).includes("W"); kitPlasma(u, tgt, t, ev?3:2);
        if (ev && (u.cd.W||0)>t) u.cd.W = t+(u.cd.W-t)*0.25; } },
    },
    Smolder: {
      onCast(u, a, tgt, t){
        if (a.slot==="Q" && tgt){ const b=(a.later||[]).find(p=>p.later==="burn"); if (b){ for (let i=1;i<=3;i++) kitLater(u, tgt, t+i, {...b, v:b.v/3}, `Q burn ${i}/3`); tgt.kitBurnBy=u; tgt.kitBurnUntil=t+3;
          simNotes.add(`${u.name} Q: 225+ stacks: the burn (true damage, maximum health) over 3 s in 3 ticks, and the 6.5% execute while it burns`); } } },
      afterCast(u, a, tgt, t){ kitSmolderExecute(u, tgt, t); },
    },
    Ezreal: {
      onCast(u, a, tgt, t){ if (a.slot==="W" && tgt){ const m=(a.later||[]).find(p=>p.later==="mark"); if (m){ tgt.ezMark={by:u, until:t+(dvOf(a.S,"detonationtimeout",a.rank)||4), v:m.v};
        simNotes.add(`${u.name} W: the mark is detonated by the next attack or ability hit within 4 s`); } } },
      afterCast(u, a, tgt, t){ if (!tgt) return;
        kitEzP(u, t);
        if (a.slot!=="W") kitEzDetonate(u, tgt, t);
        if (a.slot==="Q"){ const cut=dvOf(a.S,"cdrefund",a.rank)||1.5; for (const s of ["Q","W","E","R"]) if ((u.cd[s]||0)>t) u.cd[s]=Math.max(t, u.cd[s]-cut);
          simNotes.add(`${u.name} Q: a hit cuts every current cooldown by ${fmt(cut)} s`); } },
      onHit(u, x, t, o){ if (o.basic && o.primary) kitEzDetonate(u, x, t); },
    },
    Yone: {
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
      castable:(u, a, tgt, t)=>a.slot!=="R" || kitAirborne(u, t) ? true : "Last Breath needs an airborne enemy champion",
      step(u, step, tgt, t, log){ if (step!=="R" || !u.abAll.R || (u.cd.R||0)>t) return false; const why=CHAMP_MECH.Yasuo.castable(u,u.abAll.R,tgt,t); if (why===true) return false; log({skipped:why}); return "logged"; },
      onCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t); },
      afterCast(u, a, tgt, t){ if (a.slot==="Q") kitGatheringStorm(u, a, t, true); },
      onHurt(u, att, v, type, t){ if (!u.kit.flowSpent && att && !att.dummy && v>0){ u.kit.flowSpent=true;
        const s=evalCalc({S:CALC.champs.Yasuo.P, rank:1, st:u.st, flags:u.flags},"shieldvalue").v; u.shieldDone+=addShield(u, s, 1, t, {id:"flow"}); say(t, `  ${u.name}: Resolve shield ${fmt(s)} (1 s)`);
        simNotes.add(`${u.name}: starts with full Flow; the first champion damage taken triggers the Resolve shield (no Flow regained: nobody moves in fight())`); } },
    },
    Samira: {
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
      onCast(u, a, tgt, t){ const K=u.kit;
        if (a.slot==="W"){ K.shadows=kitShadowsAt(u,t).filter(s=>s.src!=="W"); K.shadows.push({src:"W", until:t+(dvOf(a.S,"shadowduration",a.rank)||5.25)}); }
        if (a.slot==="Q" && kitShadowsAt(u,t).length) simNotes.add(`${u.name} Q: each live shadow throws a shuriken too; each deals full damage to the target (wiki: mimicked casts are separate)`);
        if (a.slot==="R"){ K.shadows=kitShadowsAt(u,t).filter(s=>s.src!=="R"); K.shadows.push({src:"R", until:t+9});
          const m=(a.later||[]).find(p=>p.later==="mark"); if (tgt && m){ const M={u, until:t+(dvOf(a.S,"rdeathmarkduration",a.rank)||3), stored:0, amp:dvOf(a.S,"rdamageamp",a.rank)||0.25, step:u.curStep}; tgt.zedMark=M;
            events.push({at:M.until, fn:(tt)=>{ if (!tgt.alive || !u.alive) return; tgt.zedMark=null; const b=u.dealt, prev=u.curStep; u.curStep=M.step;
              deal(u,tgt,m.v + M.amp*M.stored,"physical",tt,"ability",`Death Mark (${fmt(M.amp*100)}% of ${fmt(M.stored)} stored)`);
              u.curStep=prev; if (M.step!=null && u.stepLog[M.step]) u.stepLog[M.step].dmg += u.dealt-b; }});
            simNotes.add(`${u.name} R: the mark lands at cast (the 0.95 s dash is not simulated) and detonates 3 s later for 100% AD plus ${fmt(M.amp*100)}% of the physical and magic damage (before mitigation) Zed dealt meanwhile`); } } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && tgt && (u.cd.W||0)>t) u.cd.W=Math.max(t, u.cd.W-(dvOf(a.S,"shadowhitcdr",a.rank)||3)); },
      onDealt(att, tgt, v, pre, type, t){ const M=tgt.zedMark; if (M && M.u===att && t<M.until && (type==="physical"||type==="magic")) M.stored+=pre; },
    },
    Akali: {
      afterCast(u, a, tgt, t){ if (!tgt || !a.parts.length) return; const P=u.kit.akaliP; if (P && P.until>t) return;
        u.kit.akaliP={until:t+4}; simNotes.add(`${u.name}: an ability hit creates the ring; the next attack is Swinging Kama (assumed: she steps out of the ring at once)`);
        if (a.slot==="R"){ const r=(a.later||[]).find(p=>p.later==="recast"); if (r) kitLater(u, tgt, t+(dvOf(a.S,"cooldownbetweencasts",a.rank)||2.5), r, "R recast");
          simNotes.add(`${u.name} R: recast after the 2.5 s lockout, its damage raised by the target's missing health then`); } },
      attack(u, tgt, t){ const P=u.kit.akaliP; if (!P || !(P.until>t)) return null; u.kit.akaliP={until:t+0.01, used:true};
        const v=evalCalc({S:CALC.champs.Akali.P, rank:1, st:u.st, flags:u.flags},"damage").v; return {bonus:[{v, type:"magic", what:"Swinging Kama"}]}; },
    },
    Caitlyn: {
      attack(u, tgt, t){ const K=u.kit, P=CALC.champs.Caitlyn.P, ctx={S:P, rank:1, st:u.st, flags:u.flags};
        K.caitFree=(K.caitFree||[]).filter(f=>f.until>t); const free=K.caitFree.filter(f=>!(f.from>t)).sort((a,b)=>b.w-a.w)[0] || null;
        if (!free){ K.count=(K.count||0); if (K.count < (dvOf(P,"attacksperheadshot",1)||5)){ K.count++; return null; } K.count=0; }
        else K.caitFree=K.caitFree.filter(f=>f!==free);
        const v=evalCalc(ctx,"headshotbonusdamage").v + (free && free.w ? free.w : 0);
        simNotes.add(`${u.name}: every 6th attack is a Headshot (5 stacks, then the Headshot); a trap or net hit grants one more`);
        return {bonus:[{v, type:"physical", what:`Headshot${free && free.w ? " (trap)" : free ? " (net)" : ""}`}]}; },
      onCast(u, a, tgt, t){ if (a.slot==="W" && tgt){ const m=(a.later||[]).find(p=>p.later==="headshot"); u.kit.caitFree=(u.kit.caitFree||[]).filter(f=>f.src!=="W").concat([{src:"W", from:t+1, until:t+1+1.8, w:m?m.v:0}]);
          simNotes.add(`${u.name} W: the trap is placed under the target, arms after 1 s and grants a Headshot with its bonus for 1.8 s (wiki Headshot)`); } },
      afterCast(u, a, tgt, t){ if (a.slot==="E" && tgt) u.kit.caitFree=(u.kit.caitFree||[]).filter(f=>f.src!=="E").concat([{src:"E", from:t, until:t+1.8, w:0}]); },
    },
    // (Death Lotus daggers: separate hits with on-hit effects, handled generically in cast() from S.onHit)
  };
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
    { const km=CHAMP_MECH[u.c.champ], h=km && km.step ? km.step(u, step, tgt, t, log) : false; if (h){ if (h!=="logged") log({}); u.si++; return; } }   // champion kits: recasts, gates
    const a=u.abAll[step];
    if (!a){ log({skipped: step==="P" ? "this passive has no damage formula in the game data" : "not learned or no data"}); u.si++; return; }
    if (a.passiveOnly){ log({skipped:"passive, toggle or ammo ability (cooldown 0 in the data)"}); u.si++; return; }
    if (t < (u.cd[step]||0)){ if (u.scriptWait) return; log({skipped:"on cooldown"}); u.si++; return; }
    if (a.isPassive){
      refresh(u,t); abNums(u,a);
      const hp0=tgt.hp; for (const p of a.parts) deal(u,tgt,partDmg(p,tgt),p.type,t,"passive","passive");
      onHit(u,tgt,t,"passive"); abilityOnHit(u,tgt,t,a,hp0);
      const mech = CHAMP_MECH[u.c.champ]; if (mech && mech.onPassiveStep) mech.onPassiveStep(u, t);
      log({}); u.si++; return; }
    u.curStep = u.stepLog.length;
    cast(u, a, a.parts.length || a.immob || a.slows ? tgt : null, t); log(a.spread > 0 ? {spread:a.spread} : {}); u.curStep = null; u.si++;
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
    const took=u.c.summoners; if (!took || !took.length || u.script || u.dummy) return;
    if ((took.includes("heal")||took.includes("barrier")) && pct(u)<0.3){ for (const k of ["barrier","heal"]) if (took.includes(k) && useSummoner(u,k,null,t)) break; }
    if (u.passive || u.champCombatAt==null) return;
    const foes=enemiesOf(u,t); if (!foes.length) return;
    let tgt = u.target ? foes.find(x=>sameChamp(x,u.target)) : null; if (!tgt) tgt = foes.slice().sort((a,b)=>a.hp-b.hp)[0];
    for (const k of ["exhaust","ignite"]) if (took.includes(k)) useSummoner(u,k,k==="exhaust" ? foes.slice().sort((a,b)=>(b.st.ad+b.st.ap)-(a.st.ad+a.st.ap))[0] : tgt,t);
    simNotes.add(`${u.name} uses its summoner spells in fights: Ignite and Exhaust on first contact (Exhaust on the enemy with the most AD + AP), Heal and Barrier below 30% health`);
  }
  const DAMAGE_ACTIVES = ["hextechrocketbelt","hextechgunblade","profanehydra","ravenoushydra","tiamat","stridebreaker","titanichydra","actualizer"];
  function act(u, t){
    if (locked(u,t)){ forcedAct(u,t); return; }
    if (u.script) return runScript(u, t);
    const cc = canCast(u,t), role=roleOf(u);
    // support abilities first: heals and shields that are needed now (spell shields are raised when an ability lands)
    if (cc) for (const s of order(u)){ const a=u.ab[s]; if (!a || t<(u.cd[s]||0) || a.parts.length || a.spellShield!=null || !(a.heal||a.shield)) continue; if (supportTargets(u,a,t,false)){ cast(u,a,null,t); return; } }
    if (u.passive) return;
    const foes=enemiesOf(u,t); if (!foes.length) return;
    const tgt = pickTarget(u, foes, role, t);
    for (const k of DAMAGE_ACTIVES) if (has(u,k) && ready(u,"active:"+k,t) && gap(u,tgt)<=Math.max(aaReach(u,tgt), 450)) useActive(u,k,tgt,t);
    // peel: hard crowd control on an enemy that is diving an ally who outranges it (kite and peel roles)
    if (cc && role!=="engage"){ const th=threat(u,t);
      if (th) for (const s of order(u)){ const a=u.ab[s]; if (!a || !(role==="kite"||role==="peel" ? a.hard : a.knock) || t<(u.cd[s]||0) || a.spellShield!=null || (a.dash && role==="kite")) continue;
        if (inReach(u,a,th) || a.p.delivery==="self" && gap(u,th)<=abReach(u,a,th)){ say(t, `${u.name} peels ${th.name} off ${th.victim===u?"itself":th.victim.name} with ${a.slot}`); a.peeling=true; cast(u,a,th,t); a.peeling=false; return; } } }
    // escape: a kiting unit dashes or blinks away from a shorter-ranged enemy inside its attack range
    if (cc && role==="kite" && canDash(u,t)){ const e=chaser(u,t); if (e && gap(u,e)<=aaReach(e,u)+50)
      for (const s of order(u)){ const a=u.ab[s]; if (!a || !a.dash || t<(u.cd[s]||0)) continue; cast(u,a,tgt,t,{away:e}); return; } }
    // offensive abilities in reach (dashes also close the gap)
    if (cc) for (const s of order(u)){ const a=u.ab[s]; if (!a || t<(u.cd[s]||0) || a.spellShield!=null) continue;
      { const km=CHAMP_MECH[u.c.champ]; if (km && km.castable && km.castable(u,a,tgt,t)!==true) continue; }   // champion kits: Yasuo R needs airborne, Samira R 6 Style
      if (!a.parts.length && !a.cc.length && !(a.later && a.later.length)) continue;
      if (!a.parts.length && (a.heal||a.shield) && !a.hard) continue;
      if (a.knock && role!=="engage") continue;                              // knockbacks are held for peel (role "engage" uses them at once)
      if (a.hard && role==="peel") continue;
      if (a.dash){ if (role==="kite" || !canDash(u,t)) continue;
        if (!a.di){ try { a.di=dashInfo(u.c, a.slot); } catch(err){ a.di={dist:0, time:0, castTime:0}; } }
        if (gap(u,tgt) <= a.di.dist + RAD(u) + RAD(tgt) + 1 || (inReach(u,a,tgt) && gap(u,tgt)<=aaReach(u,tgt))){ cast(u,a,tgt,t); return; }
        continue; }
      if (inReach(u,a,tgt)){ cast(u,a,tgt,t); return; }
    }
    if (t>=u.nextAA && canAttack(u,t) && gap(u,tgt)<=aaReach(u,tgt)+1e-6){ autoAttack(u,tgt,t); return; }
    moveAI(u, tgt, role, t);
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
      if ((has(u,"zhonyashourglass")||has(u,"seekersarmguard")) && pct(u)<0.3) useActive(u,has(u,"zhonyashourglass")?"zhonyashourglass":"seekersarmguard",null,t);
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
      if (t>=u.udAt){ u.udAt=t+idv("unendingdespair","Cooldown",4); let dealt=0; for (const f of enemiesOf(u,t)) dealt+=deal(u,f,itemCalc(u.st,"unendingdespair","draincalc"),"magic",t,"proc","Unending Despair");
        if (dealt>0) heal(u,u,idv("unendingdespair","HealMultiplier",2.5)*dealt,t,"Unending Despair"); } }
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
    if (has(u,"kaenicrookern")) itemsTick(u, 0);
    if (has(u,"knightsvow")){ const pool=alliesOf(u).filter(x=>x!==u); const p=u.policy&&typeof u.policy==="object" ? pool.find(x=>sameChamp(x,u.policy)) : null;
      const x=p || pool.sort((a,b)=>(b.st.ad+b.st.ap)-(a.st.ad+a.st.ap))[0]; if (x){ u.vowAlly=x; x.vowBy=u; say(0, `${u.name}: Knight's Vow on ${x.name}`); } }
  }
  let t=0, over=false;
  for (t=0; t<=T+1e-9 && !over; t=Math.round((t+dt)*1000)/1000){
    for (let i=events.length-1;i>=0;i--) if (events[i].at<=t){ const e=events.splice(i,1)[0]; e.fn(t); }
    for (const u of U){
      if (u.reviveAt>=0 && t>=u.reviveAt){ u.reviveAt=-1; u.hp=0.5*u.st.basehp; say(t, `${u.name} revives (Guardian Angel) at ${fmt(u.hp)} health`); }
      for (const d of u.dots){ while (u.alive && d.next<=t && d.next<=d.until+1e-9){ const m = d.rampAfter && d.next-d.start>d.rampAfter ? 1.75 : 1;
        const got=deal(d.u,u,d.dps*0.5*m,d.type||"magic",d.next,d.abilityDot?"abilitydot":"dot",null); if (d.step!=null && d.u.stepLog[d.step]) d.u.stepLog[d.step].dmg += got;
        if (d.abilityDot && /-0$/.test(d.id)){ const mech=CHAMP_MECH[d.u.c.champ]; if (mech && mech.spreadOnHit){ const b=d.u.dealt; mech.spreadOnHit(d.u,u,d,d.next); if (d.step!=null && d.u.stepLog[d.step]) d.u.stepLog[d.step].dmg += d.u.dealt-b; } }
        d.next+=0.5; } }
      u.dots=u.dots.filter(d=>d.next<=d.until+1e-9);
      u.shields=u.shields.filter(s=>s.until>=t && shieldLeft(s,t)>0.01);
    }
    for (const u of U){ if (!u.alive) continue; refresh(u,t); stepMove(u,t); if (t<u.stasisUntil) continue; itemsTick(u,t); summonersTick(u,t); if (locked(u,t)) u.lockTime=(u.lockTime||0)+dt; if (t>=u.nextAct || locked(u,t)) act(u,t); }
    const aliveBy=[0,1].map(s=>U.some(x=>x.side===s && (x.alive || x.reviveAt>=0)));
    if (!aliveBy[0] || !aliveBy[1]) over=true;
    // scripted combos end once every script has finished and nothing is still burning or pending
    const scripted=U.filter(u=>u.script);
    if (scripted.length && scripted.every(u=>u.si>=u.script.length) && !events.length && U.every(u=>!u.dots.length)) over=true;
  }
  const end=Math.min(T, t);
  TR=saved;
  return {t:"fight", units:U, end, T, log};
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
  for (const u of f.units) lines.push(`  ${u.side===0?"side 1":"side 2"} · ${u.name}: ${u.alive?`${fmt(Math.max(0,u.hp))}/${fmt(u.max)} health`:`died at ${fmt(u.deathAt)}s`} · dealt ${fmt(u.dealt)} · healed ${fmt(u.healDone)}${u.shieldDone?` · shielded ${fmt(u.shieldDone)}`:""}`);
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
      for (let l=2;l<=L;l++){ const bp=bps.find(x=>x.mLevel===l); if(bp){ v+=bp.mAdditionalBonusAtThisLevel||0; if(bp.mBonusPerLevelAtAndAfter!=null) per=bp.mBonusPerLevelAtAndAfter; } v+=per; }
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
  let r=R*(1-pct); r = R>0 ? Math.max(0, r-flat) : r;
  const mult = r>=0 ? 100/(100+r) : 2-100/(100-r);
  return {v:v*mult, s:`${magic?"MR":"armor"} ${fmt(R)}${pct||flat?` → ${fmt(r)} after pen`:""} → ×${mult.toFixed(3)}`};
}
function line(s){ if (TR) TR.lines.push(s); }
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
      sim:(u)=>({spheres: 3 + Math.min(4, (u.kit.spheres||[]).filter(s=>s.from<=u.kitT && s.until>u.kitT).length)}),
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
        return r; }},
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
    statsFinal:(c, st, notes, e)=>kitIntent(c, st, notes, e, CALC.champs.Yone.P),
    P: {none:"Way of the Hunter has no damage formula; every second attack deals half magic damage in fight()/perform()"},
    Q: {cd:(x)=>kitAsCd(x, 4, dvOf(x.S,"qattackspeedcdpercent",1)??0.6, dvOf(x.S,"qattackspeedcdmax",1)??0.667),
      parts(x){ return [kitCrit(x, "qdamage", "totaldamagecrit", "physical")]; }},
    W: {cd:(x)=>kitAsCd(x, 14, dvOf(x.S,"wattackspeedcdpercent",1)??0.6, dvOf(x.S,"wattackspeedcdmax",1)??0.571)},
  },
  Yasuo: {
    statsFinal:(c, st, notes, e)=>kitIntent(c, st, notes, e, CALC.champs.Yasuo.P),
    P: {none:"Way of the Wanderer has no damage; its Flow shield is modelled in fight()/perform()"},
    Q: {cd:(x)=>kitAsCd(x, 4, 0.6, 0.667), parts(x){ return [kitCrit(x, "totaldamage", "totaldamagecrit", "physical")]; }},
    E: {opts:{stacks:{min:0, max:4, dflt:0, what:"Ride the Wind stacks before this dash (+25% each; from other targets)"}},
      simCd:(x)=>x.dv("pertargetcooldown"),
      parts(x){ const p=x.part("totaldamage","magic"), n=x.o.stacks; return [n ? {...p, v:p.v*(1+0.25*n), s:`(${p.s}) × (1 + 0.25 × ${n} stacks)`} : p]; }},
  },
  Samira: {
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
    W: {parts(x){ return [{...x.part("headshotbonusdamage","physical"), label:"added to the Headshot on a trapped champion", later:"headshot"}]; }},
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
};
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
const kitShadows = u => (u.kit.shadows||[]).filter(s=>s.until>u.kitT);
/* .damage for a kit ability: its parts (raw), each mitigated separately against vs:. %-health parts need vs:. */
function kitDamage(c, slot, vs, opt){
  const spec=kitSpec(c, slot), st=stats(c), rank=rankOf(c, slot), who=`${label(c)}.${slot}`;
  if (spec.none) throw new Error(`${who}: ${spec.none}`);
  if (rank===0){ line(`${who}: not learned at level ${c.level} → 0`); return 0; }
  const x=kitCtx(c, slot, rank, st, null, kitOptions(spec, opt, c, slot, st, rank), null);
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
  if (f==="cost"){ const v=(S.cost||[])[rank]??0; line(`${who}.cost = ${fmt(v)}`); return v; }
  if (f==="range"){ const v=(S.range||[])[Math.max(1,rank)]??0; line(`${who}.range = ${fmt(v)}${S.minRange?" (fully charged)":""}`); return v; }
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
function physOf(c, slot){
  const S=CALC.champs[c.champ][slot]||{}, w=WORLD.champ(c.champ), sl=w.slots[slot]||{tags:{}};
  const p={speed:0, castTime:0.25, delay:0, ...(S.phys||{})};
  const rank=Math.max(1, c.ranks[slot] ?? 1);
  p.range = sl.range && sl.range.length ? (sl.range[rank-1] ?? sl.range[0]) : 0;
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
  return `${who}: ${DELIVERIES[p.delivery]||p.delivery} (${p.kind}), range ${fmt(p.range)}${p.minRange?` (charged from ${fmt(p.minRange)} over ${fmt(p.chargeTime)}s)`:""}${p.delivery==="vector"&&p.length?` + ${fmt(p.length)} length`:""}${p.delivery==="remote"?`, from ${p.origin||"another object"}`:""}, cast time ${fmt(p.castTime)}s${p.speed?`, speed ${fmt(p.speed)}/s${p.accel?` accelerating to ${fmt(p.maxSpeed||p.minSpeed)}`:""}`:""}${p.halfWidth?`, width ${fmt(2*p.halfWidth)}`:""}${p.kind!=="line"&&p.radius?`, radius ${fmt(p.radius)}`:""}${p.delay?`, delay ${fmt(p.delay)}s`:""}`;
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
function arrivalTime(c, slot, d, p0){
  const p=p0||physOf(c, slot);
  // appear-delays (ground, arm, effect, launch) start once the missile, if any, has landed
  const travel = travelDist(p, d), tr = travelTime(p, travel);
  const t = p.castTime + tr + (p.delay||0);
  line(`${describePhys(`${label(c)}.${slot}`, p)}`);
  line(`  ${deliveryLine(c, p, d, tr, travel)}`);
  const how = !p.speed || !travel ? "" : p.accel ? ` + ${fmt(tr)}s travel (accelerating ${fmt(p.speed)}→${fmt(p.maxSpeed||p.minSpeed||p.speed)}, average ${fmt(travel/Math.max(tr,1e-9))}/s)` : ` + ${fmt(travel)}/${fmt(p.speed)} travel`;
  line(`  arrives at ${fmt(d)} units after ${fmt(p.castTime)}s cast${how}${p.delay?` + ${fmt(p.delay)}s ${p.delayKind==="missile_travel"?"flight time":p.delayKind==="arm"?"arming delay":p.delayKind==="channel"?"channel":"appear-delay"}`:""} = ${fmt(t)}s from the start of the cast`);
  delayNote(c, slot, p);
  const who=`${label(c)}.${slot}`;
  if (TR && p.deliveryNote) TR.notes.add(`${who} (${p.delivery}): ${p.deliveryNote}`);
  for (const [k,n] of [["radiusSource","radius"],["speedSource","speed"],["halfWidthSource","width"],["castTimeSource","cast time"]])
    if (TR && p[k]==="wiki") TR.notes.add(`${who}: ${n} is from the wiki, not the game files (override with setPhysics)`);
  if (TR && p.delivery==="placed" && !p.delay) TR.notes.add(`${who}: no appear-delay is known for this placed ability (counted as 0); set one with ${champName(c)}.${slot}.setPhysics(delay: …)`);
  return t;
}
/* When the defender can first see where it will land: the end of the cast (the missile or ground marker
   appears then) unless the data says the telegraph shows later (Rumble R) — setPhysics(reveal: seconds). */
function revealOf(p){ return p.revealAt ?? p.castTime; }
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
  const d=named.distance; if (typeof d!=="number") throw new Error("canDodge needs distance: (units between the two champions)");
  if (named.hitbox!=null && !(typeof named.hitbox==="number" && named.hitbox>=0)) throw new Error("hitbox: is the defender's gameplay radius in units, e.g. hitbox: 90");
  const react=named.reaction ?? 0, a=ab.owner, s=ab.slot, p=physOf(a,s), who=`${label(a)}.${s}`;
  const HB = named.hitbox ?? hitboxOf(def), hbFrom = named.hitbox!=null ? "set with hitbox:" : "game files: character record";
  if (TR){ TR.notes.add(`${label(def)}'s gameplay radius (hitbox) is ${fmt(HB)} units (${hbFrom}); the ability is aimed perfectly at the defender`);
    if (named.hitbox==null && SIZE_NOTES[def.champ]) TR.notes.add(`${label(def)}: size modifiers scale the hitbox (wiki "Size"): ${SIZE_NOTES[def.champ]}; test a bigger one with hitbox:`); }
  const selfArea = p.delivery==="self" && (p.radius || p.speed);
  const edge = p.kind==="line" ? (p.halfWidth||0) : p.kind==="cone" ? Math.min(p.coneLength||p.range, d)*Math.tan((p.coneAngle||30)*Math.PI/360) : (p.radius||0);
  const reach = reachOf(p) + HB;
  if (p.kind==="self" && !selfArea){ line(`${describePhys(who,p)}; it isn't a projectile or area ability, so dodging doesn't apply`); return false; }
  if (d > reach){ line(`${describePhys(who,p)}`); line(`  ${fmt(d)} units is beyond its reach (${fmt(reachOf(p))} + ${fmt(HB)} hitbox = ${fmt(reach)}): dodged by standing still`); return true; }
  const T = arrivalTime(a, s, d, p), reveal = Math.min(revealOf(p), T), win = T - reveal, avail = win - react;
  line(`  it becomes visible ${fmt(reveal)}s into the cast (${p.revealAt!=null?"when the first of it shows":"the end of the cast time: the aim can't be seen before"}) and lands ${fmt(win)}s later; ${label(def)} has ${fmt(win)}s − ${fmt(react)}s reaction = ${fmt(avail)}s to respond`);
  if (avail<=0){ line("  → hit: no time to respond"); return false; }
  const ds=stats(def), need = selfArea ? Math.max(0, (p.radius||reachOf(p)) + HB - d) : edge + HB;
  const needText = selfArea ? `${fmt(need)} units outward (${fmt(p.radius||reachOf(p))} radius + ${fmt(HB)} hitbox − ${fmt(d)} already between them)`
    : `${fmt(need)} units sideways (${fmt(edge)} ${p.kind==="line"?"half-width":p.kind==="cone"?"cone half-width here":"radius"} + ${fmt(HB)} hitbox)`;
  const walk=ds.ms*avail;
  if (p.kind!=="targeted"){
    line(`  must move ${needText}; walking at ${fmt(ds.ms)} covers ${fmt(walk)} (needs ${fmt(need/avail)} move speed)`);
    if (walk>=need){ line("  → dodged by walking"); return true; }
  } else line(`  ${who} is point-and-click: walking can't dodge it`);
  const Y=named.using;
  if (Y){
    const acts=(Y.t==="list" ? Y.items : [Y]).map(y=>dodgeAction(def, y, !!named.preBuff, ds));
    for (const x of acts) if (x.untarget){
      const ok = x.untarget.cast<=avail;
      line(`  ${x.label} makes ${label(def)} untargetable after ${fmt(x.untarget.cast)}s ${ok?"≤":">"} ${fmt(avail)}s`);
      if (ok){ line("  → dodged"); return true; }
    }
    if (p.kind!=="targeted"){
      for (const x of acts) line(`  ${x.text}`);
      const mv=acts.filter(x=>x.buff||x.dash);
      if (mv.length){
        // perfect play: the combination that moves the defender farthest (using nothing = walking, above)
        let best={dist:walk, plan:"walking only", top:ds.ms};
        for (let mask=1; mask<(1<<Math.min(mv.length,6)); mask++){
          const pick=mv.filter((_,i)=>mask&(1<<i)); let t=0, disp=0; const buffs=[];
          for (const x of pick) if (x.buff && !x.dash){ if (!x.buffPre) t+=x.buff.cast; buffs.push({spec:x.buff, start:x.buffPre?0:t}); }
          for (const x of pick) if (x.dash){ t+=x.dash.time; disp+=x.dash.dist; if (x.buff) buffs.push({spec:x.buff, start:t}); }
          if (t>avail+1e-9) continue;
          const w=walkWith(ds, buffs, t, avail); disp+=w.dist;
          if (disp>best.dist+1e-9) best={dist:disp, top:w.top, plan:pick.map(x=>x.short).join(" + "), still:pick.some(x=>x.buff && !x.buffPre && x.buff.cast>0), buffed:buffs.length>0};
        }
        line(`  best use: ${best.plan} → ${fmt(best.dist)} units in ${fmt(avail)}s${best.top>ds.ms+0.01?` (up to ${fmt(best.top)} move speed)`:""}; needs ${fmt(need)}`);
        if (TR && best.top>415) TR.notes.add(`move speed above 415 is soft-capped (×0.8 from 415, ×0.5 from 490)`);
        if (TR && acts.some(x=>x.buff && !x.buffPre && x.buff.cast>0)) TR.notes.add(`canDodge: ${label(def)} stands still while casting a speed boost; perfect play skips the boost when walking without it goes farther (set preBuff: true if it was cast before the ability appeared)`);
        if (best.dist>=need){ line(best.buffed ? "  → dodged by walking with the speed boost" : "  → dodged"); return true; }
      }
    }
  }
  line("  → hit"); return false;
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
function dodgeAction(def, y, preBuff, ds){
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
  if (!y || y.t!=="ability" || y.owner.champ!==def.champ) throw new Error("using: must be the defender's abilities or summoner spells, e.g. using: fizz.E, using: Flash or using: {orianna.W, Flash}");
  const tags=WORLD.champ(def.champ).slots[y.slot].tags, py=physOf(def, y.slot), lb=`${label(def)}.${y.slot}`, x={label:lb, short:lb, text:""}, bits=[];
  if (tags.untargetable!==undefined || tags.invuln!==undefined) x.untarget={cast:py.castTime};
  if (tags.dash!==undefined || tags.blink!==undefined){ const di=dashInfo(def, y.slot); x.dash={dist:di.dist, time:di.time, blink:di.blink}; bits.push(`${di.blink?"blinks":"dashes"} ${fmt(di.dist)} units in ${fmt(di.time)}s`); }
  if (py.msBuff){ x.buff=buffSpec(def, y.slot, py); x.buffPre = preBuff || x.buff.passive;
    if (x.buffPre && !x.buff.passive) x.short=`${lb} (pre-applied)`;
    bits.push(`${x.buff.desc}${x.buff.passive?" (passive, already active)":x.buffPre?" (pre-applied: active when the window opens)":` after its ${fmt(x.buff.cast)}s cast`}`);
    if (TR) TR.notes.add(x.buff.note); }
  if (!bits.length && !x.untarget) bits.push("has no dash, blink, untargetability or move-speed boost");
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
  return {unit: mb.unit==="flat" ? "flat" : "frac", cast: mb.passive ? 0 : Math.max(0, py.castTime||0), passive:!!mb.passive, mk, desc:`${amount}${shape}`,
    note:`${label(def)}.${slot}: move-speed boost from ${mb.source||"the game data"}${mb.condition?`; assumes ${mb.condition}`:""}`};
}
/* Distance walked from t0 to `avail` with boosts [{spec, start}] (flat bonuses add to base + item speed,
   % bonuses add to the item/rune %; then the soft caps). */
function walkWith(ds, buffs, t0, avail){
  const raw = ds.msraw || ds.basems || ds.ms, pct = ds.mspct ?? (ds.ms/raw - 1), fs=buffs.map(b=>({b, f:b.spec.mk()}));
  let dist=0, t=t0, top=ds.ms; const dt=0.005;
  while (t < avail-1e-9){ const h=Math.min(dt, avail-t); let flat=0, frac=0;
    for (const {b,f} of fs){ if (t<b.start-1e-9) continue; const v=f(t-b.start, dist); if (b.spec.unit==="flat") flat+=v; else frac+=v; }
    const sp = fs.length ? msCap((raw+flat)*(1+pct+frac)) : ds.ms; if (sp>top) top=sp; dist+=sp*h; t+=h; }
  return {dist, top};
}
function threatRange(c){
  const st=stats(c); let best=st.range, from="attack range";
  for (const s of ["Q","W","E","R"]){ const S=CALC.champs[c.champ][s]; if (!S || !(S.main)) continue; const p=physOf(c,s); const r=reachOf(p); if (r>best && r<5000){ best=r; from=`${s} reach (${p.delivery})`; } }
  line(`${label(c)}.threatRange = ${fmt(best)} (${from})`); return best;
}
function gapClose(c){
  let total=0; const parts=[];
  for (const s of ["Q","W","E","R"]){ const tags=WORLD.champ(c.champ).slots[s].tags; if (tags.dash===undefined && tags.blink===undefined) continue; if (!rankOf(c,s)) continue; const di=dashInfo(c,s); total+=di.dist; parts.push(`${s} ${fmt(di.dist)}`); }
  line(`${label(c)}.gapClose = ${parts.join(" + ")||"0"} = ${fmt(total)} units of dashes and blinks`); return total;
}
function closeGap(c, d){
  let left=d, t=0; const st=stats(c), steps=[];
  for (const s of ["Q","W","E","R"]){ if (left<=0) break; const tags=WORLD.champ(c.champ).slots[s].tags; if (tags.dash===undefined && tags.blink===undefined) continue; if (!rankOf(c,s)) continue;
    const di=dashInfo(c,s), used=Math.min(di.dist,left); t+=di.castTime + (di.blink?0:used/(di.dist/(di.time-di.castTime||1e-9))); left-=used; steps.push(`${s} ${fmt(used)}`); }
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
  if (!cands.length){ line(`${label(c)} has no ${tag} ability`); return NaN; }
  const vals=cands.map(s=>{ const sl=w.slots[s]; let arr=fld==="range"?sl.range:sl.cd; if(w.cdOver&&w.cdOver[s]&&fld!=="range") arr=[w.cdOver[s].v];
    if(!arr||!arr.length) return null; return {s, v: fld==="cdmax" ? arr[arr.length-1] : arr[0]}; }).filter(Boolean);
  if (!vals.length){ line(`${label(c)}'s ${tag} is a passive (no ${fld==="range"?"range":"cooldown"})`); return NaN; }
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
  if (v.t==="champ") return {...v, ranks:{...v.ranks}, items:[...v.items], runes:[...(v.runes||[])], opts:{...(v.opts||{})}};
  if (v.t==="set") return {t:"set", items:[...v.items]};
  if (v.t==="comp") return {t:"comp", champs:v.champs.map(copy)};
  if (v.t==="list") return {t:"list", items:v.items.map(copy)};
  return v;
}
function typeName(v){
  if (typeof v==="number") return "number"; if (typeof v==="boolean") return "bool"; if (typeof v==="string") return "string";
  return {champ:"Champion", ability:"Ability", item:"Item", set:"ItemSet", comp:"TeamComp", list:"list", tag:"tag", cls:"class", slot:"ability slot", fn:"function", builtin:"function", pred:"claim", rune:"Rune", fight:"Fight", combo:"Combo", comboresult:"ComboResult", summoner:"Summoner"}[v&&v.t] || "value";
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
  const add = x => { if (x && x.t==="slot") steps.push(x.name); else if (x && x.t==="combo") steps.push(...x.steps); else if (x && x.t==="list") x.items.forEach(add);
    else if (x && x.t==="summoner") steps.push(summName(x.key));
    else if (x && x.t==="item"){ if (!ITEM_ACTIVE_CD[x.key]) throw new Error(`${where}: ${ITEMS[x.key].name} has no active to press in a combo`); steps.push(ITEMS[x.key].name); }
    else throw new Error(`${where}: a combo holds abilities, AA and item actives, not ${typeName(x)}`); };
  add(v); return {t:"combo", steps};
}
function coerce(type, v, line){
  if (type==="Combo"){ try { return comboOf(v, "Combo"); } catch(e){ throw new LangError(e.message, line); } }
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
  const emit = it => { if (it.kind==="error" && quiet) it.msg = `in imported file: ${it.msg}`; if (!quiet || it.kind==="error") emitRaw(it); };
  const globals=new Env(null), funcs={}, rules=[];
  globals.def("defaultLevel", 11);
  globals.def("gameMinute", 20); GAME.minute = 20;
  for (const d of ast){ if (d.k==="func") funcs[d.name]=d; if (d.k==="rule") rules.push(d); }
  const preds=new Set(rules.map(r=>r.pred));
  let steps=0;
  const tick=(line)=>{ if(++steps>3e6) throw new LangError("the program ran too long (an endless loop?)", line); };

  function lookup(name, env, line){
    if (env.has(name)) return env.get(name);
    if (funcs[name]) return {t:"fn", decl:funcs[name]};
    if (preds.has(name)) return {t:"pred", name};
    if (BUILTINS[name]) return {t:"builtin", name, fn:BUILTINS[name]};
    if (/^[PQWER]$/.test(name) || name==="AA") return {t:"slot", name};
    if (CLASSES.includes(name)) return {t:"cls", name};
    if (TAGS.has(name)) return {t:"tag", name};
    if (SUMM_NAMES[name]) return {t:"summoner", key:SUMM_NAMES[name]};
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
        if (SUMM_NAMES[name]) return {t:"summoner", key:SUMM_NAMES[name], owner:c};
        if (name==="summoners") return {t:"list", items:(c.summoners||[]).map(k=>({t:"summoner", key:k, owner:c}))};
        if (name==="summonerHaste"){ const v=summonerHaste(c); line(`${label(c)}.summonerHaste = ${fmt(v)} (items' SummonerHaste data value; Cosmic Insight 18)`); return v; }
        if (c.dummy && ["with","stacks","perform","combo","proc","closeGap","addClass","removeClass","is","has","cdOf","cdmaxOf","rangeOf","threatRange","gapClose"].includes(name))
          throw new LangError(`the Target Dummy can't use .${name}: it has no items, runes or abilities and never attacks or moves. Use it as the target: x.Q.damage(vs: d), x.proc(Item, vs: d), x.perform(combo, vs: d)`, ln);
        if (c.dummy && name==="resists"){ line(`Target Dummy armor ${fmt(c.dummy.armor)}, MR ${fmt(c.dummy.mr)}`); if (c.dummy.armor!==c.dummy.mr) throw new LangError(`this dummy's armor (${fmt(c.dummy.armor)}) and MR (${fmt(c.dummy.mr)}) differ; read .armor and .mr`, ln); return c.dummy.armor; }
        if (["target","healPolicy","passive","rotation","souls","skillOrder","role"].includes(name)){ const o=c.opts||{}; const d={target:null, healPolicy:"lowest", passive:false, rotation:"RQEW", souls:0, skillOrder:"QEW", role:stats(c).ranged?"kite":"dive"}; return o[name] ?? d[name]; }
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
          combo: (args, named)=>{ if (args[0] && (args[0].t==="combo" || (args[0].t==="list" && args.length===1))) return perform(c, args[0], named).damage;
                   const vs=vsArg(named); let total=0; const vals=[]; const sl=args.map(a=>{ if(!a||a.t!=="slot") throw new Error("combo() takes abilities: Q, W, E, R, P"); return a.name; });
                   for (const s of sl){ let v; try { v=abilityValue(c, s, "damage", vs); } catch(err){ if(!/no damage formula|no data/.test(err.message)) throw err; v=0; if(TR) TR.notes.add(`${label(c)} ${s}: no damage formula, counted as 0 in combo()`); } total+=v; vals.push(fmt(v)); }
                   line(`${label(c)}.combo(${sl.join(",")})${vs?" vs "+label(vs):""} = ${vals.join(" + ")} = ${fmt(total)}`); return total; },
          proc: (args, named)=>{ const it=args[0]; if(!it||it.t!=="item") throw new Error("proc() takes an item, e.g. proc(Ludens)"); const I=ITEMS[it.key];
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
        const w=WORLD.champ(c.champ);
        if (name==="melee"){ const v=w.stats.melee===1; line(`${label(c)} attack range ${w.stats.range} → melee ${v}`); return v; }
        if (name in w.stats){ line(`${label(c)}.${name} = ${w.stats[name]}`); return w.stats[name]; }
        throw new LangError(`a Champion has no “${name}”.${hint(name, [...STATKEYS, ...Object.keys(methods), "Q","W","E","R","P","name","level","items","runes","classes","stacks","melee","threatRange","gapClose","hitbox","target","healPolicy","passive","rotation","souls","skillOrder","attack","defense","magic","difficulty"])} See “What a Champion can tell you” in the cheatsheet.`, ln);
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
          heal: (args,named)=>supportValue(c, s, "heal", named.target),
          shield: (args,named)=>supportValue(c, s, "shield", named.target),
          cd: ()=>abilityValue(c, s, "cd"), cdbase: ()=>abilityValue(c, s, "cdbase"),
          cost: ()=>abilityValue(c, s, "cost"), range: ()=>abilityValue(c, s, "range"),
          minRange: ()=>abilityValue(c, s, "minrange"), chargeTime: ()=>abilityValue(c, s, "chargetime"),
          value: (args,named)=>{ const v=abilityValue(c, s, String(args[0]), vsArg(named)); if (v===undefined) throw new Error(`${label(c)}.${s} has no value “${args[0]}”. It has: ${fieldsOf(S).join(", ")}`); return v; },
          has: (args)=>hasTag(c, tagArg(args[0]), s),
          addTag: (args)=>{ WORLD.addTag(c.champ, s, tagArg(args[0], true), ln, `${champName(c)}.${s}.addTag(${tagName(args[0])})`); return null; },
          removeTag: (args)=>{ WORLD.removeTag(c.champ, s, tagArg(args[0], true), ln, `${champName(c)}.${s}.removeTag(${tagName(args[0])})`); return null; },
          setPhysics: (args,named)=>{ const ok=["speed","width","radius","castTime","delay","dashSpeed","dashRange","kind","delivery","origin","originRange","length","reveal","reach"]; for (const k of Object.keys(named)) if (!ok.includes(k)) throw new Error(`setPhysics takes ${ok.join(", ")}`);
            if (named.delivery!=null && !Object.keys(DELIVERIES).includes(String(named.delivery))) throw new Error(`delivery is one of ${Object.keys(DELIVERIES).map(x=>`"${x}"`).join(", ")}`);
            if (named.origin!=null && typeof named.origin!=="number") throw new Error("origin: is a distance in units, from the object the ability comes from (e.g. Orianna's ball) to the target");
            WORLD.setPhys(c.champ, s, named, ln, `${champName(c)}.${s}.setPhysics(${Object.entries(named).map(([k,v])=>`${k}: ${show(v)}`).join(", ")})`); return null; },
          ccDuration: (args,named)=>{ const ty=String(args[0]||"").toLowerCase(), r=Math.max(1, rankOf(c,s)||1), cl=ccList(c, s, r), e=cl.list.find(e=>e.type===ty);
            if (!e){ line(`${label(c)}.${s} (rank ${r}) has no ${ty}${cl.list.length?` (it has ${cl.list.map(e=>e.type).join(", ")})`:""}`); return 0; }
            line(`${label(c)}.${s} (rank ${r}): ${ccDescribe(e)} — ${ccSrc(e)}`);
            const vs=vsArg(named); if (!vs) return e.dur;
            const ten=stats(vs).tenacity||0, d=ccDuration(e, ten);
            line(NO_TENACITY.has(e.type) ? `  vs ${label(vs)}: ${e.type} ignores tenacity → ${fmt(d)}s` : `  vs ${label(vs)}: ${fmt(e.dur)} × (1 − ${fmt(100*ten)}% tenacity) = ${fmt(d)}s${d>e.dur*(1-ten)+1e-9?" (floor 0.3s)":""}`);
            return d; },
          arrival: (args,named)=>{ if (typeof named.distance!=="number") throw new Error("arrival(distance: …)"); return arrivalTime(c, s, named.distance); },
          setDamageType: (args)=>{ const t=String(args[0]||"").toLowerCase(); if (!["magic","physical","true"].includes(t)) throw new Error(`setDamageType takes "magic", "physical" or "true"`);
            WORLD.setType(c.champ, s, t, ln, `${champName(c)}.${s}.setDamageType("${t}")`); return null; },
          setCooldown: (args)=>{ WORLD.setCd(c.champ, s, args[0], ln, `${champName(c)}.${s}.setCooldown(${args[0]})`); return null; },
        };
        if (methods[name]) return M(methods[name]);
        if (S){ const v=abilityValue(c, s, name, null); if (v!==undefined) return v; }
        { const opts=["damage","cd","cdbase","cost","range","minRange","chargeTime","rank","name","heal","shield","healTarget","shieldTarget","value","speed","width","radius","castTime","delay","kind","reach","delivery","length","origin","arrival","has","addTag","removeTag","setCooldown","setPhysics","setDamageType", ...(S?fieldsOf(S):[])];
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
      case "fight": {
        const f=obj;
        if (TR && !TR.seenFights) TR.seenFights=new Set();
        if (TR && !TR.seenFights.has(f)){ TR.seenFights.add(f); fightSummary(f).forEach(l=>TR.lines.push(l)); (f.notes||[]).forEach(n=>TR.notes.add(n)); }
        const U = x => { if (!x||x.t!=="champ") throw new Error(`expected a Champion from this fight`); const same=f.units.filter(u=>champKey(u.c)===champKey(x)); const u=same.find(u=>x.label && u.c.label===x.label) || same[0] || f.units.find(u=>u.c.champ===x.champ); if(!u) throw new Error(`${label(x)} wasn't in this fight`); return u; };
        const side = x => typeof x==="number" ? x-1 : (x&&x.t==="comp" ? f.units.find(u=>x.champs.some(c=>champKey(c)===champKey(u.c)))?.side : x&&x.t==="champ" ? U(x).side : null);
        const methods = {
          alive:(a)=>U(a[0]).alive, dead:(a)=>!U(a[0]).alive, hp:(a)=>Math.max(0,U(a[0]).hp), hpPercent:(a)=>Math.max(0,U(a[0]).hp)/U(a[0]).max,
          deathTime:(a)=>{ const u=U(a[0]); if (u.dummy) return u.wouldDieAt ?? Infinity; return u.alive?Infinity:u.deathAt; }, dealt:(a)=>U(a[0]).dealt, healed:(a)=>U(a[0]).healDone,
          shielded:(a)=>U(a[0]).shieldDone, received:(a)=>U(a[0]).healRecv, taken:(a)=>U(a[0]).taken,
          ccTime:(a)=>{ const u=U(a[0]), v=Math.round((u.lockTime||0)*1000)/1000; line(`${u.name} spent ${fmt(v)}s unable to act (stunned, airborne, suppressed, asleep or forced)`); return v; },
          blocks:(a)=>U(a[0]).blocks||0, position:(a)=>U(a[0]).x,
          distance:(a)=>{ const v=Math.abs(U(a[0]).x-U(a[1]).x); line(`distance ${U(a[0]).name} – ${U(a[1]).name} at the end: ${fmt(v)} units`); return v; },
          survivors:(a)=>{ const s=side(a[0]); if (s==null) throw new Error("survivors() takes 1, 2 or a TeamComp from the fight"); return f.units.filter(u=>u.side===s&&u.alive).length; },
          deaths:(a)=>{ const s=side(a[0]); return f.units.filter(u=>u.side===s&&!u.alive).length; },
          totalHealing:(a)=>{ const s=side(a[0]); return f.units.filter(u=>u.side===s).reduce((x,u)=>x+u.healDone+u.shieldDone,0); },
        };
        if (name==="winner"){ const a=f.units.some(u=>u.side===0&&u.alive), b=f.units.some(u=>u.side===1&&u.alive); return a&&!b?1:b&&!a?2:0; }
        if (name==="duration") return f.end;
        if (name==="log"){ return f.log.join("\n"); }
        if (methods[name]) return M(methods[name]);
        throw new LangError(`a Fight has: winner, duration, log, alive(x), dead(x), hp(x), hpPercent(x), deathTime(x), dealt(x), healed(x), shielded(x), received(x), taken(x), ccTime(x), blocks(x), position(x), distance(x, y), survivors(side), deaths(side), totalHealing(side)`, ln);
      }
      case "combo": {
        const methods = { size: ()=>obj.steps.length, add: (args)=>{ obj.steps.push(...comboOf({t:"list", items:args}, "add()").steps); return null; } };
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
          // total post-mitigation damage from one source (an item's "damage dealt" counter): hits whose label starts with it
          bySource: (a)=>{ const want=norm(String(a[0]??"")), hs=r.hits.filter(h=>norm(String(h.what)).startsWith(want));
            if (!want) throw new Error(`bySource("Kraken Slayer"): name a source. This result has: ${[...new Set(r.hits.map(h=>String(h.what).replace(/ \(×.*\)$| hit \d+\/\d+$/,"")))].join(", ")}`);
            const v=hs.reduce((s,h)=>s+h.v,0); line(`${a[0]}: ${hs.length} hits, ${fmt(v)} damage after resistances`); return v; },
        };
        if (cm[name]) return M(cm[name]);
        if (name==="hitCount") return r.hits.length;
        if (name==="floatingText") return floatingText(r);
        const v = {damage:r.damage, time:r.time, killed:r.killed, killTime:r.killTime, hpLeft:r.hpLeft, hpPercent:r.hpLeft/r.hpMax,
          dps:r.damage/Math.max(r.time,0.25), lingering:r.lingering, healed:r.healed, shielded:r.shielded, steps:r.steps.map(x=>`${x.step}${x.skipped?" (skipped)":` ${fmt(x.dmg)}`}`).join(", "), log:r.log.join("\n")}[name];
        if (v===undefined) throw new LangError(`a ComboResult has damage, time, killed, killTime, hpLeft, hpPercent, dps, lingering, healed, shielded, steps, log, floatingText, hitCount, hit(i), stepDamage(i), bySource("name")`, ln);
        if (TR && ["damage","time","killed","killTime","hpLeft","hpPercent","dps"].includes(name) && !(TR.seenFights ||= new Set()).has(r)){
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
          size: ()=>arr.length, add: (args)=>{ for(const a of args) arr.push(copy(a)); return null; }, push_back: (args)=>{ for(const a of args) arr.push(copy(a)); return null; },
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
    canKill:(a, named)=>{ const f=killFight(a, named, a[2]); const u=f.units[1]; return u.dummy ? u.wouldDieAt!=null : !u.alive; },
    timeToKill:(a, named)=>{ const f=killFight(a, named, named.within ?? 60); const u=f.units[1]; const dead = u.dummy ? u.wouldDieAt!=null : !u.alive;
      if (TR && !dead) TR.lines.push(`${u.name} survives the full ${fmt(named.within ?? 60)}s`); if (TR && u.dummy) TR.notes.add(`${u.name}: the dummy can't die; the time is when its damage taken reached its max health`); return !dead ? Infinity : u.dummy ? u.wouldDieAt : u.deathAt; },
  };
  function teamOf(v){ if (v&&v.t==="champ") return [v]; if (v&&v.t==="comp") return v.champs; if (v&&v.t==="list") return v.items; throw new Error(`a fight side is a Champion or TeamComp, not ${typeName(v)}`); }
  function perform(c, combo, named){
    if (combo && combo.t==="list") combo = comboOf(combo, "perform()");
    if (!combo || combo.t!=="combo") throw new Error("perform(combo, vs: target) takes a Combo, e.g. Combo q = {Q, AA, E, R};");
    const tgt=named.vs; if (!tgt || tgt.t!=="champ") throw new Error("perform needs vs: a target Champion");
    if (!combo.steps.length) throw new Error("the combo is empty");
    const att=copy(c); att._script=combo.steps.slice(); att._scriptWait = named.wait !== false; att.opts={...att.opts, target:null};
    const t2=copy(tgt); t2.opts={...t2.opts, passive: !named.fightBack};
    const helpers = named.healers ? teamOf(named.healers).map(h=>{ const x=copy(h); x.opts={...x.opts, passive:true}; return x; }) : [];
    if (named.distance!=null && !(typeof named.distance==="number" && named.distance>=0)) throw new Error("perform(…, distance: n): n is the units between the two champions' centres");
    // distance: puts the two champions that many units apart (centre to centre) for distance-based effects (Arcane Comet, Aftershock's radius);
    // the combo's steps still ignore range
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
      (TR.seenFights ||= new Set()).add(r);
      TR.lines.push(`${r.who} performs ${combo.steps.join(" → ")} on ${r.target}${named.wait===false?" (skipping abilities on cooldown)":""}`);
      for (const x of steps) TR.lines.push(`  ${x.t.toFixed(2)}s  ${x.step}${x.skipped?`: skipped (${x.skipped})`:`: ${fmt(x.dmg)}${x.spread?` (over ${fmt(x.spread)}s)`:""}`}`);
      if (r.lingering>0.5) TR.lines.push(`  after the last step (burns, delayed procs): ${fmt(r.lingering)}`);
      TR.lines.push(`  total ${fmt(r.damage)} in ${fmt(r.time)}s → ${r.target} ${r.killed?`dies at ${fmt(r.killTime)}s`:`left on ${fmt(r.hpLeft)}/${fmt(r.hpMax)}`}`);
      TR.notes.add(`perform(): ${r.target} ${named.fightBack?"fights back":"doesn't fight back (add fightBack: true)"}; abilities on cooldown are ${named.wait===false?"skipped":"waited for"}; every step hits`);
      notes.forEach(n=>{ if (!/fight\(\): attacks without a set target/.test(n)) TR.notes.add(n); });
    }
    return r;
  }
  function fightOpts(named){ const o={}; named=named||{};
    for (const k of Object.keys(named)) if (!["start","kite","room","formation","fightBack","healers","within"].includes(k)) throw new Error(`fight options are start: (distance between the two front lines, default 0), kite: (false = ranged units don't kite), room: (how far a unit can back off), formation: (false = everyone on the front line)`);
    if (named.formation!=null) o.formation=truthy(named.formation);
    if (named.start!=null){ if (typeof named.start!=="number" || named.start<0) throw new Error("start: is the distance between the two sides in units (0 or more)"); o.start=named.start; }
    if (named.kite!=null) o.kite=truthy(named.kite);
    if (named.room!=null){ if (typeof named.room!=="number" || named.room<0) throw new Error("room: is a distance in units"); o.room=named.room; }
    return o; }
  function runFight(sides, T, fo){
    if (!(T>0 && T<=120)) throw new Error("a fight lasts between 0 and 120 seconds");
    const notes=new Set(); const f=simulate(sides.map(s=>s.map(copy)), T, notes, fo||{}); f.notes=[...notes];
    if (fo && fo.start) notes.add(`fight(): the sides start ${fmt(fo.start)} units apart`), f.notes=[...notes];
    if (TR){ if (!TR.seenFights) TR.seenFights=new Set(); TR.seenFights.add(f); fightSummary(f).forEach(l=>TR.lines.push(l)); f.log.slice(0,40).forEach(l=>TR.lines.push("    "+l)); if (f.log.length>40) TR.lines.push(`    … ${f.log.length-40} more events (print(f.log) shows them all)`); notes.forEach(n=>TR.notes.add(n)); }
    return f;
  }
  function killFight(a, named, T){
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
      case "list": return {t:"list", items:e.items.map(x=>copy(evalE(x,env)))};
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
        if (typeof i!=="number" || i<0 || i>=arr.length) throw new LangError(`index ${fmt(i)} is out of range (size ${arr.length})`, e.line);
        return arr[Math.trunc(i)];
      }
      case "call": return call(e, env);
      case "un": { const v=evalE(e.e,env); if (e.op==="!") return !truthy(v); if (typeof v!=="number") throw new LangError(`can't negate a ${typeName(v)}`, e.line); return -v; }
      case "incr": { const old=evalE(e.e,env); if(typeof old!=="number") throw new LangError("++ and -- work on numbers", e.line); const nv=old+(e.op==="++"?1:-1); store(e.e, nv, env, e.line); return e.pre?nv:old; }
      case "assign": {
        let v=evalE(e.value, env);
        if (e.op!=="="){ const old=evalE(e.target, env); v=arith(e.op[0], old, v, e.line); }
        store(e.target, copy(v), env, e.line); return v;
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
    if (op==="+" && (typeof a==="string"||typeof b==="string")) return show(a)+show(b);
    if (op==="+" && a&&a.t==="set") return {t:"set", items:checkItemLimits([...a.items, ...toItems(b,"+")], "+")};
    if (op==="+" && a&&a.t==="comp"){ if(!b||b.t!=="champ") throw new LangError("add a Champion to a TeamComp", ln); return {t:"comp", champs:[...a.champs.map(copy), copy(b)]}; }
    if (op==="+" && a&&a.t==="combo"){ try { return {t:"combo", steps:[...a.steps, ...comboOf(b,"+").steps]}; } catch(e){ throw new LangError(e.message, ln); } }
    if (op==="+" && a&&a.t==="slot" && b&&(b.t==="slot"||b.t==="combo")) return {t:"combo", steps:[a.name, ...comboOf(b,"+").steps]};
    if (op==="+" && a&&a.t==="item") return {t:"set", items:checkItemLimits([a.key, ...toItems(b,"+")], "+")};
    if (typeof a!=="number"||typeof b!=="number") throw new LangError(`“${op}” needs numbers, not ${typeName(a)} and ${typeName(b)}`, ln);
    switch(op){ case "+": return a+b; case "-": return a-b; case "*": return a*b; case "/": return a/b; case "%": return a%b; }
    throw new LangError(`unknown operator ${op}`, ln);
  }
  function store(target, v, env, ln){
    if (target.k==="id"){ if(!env.has(target.name)) throw new LangError(`“${target.name}” is not declared; declare it first, e.g. auto ${target.name} = …;`, ln); const old=env.get(target.name); if (v && v.t==="champ") v.label = target.name; env.set(target.name, v); if (target.name==="defaultLevel") statMemo.clear(); if (target.name==="gameMinute"){ GAME.minute=v; statMemo.clear(); } return; }
    if (target.k==="member"){
      const obj=evalE(target.obj, env);
      if (obj&&obj.t==="champ" && ["target","healPolicy","passive","rotation","souls","skillOrder","role"].includes(target.name)){
        if (target.name==="role" && !["kite","dive","peel","engage","fight"].includes(v)) throw new LangError(`role is "kite", "dive", "peel", "engage" or "fight"`, ln);
        if (target.name==="skillOrder" && !/^[QWEqwe]{1,3}$/.test(String(v))) throw new LangError(`skillOrder is the order to max basic abilities, e.g. "QEW"`, ln);
        if (target.name==="healPolicy" && !(v&&v.t==="champ") && !["lowest","save","self"].includes(v)) throw new LangError(`healPolicy is "lowest", "save", "self" or a Champion`, ln);
        if (target.name==="target" && !(v&&v.t==="champ")) throw new LangError(`target must be a Champion`, ln);
        obj.opts = {...(obj.opts||{}), [target.name]: target.name==="passive" ? truthy(v) : v}; return; }
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
      throw new LangError(`you can set a champion's level, skillOrder, target, healPolicy, passive, rotation, role and souls, and an ability's rank; “${target.name}” is calculated.${hint(target.name, ["level","rank","skillOrder","target","healPolicy","passive","rotation","souls"])}`, ln);
    }
    if (target.k==="index"){ const o=evalE(target.obj,env), i=evalE(target.i,env); const arr=o&&o.t==="comp"?o.champs:o&&o.t==="list"?o.items:null; if(!arr) throw new LangError("can't assign into that", ln); arr[i]=v; return; }
  }
  function call(e, env){
    if (e.fn.k==="id" && (e.fn.name==="assert"||e.fn.name==="print")) return special(e, env);
    if (e.fn.k==="id" && TYPES.has(e.fn.name)){ // Champion(Syndra, 11), ItemSet(...)
      const args=e.args.map(a=>evalE(a,env));
      if (e.fn.name==="Dummy"){ const named={}; for (const [k,v] of Object.entries(e.named||{})) named[k]=evalE(v,env); try { return mkDummy(args, named); } catch(err){ throw new LangError(err.message, e.line); } }
      if (e.fn.name==="Champion"){ const c=args[0]; if(!c||c.t!=="champ") throw new LangError("Champion(…) takes a champion, e.g. Champion(Syndra, 11)", e.line); const n=copy(c); if(args[1]!=null) n.level=args[1]; return n; }
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
      if (f && f.t==="builtin") return f.fn(args, named);
      if (f && f.t==="champ"){ if(typeof args[0]!=="number") throw new Error(`${champName(f)}(…) takes a level, e.g. ${champName(f)}(11)`); const n=copy(f); n.level=Math.min(18,Math.max(1,Math.round(args[0]))); return n; }
      if (f && f.t==="pred"){ const q=query(f.name, args, e.line); if (TR){ TR.subs.push(q); TR.lines.push(`${f.name}(${args.map(show).join(", ")}) is ${q.status==="none"?"not established (no rule applies)":q.status}`); } return q.status==="holds"; }
      if (f && f.t==="fn") return invoke(f.decl, args, e.line);
    } catch(err){ if (err instanceof LangError || err instanceof Ret) throw err; throw new LangError(err.message, e.line); }
    if (e.fn.k==="member" && ["rank","level","target","healPolicy","passive","rotation","souls","skillOrder"].includes(e.fn.name))
      throw new LangError(`${e.fn.name} is a field, not a function: set it with ${e.fn.src.replace(/\($/,"")} = ${e.args[0] && e.args[0].src ? e.args[0].src : "…"};`, e.line);
    throw new LangError(`${show(f)} is not something you can call`, e.line);
  }
  function invoke(d, args, ln){
    if (args.length!==d.params.length) throw new LangError(`${d.name} takes ${d.params.length} argument${d.params.length===1?"":"s"}, got ${args.length}`, ln);
    const env=new Env(globals);
    d.params.forEach((q,i)=>env.def(q.name, q.ref ? args[i] : coerce(q.type, args[i], ln)));
    try { exec(d.body, env); } catch(r){ if (r instanceof Ret) return d.type==="auto"||d.type==="void" ? r.v : coerce(d.type, r.v, ln); throw r; }
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
          TR={lines:[], notes:new Set(), asm:new Set(), subs:[]};
          let v; try { v=truthy(evalE(c, env)); } catch(err){ TR.lines.push(err.message); v=false; }
          results.push({text:c.src, ok:v, tr:TR});
          if (!v){ ok=false; break; }
        }
      } else {
        TR={lines:[], notes:new Set(), asm:new Set(), subs:[]};
        let v=false; try { exec(r.body, env); } catch(x){ if (x instanceof Ret) v=truthy(x.v); else TR.lines.push(x.message); }
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
      const seen=new Set();
      const rows=e.args.map(a=>{ const outer=TR; TR={lines:[], notes:new Set(), asm:new Set(), subs:[], seenFights:seen}; let v; try { v=evalE(a,env); } finally { var tr=TR; TR=outer; } return {text:a.src, v, tr}; });
      emit({kind:"print", rows, line:e.line}); return null;
    }
    // assert
    if (!e.args.length) throw new LangError("assert needs a condition", e.line);
    const c=e.args[0], title = e.args[1] ? evalE(e.args[1], env) : c.src;
    const outer=TR;
    try {
      if (c.k==="bin" && ["<","<=",">",">=","==","!="].includes(c.op)){
        const seen=new Set();
        TR={lines:[], notes:new Set(), asm:new Set(), subs:[], seenFights:seen}; const a=evalE(c.a,env); const ta=TR;
        TR={lines:[], notes:new Set(), asm:new Set(), subs:[], seenFights:seen}; const b=evalE(c.b,env); const tb=TR;
        const ok=binop(c.op, a, b, e.line);
        emit({kind:"assert", title, ok, cmp:{op:c.op, a:{text:c.a.src, v:a, tr:ta}, b:{text:c.b.src, v:b, tr:tb}}, line:e.line});
        return ok;
      }
      TR={lines:[], notes:new Set(), asm:new Set(), subs:[]}; const v=truthy(evalE(c,env)); const t=TR;
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
        if (v && v.t==="champ" && !s.ref) v.label = d.name;
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
        catch(err){ if (err instanceof Ret) continue; emit({kind:"error", msg: err.message, line: err.line ?? s.line}); if (err instanceof LangError && /ran too long/.test(err.message)) return; }
      }
    }
  };
}


/* ================= public API ================= */
function run(text, libs){
  statMemo.clear(); rankMemo.clear(); WORLD=World(); TR=null; GAME.minute=20;
  const items=[]; let ast=[];
  for (const lib of (libs||[])){
    try { const la=parse(lib.text.replace(/^\s*import\s+"[^"]*"\s*;?/gm, "")); for (const st of la) st.lib=lib.name; ast.push(...la); }
    catch(e){ return {items:[{kind:"error", line:e.line??null, msg:`in ${lib.name}: ${e.message}`}], functions:0, rules:0}; }
  }
  if (/^\s*import\s+"/m.test(text) && !(libs && libs.length)) items.push({kind:"error", line:null, msg:"import only works from the command line (node tools/rl.js); the editor ignores it"});
  text = text.replace(/^\s*import\s+"[^"]*"\s*;?/gm, "");
  try { ast.push(...parse(text)); }
  catch(e){ return {items:[{kind:"error", line:e.line??null, msg:e.message}], functions:0, rules:0}; }
  Interpreter(ast, it=>items.push(it)).run();
  return {items, functions:ast.filter(s=>s.k==="func").length, rules:ast.filter(s=>s.k==="rule").length};
}
return {run, parse, KB, CALC, ITEMS, ITEMKEYS, CLASSES, SLOTS, IDX, TAGS, KEYWORDS, TYPES, STATLABEL, RUNE_KEYS,
        norm, fmt, fmtc, show, label, champName, runeName, findItem, findRune, typeName,
        _internals:{itemCalc, stats, MODELLED_ITEMS}};
}
if (typeof module !== "undefined") module.exports = createRiftLogic;
