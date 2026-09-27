// Rift Logic background: Summoner's Rift under fog of war (v2, approved 2026-09-27).
// Single-pass fragment shader run by web/fx/scene.js (which also runs the little match sim that feeds the arrays below).
// src/theme_fx.py inlines it into every page at build time. No mouse effects: the cursor ward and tilt stay off.
// Site hooks: uCam.xy carries the per-page camera framing (scene.js); uE = the draft eval bar's blue win probability
// 0-1 (-1 on other pages), which leans the base glows toward the side that is ahead.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uR;uniform float uT;uniform vec3 uM;uniform float uL;
uniform vec4 uCam;uniform float uTx;
uniform vec4 uMin[9];uniform vec4 uFront[3];uniform vec4 uTw[12];uniform vec4 uCamp[8];
uniform vec4 uPing[3];uniform vec4 uWard[4];uniform vec3 uEW;uniform vec3 uChamp;uniform vec4 uRecall;
uniform vec4 uShot;uniform vec3 uSP;uniform vec4 uDrag;uniform float uBar;uniform float uE;
float h1(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h1(i),h1(i+vec2(1.,0.)),f.x),mix(h1(i+vec2(0.,1.)),h1(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vn(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return v;}
float fbm3(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*vn(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return v;}
float seg(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);return length(pa-ba*h);}
float gs(float d,float k){return exp(-d*d*k);}
float ring(float d,float r,float w){float x=(d-r)/w;return exp(-x*x);}
const vec2 BB=vec2(-.8,-.8);const vec2 RB=vec2(.8,.8);
const vec2 BARON=vec2(-.3,.4);const vec2 DRAG=vec2(.32,-.36);
float laneD(vec2 p){
  float d=min(seg(p,vec2(-.82,-.6),vec2(-.82,.82)),seg(p,vec2(-.82,.82),vec2(.6,.82)));
  d=min(d,seg(p,vec2(-.6,-.6),vec2(.6,.6)));
  d=min(d,min(seg(p,vec2(-.6,-.82),vec2(.82,-.82)),seg(p,vec2(.82,-.82),vec2(.82,.6))));
  return d;}
float riverD(vec2 p){float w=.035*sin(dot(p,vec2(1.,1.))*5.);return seg(p+vec2(w,w),vec2(-.85,.85),vec2(.85,-.85));}
float openD(vec2 p){
  float d=min(laneD(p)-.05,riverD(p)-.085);
  d=min(d,min(length(p-BB),length(p-RB))-.27);
  d=min(d,min(length(p-BARON),length(p-DRAG))-.1);
  d=min(d,min(length(p-vec2(-.42,-.05)),length(p-vec2(.42,.05)))-.07);
  d=min(d,min(length(p-vec2(-.05,-.5)),length(p-vec2(.05,.5)))-.07);
  d=min(d,min(length(p-vec2(-.6,.2)),length(p-vec2(.6,-.2)))-.06);
  d=min(d,min(length(p-vec2(.2,-.6)),length(p-vec2(-.2,.6)))-.06);
  return d;}
float height(vec2 p){
  float o=openD(p);
  float n=fbm(p*3.2+vec2(3.1,1.7));
  float w=smoothstep(.015,.07,o)*smoothstep(.4,.52,n+.12*smoothstep(.1,.35,o));
  float edge=max(abs(p.x),abs(p.y));
  return max(w,smoothstep(.93,.97,edge));}
vec2 toMap(vec2 uv){
  float z=1.+(.5+uCam.w)*uv.y+uTx*uv.x;
  return vec2(uv.x*1.2*z,uv.y*1.7)*z*.95*uCam.z+uCam.xy+vec2(0.,.05);}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uR)/uR.y;
  float t=uT;
  vec2 p=toMap(uv);
  vec2 mp=toMap((uM.xy-.5*uR)/uR.y);
  // ---- terrain ----
  float H=height(p);
  float H2=height(p+vec2(-.012,-.016));
  float rim=clamp((H-H2)*3.,0.,1.);
  float lD=laneD(p),rD=riverD(p);
  float g=fbm3(p*9.);
  float lane=1.-smoothstep(.03,.05,lD);
  float riv=1.-smoothstep(.06,.09,rD);
  vec2 wp=p*14.+vec2(t*.25,-t*.25);
  float wv=fbm3(wp+fbm3(wp*.5-t*.1)*2.);
  float caus=pow(abs(sin(wv*12.)),8.);
  float bp=length(p-BARON),dp=length(p-DRAG);
  float db=length(p-BB),dr=length(p-RB);
  float wn=fbm3(p*20.);
  // dark palette: night rift
  vec3 cD=mix(vec3(.022,.045,.035),vec3(.035,.07,.05),g);
  cD=mix(cD,vec3(.085,.075,.058)*(.8+.4*g),lane);
  cD=mix(cD,vec3(.02,.06,.1)+vec3(.05,.2,.25)*caus*.6,riv);
  // light palette: parchment map
  vec3 cL=vec3(.925,.9,.83)*(.96+.06*g);
  cL=mix(cL,vec3(.84,.78,.66)*(.97+.05*g),lane);
  cL=mix(cL,vec3(.76,.84,.86)+vec3(.08,.07,.05)*caus,riv);
  cL-=vec3(.03,.035,.04)*(1.-smoothstep(.0,.006,abs(rD-.075)))*riv;
  // objective pits (dragon hue drifts through the elements)
  vec3 dh=uDrag.rgb;
  float dPulse=uDrag.w<1.?ring(dp,.085+.12*uDrag.w,.02+.03*uDrag.w)*(1.-uDrag.w)*1.4:0.;
  float bPulse=uBar<1.?ring(bp,.085+.12*uBar,.02+.03*uBar)*(1.-uBar)*1.4:0.;
  float breathe=.85+.15*sin(t*.7);
  vec3 pits=vec3(.35,.12,.5)*gs(bp,300.)*.25*breathe+vec3(.5,.2,.9)*(ring(bp,.085,.014)*.25+bPulse*.35)
           +dh*.6*gs(dp,300.)*.25*breathe+dh*(ring(dp,.085,.014)*.28+dPulse*.35);
  // walls
  cD=mix(cD,vec3(.008,.012,.012)+vec3(.01,.02,.02)*wn,H);
  cD+=mix(vec3(.25,.75,.7),vec3(.95,.72,.35),smoothstep(-.5,.5,p.x-p.y))*rim*.35;
  float hatch=.5+.5*sin((p.x-p.y)*220.);
  cL=mix(cL,vec3(.8,.75,.65)-vec3(.05,.045,.04)*hatch*wn,H);
  cL-=vec3(.3,.26,.2)*rim*.55;
  // bases
  float eB=uE<0.?1.:.45+1.1*uE,eR=uE<0.?1.:1.55-1.1*uE;
  vec3 base=vec3(.1,.35,.9)*(gs(db,60.)*.35+gs(db,2000.)*.9)*eB+vec3(.95,.15,.12)*(gs(dr,60.)*.35+gs(dr,2000.)*.9)*eR;
  cD+=base;
  // ---- vision + emissives (ally = full, enemy = dimmed by fog) ----
  float vis=1.-smoothstep(.26,.38,db);
  vec3 ally=vec3(0.),foe=vec3(0.),ui=vec3(0.);
  foe+=pits*.9;
  // towers + attack-range rings
  for(int i=0;i<12;i++){
    vec4 tw=uTw[i];float d=length(p-tw.xy);
    float rg=ring(d,.13,.005)*tw.w*.4+gs(d,4000.)*tw.w*.03;
    if(tw.z<.5){vis=max(vis,1.-smoothstep(.1,.17,d));ally+=vec3(.3,.65,1.)*(gs(d,9000.)*1.2+rg);}
    else{foe+=vec3(1.,.25,.2)*(gs(d,9000.)*.9*(.75+.25*sin(t*2.+float(i)))+rg);}
  }
  // minion waves
  for(int l=0;l<3;l++){
    vec4 fr=uFront[l];
    for(int k=0;k<3;k++){
      vec4 mm=uMin[l*3+k];
      float d1=length(p-mm.xy),d2=length(p-mm.zw);
      ally+=vec3(.35,.7,1.)*gs(d1,22000.)*fr.z;
      vis=max(vis,(1.-smoothstep(.04,.085,d1))*fr.z);
      foe+=vec3(1.,.3,.25)*gs(d2,22000.)*fr.z*.85;
    }
    // clash sparks: a jittered pinprick that flickers at the front
    float sk=floor(t*9.+float(l)*3.7);
    vec2 jo=vec2(h1(vec2(sk,float(l)))-.5,h1(vec2(float(l),sk))-.5)*.03;
    float on=step(.55,h1(vec2(sk*.37,float(l)+.5)));
    ally+=vec3(1.,.85,.55)*gs(length(p-fr.xy-jo),60000.)*on*fr.z*.9;
  }
  // tower shot: short glowing arc with a 3-sample trail
  if(uSP.x<1.){
    vec3 sc=uSP.z<.5?vec3(.55,.85,1.):vec3(1.,.55,.3);
    for(int k=0;k<3;k++){
      float s=clamp(uSP.x-float(k)*.07,0.,1.);
      vec2 sp=mix(uShot.xy,uShot.zw,s)+vec2(0.,.07*sin(3.14159*s));
      float d=length(p-sp);
      vec3 e=sc*gs(d,26000.-float(k)*6000.)*(1.2-float(k)*.35);
      if(uSP.z<.5)ally+=e;else foe+=e;
    }
    float hit=smoothstep(.85,1.,uSP.x);
    vec3 e2=sc*ring(length(p-uShot.zw),.012+.02*hit,.006)*hit*.8;
    if(uSP.z<.5)ally+=e2;else foe+=e2;
  }
  // jungle camps (neutral gold); cleared camps dim out, respawns pulse
  for(int i=0;i<8;i++){
    vec4 cp=uCamp[i];float d=length(p-cp.xy);
    vec3 e=vec3(.95,.72,.32)*(gs(d,7000.)*.55+gs(d,500.)*.05)*cp.z;
    e+=vec3(1.,.8,.4)*ring(d,.02+.06*cp.w,.007)*(cp.w>0.?1.-cp.w:0.)*.8;
    if(i<4)ally+=e;else foe+=e;
  }
  // friendly wards
  for(int i=0;i<4;i++){
    vec4 w=uWard[i];float d=length(p-w.xy);
    vis=max(vis,(1.-smoothstep(w.w*.72,w.w,d))*w.z);
    ally+=vec3(1.,.82,.3)*(gs(d,14000.)*.9+ring(d,w.w*.94,.005)*.07)*w.z;
  }
  // jungler
  float dc=length(p-uChamp.xy);
  vis=max(vis,(1.-smoothstep(.1,.15,dc))*uChamp.z);
  ally+=(vec3(.4,.75,1.)*gs(dc,6000.)+vec3(.9,.97,1.)*gs(dc,30000.))*uChamp.z;
  // recall: swirling blue ring that collapses into a flash, then gone
  if(uRecall.z<1.){
    float rp=uRecall.z;vec2 rv=p-uRecall.xy;float d=length(rv);
    float grow=smoothstep(0.,.15,rp)*(1.-smoothstep(.82,.9,rp));
    float sw=.6+.4*sin(atan(rv.y,rv.x)*5.-t*5.);
    ally+=vec3(.35,.7,1.)*(ring(d,.034,.006)*sw*grow*.9+gs(d,4000.)*grow*.35);
    ally+=vec3(.7,.9,1.)*gs(d,1500.)*smoothstep(.84,.9,rp)*(1.-smoothstep(.9,1.,rp))*.9;
    vis=max(vis,(1.-smoothstep(.05,.09,d))*grow);
  }
  // cursor = control ward: vision, and it reveals an enemy ward
  float wd=length(p-mp);
  float wr=.2+.015*sin(t*1.5);
  float wardOn=0.; // no cursor ward (user: no mouse tracker)
  vis=max(vis,(1.-smoothstep(wr*.75,wr,wd))*wardOn);
  float rev=vis*uEW.z; // enemy ward shows only where friendly vision covers it
  float de=length(p-uEW.xy);
  ui+=vec3(1.,.25,.2)*(gs(de,16000.)*1.1+ring(de,.03,.004)*.35)*rev;
  ally+=vec3(1.,.85,.3)*(gs(wd,6000.)*.8+ring(wd,wr*.92,.011)*.08)*wardOn;
  // map pings (UI layer; never fogged)
  for(int i=0;i<3;i++){
    vec4 pg=uPing[i];
    if(pg.z<1.){
      float d=length(p-pg.xy),a=pg.z;
      vec3 pc=pg.w<.5?vec3(1.,.3,.25):(pg.w<1.5?vec3(.35,.7,1.):vec3(1.,.82,.28));
      float a2=clamp(a*1.3-.3,0.,1.);
      float e=ring(d,.015+.1*a,.005+.006*a)*pow(1.-a,1.5)+ring(d,.015+.1*a2,.005)*(1.-a2)*step(.23,a)*.6
             +gs(d,9000.)*(1.-smoothstep(.6,1.,a))*.9;
      ui+=pc*e;
    }
  }
  // ---- fog of war ----
  float fn=fbm(p*3.+vec2(t*.04,-t*.03)-uCam.xy*.6+fbm3(p*2.-t*.02));
  // dark
  vec3 fogD=vec3(.012,.016,.024)+vec3(.02,.025,.035)*fn;
  float lum=dot(cD,vec3(.3,.5,.2));
  vec3 c=mix(mix(vec3(lum),cD,.3)*.45+fogD,cD,vis);
  c+=vec3(.12,.2,.25)*.06*(vis*(1.-vis)*4.);
  c+=ally*mix(.55,1.,vis)+foe*mix(.3,1.,vis)+ui;
  c*=.85;
  // light: pale mist over the parchment; emissives become ink
  vec3 mist=vec3(.95,.955,.96)-vec3(.035,.03,.025)*fn;
  float lumL=dot(cL,vec3(.3,.5,.2));
  vec3 l2=mix(mix(vec3(lumL),cL,.35)*.35+mist*.65,cL,vis);
  l2-=vec3(.09,.08,.06)*(vis*(1.-vis)*4.)*.35;
  vec3 em=ally*mix(.6,1.,vis)+foe*mix(.35,1.,vis)+ui+base*.6;
  float ea=max(em.r,max(em.g,em.b));
  l2=mix(l2,(em/max(ea,1e-3))*.5,clamp(ea,0.,1.)*.8);
  vec3 o=mix(c,clamp(l2,0.,1.),uL);
  vec3 lb=vec3(.937,.949,.961);
  vec2 v=gl_FragCoord.xy/uR-.5;
  o=mix(o,mix(vec3(.006,.008,.012),lb,uL),smoothstep(.35,.95,length(v*vec2(1.,.85)))*.6);
  o+=(h1(gl_FragCoord.xy+fract(uT))-.5)/255.;
  gl_FragColor=vec4(o,1.);
}
