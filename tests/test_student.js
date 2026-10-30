const {makeServer,boot}=require('./boot');const F=require('./fixtures');const {adaptiveTest}=require('./fx2');const T=require('./t');
const dir=process.argv[2]||require('path').resolve(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(win){for(let i=0;i<200;i++){if(!win.eval('_sxBusy'))break;await sleep(15);}await sleep(30);}
(async()=>{
  T.section('LEGACY: shuffle-questions scoring bug is fixed');
  {
    const server=makeServer(dir);
    server.seed({tests:[F.legacyTest()],assignments:[F.legacyAssignment({shuffleItems:true})],submissions:[],peerSessions:[]});
    let bad=0;
    for(let r=0;r<6;r++){
      const {win}=await boot({projectDir:dir,server,query:'?exam=A1'});
      win.document.getElementById('student-name-input').value='Tester T'+r;
      win.eval(`startExam('A1')`);
      win.eval(`(function(){const ex=APP.currentStudentExam;examItems().forEach(f=>{const q=f.q;if(q.type==='mc')ex.sub.answers[f.key]=q.correctAnswers[0];else if(q.type==='ms')ex.sub.answers[f.key]=[...q.correctAnswers];else if(q.type==='short')ex.sub.answers[f.key]=q.correctAnswers[0];});})()`);
      const order=win.eval(`examItems().map(f=>f.key).join(',')`);
      win.eval(`submitExam()`);await sleep(60);
      if(win.eval(`APP.currentStudentExam.sub.score`)!==12)bad++;
    }
    T.eq(bad,0,'6 shuffled perfect papers all score 12/12');
    // shuffled order is stable and keys canonical
    const {win}=await boot({projectDir:dir,server,query:'?exam=A1'});
    win.document.getElementById('student-name-input').value='Stable S';win.eval(`startExam('A1')`);
    const o1=win.eval(`examItems().map(f=>f.key).join(',')`),o2=win.eval(`examItems().map(f=>f.key).join(',')`);
    T.eq(o1,o2,'shuffled order stable across renders');
  }

  T.section('SECTIONED: adaptive run through the real UI functions');
  const server=makeServer(dir);
  const A={id:'A2',testId:'T2',releaseScores:true,timed:false,maxMinutes:60,shuffleItems:false,shuffleChoices:false,allowDesmos:false,locked:false,maxStrikes:2,createdAt:new Date().toISOString()};
  server.seed({tests:[adaptiveTest({continueLater:{allowed:true,when:'anytime',clock:'pause'}})],assignments:[A],submissions:[],peerSessions:[]});
  let {win,errors}=await boot({projectDir:dir,server,query:'?exam=A2'});
  const E=c=>win.eval(c);
  win.document.getElementById('student-name-input').value='Ada L';
  E(`startExam('A2')`);await sleep(40);
  T.eq(E(`sub0=APP.currentStudentExam.sub,sub0.sectionState.phase`),'intro','starts on the section intro screen');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Begin Section'),'intro screen rendered with Begin button');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Answer <strong>all</strong>'),'section directions rendered as markdown');
  T.eq(E(`sxRemainingSecs(APP.currentStudentExam.t,APP.currentStudentExam.a,sub0,'S1',Date.now())`),Infinity,'clock not running at intro');
  E(`sxBeginSectionUI()`);await sleep(20);
  T.eq(E(`sub0.sectionState.phase`),'active','begin → active');
  T.eq(E(`examItems().length`),4,'only section-1 questions are visible');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Question 1 of 4'),'question counter is section-scoped');
  T.ok(win.document.getElementById('timer-display')!==null,'section timer displayed');
  // answer 3/4 right → 75% → HARD
  E(`['0','1','2'].forEach(k=>sub0.answers[k]=0);sub0.answers['3']=2;`);
  E(`toggleFlag('1')`);E(`studentState.currentQ=2;saveLocalResume()`);
  T.eq(E(`sub0.ui.currentQ`),2,'position written to the submission (not just localStorage)');
  T.eq(E(`!!sub0.ui.flagged['1']`),true,'flag written to the submission');
  E(`sxFinishSection('submitted')`);await settle(win);
  T.eq(E(`sxById(APP.currentStudentExam.t,sub0.sectionState.current).title`),'Module 2 Hard','75% routed to HARD module');
  T.eq(E(`sub0.sectionState.phase`),'intro','HARD module waits at intro');
  // server has the routing decision (verified save)
  let srv=server.state().submissions.find(s=>s.id===E('sub0.id'));
  T.eq(srv.sectionState.current,'S2H','server already holds the routed section');
  T.eq(srv.sectionState.decisions[0].via,'rule','routing decision persisted for audit');
  E(`sxBeginSectionUI()`);await sleep(20);
  T.ok(!win.document.getElementById('student-wrapper').innerHTML.includes('onclick="prevQ()" ')||win.document.getElementById('student-wrapper').innerHTML.includes('visibility:hidden'),'forward-only section hides Back');
  T.eq(E(`(sxGoTo(1),studentState.currentQ)`),0,'forward-only: jumping via nav grid is refused');
  E(`examItems().forEach(f=>sub0.answers[f.key]=1)`);
  E(`sxFinishSection('submitted')`);await settle(win);
  T.eq(E(`sxById(APP.currentStudentExam.t,sub0.sectionState.current).title`),'Writing','after a branch module, flow rejoins the core path');
  E(`sxBeginSectionUI()`);await sleep(20);
  E(`sub0.answers['8']='x';sub0.answers['9']='<p>my essay</p>'`);
  E(`sxFinishSection('submitted')`);await settle(win);
  T.eq(E(`sub0.status`),'submitted','exam submitted after final section');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.length>200,'submitted screen rendered');
  srv=server.state().submissions.find(s=>s.id===E('sub0.id'));
  T.eq(srv.status,'submitted','server has the final submission');
  T.eq(srv.grade.sections.map(s=>s.title),['Module 1','Module 2 Hard','Writing'],'grade only counts sections taken');
  T.eq(srv.score,3+4+1,'score = M1 3 + Hard 4 + short 1 (essay pending)');
  T.eq(srv.grade.pending,1,'essay awaits manual grading');
  T.ok(E(`needsGrading(sub0,APP.currentStudentExam.t)`),'needsGrading true');
  T.ok(errors.length===0,'no page errors: '+errors.slice(0,2).join(' | '));

  T.section('SAVE & CONTINUE LATER — resume on another device');
  server.seed({tests:[adaptiveTest({continueLater:{allowed:true,when:'anytime',clock:'pause'},sections:adaptiveTest().sections.map((s,i)=>i===0?Object.assign({},s,{timeLimitMin:10}):s)})],assignments:[A],submissions:[],peerSessions:[]});
  ({win,errors}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  const E2=c=>win.eval(c);
  win.document.getElementById('student-name-input').value='Bo K';E2(`startExam('A2')`);await sleep(30);
  E2(`sxBeginSectionUI()`);await sleep(20);
  E2(`sub=APP.currentStudentExam.sub;sub.answers['0']=0;sub.answers['1']=3;studentState.currentQ=2;toggleFlag('0');`);
  // pretend 3 minutes elapsed
  E2(`(function(){const s=sub.sectionState.status['S1'];s.resumedAt=new Date(Date.now()-180000).toISOString();})()`);
  T.near(E2(`sxRemainingSecs(APP.currentStudentExam.t,APP.currentStudentExam.a,sub,'S1',Date.now())`),420,'7:00 left after 3 min',2);
  E2(`sxSaveAndExit()`);await settle(win);
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'),'"Progress saved" screen shown');
  let s1=server.state().submissions.find(s=>s.studentName==='Bo K');
  T.eq(s1.status,'in-progress','still in-progress on the server');
  T.eq(s1.paused,true,'marked paused');
  T.eq([s1.answers['0'],s1.answers['1']],[0,3],'answers are on the server');
  T.eq(s1.ui.currentQ,2,'question position is on the server');
  T.eq(!!s1.ui.flagged['0'],true,'flag is on the server');
  T.eq(s1.sectionState.status.S1.resumedAt,null,'section clock paused');
  // "other device": brand-new window, empty localStorage, an hour later
  const realNow=Date.now;
  ({win,errors}=await boot({projectDir:dir,server,query:'?exam=A2',beforeScripts:w=>{}}));
  const E3=c=>win.eval(c);
  win.eval(`(function(){const off=3600000;const rn=Date.now;Date.now=()=>rn()+off;})()`);   // 1 hour passes
  win.document.getElementById('student-name-input').value='Bo K';
  T.eq(E3(`getLocalResume('A2','Bo K')`),null,'second device has no local resume record');
  E3(`startExam('A2')`);await sleep(60);
  const sub=()=>E3(`APP.currentStudentExam.sub`);
  T.eq(E3(`APP.currentStudentExam.sub.id`),s1.id,'resumed the SAME submission (no duplicate)');
  T.eq(E3(`APP.currentStudentExam.sub.sectionState.current`),'S1','resumed in the right section');
  T.eq(E3(`studentState.currentQ`),2,'resumed on the right question');
  T.eq(E3(`!!studentState.flagged['0']`),true,'flag restored');
  T.eq(E3(`APP.currentStudentExam.sub.answers['1']`),3,'answer restored');
  T.near(E3(`sxRemainingSecs(APP.currentStudentExam.t,APP.currentStudentExam.a,APP.currentStudentExam.sub,'S1',Date.now())`),420,'timer still 7:00 after an hour away (paused)',3);
  T.eq(E3(`APP.currentStudentExam.sub.paused`),false,'unpaused on resume');
  T.eq(E3(`APP.submissions.filter(s=>s.studentName==='Bo K').length`),1,'only one submission exists');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Question 3 of 4'),'UI shows question 3 of 4');

  T.section('clock policy = run: time expires while away');
  const runTest=adaptiveTest({continueLater:{allowed:true,when:'anytime',clock:'run'}});
  server.seed({tests:[runTest],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Cy M';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sub.answers['0']=0;sub.answers['1']=0;sub.answers['2']=0;sub.answers['3']=0;`);
  win.eval(`sxSaveAndExit()`);await settle(win);
  T.ok(win.eval(`sub.sectionState.status.S1.resumedAt!==null`),'clock keeps running (not paused)');
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.eval(`(function(){const rn=Date.now;Date.now=()=>rn()+11*60000;})()`);   // 11 minutes pass
  win.document.getElementById('student-name-input').value='Cy M';win.eval(`startExam('A2')`);await sleep(80);
  T.eq(win.eval(`APP.currentStudentExam.sub.sectionState.status.S1.endReason`),'timeout','expired section auto-submitted on return');
  T.eq(win.eval(`APP.currentStudentExam.sub.sectionState.current`),'S2H','100% before expiry still routed to HARD');
  T.eq(win.eval(`APP.currentStudentExam.sub.sectionState.phase`),'intro','student lands at next section intro');

  T.section('save failure is never silent');
  server.seed({tests:[adaptiveTest({continueLater:{allowed:true,when:'anytime',clock:'pause'}})],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Di P';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sub.answers['0']=0;`);
  server.online=false;
  win.eval(`window._p=sxReliableSaveSubmission(sub,2)`);
  const res=await win.eval(`window._p`);
  T.eq(res.ok,false,'offline: verified save reports failure');
  server.online=true;
  const res2=await win.eval(`sxReliableSaveSubmission(sub,2)`);
  T.eq(res2.ok,true,'back online: verified save succeeds');
  // Save&Exit while offline must NOT show "saved" and must restore the clock
  server.online=false;
  win.eval(`window._se=sxSaveAndExit()`);for(let i=0;i<120;i++){const b=win.document.getElementById('sx-busy');if(b&&b.innerHTML.includes('hasn’t been saved'))break;await sleep(100);}
  T.ok(win.document.getElementById('sx-busy')&&win.document.getElementById('sx-busy').innerHTML.includes('hasn’t been saved'),'offline Save&Exit shows the "not saved" warning');
  win.document.getElementById('sx-cancel').click();await sleep(50);
  T.ok(!win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'),'did NOT claim progress was saved');
  T.eq(win.eval(`sub.paused`),false,'rolled back: still unpaused, exam continues');
  server.online=true;

  T.section('beforeunload guard sees unsynced submissions');
  win.eval(`sub.answers['1']=2`);
  T.eq(win.eval(`hasPendingChanges()`),true,'unsynced answer → pending');
  T.done();
})();
