const {admin,init,authenticate,accounts,accountUid}=require('./firebase.cjs');
const {createService}=require('./community-service.cjs');
const SITE='https://kkumjari-worship.vercel.app/';
let runtime;
function getRuntime(){
 init();if(runtime)return runtime;
 const db=admin.firestore();
 async function push(recipients,note){
  const targets=[];
  for(const a of recipients){const uid=await accountUid(a);if(!uid)continue;const s=await db.collection('pushTokens').where('uid','==',uid).get();s.docs.forEach(d=>{const x=d.data();if(typeof x.token==='string'&&x.token&&x.types?.[note.type||'song']!==false)targets.push({id:d.id,token:x.token});});}
  const unique=[...new Map(targets.map(t=>[t.token,t])).values()];let sent=0,failed=0;
  const link=SITE+'?kz_open='+encodeURIComponent(note.target)+(note.room?'&kz_room='+encodeURIComponent(note.room):'');
  for(let i=0;i<unique.length;i+=500){const chunk=unique.slice(i,i+500);const result=await admin.messaging().sendEachForMulticast({tokens:chunk.map(x=>x.token),webpush:{notification:{title:note.title,body:note.body,icon:'/icon-192.png',badge:'/icon-192.png',tag:note.tag||((note.type||'song')+'-'+Date.now())},fcmOptions:{link}},data:{type:note.type||'song',title:note.title,body:note.body,link,target:note.target}});const dead=[];result.responses.forEach((x,j)=>{if(x.success)sent++;else{failed++;if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(x.error?.code))dead.push(db.doc('pushTokens/'+chunk[j].id).delete().catch(()=>{}));}});await Promise.all(dead);}
  return{sent,failed};
 }
 runtime={db,authenticate,run:createService({db,accounts,push,timestamp:n=>admin.firestore.Timestamp.fromMillis(n)})};return runtime;
}
function respondError(res,e){if(!e.status)console.error('[community]',e.code||e.name);res.status(e.status||500).json({error:e.status?e.message:'서버 연결에 실패했어요. 잠시 후 다시 시도해 주세요.'});}
module.exports={getRuntime,respondError};