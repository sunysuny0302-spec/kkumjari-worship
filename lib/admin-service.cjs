'use strict';
/* 관리계정 전용: 계정 목록 · PIN 재설정 · 잠금 풀기 · 기기·로그인 원격 해제 · 정지 · 가입 관리.
   firebase-admin(auth, firestore)을 주입받아 동작해요. 테스트에서는 가짜 객체를 넣어요. */
const err = (status, message) => Object.assign(new Error(message), {status});
const normName = n => String(n || '').normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
/* 앱(index.html)의 authPassword · authPwId 와 같은 규칙 */
const pwLocal = a => String(a && a.authEmail || '').split('@')[0] || (a && a.id) || '';
const authPassword = (local, pin) => `Kz!${pin}#${String(local).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`;
const PUBLIC = new Set(['signupInfo', 'checkInvite', 'loginFail', 'versionInfo', 'loginLookup']);
const ADMIN = new Set(['pending', 'transferChief', 'chiefOffer', 'chiefOfferGet', 'chiefAccept', 'chiefDecline', 'list', 'resetPin', 'unlock', 'revoke', 'removePasskey', 'setStatus', 'rename', 'remove', 'signupSet', 'logs', 'versionBump', 'themeSet', 'approve']);
const SELF = new Set(['pinChanged', 'log']);

function createAdminService({db, auth, now = () => Date.now()}) {
  const signupRef = () => db.doc('_kzAdmin/signup');
  const failsRef = () => db.doc('_kzAdmin/loginFails');
  async function signup() {
    const s = await signupRef().get();
    const d = s.exists ? s.data() || {} : {};
    return {open: d.open !== false, code: typeof d.code === 'string' ? d.code : ''};
  }
  async function account(id) {
    id = String(id || '').slice(0, 128);
    if (!id || id === 'management') throw err(400, '관리계정은 여기서 바꿀 수 없어요.');
    const s = await db.doc('accounts/' + id).get();
    if (!s.exists) throw err(404, '계정을 찾을 수 없어요.');
    return {...s.data(), id};
  }
  async function passkeysOf(id) {
    const s = await db.collection('passkeys').where('accountId', '==', id).get();
    return s.docs;
  }
  async function clearFail(id) {
    const s = await failsRef().get();
    if (!s.exists) return;
    const d = {...(s.data() || {})};
    if (!(id in d)) return;
    delete d[id];
    await failsRef().set(d);
  }
  async function revokeAuth(id) {
    try { await auth.revokeRefreshTokens(id); } catch (e) { if (!String(e && e.code || '').includes('user-not-found')) throw e; }
  }

  async function writeLog(actor, kind, text) {
    const t = now(), id = t.toString(36) + Math.random().toString(36).slice(2, 7);
    try { await db.collection('_kzLog').doc(id).set({at: t, by: (actor && actor.name) || '', byId: (actor && actor.id) || '', kind, text}); } catch (e) {}
  }
  /* 로그인 없이 부르는 요청은 IP별 횟수 제한 (초대 코드 맞히기·잠김 표시 장난 막기) */
  const triesRef = () => db.doc('_kzAdmin/publicTries');
  async function throttle(kind, ip, max, windowMs) {
    if (!ip) return true;
    const key = (kind + '_' + String(ip)).replace(/[^\w.:-]/g, '_').slice(0, 80);
    const s = await triesRef().get();
    const d = s.exists ? s.data() || {} : {};
    const t = now(), prev = d[key] || {n: 0, first: t};
    const fresh = t - (prev.first || 0) > windowMs;
    const next = fresh ? {n: 1, first: t} : {n: (prev.n || 0) + 1, first: prev.first};
    /* 오래된 기록은 정리 */
    const keep = {};
    for (const [k, v] of Object.entries(d)) if (v && t - (v.first || 0) <= 864e5) keep[k] = v;
    keep[key] = next;
    await triesRef().set(keep);
    return next.n <= max;
  }
  async function publicRun(input, ip = '') {
    const a = input.action;
    if (a === 'signupInfo') { const s = await signup(); return {open: s.open, needCode: !!s.code}; }
    if (a === 'checkInvite') {
      const s = await signup();
      if (!s.open) return {ok: false, reason: '지금은 가입을 받지 않아요.'};
      if (!s.code) return {ok: true};
      if (!(await throttle('invite', ip, 10, 15 * 60e3))) return {ok: false, reason: '시도가 너무 많아요. 15분 뒤에 다시 해 주세요.'};
      return String(input.code || '').trim().toUpperCase() === s.code ? {ok: true} : {ok: false, reason: '초대 코드가 맞지 않아요.'};
    }
    if (a === 'loginLookup') {
      /* 로그인 화면에 이름 목록을 보여주지 않으므로, 입력한 이름으로 승인된 계정 하나만 찾아 줌 (로그인에 필요한 값만) */
      const name = normName(String(input.name || '').slice(0, 40));
      if (!name) return {found: false};
      if (!(await throttle('lookup', ip, 30, 10 * 60e3))) throw err(429, '시도가 너무 많아요. 10분 뒤에 다시 해 주세요.');
      const all = await db.collection('accounts').get();
      const hit = all.docs.map(d => ({...(d.data() || {}), id: d.id})).find(x => x.id !== 'management' && x.status === 'approved' && normName(x.name) === name);
      if (!hit) return {found: false};
      return {found: true, account: {id: hit.id, name: hit.name || '', status: 'approved', authEmail: hit.authEmail || ''}};
    }
    if (a === 'versionInfo') { const [v, th] = await Promise.all([db.doc('_kzAdmin/version').get(), db.doc('_kzAdmin/theme').get()]); return {v: v.exists ? Number((v.data() || {}).v) || 0 : 0, theme: th.exists ? String((th.data() || {}).season || 'auto') : 'auto'}; }
    if (a === 'loginFail') {
      const id = String(input.id || '').slice(0, 128);
      if (!id || id === 'management') return {ok: true};
      const acc = await db.doc('accounts/' + id).get();
      if (!acc.exists) return {ok: true};
      if (!(await throttle('fail', ip, 30, 10 * 60e3))) return {ok: true};
      const s = await failsRef().get();
      const d = s.exists ? s.data() || {} : {};
      const prev = d[id] || {n: 0};
      const t = now();
      /* 하루가 지나면 새로 셈 */
      const n = (t - (prev.last || 0) > 864e5 ? 0 : Math.min(999, prev.n || 0)) + 1;
      /* '잠김' 표시는 실제로 여러 번 틀린 기록이 쌓였을 때만 */
      await failsRef().set({[id]: {n, last: t, locked: (!!input.locked && n >= 3) || (!!prev.locked && n > 1)}}, {merge: true});
      return {ok: true};
    }
    throw err(400, '요청 내용을 확인해 주세요.');
  }

  async function run(actor, input) {
    const a = input.action;
    if (a === 'log') {
      const kind = String(input.kind || '기타').slice(0, 20), text = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!text) return {ok: true};
      await writeLog(actor, kind, text);
      return {ok: true};
    }
    if (SELF.has(a)) {
      if (!actor) return {ok: true};
      /* 관리계정은 PIN을 바꾼 시각만 기록 (처음 PIN 그대로인지 안내하는 데 사용) */
      if (actor.id === 'management') { await db.doc('accounts/management').set({pinChangedAt: now()}, {merge: true}); return {ok: true}; }
      await db.doc('accounts/' + actor.id).set({mustChangePin: false, pinChangedAt: now()}, {merge: true});
      await clearFail(actor.id);
      return {ok: true};
    }
    if (!ADMIN.has(a)) throw err(400, '요청 내용을 확인해 주세요.');
    /* 단장도 가입 승인(대기 목록 보기 · 승인 · 대기 요청 삭제)을 할 수 있음 */
    const isMgr = !!actor && actor.rank === '관리계정' && actor.id === 'management';
    const isChief = !!actor && actor.rank === '단장' && actor.status === 'approved' && ['pending', 'approve', 'remove', 'chiefOffer'].includes(a);
    const isAny = !!actor && actor.status === 'approved' && ['chiefOfferGet', 'chiefAccept', 'chiefDecline'].includes(a);
    if (!isMgr && !isChief && !isAny) throw err(403, a === 'approve' || a === 'pending' ? '관리계정이나 단장만 할 수 있어요.' : '관리계정만 할 수 있어요.');
    const t = now();

    /* 단장 위임: 단장이 요청 → 받는 사람이 수락해야 끝남. 관리계정은 바로 위임할 수 있음 */
    const CX = ['인도자', '선임싱어', '선임세션'];
    const offerRef = db.doc('_kzAdmin/chiefOffer');
    const allAcc = async () => (await db.collection('accounts').get()).docs.map(d => ({...(d.data() || {}), id: d.id}));
    const curChief = all => all.find(x => x.status === 'approved' && x.rank === '단장' && x.id !== 'management');
    async function doTransfer(all, target, cur, myRank) {
      const tParts = new Set(Array.isArray(target.parts) ? target.parts : []);
      if (CX.includes(target.rank)) tParts.add(target.rank);
      const tUpd = {rank: '단장', parts: [...tParts]};
      let cUpd = null;
      if (cur) {
        const mr = ['팀원', ...CX].includes(myRank) ? myRank : (CX.find(r => (cur.parts || []).includes(r)) || '팀원');
        const cp = new Set((Array.isArray(cur.parts) ? cur.parts : []).filter(v => !CX.includes(v)));
        if (mr === '선임싱어') cp.add('싱어');
        if (mr === '선임세션') cp.add('세션');
        cUpd = {rank: mr, parts: [...cp]};
        await db.doc('accounts/' + cur.id).set(cUpd, {merge: true});
      }
      await db.doc('accounts/' + target.id).set(tUpd, {merge: true});
      try {
        const ms = await db.doc('settings/members').get();
        const list = ms.exists && Array.isArray((ms.data() || {}).list) ? ms.data().list : null;
        if (list) {
          const hit = (m, a) => m && (m.accountId === a.id || (!m.accountId && m.name === a.name));
          const next = list.map(m => hit(m, target) ? {...m, ...tUpd, roles: ['단장', ...tUpd.parts]} : cur && hit(m, cur) ? {...m, ...cUpd, roles: [...(cUpd.rank === '인도자' ? ['인도자'] : []), ...cUpd.parts]} : m);
          await db.doc('settings/members').set({list: next});
        }
      } catch (e) {}
      return {ok: true, to: {id: target.id, name: target.name, ...tUpd}, from: cur ? {id: cur.id, name: cur.name, ...cUpd} : null};
    }
    const findTarget = (all, input) => all.find(x => x.id === String(input.to || '')) || (input.toName ? all.find(x => normName(x.name) === normName(input.toName)) : null);
    if (a === 'transferChief') {
      if (!isMgr) throw err(403, '단장 위임은 요청을 보내고 상대가 수락해야 해요.');
      const all = await allAcc(), target = findTarget(all, input);
      if (!target || target.id === 'management' || target.status !== 'approved') throw err(400, '위임받을 멤버를 확인해 주세요.');
      if (target.rank === '단장') throw err(409, '이미 단장이에요.');
      await offerRef.delete().catch(() => {});
      return doTransfer(all, target, curChief(all), input.myRank);
    }
    if (a === 'chiefOffer') {
      const all = await allAcc(), cur = curChief(all);
      if (!cur || cur.id !== actor.id) throw err(403, '지금 단장만 위임할 수 있어요.');
      const target = findTarget(all, input);
      if (!target || target.id === 'management' || target.status !== 'approved' || target.id === actor.id) throw err(400, '위임받을 멤버를 확인해 주세요.');
      const myRank = ['팀원', ...CX].includes(input.myRank) ? input.myRank : (CX.find(r => (cur.parts || []).includes(r)) || '팀원');
      const offer = {from: cur.id, fromName: cur.name || '', to: target.id, toName: target.name || '', myRank, at: t};
      await offerRef.set(offer);
      try { await db.doc('_kzCommunity/inbox_' + target.id + '/items/chiefoffer_' + t).set({title: (cur.name || '단장') + '님이 단장을 위임하려고 해요 👑', body: '앱을 열면 나오는 창에서 수락하거나 거절할 수 있어요', target: 'home', type: 'sched', createdAt: t}); } catch (e) {}
      return {ok: true, offer};
    }
    if (a === 'chiefOfferGet') {
      const s0 = await offerRef.get(), o = s0.exists ? s0.data() || {} : null;
      if (!o || t - (o.at || 0) > 7 * 864e5) return {offer: null};
      if (o.to === actor.id || o.from === actor.id || isMgr) return {offer: o, mine: o.to === actor.id ? 'to' : o.from === actor.id ? 'from' : ''};
      return {offer: null};
    }
    if (a === 'chiefAccept' || a === 'chiefDecline') {
      const s0 = await offerRef.get(), o = s0.exists ? s0.data() || {} : null;
      if (!o || t - (o.at || 0) > 7 * 864e5) throw err(404, '위임 요청이 없거나 기간(7일)이 지났어요.');
      if (a === 'chiefDecline') {
        if (o.to !== actor.id && o.from !== actor.id && !isMgr) throw err(403, '요청을 받은 사람이나 보낸 사람만 할 수 있어요.');
        await offerRef.delete();
        if (o.to === actor.id) { try { await db.doc('_kzCommunity/inbox_' + o.from + '/items/chiefno_' + t).set({title: (o.toName || '') + '님이 단장 위임을 거절했어요', body: '다른 분에게 다시 요청할 수 있어요', target: 'home', type: 'sched', createdAt: t}); } catch (e) {} }
        return {ok: true};
      }
      if (o.to !== actor.id) throw err(403, '위임받는 사람만 수락할 수 있어요.');
      const all = await allAcc(), cur = curChief(all), target = all.find(x => x.id === o.to);
      if (!cur || cur.id !== o.from) { await offerRef.delete(); throw err(409, '그사이 단장이 바뀌어서 이 요청은 끝났어요.'); }
      if (!target || target.status !== 'approved') throw err(400, '계정을 확인해 주세요.');
      const r = await doTransfer(all, target, cur, o.myRank);
      await offerRef.delete();
      try { await db.doc('_kzCommunity/inbox_' + o.from + '/items/chiefok_' + t).set({title: (o.toName || '') + '님이 단장 위임을 수락했어요 👑', body: '이제 ' + (o.toName || '') + '님이 단장이에요', target: 'home', type: 'sched', createdAt: t}); } catch (e) {}
      return r;
    }

    if (a === 'pending') {
      const accSnap = await db.collection('accounts').get();
      const list = accSnap.docs.filter(d => d.id !== 'management').map(d => { const x = d.data() || {}; return {id: d.id, name: x.name || '', status: x.status || 'pending', requestedAt: x.requestedAt || 0}; }).filter(x => x.status === 'pending');
      const approved = accSnap.docs.filter(d => (d.data() || {}).status === 'approved').map(d => ({id: d.id, name: (d.data() || {}).name || '', rank: (d.data() || {}).rank || '팀원', status: 'approved'}));
      return {accounts: [...list, ...approved], now: t};
    }

    if (a === 'list') {
      const [accSnap, pkSnap, failSnap, su] = await Promise.all([db.collection('accounts').get(), db.collection('passkeys').get(), failsRef().get(), signup()]);
      const fails = failSnap.exists ? failSnap.data() || {} : {};
      const pks = new Map();
      pkSnap.docs.forEach(d => { const x = d.data() || {}; if (!x.accountId) return; if (!pks.has(x.accountId)) pks.set(x.accountId, []); pks.get(x.accountId).push({credId: d.id, label: String(x.label || '').slice(0, 40), createdAt: x.createdAt || 0, lastUsedAt: x.lastUsedAt || 0}); });
      const list = accSnap.docs.filter(d => d.id !== 'management').map(d => { const x = d.data() || {}; return {id: d.id, name: x.name || '', rank: x.rank || '팀원', parts: Array.isArray(x.parts) ? x.parts : [], status: x.status || 'pending', requestedAt: x.requestedAt || 0, approvedAt: x.approvedAt || 0, mustChangePin: !!x.mustChangePin, revokedAt: x.revokedAt || 0, suspendedAt: x.suspendedAt || 0, passkeys: pks.get(d.id) || [], fails: fails[d.id] || null}; });
      const users = new Map();
      for (let i = 0; i < list.length; i += 100) {
        try {
          const r = await auth.getUsers(list.slice(i, i + 100).map(x => ({uid: x.id})));
          (r.users || []).forEach(u => users.set(u.uid, u));
        } catch (e) { console.warn('[admin] getUsers', e && e.code); }
      }
      list.forEach(x => {
        const u = users.get(x.id), m = u && u.metadata || {};
        const ms = v => { const n = v ? Date.parse(v) : 0; return Number.isFinite(n) ? n : 0; };
        x.createdAt = ms(m.creationTime);
        x.lastSignIn = ms(m.lastSignInTime);
        x.lastActive = Math.max(ms(m.lastRefreshTime), x.lastSignIn);
        x.disabled = !!(u && u.disabled);
        x.noAuth = !u;
      });
      return {accounts: list, signup: su, now: t};
    }

    if (a === 'logs') {
      const col = db.collection('_kzLog');
      const snap = await (col.orderBy ? col.orderBy('at', 'desc').limit(3) : col).get();
      const items = snap.docs.map(d => ({id: d.id, ...(d.data() || {})})).sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 3);
      return {items};
    }
    if (a === 'themeSet') {
      const season = ['auto', 'spring', 'summer', 'autumn', 'winter'].includes(input.season) ? input.season : 'auto';
      await db.doc('_kzAdmin/theme').set({season, at: t});
      await writeLog(actor, '사이트', '계절 테마 · ' + ({auto: '자동', spring: '봄', summer: '여름', autumn: '가을', winter: '겨울'})[season]);
      return {ok: true, season};
    }
    if (a === 'versionBump') {
      await db.doc('_kzAdmin/version').set({v: t, by: actor.name || '관리계정'});
      await writeLog(actor, '사이트', '모든 기기에 새 버전 적용');
      return {ok: true, v: t};
    }
    if (a === 'signupSet') {
      const open = input.open !== false;
      let code = String(input.code || '').trim().toUpperCase();
      if (code && !/^[A-Z0-9]{4,12}$/.test(code)) throw err(400, '초대 코드는 영문·숫자 4~12자로 만들어 주세요.');
      await signupRef().set({open, code, updatedAt: t});
      return {ok: true, signup: {open, code}};
    }

    if (a === 'removePasskey') {
      const credId = String(input.credId || '').slice(0, 1500);
      const ref = db.collection('passkeys').doc(credId || '_');
      const s = await ref.get();
      if (!s.exists) return {ok: true, removed: 0};
      if ((s.data() || {}).accountId === 'management') throw err(400, '관리계정 기기는 여기서 지울 수 없어요.');
      await ref.delete();
      return {ok: true, removed: 1};
    }

    const acc = await account(input.id);
    const id = acc.id, ref = db.doc('accounts/' + id);

    if (a === 'approve') {
      /* 가입 승인: 상태가 비어 있는 옛 문서도 '승인 대기'로 보고 승인할 수 있게 */
      if (acc.status && acc.status !== 'pending') throw err(409, '이미 처리된 가입 요청이에요. 목록을 새로고침해 주세요.');
      const RK = ['팀원', '선임싱어', '선임세션', '인도자', '단장'], PT = ['싱어', '세션', '엔지니어', '인도자', '선임싱어', '선임세션'], SL = ['건반', '드럼', 'E.G', 'B.G', 'A.G'];
      const rank = RK.includes(input.rank) ? input.rank : '팀원';
      const parts = new Set((Array.isArray(input.parts) ? input.parts : []).filter(v => PT.includes(v)));
      if (rank === '선임싱어') parts.add('싱어');
      if (rank === '선임세션') parts.add('세션');
      /* 단장은 인도자 · 선임싱어 · 선임세션을 함께 맡을 수 있음 (겸직) */
      if (rank !== '단장') ['인도자', '선임싱어', '선임세션'].forEach(v => parts.delete(v));
      if (parts.has('선임싱어')) parts.add('싱어');
      if (parts.has('선임세션')) parts.add('세션');
      const slots = parts.has('세션') ? [...new Set((Array.isArray(input.slots) ? input.slots : []).filter(v => SL.includes(v)))] : [];
      if (parts.has('세션') && !slots.length) throw err(400, '세션 파트라면 악기를 하나 이상 선택해 주세요.');
      const all = await db.collection('accounts').get();
      if (all.docs.some(d => d.id !== id && (d.data() || {}).status === 'approved' && normName((d.data() || {}).name) === normName(acc.name))) throw err(409, '같은 이름으로 승인된 계정이 이미 있어요. 이름을 바꾸거나 요청을 삭제해 주세요.');
      /* 단장은 한 명만 */
      const chief = rank === '단장' && all.docs.find(d => d.id !== id && (d.data() || {}).status === 'approved' && (d.data() || {}).rank === '단장');
      if (chief) throw err(409, `단장은 한 명만 둘 수 있어요. 지금 단장은 ${(chief.data() || {}).name || '다른 분'}님이에요.`);
      const upd = {status: 'approved', rank, parts: [...parts], slots, approvedAt: t, suspendedAt: 0, requestedAt: acc.requestedAt || t};
      await ref.set(upd, {merge: true});
      try { await auth.updateUser(id, {disabled: false}); } catch (e) {}
      await clearFail(id);
      return {ok: true, account: {...acc, ...upd, id}};
    }
    if (a === 'resetPin') {
      const pin = String(input.pin || '');
      if (!/^\d{4}$/.test(pin)) throw err(400, '임시 PIN은 숫자 4자리로 정해 주세요.');
      try { await auth.updateUser(id, {password: authPassword(pwLocal(acc), pin)}); }
      catch (e) { if (String(e && e.code || '').includes('user-not-found')) throw err(404, '로그인 정보를 찾을 수 없어요. 계정을 지우고 다시 가입하게 해 주세요.'); throw e; }
      await revokeAuth(id);
      await ref.set({mustChangePin: true, revokedAt: t}, {merge: true});
      await clearFail(id);
      return {ok: true};
    }
    if (a === 'unlock') { await clearFail(id); return {ok: true}; }
    if (a === 'revoke') {
      await revokeAuth(id);
      let removed = 0;
      if (input.passkeys) { const docs = await passkeysOf(id); await Promise.all(docs.map(d => d.ref.delete())); removed = docs.length; }
      await ref.set({revokedAt: t}, {merge: true});
      return {ok: true, removed};
    }
    if (a === 'setStatus') {
      const st = input.status;
      if (st === 'suspended') {
        if (acc.status !== 'approved') throw err(400, '승인된 계정만 정지할 수 있어요.');
        try { await auth.updateUser(id, {disabled: true}); } catch (e) { if (!String(e && e.code || '').includes('user-not-found')) throw e; }
        await revokeAuth(id);
        await ref.set({status: 'suspended', suspendedAt: t, revokedAt: t}, {merge: true});
        return {ok: true};
      }
      if (st === 'approved') {
        if (acc.status !== 'suspended') throw err(400, '정지된 계정만 다시 풀 수 있어요.');
        try { await auth.updateUser(id, {disabled: false}); } catch (e) { if (!String(e && e.code || '').includes('user-not-found')) throw e; }
        await ref.set({status: 'approved', suspendedAt: 0}, {merge: true});
        return {ok: true};
      }
      throw err(400, '요청 내용을 확인해 주세요.');
    }
    if (a === 'rename') {
      const name = String(input.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 20) throw err(400, '이름은 1~20자로 입력해 주세요.');
      const all = await db.collection('accounts').get();
      if (all.docs.some(d => d.id !== id && normName((d.data() || {}).name) === normName(name))) throw err(409, '같은 이름의 계정이 이미 있어요.');
      await ref.set({name}, {merge: true});
      try { await auth.updateUser(id, {displayName: name}); } catch (e) {}
      return {ok: true, name, old: acc.name || ''};
    }
    if (a === 'remove') {
      if (!isMgr && acc.status && acc.status !== 'pending') throw err(403, '단장은 승인 대기 중인 요청만 지울 수 있어요.');
      const docs = await passkeysOf(id);
      await Promise.all(docs.map(d => d.ref.delete()));
      await ref.delete();
      try { await auth.deleteUser(id); } catch (e) { if (!String(e && e.code || '').includes('user-not-found')) throw e; }
      await clearFail(id);
      return {ok: true};
    }
    throw err(400, '요청 내용을 확인해 주세요.');
  }
  const LBL = {approve: '가입 승인', resetPin: 'PIN 재설정', unlock: '잠금 기록 지움', revoke: '모든 기기 로그아웃', removePasskey: 'Face ID 기기 삭제', setStatus: '상태 변경', rename: '이름 변경', remove: '계정 삭제', signupSet: '가입 설정 변경'};
  async function runLogged(actor, input) {
    const out = await run(actor, input);
    if (LBL[input.action]) {
      let who = '';
      try { if (input.id) { const s = await db.doc('accounts/' + String(input.id).slice(0, 128)).get(); who = s.exists ? (s.data() || {}).name || '' : (out && out.old) || ''; } } catch (e) {}
      const extra = input.action === 'setStatus' ? (input.status === 'suspended' ? ' (정지)' : ' (정지 풀기)') : input.action === 'rename' ? ` → ${out && out.name}` : input.action === 'signupSet' ? (input.open === false ? ' (닫음)' : input.code ? ' (초대 코드)' : ' (열림)') : '';
      await writeLog(actor, '계정', (who ? who + ' · ' : '') + LBL[input.action] + extra);
    }
    return out;
  }
  /* 가입할 때 받은 생년월일: 승인 전이라도 본인 문서가 있으면 저장 (서버만 읽는 곳, 꿈마당 생일 축하에 월·일만 씀) */
  async function birthRun(uid, input) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input.birth || ''));
    const y = m ? +m[1] : 0, mo = m ? +m[2] : 0, d = m ? +m[3] : 0, nowY = new Date(now()).getUTCFullYear();
    const dt = m ? new Date(Date.UTC(y, mo - 1, d)) : null;
    if (!m || y < 1930 || y > nowY || !dt || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw err(400, '생년월일을 확인해 주세요.');
    if (!uid || uid === 'management') throw err(400, '요청 내용을 확인해 주세요.');
    const acc = await db.doc('accounts/' + uid).get();
    if (!acc.exists || !['pending', 'approved'].includes((acc.data() || {}).status)) throw err(403, '가입한 계정만 등록할 수 있어요.');
    const ref = db.doc('_kzCommunity/birthdays'), md = m[2] + '-' + m[3];
    await db.runTransaction(async tx => { const x = await tx.get(ref); const all = {...(x.exists && x.data() && typeof x.data().m === 'object' ? x.data().m : {})}; all[uid] = {...(all[uid] || {}), md, y, name: String((acc.data() || {}).name || '')}; tx.set(ref, {m: all}); });
    return {ok: true};
  }
  return {run: runLogged, publicRun, birthRun};
}
module.exports = {createAdminService, PUBLIC, ADMIN, SELF, authPassword, pwLocal};
