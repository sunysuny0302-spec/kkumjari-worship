'use strict';
const {admin,init,authenticate}=require('../lib/firebase.cjs');
const {createAssistant}=require('../lib/assistant.cjs');
let svc;
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store, max-age=0');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'POST 요청만 가능해요.'});}
 let input;try{input=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{return res.status(400).json({error:'요청 내용을 확인해 주세요.'});}
 if(!input||typeof input!=='object'||Array.isArray(input))return res.status(400).json({error:'요청 내용을 확인해 주세요.'});
 try{
  init();const actor=await authenticate(req);
  if(!svc)svc=createAssistant({db:admin.firestore()});
  return res.status(200).json(await svc.ask(actor,input));
 }catch(e){const s=e.status||500;if(s>=500)console.error('[assistant]',e);return res.status(s).json({error:s>=500?'잠시 후 다시 물어봐 주세요.':e.message});}
};
