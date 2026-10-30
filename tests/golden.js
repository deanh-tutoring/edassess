// Prints a deterministic snapshot of legacy scoring behaviour for a project dir.
const {makeServer,boot}=require('./boot');
const F=require('./fixtures');
(async()=>{
  const dir=process.argv[2];
  const server=makeServer(dir);
  server.seed({tests:[F.legacyTest()],assignments:[F.legacyAssignment()],submissions:[],peerSessions:[]});
  const {win}=await boot({projectDir:dir,server});
  const out=win.eval(`(function(){
    const t=APP.tests[0];
    const cases=[
      {answers:{}},
      {answers:{'0':0,'1':1,'2':2,'3':[0,2],'4':'42','p5_s0':3,'p5_s1':'yes'}},
      {answers:{'0':1,'1':1,'3':[2,0],'4':' 42 ','p5_s1':'YES'}},
      {answers:{'3':[0]},mcOverrides:{'3':1,'0':1}},
      {answers:{'6':'<p>essay</p>'},rubricScores:{'6':{0:2,1:1.5}}},
      {answers:{'6':'x'},manualScores:{'6':3}},
      {answers:{'0':0},rubricScores:{'6':{0:1,1:1}},manualScores:{'6':4},mcOverrides:{'4':0.5}},
    ];
    return {total:calcTotalPoints(t),cases:cases.map(c=>{const s=Object.assign({id:'x',testId:t.id,status:'submitted'},JSON.parse(JSON.stringify(c)));autoScore(s,t);return {score:s.score,needsGrading:needsGrading(s,t)};}),
      flat:flatQuestions(t).map(f=>f.key)};
  })()`);
  console.log(JSON.stringify(out));
  process.exit(0);
})();
