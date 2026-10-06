/* =====================================================================
   꿈자리 찬양팀 — 푸시 알림 발송 (Vercel 서버 함수, 무료)
   · conti/notice/event: 관리자만, 알림 켠 팀원 전체에게
   · sched(싱어·세션·인도자 일정 변경): 승인된 팀원 누구나, 관련된 사람 + 관리자급 전원에게
   · 비밀키는 코드에 넣지 않고 Vercel 환경변수 FIREBASE_SERVICE_ACCOUNT 에서 읽음
   · 로그인한 관리자(관리계정·단장·인도자·선임싱어·선임세션)만 발송 가능
   · 알림을 켠 팀원 기기(Firestore pushTokens)로 발송, 끊긴 기기는 자동 정리
   ===================================================================== */
const admin = require('firebase-admin');

const MANAGER_EMAIL = 'management@kkumjari-worship.firebaseapp.com';
const SENDER_RANKS = ['단장', '인도자', '선임싱어', '선임세션'];
/* 관리자급은 모든 알림(일정 변경 포함)을 항상 받음 */
const ADMIN_RANKS = ['관리계정', '단장', '인도자', '선임싱어', '선임세션'];
const TYPES = ['conti', 'notice', 'event', 'sched'];
const SITE = 'https://kkumjari-worship.vercel.app/';

function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('서버에 FIREBASE_SERVICE_ACCOUNT 환경변수가 없어요'), { status: 500, code: 'no-config' });
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT 값이 올바른 JSON이 아니에요'), { status: 500, code: 'bad-config' }); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+\n/g, '\n').trim().slice(0, n);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ok: true, ready: !!process.env.FIREBASE_SERVICE_ACCOUNT });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 가능해요' });
  try {
    init();
    const idToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return res.status(401).json({ error: '로그인이 필요해요' });
    let user;
    try { user = await admin.auth().verifyIdToken(idToken); } catch (e) { return res.status(401).json({ error: '로그인 정보를 확인하지 못했어요' }); }

    const db = admin.firestore();
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const type = TYPES.includes(b.type) ? b.type : 'notice';
    let senderName = '관리계정';
    if (user.email !== MANAGER_EMAIL) {
      const acc = await db.doc('accounts/' + user.uid).get();
      const a = acc.exists ? acc.data() : null;
      if (!a || a.status !== 'approved') return res.status(403).json({ error: '알림을 보낼 권한이 없어요' });
      if (type !== 'sched' && !SENDER_RANKS.includes(a.rank)) return res.status(403).json({ error: '알림을 보낼 권한이 없어요' });
      senderName = a.name || senderName;
    }
    /* 일정 변경 알림은 관련된 사람(이름)·직책에게만 */
    const toNames = Array.isArray(b.to && b.to.names) ? b.to.names.map(v => String(v).trim()).filter(Boolean).slice(0, 40) : [];
    const toRanks = Array.isArray(b.to && b.to.ranks) ? b.to.ranks.map(v => String(v).trim()).filter(Boolean).slice(0, 10) : [];
    const targeted = type === 'sched';
    if (targeted && !toNames.length && !toRanks.length) return res.status(200).json({ sent: 0, skipped: 'no-target' });
    const title = clip(b.title, 80) || '꿈자리 찬양팀';
    const body = clip(b.body, 180);
    let link = String(b.link || SITE);
    if (!/^https:\/\//.test(link)) link = SITE;

    /* 같은 내용이 짧은 시간에 반복 발송되지 않게 (30초) */
    const metaRef = db.doc('pushMeta/last');
    const meta = await metaRef.get();
    const sig = type + '|' + title + '|' + body;
    if (meta.exists && meta.data().sig === sig && Date.now() - (meta.data().at || 0) < 30000) return res.status(200).json({ sent: 0, skipped: 'duplicate' });
    await metaRef.set({ sig, at: Date.now(), by: senderName });

    const snap = await db.collection('pushTokens').get();
    /* 직책·이름은 계정 정보에서 최신으로 확인 (직책이 바뀌어도 바로 반영) */
    const accNow = {};
    if (targeted) {
      try { (await db.collection('accounts').get()).forEach(a => { accNow[a.id] = a.data() || {}; }); } catch (e) {}
    }
    const targets = [];
    snap.forEach(d => {
      const x = Object.assign({}, d.data() || {});
      const cur = accNow[x.uid];
      if (cur) { if (cur.rank) x.rank = cur.rank; if (cur.name) x.name = cur.name; }
      if (!x.token) return;
      if (x.uid === user.uid && b.includeSelf !== true) return;   // 보낸 사람 본인 기기는 제외
      if (x.types && x.types[type] === false) return;             // 이 종류 알림을 끈 사람 제외
      if (targeted && !ADMIN_RANKS.includes(String(x.rank || '')) && !toNames.includes(String(x.name || '')) && !toRanks.includes(String(x.rank || ''))) return;
      targets.push({ id: d.id, token: x.token });
    });
    if (!targets.length) return res.status(200).json({ sent: 0, failed: 0, devices: 0 });

    let sent = 0, failed = 0;
    const dead = [];
    for (let i = 0; i < targets.length; i += 500) {
      const chunk = targets.slice(i, i + 500);
      const r = await admin.messaging().sendEachForMulticast({
        tokens: chunk.map(t => t.token),
        webpush: {
          notification: { title, body, icon: '/icon-192.png', badge: '/icon-192.png', tag: type + '-' + Date.now() },
          fcmOptions: { link }
        },
        data: { type, title, body, link }
      });
      r.responses.forEach((x, k) => {
        if (x.success) { sent++; return; }
        failed++;
        const c = x.error && x.error.code;
        if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(chunk[k].id);
      });
    }
    await Promise.all(dead.map(id => db.doc('pushTokens/' + id).delete().catch(() => {})));
    return res.status(200).json({ sent, failed, devices: targets.length, cleaned: dead.length });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.message || '알림을 보내지 못했어요', code: e.code || '' });
  }
};
