// npm test  →  runs every suite; exits non-zero if any fail.
const {spawnSync}=require('child_process');const path=require('path');
const suites=['test_engine','test_student','test_flow2','test_builder','test_builder2','test_instructor','test_legacy','test_golden'];
let bad=0;
for(const s of suites){
  const r=spawnSync('node',[path.join(__dirname,s+'.js')],{encoding:'utf8',timeout:280000});
  const last=(r.stdout||'').trim().split('\n').pop();
  console.log(s.padEnd(18),r.status===0?last:'FAILED\n'+(r.stdout||'')+(r.stderr||''));
  if(r.status!==0)bad++;
}
process.exit(bad?1:0);
