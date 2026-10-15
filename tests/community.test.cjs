'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createService,RETENTION}=require('../lib/community-service.cjs');
const {validateImages,summary}=require('../lib/chat-images.cjs');
function fixture(){
 const pushed=[];
 const data=new Map();let clock=2000000000000,queue=Promise.resolve();
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const deep=(a,b)=>{const o={...(a||{})};for(const[k,v]of Object.entries(b))o[k]=v&&typeof v==='object'&&!Array.isArray(v)?deep(o[k],v):v;return o};
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),set:async(v,o)=>{data.set(path,o&&o.merge?deep(data.get(path),v):v)},collection:n=>col(path+'/'+n)});
 function col(path,state={}){return{
  doc:key=>ref(path+'/'+key),
  orderBy:()=>col(path,state),where:(field,op,value)=>col(path,{...state,cutoff:value}),
  startAfter:(a,b)=>col(path,{...state,after:typeof a==='object'?[a.data().createdAt,a.id]:[a,b]}),
  limit:n=>col(path,{...state,limit:n}),
  get:async()=>{let docs=[...data.keys()].filter(p=>p.startsWith(path+'/')&&p.slice(path.length+1).indexOf('/')===-1).map(snap).sort((a,b)=>b.data().createdAt-a.data().createdAt||b.id.localeCompare(a.id));
   if(state.cutoff!=null)docs=docs.filter(d=>d.data().createdAt>state.cutoff);
   if(state.after)docs=docs.filter(d=>d.data().createdAt<state.after[0]||d.data().createdAt===state.after[0]&&d.id<state.after[1]);
   docs=docs.slice(0,state.limit||Infinity);return{docs,size:docs.length};}
 };}
 const db={collection:col,runTransaction:fn=>{const op=queue.then(async()=>{let written=false;const writes=[];const result=await fn({get:async r=>{assert.equal(written,false,'Firestore reads must precede writes');return snap(r.path);},set:(r,v)=>{written=true;writes.push(()=>data.set(r.path,v));},update:(r,v)=>{written=true;writes.push(()=>data.set(r.path,{...data.get(r.path),...v}));},delete:r=>{written=true;writes.push(()=>data.delete(r.path));}});writes.forEach(w=>w());return result;});queue=op.catch(()=>{});return op;}};
 const user={id:'u'.repeat(128),name:'팀원',rank:'싱어',status:'approved'},admin={id:'management',name:'관리계정',rank:'관리계정',status:'approved'};
 const outsider={id:"other_user",name:"다른 팀원",rank:"싱어",status:"approved"};
 const run=createService({db,accounts:async()=>[user,admin,outsider],push:async(recipients,note)=>{pushed.push({recipients,note});return{sent:recipients.length};},now:()=>clock});
 return{run,user,admin,outsider,pushed,data,clock:()=>clock,advance:()=>clock+=11000};
}
test('long owner ID: send retry stays one message; images lookup accepts stored ID',async()=>{
 const f=fixture(),input={action:'send',room:'all',id:'request_12345678',text:'안녕',images:[]};
 const [a,b]=await Promise.all([f.run(f.user,input),f.run(f.user,input)]);assert.equal(a.item.id,b.item.id);assert.equal(b.duplicate,true);
 assert.deepEqual(await f.run(f.user,{action:'chatImages',room:'all',id:a.item.id}),{images:[]});
 assert.equal((await f.run(f.user,{action:'chat',room:'all'})).items.length,1);
 await assert.rejects(f.run(f.user,{...input,text:'다른 메시지'}),{status:409});
});
test('permissions, validation and rate limits remain enforced',async()=>{
 const f=fixture();for(const who of [f.user,f.admin])await assert.rejects(f.run(who,{action:'chat',room:'admin'}),{status:400});
 await assert.rejects(f.run({...f.user,status:'pending'},{action:'status'}),{status:403});
 await assert.rejects(f.run(f.user,{action:'send',room:'all',id:'../x',text:'x'}),{status:400});
 await f.run(f.user,{action:'send',room:'all',id:'request_1',text:'a'});
 await assert.rejects(f.run(f.user,{action:'send',room:'all',id:'request_2',text:'b'}),{status:429});
});
test('cursor survives deletion, stable ordering, expired messages excluded',async()=>{
 const f=fixture(),base='_kzCommunity/room_all/kzChatMessages/';
 for(let n=0;n<125;n++)f.data.set(base+'message_'+String(n).padStart(3,'0'),{createdAt:f.clock()-Math.floor(n/2),text:String(n),owner:f.user.id});
 f.data.set(base+'expired',{createdAt:f.clock()-RETENTION,text:'old'});
 const one=await f.run(f.user,{action:'chat',room:'all'});assert.equal(one.items.length,30);assert.ok(one.cursor);
 const oldest=one.items[0];f.data.delete(base+oldest.id);
 const two=await f.run(f.user,{action:'chat',room:'all',cursor:one.cursor});assert.equal(two.items.length,30);
 const all=[...one.items,...two.items];let cursor=two.cursor;while(cursor){const page=await f.run(f.user,{action:'chat',room:'all',cursor});all.push(...page.items);cursor=page.cursor;}
 assert.equal(new Set(all.map(x=>x.id)).size,125);assert.ok(all.every(x=>x.createdAt>f.clock()-RETENTION));
 await assert.rejects(f.run(f.user,{action:'chat',room:'all',cursor:'v1.invalid'}),{status:400});
});
test('long song and notification IDs; ownership; revision conflict; completion',async()=>{
 const f=fixture(),song=await f.run(f.user,{action:'songCreate',id:'song_request_1',title:'찬양',url:'https://youtu.be/test'});
 await assert.rejects(f.run(f.admin,{action:'songUpdate',id:song.item.id,revision:1,title:'x',url:'https://youtu.be/x'}),{status:403});
 await f.run(f.user,{action:'songUpdate',id:song.item.id,revision:1,title:'수정',url:'https://youtu.be/x'});
 await assert.rejects(f.run(f.user,{action:'songDelete',id:song.item.id,revision:1}),{status:409});
 await f.run(f.admin,{action:'songComplete',id:song.item.id,revision:2});
 const inbox=await f.run(f.user,{action:'inbox'});assert.equal(inbox.items.length,1);
 await f.run(f.user,{action:'read',id:inbox.items[0].id});assert.equal((await f.run(f.user,{action:'inbox'})).items.length,0);
});
test('malformed JPEG marker cannot throw RangeError; summary omits image bodies',()=>{
 const malformed=Buffer.from([255,216,255,255,255,255,255,255,255,255,255,255,255,217]);
 assert.throws(()=>validateImages(['data:image/jpeg;base64,'+malformed.toString('base64')]),{status:400});
 assert.throws(()=>validateImages(['data:image/png;base64,abcd']),{status:400});
 assert.deepEqual(validateImages(undefined),[]);
 assert.deepEqual(summary({id:'x',images:['big'],expiresAt:new Date(0)}),{id:'x',imageCount:1});
});

const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,192,0,11,8,0,2,0,2,1,1,17,0,255,217]).toString('base64');
test('image-only messages retain attachment on idempotent retry',async()=>{const f=fixture();const input={action:'send',room:'all',id:'image_request',text:'',images:[jpeg]};const r=await f.run(f.user,input);assert.equal(r.item.imageCount,1);assert.deepEqual((await f.run(f.user,{action:'chatImages',room:'all',id:r.item.id})).images,[jpeg]);await f.run(f.user,input);assert.equal(f.pushed.length,1);});
test('notifications default on, exclude sender and nonmembers, honor room mute; only the single all-member room exists',async()=>{const f=fixture();await f.run(f.user,{action:'send',room:'all',id:'notify_request',text:'hello'});assert.deepEqual(f.pushed[0].recipients.map(a=>a.id),[f.admin.id,f.outsider.id]);assert.equal((await f.run(f.admin,{action:'inbox'})).items[0].room,'all');await f.run(f.outsider,{action:'chatPreference',room:'all',enabled:false});f.advance();await f.run(f.user,{action:'send',room:'all',id:'notify_request2',text:'hello'});assert.deepEqual(f.pushed[1].recipients.map(a=>a.id),[f.admin.id]);assert.equal((await f.run(f.outsider,{action:'chat',room:'all'})).notificationsEnabled,false);f.advance();await assert.rejects(f.run(f.admin,{action:'send',room:'admin',id:'admin_request',text:'private'}),{status:400});assert.equal(f.pushed.length,2);await assert.rejects(f.run(f.outsider,{action:'chatPreference',room:'admin',enabled:true}),{status:400});});
test('profile photo is saved only for authenticated actor and removable',async()=>{const f=fixture();await f.run(f.user,{action:'profileSave',id:f.admin.id,photo:jpeg});assert.equal((await f.run(f.user,{action:'profileGet'})).photo,jpeg);assert.equal((await f.run(f.admin,{action:'profileGet'})).photo,'');const r=await f.run(f.admin,{action:'profiles',ids:[f.user.id]});assert.equal(r.profiles[0].photo,jpeg);await f.run(f.user,{action:'profileSave',photo:''});assert.equal((await f.run(f.user,{action:'profileGet'})).photo,'');await assert.rejects(f.run(f.user,{action:'profileSave',photo:'https://bad.test/image'}),{status:400});});

test('read all removes existing inbox items from view and leaves future messages unread',async()=>{const f=fixture();await f.run(f.user,{action:'send',room:'all',id:'readall_request',text:'one'});assert.equal((await f.run(f.admin,{action:'status'})).unread,1);await f.run(f.admin,{action:'readAll'});assert.equal((await f.run(f.admin,{action:'status'})).unread,0);assert.equal((await f.run(f.admin,{action:'inbox'})).items.length,0);f.advance();await f.run(f.user,{action:'send',room:'all',id:'readall_request2',text:'two'});assert.equal((await f.run(f.admin,{action:'status'})).unread,1);assert.equal((await f.run(f.admin,{action:'inbox'})).items.filter(n=>n.read).length,0);});
test('presence tracks each session, expires stale heartbeats and requires approval',async()=>{
 const f=fixture();const rows=()=>f.run(f.user,{action:'members'});const active=async()=> (await rows()).items.find(x=>x.id===f.user.id).online;
 assert.equal(await active(),false);
 await f.run(f.user,{action:'presence',session:'device1',active:true});assert.equal(await active(),true);
 await f.run(f.user,{action:'presence',session:'device2',active:true});
 await f.run(f.user,{action:'presence',session:'device1',active:false});assert.equal(await active(),true);
 await f.run(f.user,{action:'presence',session:'device2',active:false});assert.equal(await active(),false);
 await f.run(f.user,{action:'presence',session:'device2',active:true});for(let i=0;i<6;i++)f.advance();assert.equal(await active(),false);
 await assert.rejects(f.run({...f.user,status:'pending'},{action:'members'}),e=>e.status===403);
 await assert.rejects(f.run(f.user,{action:'presence',session:'device1',active:'yes'}),e=>e.status===400);
});

test('reading a notification deletes it and preserves its destination',async()=>{const f=fixture();await f.run(f.user,{action:'send',room:'all',id:'read_one',text:'hello'});const note=(await f.run(f.admin,{action:'inbox'})).items[0];const r=await f.run(f.admin,{action:'read',id:note.id});assert.equal(r.note.target,'community');assert.equal((await f.run(f.admin,{action:'inbox'})).items.length,0);assert.equal((await f.run(f.admin,{action:'status'})).unread,0);});
test('members list reports last seen time after a member leaves',async()=>{const f=fixture();const row=async()=>(await f.run(f.admin,{action:'members'})).items.find(x=>x.id===f.user.id);
 assert.equal((await row()).lastSeen,null);await f.run(f.user,{action:'presence',session:'d1',active:true});const t=f.clock();await f.run(f.user,{action:'presence',session:'d1',active:false});const r=await row();assert.equal(r.online,false);assert(r.lastSeen>=t);});
test('myAttendance: only my records, last month by Korean time, rate like the app',async()=>{
 const docs=[
  ['_status',{list:['x']}],
  ['a1',{date:'2026-09-06',type:'주일예배',list:[{n:'팀원'},{n:'다른 팀원'}],recs:{'팀원':{s:'출석'},'다른 팀원':{s:'무단 결석'}}}],
  ['a2',{date:'2026-09-13',type:'주일예배',list:[{n:'팀원'}],recs:{'팀원':{s:'일반 지각'}}}],
  ['a3',{date:'2026-09-20',type:'기타',label:'수련회',list:[{n:'팀원'}],recs:{'팀원':{s:'무단 결석'}}}],
  ['a4',{date:'2026-09-27',type:'주일예배',list:[{n:'팀원'}],recs:{}}],
  ['a5',{date:'2026-10-04',type:'주일예배',list:[{n:'팀원'}],recs:{'팀원':{s:'출석'}}}],
  ['a6',{date:'2026-08-30',type:'주일예배',list:[{n:'팀원'}],recs:{'팀원':{s:'출석'}}}]];
 let asked=null;
 const db={collection:name=>{if(name!=='attendance')return{doc:()=>({collection:()=>({})})};return{where:(f,op,v)=>{asked=[f,op,v];return{get:async()=>({docs:docs.map(([id,d])=>({id,data:()=>d}))})}}}}};
 /* 2026-10-01 00:30 KST = 2026-09-30 15:30 UTC → 이번 달은 10월, 지난달은 9월 */
 const run=createService({db,accounts:async()=>[],now:()=>Date.UTC(2026,8,30,15,30)});
 const r=await run({id:'u1',name:'팀원',rank:'싱어',status:'approved'},{action:'myAttendance'});
 assert.deepEqual(asked,['date','>=','2026-07-01']);
 assert.equal(r.last.month,'2026-09');assert.equal(r.last.assigned,4);assert.equal(r.last.counted,3);
 assert.equal(r.last.p,1);assert.equal(r.last.nl,1);assert.equal(r.last.ua,1);assert.equal(r.last.rate,66.7);
 assert.deepEqual(r.last.recs.map(x=>x.s),['출석','일반 지각','무단 결석','미입력']);assert.equal(r.last.recs[2].type,'수련회');
 assert.equal(r.prev[1].month,'2026-08');assert.equal(r.prev[1].rate,100);
 assert.ok(!JSON.stringify(r).includes('다른 팀원'));
 await assert.rejects(run({id:'u1',name:'팀원',status:'pending'},{action:'myAttendance'}),{status:403});
});
test('rsvp: everyone reads, each person sets only own answer, date window enforced',async()=>{
 const f=fixture(),d='2033-05-22';/* fixture clock 2000000000000 ≈ 2033-05-18 */
 assert.deepEqual((await f.run(f.user,{action:'rsvpGet',date:d})).answers,{});
 await f.run(f.user,{action:'rsvpSet',date:d,s:'yes'});
 const r=await f.run(f.outsider,{action:'rsvpSet',date:d,s:'no',note:'출장'});
 assert.equal(r.answers['팀원'].s,'yes');assert.equal(r.answers['다른 팀원'].s,'no');assert.equal(r.answers['다른 팀원'].note,'출장');
 const g=await f.run(f.admin,{action:'rsvpGet',date:d});assert.equal(Object.keys(g.answers).length,2);
 await f.run(f.user,{action:'rsvpSet',date:d,s:''});assert.equal((await f.run(f.user,{action:'rsvpGet',date:d})).answers['팀원'],undefined);
 await assert.rejects(f.run(f.user,{action:'rsvpSet',date:d,s:'maybe'}),{status:400});
 await assert.rejects(f.run(f.user,{action:'rsvpGet',date:'2020-01-05'}),{status:400});
 await assert.rejects(f.run(f.user,{action:'rsvpGet',date:'../x'}),{status:400});
});
test('mention: muted member still gets a mention notice; @모두 reaches everyone in the room',async()=>{const f=fixture();await f.run(f.outsider,{action:'chatPreference',room:'all',enabled:false});
 await f.run(f.user,{action:'send',room:'all',id:'mention_req1',text:'@'+f.outsider.name+' 확인 부탁해요'});
 const ids=f.pushed.flatMap(p=>p.recipients.map(a=>a.id));assert.ok(ids.includes(f.outsider.id));assert.ok(ids.includes(f.admin.id));
 const note=(await f.run(f.outsider,{action:'inbox'})).items[0];assert.equal(note.type,'mention');assert.match(note.title,/언급/);
 f.advance();const before=f.pushed.length;await f.run(f.user,{action:'send',room:'all',id:'mention_req2',text:'@모두 내일 연습해요'});
 const ids2=f.pushed.slice(before).flatMap(p=>p.recipients.map(a=>a.id));assert.deepEqual([...new Set(ids2)].sort(),[f.admin.id,f.outsider.id].sort());});
test('rsvp reminder: only weekdays, only targets without an answer, inbox + push; targets need staff',async()=>{const f=fixture();
 // fixture clock: find date fields from service by running at a known Monday KST
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가수1',rank:'싱어',status:'approved'},{id:'a2',name:'가수2',rank:'싱어',status:'approved'},{id:'m1',name:'선임',rank:'선임싱어',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,12,10,0);/* 2026-10-12 (월) 19:00 KST */
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),collection:n=>({doc:k=>ref(path+'/'+n+'/'+k)})});
 const db={collection:n=>({doc:k=>ref(n+'/'+k)}),runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v)),update:(x,v)=>w.push(()=>data.set(x.path,{...data.get(x.path),...v})),delete:x=>w.push(()=>data.delete(x.path))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 await assert.rejects(run(people[0],{action:'rsvpTargets',date:'2026-10-18',targets:[{n:'가수1'}]}),{status:403});
 await run(people[2],{action:'rsvpTargets',date:'2026-10-18',targets:[{n:'가수1',r:['싱어']},{n:'가수2',r:['싱어']}]});
 await run(people[1],{action:'rsvpSet',date:'2026-10-18',s:'yes'});
 const r=await run({system:true},{action:'rsvpRemind'});assert.equal(r.date,'2026-10-18');assert.equal(r.reminded,1);assert.deepEqual(pushed[0].r.map(a=>a.id),['a1']);
 assert.ok(data.get('_kzCommunity/inbox_a1/items/rsvp_2026-10-18'));
 const saved=data.get('_kzCommunity/rsvp_2026-10-18');assert.equal(saved.targets.length,2);assert.ok(saved.answers['가수2']);
 await assert.rejects(run(people[0],{action:'rsvpRemind'}),{status:400});
 clock=Date.UTC(2026,9,17,10,0);/* 토요일 */const r2=await run({system:true},{action:'rsvpRemind'});assert.equal(r2.skipped,'not-weekday');});
test('profile big photo: stored alongside, served by profileBig, not in profiles list',async()=>{const f=fixture();
 await f.run(f.user,{action:'profileSave',photo:jpeg,photoL:jpeg});const r=await f.run(f.admin,{action:'profiles',ids:[f.user.id]});assert.equal(r.profiles[0].photo,jpeg);assert.equal(r.profiles[0].photoL,undefined);
 assert.equal((await f.run(f.admin,{action:'profileBig',id:f.user.id})).photo,jpeg);
 await f.run(f.user,{action:'profileSave',photo:jpeg});assert.equal((await f.run(f.admin,{action:'profileBig',id:f.user.id})).photo,jpeg,'falls back to small photo');
 await f.run(f.user,{action:'profileSave',photo:''});assert.equal((await f.run(f.admin,{action:'profileBig',id:f.user.id})).photo,'');
 await assert.rejects(f.run(f.user,{action:'profileSave',photo:jpeg,photoL:'https://bad.test/x'}),{status:400});
 assert.equal((await f.run(f.admin,{action:'profileBig',id:'nobody'})).photo,'');});
test('ppt duty reminder: upcoming Sunday duty, once per person, override respected, inbox + push',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가',rank:'팀원',status:'approved'},{id:'a2',name:'나',rank:'팀원',status:'approved'},{id:'a3',name:'다',rank:'팀원',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,12,10,0);/* 2026-10-12 (월) 19:00 KST → 주일 10-18 */
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),collection:n=>({doc:k=>ref(path+'/'+n+'/'+k)})});
 const db={collection:n=>({doc:k=>ref(n+'/'+k)}),runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v)),update:(x,v)=>w.push(()=>data.set(x.path,{...data.get(x.path),...v})),delete:x=>w.push(()=>data.delete(x.path))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 assert.equal((await run({system:true},{action:'pptRemind'})).skipped,'no-rotation');
 data.set('settings/pptRotation',{members:['가','나','다'],weeks:2,start:'2026-10-11',overrides:{}});
 let r=await run({system:true},{action:'pptRemind'});assert.equal(r.date,'2026-10-18');assert.equal(r.name,'가');assert.equal(r.reminded,1);assert.equal(pushed.length,1);assert.equal(pushed[0].n.target,'lyrics');
 assert.ok(data.has('_kzCommunity/inbox_a1/items/ppt_2026-10-18'));
 r=await run({system:true},{action:'pptRemind'});assert.equal(r.skipped,'sent');assert.equal(pushed.length,1);
 data.set('settings/pptRotation',{members:['가','나','다'],weeks:2,start:'2026-10-11',overrides:{'2026-10-18':'다'}});
 r=await run({system:true},{action:'pptRemind'});assert.equal(r.name,'다');assert.equal(pushed.length,2);assert.deepEqual(pushed[1].r.map(a=>a.id),['a3']);
 clock=Date.UTC(2026,9,19,10,0);/* 10-19 (월) → 주일 10-25: 2주 교대 → 나 */data.set('settings/pptRotation',{members:['가','나','다'],weeks:2,start:'2026-10-11',overrides:{}});
 r=await run({system:true},{action:'pptRemind'});assert.equal(r.date,'2026-10-25');assert.equal(r.name,'나');
 clock=Date.UTC(2026,9,18,3,0);/* 일요일 */assert.equal((await run({system:true},{action:'pptRemind'})).skipped,'sunday');
 await assert.rejects(run(people[0],{action:'pptRemind'}),{status:400});});
test('no-service Sunday: no ppt/rsvp reminder that week, ppt rotation shifts one week',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가',rank:'팀원',status:'approved'},{id:'a2',name:'나',rank:'팀원',status:'approved'},{id:'a3',name:'다',rank:'팀원',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,12,10,0);
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),collection:n=>({doc:k=>ref(path+'/'+n+'/'+k)})});
 const db={collection:n=>({doc:k=>ref(n+'/'+k)}),runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v)),update:(x,v)=>w.push(()=>data.set(x.path,{...data.get(x.path),...v})),delete:x=>w.push(()=>data.delete(x.path))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 data.set('settings/pptRotation',{members:['가','나','다'],weeks:1,start:'2026-10-11',overrides:{}});
 data.set('settings/noService',{days:{'2026-10-18':'새생명초청주일'}});
 let r=await run({system:true},{action:'pptRemind'});assert.equal(r.skipped,'no-service');
 r=await run({system:true},{action:'rsvpRemind'});assert.equal(r.skipped,'no-service');
 clock=Date.UTC(2026,9,19,10,0);/* 주일 10-25: 10-11 가, 10-18 없음, 10-25 나 (한 주 밀림) */
 r=await run({system:true},{action:'pptRemind'});assert.equal(r.date,'2026-10-25');assert.equal(r.name,'나');assert.equal(pushed.length,1);});
test('serve reminder: once per assigned person per week, roles shown, skipped on no-service',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가수',rank:'팀원',status:'approved'},{id:'a2',name:'건반이',rank:'팀원',status:'approved'},{id:'m1',name:'선임',rank:'선임싱어',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,12,10,0);
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),collection:n=>({doc:k=>ref(path+'/'+n+'/'+k)})});
 const db={collection:n=>({doc:k=>ref(n+'/'+k)}),runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v)),update:(x,v)=>w.push(()=>data.set(x.path,{...data.get(x.path),...v})),delete:x=>w.push(()=>data.delete(x.path))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 await run(people[2],{action:'rsvpTargets',date:'2026-10-18',targets:[{n:'가수',r:['싱어']},{n:'건반이',r:['메인']}]});
 let r=await run({system:true},{action:'serveRemind'});assert.equal(r.reminded,2);assert.equal(pushed.length,2);assert.match(pushed[1].n.body,/건반/);
 assert.ok(data.has('_kzCommunity/inbox_a1/items/serve_2026-10-18'));
 r=await run({system:true},{action:'serveRemind'});assert.equal(r.reminded,0);assert.equal(pushed.length,2);
 data.set('settings/noService',{days:{'2026-10-18':'x'}});r=await run({system:true},{action:'serveRemind'});assert.equal(r.skipped,'no-service');});
test('sub request: notifies target member, validates name/date, rate limited',async()=>{const f=fixture();
 const d=new Date(2000000000000+3*86400000).toISOString().slice(0,10);
 const r=await f.run(f.user,{action:'subRequest',to:f.admin.name,date:d,role:'싱어'});assert.equal(r.ok,true);
 await assert.rejects(f.run(f.user,{action:'subRequest',to:'없는사람',date:d}),{status:404});
 await assert.rejects(f.run(f.user,{action:'subRequest',to:f.admin.name,date:'2020-01-01'}),{status:400});});
test('attend rank: any approved member gets per-person totals sorted by rate, no raw records',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가',rank:'팀원',status:'approved'},{id:'a2',name:'나',rank:'팀원',status:'approved'},{id:'a3',name:'다',rank:'팀원',status:'approved'}];
 const data=new Map();const clock=Date.UTC(2026,9,15,3,0);
 const snap=(path)=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const col=n=>({doc:k=>({path:n+'/'+k,get:async()=>snap(n+'/'+k),collection:c=>col(n+'/'+k+'/'+c)}),where:(f,op,v)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(n+'/')&&k.split('/').length===2&&(data.get(k)[f]||'')>=v).map(k=>({id:k.split('/')[1],data:()=>data.get(k)}))})})});
 const db={collection:col,runTransaction:async fn=>fn({get:async x=>snap(x.path),set:()=>{}})};
 const run=createService({db,accounts:async()=>people,now:()=>clock});
 data.set('attendance/w1',{date:'2026-10-04',list:[{n:'가'},{n:'나'},{n:'다'}],recs:{'가':{s:'출석'},'나':{s:'무단 결석'},'다':{s:'일반 지각'}}});
 data.set('attendance/w2',{date:'2026-10-11',list:[{n:'가'},{n:'나'}],recs:{'가':{s:'출석'},'나':{s:'출석'}}});
 const r=await run(people[1],{action:'attendRank',range:'month'});
 assert.deepEqual(r.items.map(x=>x.name),['가','나','다']);assert.equal(r.items[0].rate,100);assert.equal(r.items[1].rate,50);assert.equal(r.items[2].rate,0);assert.equal(r.items[2].late,1);assert.equal(r.days,2);
 assert.equal(JSON.stringify(r).includes('recs'),false);
 data.set('settings/attendRank',{mode:'rate'});const r2=await run(people[1],{action:'attendRank',range:'month'});assert.equal(r2.mode,'rate');assert.equal(r2.items[0].p,undefined);assert.equal(r2.items[0].rate,100);});
test('event rsvp: answer/get, deadline, staff-only notify, reminder once before deadline',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가',rank:'팀원',status:'approved'},{id:'a2',name:'나',rank:'팀원',status:'approved'},{id:'m1',name:'선임',rank:'선임싱어',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,15,3,0);
 const snap=p=>({id:p.split('/').at(-1),exists:data.has(p),data:()=>data.get(p)});
 const ref=p=>({path:p,id:p.split('/').at(-1),get:async()=>snap(p),collection:c=>col(p+'/'+c)});
 const col=n=>({doc:k=>ref(n+'/'+k),where:(f,op,v)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(n+'/')&&k.split('/').length===n.split('/').length+1&&String(data.get(k)[f]||'')>=v).map(k=>({id:k.split('/').at(-1),data:()=>data.get(k)}))})})});
 const db={collection:col,runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 data.set('events/e1',{title:'수련회',date:'2026-11-03',rsvp:true,rsvpUntil:'2026-10-25'});data.set('events/e2',{title:'회식',date:'2026-11-01'});
 await run(people[0],{action:'evRsvpSet',id:'e1',s:'yes'});await run(people[1],{action:'evRsvpSet',id:'e1',s:'no',note:'출장'});
 let g=await run(people[0],{action:'evRsvpGet',ids:['e1']});assert.equal(g.items.e1['가'].s,'yes');assert.equal(g.items.e1['나'].note,'출장');
 await assert.rejects(run(people[0],{action:'evRsvpSet',id:'e2',s:'yes'}),{status:404});
 await assert.rejects(run(people[0],{action:'evRsvpNotify',id:'e1'}),{status:403});
 const n=await run(people[2],{action:'evRsvpNotify',id:'e1'});assert.equal(n.sent,2);
 clock=Date.UTC(2026,9,23,10,0);/* 마감 2일 전 */pushed.length=0;
 let r=await run({system:true},{action:'eventRemind'});assert.equal(r.reminded,1);assert.deepEqual(pushed[0].r.map(a=>a.id),['m1']);
 r=await run({system:true},{action:'eventRemind'});assert.equal(r.reminded,0);
 clock=Date.UTC(2026,9,26,3,0);/* 마감 지남 */await assert.rejects(run(people[2],{action:'evRsvpSet',id:'e1',s:'yes'}),{status:400});});
test('sub request accept: appears in target list, accept writes override and notifies requester, only target can answer',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'a1',name:'가',rank:'팀원',status:'approved'},{id:'a2',name:'나',rank:'팀원',status:'approved'},{id:'a3',name:'다',rank:'팀원',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,15,3,0);
 const snap=p=>({id:p.split('/').at(-1),exists:data.has(p),data:()=>data.get(p)});
 const ref=p=>({path:p,id:p.split('/').at(-1),get:async()=>snap(p),collection:c=>col(p+'/'+c)});
 const col=n=>({doc:k=>ref(n+'/'+k),where:(f,op,v)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(n+'/')&&k.split('/').length===n.split('/').length+1&&data.get(k)[f]===v).map(k=>({id:k.split('/').at(-1),data:()=>data.get(k)}))})})});
 const db={collection:col,runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v)),delete:x=>w.push(()=>data.delete(x.path))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 await run(people[0],{action:'subRequest',to:'나',date:'2026-10-25',role:'드럼',for:'가',kind:'session'});clock+=6000;
 await run(people[0],{action:'subRequest',to:'다',date:'2026-10-25',role:'드럼',for:'가',kind:'session'});
 let l=await run(people[1],{action:'subReqList'});assert.equal(l.items.length,1);assert.equal(l.items[0].fromName,'가');
 await assert.rejects(run(people[2],{action:'subRespond',id:l.items[0].id,accept:true}),{status:403});
 data.set('overrides/ug1',{date:'2026-10-25',from:'가',to:'',k:'session',urgent:true});data.set('overrides/keep',{date:'2026-10-25',from:'가',to:'',urgent:true});
 const r=await run(people[1],{action:'subRespond',id:l.items[0].id,accept:true});assert.equal(r.status,'accepted');
 const ov=[...data.entries()].find(([k])=>k.startsWith('overrides/sr'));assert.ok(ov);assert.deepEqual([ov[1].date,ov[1].from,ov[1].to,ov[1].k],['2026-10-25','가','나','session']);
 assert.equal(pushed.at(-1).r[0].id,'a1');assert.match(pushed.at(-1).n.title,/수락/);
 await assert.rejects(run(people[1],{action:'subRespond',id:l.items[0].id,accept:true}),{status:409});
 assert.equal((await run(people[1],{action:'subReqList'})).items.length,0);
 const l3=await run(people[2],{action:'subReqList'});await run(people[2],{action:'subRespond',id:l3.items[0].id,accept:false});
 assert.deepEqual([...data.keys()].filter(k=>k.startsWith('overrides/')).length,2);assert.ok(data.has('overrides/keep'));assert.ok(!data.has('overrides/ug1'));});


test('urgent absence after deadline notifies leader of that week, chief and part seniors with reason',async()=>{
 const {createService}=require('../lib/community-service.cjs');
 const people=[{id:'u1',name:'가',rank:'팀원',status:'approved'},{id:'c1',name:'단',rank:'단장',status:'approved'},{id:'l1',name:'인1',rank:'인도자',status:'approved'},{id:'l2',name:'인2',rank:'인도자',status:'approved'},{id:'ss',name:'선싱',rank:'선임싱어',status:'approved'},{id:'se',name:'선세',rank:'선임세션',status:'approved'}];
 const data=new Map(),pushed=[];let clock=Date.UTC(2026,9,15,3,0);
 const snap=p=>({id:p.split('/').at(-1),exists:data.has(p),data:()=>data.get(p)});
 const ref=p=>({path:p,id:p.split('/').at(-1),get:async()=>snap(p),collection:c=>col(p+'/'+c)});
 const col=n=>({doc:k=>ref(n+'/'+k)});
 const db={collection:col,runTransaction:async fn=>{const w=[];const r=await fn({get:async x=>snap(x.path),set:(x,v)=>w.push(()=>data.set(x.path,v))});w.forEach(f=>f());return r;}};
 const run=createService({db,accounts:async()=>people,push:async(r,n)=>{pushed.push({r,n});return{sent:r.length}},now:()=>clock});
 await assert.rejects(run(people[0],{action:'urgentAbs',date:'2026-10-18',kinds:['singer'],reason:'  '}),{status:400});
 await assert.rejects(run(people[0],{action:'urgentAbs',date:'2026-11-01',kinds:['singer'],reason:'야근'}),{status:400});
 const r=await run(people[0],{action:'urgentAbs',date:'2026-10-18',kinds:['singer'],reason:'갑자기 야근',leader:'인2'});
 assert.equal(r.ok,true);const ids=pushed.at(-1).r.map(a=>a.id).sort();assert.deepEqual(ids,['c1','l2','ss']);assert.match(pushed.at(-1).n.body,/가님 · 10월 18일 주일 싱어 · 갑자기 야근/);
 clock+=11000;await run(people[0],{action:'urgentAbs',date:'2026-10-18',kinds:['session','singer'],reason:'몸살'});
 assert.deepEqual(pushed.at(-1).r.map(a=>a.id).sort(),['c1','l1','l2','se','ss']);});

test('feed: post, list without image bodies, like toggle, comments with preview, permissions, delete',async()=>{
 const f=fixture();
 await assert.rejects(f.run(f.user,{action:'feedPost',id:'feedreq_0001',text:'  ',images:[]}),{status:400});
 const p=await f.run(f.user,{action:'feedPost',id:'feedreq_0001',text:'첫 게시물',images:[]});assert.equal(p.item.text,'첫 게시물');assert.equal(p.item.mine,true);
 const again=await f.run(f.user,{action:'feedPost',id:'feedreq_0001',text:'첫 게시물',images:[]});assert.equal(again.item.id,p.item.id);
 f.advance();await f.run(f.outsider,{action:'feedPost',id:'feedreq_0002',text:'두번째',images:[]});
 let l=await f.run(f.outsider,{action:'feedList'});assert.equal(l.items.length,2);assert.equal(l.items[0].text,'두번째');assert.ok(!('images' in l.items[0]));assert.ok(!('likes' in l.items[0]));
 const pid=p.item.id;
 let r=await f.run(f.outsider,{action:'feedLike',id:pid,on:true});assert.deepEqual([r.liked,r.likeCount],[true,1]);assert.deepEqual(r.likers,['다른 팀원']);
 r=await f.run(f.outsider,{action:'feedLike',id:pid,on:true});assert.equal(r.likeCount,1);
 r=await f.run(f.admin,{action:'feedLike',id:pid,on:true});assert.equal(r.likeCount,2);
 r=await f.run(f.outsider,{action:'feedLike',id:pid,on:false});assert.equal(r.likeCount,1);
 const c1=await f.run(f.outsider,{action:'feedComment',id:pid,cid:'cmtreq_0001',text:'좋아요!'});assert.equal(c1.commentCount,1);
 assert.equal(f.pushed.at(-1).recipients[0].id,f.user.id);assert.match(f.pushed.at(-1).note.title,/댓글/);
 f.advance();await f.run(f.admin,{action:'feedComment',id:pid,cid:'cmtreq_0002',text:'멋져요'});f.advance();
 const c3=await f.run(f.user,{action:'feedComment',id:pid,cid:'cmtreq_0003',text:'감사해요'});assert.equal(c3.commentCount,3);assert.deepEqual(c3.recent.map(x=>x.text),['멋져요','감사해요']);
 const all=await f.run(f.user,{action:'feedComments',id:pid});assert.deepEqual(all.items.map(x=>x.text),['좋아요!','멋져요','감사해요']);
 await assert.rejects(f.run(f.outsider,{action:'feedCommentDelete',id:pid,cid:all.items[2].id}),{status:403});
 const d=await f.run(f.user,{action:'feedCommentDelete',id:pid,cid:all.items[0].id});assert.equal(d.commentCount,2);
 await assert.rejects(f.run(f.outsider,{action:'feedEdit',id:pid,text:'남의 글'}),{status:403});
 const e=await f.run(f.user,{action:'feedEdit',id:pid,text:'고친 글'});assert.equal(e.item.text,'고친 글');assert.ok(e.item.editedAt);
 await assert.rejects(f.run(f.outsider,{action:'feedDelete',id:pid}),{status:403});
 await f.run(f.admin,{action:'feedDelete',id:pid});l=await f.run(f.user,{action:'feedList'});assert.equal(l.items.length,1);
 assert.equal([...f.data.keys()].filter(k=>k.includes('/comments/')).length,0);
 await assert.rejects(f.run(f.user,{action:'feedImages',id:pid}),{status:404});
});

test('chat read receipts: opening chat marks read only when there is something new; seen map per member',async()=>{
 const f=fixture();await f.run(f.user,{action:'send',room:'all',id:'request_read0001',text:'hi'});
 let r=await f.run(f.outsider,{action:'chat',room:'all'});assert.ok(r.readers.some(x=>x.id===f.outsider.id));assert.ok(!r.readers.some(x=>x.id==='management'));
 assert.ok(r.seen[f.outsider.id]>=r.items[0].createdAt);assert.ok(r.seen[f.user.id]>0);
 const writes=[...f.data.keys()].filter(k=>k.endsWith('seen_all')).length;assert.equal(writes,1);
 const before=f.data.get([...f.data.keys()].find(k=>k.endsWith('seen_all'))).at[f.outsider.id];f.advance();
 r=await f.run(f.outsider,{action:'chat',room:'all'});assert.equal(r.seen[f.outsider.id],before);
 await f.run(f.admin,{action:'chat',room:'all'});assert.ok(!('management' in f.data.get([...f.data.keys()].find(k=>k.endsWith('seen_all'))).at));
});

test('feed notification preference: owner can turn off like/comment alerts',async()=>{
 const f=fixture();const p=await f.run(f.user,{action:'feedPost',id:'feedreq_pref01',text:'글',images:[]});
 assert.equal((await f.run(f.user,{action:'feedList'})).notify,true);
 await f.run(f.user,{action:'feedPref',enabled:false});assert.equal((await f.run(f.user,{action:'feedList'})).notify,false);
 const n=f.pushed.length;await f.run(f.outsider,{action:'feedComment',id:p.item.id,cid:'cmtreq_pref01',text:'댓글'});assert.equal(f.pushed.length,n);
 await f.run(f.outsider,{action:'feedLike',id:p.item.id,on:true});assert.equal([...f.data.keys()].filter(k=>k.includes('inbox_'+f.user.id)&&k.includes('feed')).length,0);
 await f.run(f.user,{action:'feedPref',enabled:true});f.advance();await f.run(f.outsider,{action:'feedComment',id:p.item.id,cid:'cmtreq_pref02',text:'댓글2'});assert.equal(f.pushed.length,n+1);
});

test('chat read receipts: two readers keep both marks (merged write)',async()=>{
 const f=fixture();await f.run(f.admin,{action:'send',room:'all',id:'request_read0002',text:'공지'});
 await f.run(f.outsider,{action:'chat',room:'all'});await f.run(f.user,{action:'chat',room:'all'});
 const r=await f.run(f.outsider,{action:'chat',room:'all'});assert.ok(r.seen[f.user.id]>0&&r.seen[f.outsider.id]>0);
});

test('feed tags: tagged members get notified on post, new tags on edit, and in comments',async()=>{
 const f=fixture();const tagName=f.outsider.name;
 const p=await f.run(f.user,{action:'feedPost',id:'feedreq_tag001',text:'@'+tagName+' 같이 찍은 사진',images:[]});
 let last=f.pushed.at(-1);assert.equal(last.recipients[0].id,f.outsider.id);assert.match(last.note.title,/태그/);
 const n=f.pushed.length;await f.run(f.user,{action:'feedEdit',id:p.item.id,text:'@'+tagName+' 고침'});assert.equal(f.pushed.length,n);
 await f.run(f.user,{action:'feedEdit',id:p.item.id,text:'@'+tagName+' @관리계정 고침'});assert.equal(f.pushed.length,n);
 await f.run(f.outsider,{action:'feedComment',id:p.item.id,cid:'cmtreq_tag001',text:'@'+f.user.name+' 좋아요'});
 const notes=f.pushed.slice(n).map(x=>[x.recipients[0].id,x.note.title]);assert.equal(notes.filter(x=>x[0]===f.user.id).length,1);
});

test('chat read receipts: sending a message marks the sender as having read up to now',async()=>{
 const f=fixture();await f.run(f.admin,{action:'send',room:'all',id:'request_read0003',text:'질문'});f.advance();
 await f.run(f.outsider,{action:'send',room:'all',id:'request_read0004',text:'답장'});
 const r=await f.run(f.user,{action:'chat',room:'all'});const q=r.items.find(x=>x.text==='질문');assert.ok(r.seen[f.outsider.id]>=q.createdAt);
});

test('꿈마당 extras: thanks card, poll vote, emoji reactions, birthdays',async()=>{
 const f=fixture();
 await assert.rejects(f.run(f.user,{action:'feedPost',id:'feedreq_thx001',kind:'thanks',to:f.user.id,text:'고마워'}),{status:400});
 const t=await f.run(f.user,{action:'feedPost',id:'feedreq_thx002',kind:'thanks',to:f.outsider.id,text:'오늘 베이스 최고'});assert.equal(t.item.kind,'thanks');assert.equal(t.item.to.id,f.outsider.id);
 assert.equal(f.pushed.at(-1).recipients[0].id,f.outsider.id);assert.match(f.pushed.at(-1).note.title,/감사/);
 let l=await f.run(f.outsider,{action:'feedList'});assert.equal(l.thanks[f.outsider.id],1);
 f.advance();await assert.rejects(f.run(f.user,{action:'feedPost',id:'feedreq_pol000',kind:'poll',q:'메뉴?',options:['국밥']}),{status:400});
 const p=await f.run(f.user,{action:'feedPost',id:'feedreq_pol001',kind:'poll',q:'회식 메뉴?',options:['국밥','파스타','치킨']});assert.equal(p.item.poll.options.length,3);
 let v=await f.run(f.outsider,{action:'feedVote',id:p.item.id,o:1});assert.deepEqual([v.poll.total,v.poll.options[1].n,v.poll.my[0]],[1,1,1]);
 v=await f.run(f.outsider,{action:'feedVote',id:p.item.id,o:2});assert.deepEqual([v.poll.total,v.poll.options[1].n,v.poll.options[2].n],[1,0,1]);
 await assert.rejects(f.run(f.admin,{action:'feedVote',id:p.item.id,o:[0,1]}),{status:400});
 let r=await f.run(f.outsider,{action:'feedReact',id:p.item.id,e:'😂'});assert.equal(r.myReact,'😂');assert.equal(r.reacts[0].n,1);
 r=await f.run(f.outsider,{action:'feedReact',id:p.item.id,e:'😂'});assert.equal(r.myReact,'');assert.equal(r.reacts.length,0);
 await assert.rejects(f.run(f.outsider,{action:'feedReact',id:p.item.id,e:'💩'}),{status:400});
 const k=new Date(f.clock()+9*3600000),md=String(k.getUTCMonth()+1).padStart(2,'0')+'-'+String(k.getUTCDate()).padStart(2,'0');
 await f.run(f.outsider,{action:'feedBday',md});l=await f.run(f.user,{action:'feedList'});assert.deepEqual(l.birthdays.map(b=>b.id),[f.outsider.id]);
 assert.equal((await f.run(f.outsider,{action:'feedList'})).myBday,md);await assert.rejects(f.run(f.user,{action:'feedBday',md:'13-40'}),{status:400});
 await f.run(f.user,{action:'feedDelete',id:t.item.id});l=await f.run(f.outsider,{action:'feedList'});assert.equal(l.thanks[f.outsider.id],0);
});
