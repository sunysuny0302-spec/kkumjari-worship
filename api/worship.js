'use strict';
const {admin,init,authenticate}=require('../lib/firebase.cjs');
const DEFAULT_CHANNEL='https://www.youtube.com/@%EC%88%98%EC%83%89%EA%B5%90%ED%9A%8C%EC%B2%AD%EB%85%84%EB%B6%80';
const editors=new Set(['관리계정','단장','인도자']);
const err=(status,message)=>Object.assign(new Error(message),{status});
function videoId(value){if(!value)return'';try{const u=new URL(value);let id='';if(u.hostname==='youtu.be')id=u.pathname.slice(1);else if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname))id=u.searchParams.get('v')||u.pathname.match(/^\/(?:live|embed|shorts)\/([^/]+)/)?.[1]||'';if(/^[\w-]{11}$/.test(id))return id;}catch{}throw err(400,'올바른 유튜브 영상 주소를 입력해 주세요.');}
function channelUrl(value){if(!value)return'';try{const u=new URL(value);if(['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname)&&/^\/(?:@[^/]+|channel\/UC[\w-]{22})(?:\/(?:streams|live|videos))?\/?$/.test(u.pathname))return'https://www.youtube.com'+u.pathname.replace(/\/(streams|live|videos)\/?$/,'').replace(/\/$/,'');}catch{}throw err(400,'유튜브 채널의 @주소 또는 /channel/ 주소를 입력해 주세요.');}
async function yt(resource,params,key){const u=new URL('https://www.googleapis.com/youtube/v3/'+resource);for(const[k,v]of Object.entries({...params,key}))u.searchParams.set(k,v);const r=await fetch(u,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw err(502,'유튜브 자동 연결을 확인해 주세요. 등록된 링크로 시청할 수 있어요.');return r.json();}
function select(videos,keyword){
 const sunday=v=>{const start=v.liveStreamingDetails?.actualStartTime;return !!start&&new Date(Date.parse(start)+9*3600000).getUTCDay()===0};
 /* 제목에 키워드가 없으면(제목 형식이 바뀐 경우) 주일 라이브 중 가장 최근 것 */
 const norm=x=>String(x||'').replace(/\s+/g,'');let matching=videos.filter(v=>sunday(v)&&(!keyword||norm(v.snippet?.title).includes(norm(keyword))));if(!matching.length)matching=videos.filter(sunday);matching=matching.sort((a,b)=>Date.parse(b.liveStreamingDetails.actualStartTime)-Date.parse(a.liveStreamingDetails.actualStartTime));
 const video=matching[0]||null;
 const live=video&&!video.liveStreamingDetails.actualEndTime&&video.snippet?.liveBroadcastContent==='live'?video:null;
 return {video,live,ended:video&&!live?video:null};
}
function retain(candidate,previous){
 if(!candidate)return previous||null;
 if(!previous||candidate.id===previous.id)return candidate;
 return Date.parse(candidate.date)>=Date.parse(previous.date)?candidate:previous;
}
const simple=v=>v?{id:v.id,title:v.snippet?.title||'주일예배',live:!v.liveStreamingDetails?.actualEndTime&&v.snippet?.liveBroadcastContent==='live',date:v.liveStreamingDetails?.actualStartTime||v.snippet?.publishedAt||'',thumbnail:'https://i.ytimg.com/vi/'+v.id+'/hqdefault.jpg'}:null;
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');if(req.method!=='POST')return res.status(405).json({error:'POST 요청만 가능해요.'});
 try{
  init();const actor=await authenticate(req),db=admin.firestore(),ref=db.doc('_kzCommunity/worshipSettings');let input;
  try{input=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{throw err(400,'요청을 확인해 주세요.');}
  if(!input||!['get','save'].includes(input.action))throw err(400,'요청을 확인해 주세요.');
  const editable=editors.has(actor.rank);
  if(input.action==='save'){
   if(!editable)throw err(403,'관리자·단장·인도자만 변경할 수 있어요.');
   const cfg={channel:channelUrl(input.channel),current:videoId(input.current),replay:videoId(input.replay),title:String(input.title||'주일예배').trim().slice(0,120),date:String(input.date||''),keyword:String(input.keyword??'청년부 주일예배').trim().slice(0,40),updatedAt:Date.now()};
   if(cfg.date&&!/^\d{4}-\d{2}-\d{2}$/.test(cfg.date))throw err(400,'예배 날짜를 확인해 주세요.');
   await ref.set(cfg);await db.doc('_kzCommunity/worshipCache').delete().catch(()=>{});
  }
  const snap=await ref.get(),cfg=snap.exists?snap.data():{channel:DEFAULT_CHANNEL,current:'',replay:'',title:'주일예배',date:'',keyword:'청년부 주일예배'};
  let auto=null,warning='';const key=process.env.YOUTUBE_API_KEY;
  if(key&&(cfg.channel||cfg.current||cfg.replay)){
   const cacheRef=db.doc('_kzCommunity/worshipCache'),cache=await cacheRef.get(),old=cache.exists?cache.data():null;
   if(old&&old.schema===2&&old.version===(cfg.updatedAt||0)&&Date.now()-old.at<120000){auto=old.auto;warning=old.warning||'';}
   else try{
    const previousVideo=old?.version===(cfg.updatedAt||0)?old.auto?.video:null;
    const ids=new Set([cfg.current,cfg.replay,previousVideo?.id].filter(Boolean));let cid='';
    if(cfg.channel){const u=new URL(cfg.channel),ch=await yt('channels',{part:'contentDetails',...(u.pathname.startsWith('/@')?{forHandle:decodeURIComponent(u.pathname.slice(1))}:{id:u.pathname.split('/')[2]})},key),c=ch.items?.[0];cid=c?.id||'';const playlist=c?.contentDetails?.relatedPlaylists?.uploads;if(playlist){const items=await yt('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:50},key);for(const x of items.items||[])ids.add(x.contentDetails.videoId);}}
    /* 유튜브는 한 번에 영상 50개까지만 조회 → 50개씩 나눠서 (넘으면 오류가 나서 지난 영상이 계속 걸렸음) */const all=[...ids],result={items:[]};for(let i=0;i<all.length;i+=50){const r=await yt('videos',{part:'snippet,liveStreamingDetails',id:all.slice(i,i+50).join(',')},key);result.items.push(...(r.items||[]));}
    const items=(result.items||[]).filter(v=>!cid||v.snippet?.channelId===cid||[cfg.current,cfg.replay].includes(v.id));
    const chosen=select(items,cfg.keyword),explicit=items.find(v=>v.id===cfg.current);
    // A manually supplied current video is a fallback, not a permanent pin to an old week.
    const startedExplicit=explicit&&explicit.snippet?.liveBroadcastContent!=='upcoming'?simple(explicit):null;
    let video=retain(simple(chosen.video),previousVideo);
    video=retain(startedExplicit,video);
    if(!video){const previous=items.find(v=>v.id===cfg.replay);video=simple(previous);}
    if(video){const refreshed=items.find(v=>v.id===video.id);if(refreshed)video=simple(refreshed);}
    auto={video,live:video?.live?video:null,replay:video&&!video.live?video:null};
    await cacheRef.set({schema:2,at:Date.now(),version:cfg.updatedAt||0,auto});
   }catch(e){warning='영상 정보를 새로 확인하지 못했어요. 마지막으로 확인한 예배를 표시해요.';auto=old?.version===(cfg.updatedAt||0)?old.auto:null;await cacheRef.set({schema:2,at:Date.now(),version:cfg.updatedAt||0,auto,warning}).catch(()=>{});}

  }
  return res.json({config:cfg,editable,auto,automatic:!!key,warning});
 }catch(e){return res.status(e.status||500).json({error:e.status?e.message:'예배 영상 연결을 불러오지 못했어요.'});}
};
module.exports._test={videoId,channelUrl,select,retain};
