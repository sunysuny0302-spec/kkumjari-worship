'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createService,RETENTION}=require('../lib/community-service.cjs');
const {validateImages,summary}=require('../lib/chat-images.cjs');
function fixture(){
 const pushed=[];
 const data=new Map();let clock=2000000000000,queue=Promise.resolve();
 const snap=path=>({id:path.split('/').at(-1),exists:data.has(path),data:()=>data.get(path)});
 const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path),collection:n=>col(path+'/'+n)});
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
