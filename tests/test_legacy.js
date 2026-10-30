const {makeServer,boot}=require('./boot');const F=require('./fixtures');const T=require('./t');
const dir=process.argv[2]||require('path').resolve(__dirname,'..');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  T.section('legacy test: default behaviour has NO new UI');
  let server=makeServer(dir);
  server.seed({tests:[F.legacyTest()],assignments:[F.legacyAssignment({timed:true,maxMinutes:30})],submissions:[],peerSessions:[]});
  let {win,errors}=await boot({projectDir:dir,server,query:'?exam=A1'});
  win.document.getElementById('student-name-input').value='Hal J';win.eval(`startExam('A1')`);await sleep(40);
  let h=win.document.getElementById('student-wrapper').innerHTML;
  T.ok(!h.includes('Save &amp; exit')&&!h.includes('student-save-pill'),'no Save&Exit / save pill unless the instructor enabled it');
  T.ok(h.includes('timer-display'),'overall timer still rendered');
  T.ok(h.includes('Question 1 of 8'),'question counter covers whole test');
  T.eq(win.eval(`sxContinueLater(APP.currentStudentExam.t,APP.currentStudentExam.a).allowed`),false,'continue-later defaults OFF for legacy tests');
  T.eq(win.eval(`typeof sxStudentCtx()`),'object','ctx is null (typeof null) for legacy');
  T.eq(win.eval(`sxStudentCtx()`),null,'no section context for legacy');
  // answer & submit via the legacy path
  win.eval(`(function(){const ex=APP.currentStudentExam;examItems().forEach(f=>{if(f.q.type==='mc')ex.sub.answers[f.key]=f.q.correctAnswers[0];});})()`);
  win.eval(`submitExam()`);await sleep(60);
  T.eq(server.state().submissions[0].status,'submitted','legacy submit works');
  T.eq(server.state().submissions[0].score,7,'legacy score (3 MC + P5a... = 1+2+3+1)');
  T.ok(server.state().submissions[0].grade===undefined,'no grade object attached to plain legacy tests');
  win.eval(`window.__h=document.getElementById('student-wrapper').innerHTML`);
  T.ok(win.eval(`__h`).includes('Submitted.'),'legacy submitted screen');

  T.section('legacy test with Save & continue later enabled (opt-in) + paused clock');
  const lt=F.legacyTest();lt.continueLater={allowed:true,clock:'pause'};
  server=makeServer(dir);
  server.seed({tests:[lt],assignments:[F.legacyAssignment({timed:true,maxMinutes:30})],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A1'}));
  win.document.getElementById('student-name-input').value='Ivy K';win.eval(`startExam('A1')`);await sleep(40);
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('student-save-pill'),'save pill visible when enabled');
  win.eval(`window.__sub=APP.currentStudentExam.sub;__sub.answers['0']=0;__sub.startedAt=new Date(Date.now()-10*60000).toISOString();`);   // 10 min used
  win.eval(`sxSaveAndExit()`);for(let i=0;i<100;i++){if(win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'))break;await sleep(50);}
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'),'legacy: Progress saved screen');
  const saved=server.state().submissions[0];
  T.eq(saved.paused,true,'server copy is paused');T.eq(saved.answers['0'],0,'answers saved');
  // resume 2 hours later on a new device
  ({win}=await boot({projectDir:dir,server,query:'?exam=A1'}));
  win.eval(`(function(){const rn=Date.now;Date.now=()=>rn()+2*3600000;})()`);
  win.document.getElementById('student-name-input').value='Ivy K';win.eval(`startExam('A1')`);await sleep(80);
  const rem=win.eval(`computeRemainingSecs()`);
  T.ok(Math.abs(rem-20*60)<5,'legacy timer: 20:00 left after 2h away (clock paused) — got '+rem);
  T.eq(win.eval(`APP.currentStudentExam.sub.paused`),false,'unpaused');

  T.section('non-sectioned test with grading config');
  const gt=F.legacyTest();gt.grading={method:'total',passPercent:50,letterEnabled:true};
  server=makeServer(dir);
  server.seed({tests:[gt],assignments:[F.legacyAssignment()],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A1'}));
  win.document.getElementById('student-name-input').value='Jo L';win.eval(`startExam('A1')`);await sleep(40);
  win.eval(`(function(){const ex=APP.currentStudentExam;examItems().forEach(f=>{const q=f.q;if(q.type==='mc')ex.sub.answers[f.key]=q.correctAnswers[0];else if(q.type==='ms')ex.sub.answers[f.key]=[...q.correctAnswers];else if(q.type==='short')ex.sub.answers[f.key]=q.correctAnswers[0];});ex.sub.manualScores={'6':4};})()`);
  win.eval(`submitExam()`);await sleep(60);
  const g=server.state().submissions[0];
  T.eq([g.score,g.grade.percent,g.grade.letter,g.grade.passed],[16,100,'A',true],'plain test + letter/pass config grades correctly');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Grade A'),'submitted screen shows letter grade');
  T.ok(errors.length===0,'no page errors');
  process.exit(T.done()||0);
})();
