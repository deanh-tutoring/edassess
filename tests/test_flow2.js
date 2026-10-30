const {makeServer,boot}=require('./boot');const {adaptiveTest}=require('./fx2');const T=require('./t');
const dir=require('path').resolve(__dirname,'..');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const A={id:'A2',testId:'T2',releaseScores:true,timed:false,maxMinutes:60,shuffleItems:false,shuffleChoices:false,allowDesmos:false,locked:false,maxStrikes:2};
  const mk=(f)=>{const t=adaptiveTest({continueLater:{allowed:true,when:'anytime',clock:'pause'}});f(t);return t;};
  const settle=async win=>{for(let i=0;i<200;i++){if(!win.eval('_sxBusy'))break;await sleep(15);}await sleep(30);};

  T.section('break screen');
  let server=makeServer(dir);server.seed({tests:[mk(t=>{t.sections[0].breakAfterMin=2;})],assignments:[A],submissions:[],peerSessions:[]});
  let {win,errors}=await boot({projectDir:dir,server,query:'?exam=A2'});
  win.document.getElementById('student-name-input').value='Kim B';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;`);win.eval(`sxFinishSection('submitted')`);await settle(win);
  let h=win.document.getElementById('student-wrapper').innerHTML;
  T.ok(h.includes('Break time')&&h.includes('2:00')||h.includes('1:5'),'break screen with 2-minute countdown');
  T.ok(win.eval(`breakTicker!==null`),'break ticker running');
  T.ok(h.includes('Save &amp; continue later'),'save & continue offered during a break');
  win.eval(`sxEndBreak()`);
  T.eq(win.eval(`sub.sectionState.phase`),'intro','Continue now → next section intro');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Begin Section'),'intro rendered after break');
  // break auto-ends when its time is up
  server.seed({tests:[mk(t=>{t.sections[0].breakAfterMin=2;})],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Lu M';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sxFinishSection('submitted')`);await settle(win);
  win.eval(`(function(){const rn=Date.now;Date.now=()=>rn()+3*60000;})()`);
  for(let i=0;i<30;i++){if(win.eval(`sub.sectionState.phase`)==='intro')break;await sleep(100);}
  T.eq(win.eval(`sub.sectionState.phase`),'intro','break ends by itself when its clock runs out');

  T.section('live timer: section expires while the student is in it');
  server.seed({tests:[mk(t=>{})],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Ned P';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;['0','1','2','3'].forEach(k=>sub.answers[k]=0);save()`);
  T.ok(win.eval(`sectionTimer!==null`),'section timer running');
  T.ok(win.document.getElementById('timer-display').textContent.includes('10:00')||win.document.getElementById('timer-display').textContent.includes('9:5'),'timer shows ~10:00');
  win.eval(`(function(){const rn=Date.now;Date.now=()=>rn()+10*60000+2000;})()`);   // 10 min later
  for(let i=0;i<40;i++){if(win.eval(`sub.sectionState.status.S1.endedAt`))break;await sleep(100);}
  await settle(win);
  T.eq(win.eval(`sub.sectionState.status.S1.endReason`),'timeout','timer expiry ends the section automatically');
  T.eq(win.eval(`sub.sectionState.current`),'S2H','adaptive routing applied on timeout (4/4 → Hard)');
  T.eq(win.eval(`sectionTimer`),null,'timer stopped between sections');
  T.eq(server.state().submissions[0].sectionState.current,'S2H','server already has the new section');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Begin Section'),'student sees the next section intro');

  T.section('timeout in the LAST section submits the exam');
  server.seed({tests:[mk(t=>{t.sections[3].timeLimitMin=1;t.sections[0].routing={rules:[],fallback:'S3'};})],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Oz Q';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sxFinishSection('submitted')`);await settle(win);
  win.eval(`sxBeginSectionUI();sub.answers['8']='x'`);
  T.eq(win.eval(`sxById(APP.currentStudentExam.t,sub.sectionState.current).title`),'Writing','custom routing skipped both branches');
  win.eval(`(function(){const rn=Date.now;Date.now=()=>rn()+61000;})()`);
  for(let i=0;i<40;i++){if(win.eval(`sub.status`)==='submitted')break;await sleep(100);}
  await settle(win);
  T.eq(win.eval(`sub.status`),'submitted','last-section timeout submits the exam');
  T.ok(win.eval(`sub.note`).includes('time expired'),'note explains auto-submit');
  T.eq(server.state().submissions[0].status,'submitted','server has the submitted exam');

  T.section('saved screen → Continue now');
  server.seed({tests:[mk(t=>{})],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Pam R';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sub.answers['0']=0;`);
  win.eval(`sxSaveAndExit()`);for(let i=0;i<100;i++){if(win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'))break;await sleep(50);}
  T.eq(win.eval(`sectionTimer`),null,'timers stopped while saved');
  win.eval(`sxResumeNow()`);await sleep(80);
  T.eq(win.eval(`APP.currentStudentExam.sub.paused`),false,'Continue now resumes');
  T.ok(win.document.getElementById('student-wrapper').innerHTML.includes('Question 1 of 4'),'back in the exam');
  T.ok(win.eval(`sectionTimer!==null`),'timer restarted');
  T.eq(win.eval(`APP.currentStudentExam.sub.answers['0']`),0,'answer still there');

  T.section('"between sections" blocks mid-section exit');
  server.seed({tests:[{...mk(t=>{}),continueLater:{allowed:true,when:'between',clock:'pause'}}],assignments:[A],submissions:[],peerSessions:[]});
  ({win}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  win.document.getElementById('student-name-input').value='Quin S';win.eval(`startExam('A2')`);await sleep(30);
  win.eval(`sxBeginSectionUI()`);
  win.eval(`sxSaveAndExit()`);await sleep(100);
  T.ok(!win.document.getElementById('student-wrapper').innerHTML.includes('Progress saved</h2>'),'mid-section exit refused');
  T.eq(win.eval(`APP.currentStudentExam.sub.sectionState.phase`),'active','still in the section');
  T.ok(!win.document.getElementById('student-wrapper').innerHTML.includes('Save &amp; exit'),'no Save & exit link shown mid-section');
  T.ok(errors.length===0,'no page errors: '+errors.join('|').slice(0,200));
  process.exit(T.done()||0);
})();
