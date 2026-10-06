// Called inside the existing notify transaction. No browser-supplied sender identity.
const ADMIN_RANKS=['관리계정','단장','인도자','선임싱어','선임세션'];
function recipientsFor(accounts,{type,toNames=[],toRanks=[],senderId,includeSelf=false}){
 return accounts.filter(a=>a.status==='approved'&&(includeSelf||a.id!==senderId)&&(type!=='sched'||ADMIN_RANKS.includes(a.rank)||toNames.includes(a.name)||toRanks.includes(a.rank)));
}
function stageInbox(tx,db,recipients,{key,type,title,body,createdAt}){
 if(recipients.length>450)throw Object.assign(new Error('알림 대상이 너무 많아요. 관리자에게 문의해 주세요.'),{status:503});
 const target=type==='conti'?'archive':type==='sched'?'mobile_my':'notice';
 for(const a of recipients)tx.set(db.collection('_kzCommunity').doc('inbox_'+a.id).collection('items').doc(key),{title,body,type,target,createdAt});
}
module.exports={recipientsFor,stageInbox};
