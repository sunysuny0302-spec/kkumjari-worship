'use strict';
/* 꿈자리 도우미: 앱 설명서(assets/assistant-kb.json)만 근거로 답하는 AI.
   ANTHROPIC_API_KEY가 없으면 {ai:false}를 돌려주고, 화면이 설명서 검색으로 답해요. */
const KB=require('../assets/assistant-kb.json');
const DAILY=Number(process.env.KZ_AI_DAILY||40);
const MODEL=process.env.KZ_AI_MODEL||'claude-haiku-5-5';
const GO_KEYS=Object.keys(KB.go);

function kbText(){return KB.items.map(x=>`### ${x.t}${x.who?` (대상: ${x.who})`:''}\n${x.a}${x.steps?'\n순서:\n'+x.steps.map((v,i)=>`${i+1}. ${v}`).join('\n'):''}${x.tips?'\n참고:\n'+x.tips.map(v=>'- '+v).join('\n'):''}${x.go?`\n관련 화면: ${x.go.map(g=>`[[go:${g}]]`).join(' ')}`:''}`).join('\n\n');}
function systemPrompt(actor){
 const who=actor?`${actor.name||'팀원'} (직책: ${actor.rank||'팀원'}${Array.isArray(actor.parts)&&actor.parts.length?', 파트: '+actor.parts.join('·'):''})`:'팀원';
 return `너는 '꿈자리 찬양팀' 앱의 도우미 "꿈자리 도우미"야. 팀원들이 앱 사용법을 물으면 관리자 대신 친절하게 답해 줘.

규칙:
- 아래 [앱 설명서]에 있는 내용만 근거로 답해. 설명서에 없는 기능·메뉴·숫자를 지어내지 마.
- 설명서로 답할 수 없거나 사람이 직접 처리해야 하는 일(승인, 임시 PIN, 계정 문제, 오류 신고 등)이면 솔직히 모른다고/직접 할 수 없다고 말하고 단장이나 관리계정에게 물어보라고 안내해.
- PIN·비밀번호를 알려 달라고 하거나 남에게 알려 주라고 하지 마. 너는 앱 데이터를 보거나 바꿀 수 없어(누가 언제 서는지 같은 실제 일정은 화면에서 확인하라고 안내).
- 존댓말 '~해요'체로, 쉽고 짧게(보통 2~5문장, 필요하면 • 목록). 메뉴 위치는 폰/컴퓨터를 구분해서 알려 줘.
- 질문한 사람의 직책에 맞춰 답해. 그 직책으로 할 수 없는 일이면 누가 할 수 있는지 알려 줘.
- 찬양팀·신앙과 관련된 가벼운 대화에는 짧고 따뜻하게 답해도 되지만, 앱과 무관한 긴 요청(숙제, 코드 등)은 정중히 사양해.
- 화면으로 바로 가는 버튼이 도움이 되면 답 맨 끝 줄에 [[go:키]]를 최대 2개 붙여. 쓸 수 있는 키: ${GO_KEYS.map(k=>`${k}(${KB.go[k]})`).join(', ')}.

질문한 사람: ${who}

[앱 설명서]
${kbText()}`;
}
function cleanHistory(h){
 if(!Array.isArray(h))return[];
 const out=[];for(const m of h.slice(-8)){if(!m||typeof m.text!=='string')continue;const role=m.role==='assistant'?'assistant':'user';const text=m.text.trim().slice(0,1200);if(!text)continue;
  if(out.length&&out[out.length-1].role===role)out[out.length-1].content+='\n'+text;else out.push({role,content:text});}
 while(out.length&&out[0].role!=='user')out.shift();
 return out;
}
function parseAnswer(raw){
 const go=[];let text=String(raw||'').replace(/\[\[go:([a-z_]+)\]\]/g,(_,k)=>{if(GO_KEYS.includes(k)&&!go.includes(k)&&go.length<2)go.push(k);return''});
 text=text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 return{text,go};
}
function fail(status,message){throw Object.assign(new Error(message),{status});}
function today(){return new Date(Date.now()+9*3600e3).toISOString().slice(0,10);}

function createAssistant({db,fetchImpl=globalThis.fetch,key=process.env.ANTHROPIC_API_KEY}={}){
 async function quota(actor){
  if(!db)return DAILY;
  const ref=db.doc('aiUsage/'+String(actor.uid||actor.id));
  return db.runTransaction(async tx=>{const s=await tx.get(ref),d=s.exists?s.data():{},n=d.d===today()?Number(d.n||0):0;
   if(n>=DAILY)fail(429,`오늘은 도우미에게 ${DAILY}번까지 물어볼 수 있어요. 내일 다시 물어보거나 단장·관리계정에게 물어봐 주세요.`);
   tx.set(ref,{d:today(),n:n+1,at:Date.now()});return DAILY-n-1;});
 }
 async function ask(actor,input){
  const q=typeof input.q==='string'?input.q.trim():'';
  if(!q)fail(400,'질문을 적어 주세요.');if(q.length>600)fail(400,'질문은 600자까지 적을 수 있어요.');
  if(!key)return{ai:false};
  const left=await quota(actor);
  const messages=[...cleanHistory(input.history),{role:'user',content:q}];
  if(messages.length>1&&messages[messages.length-2].role==='user'){const last=messages.pop();messages[messages.length-1].content+='\n'+last.content;}
  const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),25000);
  let r;try{r=await fetchImpl('https://api.anthropic.com/v1/messages',{method:'POST',signal:ctl.signal,headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
   body:JSON.stringify({model:MODEL,max_tokens:700,system:[{type:'text',text:systemPrompt(actor),cache_control:{type:'ephemeral'}}],messages})});}
  catch(e){return{ai:false,error:'도우미 연결이 늦어요.'}}finally{clearTimeout(tm)}
  if(!r.ok){let detail='';try{detail=(await r.text()).slice(0,200)}catch(_){}console.warn('[assistant]',r.status,detail);return{ai:false,error:'도우미가 잠시 쉬고 있어요.'}}
  const j=await r.json();const raw=(j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const out=parseAnswer(raw);if(!out.text)return{ai:false};
  return{ai:true,answer:out.text,go:out.go,left};
 }
 return{ask};
}
module.exports={createAssistant,systemPrompt,parseAnswer,cleanHistory,KB};
