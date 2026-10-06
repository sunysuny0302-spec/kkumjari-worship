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
   const s=await db.collection('_kzCommunity').doc('room_'+room).collection('kzChatMessages').where('expiresAt','<=',admin.firestore.Timestamp.now()).limit(400).get();if(s.empty)break;
   const batch=db.batch();s.docs.forEach(d=>batch.delete(d.ref));await batch.commit();deleted+=s.size;
  }
  return res.json({deleted});
 }catch(e){console.error('[community-cleanup]',e.code||e.name);return res.status(500).json({error:'Cleanup failed'});}
};
