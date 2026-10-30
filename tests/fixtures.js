// Shared fixtures
const mc=(stem,correct,points=1,n=4)=>({type:'mc',stem,options:Array.from({length:n},(_,i)=>`opt${i}`),correctAnswers:[correct],points,image:null});
const ms=(stem,correct,points=2)=>({type:'ms',stem,options:['a','b','c','d'],correctAnswers:correct,points,image:null});
const short=(stem,answers,points=1)=>({type:'short',stem,correctAnswers:answers,points,image:null});
const essay=(stem,points=5,rubric)=>({type:'essay',stem,points,rubric:rubric||[],image:null});
const passage=(subs)=>({type:'passage',docs:[{id:'d1',title:'Doc 1',content:'<p>text</p>'}],subQuestions:subs});
function legacyTest(){
  return {id:'T1',title:'Legacy Test',subject:'x',grade:'y',description:'',published:true,
    questions:[mc('Q0',0,1),mc('Q1',1,2),mc('Q2',2,3),ms('Q3',[0,2],2),short('Q4',['42'],1),
      passage([mc('P5a',3,1),short('P5b',['yes'],2)]),essay('Q6',4,[{criterion:'Clarity',maxPoints:2},{criterion:'Evidence',maxPoints:2}])],
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}
function legacyAssignment(over={}){
  return Object.assign({id:'A1',testId:'T1',releaseScores:true,timed:false,maxMinutes:60,shuffleItems:false,shuffleChoices:false,allowDesmos:false,locked:false,maxStrikes:2,ultraLockdown:false,createdAt:new Date().toISOString()},over);
}
module.exports={mc,ms,short,essay,passage,legacyTest,legacyAssignment};
