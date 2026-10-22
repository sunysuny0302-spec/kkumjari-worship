'use strict';
const {validateImages,summary}=require('./chat-images.cjs');
const ADMIN=new Set(['관리계정','단장','인도자','선임싱어','선임세션']);
/* 채팅 기록은 한 달(30일) 보관 */
const RETENTION=30*86400000;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(400,`${label}을 확인해 주세요.`);return value.trim();}
// Stored IDs include an account ID plus the client request ID. Firebase UIDs
// may contain characters other than letters, and can be 128 characters long.
function id(value){if(typeof value!=='string'||!value||value==='.'||value==='..'||/[\/\u0000-\u001f\u007f]/u.test(value)||Buffer.byteLength(value,'utf8')>1500)fail(400,'잘못된 항목이에요.');return value;}
function requestId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(value))fail(400,'요청 번호를 확인해 주세요.');return value;}
/* 참고 영상 여러 개(최대 5개). 예전처럼 url 하나만 보내도 됨 */
/* 참고 영상 + 짧은 설명(버전 등): links=[{url,note}] (최대 5개). 예전 urls/url도 받음 */
function videoLinks(input){const raw=Array.isArray(input&&input.links)?input.links.filter(x=>x&&typeof x.url==='string'&&x.url.trim()):null;if(raw&&raw.length){if(raw.length>5)fail(400,'참고 영상은 5개까지 넣을 수 있어요.');const seen=new Set(),out=[];for(const x of raw){const url=videoUrl(x.url);if(seen.has(url))continue;seen.add(url);const note=typeof x.note==='string'?x.note.trim().slice(0,40):'';out.push(note?{url,note}:{url});}return out;}return videoUrls(input).map(url=>({url}));}
function videoUrls(input){const raw=Array.isArray(input&&input.urls)?input.urls.filter(v=>typeof v==='string'&&v.trim()):null;if(raw&&raw.length){if(raw.length>5)fail(400,'참고 영상은 5개까지 넣을 수 있어요.');return[...new Set(raw.map(videoUrl))];}return[videoUrl(input&&input.url)];}
function videoUrl(value){const s=text(value,2000,'영상 링크');let u;try{u=new URL(s);}catch{fail(400,'올바른 영상 링크를 입력해 주세요.');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)fail(400,'http 또는 https 영상 링크만 사용할 수 있어요.');return u.href;}
// 채팅방은 전체 인원이 함께 쓰는 '전체 채팅' 하나만 사용 (예전 관리자방은 닫음)
function roomAccess(actor,room){if(room!=='all')fail(400,'채팅방은 전체 채팅 하나만 있어요. 앱을 새로고침해 주세요.');}
/* 인도자 = 직책 인도자, 또는 인도자를 겸하는 단장 */
const isLeader=a=>!!a&&(['인도자','관리계정'].includes(a.rank)||(a.rank==='단장'&&Array.isArray(a.parts)&&a.parts.includes('인도자')));
function songAccess(actor,song,op){if(op==='complete'){if(!isLeader(actor))fail(403,'인도자만 콘티 반영을 완료할 수 있어요.');}else if(song.owner!==actor.id)fail(403,'신청한 본인만 수정하거나 삭제할 수 있어요.');}
function createService({db,accounts,push=async()=>({sent:0}),defer=null,now=Date.now,timestamp=n=>new Date(n)}){
 const root=db.collection('_kzCommunity');
 const messages=room=>root.doc('room_'+room).collection('kzChatMessages');
 const inbox=who=>root.doc('inbox_'+who).collection('items');
 const songs=root.doc('songs').collection('items');
 const subreqs=root.doc('subreqs').collection('items');
 const feedPosts=root.doc('feed').collection('posts');const feedComments=pid=>feedPosts.doc(id(pid)).collection('comments');
 const prefs=who=>root.doc('chatPrefs_'+id(who));
 const prefCache=new Map();async function enabled(who,room){const c=prefCache.get(who);let d;if(c&&c.exp>now()&&c.exp-now()<=30000)d=c.d;else{const p=await prefs(who).get();d=p.exists?p.data():{};prefCache.set(who,{d,exp:now()+30000});}return d[room]!==false;}
 const packet=d=>({...d.data(),id:d.id});
 const leader=a=>isLeader(a);
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
 /* 토요 연습 미응답자 알림 (매일 저녁 크론). 월~금에만, 다가오는 주일 콘티의 대상자 중 아직 응답 안 한 사람에게 */
 async function remindRsvp(){
  const k=new Date(now()+9*3600000),dow=k.getUTCDay();if(dow<1||dow>5)return{skipped:'not-weekday'};
  const sun=new Date(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate()+(7-dow))),date=sun.toISOString().slice(0,10);
  if((await noSvcDays()).includes(date))return{date,skipped:'no-service'};
  const s=await root.doc('rsvp_'+date).get();if(!s.exists)return{date,reminded:0};
  const d=s.data(),targets=Array.isArray(d.targets)?d.targets:[],answers=d.answers||{};
  const pendingNames=new Set(targets.map(t=>t&&t.n).filter(n=>typeof n==='string'&&n&&!answers[n]));if(!pendingNames.size)return{date,reminded:0};
  const people=(await roster()).filter(a=>pendingNames.has(a.name));if(!people.length)return{date,reminded:0};
  const sat=new Date(sun.getTime()-86400000),label=(sat.getUTCMonth()+1)+'월 '+sat.getUTCDate()+'일(토)';
  const note={title:'토요 연습 참석 여부를 알려 주세요',body:label+' 연습에 올 수 있는지 앱에서 눌러 주세요',target:'home',type:'rsvp',tag:'rsvp-'+date};
  await db.runTransaction(async tx=>{notices(tx,people,'rsvp_'+date,note);});
  const push=await safePush(people,note);return{date,reminded:people.length,push};
 }
 /* 가사 PPT 담당 알림 (매일 저녁 크론). 월~토, 다가오는 주일 담당에게 한 번만 (주중에 담당이 바뀌면 바뀐 사람에게도) */
 async function noSvcDays(){try{const d=await db.collection('settings').doc('noService').get();const x=d.exists&&d.data()&&d.data().days;return x&&typeof x==='object'?Object.keys(x).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)):[];}catch{return[];}}
 function pptDuty(r,date,skip=[]){if(!r||skip.includes(date))return '';if(r.overrides&&typeof r.overrides[date]==='string'&&r.overrides[date])return r.overrides[date];const m=Array.isArray(r.members)?r.members.filter(x=>typeof x==='string'&&x):[];if(!m.length||!/^\d{4}-\d{2}-\d{2}$/.test(String(r.start||'')))return '';
  const a=r.start,sh=skip.reduce((c,x)=>date>a?(x>=a&&x<date?c+1:c):(x>=date&&x<a?c-1:c),0);const k=Math.max(1,Math.min(8,(r.weeks|0)||1)),w=Math.round((Date.parse(date+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/(7*86400000))-sh,i=Math.floor(w/k);return m[((i%m.length)+m.length)%m.length];}
 async function remindPpt(){
  const k=new Date(now()+9*3600000),dow=k.getUTCDay();if(dow===0)return{skipped:'sunday'};
  const sun=new Date(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate()+(7-dow))),date=sun.toISOString().slice(0,10);
  const r=await db.collection('settings').doc('pptRotation').get();if(!r.exists)return{date,skipped:'no-rotation'};
  const skip=await noSvcDays();if(skip.includes(date))return{date,skipped:'no-service'};const name=pptDuty(r.data(),date,skip);if(!name)return{date,skipped:'no-duty'};
  const mark=root.doc('pptRemind_'+date),m=await mark.get(),sent=m.exists&&Array.isArray(m.data().names)?m.data().names:[];if(sent.includes(name))return{date,name,skipped:'sent'};
  const people=(await roster()).filter(a=>a.name===name);if(!people.length)return{date,name,skipped:'no-account'};
  const note={title:'이번 주 가사 PPT 담당이에요',body:(sun.getUTCMonth()+1)+'월 '+sun.getUTCDate()+'일 주일예배 가사 PPT를 준비해 주세요',target:'lyrics',type:'ppt',tag:'ppt-'+date};
  await db.runTransaction(async tx=>{notices(tx,people,'ppt_'+date,note);tx.set(mark,{names:[...sent,name],at:now()});});
  const push=await safePush(people,note);return{date,name,reminded:people.length,push};
 }
 /* 이번 주 섬김 안내 (매일 저녁 크론). 월~토, 콘티가 올라와 대상자 명단(rsvp targets)이 생기면 한 사람에 한 번 */
 async function remindServe(){
  const k=new Date(now()+9*3600000),dow=k.getUTCDay();if(dow===0)return{skipped:'sunday'};
  const sun=new Date(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate()+(7-dow))),date=sun.toISOString().slice(0,10);
  if((await noSvcDays()).includes(date))return{date,skipped:'no-service'};
  const s=await root.doc('rsvp_'+date).get();if(!s.exists)return{date,reminded:0};
  const targets=(Array.isArray(s.data().targets)?s.data().targets:[]).filter(t=>t&&typeof t.n==='string'&&t.n);if(!targets.length)return{date,reminded:0};
  const mark=root.doc('serveRemind_'+date),m=await mark.get(),sent=m.exists&&Array.isArray(m.data().names)?m.data().names:[];
  const roster_=await roster(),todo=targets.filter(t=>!sent.includes(t.n)).map(t=>({t,a:roster_.find(a=>a.name===t.n)})).filter(x=>x.a);if(!todo.length)return{date,reminded:0};
  const label=(sun.getUTCMonth()+1)+'월 '+sun.getUTCDate()+'일';let pushed=0;
  await db.runTransaction(async tx=>{for(const x of todo){const role=(Array.isArray(x.t.r)?x.t.r:[]).map(r=>(r==='메인'||r==='세컨')?'건반':r).filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ')||'섬김';
    notices(tx,[x.a],'serve_'+date,{title:'이번 주 섬기는 날이에요',body:label+' 주일 · '+role,target:'mobile_my',type:'sched',tag:'serve-'+date});}
   tx.set(mark,{names:[...sent,...todo.map(x=>x.t.n)],at:now()});});
  for(const x of todo){const role=(Array.isArray(x.t.r)?x.t.r:[]).map(r=>(r==='메인'||r==='세컨')?'건반':r).filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ')||'섬김';const r=await safePush([x.a],{title:'이번 주 섬기는 날이에요',body:label+' 주일 · '+role,target:'mobile_my',type:'sched',tag:'serve-'+date});pushed+=r&&r.sent||0;}
  return{date,reminded:todo.length,pushed};
 }
 /* 일정 참석 여부 마감 2일 전부터, 아직 응답 안 한 사람에게 한 번 알림 */
 async function remindEvents(){
  const today=new Date(now()+9*3600000).toISOString().slice(0,10),add=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  let evs=[];try{const q=await db.collection('events').where('date','>=',today).get();evs=q.docs.map(d=>({id:d.id,...d.data()})).filter(e=>e.rsvp);}catch{return{skipped:'query'};}
  const people=(await roster()).filter(a=>a.id!=='management');let total=0;
  for(const e of evs){const until=/^\d{4}-\d{2}-\d{2}$/.test(String(e.rsvpUntil||''))?e.rsvpUntil:add(e.date,-1);if(today<add(until,-2)||today>until)continue;
   const mark=root.doc('evrsvpRemind_'+e.id);if((await mark.get()).exists)continue;const ans=await root.doc('evrsvp_'+e.id).get(),a=ans.exists?ans.data().answers||{}:{};
   const todo=people.filter(p=>!a[p.name]);const note={title:'참석 여부를 아직 안 알려 주셨어요',body:`${String(e.title||'일정').slice(0,60)} · ${until.slice(5).replace('-','/')}까지 응답`,target:'rsvp',type:'event',tag:'evrsvp-'+e.id};
   await db.runTransaction(async tx=>{if(todo.length)notices(tx,todo,'evrsvpR_'+e.id,note);tx.set(mark,{at:now(),n:todo.length});});if(todo.length)await safePush(todo,note);total+=todo.length;}
  return{reminded:total};
 }
 /* 생일 알림 (매일 아침 크론 + 저녁 크론 보조). 생일인 사람에게 축하, 나머지에게 '오늘은 ○○님 생일' — 하루 한 번만 */
 /* 생일 게시물: 그날 꿈마당에 자동으로 한 번 (id가 정해져 있어 두 번 생기지 않음) */
 const bdayMade=new Set();
 async function ensureBdayPosts(date,list){for(const a of list){const k=date+'_'+a.id;if(bdayMade.has(k))continue;const ref=root.doc('feed').collection('posts').doc('bday_'+date.replace(/-/g,'')+'_'+a.id);
   const lref=root.doc('bdayPosts');
   await db.runTransaction(async tx=>{const d=await tx.get(ref),l=await tx.get(lref);if(d.exists)return;const ids=l.exists&&Array.isArray(l.data().ids)?l.data().ids:[];
    tx.set(ref,{owner:a.id,name:a.name,kind:'bday',bday:{date},text:'',images:[],createdAt:now(),likes:{},commentCount:0,recent:[]});tx.set(lref,{ids:[...ids.filter(x=>x.id!==ref.id),{id:ref.id,date}]});});bdayMade.add(k);}}
 /* 알림함 정리: 읽음 처리된 것 · 30일 지난 것 · 예전 일반 채팅 알림 */
 async function cleanInbox(){const people=await accounts();let removed=0;const cut=now()-30*86400000;
  for(const a of people){if(!a||!a.id)continue;const st=await root.doc('inboxState_'+a.id).get(),rt=st.exists?Number(st.data().readThrough)||0:0;
   const [o,c]=await Promise.all([inbox(a.id).where('createdAt','<=',Math.max(cut,rt)).orderBy('createdAt','desc').limit(300).get(),inbox(a.id).where('type','==','chat').limit(300).get()]);
   const refs=new Map([...o.docs,...c.docs].map(d=>[d.ref.path||d.id,d.ref]));if(!refs.size)continue;
   await db.runTransaction(async tx=>{refs.forEach(r=>tx.delete(r));});removed+=refs.size;}
  return{removed};}
 /* 새 가입 요청: 관리계정 · 단장에게 알림함 + 휴대폰 알림 (같은 사람은 한 번만) */
 async function notifySignup(input){const uid=id(String(input.uid||'')),name=String(input.name||'').slice(0,30);if(!name)return{sent:0};
  const to=(await accounts()).filter(a=>a.status==='approved'&&(a.id==='management'||a.rank==='단장'));if(!to.length)return{sent:0};
  const note={title:'새 가입 요청이 왔어요 🙋',body:name+'님이 가입을 기다리고 있어요. 승인해 주세요',target:'approve',type:'notice',tag:'signup-'+uid};
  let fresh=false;await db.runTransaction(async tx=>{const ref=inbox(to[0].id).doc('signup_'+uid),old=await tx.get(ref);fresh=!old.exists;if(fresh)notices(tx,to,'signup_'+uid,note);});
  if(!fresh)return{sent:0,dup:true};const r=await safePush(to,note);return{sent:(r&&r.sent)||0,to:to.length};}
 async function remindBday(){
  const k=new Date(now()+9*3600000),date=k.toISOString().slice(0,10),md=date.slice(5);
  const bd=await root.doc('birthdays').get(),all=bd.exists&&bd.data()&&typeof bd.data().m==='object'?bd.data().m:{};
  const people=await roster(),byId=new Map(people.map(a=>[a.id,a]));
  const today=Object.entries(all).filter(([id,v])=>v&&v.md===md&&byId.has(id)&&id!=='management').map(([id])=>byId.get(id));if(!today.length)return{date,reminded:0};
  await ensureBdayPosts(date,today);
  const mark=root.doc('bdayRemind_'+date);let todo=[];
  await db.runTransaction(async tx=>{const m=await tx.get(mark),sent=m.exists&&Array.isArray(m.data().ids)?m.data().ids:[];todo=today.filter(a=>!sent.includes(a.id));if(!todo.length)return;
   for(const b of todo){notices(tx,[b],'bday_'+date+'_'+b.id,{title:'생일 축하해요, '+b.name+'님! 🎂',body:'꿈자리 찬양팀이 함께 축하해요. 꿈마당에서 축하 메시지를 확인해 보세요',target:'feed',type:'celebrate',tag:'bday-'+date+'-'+b.id});
    const others=people.filter(a=>a.id!==b.id);if(others.length)notices(tx,others,'bdayo_'+date+'_'+b.id,{title:'오늘은 '+b.name+'님 생일이에요 🎂',body:'꿈마당 생일 게시물에 축하 메시지를 남겨 주세요',target:'feed',type:'celebrate',tag:'bday-'+date+'-'+b.id});}
   tx.set(mark,{ids:[...sent,...todo.map(a=>a.id)],at:now()});});
  let pushed=0;for(const b of todo){const r1=await safePush([b],{title:'생일 축하해요, '+b.name+'님! 🎂',body:'꿈자리 찬양팀이 함께 축하해요. 꿈마당에서 축하 메시지를 확인해 보세요',target:'feed',type:'celebrate',tag:'bday-'+date+'-'+b.id});
   const r2=await safePush(people.filter(a=>a.id!==b.id),{title:'오늘은 '+b.name+'님 생일이에요 🎂',body:'꿈마당 생일 게시물에 축하 메시지를 남겨 주세요',target:'feed',type:'celebrate',tag:'bday-'+date+'-'+b.id});pushed+=(r1&&r1.sent||0)+(r2&&r2.sent||0);}
  return{date,reminded:todo.length,pushed};
 }
 return async function run(actor,input){
  if(actor&&actor.system===true&&input&&input.action==='bdayRemind')return remindBday();
  if(actor&&actor.system===true&&input&&input.action==='inboxClean')return cleanInbox();
  if(actor&&actor.system===true&&input&&input.action==='signupNotify')return notifySignup(input);
  if(actor&&actor.system===true&&input&&input.action==='eventRemind')return remindEvents();
  if(actor&&actor.system===true&&input&&input.action==='serveRemind')return remindServe();
  if(actor&&actor.system===true&&input&&input.action==='rsvpRemind')return remindRsvp();
  if(actor&&actor.system===true&&input&&input.action==='pptRemind')return remindPpt();
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
    tx.set(ref,{sessions:Object.fromEntries(Object.entries(sessions).sort((a,b)=>b[1]-a[1]).slice(0,12)),lastSeen:time});
   });return{ok:true};
  }
  /* 이번 주 참석 확인: 누구나 응답 현황을 볼 수 있고, 내 응답만 바꿀 수 있음 */
  /* 토요 연습 대상자 목록: 콘티를 올린 주에 관리자급 화면이 계산해서 저장 (미응답 알림에 사용) */
  if(action==='rsvpTargets'){
   if(!ADMIN.has(actor.rank))fail(403,'관리자급만 저장할 수 있어요.');
   const date=String(input.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail(400,'날짜를 확인해 주세요.');
   const t=Date.parse(date+'T12:00:00+09:00');if(!Number.isFinite(t)||t<now()-2*86400000||t>now()+60*86400000)fail(400,'저장할 수 없는 날짜예요.');
   if(!Array.isArray(input.targets)||input.targets.length>60)fail(400,'대상자를 확인해 주세요.');
   const targets=input.targets.map(x=>({n:String(x&&x.n||'').trim().slice(0,30),r:Array.isArray(x&&x.r)?x.r.slice(0,6).map(v=>String(v).slice(0,20)):[]})).filter(x=>x.n);
   const ref=root.doc('rsvp_'+date);await db.runTransaction(async tx=>{const old=await tx.get(ref);tx.set(ref,{...(old.exists?old.data():{}),date,targets,targetsAt:now()});});return{date,count:targets.length};
  }
  /* 일정 참석 여부 (수련회 등): 일정마다 응답 저장. 일정에 rsvp 표시가 있어야 받음 */
  if(action==='evRsvpGet'){
   if(!Array.isArray(input.ids)||input.ids.length>30)fail(400,'일정을 확인해 주세요.');
   const ids=[...new Set(input.ids.map(id))];const out={};
   await Promise.all(ids.map(async e=>{const s=await root.doc('evrsvp_'+e).get();out[e]=s.exists?s.data().answers||{}:{};}));return{items:out};
  }
  if(action==='evRsvpSet'){
   const e=id(input.id),ev=await db.collection('events').doc(e).get();if(!ev.exists||!ev.data().rsvp)fail(404,'참석 여부를 받는 일정이 아니에요.');
   const until=String(ev.data().rsvpUntil||ev.data().date||'');if(/^\d{4}-\d{2}-\d{2}$/.test(until)&&Date.parse(until+'T23:59:59+09:00')<now())fail(400,'응답 마감이 지났어요.');
   const st=input.s;if(!['yes','no','maybe',''].includes(st))fail(400,'응답을 확인해 주세요.');const note=typeof input.note==='string'?input.note.trim().slice(0,200):'';
   const ref=root.doc('evrsvp_'+e);
   return db.runTransaction(async tx=>{const s=await tx.get(ref),answers={...(s.exists?s.data().answers||{}:{})};if(st)answers[actor.name]={s:st,at:now(),...(note?{note}:{})};else delete answers[actor.name];
    tx.set(ref,{id:e,answers,updatedAt:now()});return{id:e,answers};});
  }
  if(action==='evRsvpNotify'){
   if(!ADMIN.has(actor.rank))fail(403,'관리자급만 보낼 수 있어요.');
   const e=id(input.id),ev=await db.collection('events').doc(e).get();if(!ev.exists||!ev.data().rsvp)fail(404,'참석 여부를 받는 일정이 아니에요.');const d=ev.data();
   const people=(await roster()).filter(a=>a.id!==actor.id&&a.id!=='management');
   const md=x=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x||''));return m?(+m[2])+'월 '+(+m[3])+'일':''};
   const note={title:'참석 여부를 알려 주세요',body:`${String(d.title||'일정').slice(0,60)} · ${md(d.date)}${d.rsvpUntil?' · '+md(d.rsvpUntil)+'까지 응답':''}`,target:'rsvp',type:'event',tag:'evrsvp-'+e};
   await db.runTransaction(async tx=>{await limited(tx,actor,'evnotify',3000);notices(tx,people,'evrsvp_'+e,note);});const push=await safePush(people,note);return{ok:true,sent:people.length,push};
  }
  if(action==='rsvpGet'||action==='rsvpSet'){
   const date=String(input.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail(400,'날짜를 확인해 주세요.');
   const t=Date.parse(date+'T12:00:00+09:00');if(!Number.isFinite(t)||t<now()-21*86400000||t>now()+180*86400000)fail(400,'응답할 수 없는 날짜예요.');
   const ref=root.doc('rsvp_'+date);
   if(action==='rsvpGet'){const s=await ref.get();return{date,answers:s.exists?s.data().answers||{}:{}};}
   const st=input.s;if(!['yes','no',''].includes(st))fail(400,'응답을 확인해 주세요.');
   const note=typeof input.note==='string'?input.note.trim().slice(0,200):'';
   return db.runTransaction(async tx=>{const s=await tx.get(ref),answers={...(s.exists?s.data().answers||{}:{})};
    if(st)answers[actor.name]={s:st,at:now(),...(note?{note}:{})};else delete answers[actor.name];
    tx.set(ref,{...(s.exists?s.data():{}),date,answers,updatedAt:now()});return{date,answers};});
  }
  /* 내 출석: 본인 기록만 계산해서 돌려줌 (출결 원본은 권한자만 볼 수 있으므로 서버에서 계산) */
  if(action==='myAttendance'){
   const k=new Date(now()+9*3600000),y=k.getUTCFullYear(),m=k.getUTCMonth();/* 한국 시간 기준 이번 달 */
   const ym=(yy,mm)=>{const d=new Date(Date.UTC(yy,mm,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');};
   const months=[ym(y,m-3),ym(y,m-2),ym(y,m-1)],from=months[0]+'-01',to=ym(y,m)+'-01';
   const s=await db.collection('attendance').where('date','>=',from).get();
   const blank=()=>({assigned:0,counted:0,p:0,nl:0,el:0,ua:0,ea:0,recs:[]}),by=Object.fromEntries(months.map(x=>[x,blank()]));
   for(const d of s.docs){const a=d.data()||{},date=String(a.date||'');if(d.id==='_status'||date<from||date>=to)continue;const b=by[date.slice(0,7)];if(!b)continue;
    const it=(Array.isArray(a.list)?a.list:[]).find(x=>x&&x.n===actor.name);if(!it)continue;b.assigned++;
    const st=String((((a.recs||{})[actor.name])||{}).s||'').trim();b.recs.push({date,type:a.type==='기타'?String(a.label||'기타').slice(0,20):String(a.type||'').slice(0,20),s:st||'미입력'});if(!st)continue;b.counted++;
    if(st==='출석')b.p++;else if(st==='일반 지각')b.nl++;else if(st==='인정 지각')b.el++;else if(st==='무단 결석')b.ua++;else if(st==='인정 결석')b.ea++;}
   const out=months.map(mo=>{const b=by[mo];b.recs.sort((x,z)=>x.date<z.date?-1:1);return{month:mo,...b,rate:b.counted?Math.round((b.p+b.nl+b.el+b.ea)/b.counted*1000)/10:null};});
   return{name:actor.name,last:out[2],prev:out.slice(0,2)};
  }
  /* 출결 순위: 승인된 팀원 모두 볼 수 있게 사람별 집계만 내려줌 (기록 원본·메모는 안 보냄) */
  if(action==='attendRank'){
   const range=['month','3m','year'].includes(input.range)?input.range:'3m';
   const k=new Date(now()+9*3600000),y=k.getUTCFullYear(),m=k.getUTCMonth(),ymd=(yy,mm,dd)=>new Date(Date.UTC(yy,mm,dd)).toISOString().slice(0,10);
   const from=range==='month'?ymd(y,m,1):range==='3m'?ymd(y,m-2,1):ymd(y,0,1),to=range==='year'?ymd(y+1,0,1):ymd(y,m+1,1);
   const s=await db.collection('attendance').where('date','>=',from).get(),by=new Map(),people=(await roster()).filter(a=>a.id!=='management'),names=new Set(people.map(a=>a.name));let days=0;
   for(const d of s.docs){const a=d.data()||{},date=String(a.date||'');if(d.id==='_status'||date<from||date>=to)continue;days++;
    for(const it of (Array.isArray(a.list)?a.list:[])){const n=it&&it.n;if(!n||!names.has(n))continue;const b=by.get(n)||{assigned:0,counted:0,p:0,nl:0,el:0,ua:0,ea:0};b.assigned++;
     const st=String((((a.recs||{})[n])||{}).s||'').trim();if(st){b.counted++;if(st==='출석')b.p++;else if(st==='일반 지각')b.nl++;else if(st==='인정 지각')b.el++;else if(st==='무단 결석')b.ua++;else if(st==='인정 결석')b.ea++;}by.set(n,b);}}
   const items=people.map(a=>{const b=by.get(a.name)||{assigned:0,counted:0,p:0,nl:0,el:0,ua:0,ea:0};const att=b.p+b.nl+b.el;return{name:a.name,rank:a.rank,parts:Array.isArray(a.parts)?a.parts.slice(0,4):[],assigned:b.assigned,counted:b.counted,attend:att,p:b.p,late:b.nl+b.el,absent:b.ua+b.ea,ua:b.ua,rate:b.counted?Math.round((b.p+b.el+b.ea)/b.counted*1000)/10:null};})/* 출결 통계와 같은 기준: 출석·인정 지각·인정 결석 = 참여 */
    .sort((a,b)=>(b.rate==null?-1:b.rate)-(a.rate==null?-1:a.rate)||b.attend-a.attend||a.late-b.late||a.name.localeCompare(b.name,'ko'));
   /* 공개 범위: settings/attendRank.mode==='rate' 이면 관리자급이 아닌 사람에게는 순위·참여율만 */
   let mode='full';try{const c=await db.collection('settings').doc('attendRank').get();if(c.exists&&c.data().mode==='rate')mode='rate';}catch{}
   const staff=ADMIN.has(actor.rank)||actor.id==='management';
   if(mode==='rate'&&!staff)return{range,from,to,days,mode,items:items.map(x=>({name:x.name,rank:x.rank,parts:x.parts,rate:x.rate}))};
   return{range,from,to,days,mode,items};
  }
  if(action==='members'){
   const members=await roster(),time=now();
   const items=await Promise.all(members.map(async a=>{const state=await root.doc('presence_'+a.id).get(),d=state.exists?state.data():{},times=Object.values(d.sessions||{}).map(Number);/* 마지막 접속 시각: 접속 중 기록 또는 마지막 활동 */return{id:a.id,name:a.name,rank:a.rank,parts:Array.isArray(a.parts)?a.parts.slice(0,6):[],online:times.some(t=>t>time-65000),lastSeen:Math.max(Number(d.lastSeen)||0,...times,0)||null};}));
   return{items:items.sort((a,b)=>Number(b.online)-Number(a.online)||a.name.localeCompare(b.name,'ko'))};
  }
  /* 대타 요청: 못 서는 주에 다른 멤버에게 '대신 서 줄 수 있나요?' 알림 */
  if(action==='subRequest'){
   const date=String(input.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail(400,'날짜를 확인해 주세요.');
   const t=Date.parse(date+'T12:00:00+09:00');if(!Number.isFinite(t)||t<now()-86400000||t>now()+90*86400000)fail(400,'요청할 수 없는 날짜예요.');
   const toName=typeof input.to==='string'?input.to.trim():'';if(!toName||toName.length>40)fail(400,'받는 사람을 확인해 주세요.');
   const role=typeof input.role==='string'?input.role.trim().slice(0,12):'';const forName=typeof input.for==='string'?input.for.trim().slice(0,40):actor.name;
   const target=(await roster()).find(a=>a.name===toName);if(!target)fail(404,'그 이름의 팀원을 찾지 못했어요.');if(target.id===actor.id)fail(400,'나에게는 보낼 수 없어요.');
   const d=new Date(t),label=(d.getUTCMonth()+1)+'월 '+d.getUTCDate()+'일';
   const kind=input.kind==='session'?'session':'singer',rid='r_'+date+'_'+actor.id+'_'+target.id;
   const note={title:'대신 서 줄 수 있나요?',body:`${actor.name}님 요청 · ${label} 주일${role?' '+role:''} · ${forName&&forName!==actor.name?forName+'님 대신':actor.name+'님 대신'} · 참석 확인에서 수락할 수 있어요`.slice(0,160),target:'rsvp',type:'sched',tag:'subreq-'+date};
   await db.runTransaction(async tx=>{await limited(tx,actor,'subreq',5000);tx.set(subreqs.doc(rid),{id:rid,date,to:target.id,toName:target.name,from:actor.id,fromName:actor.name,forName,role,kind,status:'pending',at:now()});notices(tx,[target],'subreq_'+date+'_'+actor.id+'_'+target.id,note);});
   const push=await safePush([target],note);return{ok:true,push};
  }
  /* 급한 불참: 변경 마감(전주 일요일)이 지난 이번 주에 갑자기 못 오게 된 경우. 불참 표시는 앱이 하고, 여기서는 인도자 · 단장 · 선임에게 사유와 함께 알림 */
  if(action==='urgentAbs'){
   const date=String(input.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail(400,'날짜를 확인해 주세요.');
   const today=new Date(now()+9*3600000).toISOString().slice(0,10),max=new Date(now()+9*3600000+8*86400000).toISOString().slice(0,10);
   if(date<today||date>max)fail(400,'이번 주 예배만 급한 불참으로 알릴 수 있어요.');
   const reason=typeof input.reason==='string'?input.reason.trim().slice(0,120):'';if(!reason)fail(400,'사유를 적어 주세요.');
   const kinds=(Array.isArray(input.kinds)?input.kinds:[]).filter((k,i,a)=>(k==='singer'||k==='session')&&a.indexOf(k)===i);if(!kinds.length)fail(400,'싱어인지 세션인지 골라 주세요.');
   const leader=typeof input.leader==='string'?input.leader.trim().slice(0,40):'';
   const all=await roster(),want=new Set(['단장',...(kinds.includes('singer')?['선임싱어']:[]),...(kinds.includes('session')?['선임세션']:[])]);
   const lds=all.filter(a=>a.rank!=='관리계정'&&isLeader(a)),ld=lds.filter(a=>a.name===leader);
   const people=[...all.filter(a=>want.has(a.rank)),...(ld.length?ld:lds)].filter((a,i,arr)=>a.id!==actor.id&&arr.findIndex(b=>b.id===a.id)===i);
   const d=new Date(Date.parse(date+'T12:00:00+09:00')),label=(d.getUTCMonth()+1)+'월 '+d.getUTCDate()+'일',part=kinds.map(k=>k==='singer'?'싱어':'세션').join(' · ');
   const note={title:'급한 불참 알림',body:`${actor.name}님 · ${label} 주일 ${part} · ${reason}`.slice(0,160),target:'mobile_my',type:'sched',tag:'urgent-'+date+'-'+actor.id};
   await db.runTransaction(async tx=>{await limited(tx,actor,'urgent',10000);tx.set(root.doc('urgent_'+date+'_'+actor.id),{date,id:actor.id,name:actor.name,kinds,reason,at:now()});notices(tx,people,'urgent_'+date+'_'+actor.id,note);});
   const push=await safePush(people,note);return{ok:true,notified:people.length,push};
  }
  /* 나에게 온 대타 요청 (아직 답하지 않은 것) */
  if(action==='subReqList'){const today=new Date(now()+9*3600000).toISOString().slice(0,10);const q=await subreqs.where('to','==',actor.id).get();
   return{items:q.docs.map(d=>d.data()).filter(x=>x.status==='pending'&&x.date>=today).sort((a,b)=>a.date<b.date?-1:1).slice(0,20)};}
  /* 대타 요청 수락/거절: 수락하면 일정 변경(대신 서기)을 바로 등록하고 요청한 사람에게 알림 */
  if(action==='subRespond'){const ref=subreqs.doc(id(input.id)),accept=input.accept===true;
   let stale=[];if(accept){try{const p=await ref.get();if(p.exists){const x=p.data(),who=x.forName||x.fromName,kk=x.kind==='session'?'session':'';const q=await db.collection('overrides').where('date','==',x.date).get();stale=q.docs.filter(o=>{const v=o.data()||{};return v.date===x.date&&v.from===who&&(v.k||'')===kk}).map(o=>o.id);}}catch{stale=[];}}
   const r=await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)fail(404,'요청을 찾지 못했어요.');const x=s.data();if(x.to!==actor.id)fail(403,'나에게 온 요청이 아니에요.');if(x.status!=='pending')fail(409,'이미 답한 요청이에요.');
    tx.set(ref,{...x,status:accept?'accepted':'declined',answeredAt:now()});
    if(accept)for(const o of stale)tx.delete(db.collection('overrides').doc(o));
    if(accept)tx.set(db.collection('overrides').doc('sr'+x.date.replace(/-/g,'')+'_'+String(x.from).slice(0,20)+'_'+String(actor.id).slice(0,20)),{date:x.date,from:x.forName||x.fromName,to:actor.name,at:now(),by:'subreq',...(x.kind==='session'?{k:'session'}:{})});
    const req=(await roster()).find(a=>a.id===x.from);const d=new Date(Date.parse(x.date+'T12:00:00+09:00'));const label=(d.getUTCMonth()+1)+'월 '+d.getUTCDate()+'일';
    const note={title:accept?'대타 요청을 수락했어요':'대타 요청을 거절했어요',body:`${actor.name}님 · ${label} 주일${x.role?' '+x.role:''}${accept?' · 일정표에 바로 반영됐어요':''}`,target:'mobile_my',type:'sched',tag:'subreq-'+x.date};
    if(req)notices(tx,[req],'subres_'+x.id,note);return{x,req,note};});
   if(r.req)await safePush([r.req],r.note);return{ok:true,status:accept?'accepted':'declined'};}
  /* ===== 피드: 사진·글 게시물, 좋아요, 댓글 ===== */
  if(action.startsWith('feed')){
   const staff=ADMIN.has(actor.rank)||actor.id==='management';
   const REACTS=['😂','🔥','👏','🙏','😍'];
   const pollView=x=>{const P=x.poll;if(!P||!Array.isArray(P.options))return null;const votes=P.votes&&typeof P.votes==='object'?P.votes:{},opts=P.options.map(t=>({t,n:0,who:[]}));for(const[uid,v] of Object.entries(votes)){const arr=Array.isArray(v.o)?v.o:[v.o];arr.forEach(i=>{if(opts[i]){opts[i].n++;if(!P.anon&&opts[i].who.length<30)opts[i].who.push(v.n||'')}})}const mine=votes[actor.id];return{q:P.q||'',multi:!!P.multi,anon:!!P.anon,options:opts,total:Object.keys(votes).length,my:mine?(Array.isArray(mine.o)?mine.o:[mine.o]):[]}};
   const reactView=x=>{const r=x.reacts&&typeof x.reacts==='object'?x.reacts:{},c={};for(const v of Object.values(r)){if(v&&REACTS.includes(v.e))(c[v.e]=c[v.e]||{e:v.e,n:0,who:[]}),c[v.e].n++,c[v.e].who.length<30&&c[v.e].who.push(v.n||'')}return{reacts:Object.values(c).sort((a,b)=>b.n-a.n),myReact:(r[actor.id]&&r[actor.id].e)||''}};
   const view=d=>{const x=typeof d.data==='function'?d.data():d,likes=x.likes&&typeof x.likes==='object'?x.likes:{};return{kind:x.kind||'post',...(x.to?{to:x.to,priv:x.priv!==false}:{}),...(x.poll?{poll:pollView(x)}:{}),...reactView(x),id:d.id,owner:x.owner,name:x.name,text:x.text||'',imageCount:Array.isArray(x.images)?x.images.length:0,createdAt:x.createdAt,editedAt:x.editedAt||null,
    likeCount:Object.keys(likes).length,liked:!!likes[actor.id],likers:Object.values(likes).slice(0,60),commentCount:Number(x.commentCount)||0,recent:Array.isArray(x.recent)?x.recent:[],...(x.kind==='bday'?{bday:x.bday||{},cheers:(()=>{const c=x.cheers&&typeof x.cheers==='object'?x.cheers:{};const e=Object.entries(c).sort((a,b)=>(b[1].at||0)-(a[1].at||0));return{n:e.length,who:e.slice(0,60).map(([,v])=>v.n),ids:e.slice(0,60).map(([k])=>k),mine:!!c[actor.id]};})()}:{}),mine:x.kind!=='bday'&&x.owner===actor.id,canDelete:x.kind==='bday'?staff:(x.owner===actor.id||staff)}};
   /* 태그(@이름): 글이나 댓글에 언급된 팀원 찾기 */
   const tagged=(text,people)=>people.filter(a=>a.id!==actor.id&&a.id!=='management'&&new RegExp('(^|\\s)@'+String(a.name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![가-힣A-Za-z0-9])').test(text||''));
   const tagNotify=async(list,note)=>{const ok=[];for(const a of list){if(await enabled(a.id,'feed'))ok.push(a);}if(!ok.length)return;await db.runTransaction(async tx=>{notices(tx,ok,note.key,note.n);});const job=safePush(ok,note.n);if(!(defer&&defer(job)))await job;};
   const post=async pid=>{const r=feedPosts.doc(id(pid)),d=await r.get();if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');return{r,d};};
   if(action==='feedList'){const first=!input.cursor;let bd=null;if(first){bd=await root.doc('birthdays').get();try{const k=new Date(now()+9*3600000),date=k.toISOString().slice(0,10),m=bd.exists&&bd.data()&&typeof bd.data().m==='object'?bd.data().m:{},ids=Object.keys(m).filter(u=>m[u]&&m[u].md===date.slice(5)&&u!=='management');if(ids.length){const ros=await roster();await ensureBdayPosts(date,ros.filter(a=>ids.includes(a.id)));}}catch(e){}}
    const [r,notify,stats]=await Promise.all([list(feedPosts,input,8),first?enabled(actor.id,'feed'):Promise.resolve(undefined),first?root.doc('feedStats').get():Promise.resolve(null)]);
    const extra={};if(first){const k=new Date(now()+9*3600000),md=String(k.getUTCMonth()+1).padStart(2,'0')+'-'+String(k.getUTCDate()).padStart(2,'0');const all=bd&&bd.exists&&bd.data()&&typeof bd.data().m==='object'?bd.data().m:{};
     extra.notify=notify;const ros=new Map((await roster()).map(x=>[x.id,x]));extra.birthdays=Object.entries(all).filter(([id,v])=>v&&v.md===md&&ros.has(id)).map(([id])=>({id,name:ros.get(id).name}));extra.myBday=(all[actor.id]&&all[actor.id].md)||'';extra.thanks=Object.fromEntries(Object.entries(stats&&stats.exists&&stats.data()&&typeof stats.data().thanks==='object'?stats.data().thanks:{}).filter(([id])=>ros.has(id)));}
    const todayK=new Date(now()+9*3600000).toISOString().slice(0,10);
    /* 지난 생일 게시물은 목록에서 빼고, 생일 당사자에게만 '받은 축하' 카드로 (최근 3개) */
    if(first){try{const l=await root.doc('bdayPosts').get(),ids=(l.exists&&Array.isArray(l.data().ids)?l.data().ids:[]).filter(x=>x&&x.date<todayK&&String(x.id).endsWith('_'+actor.id)).sort((a,b)=>a.date<b.date?1:-1).slice(0,3);
     const ds=await Promise.all(ids.map(x=>feedPosts.doc(id(x.id)).get()));extra.bdayCards=ds.filter(d=>d.exists&&d.data().owner===actor.id).map(view);}catch(e){extra.bdayCards=[];}}
    return{items:r.items.filter(d=>{const x=typeof d.data==='function'?d.data():d;if(x.kind==='thanks'&&x.priv!==false&&x.owner!==actor.id&&!(x.to&&x.to.id===actor.id))return false;/* 비공개 감사 카드는 받은 사람 · 보낸 사람만 (예전 카드는 비공개) */return x.kind!=='bday'||(x.bday&&x.bday.date===todayK);}).map(view),cursor:r.cursor||null,...extra};}
   /* 내 생일(월-일) 등록: 그날 꿈마당 맨 위에 축하 카드 */
   if(action==='feedBday'){const md=typeof input.md==='string'?input.md:'';if(md&&!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(md))fail(400,'생일을 확인해 주세요.');if(actor.id==='management')fail(400,'관리계정은 생일을 등록할 수 없어요.');
    const ref=root.doc('birthdays');await db.runTransaction(async tx=>{const d=await tx.get(ref),m={...(d.exists&&d.data()&&typeof d.data().m==='object'?d.data().m:{})};if(md)m[actor.id]={...(m[actor.id]||{}),md,name:actor.name};else delete m[actor.id];tx.set(ref,{m});});return{md};}
   /* 투표 */
   if(action==='feedVote'){const ref=feedPosts.doc(id(input.id)),idx=Array.isArray(input.o)?input.o:[input.o];
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');const x=d.data();if(!x.poll)fail(400,'투표가 아니에요.');const n=x.poll.options.length;
     const pick=[...new Set(idx.map(Number).filter(i=>Number.isInteger(i)&&i>=0&&i<n))];if(!x.poll.multi&&pick.length>1)fail(400,'하나만 고를 수 있어요.');
     const votes={...(x.poll.votes||{})};if(pick.length)votes[actor.id]={o:x.poll.multi?pick:pick[0],n:actor.name,at:now()};else delete votes[actor.id];tx.set(ref,{...x,poll:{...x.poll,votes}});return{...x,poll:{...x.poll,votes}};});
    return{poll:pollView(r)};}
   /* 이모지 반응 (사람마다 하나, 같은 걸 다시 누르면 취소) */
   if(action==='feedReact'){const e=String(input.e||'');if(e&&!REACTS.includes(e))fail(400,'반응을 확인해 주세요.');const ref=feedPosts.doc(id(input.id));
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');const x=d.data(),re={...(x.reacts||{})};if(!e||(re[actor.id]&&re[actor.id].e===e))delete re[actor.id];else re[actor.id]={e,n:actor.name};tx.set(ref,{...x,reacts:re});return{...x,reacts:re};});
    return reactView(r);}
   /* 피드 알림 켜기/끄기 (내 게시물의 좋아요·댓글 알림) */
   if(action==='feedPref'){if(typeof input.enabled!=='boolean')fail(400,'알림 설정을 확인해 주세요.');await db.runTransaction(async tx=>{const ref=prefs(actor.id),old=await tx.get(ref);tx.set(ref,{...(old.exists?old.data():{}),feed:input.enabled});});prefCache.delete(actor.id);return{enabled:input.enabled};}
   if(action==='feedImages'){const {d}=await post(input.id);return{id:d.id,images:Array.isArray(d.data().images)?d.data().images:[]};}
   if(action==='feedPost'){
    const kind=['thanks','poll'].includes(input.kind)?input.kind:'post';
    const key=requestId(input.id),images=kind==='post'?validateImages(input.images):[],text=typeof input.text==='string'?input.text.trim():'';
    if(text.length>2000)fail(400,'글은 2000자까지 쓸 수 있어요.');
    let extraDoc={},thanksTo=null;
    if(kind==='post'){if(!text&&!images.length)fail(400,'사진이나 글을 넣어 주세요.');}
    if(kind==='thanks'){if(!text)fail(400,'고마운 마음을 적어 주세요.');if(text.length>500)fail(400,'감사 카드는 500자까지 쓸 수 있어요.');thanksTo=(await roster()).find(a=>a.id===String(input.to||''));if(!thanksTo||thanksTo.id==='management')fail(400,'받는 사람을 골라 주세요.');if(thanksTo.id===actor.id)fail(400,'나에게는 보낼 수 없어요.');extraDoc={to:{id:thanksTo.id,name:thanksTo.name},priv:input.priv!==false};}
    if(kind==='poll'){const q=typeof input.q==='string'?input.q.trim():'';if(!q||q.length>120)fail(400,'투표 질문을 120자 안으로 적어 주세요.');const opts=(Array.isArray(input.options)?input.options:[]).map(o=>String(o||'').trim()).filter(Boolean);if(opts.length<2||opts.length>6||opts.some(o=>o.length>40))fail(400,'선택지는 2~6개, 각 40자까지예요.');extraDoc={poll:{q,options:opts,multi:input.multi===true,anon:input.anon===true,votes:{}}};}
    const ref=feedPosts.doc(id(actor.id+'_'+key));
    let fresh=false;await db.runTransaction(async tx=>{const old=await tx.get(ref);if(old.exists)return;await limited(tx,actor,'feed',5000);fresh=true;tx.set(ref,{owner:actor.id,name:actor.name,text,images,createdAt:now(),likes:{},commentCount:0,recent:[],...(kind==='post'?{}:{kind}),...extraDoc});});
    if(fresh&&kind==='thanks'&&thanksTo){const sref=root.doc('feedStats');await db.runTransaction(async tx=>{const d=await tx.get(sref),t={...(d.exists&&d.data()&&typeof d.data().thanks==='object'?d.data().thanks:{})};t[thanksTo.id]=(Number(t[thanksTo.id])||0)+1;tx.set(sref,{...(d.exists?d.data():{}),thanks:t});});
     /* 감사 카드는 꿈마당 알림을 꺼도 꼭 전달 (알림 설정에 없는 celebrate 종류) */
     const tn={title:actor.name+'님이 감사 카드를 보냈어요 💌',body:text.slice(0,120),target:'feed',type:'celebrate',tag:'feed-'+ref.id};await db.runTransaction(async tx=>{notices(tx,[thanksTo],'feedthx_'+ref.id,tn);});const tj=safePush([thanksTo],tn);if(!(defer&&defer(tj)))await tj;}
    if(fresh&&text.includes('@')){const tg=tagged(text,await roster());if(tg.length)await tagNotify(tg,{key:'feedtag_'+ref.id,n:{title:actor.name+'님이 게시물에 회원님을 태그했어요',body:(text.replace(/@/g,'')||'사진').slice(0,120),target:'feed',type:'feed',tag:'feed-'+ref.id}});}
    return{item:view(await ref.get())};
   }
   if(action==='feedEdit'){
    const text=typeof input.text==='string'?input.text.trim():'';if(text.length>2000)fail(400,'글은 2000자까지 쓸 수 있어요.');
    const ref=feedPosts.doc(id(input.id));
    let before='';await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요.');const x=d.data();if(x.kind==='bday')fail(400,'생일 게시물은 고칠 수 없어요.');if(x.owner!==actor.id)fail(403,'올린 사람만 고칠 수 있어요.');if(!text&&!(x.images||[]).length)fail(400,'사진이 없는 글은 비울 수 없어요.');before=x.text||'';tx.set(ref,{...x,text,editedAt:now()});});
    if(text.includes('@')){const people=await roster(),was=new Set(tagged(before,people).map(a=>a.id)),tg=tagged(text,people).filter(a=>!was.has(a.id));if(tg.length)await tagNotify(tg,{key:'feedtag_'+ref.id+'_'+now(),n:{title:actor.name+'님이 게시물에 회원님을 태그했어요',body:(text.replace(/@/g,'')||'사진').slice(0,120),target:'feed',type:'feed',tag:'feed-'+ref.id}});}
    return{item:view(await ref.get())};
   }
   if(action==='feedDelete'){
    const ref=feedPosts.doc(id(input.id)),cs=await feedComments(input.id).get();
    const sref=root.doc('feedStats');await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)return;const x=d.data();if(x.kind==='bday'?!staff:(x.owner!==actor.id&&!staff))fail(403,'올린 사람이나 관리자급만 지울 수 있어요.');const st=x.kind==='thanks'&&x.to?await tx.get(sref):null;
     cs.docs.slice(0,450).forEach(c=>tx.delete(feedComments(input.id).doc(c.id)));tx.delete(ref);if(st){const t={...(st.exists&&st.data()&&typeof st.data().thanks==='object'?st.data().thanks:{})};t[x.to.id]=Math.max(0,(Number(t[x.to.id])||0)-1);tx.set(sref,{...(st.exists?st.data():{}),thanks:t});}});
    return{ok:true};
   }
   /* 생일 게시물 '축하하기': 한 번 누르면 축하가 올라가고 다시 누르면 취소. 생일인 사람에게는 끌 수 없는 알림 */
   if(action==='feedCheer'){
    const on=input.on!==false,ref=feedPosts.doc(id(input.id));
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');const x=d.data();if(x.kind!=='bday')fail(400,'생일 게시물이 아니에요.');if(x.owner===actor.id)fail(400,'내 생일은 축하받는 날이에요 🎂');
     const cheers={...(x.cheers&&typeof x.cheers==='object'?x.cheers:{})},had=!!cheers[actor.id];if(on)cheers[actor.id]=had?cheers[actor.id]:{n:actor.name,at:now()};else delete cheers[actor.id];tx.set(ref,{...x,cheers});
     const owner=on&&!had?(await roster()).find(a=>a.id===x.owner):null;const note={title:actor.name+'님이 생일을 축하했어요 🎉',body:'꿈마당 생일 게시물에서 확인해 보세요',target:'feed',type:'celebrate',tag:'feed-'+ref.id};
     const oc=Object.keys(cheers).filter(k=>k!==actor.id).length;if(oc)note.title=actor.name+'님 외 '+oc+'명이 생일을 축하했어요 🎉';
     if(owner)notices(tx,[owner],'feedcheer_'+ref.id,note);return{x:{...x,cheers},owner,note};});
    if(r.owner){const job=safePush([r.owner],r.note);if(!(defer&&defer(job)))await job;}
    return{item:view({id:ref.id,data:()=>r.x})};
   }
   if(action==='feedLike'){
    const on=input.on===true,ref=feedPosts.doc(id(input.id));
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');const x=d.data(),likes={...(x.likes&&typeof x.likes==='object'?x.likes:{})};const had=!!likes[actor.id];
     if(on)likes[actor.id]=actor.name;else delete likes[actor.id];tx.set(ref,{...x,likes});
     let owner=x.owner!==actor.id&&on&&!had?(await roster()).find(a=>a.id===x.owner):null;if(owner&&!(await enabled(owner.id,'feed')))owner=null;
     const others=Object.keys(likes).filter(k=>k!==x.owner&&k!==actor.id).length;
     if(owner)notices(tx,[owner],'feedlike_'+ref.id,{title:actor.name+'님'+(others?' 외 '+others+'명':'')+'이 게시물을 좋아해요',body:(x.text||'사진').slice(0,80),target:'feed',type:'feed',tag:'feed-'+ref.id});
     return{liked:on,likeCount:Object.keys(likes).length,likers:Object.values(likes).slice(0,60)};});
    return r;
   }
   if(action==='feedComments'){await post(input.id);const q=await feedComments(input.id).get();
    return{items:q.docs.map(d=>({...d.data(),id:d.id})).sort((a,b)=>a.createdAt-b.createdAt).slice(-300).map(c=>({...c,mine:c.owner===actor.id}))};}
   if(action==='feedComment'){
    const key=requestId(input.cid),text=typeof input.text==='string'?input.text.trim():'';if(!text)fail(400,'댓글을 입력해 주세요.');if(text.length>500)fail(400,'댓글은 500자까지 쓸 수 있어요.');
    const ref=feedPosts.doc(id(input.id)),cref=feedComments(input.id).doc(id(actor.id+'_'+key)),people=await roster(),pre=await ref.get(),ownerOn=pre.exists&&pre.data().owner!==actor.id?await enabled(pre.data().owner,'feed'):false;
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요. 지워졌을 수 있어요.');const old=await tx.get(cref);const x=d.data();
     if(old.exists)return{comment:{...old.data(),id:cref.id,mine:true},commentCount:Number(x.commentCount)||0,recent:x.recent||[],dup:true};
     await limited(tx,actor,'fcomment',1500);
     const c={owner:actor.id,name:actor.name,text,createdAt:now()};tx.set(cref,c);
     const recent=[...(Array.isArray(x.recent)?x.recent:[]),{id:cref.id,...c}].slice(-2),commentCount=(Number(x.commentCount)||0)+1;tx.set(ref,{...x,commentCount,recent});
     const owner=x.owner!==actor.id&&ownerOn?people.find(a=>a.id===x.owner):null;
     const note={title:actor.name+'님이 댓글을 남겼어요',body:text.slice(0,120),target:'feed',type:'feed',tag:'feed-'+ref.id};
     if(commentCount>1)note.body='(댓글 '+commentCount+'개) '+note.body;
     if(owner)notices(tx,[owner],'feedc_'+ref.id,note);return{comment:{...c,id:cref.id,mine:true},commentCount,recent,owner,note};});
    if(r.owner){const job=safePush([r.owner],r.note);if(!(defer&&defer(job)))await job;}
    if(!r.dup&&text.includes('@')){const tg=tagged(text,people).filter(a=>!r.owner||a.id!==r.owner.id);if(tg.length)await tagNotify(tg,{key:'feedctag_'+r.comment.id,n:{title:actor.name+'님이 댓글에서 회원님을 언급했어요',body:text.replace(/@/g,'').slice(0,120),target:'feed',type:'feed',tag:'feed-'+ref.id}});}
    return{comment:r.comment,commentCount:r.commentCount,recent:r.recent};
   }
   if(action==='feedCommentDelete'){
    const ref=feedPosts.doc(id(input.id)),cref=feedComments(input.id).doc(id(input.cid));
    const r=await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)fail(404,'게시물을 찾지 못했어요.');const c=await tx.get(cref);if(!c.exists)return{commentCount:Number(d.data().commentCount)||0};const x=d.data(),cx=c.data();
     if(cx.owner!==actor.id&&x.owner!==actor.id&&!staff)fail(403,'댓글 쓴 사람, 게시물 올린 사람, 관리자급만 지울 수 있어요.');
     tx.delete(cref);const commentCount=Math.max(0,(Number(x.commentCount)||0)-1);tx.set(ref,{...x,commentCount,recent:(x.recent||[]).filter(y=>y.id!==cref.id)});return{commentCount};});
    /* 미리보기(최근 2개) 다시 채우기 */
    try{const q=await feedComments(input.id).get(),all=q.docs.map(d=>({...d.data(),id:d.id})).sort((a,b)=>a.createdAt-b.createdAt),recent=all.slice(-2);const d=await ref.get();if(d.exists)await db.runTransaction(async tx=>{const z=await tx.get(ref);if(z.exists)tx.set(ref,{...z.data(),recent,commentCount:all.length});});r.recent=recent;r.commentCount=all.length;}catch{}
    return r;
   }
   fail(400,'지원하지 않는 요청이에요.');
  }
  if(action==='profileGet'){const p=await root.doc('profile_'+actor.id).get();return{photo:p.exists?p.data().photo||'':''};}
  if(action==='profileSave'){
   const photo=input.photo===''?'':validateImages([input.photo])[0];
   if(photo.length>24000)fail(400,'프로필 사진 크기를 줄여 주세요.');
   /* 크게 보기용 사진(선택): 작은 사진과 함께 저장, 채팅 목록에는 작은 것만 내려감 */
   const big=!photo||input.photoL==null||input.photoL===''?'':validateImages([input.photoL])[0];
   if(big.length>150000)fail(400,'프로필 사진 크기를 줄여 주세요.');
   await db.runTransaction(async tx=>{tx.set(root.doc('profile_'+actor.id),{photo,photoL:big,updatedAt:now()});});return{photo};
  }
  if(action==='profileBig'){const who=id(input.id);const p=await root.doc('profile_'+who).get();const d=p.exists?p.data():{};return{photo:d.photoL||d.photo||''};}
  if(action==='profiles'){
   if(!Array.isArray(input.ids)||input.ids.length>30)fail(400,'프로필 요청을 확인해 주세요.');
   const ids=[...new Set(input.ids.map(id))];
   const profiles=await Promise.all(ids.map(async who=>{const p=await root.doc('profile_'+who).get();return{id:who,photo:p.exists?p.data().photo||'':''};}));return{profiles};
  }
  /* 예배 없는 주일 저장: 콘솔 보안 규칙과 상관없이 서버가 직책을 확인하고 저장 (관리자급만) */
  /* 도우미가 답을 못 찾은 질문 모아 두기 (질문 글만, 누가 물었는지는 저장하지 않음) → 관리계정·단장이 보고 설명서를 보강 */
  if(action==='askMiss'){const q=typeof input.q==='string'?input.q.replace(/\s+/g,' ').trim().slice(0,200):'';if(q.length<2)return{ok:false};
   await root.doc('askMiss').collection('items').doc(id(String(now())+'_'+Math.random().toString(36).slice(2,8))).set({q,createdAt:now()});return{ok:true}}
  if(action==='askMissList'||action==='askMissClear'){if(!(actor.id==='management'||actor.rank==='관리계정'||actor.rank==='단장'))fail(403,'관리계정·단장만 볼 수 있어요.');
   const snap=await root.doc('askMiss').collection('items').orderBy('createdAt','desc').limit(200).get();
   if(action==='askMissClear'){await db.runTransaction(async tx=>{for(const d of snap.docs)tx.delete(root.doc('askMiss').collection('items').doc(d.id))});return{ok:true,cleared:snap.docs.length}}
   return{items:snap.docs.map(d=>({q:d.data().q,at:d.data().createdAt}))}}
  if(action==='noServiceGet'){const d=await db.collection('settings').doc('noService').get();const x=d.exists?d.data():{};return{days:x.days&&typeof x.days==='object'?x.days:{}}}
  if(action==='noServiceSave'){if(!ADMIN.has(actor.rank))fail(403,'예배 없는 주일은 관리자급(단장 · 인도자 · 선임)만 등록할 수 있어요.');
   const days=input.days&&typeof input.days==='object'&&!Array.isArray(input.days)?input.days:null;if(!days)fail(400,'날짜를 확인해 주세요.');
   const keys=Object.keys(days);if(keys.length>300)fail(400,'너무 많아요.');const clean={};
   for(const k of keys){if(!/^\d{4}-\d{2}-\d{2}$/.test(k))fail(400,'날짜 형식을 확인해 주세요.');clean[k]=typeof days[k]==='string'?days[k].trim().slice(0,60):''}
   const fix=Array.isArray(input.fix)?input.fix.slice(0,50):[];
   await db.collection('settings').doc('noService').set({days:clean,up:now(),by:String(actor.name||'').slice(0,30)});
   for(const f of fix){if(!f||typeof f.id!=='string'||!/^[\w-]{1,80}$/.test(f.id)||typeof f.from!=='string'||!f.from.trim()||f.from.length>30)continue;const r=db.collection('overrides').doc(f.id);const d=await r.get();if(d.exists)await r.set({from:f.from.trim()},{merge:true})}
   return{ok:true,count:keys.length}}
  if(action==='status'){const through=await readThrough(),s=await inbox(actor.id).where('createdAt','>',through).orderBy('createdAt','desc').limit(99).get();return{unread:s.docs.filter(d=>!d.data().readAt).length,account:{id:actor.id,name:actor.name,rank:actor.rank},admin:ADMIN.has(actor.rank),leader:leader(actor)};}
  if(action==='inbox'){const through=await readThrough(),result=await list(inbox(actor.id),input,60,through);result.items=result.items.filter(n=>!n.readAt).map(n=>({...n,read:false}));return result;}
  if(action==='readAll'){const through=now();await db.runTransaction(async tx=>{const s=await tx.get(readState);tx.set(readState,{readThrough:Math.max(through,s.exists?Number(s.data().readThrough)||0:0)});});
   /* 읽은 알림은 쌓아 두지 않고 지움 (한 번에 최대 300개, 남은 건 매일 정리) */
   try{const old=await inbox(actor.id).where('createdAt','<=',through).orderBy('createdAt','desc').limit(300).get();if(!old.empty)await db.runTransaction(async tx=>{old.docs.forEach(d=>tx.delete(d.ref));});}catch(e){}
   return{ok:true,readThrough:through};}
  /* 여러 개 한 번에 읽음(종류별 '모두 읽음') */
  if(action==='readMany'){const ids=Array.isArray(input.ids)?[...new Set(input.ids.map(id))].slice(0,100):[];if(!ids.length)fail(400,'읽을 알림을 골라 주세요.');
   await db.runTransaction(async tx=>{ids.forEach(k=>tx.delete(inbox(actor.id).doc(k)));});return{ok:true,count:ids.length};}
  if(action==='read'){const ref=inbox(actor.id).doc(id(input.id));return db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)fail(404,'알림을 찾을 수 없어요.');const note=packet(s);tx.delete(ref);return{note:{...note,read:true}};});}
  if(action==='chatPreference'){prefCache.delete(actor.id);
   roomAccess(actor,input.room);if(typeof input.enabled!=='boolean')fail(400,'알림 설정을 확인해 주세요.');
   await db.runTransaction(async tx=>{const ref=prefs(actor.id),old=await tx.get(ref);tx.set(ref,{...(old.exists?old.data():{}),[input.room]:input.enabled});});prefCache.delete(actor.id);return{enabled:input.enabled};
  }
  /* 채팅 안 읽은 개수 (탭·버튼 배지용): 내가 마지막으로 본 뒤 남이 보낸 메시지 수, 최대 99 */
  if(action==='chatUnread'){const r=typeof input.room==='string'?input.room:'all';roomAccess(actor,r);const sd=await root.doc(actor.id==='management'?'mseen_'+r:'seen_'+r).get();const at=actor.id==='management'?(sd.exists&&Number((sd.data()||{}).at)||0):(sd.exists&&sd.data()&&sd.data().at&&Number(sd.data().at[actor.id])||0);
   const since=Math.max(at,now()-RETENTION);const q=await messages(r).where('createdAt','>',since).limit(100).get();const n=q.docs.filter(d=>{const x=d.data()||{};return x.owner!==actor.id&&!x.deleted}).length;return{room:r,unread:Math.min(99,n)};}
  if(action==='chat'){roomAccess(actor,input.room);const seenRef=root.doc('seen_'+input.room);
   const [result,notificationsEnabled,seenDoc,people]=await Promise.all([list(messages(input.room),input,30,now()-RETENTION),enabled(actor.id,input.room),seenRef.get(),roster()]);result.items=result.items.map(summary).reverse();
   /* 읽음 표시: 채팅을 열어 둔 채 목록을 받으면 '여기까지 읽음'. 새 메시지가 있을 때만 기록 */
   const seen={...(seenDoc.exists&&seenDoc.data()&&typeof seenDoc.data().at==='object'?seenDoc.data().at:{})};
   const latest=result.items.reduce((m,x)=>Math.max(m,Number(x.createdAt)||0),0);
   if(!input.cursor&&actor.id!=='management'&&latest&&(Number(seen[actor.id])||0)<latest){const t=now();seen[actor.id]=t;
    /* 여러 사람이 동시에 읽어도 서로 막지 않게: 내 칸만 덮어쓰기, 응답은 기다리지 않음 */
    const job=Promise.resolve().then(()=>seenRef.set({at:{[actor.id]:t}},{merge:true})).catch(()=>{});if(!(defer&&defer(job)))await job;}
   /* 관리계정은 읽음 표시에는 안 나오지만, 안 읽은 수 배지는 따로 기록해서 지워지게 */
   if(!input.cursor&&actor.id==='management'&&latest){const job=Promise.resolve().then(()=>root.doc('mseen_'+input.room).set({at:now()})).catch(()=>{});if(!(defer&&defer(job)))await job;}
   const readers=people.filter(a=>a.id!=='management').map(a=>({id:a.id,name:a.name}));
   return {...result,notificationsEnabled,readers,seen:Object.fromEntries(readers.map(r=>[r.id,Number(seen[r.id])||0]))};}
  /* 이모지 반응 (카톡처럼 한 사람당 하나 · 같은 걸 다시 누르면 취소) */
  if(action==='chatReact'){roomAccess(actor,input.room);const E=['❤️','👍','✅','😆','😮','😢','🙏','🔥'];const e=typeof input.e==='string'?input.e:'';if(e&&!E.includes(e))fail(400,'반응을 확인해 주세요.');
   const ref=messages(input.room).doc(id(input.id));
   return db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)fail(404,'메시지를 찾을 수 없어요.');const x=s.data()||{};if(Number(x.createdAt)<=now()-RETENTION||x.deleted)fail(404,'메시지를 찾을 수 없어요.');
    const rx={...(x.rx&&typeof x.rx==='object'?x.rx:{})};if(!e||(rx[actor.id]&&rx[actor.id].e===e))delete rx[actor.id];else rx[actor.id]={e,n:String(actor.name||'').slice(0,40)};
    tx.set(ref,{...x,rx});return{id:s.id,rx};});}
  if(action==='chatImages'){roomAccess(actor,input.room);const s=await messages(input.room).doc(id(input.id)).get();if(!s.exists||s.data().createdAt<=now()-RETENTION)fail(404,'삭제되었거나 보관 기간이 지난 이미지예요.');return{images:s.data().images||[]};}
  if(action==='send'){
   roomAccess(actor,input.room);const images=validateImages(input.images),key=requestId(input.id),content=typeof input.text==='string'?input.text.trim():'';
   if(content.length>2000||(!content&&!images.length))fail(400,'메시지나 이미지를 넣어 주세요.');
   const ref=messages(input.room).doc(id(actor.id+'_'+key));
   const members=(await roster()).filter(a=>a.id!==actor.id&&(input.room==='all'||ADMIN.has(a.rank)));
   /* 답장: 원래 메시지를 짧게 붙여 둬요 (원문이 지워져도 답장 말풍선엔 남음) */
   let reply=null;if(typeof input.reply==='string'&&input.reply){try{const rs=await messages(input.room).doc(id(input.reply)).get();if(rs.exists){const x=rs.data()||{};if(!x.deleted&&Number(x.createdAt)>now()-RETENTION)reply={id:rs.id,owner:String(x.owner||''),name:String(x.name||'팀원').slice(0,40),text:String(x.text||'').slice(0,120),img:Array.isArray(x.images)?x.images.length:0}}}catch(e){}}
   /* @이름 언급: 채팅 알림을 꺼 둔 사람에게도 '언급' 알림을 보냄. @모두는 이 방 모두 */
   const mentionAll=/(^|\s)@모두(?![가-힣A-Za-z0-9])/.test(content);
   const mentioned=members.filter(a=>mentionAll||new RegExp('(^|\\s)@'+String(a.name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![가-힣A-Za-z0-9])').test(content));
   const mentionIds=new Set(mentioned.map(a=>a.id));
   const recipients=(await Promise.all(members.filter(a=>!mentionIds.has(a.id)).map(async a=>await enabled(a.id,input.room)?a:null))).filter(Boolean);
   const note={title:actor.name,sender:actor.name,body:(content||('사진 '+images.length+'장')).slice(0,160),target:'community',room:input.room,type:'chat',tag:'chat-'+input.room};
   const mentionNote={...note,title:actor.name+'님이 회원님을 언급했어요',type:'mention',tag:'mention-'+input.room};
   const result=await db.runTransaction(async tx=>{
    const rateRef=root.doc('rate_'+actor.id+'_chat');const [old,rs]=await Promise.all([tx.get(ref),tx.get(rateRef)]);
    if(old.exists){const saved=old.data();if(saved.text!==content||JSON.stringify(saved.images||[])!==JSON.stringify(images))fail(409,'같은 요청 번호로 다른 메시지를 보낼 수 없어요. 새 메시지로 보내 주세요.');return{item:summary(packet(old)),duplicate:true};}
    const time=now(),item={owner:actor.id,name:actor.name,text:content,images,createdAt:time,expiresAt:timestamp(time+RETENTION),...(reply?{reply}:{})};
    if(rs.exists&&time-Number(rs.data().at)<250)fail(429,'잠시 후 다시 시도해 주세요.');tx.set(rateRef,{at:time});tx.set(ref,item);/* 일반 채팅은 알림함에 쌓지 않음(채팅 안 읽은 수 배지 + 휴대폰 알림으로 충분). @언급만 알림함에 */if(mentioned.length)notices(tx,mentioned,'chat_'+ref.id,mentionNote);return{item:summary({id:ref.id,...item})};
   });
   /* 보낸 사람은 여기까지 읽은 것 */
   if(!result.duplicate&&actor.id!=='management'){const sj=Promise.resolve().then(()=>root.doc('seen_'+input.room).set({at:{[actor.id]:now()}},{merge:true})).catch(()=>{});if(!(defer&&defer(sj)))await sj;}
   if(!result.duplicate){const job=(async()=>{const p=await safePush(recipients,note);const mp=mentioned.length?await safePush(mentioned,mentionNote):undefined;return{p,mp};})();
    if(defer&&defer(job))result.pushQueued=true;else{const r=await job;result.push=r.p;if(r.mp)result.mentionPush=r.mp;}}
   return result;
  }
  if(action==='songs')return list(songs,input);
  if(action==='songCreate'){
   const key=requestId(input.id),ref=songs.doc(id(actor.id+'_'+key)),title=text(input.title,120,'곡 제목'),links=videoLinks(input),urls=links.map(x=>x.url),url=urls[0],recipients=(await roster()).filter(leader);
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(ref);if(old.exists)return{item:packet(old),duplicate:true};
    await limited(tx,actor,'song',10000);const time=now(),item={owner:actor.id,name:actor.name,title,url,urls,links,createdAt:time,updatedAt:time,revision:1};
    tx.set(ref,item);notices(tx,recipients,'song_'+ref.id,{title:'찬양 신청',body:actor.name+' · '+title,target:'song_requests',type:'song',songId:ref.id});return{item:{id:ref.id,...item}};
   });
   if(!result.duplicate)result.push=await safePush(recipients,{title:'찬양 신청',body:actor.name+' · '+title,target:'song_requests',type:'song'});return result;
  }
  if(['songUpdate','songDelete','songComplete'].includes(action)){
   const ref=songs.doc(id(input.id));return db.runTransaction(async tx=>{
    const s=await tx.get(ref);if(!s.exists)fail(404,'이미 삭제되거나 콘티에 반영된 신청곡이에요.');const item=s.data();songAccess(actor,item,action==='songComplete'?'complete':'owner');
    if(input.revision!==item.revision)fail(409,'신청곡이 변경됐어요. 새로고침 후 다시 확인해 주세요.');
    if(action==='songUpdate'){const links=videoLinks(input),urls=links.map(x=>x.url);tx.update(ref,{title:text(input.title,120,'곡 제목'),url:urls[0],urls,links,updatedAt:now(),revision:item.revision+1});}
    else{tx.delete(ref);if(action==='songComplete')notices(tx,[{id:item.owner}],'done_'+ref.id,{title:'신청곡 반영 완료',body:item.title+' · '+actor.name,target:'archive',type:'song'});}return{ok:true};
   });
  }
  fail(400,'지원하지 않는 요청이에요.');
 };
}
module.exports={ADMIN,RETENTION,fail,text,id,videoUrl,roomAccess,songAccess,createService};
