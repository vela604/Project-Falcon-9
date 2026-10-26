// rtls-check.js — offline numerical verification for the standardRTLS block.
// Run:  node rtls-check.js   (from the folder that contains guidance-blocks.js)
//
// Stubs Guidance / GuideRCS / Derivation, models the 1-tick command latency
// (a command sent on tick k acts from tick k+1) and a single-axis rotation with
// RCS torque limit TMAX, inertia I. Extend the stubs (translation, mass flow,
// gimbal, atmosphere) as new phases need them. Prints, per case, the direction
// the FLIP chose, predicted vs actual time, and final error / omega.
const fs=require('fs');
const DT=1/80, I=2.0e6, TMAX=3.0e4, R=6371000+150000;
let sent=[]; 
global.Guidance={send:c=>sent.push(c),cmdSetAllThrottle:x=>({t:'thr'}),cmdSetGimbalRate:x=>({t:'g'}),
  cmdRcsDuty:(du,i)=>({t:'rcs',tau: du? du.p.tau:0})};
global.GuideRCS={targetTorqueRcs:(snap,tau)=>{ const c=Math.max(-TMAX,Math.min(TMAX,tau));
  if(Math.abs(c)<1e-9) return {fires:[],duties:{},torqueAchieved:0};
  return {fires:[{torque:c}],duties:{p:{up:0,dn:0,lat:Math.abs(c)/TMAX,tau:c}},torqueAchieved:c};}};
let S;
global.Derivation={getEnv:()=>({DT}),derive:()=>({rx:S.rx,ry:S.ry,vx:S.vx,vy:S.vy,theta:S.th,omega:S.w,
  massProps:{I,M:2e4},alphaAng:0,gVecX:0,gVecY:0,dragVecX:0,dragVecY:0,thrustBodyX:0,thrustBodyY:0,altitudeAGL:150000})};
eval(fs.readFileSync('guidance-blocks.js','utf8')+';global.FB=FUNDAMENTAL_BLOCKS;');
const B=FB.standardRTLS;
function run(th0deg, w0, orbit){
  const b=B.createInstance(); b.start(JSON.parse(JSON.stringify(B.defaultConstants)),0,{});
  const wo = orbit? 0.0011:0; let ang=0.0;
  S={rx:R*Math.sin(ang),ry:R*Math.cos(ang),vx:2000*Math.cos(ang),vy:-2000*Math.sin(ang),th:th0deg*Math.PI/180,w:w0};
  let pending=0,t=0,modes=[],log=[];
  const origLog=console.log; let dirLine=""; console.log=(m)=>{ if(String(m).includes("FLIP dir")) dirLine=m; };
  let doneT=null,maxErr=0,flips=0,lastSgn=0;
  for(let k=0;k<80*200;k++){
    t=k*DT; const tauStep=pending; sent=[];
    b.tick({simTime:t,bodies:[{}]});
    const st=b.getStatus();
    const c=sent.filter(x=>x.t==='rcs').pop();
    if(modes[modes.length-1]!==st.flipMode) modes.push(st.flipMode);
    if(st.phase!=='FLIP'){doneT=t;break;}
    pending = c? c.tau : pending;
    // integrate one step with the torque applied this step
    S.w+=tauStep/I*DT; S.th+=S.w*DT;
    ang+=wo*DT; S.rx=R*Math.sin(ang);S.ry=R*Math.cos(ang);S.vx=2000*Math.cos(ang);S.vy=-2000*Math.sin(ang);
  }
  console.log=origLog;
  const st=b.getStatus();
  console.log(dirLine+"\n  "+`th0=${th0deg} w0=${w0} orbit=${orbit}: left FLIP at t=${doneT&&doneT.toFixed(1)}s, modes=${modes.join('>')}, finalErr=${st.flipErrDeg&&st.flipErrDeg.toFixed(3)}deg w=${st.flipOmegaDegS&&st.flipOmegaDegS.toFixed(3)}deg/s phase=${st.phase}`);
}
run(-10,0,false); run(200,0,false); run(90.2,0.3,true); run(269,0,true); run(0,-0.05,false); run(0,0.25,false); run(0,-0.25,false); run(60,-0.2,false); run(179,0.1,false);
