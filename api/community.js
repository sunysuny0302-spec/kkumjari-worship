'use strict';
const {getRuntime,respondError}=require('../lib/community-runtime.cjs');
const ACTIONS=new Set(['rsvpGet','rsvpSet','rsvpTargets','myAttendance','presence','members','readAll','profileGet','profileSave','profiles','chatPreference','chatImages','status','inbox','read','chat','send','songs','songCreate','songUpdate','songDelete','songComplete']);
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Vary','Authorization');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'POST 요청만 가능해요.'});}
 let input;
 try{
  if(typeof req.body==='string'&&Buffer.byteLength(req.body,'utf8')>750000)return res.status(413).json({error:'요청이 너무 커요. 이미지 크기와 개수를 줄여 주세요.'});
  input=typeof req.body==='string'?JSON.parse(req.body):req.body;
 }catch{return res.status(400).json({error:'요청 내용을 확인해 주세요.'});}
 if(!input||typeof input!=='object'||Array.isArray(input)||!ACTIONS.has(input.action))return res.status(400).json({error:'요청 내용을 확인해 주세요.'});
 try{
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>750000)return res.status(413).json({error:'요청이 너무 커요. 이미지 크기와 개수를 줄여 주세요.'});
  const rt=getRuntime(),actor=await rt.authenticate(req);return res.status(200).json(await rt.run(actor,input));
 }catch(e){if(e.status===429)res.setHeader('Retry-After','1');respondError(res,e);}
};
