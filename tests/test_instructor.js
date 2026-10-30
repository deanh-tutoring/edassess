const {makeServer,boot}=require('./boot');const F=require('./fixtures');const {adaptiveTest}=require('./fx2');const T=require('./t');
const dir=process.argv[2]||require('path').resolve(__dirname,'..');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const server=makeServer(dir);
  const A={id:'A2',testId:'T2',releaseScores:true,timed:false,maxMinutes:60,shuffleItems:false,shuffleChoices:false,allowDesmos:false,locked:false,maxStrikes:2,createdAt:new Date().toISOString()};
  const test=adaptiveTest({grading:{method:'weighted',totalPoints:100,passPercent:60,letterEnabled:true,scaled:{enabled:true,min:200,max:800,step:10}},continueLater:{allowed:true,when:'anytime',clock:'pause'}});
  server.seed({tests:[test],assignments:[A],submissions:[],peerSessions:[]});

  T.section('submit an adaptive exam as a student, then review as instructor');
  let {win}=await boot({projectDir:dir,server,query:'?exam=A2'});
  win.document.getElementById('student-name-input').value='Eve R';win.eval(`startExam('A2')`);await sleep(30);
  const run=async(code)=>{win.eval(code);for(let i=0;i<200;i++){if(!win.eval('_sxBusy'))break;await sleep(15);}await sleep(30);};
  await run(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;['0','1','2'].forEach(k=>sub.answers[k]=0);sub.answers['3']=1;sxFinishSection('submitted')`);
  await run(`sxBeginSectionUI();examItems().forEach(f=>sub.answers[f.key]=1);sxFinishSection('submitted')`);
  await run(`sxBeginSectionUI();sub.answers['8']='x';sub.answers['9']='<p>essay</p>';sxFinishSection('submitted')`);
  const html=win.document.getElementById('student-wrapper').innerHTML;
  T.ok(html.includes('Submitted.'),'student sees the submitted screen');
  T.ok(html.includes('Grade '),'submitted screen shows letter grade');
  T.ok(html.includes('Module 1')&&html.includes('Writing'),'submitted screen shows section scores');
  T.ok(!html.includes('Module 2 Easy'),'…but not sections never taken');

  ({win}=await boot({projectDir:dir,server}));
  const E=c=>win.eval(c);const sid=server.state().submissions[0].id;
  T.eq(E(`APP.submissions.length`),1,'instructor sees the submission');
  E(`openGradingStudent('${sid}')`);
  let m=win.document.getElementById('modal-container').innerHTML;
  T.ok(m.includes('Adaptive path'),'grader shows the adaptive path');
  T.ok(m.includes('rule 1 matched'),'grader explains WHY the student was routed (rule matched)');
  T.ok(m.includes('Module 2 Hard')&&!m.includes('>Module 2 Easy<'),'grader only lists sections the student took');
  T.ok(m.includes('awaiting grading'),'grader flags the ungraded essay');
  T.eq((m.match(/Instructor Comment/g)||[]).length,8,'exactly 8 question cards: Module 1 (4) + Hard (2) + Writing (2); none from the Easy module');
  // grade the essay → score + grade update
  const before=E(`APP.submissions[0].score`);
  E(`setManualScore('${sid}','9',4,4)`);
  T.ok(E(`APP.submissions[0].score`)>before,'grading the essay raises the weighted score');
  T.eq(E(`APP.submissions[0].grade.pending`),0,'no pending questions remain');
  E(`closeModal()`);
  // results page
  E(`loadStudentResults('${sid}')`);
  const r=win.document.getElementById('student-wrapper').innerHTML;
  T.ok(r.includes('Question Review')&&r.includes('Module 1'),'results page groups questions under section headers');
  T.ok(r.includes('Grade '),'results page shows grade');

  T.section('live monitor + control panel');
  // in-progress, sectioned, paused student
  E(`(function(){const t=APP.tests[0];const s={id:'live1',testId:t.id,assignmentId:'A2',studentName:'Fay Q',status:'in-progress',startedAt:new Date().toISOString(),answers:{'0':0},flags:{},score:0,rubricScores:{},manualScores:{},strikes:0};sxEnsureState(t,s,Date.now());sxBegin(s,'S1',Date.now());sxPause(t,s,Date.now());APP.submissions.push(s);})()`);
  const live=E(`renderLiveList(APP.submissions)`);
  T.ok(live.includes('Saved · away'),'paused student shows "Saved · away"');
  T.ok(live.includes('Module 1'),'live row shows current section');
  E(`openStudentControl('live1')`);
  T.ok(win.document.getElementById('modal-container').innerHTML.includes('+5 min'),'control modal offers +time for sectioned test');
  E(`closeModal()`);

  T.section('assign modal: section overrides, multiplier, continue-later');
  E(`openAssignModal('T2')`);
  T.ok(win.document.getElementById('modal-container').innerHTML.includes('Section timing'),'assign modal shows Section timing');
  win.document.querySelector('.as-sx-lim[data-sec="S1"]').value='25';
  win.document.getElementById('as-sx-mult').value='1.5';
  win.document.getElementById('as-sx-cl').checked=false;
  await E(`createAssignment('T2')`);await sleep(120);
  const na=server.state().assignments.find(x=>x.id!=='A2');
  T.eq(na.sectionOverrides,{S1:{limitMin:25}},'override stored');
  T.eq(na.timeMultiplier,1.5,'multiplier stored');
  T.eq(na.continueLater,false,'continue-later switched off for this assignment');
  T.eq(na.timed,false,'overall timer off for sectioned tests');
  T.eq(E(`sxRemainingSecs(APP.tests[0],${JSON.stringify(na)},{sectionState:{status:{S1:{startedAt:'x',activeMs:0,resumedAt:null}}}},'S1',0)`),Math.round(25*60*1.5),'override × multiplier = 37.5 min');
  T.eq(E(`sxContinueLater(APP.tests[0],${JSON.stringify(na)}).allowed`),false,'assignment can disable continue-later');
  // legacy test: no section block
  server.seed({...server.state(),tests:[...server.state().tests,F.legacyTest()]});await E(`refreshFromServer()`);
  E(`openAssignModal('T1')`);
  T.ok(!win.document.getElementById('modal-container').innerHTML.includes('Section timing'),'legacy test: assign modal unchanged');
  T.ok(win.document.getElementById('as-timed').closest('.assign-section').style.display!=='none','legacy test: normal Timing block visible');
  E(`closeModal()`);

  T.section('analytics + dashboard');
  const an=E(`renderAnalyticsContent()`);
  T.ok(an.includes('Section Performance'),'analytics shows section performance & routing');
  T.ok(an.includes('Module 2 Hard: 1'),'analytics counts where students were routed');
  T.eq(E(`typeof renderDashboard()`),'undefined','dashboard renders without error');

  T.section('instructor ops: +time and end-section reach a live student');
  server.seed({tests:[test],assignments:[A],submissions:[],peerSessions:[]});
  let st;({win:st}=await boot({projectDir:dir,server,query:'?exam=A2'}));
  st.document.getElementById('student-name-input').value='Gus T';st.eval(`startExam('A2')`);await sleep(30);
  st.eval(`sxBeginSectionUI();sub=APP.currentStudentExam.sub;sub.answers['0']=0;sub.answers['1']=0;sub.answers['2']=0;sub.answers['3']=0;save()`);await sleep(50);
  const subId=st.eval('sub.id');
  const base=st.eval(`sxRemainingSecs(APP.currentStudentExam.t,APP.currentStudentExam.a,sub,'S1',Date.now())`);
  // instructor window
  let ins;({win:ins}=await boot({projectDir:dir,server}));
  T.eq(await ins.eval(`sxInstructorOp('${subId}','addTime',{sectionId:'S1',secs:300},'ok')`),true,'instructor sends +5 min');
  // race: the student autosaves AFTER the instructor's op landed (stale copy has no ops)
  st.eval(`sub.answers['3']=0;save()`);await sleep(150);
  T.ok((server.state().submissions[0].instructorOps||[]).length===1,'student autosave did NOT erase the instructor op');
  for(let i=0;i<80;i++){if(st.eval(`(sub.appliedOps||[]).length`)>0)break;await sleep(100);}
  T.eq(st.eval(`(sub.appliedOps||[]).length`),1,'student applied the op (polled within ~4s)');
  const after=st.eval(`sxRemainingSecs(APP.currentStudentExam.t,APP.currentStudentExam.a,sub,'S1',Date.now())`);
  T.ok(after-base>=295,'student has ~5 more minutes ('+(after-base)+'s)');
  await sleep(200);
  T.eq(server.state().submissions[0].sectionState.status.S1.extraSecs,300,'extra time persisted on the submission');
  // end section
  await ins.eval(`sxInstructorOp('${subId}','endSection',{sectionId:'S1'},'ok')`);
  for(let i=0;i<90;i++){if(st.eval(`sub.sectionState.status.S1.endedAt`))break;await sleep(100);}
  T.eq(st.eval(`sub.sectionState.status.S1.endReason`),'instructor','section ended by instructor');
  T.eq(st.eval(`sub.sectionState.current`),'S2H','…and adaptive routing still applied (100% → Hard)');
  // applied once only
  await sleep(4500);
  T.eq(st.eval(`sub.appliedOps.length`),2,'each op applied exactly once (no replay on later polls)');

  T.section('server validation');
  const bad=await ins.eval(`apiPost({action:'instructorOp',submissionId:'${subId}',op:{type:'addTime',secs:-5}})`);
  T.ok(bad&&bad.__httpError&&bad.status===400,'negative time rejected');
  const bad2=await ins.eval(`apiPost({action:'instructorOp',submissionId:'${subId}',op:{type:'format-disk'}})`);
  T.ok(bad2&&bad2.__httpError&&bad2.status===400,'unknown op type rejected');
  const bad3=await ins.eval(`apiPost({action:'instructorOp',submissionId:'nope',op:{type:'addTime',secs:60}})`);
  T.ok(bad3&&bad3.__httpError&&bad3.status===404,'unknown submission → 404');
  process.exit(T.done()||0);
})();
