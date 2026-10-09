'use strict';
/* 관리계정 전용: 계정 목록 · PIN 재설정 · 잠금 풀기 · 기기·로그인 원격 해제 · 정지 · 가입 관리.
   firebase-admin(auth, firestore)을 주입받아 동작해요. 테스트에서는 가짜 객체를 넣어요. */
const err = (status, message) => Object.assign(new Error(message), {status});
const normName = n => String(n || '').normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
/* 앱(index.html)의 authPassword · authPwId 와 같은 규칙 */
const pwLocal = a => String(a && a.authEmail || '').split('@')[0] || (a && a.id) || '';
const authPassword = (local, pin) => `Kz!${pin}#${String(local).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`;
const PUBLIC = new Set(['signupInfo', 'checkInvite', 'loginFail', 'versionInfo']);
const ADMIN = new Set(['list', 'resetPin', 'unlock', 'revoke', 'removePasskey', 'setStatus', 'rename', 'remove', 'signupSet', 'logs', 'versionBump', 'themeSet']);
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
  async function publicRun(input) {
    const a = input.action;
    if (a === 'signupInfo') { const s = await signup(); return {open: s.open, needCode: !!s.code}; }
    if (a === 'checkInvite') {
      const s = await signup();
      if (!s.open) return {ok: false, reason: '지금은 가입을 받지 않아요.'};
      if (!s.code) return {ok: true};
      return String(input.code || '').trim().toUpperCase() === s.code ? {ok: true} : {ok: false, reason: '초대 코드가 맞지 않아요.'};
    }
    if (a === 'versionInfo') { const [v, th] = await Promise.all([db.doc('_kzAdmin/version').get(), db.doc('_kzAdmin/theme').get()]); return {v: v.exists ? Number((v.data() || {}).v) || 0 : 0, theme: th.exists ? String((th.data() || {}).season || 'auto') : 'auto'}; }
    if (a === 'loginFail') {
      const id = String(input.id || '').slice(0, 128);
      if (!id || id === 'management') return {ok: true};
      const acc = await db.doc('accounts/' + id).get();
      if (!acc.exists) return {ok: true};
      const s = await failsRef().get();
      const d = s.exists ? s.data() || {} : {};
      const prev = d[id] || {n: 0};
      const t = now();
      /* 하루가 지나면 새로 셈 */
      const n = (t - (prev.last || 0) > 864e5 ? 0 : Math.min(999, prev.n || 0)) + 1;
      await failsRef().set({[id]: {n, last: t, locked: !!input.locked || !!prev.locked}}, {merge: true});
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
      if (!actor || actor.id === 'management') return {ok: true};
      await db.doc('accounts/' + actor.id).set({mustChangePin: false, pinChangedAt: now()}, {merge: true});
      await clearFail(actor.id);
      return {ok: true};
    }
    if (!ADMIN.has(a)) throw err(400, '요청 내용을 확인해 주세요.');
    if (!actor || actor.rank !== '관리계정' || actor.id !== 'management') throw err(403, '관리계정만 할 수 있어요.');
    const t = now();

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
      const docs = await passkeysOf(id);
      await Promise.all(docs.map(d => d.ref.delete()));
      await ref.delete();
      try { await auth.deleteUser(id); } catch (e) { if (!String(e && e.code || '').includes('user-not-found')) throw e; }
      await clearFail(id);
      return {ok: true};
    }
    throw err(400, '요청 내용을 확인해 주세요.');
  }
  const LBL = {resetPin: 'PIN 재설정', unlock: '잠금 기록 지움', revoke: '모든 기기 로그아웃', removePasskey: 'Face ID 기기 삭제', setStatus: '상태 변경', rename: '이름 변경', remove: '계정 삭제', signupSet: '가입 설정 변경'};
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
  return {run: runLogged, publicRun};
}
module.exports = {createAdminService, PUBLIC, ADMIN, SELF, authPassword, pwLocal};
