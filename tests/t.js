// minimal test helper
let pass=0,fail=0;const fails=[];
function ok(cond,msg){if(cond){pass++;}else{fail++;fails.push(msg);console.log('  ✗ FAIL:',msg);}}
function eq(a,b,msg){const A=JSON.stringify(a),B=JSON.stringify(b);ok(A===B,`${msg} — got ${A}, expected ${B}`);}
function near(a,b,msg,eps=0.051){ok(Math.abs(a-b)<=eps,`${msg} — got ${a}, expected ${b}`);}
function section(n){console.log('\n■ '+n);}
function done(){console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);}
module.exports={ok,eq,near,section,done};
