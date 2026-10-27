// rtls-bb-check.js — offline check of standardRTLS BOOSTBACK_BURN. Run: node rtls-bb-check.js
// Models: point-mass gravity + Earth rotation, 9 Merlin-like engines (3 s startup, 2 s shutdown,
// 0.5/s throttle slew, 39% floor), gimbal accel cmd, 1-tick command latency, planar attitude.
const fs=require('fs');
const DT=1/80, GM=3.986004418e14, RE=6371000, WE=7.2921159e-5, I=3.0e6, COMY=15;
const MAXF=282, VE=3050, MINF=0.39, GMAX=5;
let S, sent=[];
global.Guidance={send:c=>sent.push(c),
  cmdSetAllThrottle:v=>({t:'all',v}), cmdSetCenterThrottle:v=>({t:'c',v}),
  cmdSetGroupThrottle:(a,v)=>({t:'grp',a,v}), cmdSetGimbalRate:v=>({t:'gr',v}),
  cmdSetGimbalAccel:(al)=>({t:'ga',al}), cmdRcsDuty:()=>({t:'rcs'})};
global.GuideRCS={};
const mk=()=>{const E=[{isCenter:true,angleDeg:null,x:0}];for(let a=0;a<360;a+=45)E.push({isCenter:false,angleDeg:a,x:Math.cos(a*Math.PI/180)});
  E.forEach(e=>Object.assign(e,{f:0,tgt:0,Ve:VE,gimbal:true,gimbalMaxDeg:GMAX,maxMassFlowRate:MAXF,minMassFlowRate:MINF*MAXF,shutdownDurationS:2,gimbalDeg:0,gimbalRateActDegS:0,gimbalAccelDegS2:60,massFlowRate:0}));return E;};
global.Derivation={getEnv:()=>({DT,GM_EARTH:GM,EARTH_RADIUS:RE,EARTH_OMEGA:WE,LAUNCH_SITE_ANGLE_0:0}),
 derive:()=>({rx:S.rx,ry:S.ry,vx:S.vx,vy:S.vy,theta:S.th,omega:S.w,massProps:{I,M:S.M,comX:0,comY:COMY}})};
eval(fs.readFileSync('guidance-blocks.js','utf8')+';global.FB=FUNDAMENTAL_BLOCKS;');
const B=FB.standardRTLS;
function apply(c){ if(!c)return; const E=S.E;
  const set=(e,v)=>{ e.tgt = v===0?0:(v===Infinity?MAXF:Math.max(MINF*MAXF,Math.min(MAXF,v))); };
  if(c.t==='all')E.forEach(e=>set(e,c.v));
  else if(c.t==='c')E.filter(e=>e.isCenter).forEach(e=>set(e,c.v));
  else if(c.t==='grp')E.filter(e=>!e.isCenter&&c.a.some(a=>Math.abs(a-e.angleDeg)<1e-6)).forEach(e=>set(e,c.v));
  else if(c.t==='ga')S.alpha=c.al; }
function run(name,{dtheta0=0, w0=0, cfg={}, downrangeKm=40, alt=70000, vh=900, vr=700}={}){
  const b=B.createInstance(); const C=Object.assign(JSON.parse(JSON.stringify(B.defaultConstants)),cfg);
  const logs=[]; const oL=console.log,oW=console.warn; console.log=m=>logs.push(m); console.warn=m=>logs.push('WARN '+m);
  b.start(C,0,{targetPad:{id:'LZ-1',angleEf:400/RE}});
  const st=b.getState(); st.st.phase='BOOSTBACK_BURN'; st.st.phaseLog={BOOSTBACK_BURN:{startT:0,endT:null,reason:null}}; b.setState(st);
  const phi0=downrangeKm*1e3/RE, r0=RE+alt;
  S={rx:r0*Math.sin(phi0),ry:r0*Math.cos(phi0),vx:0,vy:0,th:0,w:w0,M:60000,E:mk(),alpha:0,fuel:30000};
  // east tangent (cos,-sin), radial (sin,cos); inertial v incl. earth rot
  const ve=vh+WE*r0; S.vx=ve*Math.cos(phi0)+vr*Math.sin(phi0); S.vy=-ve*Math.sin(phi0)+vr*Math.cos(phi0);
  S.th=Math.PI/2-phi0+dtheta0*Math.PI/180; // nose = -east
  let s0=1,pend=[],done=null,t=0,maxAtt=0,maxGim=0,fuel0=S.fuel;
  for(let k=0;k<80*600;k++){
    t=k*DT; pend.forEach(apply); sent=[]; pend=[];
    const E=S.E; E.forEach(e=>{e.massFlowRate=e.f;});
    const snap={simTime:t,bodies:[{engines:E,fuelMass:S.fuel,memberFuel:[S.fuel]}]};
    b.tick(snap); pend=sent.slice();
    if(b.getStatus().phase!=='BOOSTBACK_BURN'){done=t;break;}
    // physics
    let F=0,A=0,Bt=0; E.forEach(e=>{
      const up=e.f===0?MAXF/3:MAXF/3, slew=MAXF*0.5, dn=MAXF/2;
      if(e.tgt>e.f){ const rate=e.f<MINF*MAXF&&e.tgt>=MINF*MAXF&&e.f<e.tgt?(e.f===0||e.f<MINF*MAXF?up:slew):slew; e.f=Math.min(e.tgt,e.f+rate*DT); }
      else e.f=Math.max(e.tgt,e.f-(e.tgt===0?dn:slew)*DT);
      const Fi=e.f*VE; F+=Fi; A+=e.x*Fi; Bt+=Fi; });
    S.fuel-=E.reduce((s,e)=>s+e.f,0)*DT; S.M=60000-(fuel0-S.fuel);
    // gimbal (shared)
    const g0=E[0]; let gr=g0.gimbalRateActDegS+S.alpha*DT, gd=g0.gimbalDeg+gr*DT;
    if(Math.abs(gd)>GMAX){gd=Math.sign(gd)*GMAX;gr=0;} E.forEach(e=>{e.gimbalDeg=gd;e.gimbalRateActDegS=gr;});
    const g=gd*Math.PI/180; const tau=A*Math.cos(g)+Bt*COMY*Math.sin(g);
    const r=Math.hypot(S.rx,S.ry), a=F/S.M, nx=-Math.sin(S.th), ny=Math.cos(S.th);
    S.vx+=(-GM*S.rx/r**3+a*nx)*DT; S.vy+=(-GM*S.ry/r**3+a*ny)*DT; S.rx+=S.vx*DT; S.ry+=S.vy*DT;
    S.w+=tau/I*DT; S.th+=S.w*DT;
    const phi=Math.atan2(S.rx,S.ry), vE=S.vx*Math.cos(phi)-S.vy*Math.sin(phi), vR=S.vx*Math.sin(phi)+S.vy*Math.cos(phi);
    const tgtTh=Math.atan2(Math.cos(phi),Math.sin(phi)); // nose opposite vE
    if(process.env.DBG&&name==="nominal"&&k%240===0)console.error(t.toFixed(1),"err",(((S.th-tgtTh+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI)*180/Math.PI,"w",S.w.toFixed(4),"g",gd.toFixed(2),"F",F.toFixed(0),"vE",vE.toFixed(0));
    maxAtt=Math.max(maxAtt,Math.abs(((S.th-tgtTh+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI)*180/Math.PI); maxGim=Math.max(maxGim,Math.abs(gd));
  }
  console.log=oL;console.warn=oW;
  // true ballistic impact after the burn
  let x=S.rx,y=S.ry,vx=S.vx,vy=S.vy,tt=0;const h=0.05; 
  while(Math.hypot(x,y)>RE&&tt<4000){const r=Math.hypot(x,y);vx+=-GM*x/r**3*h;vy+=-GM*y/r**3*h;x+=vx*h;y+=vy*h;tt+=h;}
  const impEf=(Math.atan2(x,y)-WE*(t+tt))*180/Math.PI, tgt=(400/RE)*180/Math.PI+(C.BOOSTBACK_APPARENT_OFFSET_DEG||0);
  const stg=logs.filter(l=>/THREE|CENTER|SPOOL|done|WARN/.test(l)).map(l=>l.replace('[standardRTLS] ',''));
  console.log(`\n== ${name}: end t=${done&&done.toFixed(1)}s  trueImpactErr=${(impEf-tgt).toFixed(4)}deg (${((impEf-tgt)*Math.PI/180*RE).toFixed(0)} m)  fuel=${(fuel0-S.fuel).toFixed(0)}kg  maxAttErr=${maxAtt.toFixed(1)}deg maxGimbal=${maxGim.toFixed(2)}deg`);
  console.log('   '+logs[0]); stg.forEach(l=>console.log('   '+l));
}
run('nominal');
run('offset +1deg east',{cfg:{BOOSTBACK_APPARENT_OFFSET_DEG:1}});
run('start below SIDE_CUT (far already close)',{downrangeKm:60,cfg:{BOOSTBACK_SIDE_CUT_DEG:200}});
run('no taper',{cfg:{BOOSTBACK_TAPER_DEG:0}});
run('att err 20deg + w',{dtheta0:20,w0:0.02});
