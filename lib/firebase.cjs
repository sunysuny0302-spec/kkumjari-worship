// Shared by the existing notify API and the new community API.
const admin = require('firebase-admin');
const MANAGER_EMAIL = 'management@kkumjari-worship.firebaseapp.com';
function init() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('서버에 FIREBASE_SERVICE_ACCOUNT 환경변수가 없어요'), {status:500,code:'no-config'});
  let sa;
  try { sa = JSON.parse(raw); } catch { throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT 값이 올바른 JSON이 아니에요'), {status:500,code:'bad-config'}); }
  admin.initializeApp({credential:admin.credential.cert(sa)});
  return admin;
}
/* 같은 함수 인스턴스 안에서 짧게 기억: 채팅처럼 연달아 오는 요청마다 토큰 확인·계정 읽기를 반복하지 않게.
 정지·삭제는 최대 60초 안에 반영됨 */
const AUTH_TTL=60000,ACC_TTL=20000,authCache=new Map();let accCache=null;
async function authenticate(req) {
  init();
  const header=String(req.headers.authorization||'');
  if(!/^Bearer\s+\S+$/i.test(header))throw Object.assign(new Error('로그인이 필요해요.'),{status:401});
  const hit=authCache.get(header);if(hit&&hit.exp>Date.now())return {...hit.actor};
  const actor=await authenticateNow(header);
  if(authCache.size>300)authCache.clear();authCache.set(header,{actor,exp:Date.now()+AUTH_TTL});return {...actor};
}
async function authenticateNow(header) {
  let token;
  try{token=await admin.auth().verifyIdToken(header.replace(/^Bearer\s+/i,''),true);}catch{throw Object.assign(new Error('로그인이 만료됐어요. 다시 로그인해 주세요.'),{status:401});}
  // Same legacy management identity as the user's existing Rules and notify API.
  if(token.email===MANAGER_EMAIL)return {id:'management',uid:token.uid,name:'관리계정',rank:'관리계정',status:'approved'};
  const snap=await admin.firestore().doc('accounts/'+token.uid).get();
  if(!snap.exists||snap.data().status!=='approved')throw Object.assign(new Error('승인된 계정만 이용할 수 있어요.'),{status:403});
  return {...snap.data(),id:token.uid,uid:token.uid};
}
async function accounts() {
  init();
  if(accCache&&accCache.exp>Date.now())return accCache.list.map(a=>({...a}));
  const snap=await admin.firestore().collection('accounts').get();
  const list=snap.docs.map(d=>({...d.data(),id:d.id})).filter(a=>a.status==='approved');
  accCache={list,exp:Date.now()+ACC_TTL};return list.map(a=>({...a}));
}
async function accountUid(a) {
  if(a.id!=='management')return a.id;
  try{return (await admin.auth().getUserByEmail(MANAGER_EMAIL)).uid;}catch(e){if(e.code==='auth/user-not-found')return null;throw e;}
}
module.exports={admin,MANAGER_EMAIL,init,authenticate,accounts,accountUid};
