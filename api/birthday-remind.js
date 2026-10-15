const {timingSafeEqual}=require('node:crypto');
/* 매일 아침(한국 시간 9시대) 생일 알림. 같은 날 두 번 보내지 않도록 서버에서 기록해요. */
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).end();
 const secret=process.env.CRON_SECRET,got=Buffer.from(req.headers.authorization||''),want=Buffer.from('Bearer '+(secret||''));
 if(!secret||got.length!==want.length||!timingSafeEqual(got,want))return res.status(401).json({error:'Unauthorized'});
 try{const out=await require('../lib/community-runtime.cjs').getRuntime().run({system:true},{action:'bdayRemind'});return res.json(out);}
 catch(e){console.error('[birthday-remind]',e.code||e.name||e.message);return res.status(500).json({error:'Birthday reminder failed'});}
};
