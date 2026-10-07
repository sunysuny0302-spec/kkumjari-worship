/* Group incoming web pushes by chat room or notification type. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
let notificationQueue=Promise.resolve();
function groupKey(d,n){
 const title=d.title||n.title||'',type=d.type||'';
 if(type==='chat'||d.target==='community'||/채팅|관리자방/.test(title)){
  let room=d.room;try{room=room||new URL(d.link||'/',self.location.origin).searchParams.get('kz_room');}catch{}
  return room==='admin'||/관리자방/.test(title)?'chat-admin':'chat-all';
 }
 if(type)return type;
 if(/공지/.test(title))return'notice';if(/일정/.test(title))return'event';if(/신청곡/.test(title))return'song';if(/콘티/.test(title))return'conti';return'other';
}
self.addEventListener('push',event=>{
 let p;try{p=event.data.json();}catch{return;}
 const task=notificationQueue.catch(()=>{}).then(async()=>{
 const d=p.data||{},n=p.notification||{},key=groupKey(d,n),tag='kz-group-'+key;
 const title=d.title||n.title||'새 알림',body=d.body||n.body||'';
 const existing=await self.registration.getNotifications({tag}),old=existing[0]?.data||{};
 const messageId=p.fcmMessageId||p.messageId||'';if(messageId&&(old.ids||[]).includes(messageId))return;
 const lines=[...(old.lines||[]),body?title+' · '+body:title].slice(-5),count=(old.count||0)+1;
 const names={'chat-all':'전체 채팅','chat-admin':'관리자방',notice:'공지',event:'일정',song:'신청곡',conti:'콘티',sched:'일정 변경',other:'새 알림'};
 let link=d.link||p.fcmOptions?.link||n.click_action||'/?kz_open=inbox';
 try{const u=new URL(link,self.location.origin);link=u.origin===self.location.origin?u.href:self.location.origin+'/?kz_open=inbox';}catch{link='/?kz_open=inbox';}
 await self.registration.showNotification((names[key]||'새 알림')+' · '+count+'개',{
 body:(count>lines.length?'최근 '+lines.length+'개\n':'')+lines.join('\n'),icon:'/icon-192.png',badge:'/icon-192.png',tag,renotify:true,
 data:{link,lines,count,ids:[...(old.ids||[]),messageId].filter(Boolean).slice(-20)}
 });
 });notificationQueue=task;event.waitUntil(task);
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const link=event.notification.data?.link||'/?kz_open=inbox';
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async list=>{
 for(const client of list){if(new URL(client.url).origin!==self.location.origin)continue;await client.navigate(link);return client.focus();}return self.clients.openWindow(link);
 }));
});
