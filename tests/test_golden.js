// Proves non-sectioned tests score EXACTLY as they did before the sections feature.
const {execFileSync}=require('child_process');const fs=require('fs');const path=require('path');
const out=execFileSync('node',[path.join(__dirname,'golden.js'),path.resolve(__dirname,'..')],{encoding:'utf8'}).trim();
const want=fs.readFileSync(path.join(__dirname,'golden_legacy.json'),'utf8').trim();
if(out!==want){console.log('✗ legacy scoring changed!\n got:',out,'\nwant:',want);process.exit(1);}
console.log('legacy scoring identical to pre-sections snapshot\n1 passed, 0 failed');
