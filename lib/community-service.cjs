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
// 채팅방은 전체 인원이 함께 쓰는 '전체 채팅' 하나만 사용 (예전 관리자방은 닫음)
function roomAccess(actor,room){if(room!=='all')fail(400,'채팅방은 전체 채팅 하나만 있어요. 앱을 새로고침해 주세요.');}
function songAccess(actor,song,op){if(op==='complete'){if(!['인도자','관리계정'].includes(actor.rank))fail(403,'인도자만 콘티 반영을 완료할 수 있어요.');}else if(song.owner!==actor.id)fail(403,'신청한 본인만 수정하거나 삭제할 수 있어요.');}
function createService({db,accounts,push=async()=>({sent:0}),defer=null,now=Date.now,timestamp=n=>new Date(n)}){
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
 return async function run(actor,input){
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
   return{range,from,to,days,items};
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
   const note={title:'대신 서 줄 수 있나요?',body:`${actor.name}님 요청 · ${label} 주일${role?' '+role:''} · ${forName&&forName!==actor.name?forName+'님 대신':actor.name+'님 대신'}`.slice(0,160),target:'community',room:'all',type:'sched',tag:'subreq-'+date};
   await db.runTransaction(async tx=>{await limited(tx,actor,'subreq',5000);notices(tx,[target],'subreq_'+date+'_'+actor.id+'_'+target.id,note);});
   const push=await safePush([target],note);return{ok:true,push};
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
   /* @이름 언급: 채팅 알림을 꺼 둔 사람에게도 '언급' 알림을 보냄. @모두는 이 방 모두 */
   const mentionAll=/(^|\s)@모두(?![가-힣A-Za-z0-9])/.test(content);
   const mentioned=members.filter(a=>mentionAll||new RegExp('(^|\\s)@'+String(a.name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![가-힣A-Za-z0-9])').test(content));
   const mentionIds=new Set(mentioned.map(a=>a.id));
   const recipients=(await Promise.all(members.filter(a=>!mentionIds.has(a.id)).map(async a=>await enabled(a.id,input.room)?a:null))).filter(Boolean);
   const note={title:actor.name,sender:actor.name,body:(content||('사진 '+images.length+'장')).slice(0,160),target:'community',room:input.room,type:'chat',tag:'chat-'+input.room};
   const mentionNote={...note,title:actor.name+'님이 회원님을 언급했어요',type:'mention',tag:'mention-'+input.room};
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(ref);
    if(old.exists){const saved=old.data();if(saved.text!==content||JSON.stringify(saved.images||[])!==JSON.stringify(images))fail(409,'같은 요청 번호로 다른 메시지를 보낼 수 없어요. 새 메시지로 보내 주세요.');return{item:summary(packet(old)),duplicate:true};}
    const time=now(),item={owner:actor.id,name:actor.name,text:content,images,createdAt:time,expiresAt:timestamp(time+RETENTION)};
    await limited(tx,actor,'chat',1000);tx.set(ref,item);notices(tx,recipients,'chat_'+ref.id,note);if(mentioned.length)notices(tx,mentioned,'chat_'+ref.id,mentionNote);return{item:summary({id:ref.id,...item})};
   });
   if(!result.duplicate){const job=(async()=>{const p=await safePush(recipients,note);const mp=mentioned.length?await safePush(mentioned,mentionNote):undefined;return{p,mp};})();
    if(defer&&defer(job))result.pushQueued=true;else{const r=await job;result.push=r.p;if(r.mp)result.mentionPush=r.mp;}}
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
