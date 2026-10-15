const {timingSafeEqual}=require('node:crypto');
const {admin,init}=require('../lib/firebase.cjs');
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).end();
 const secret=process.env.CRON_SECRET,got=Buffer.from(req.headers.authorization||''),want=Buffer.from('Bearer '+(secret||''));
 if(!secret||got.length!==want.length||!timingSafeEqual(got,want))return res.status(401).json({error:'Unauthorized'});
 try{init();const db=admin.firestore();let deleted=0;
  // Two fixed room paths avoid collection-group index setup.
  for(const room of ['all','admin'])for(let i=0;i<5;i++){
   /* 보관 기간(RETENTION, 30일)이 지난 것은 지우고, 예전 기준(5일)으로 만료가 잡힌 메시지는 30일로 늘려 줌 */
   const RET=require('../lib/community-service.cjs').RETENTION,nowMs=Date.now();
   const s=await db.collection('_kzCommunity').doc('room_'+room).collection('kzChatMessages').where('expiresAt','<=',admin.firestore.Timestamp.fromMillis(nowMs+6*86400000)).orderBy('expiresAt').limit(400).get();if(s.empty)break;
   const batch=db.batch();let touched=0;s.docs.forEach(d=>{const x=d.data()||{},c=Number(x.createdAt)||0,end=c+RET;if(!c||end<=nowMs){batch.delete(d.ref);deleted++;touched++;}else{const cur=x.expiresAt&&x.expiresAt.toMillis?x.expiresAt.toMillis():0;if(Math.abs(cur-end)>60000){batch.update(d.ref,{expiresAt:admin.firestore.Timestamp.fromMillis(end)});touched++;}}});
   if(!touched)break;await batch.commit();
  }
  /* 같은 크론에서 토요 연습 미응답자 알림 (월~금 저녁 7시) */
  let remind=null;try{remind=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'rsvpRemind'});}catch(e){console.error('[rsvp-remind]',e.code||e.name||e.message);remind={error:true};}
  let ppt=null;try{ppt=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'pptRemind'});}catch(e){console.error('[ppt-remind]',e.code||e.name||e.message);ppt={error:true};}
  let serve=null;try{serve=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'serveRemind'});}catch(e){console.error('[serve-remind]',e.code||e.name||e.message);serve={error:true};}
  let ev=null;try{ev=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'eventRemind'});}catch(e){console.error('[event-remind]',e.code||e.name||e.message);ev={error:true};}
  /* 아침 생일 알림이 빠졌을 때를 대비한 보조 (이미 보냈으면 건너뜀) */
  let bday=null;try{bday=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'bdayRemind'});}catch(e){console.error('[bday-remind]',e.code||e.name||e.message);bday={error:true};}
  return res.json({deleted,remind,ppt,serve,ev,bday});
 }catch(e){console.error('[community-cleanup]',e.code||e.name);return res.status(500).json({error:'Cleanup failed'});}
};
