const {validateImages,summary}=require('./chat-images.cjs');
const ADMIN = new Set(['관리계정','단장','인도자','선임싱어','선임세션']);
const RETENTION = 21 * 86400000;
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function text(value, max, label) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${label}을 확인해 주세요.`); return value.trim(); }
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) fail(400, '잘못된 항목이에요.'); return value; }
function videoUrl(value) { const s = text(value, 2000, '영상 링크'); let u; try { u = new URL(s); } catch { fail(400, '올바른 영상 링크를 입력해 주세요.'); } if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) fail(400, 'http 또는 https 영상 링크만 사용할 수 있어요.'); return u.href; }
function roomAccess(actor, room) { if (!['all','admin'].includes(room)) fail(400, '채팅방을 확인해 주세요.'); if (room === 'admin' && !ADMIN.has(actor.rank)) fail(403, '관리자급만 들어갈 수 있는 방이에요.'); }
function songAccess(actor, song, op) { if (op === 'complete') { if (actor.rank !== '인도자' && actor.rank !== '관리계정') fail(403, '인도자만 콘티 반영을 완료할 수 있어요.'); } else if (song.owner !== actor.id) fail(403, '신청한 본인만 수정하거나 삭제할 수 있어요.'); }
function createService({ db, accounts, push = async()=>({sent:0}), now = Date.now, timestamp = n=>new Date(n) }) {
 const root = db.collection('_kzCommunity');
 const messages = room => root.doc('room_'+room).collection('kzChatMessages');
 const inbox = who => root.doc('inbox_'+who).collection('items');
 const songs = root.doc('songs').collection('items');
 const packet = d => ({id:d.id,...d.data()});
 const leader = a => ['인도자','관리계정'].includes(a.rank);
 async function roster() { return (await accounts()).filter(a=>a.status==='approved'); }
 async function limited(tx, actor, key, interval) {
  const ref = root.doc('rate_'+actor.id+'_'+key), s = await tx.get(ref), time = now();
  if(s.exists && time-s.data().at<interval) fail(429,'잠시 후 다시 시도해 주세요.');
  tx.set(ref,{at:time});
 }
 async function list(col, input, size=60, valid=()=>true) {
  let q = col.orderBy('createdAt','desc');
  if(input.cursor) { const cursor=await col.doc(id(input.cursor)).get(); if(cursor.exists) q=q.startAfter(cursor); }
  const s=await q.limit(size+1).get(), docs=s.docs.slice(0,size);
  return {items:docs.map(packet).filter(valid),cursor:s.docs.length>size?docs.at(-1).id:null};
 }
 function notices(tx, recipients, key, note) {
  if(recipients.length>450) fail(503,'알림 대상이 너무 많아요. 관리자에게 문의해 주세요.');
  for(const a of recipients) tx.set(inbox(a.id).doc(key),{...note,createdAt:now()});
 }
 async function safePush(recipients,note) { try { return await push(recipients,note); } catch { return {sent:0,pushFailed:true}; } }
 return async function run(actor, input) {
  if(!actor || actor.status!=='approved') fail(403,'승인된 계정으로 로그인해 주세요.');
  const action=input.action;
  if(action==='status') { const s=await inbox(actor.id).limit(100).get(); return {unread:s.size,account:{id:actor.id,name:actor.name,rank:actor.rank},admin:ADMIN.has(actor.rank),leader:leader(actor)}; }
  if(action==='inbox') return list(inbox(actor.id),input);
  if(action==='read') { const ref=inbox(actor.id).doc(id(input.id)); return db.runTransaction(async tx=>{const s=await tx.get(ref); if(!s.exists) fail(404,'이미 읽은 알림이에요.'); const note=packet(s); tx.delete(ref); return {note};}); }
  if(action==='chat') {
   roomAccess(actor,input.room);
   const result=await list(messages(input.room),input,60,m=>m.createdAt>now()-RETENTION);
   // Stop pagination at the retention boundary; expired content is never returned.
   if(!result.items.length || result.items.at(-1).createdAt<=now()-RETENTION) result.cursor=null;
   result.items=result.items.map(summary);result.items.reverse(); return result;
  }
  if(action==='chatImages') {
   roomAccess(actor,input.room);const snap=await messages(input.room).doc(id(input.id)).get();
   if(!snap.exists||snap.data().createdAt<=now()-RETENTION)fail(404,'삭제되었거나 보관 기간이 지난 이미지예요.');
   return {images:snap.data().images||[]};
  }
  if(action==='send') {
   roomAccess(actor,input.room); const images=validateImages(input.images),key=id(input.id),content=typeof input.text==='string'?input.text.trim():'';if(content.length>2000||(!content&&!images.length))fail(400,'메시지나 이미지를 넣어 주세요.');const ref=messages(input.room).doc(actor.id+'_'+key);
   return db.runTransaction(async tx=>{
    const old=await tx.get(ref); if(old.exists) return {item:summary(packet(old))};
    const time=now(), item={owner:actor.id,name:actor.name,text:content,images,createdAt:time,expiresAt:timestamp(time+RETENTION)};
    await limited(tx,actor,'chat',1000); tx.set(ref,item); return {item:summary({id:ref.id,...item})};
   });
  }
  if(action==='songs') return list(songs,input,60);
  if(action==='songCreate') {
   const key=id(input.id), ref=songs.doc(actor.id+'_'+key), title=text(input.title,120,'곡 제목'), url=videoUrl(input.url), recipients=(await roster()).filter(leader);
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(ref); if(old.exists) return {item:packet(old),duplicate:true};
    await limited(tx,actor,'song',10000);
    const item={owner:actor.id,name:actor.name,title,url,createdAt:now(),updatedAt:now(),revision:1};
    tx.set(ref,item); notices(tx,recipients,'song_'+ref.id,{title:'새 신청곡 · '+title,body:actor.name+'님이 신청했어요.',target:'song_requests',songId:ref.id});
    return {item:{id:ref.id,...item}};
   });
   if(!result.duplicate) result.push=await safePush(recipients,{title:'새 신청곡 · '+title,body:actor.name+'님이 신청했어요.',target:'song_requests',type:'song'});
   return result;
  }
  if(['songUpdate','songDelete','songComplete'].includes(action)) {
   const ref=songs.doc(id(input.id));
   return db.runTransaction(async tx=>{
    const s=await tx.get(ref); if(!s.exists) fail(404,'이미 삭제되거나 콘티에 반영된 신청곡이에요.');
    const item=s.data(); songAccess(actor,item,action==='songComplete'?'complete':'owner');
    if(input.revision!==item.revision) fail(409,'신청곡이 변경됐어요. 새로고침 후 다시 확인해 주세요.');
    if(action==='songUpdate') tx.update(ref,{title:text(input.title,120,'곡 제목'),url:videoUrl(input.url),updatedAt:now(),revision:item.revision+1});
    else { tx.delete(ref); if(action==='songComplete') notices(tx,[{id:item.owner}],'done_'+ref.id,{title:'신청곡이 콘티에 반영됐어요',body:item.title+' · '+actor.name,target:'archive'}); }
    return {ok:true};
   });
  }
  fail(400,'지원하지 않는 요청이에요.');
 };
}

module.exports={ADMIN,RETENTION,fail,text,id,videoUrl,roomAccess,songAccess,createService};
