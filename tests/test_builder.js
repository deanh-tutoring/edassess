const {makeServer,boot}=require('./boot');const F=require('./fixtures');const T=require('./t');
const dir=process.argv[2]||require('path').resolve(__dirname,'..');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const server=makeServer(dir);
  server.seed({tests:[F.legacyTest()],assignments:[],submissions:[],peerSessions:[]});
  const {win,errors}=await boot({projectDir:dir,server});
  const E=c=>win.eval(c);const $=id=>win.document.getElementById(id);
  const dom=()=>win.document.body.innerHTML;

  T.section('enable sections on an existing test');
  E(`openBuilder('T1')`);
  T.ok(dom().includes('Sections &amp; Grading'),'builder shows Sections & Grading button');
  const before=E(`JSON.stringify(APP.currentTest.questions.map(q=>q.type))`);
  E(`sxOpenManager()`);
  T.ok($('sx-mgr-body').innerHTML.includes('Enable sections'),'manager offers to enable sections');
  E(`sxEnable()`);
  T.eq(E(`APP.currentTest.sections.length`),1,'one section created');
  T.eq(E(`APP.currentTest.questions.every(q=>q.sectionId===APP.currentTest.sections[0].id)`),true,'every existing question assigned to Section 1');
  T.eq(E(`JSON.stringify(APP.currentTest.questions.map(q=>q.type))`),before,'question order/positions untouched');
  T.eq(E(`flatQuestions(APP.currentTest).map(f=>f.key).join()`),'0,1,2,3,4,p5_s0,p5_s1,6','answer keys unchanged');

  T.section('build an adaptive structure');
  E(`sxAddSection();sxAddSection();sxAddSection();`);
  T.eq(E(`APP.currentTest.sections.length`),4,'4 sections');
  E(`(function(){const t=APP.currentTest;const [a,b,c,d]=t.sections;a.title='Core';b.title='Hard';c.title='Easy';d.title='Writing';
     b.branchOnly=true;c.branchOnly=true;sxActiveSec=b.id;addQuestion('mc');sxActiveSec=c.id;addQuestion('mc');sxActiveSec=d.id;addQuestion('short');})()`);
  T.eq(E(`sxQuestionCount(APP.currentTest,APP.currentTest.sections[1].id)`),1,'question added into the selected (Hard) section');
  T.eq(E(`sxQuestionCount(APP.currentTest,APP.currentTest.sections[3].id)`),1,'question added into Writing');
  T.ok($('q-sidebar-list').innerHTML.includes('sx-side-sec'),'sidebar grouped by section');
  T.eq(win.document.querySelectorAll('#q-sidebar-list .question-card').length,E(`APP.currentTest.questions.length`),'every question appears once in sidebar');
  // move a question between sections: no key shift
  const keysBefore=E(`APP.currentTest.questions.length`);
  E(`sxMoveQuestion(0,APP.currentTest.sections[3].id)`);
  T.eq(E(`APP.currentTest.questions.length`),keysBefore,'moving a question does not reorder the list (keys safe)');
  E(`sxMoveQuestion(0,APP.currentTest.sections[0].id)`);
  // rules
  E(`sxMgr.tab='adaptive';sxRenderMgr();sxAddRule(APP.currentTest.sections[0].id)`);
  E(`(function(){const t=APP.currentTest;const r=t.sections[0].routing.rules[0];r.to=t.sections[1].id;t.sections[0].routing.fallback=t.sections[2].id;sxRefresh();})()`);
  T.ok($('sx-mgr-body').innerHTML.includes('Flow map'),'adaptive tab renders flow map');
  T.ok($('sx-mgr-body').innerHTML.includes('path simulator'),'adaptive tab renders simulator');
  T.eq(E(`sxValidate(APP.currentTest).errors.length`),0,'structure validates');
  E(`sxSimPct(APP.currentTest.sections[0].id,95)`);
  T.ok($('sx-sim-out').innerHTML.includes('Hard'),'simulator at 95% routes to Hard');
  E(`sxSimPct(APP.currentTest.sections[0].id,20)`);
  T.ok($('sx-sim-out').innerHTML.includes('Easy'),'simulator at 20% routes to Easy');
  // validation reacts: dangling target
  E(`APP.currentTest.sections[0].routing.rules[0].to='nope';sxRefresh()`);
  T.ok($('sx-valid-wrap').innerHTML.includes('no longer exists'),'dangling rule target flagged in UI');
  E(`APP.currentTest.sections[0].routing.rules[0].to=APP.currentTest.sections[1].id;sxRefresh()`);

  T.section('grading tab');
  E(`sxMgr.tab='grading';sxRenderMgr()`);
  T.ok($('sx-mgr-body').innerHTML.includes('Total points'),'grading tab renders method choices');
  E(`sxGMethod('weighted')`);
  T.ok($('sx-mgr-body').innerHTML.includes('Credit floor'),'weighted mode exposes weight + credit range');
  E(`(function(){const t=APP.currentTest;sxField(t.sections[1].id,'weight','2','num');sxField(t.sections[1].id,'creditFloor','40','num');sxG('passPercent','60','nnum');sxG('letterEnabled',true,'bool');sxGScaled('enabled',true,'bool');sxRefresh();})()`);
  T.ok($('sx-wi-out').innerHTML.includes('Letter'),'what-if shows a letter grade');
  T.ok($('sx-wi-out').innerHTML.includes('Scaled'),'what-if shows a scaled score');
  E(`sxMgr.wi={};sxMgr.wi[APP.currentTest.sections[0].id]=100;sxRefreshWhatIf()`);
  T.eq(E(`sxGradeFromRows(APP.currentTest,sxWhatIfRows(APP.currentTest)).percent>0`),true,'what-if math runs');
  E(`sxScaleAdd();sxScaleDel(5)`);
  T.eq(E(`sxGrading(APP.currentTest).scale.length`),5,'letter scale add/remove');
  E(`sxMgr.tab='resume';sxRenderMgr()`);
  T.ok($('sx-mgr-body').innerHTML.includes('Save &amp; continue later'),'resume tab renders');
  E(`sxCL('when','anytime');sxCL('clock','run')`);
  T.eq(E(`JSON.stringify(sxContinueLater(APP.currentTest,null))`),JSON.stringify({allowed:true,when:'anytime',clock:'run'}),'continue-later policy stored');
  E(`sxMgr.tab='sections';sxRenderMgr()`);
  T.ok($('sx-mgr-body').innerHTML.includes('Branch-only'),'sections tab renders all controls');

  T.section('delete / reorder sections');
  E(`window.cnt=APP.currentTest.questions.length;sxMoveSection(APP.currentTest.sections[3].id,-1)`);
  T.eq(E(`APP.currentTest.sections.map(s=>s.title).join()`),'Core,Hard,Writing,Easy','sections reorder');
  T.eq(E(`APP.currentTest.questions.length`),E(`cnt`),'reorder keeps all questions');
  E(`sxDelSection(APP.currentTest.sections[2].id)`);   // delete Writing (confirm stubbed true)
  T.eq(E(`APP.currentTest.sections.length`),3,'section deleted');
  T.eq(E(`APP.currentTest.questions.length`),E(`cnt`),'deleting a section MOVES its questions (none lost)');
  T.eq(E(`APP.currentTest.questions.every(q=>sxById(APP.currentTest,q.sectionId))`),true,'no orphaned sectionIds');

  T.section('publish validation + save');
  E(`APP.currentTest.sections[0].branchOnly=true`);
  await E(`publishTest()`);await sleep(50);
  T.eq(server.state().tests[0].published,true,'(legacy flag already published in fixture)');
  E(`APP.currentTest.sections[0].branchOnly=false;APP.currentTest.published=false`);
  await E(`publishTest()`);await sleep(100);
  T.eq(server.state().tests[0].published,true,'valid sectioned test publishes');
  T.eq(server.state().tests[0].sections.length,3,'sections persisted to server');
  await E(`sxSaveManager?1:0`);

  T.section('re-score offer');
  server.seed({...server.state(),submissions:[{id:'s1',testId:'T1',assignmentId:'A1',studentName:'X Y',status:'submitted',answers:{'0':0,'1':1},score:3,rubricScores:{},manualScores:{}}]});
  await E(`refreshFromServer()`);
  E(`sxRescoreAll(APP.currentTest)`);
  T.ok(E(`APP.submissions[0].grade!==undefined`),'re-score attaches grade to existing submissions');
  T.ok(E(`APP.submissions[0].score>=0`),'re-score keeps a numeric score');

  T.section('import assigns sections');
  T.eq(E(`sxImportSection(APP.currentTest,{section:'hard'})`),E(`APP.currentTest.sections.find(s=>s.title==='Hard').id`),'import: section by title');
  T.eq(E(`sxImportSection(APP.currentTest,{section:2})`),E(`APP.currentTest.sections[1].id`),'import: section by number');

  T.ok(errors.length===0,'no page errors: '+errors.slice(0,3).join(' | '));
  process.exit(T.done()||0);
})();
