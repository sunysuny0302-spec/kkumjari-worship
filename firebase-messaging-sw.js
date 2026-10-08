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
 const chat=key.startsWith('chat-');
 let sender=d.sender||'',message=body;
 if(chat&&!sender){const legacy=body.match(/^(.+?) · ([\s\S]*)$/);if(/새 메시지|전체 채팅|관리자방/.test(title)&&legacy){sender=legacy[1];message=legacy[2];}else sender=title;}
 const clean=x=>String(x||'').replace(/^[📢📅🎵🔁🎤🎸]\s*/u,'').trim();
 const entry=chat?{sender:clean(sender)||'팀원',body:message}: {sender:clean(title),body};
 const entries=[...(old.entries||[]),entry].slice(-3),count=(old.count||0)+1;
 const displayTitle=chat?entry.sender+(key==='chat-admin'?' · 관리자방':''):entry.sender;
 // Keep the latest message first; older messages remain compact within the same room.
 // 알림은 짧게: 공지·일정·콘티 등은 제목만, 채팅은 최신 한 줄만 (여러 개면 개수 표시)
 const one=t=>{t=String(t||'').replace(/\s+/g,' ').trim();return t.length>60?t.slice(0,58)+'…':t};
 const displayBody=chat?(count>1?'('+count+'개) ':'')+one(message):'';
 let link=d.link||p.fcmOptions?.link||n.click_action||'/?kz_open=inbox';
 try{const u=new URL(link,self.location.origin);link=u.origin===self.location.origin?u.href:self.location.origin+'/?kz_open=inbox';}catch{link='/?kz_open=inbox';}
 for(const notification of existing)notification.close();
 await self.registration.showNotification(displayTitle,{
 body:displayBody,icon:'/icon-192.png',badge:'/icon-192.png',tag,renotify:true,
 data:{link,entries,count,ids:[...(old.ids||[]),messageId].filter(Boolean).slice(-20)}
 });
 });notificationQueue=task;event.waitUntil(task);
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const link=event.notification.data?.link||'/?kz_open=inbox';
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async list=>{
 for(const client of list){if(new URL(client.url).origin!==self.location.origin)continue;await client.navigate(link);return client.focus();}return self.clients.openWindow(link);
 }));
});
