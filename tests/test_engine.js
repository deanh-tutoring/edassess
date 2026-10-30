const {makeServer,boot}=require('./boot');const F=require('./fixtures');const T=require('./t');
(async()=>{
  const dir=process.argv[2]||require('path').resolve(__dirname,'..');
  const server=makeServer(dir);server.seed({tests:[],assignments:[],submissions:[],peerSessions:[]});
  const {win,errors}=await boot({projectDir:dir,server});
  const E=(code)=>win.eval(code);
  win.F=F;
  // build a 3-section adaptive test in-page
  E(`window.mk=function(){
    const mc=(c,p=1)=>({type:'mc',stem:'q',options:['a','b','c','d'],correctAnswers:[c],points:p});
    const S1=sxNewSection('Module 1',{timeLimitMin:10});
    const S2h=sxNewSection('Module 2 Hard',{branchOnly:true,weight:2,creditFloor:40,creditCap:100});
    const S2e=sxNewSection('Module 2 Easy',{branchOnly:true,weight:2,creditFloor:0,creditCap:70});
    const S3=sxNewSection('Writing',{weight:1,minPercent:50});
    S1.routing={rules:[{source:'this',metric:'percent',op:'>=',value:70,to:S2h.id}],fallback:S2e.id};
    const t={id:'T',title:'Adaptive',sectioned:true,sections:[S1,S2h,S2e,S3],published:true,questions:[]};
    const add=(sec,q)=>{q.sectionId=sec.id;t.questions.push(q);};
    for(let i=0;i<4;i++)add(S1,mc(0));          // keys 0..3
    for(let i=0;i<2;i++)add(S2h,mc(1,2));       // 4,5  (2pts each)
    for(let i=0;i<2;i++)add(S2e,mc(1,2));       // 6,7
    add(S3,{type:'short',stem:'s',correctAnswers:['x'],points:1}); // 8
    add(S3,{type:'essay',stem:'e',points:4,rubric:[]});            // 9
    return {t,S1,S2h,S2e,S3};
  }`);

  T.section('structure & keys');
  E(`window.X=mk();window.t=X.t`);
  T.eq(E(`sxItems(t,X.S1.id).map(i=>i.key)`),['0','1','2','3'],'section 1 canonical keys');
  T.eq(E(`sxItems(t,X.S2h.id).map(i=>i.key)`),['4','5'],'branch hard keys');
  T.eq(E(`sxFirstSection(t)===X.S1.id`),true,'first section is first non-branch');
  T.eq(E(`sxNextCore(t,X.S1.id,[X.S1.id])===X.S3.id`),true,'default next skips branch-only sections');
  T.eq(E(`sxNextCore(t,X.S2h.id,[X.S1.id,X.S2h.id])===X.S3.id`),true,'next from a branch module goes to next core section');
  // orphan question (no sectionId) heals into the first section
  E(`t.questions.push({type:'mc',stem:'orphan',options:['a','b'],correctAnswers:[0]})`);
  T.eq(E(`sxItems(t,X.S1.id).length`),5,'orphan question lands in first section');
  E(`t.questions.pop()`);

  T.section('adaptive routing');
  const route=(answers)=>E(`(function(){const sub={id:'s',answers:${JSON.stringify(answers)}};const t=window.t;sxEnsureState(t,sub,1000);sxBegin(sub,t.sections[0].id,1000);
     const r=sxAdvance(t,{},sub,'submitted',2000);return {to:r.to,names:sub.sectionState.path.map(id=>sxById(t,id).title),d:sub.sectionState.decisions[0]};})()`);
  let r=route({'0':0,'1':0,'2':0,'3':3});   // 3/4 = 75% → hard
  T.eq(r.names,['Module 1','Module 2 Hard'],'75% routes to HARD');
  T.eq(r.d.via,'rule','decision logged as rule');
  r=route({'0':0,'1':0,'2':1,'3':1});       // 2/4 = 50% → easy (fallback)
  T.eq(r.names,['Module 1','Module 2 Easy'],'50% falls back to EASY');
  T.eq(r.d.via,'default','decision logged as default');
  r=route({'0':0,'1':0,'2':0,'3':0});       // 100% → hard
  T.eq(r.names[1],'Module 2 Hard','100% → hard');
  r=route({'0':0,'1':0,'2':0,'3':1});       // 75% boundary (>=70) → hard
  T.eq(r.names[1],'Module 2 Hard','boundary 75 >= 70');
  // exact boundary: 70 on a 10-question section
  E(`window.t2=mk().t;t2.sections[0].routing.rules[0].value=75`);
  // after hard module → next core = Writing, then end
  E(`(function(){const t=window.t;const sub={id:'s',answers:{'0':0,'1':0,'2':0,'3':0,'4':1,'5':1,'8':'x'}};sxEnsureState(t,sub,1);sxBegin(sub,t.sections[0].id,1);
     let r=sxAdvance(t,{},sub,'submitted',2);sxBegin(sub,sub.sectionState.current,3);r=sxAdvance(t,{},sub,'submitted',4);
     sxBegin(sub,sub.sectionState.current,5);const r3=sxAdvance(t,{},sub,'submitted',6);
     window.fin={path:sub.sectionState.path.map(id=>sxById(t,id).title),ended:r3.ended,completed:sub.sectionState.completed,phase:sub.sectionState.phase,sub};})()`);
  T.eq(E(`fin.path`),['Module 1','Module 2 Hard','Writing'],'full adaptive path M1→Hard→Writing');
  T.eq(E(`fin.ended&&fin.completed&&fin.phase==='done'`),true,'exam completes after last section');

  T.section('grading — total method');
  E(`t.grading={method:'total'}`);
  // M1 4/4=4pts, Hard 4/4 (2pts each)=4... use fin.sub
  let g=E(`sxComputeGrade(t,fin.sub)`);
  T.eq([g.points,g.max],[4+4+1,4+4+5],'total: sums only sections taken (Easy excluded)');
  T.eq(g.sections.map(s=>s.title),['Module 1','Module 2 Hard','Writing'],'play set = path');
  T.eq(g.pending,1,'ungraded essay counted as pending');
  E(`fin.sub.manualScores={'9':3}`);
  g=E(`sxComputeGrade(t,fin.sub)`);
  T.eq(g.points,12,'manual essay score added (4+4+1+3)');
  T.eq(g.pending,0,'pending cleared');

  T.section('grading — weighted + credit range');
  E(`t.grading={method:'weighted',totalPoints:100}`);
  g=E(`sxComputeGrade(t,fin.sub)`);
  // M1 100% w1; Hard 100% -> floor40+100%*(60)=100 w2; Writing (1+3)/5=80% w1
  T.near(g.percent,(1*100+2*100+1*80)/4,'weighted percent');
  T.eq(g.max,100,'weighted max = totalPoints');
  T.near(g.points,95,'weighted points');
  // Easy module cap 70: perfect easy only earns 70
  E(`window.fe=(function(){const sub={id:'s2',answers:{'0':0,'1':0,'2':1,'3':1,'6':1,'7':1,'8':'x'},manualScores:{'9':4}};sxEnsureState(t,sub,1);sxBegin(sub,t.sections[0].id,1);
     sxAdvance(t,{},sub,'submitted',2);sxBegin(sub,sub.sectionState.current,3);sxAdvance(t,{},sub,'submitted',4);sxBegin(sub,sub.sectionState.current,5);sxAdvance(t,{},sub,'submitted',6);return sub;})()`);
  T.eq(E(`fe.sectionState.path.map(id=>sxById(t,id).title)`),['Module 1','Module 2 Easy','Writing'],'50% student took easy');
  g=E(`sxComputeGrade(t,fe)`);
  const easy=g.sections.find(s=>s.title==='Module 2 Easy');
  T.near(easy.adjPercent,70,'perfect EASY module is capped at 70% credit');
  T.near(g.percent,(1*50+2*70+1*100)/4,'weighted percent with easy cap');

  T.section('pass / section minimums / letter / scaled');
  E(`t.grading={method:'weighted',totalPoints:100,passPercent:60,requireSectionMins:true,letterEnabled:true,scaled:{enabled:true,min:200,max:800,step:10}}`);
  g=E(`sxComputeGrade(t,fe)`);
  T.eq(g.letter,'C','letter for '+g.percent);
  T.eq(g.scaled,Math.round((200+g.percent/100*600)/10)*10,'scaled score');
  T.eq(g.passed,true,'passed at '+g.percent);
  // Writing min 50%: student scores 0 on writing → fails the section minimum despite overall pass
  E(`fe.answers['8']='no';fe.manualScores={'9':0};t.grading.passPercent=40`);   // overall ≈47.5% still clears a 40% pass mark
  g=E(`sxComputeGrade(t,fe)`);
  T.eq(g.sectionFailures.length,1,'one section below its minimum');
  T.near(g.percent,47.5,'overall percent with zeroed writing');
  T.eq(g.passed,false,'section minimum blocks overall pass even though overall ≥ pass mark');
  E(`t.grading.requireSectionMins=false`);
  T.eq(E(`sxComputeGrade(t,fe).passed`),true,'minimum ignored when requireSectionMins=false');

  T.section('unreached + unscored sections');
  E(`t.grading={method:'total'}`);
  const early=E(`(function(){const sub={id:'s3',answers:{'0':0,'1':0,'2':0,'3':0}};sxEnsureState(t,sub,1);sxBegin(sub,t.sections[0].id,1);sxMarkEnded(t,sub,'instructor',5);return sxComputeGrade(t,sub);})()`);
  T.eq(early.sections.map(s=>s.title),['Module 1','Writing'],'force-submit in M1: unreached CORE section counted (as zero), branch-only excluded');
  T.eq(early.max,4+5,'max includes unreached core section');
  E(`t.grading={method:'total',countUnreached:false}`);
  T.eq(E(`(function(){const sub={id:'s3',answers:{'0':0}};sxEnsureState(t,sub,1);sxBegin(sub,t.sections[0].id,1);sxMarkEnded(t,sub,'instructor',5);return sxComputeGrade(t,sub).max})()`),4,'countUnreached:false → only reached sections');
  E(`t.grading={method:'total'};t.sections[3].scored=false`);
  T.eq(E(`sxComputeGrade(t,fin.sub).max`),8,'unscored section excluded from the grade');
  E(`t.sections[3].scored=true`);

  T.section('routing edge cases');
  // revisit guard: S1 rule routes to itself → ends
  E(`window.t3=mk().t;t3.sections[0].routing={rules:[{source:'this',metric:'percent',op:'>=',value:0,to:t3.sections[0].id}],fallback:'next'}`);
  T.eq(E(`(function(){const sub={id:'q',answers:{}};sxEnsureState(t3,sub,1);sxBegin(sub,t3.sections[0].id,1);return sxAdvance(t3,{},sub,'submitted',2).ended})()`),true,'self-routing ends test (no infinite loop)');
  // empty target section is skipped
  E(`window.t4=mk().t;t4.questions=t4.questions.filter(q=>q.sectionId!==t4.sections[1].id)`);
  const skipTitle=E(`(function(){const sub={id:'q',answers:{'0':0,'1':0,'2':0,'3':0}};sxEnsureState(t4,sub,1);sxBegin(sub,t4.sections[0].id,1);sxAdvance(t4,{},sub,'submitted',2);return sxById(t4,sub.sectionState.current).title})()`);
  T.ok(skipTitle!=='Module 2 Hard','empty Hard module is never entered (got '+skipTitle+')');
  // cumulative + other-section sources
  E(`window.t5=mk().t;t5.sections[3].routing={rules:[{source:'cumulative',metric:'percent',op:'>=',value:80,to:'end'}],fallback:'next'};t5.sections.push(sxNewSection('Bonus',{branchOnly:true}));t5.questions.push({type:'mc',stem:'b',options:['a','b'],correctAnswers:[0],points:1,sectionId:t5.sections[4].id});t5.sections[3].routing.fallback=t5.sections[4].id`);
  // rule referencing a section that was NOT taken must not match
  E(`window.t6=mk().t;t6.sections[3].routing={rules:[{source:t6.sections[2].id,metric:'percent',op:'>=',value:0,to:'end'}],fallback:'next'}`);
  T.eq(E(`(function(){const sub={id:'q',answers:{}};sxEnsureState(t6,sub,1);const st=sub.sectionState;st.path=[t6.sections[0].id,t6.sections[1].id,t6.sections[3].id];st.current=t6.sections[3].id;st.status={};sxBegin(sub,t6.sections[3].id,1);const c=sxCtxFor(t6,sub,t6.sections[3].id);return c(t6.sections[2].id)})()`),null,'untaken source section yields null → rule skipped');

  T.section('timers, pause/resume, expiry while away');
  E(`window.tt=mk().t;window.sub=(function(){const s={id:'z',answers:{}};sxEnsureState(tt,s,0);return s})()`);
  T.eq(E(`sxRemainingSecs(tt,{},sub,tt.sections[0].id,0)`),Infinity,'not begun → no countdown');
  E(`sxBegin(sub,tt.sections[0].id,0)`);
  T.eq(E(`sxRemainingSecs(tt,{},sub,tt.sections[0].id,60000)`),540,'10 min limit, 1 min elapsed → 9:00');
  T.eq(E(`sxRemainingSecs(tt,{timeMultiplier:1.5},sub,tt.sections[0].id,60000)`),840,'1.5× accommodation → 15 min total');
  T.eq(E(`sxRemainingSecs(tt,{sectionOverrides:{[tt.sections[0].id]:{limitMin:30}}},sub,tt.sections[0].id,0)`),1800,'assignment override beats section limit');
  T.eq(E(`sxRemainingSecs(tt,{sectionOverrides:{[tt.sections[0].id]:{limitMin:null}}},sub,tt.sections[0].id,0)`),Infinity,'assignment can make a timed section untimed');
  // pause for an hour then resume → still 9:00
  E(`sxPause(tt,sub,60000)`);
  T.eq(E(`sxRemainingSecs(tt,{},sub,tt.sections[0].id,60000+3600000)`),540,'clock paused while away');
  E(`sxResume(tt,sub,60000+3600000)`);
  T.eq(E(`sxRemainingSecs(tt,{},sub,tt.sections[0].id,60000+3600000+30000)`),510,'clock resumes from 9:00');
  // clock policy "run": no pause → time keeps burning; expire while away auto-advances
  E(`window.sub2=(function(){const s={id:'z2',answers:{'0':0,'1':0,'2':0,'3':0}};sxEnsureState(tt,s,0);sxBegin(s,tt.sections[0].id,0);return s})()`);
  const en=E(`(function(){const r=sxEnforceTime(tt,{},sub2,11*60000);return {r,cur:sxById(tt,sub2.sectionState.current).title,reason:sub2.sectionState.status[tt.sections[0].id].endReason,phase:sub2.sectionState.phase}})()`);
  T.eq(en.reason,'timeout','expired section is ended with reason=timeout');
  T.eq(en.cur,'Module 2 Hard','100% before timeout still routes adaptively');
  T.eq(en.phase,'intro','next section waits at its intro (timer not started)');
  T.eq(E(`sxRemainingSecs(tt,{},sub2,sub2.sectionState.current,99999999)`),Infinity,'next section clock starts only on Begin');
  // extra seconds (instructor +time)
  E(`window.sub3=(function(){const s={id:'z3',answers:{}};sxEnsureState(tt,s,0);sxBegin(s,tt.sections[0].id,0);s.sectionState.status[tt.sections[0].id].extraSecs=300;return s})()`);
  T.eq(E(`sxRemainingSecs(tt,{},sub3,tt.sections[0].id,0)`),900,'instructor +5 min extends limit');
  // multiple sections expire back-to-back while away
  E(`window.t7=mk().t;t7.sections.forEach(s=>s.timeLimitMin=1);window.sub4=(function(){const s={id:'z4',answers:{}};sxEnsureState(t7,s,0);sxBegin(s,t7.sections[0].id,0);return s})()`);
  E(`(function(){const st=sub4.sectionState;sxEnforceTime(t7,{},sub4,1000*60*2);})()`);
  T.eq(E(`sub4.sectionState.phase`),'intro','only first expires; next section (not begun) has no running clock');

  T.section('breaks');
  E(`window.t8=mk().t;t8.sections[0].breakAfterMin=5;window.sub5=(function(){const s={id:'z5',answers:{}};sxEnsureState(t8,s,0);sxBegin(s,t8.sections[0].id,0);sxAdvance(t8,{},s,'submitted',1000);return s})()`);
  T.eq(E(`sub5.sectionState.phase`),'break','break after section');
  T.eq(E(`sub5.sectionState.breakSecs`),300,'5 minute break');
  E(`sxEnforceTime(t8,{},sub5,1000+301*1000)`);
  T.eq(E(`sub5.sectionState.phase`),'intro','break auto-ends');

  T.section('shuffle: persisted + canonical keys');
  E(`window.t9=mk().t;window.sub6={id:'sh',answers:{}}`);
  const k1=E(`sxExamItems(t9,{},sub6,t9.sections[0].id,true).map(i=>i.key)`);
  const k2=E(`sxExamItems(t9,{},sub6,t9.sections[0].id,true).map(i=>i.key)`);
  T.eq(k1,k2,'shuffle order is stable across calls (persisted)');
  T.eq([...k1].sort(),['0','1','2','3'],'shuffled items keep canonical keys');
  E(`t9.questions.push({type:'mc',stem:'new',options:['a','b'],correctAnswers:[0],sectionId:t9.sections[0].id})`);
  T.eq(E(`sxExamItems(t9,{},sub6,t9.sections[0].id,true).length`),5,'question added mid-exam is appended, not lost');

  T.section('validation');
  E(`window.tv=mk().t;tv.sections[0].routing.rules[0].to='gone'`);
  T.ok(E(`sxValidate(tv).errors.some(e=>/no longer exists/.test(e))`),'dangling routing target is an error');
  E(`window.tv2=mk().t;tv2.sections[0].branchOnly=true`);
  T.ok(E(`sxValidate(tv2).errors.some(e=>/could never start/.test(e))`),'branch-only first section is an error');
  E(`window.tv3=mk().t;tv3.sections[0].routing={rules:[],fallback:'end'}`);
  T.ok(E(`sxValidate(tv3).warnings.some(w=>/can never be reached/.test(w))`),'unreachable sections are warned');
  E(`window.tv4=mk().t;tv4.sections[1].creditFloor=90;tv4.sections[1].creditCap=50`);
  T.ok(E(`sxValidate(tv4).errors.some(e=>/credit range/.test(e))`),'inverted credit range is an error');
  T.eq(E(`sxValidate(mk().t).errors.length`),0,'the sample adaptive test validates clean');

  T.section('simulator');
  const sim=(p1)=>E(`sxSimulate(window.t,{[window.t.sections[0].id]:${p1}}).path.map(id=>sxById(window.t,id).title)`);
  T.eq(sim(90),['Module 1','Module 2 Hard','Writing'],'simulate 90% → Hard');
  T.eq(sim(40),['Module 1','Module 2 Easy','Writing'],'simulate 40% → Easy');

  T.section('legacy non-sectioned engine path');
  E(`window.lt={id:'L',title:'L',questions:[{type:'mc',stem:'a',options:['a','b'],correctAnswers:[0],points:2},{type:'mc',stem:'b',options:['a','b'],correctAnswers:[1],points:2}],grading:{method:'total',passPercent:50,letterEnabled:true}}`);
  const lg=E(`(function(){const s={id:'l',answers:{'0':0,'1':0}};autoScore(s,lt);return {score:s.score,g:s.grade};})()`);
  T.eq(lg.score,2,'legacy test + grading config keeps raw points');
  T.eq([lg.g.percent,lg.g.letter,lg.g.passed],[50,'F',true],'pass mark + letter work on non-sectioned tests');

  T.ok(errors.length===0,'no page errors: '+errors.slice(0,2).join(' | '));
  T.done();
})();
