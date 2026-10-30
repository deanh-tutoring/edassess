// 3-section adaptive fixture as plain JSON
const F=require('./fixtures');
function adaptiveTest(over={}){
  const mc=(c,p=1)=>({type:'mc',stem:'q',options:['a','b','c','d'],correctAnswers:[c],points:p});
  const secs=[
    {id:'S1',title:'Module 1',directions:'Answer **all** questions.',timeLimitMin:10,navigation:'free',shuffleItems:null,shuffleChoices:null,calculator:'inherit',showReference:true,breakAfterMin:null,scored:true,weight:1,creditFloor:0,creditCap:100,minPercent:null,branchOnly:false,routing:{rules:[{source:'this',metric:'percent',op:'>=',value:70,to:'S2H'}],fallback:'S2E'}},
    {id:'S2H',title:'Module 2 Hard',directions:'',timeLimitMin:null,navigation:'forward',scored:true,weight:2,creditFloor:40,creditCap:100,branchOnly:true,routing:{rules:[],fallback:'next'}},
    {id:'S2E',title:'Module 2 Easy',directions:'',timeLimitMin:null,navigation:'free',scored:true,weight:2,creditFloor:0,creditCap:70,branchOnly:true,routing:{rules:[],fallback:'next'}},
    {id:'S3',title:'Writing',directions:'',timeLimitMin:null,navigation:'free',scored:true,weight:1,minPercent:null,branchOnly:false,routing:{rules:[],fallback:'next'}},
  ];
  const qs=[];const add=(sid,q)=>{q.sectionId=sid;qs.push(q);};
  for(let i=0;i<4;i++)add('S1',mc(0));
  for(let i=0;i<2;i++)add('S2H',mc(1,2));
  for(let i=0;i<2;i++)add('S2E',mc(1,2));
  add('S3',{type:'short',stem:'s',correctAnswers:['x'],points:1});
  add('S3',{type:'essay',stem:'e',points:4,rubric:[]});
  return Object.assign({id:'T2',title:'Adaptive Test',subject:'',grade:'',description:'',published:true,sectioned:true,sections:secs,questions:qs,
    grading:{method:'total'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},over);
}
module.exports={adaptiveTest};
