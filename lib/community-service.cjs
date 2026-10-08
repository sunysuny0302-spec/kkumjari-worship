'use strict';
const {validateImages,summary}=require('./chat-images.cjs');
const ADMIN=new Set(['관리계정','단장','인도자','선임싱어','선임세션']);
const RETENTION=5*86400000;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(400,`${label}을 확인해 주세요.`);return value.trim();}
// Stored IDs include an account ID plus the client request ID. Firebase UIDs
// may contain characters other than letters, and can be 128 characters long.
function id(value){if(typeof value!=='string'||!value||value==='.'||value==='..'||/[\/\u0000-\u001f\u007f]/u.test(value)||Buffer.byteLength(value,'utf8')>1500)fail(400,'잘못된 항목이에요.');return value;}
function requestId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(value))fail(400,'요청 번호를 확인해 주세요.');return value;}
function videoUrl(value){const s=text(value,2000,'영상 링크');let u;try{u=new URL(s);}catch{fail(400,'올바른 영상 링크를 입력해 주세요.');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)fail(400,'http 또는 https 영상 링크만 사용할 수 있어요.');return u.href;}
function roomAccess(actor,room){if(!['all','admin'].includes(room))fail(400,'채팅방을 확인해 주세요.');if(room==='admin'&&!ADMIN.has(actor.rank))fail(403,'관리자급만 들어갈 수 있는 방이에요.');}
function songAccess(actor,song,op){if(op==='complete'){if(!['인도자','관리계정'].includes(actor.rank))fail(403,'인도자만 콘티 반영을 완료할 수 있어요.');}else if(song.owner!==actor.id)fail(403,'신청한 본인만 수정하거나 삭제할 수 있어요.');}
function createService({db,accounts,push=async()=>({sent:0}),now=Date.now,timestamp=n=>new Date(n)}){
 const root=db.collection('_kzCommunity');
 const messages=room=>root.doc('room_'+room).collection('kzChatMessages');
 const inbox=who=>root.doc('inbox_'+who).collection('items');
 const songs=root.doc('songs').collection('items');
 const prefs=who=>root.doc('chatPrefs_'+id(who));
 async function enabled(who,room){const p=await prefs(who).get();return !p.exists||p.data()[room]!==false;}
 const packet=d=>({...d.data(),id:d.id});
 const leader=a=>['인도자','관리계정'].includes(a.rank);
 async function roster(){return(await accounts()).filter(a=>a.status==='approved');}
 async function limited(tx,actor,key,interval){const ref=root.doc('rate_'+actor.id+'_'+key),s=await tx.get(ref),time=now();if(s.exists&&time-Number(s.data().at)<interval)fail(429,'잠시 후 다시 시도해 주세요.');tx.set(ref,{at:time});}
 // A value cursor remains valid even when cleanup or another reader deletes
 // the last document of the previous page. Legacy document cursors still work.
 function cursorFor(doc){return 'v1.'+Buffer.from(JSON.stringify([doc.data().createdAt,doc.id])).toString('base64url');}
 async function list(col,input,size=60,cutoff=null){
  let q=col.orderBy('createdAt','desc').orderBy('__name__','desc');
  if(cutoff!==null)q=q.where('createdAt','>',cutoff);
  if(input.cursor){
   if(typeof input.cursor!=='string'||input.cursor.length>4096)fail(400,'이전 목록 위치가 올바르지 않아요.');
   if(input.cursor.startsWith('v1.')){
    let c;try{c=JSON.parse(Buffer.from(input.cursor.slice(3),'base64url').toString('utf8'));}catch{fail(400,'이전 목록 위치가 올바르지 않아요.');}
    if(!Array.isArray(c)||c.length!==2||!Number.isFinite(c[0])||c[0]<0)fail(400,'이전 목록 위치가 올바르지 않아요.');
    q=q.startAfter(c[0],id(c[1]));
   }else{const previous=await col.doc(id(input.cursor)).get();if(!previous.exists)fail(409,'목록이 변경됐어요. 닫았다가 다시 열어 주세요.');q=q.startAfter(previous);}
  }
  const s=await q.limit(size+1).get(),docs=s.docs.slice(0,size);
  return{items:docs.map(packet),cursor:s.docs.length>size?cursorFor(docs.at(-1)):null};
 }
 function notices(tx,recipients,key,note){if(recipients.length>450)fail(503,'알림 대상이 너무 많아요. 관리자에게 문의해 주세요.');for(const a of recipients)tx.set(inbox(a.id).doc(key),{...note,createdAt:now()});}
 async function safePush(recipients,note){try{return await push(recipients,note);}catch{return{sent:0,pushFailed:true};}}
 return async function run(actor,input){
  if(!actor||actor.status!=='approved')fail(403,'승인된 계정으로 로그인해 주세요.');
  id(actor.id);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'요청 내용을 확인해 주세요.');
  const action=input.action;
 const readState=root.doc('inboxState_'+actor.id);
 const readThrough=async()=>{const s=await readState.get();return s.exists?Number(s.data().readThrough)||0:0;};
  if(action==='presence'){
   const session=id(input.session);if(typeof input.active!=='boolean')fail(400,'활동 상태를 확인해 주세요.');
   const ref=root.doc('presence_'+actor.id),time=now();
   await db.runTransaction(async tx=>{const old=await tx.get(ref),sessions=Object.fromEntries(Object.entries(old.exists?old.data().sessions||{}:{}).filter(([k,t])=>Number(t)>time-65000));
    if(input.active)sessions[session]=time;else delete sessions[session];
    tx.set(ref,{sessions:Object.fromEntries(Object.entries(sessions).sort((a,b)=>b[1]-a[1]).slice(0,12))});
   });return{ok:true};
  }
  if(action==='members'){
   const members=await roster(),time=now();
   const items=await Promise.all(members.map(async a=>{const state=await root.doc('presence_'+a.id).get();return{id:a.id,name:a.name,rank:a.rank,online:state.exists&&Object.values(state.data().sessions||{}).some(t=>Number(t)>time-65000)};}));
   return{items:items.sort((a,b)=>Number(b.online)-Number(a.online)||a.name.localeCompare(b.name,'ko'))};
  }
  if(action==='profileGet'){const p=await root.doc('profile_'+actor.id).get();return{photo:p.exists?p.data().photo||'':''};}
  if(action==='profileSave'){
   const photo=input.photo===''?'':validateImages([input.photo])[0];
   if(photo.length>24000)fail(400,'프로필 사진 크기를 줄여 주세요.');
   await db.runTransaction(async tx=>{tx.set(root.doc('profile_'+actor.id),{photo,updatedAt:now()});});return{photo};
  }
  if(action==='profiles'){
   if(!Array.isArray(input.ids)||input.ids.length>30)fail(400,'프로필 요청을 확인해 주세요.');
   const ids=[...new Set(input.ids.map(id))];
   const profiles=await Promise.all(ids.map(async who=>{const p=await root.doc('profile_'+who).get();return{id:who,photo:p.exists?p.data().photo||'':''};}));return{profiles};
  }
  if(action==='status'){const through=await readThrough(),s=await inbox(actor.id).where('createdAt','>',through).orderBy('createdAt','desc').get();return{unread:s.docs.filter(d=>!d.data().readAt).length,account:{id:actor.id,name:actor.name,rank:actor.rank},admin:ADMIN.has(actor.rank),leader:leader(actor)};}
  if(action==='inbox'){const through=await readThrough(),result=await list(inbox(actor.id),input,60,through);result.items=result.items.filter(n=>!n.readAt).map(n=>({...n,read:false}));return result;}
  if(action==='readAll'){const through=now();await db.runTransaction(async tx=>{const s=await tx.get(readState);tx.set(readState,{readThrough:Math.max(through,s.exists?Number(s.data().readThrough)||0:0)});});return{ok:true,readThrough:through};}
  if(action==='read'){const ref=inbox(actor.id).doc(id(input.id));return db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)fail(404,'알림을 찾을 수 없어요.');const note=packet(s);tx.delete(ref);return{note:{...note,read:true}};});}
  if(action==='chatPreference'){
   roomAccess(actor,input.room);if(typeof input.enabled!=='boolean')fail(400,'알림 설정을 확인해 주세요.');
   await db.runTransaction(async tx=>{const ref=prefs(actor.id),old=await tx.get(ref);tx.set(ref,{...(old.exists?old.data():{}),[input.room]:input.enabled});});return{enabled:input.enabled};
  }
  if(action==='chat'){roomAccess(actor,input.room);const [result,notificationsEnabled]=await Promise.all([list(messages(input.room),input,30,now()-RETENTION),enabled(actor.id,input.room)]);result.items=result.items.map(summary).reverse();return {...result,notificationsEnabled};}
  if(action==='chatImages'){roomAccess(actor,input.room);const s=await messages(input.room).doc(id(input.id)).get();if(!s.exists||s.data().createdAt<=now()-RETENTION)fail(404,'삭제되었거나 보관 기간이 지난 이미지예요.');return{images:s.data().images||[]};}
  if(action==='send'){
   roomAccess(actor,input.room);const images=validateImages(input.images),key=requestId(input.id),content=typeof input.text==='string'?input.text.trim():'';
   if(content.length>2000||(!content&&!images.length))fail(400,'메시지나 이미지를 넣어 주세요.');
   const ref=messages(input.room).doc(id(actor.id+'_'+key));
   const members=(await roster()).filter(a=>a.id!==actor.id&&(input.room==='all'||ADMIN.has(a.rank)));
   const recipients=(await Promise.all(members.map(async a=>await enabled(a.id,input.room)?a:null))).filter(Boolean);
   const note={title:actor.name,sender:actor.name,body:(content||('사진 '+images.length+'장')).slice(0,160),target:'community',room:input.room,type:'chat',tag:'chat-'+input.room};
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(ref);
    if(old.exists){const saved=old.data();if(saved.text!==content||JSON.stringify(saved.images||[])!==JSON.stringify(images))fail(409,'같은 요청 번호로 다른 메시지를 보낼 수 없어요. 새 메시지로 보내 주세요.');return{item:summary(packet(old)),duplicate:true};}
    const time=now(),item={owner:actor.id,name:actor.name,text:content,images,createdAt:time,expiresAt:timestamp(time+RETENTION)};
    await limited(tx,actor,'chat',1000);tx.set(ref,item);notices(tx,recipients,'chat_'+ref.id,note);return{item:summary({id:ref.id,...item})};
   });
   if(!result.duplicate)result.push=await safePush(recipients,note);
   return result;
  }
  if(action==='songs')return list(songs,input);
  if(action==='songCreate'){
   const key=requestId(input.id),ref=songs.doc(id(actor.id+'_'+key)),title=text(input.title,120,'곡 제목'),url=videoUrl(input.url),recipients=(await roster()).filter(leader);
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(ref);if(old.exists)return{item:packet(old),duplicate:true};
    await limited(tx,actor,'song',10000);const time=now(),item={owner:actor.id,name:actor.name,title,url,createdAt:time,updatedAt:time,revision:1};
    tx.set(ref,item);notices(tx,recipients,'song_'+ref.id,{title:'찬양 신청',body:actor.name+' · '+title,target:'song_requests',type:'song',songId:ref.id});return{item:{id:ref.id,...item}};
   });
   if(!result.duplicate)result.push=await safePush(recipients,{title:'찬양 신청',body:actor.name+' · '+title,target:'song_requests',type:'song'});return result;
  }
  if(['songUpdate','songDelete','songComplete'].includes(action)){
   const ref=songs.doc(id(input.id));return db.runTransaction(async tx=>{
    const s=await tx.get(ref);if(!s.exists)fail(404,'이미 삭제되거나 콘티에 반영된 신청곡이에요.');const item=s.data();songAccess(actor,item,action==='songComplete'?'complete':'owner');
    if(input.revision!==item.revision)fail(409,'신청곡이 변경됐어요. 새로고침 후 다시 확인해 주세요.');
    if(action==='songUpdate')tx.update(ref,{title:text(input.title,120,'곡 제목'),url:videoUrl(input.url),updatedAt:now(),revision:item.revision+1});
    else{tx.delete(ref);if(action==='songComplete')notices(tx,[{id:item.owner}],'done_'+ref.id,{title:'신청곡 반영 완료',body:item.title+' · '+actor.name,target:'archive',type:'song'});}return{ok:true};
   });
  }
  fail(400,'지원하지 않는 요청이에요.');
 };
}
module.exports={ADMIN,RETENTION,fail,text,id,videoUrl,roomAccess,songAccess,createService};
