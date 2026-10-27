const {admin,init,authenticate,accounts,accountUid}=require('./firebase.cjs');
const {createService}=require('./community-service.cjs');
const SITE='https://kkumjari-worship.vercel.app/';
let runtime;
function getRuntime(){
 init();if(runtime)return runtime;
 const db=admin.firestore();
 async function push(recipients,note){
  const targets=[];
  // Bound concurrency to avoid a per-recipient serial round trip without flooding Firestore.
  /* 받는 사람 기기 토큰을 30명씩 한 번에 조회 (사람마다 따로 조회하지 않음) */
  const uids=[...new Set((await Promise.all(recipients.map(a=>accountUid(a).catch(()=>null)))).filter(Boolean))];
  for(let i=0;i<uids.length;i+=30){const s=await db.collection('pushTokens').where('uid','in',uids.slice(i,i+30)).get();s.docs.forEach(d=>{const x=d.data();if(typeof x.token==='string'&&x.token&&(note.force===true||!['song','chat','feed'].includes(note.type||'song')||x.types?.[note.type||'song']!==false))/* 끌 수 있는 건 신청곡 · 채팅 · 꿈마당뿐 */targets.push({id:d.id,token:x.token});});}
  const unique=[...new Map(targets.map(t=>[t.token,t])).values()];let sent=0,failed=0;
  const link=SITE+'?kz_open='+encodeURIComponent(note.target)+(note.room?'&kz_room='+encodeURIComponent(note.room):'');
  for(let i=0;i<unique.length;i+=500){const chunk=unique.slice(i,i+500);const result=await admin.messaging().sendEachForMulticast({tokens:chunk.map(x=>x.token),webpush:{fcmOptions:{link}},data:{sender:note.sender||'',type:note.type||'song',title:note.title,body:note.body,link,target:note.target,room:note.room||'',tag:note.tag||('kz-'+(note.type||'song'))}});const dead=[];result.responses.forEach((x,j)=>{if(x.success)sent++;else{failed++;if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(x.error?.code))dead.push(db.doc('pushTokens/'+chunk[j].id).delete().catch(()=>{}));}});await Promise.all(dead);}
  return{sent,failed};
 }
 /* 응답을 먼저 보내고 푸시는 뒤에서: Vercel 요청 컨텍스트의 waitUntil 이 있을 때만 (없으면 기존처럼 기다림) */
 function defer(job){try{const ctx=globalThis[Symbol.for('@vercel/request-context')],c=ctx&&typeof ctx.get==='function'?ctx.get():null,wu=c&&c.waitUntil;if(typeof wu==='function'){wu(Promise.resolve(job).catch(e=>console.error('[push-bg]',e&&(e.code||e.name))));return true;}}catch{}return false;}
 runtime={db,authenticate,run:createService({db,accounts,push,defer,timestamp:n=>admin.firestore.Timestamp.fromMillis(n)})};return runtime;
}
function respondError(res,e){if(!e.status)console.error('[community]',e.code||e.name);res.status(e.status||500).json({error:e.status?e.message:'서버 연결에 실패했어요. 잠시 후 다시 시도해 주세요.'});}
module.exports={getRuntime,respondError};