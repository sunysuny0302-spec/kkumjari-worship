const {getRuntime,respondError}=require('../lib/community-runtime.cjs');
const ACTIONS=new Set(['status','inbox','read','chat','send','songs','songCreate','songUpdate','songDelete','songComplete']);
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Vary','Authorization');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'POST 요청만 가능해요.'});}
 try{const input=typeof req.body==='string'?JSON.parse(req.body):req.body;
  if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>16000||!ACTIONS.has(input.action))return res.status(400).json({error:'요청 내용을 확인해 주세요.'});
  const rt=getRuntime(),actor=await rt.authenticate(req);return res.status(200).json(await rt.run(actor,input));
 }catch(e){if(e instanceof SyntaxError)return res.status(400).json({error:'요청 내용을 확인해 주세요.'});respondError(res,e);}
};
