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
  for(let i=0;i<recipients.length;i+=12){await Promise.all(recipients.slice(i,i+12).map(async a=>{const uid=await accountUid(a);if(!uid)return;const s=await db.collection('pushTokens').where('uid','==',uid).get();s.docs.forEach(d=>{const x=d.data();if(typeof x.token==='string'&&x.token&&x.types?.[note.type||'song']!==false)targets.push({id:d.id,token:x.token});});}));}
  const unique=[...new Map(targets.map(t=>[t.token,t])).values()];let sent=0,failed=0;
  const link=SITE+'?kz_open='+encodeURIComponent(note.target)+(note.room?'&kz_room='+encodeURIComponent(note.room):'');
  for(let i=0;i<unique.length;i+=500){const chunk=unique.slice(i,i+500);const result=await admin.messaging().sendEachForMulticast({tokens:chunk.map(x=>x.token),webpush:{fcmOptions:{link}},data:{sender:note.sender||'',type:note.type||'song',title:note.title,body:note.body,link,target:note.target,room:note.room||'',tag:note.tag||('kz-'+(note.type||'song'))}});const dead=[];result.responses.forEach((x,j)=>{if(x.success)sent++;else{failed++;if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(x.error?.code))dead.push(db.doc('pushTokens/'+chunk[j].id).delete().catch(()=>{}));}});await Promise.all(dead);}
  return{sent,failed};
 }
 runtime={db,authenticate,run:createService({db,accounts,push,timestamp:n=>admin.firestore.Timestamp.fromMillis(n)})};return runtime;
}
function respondError(res,e){if(!e.status)console.error('[community]',e.code||e.name);res.status(e.status||500).json({error:e.status?e.message:'서버 연결에 실패했어요. 잠시 후 다시 시도해 주세요.'});}
module.exports={getRuntime,respondError};