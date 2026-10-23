'use strict';
const assert = require('assert');
const {createAdminService, authPassword} = require('../lib/admin-service.cjs');

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const docRef = path => ({
    path,
    async get() { const v = store.get(path); return {exists: v !== undefined, id: path.split('/').pop(), data: () => v && JSON.parse(JSON.stringify(v)), ref: docRef(path)}; },
    async set(v, opt) { store.set(path, opt && opt.merge ? {...(store.get(path) || {}), ...v} : {...v}); },
    async delete() { store.delete(path); }
  });
  const col = name => {
    const all = (pred = () => true) => ({async get() { const docs = [...store.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 && pred(v)).map(([k, v]) => ({id: k.split('/')[1], data: () => JSON.parse(JSON.stringify(v)), ref: docRef(k)})); return {docs, empty: !docs.length}; }});
    return {...all(), doc: id => docRef(name + '/' + id), where: (f, op, val) => all(v => v[f] === val)};
  };
  return {store, doc: docRef, collection: col, runTransaction: async fn => fn({get: r => r.get(), set: (r, v) => r.set(v)})};
}
function fakeAuth() {
  const calls = [];
  const users = {u1: {uid: 'u1', disabled: false, metadata: {creationTime: 'Mon, 01 Sep 2026 00:00:00 GMT', lastSignInTime: 'Tue, 06 Oct 2026 00:00:00 GMT', lastRefreshTime: 'Wed, 07 Oct 2026 00:00:00 GMT'}}};
  return {calls, users,
    async updateUser(uid, p) { calls.push(['update', uid, p]); if (!users[uid]) throw Object.assign(new Error('nf'), {code: 'auth/user-not-found'}); Object.assign(users[uid], p); },
    async revokeRefreshTokens(uid) { calls.push(['revoke', uid]); },
    async deleteUser(uid) { calls.push(['delete', uid]); delete users[uid]; },
    async getUsers(ids) { return {users: ids.map(x => users[x.uid]).filter(Boolean)}; }
  };
}
const ADMIN = {id: 'management', rank: '관리계정', name: '관리계정'};
const ME = {id: 'u1', rank: '팀원', name: '김태양'};
const seed = () => ({
  'accounts/management': {id: 'management', name: '관리계정', rank: '관리계정', status: 'approved'},
  'accounts/u1': {id: 'u1', name: '김태양', rank: '인도자', status: 'approved', authEmail: 'uabc123@kkumjari-worship.firebaseapp.com'},
  'accounts/u2': {id: 'u2', name: '이하늘', rank: '팀원', status: 'pending'},
  'passkeys/c1': {accountId: 'u1', uid: 'u1', label: 'iPhone'},
  'passkeys/c2': {accountId: 'u1', uid: 'u1', label: 'iPad'}
});
const tests = [];
const t = (n, f) => tests.push([n, f]);
t('단장 위임: chief offers, target accepts in popup; admin can delegate directly', async () => {
  const db = fakeDb({...seed(), 'accounts/c1': {id: 'c1', name: '단장님', rank: '단장', status: 'approved', parts: ['인도자', '싱어']}, 'accounts/u1': {id: 'u1', name: '김태양', rank: '인도자', status: 'approved'}, 'settings/members': {list: [{name: '단장님', accountId: 'c1', rank: '단장', parts: ['인도자', '싱어']}, {name: '김태양', accountId: 'u1', rank: '인도자', parts: []}]}});
  const s = createAdminService({db, auth: fakeAuth(), now: () => 9});
  const CH = {id: 'c1', rank: '단장', name: '단장님', status: 'approved'}, TY = {id: 'u1', rank: '인도자', name: '김태양', status: 'approved'};
  await assert.rejects(s.run(CH, {action: 'transferChief', to: 'u1'}), {status: 403});
  await assert.rejects(s.run(TY, {action: 'chiefOffer', to: 'u1'}), {status: 403});
  await s.run(CH, {action: 'chiefOffer', to: 'u1'});
  assert.equal(db.store.get('accounts/c1').rank, '단장');
  assert.equal((await s.run(TY, {action: 'chiefOfferGet'})).mine, 'to');
  await assert.rejects(s.run(CH, {action: 'chiefAccept'}), {status: 403});
  const r = await s.run(TY, {action: 'chiefAccept'});
  assert.equal(r.to.rank, '단장');assert.deepEqual(r.to.parts, ['인도자']);assert.equal(r.from.rank, '인도자');assert.deepEqual(r.from.parts, ['싱어']);
  assert.equal(db.store.get('accounts/u1').rank, '단장');assert.equal(db.store.get('settings/members').list.find(m => m.accountId === 'c1').rank, '인도자');
  assert.equal((await s.run(TY, {action: 'chiefOfferGet'})).offer, null);
  /* 거절 */
  await s.run({...TY, rank: '단장'}, {action: 'chiefOffer', to: 'c1'});await s.run(CH, {action: 'chiefDecline'});assert.equal((await s.run(CH, {action: 'chiefOfferGet'})).offer, null);
  /* 관리계정은 바로 */
  const r2 = await s.run(ADMIN, {action: 'transferChief', to: 'c1'});assert.equal(r2.to.rank, '단장');
});
t('단장 can list pending, approve (with 겸직), and delete only pending requests', async () => {
  const db = fakeDb({...seed(), 'accounts/c1': {id: 'c1', name: '단장님', rank: '단장', status: 'approved'}}), s = createAdminService({db, auth: fakeAuth(), now: () => 9});
  const CH = {id: 'c1', rank: '단장', name: '단장님', status: 'approved'};
  const p = await s.run(CH, {action: 'pending'});assert.deepEqual(p.accounts.filter(x => x.status === 'pending').map(x => x.id), ['u2']);
  await assert.rejects(s.run(CH, {action: 'list'}), {status: 403});
  await assert.rejects(s.run(CH, {action: 'remove', id: 'u1'}), {status: 403});
  await assert.rejects(s.run({...CH, rank: '인도자'}, {action: 'approve', id: 'u2'}), {status: 403});
  await assert.rejects(s.run(CH, {action: 'approve', id: 'u2', rank: '단장'}), {status: 409});
  const r2 = await s.run(CH, {action: 'approve', id: 'u2', rank: '팀원', parts: ['인도자', '싱어']});assert.deepEqual(r2.account.parts, ['싱어']);
  const db2 = fakeDb(seed()), s2 = createAdminService({db: db2, auth: fakeAuth(), now: () => 9});
  const r = await s2.run(ADMIN, {action: 'approve', id: 'u2', rank: '단장', parts: ['인도자', '선임싱어']});
  assert.equal(r.account.rank, '단장');assert.deepEqual(r.account.parts.sort(), ['선임싱어', '싱어', '인도자'].sort());
});
t('signup birthday: pending or approved own account only, valid dates, keeps month-day for 꿈마당', async () => {
  const db = fakeDb({...seed(), 'accounts/p1': {name: '새친구', status: 'pending'}, 'accounts/x1': {name: '정지', status: 'suspended'}}), s = createAdminService({db, auth: fakeAuth(), now: () => Date.UTC(2026, 9, 15)});
  assert.deepEqual(await s.birthRun('p1', {birth: '1999-03-07'}), {ok: true});
  assert.deepEqual(db.store.get('_kzCommunity/birthdays').m.p1, {md: '03-07', y: 1999, name: '새친구'});
  for (const b of ['1999-02-30', '2030-01-01', '1900-01-01', '99-3-7', '']) await assert.rejects(s.birthRun('p1', {birth: b}), {status: 400});
  await assert.rejects(s.birthRun('x1', {birth: '1999-03-07'}), {status: 403});
  await assert.rejects(s.birthRun('nobody', {birth: '1999-03-07'}), {status: 403});
  await assert.rejects(s.birthRun('management', {birth: '1999-03-07'}), {status: 400});
});

t('password rule matches the app', () => {
  assert.strictEqual(authPassword('uabc123', '1234'), 'Kz!1234#uabc123');
  assert.strictEqual(authPassword('u-ab.c', '0000'), 'Kz!0000#uabc');
});
t('non-admin is refused', async () => {
  const s = createAdminService({db: fakeDb(seed()), auth: fakeAuth()});
  await assert.rejects(s.run(ME, {action: 'list'}), e => e.status === 403);
  await assert.rejects(s.run({...ME, rank: '관리계정'}, {action: 'list'}), e => e.status === 403);
});
t('list returns accounts with devices and auth metadata', async () => {
  const s = createAdminService({db: fakeDb(seed()), auth: fakeAuth()});
  const r = await s.run(ADMIN, {action: 'list'});
  assert.strictEqual(r.accounts.length, 2);
  const u1 = r.accounts.find(x => x.id === 'u1');
  assert.strictEqual(u1.passkeys.length, 2);
  assert.ok(u1.lastActive > u1.lastSignIn);
  assert.strictEqual(r.accounts.find(x => x.id === 'u2').noAuth, true);
  assert.deepStrictEqual(r.signup, {open: true, code: ''});
});
t('resetPin sets password, revokes and flags', async () => {
  const db = fakeDb(seed()), auth = fakeAuth(), s = createAdminService({db, auth, now: () => 5});
  await s.publicRun({action: 'loginFail', id: 'u1'});
  await s.run(ADMIN, {action: 'resetPin', id: 'u1', pin: '482193'});
  assert.deepStrictEqual(auth.calls[0], ['update', 'u1', {password: 'Kz!482193#uabc123'}]);
  assert.ok(auth.calls.some(c => c[0] === 'revoke'));
  assert.strictEqual(db.store.get('accounts/u1').mustChangePin, true);
  assert.ok(!('u1' in (db.store.get('_kzAdmin/loginFails') || {})));
  await assert.rejects(s.run(ADMIN, {action: 'resetPin', id: 'u1', pin: '12'}), e => e.status === 400);
  await assert.rejects(s.run(ADMIN, {action: 'resetPin', id: 'management', pin: '123456'}), e => e.status === 400);
  await assert.rejects(s.run(ADMIN, {action: 'resetPin', id: 'u1', pin: '4821'}), e => e.status === 400);
});
t('self pinChanged clears the flag', async () => {
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth()});
  await db.doc('accounts/u1').set({mustChangePin: true}, {merge: true});
  await s.run(ME, {action: 'pinChanged'});
  assert.strictEqual(db.store.get('accounts/u1').mustChangePin, false);
});
t('revoke with passkeys removes devices', async () => {
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth(), now: () => 9});
  const r = await s.run(ADMIN, {action: 'revoke', id: 'u1', passkeys: true});
  assert.strictEqual(r.removed, 2);
  assert.strictEqual(db.store.get('accounts/u1').revokedAt, 9);
  assert.ok(!db.store.has('passkeys/c1'));
});
t('suspend and restore', async () => {
  const db = fakeDb(seed()), auth = fakeAuth(), s = createAdminService({db, auth});
  await s.run(ADMIN, {action: 'setStatus', id: 'u1', status: 'suspended'});
  assert.strictEqual(db.store.get('accounts/u1').status, 'suspended');
  assert.strictEqual(auth.users.u1.disabled, true);
  await s.run(ADMIN, {action: 'setStatus', id: 'u1', status: 'approved'});
  assert.strictEqual(db.store.get('accounts/u1').status, 'approved');
  assert.strictEqual(auth.users.u1.disabled, false);
  await assert.rejects(s.run(ADMIN, {action: 'setStatus', id: 'u2', status: 'suspended'}), e => e.status === 400);
});
t('rename refuses duplicates', async () => {
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth()});
  await assert.rejects(s.run(ADMIN, {action: 'rename', id: 'u1', name: ' 이 하늘 '}), e => e.status === 409);
  const r = await s.run(ADMIN, {action: 'rename', id: 'u1', name: '김 태양'});
  assert.strictEqual(r.old, '김태양');
  assert.strictEqual(db.store.get('accounts/u1').name, '김 태양');
});
t('remove deletes doc, auth user and devices', async () => {
  const db = fakeDb(seed()), auth = fakeAuth(), s = createAdminService({db, auth});
  await s.run(ADMIN, {action: 'remove', id: 'u1'});
  assert.ok(!db.store.has('accounts/u1') && !db.store.has('passkeys/c2') && !auth.users.u1);
  await s.run(ADMIN, {action: 'remove', id: 'u2'});
});
t('signup settings and invite check', async () => {
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth()});
  assert.deepStrictEqual(await s.publicRun({action: 'signupInfo'}), {open: true, needCode: false});
  await assert.rejects(s.run(ADMIN, {action: 'signupSet', open: true, code: 'a!'}), e => e.status === 400);
  await s.run(ADMIN, {action: 'signupSet', open: true, code: 'dream26'});
  assert.deepStrictEqual(await s.publicRun({action: 'signupInfo'}), {open: true, needCode: true});
  assert.strictEqual((await s.publicRun({action: 'checkInvite', code: 'nope'})).ok, false);
  assert.strictEqual((await s.publicRun({action: 'checkInvite', code: ' Dream26 '})).ok, true);
  await s.run(ADMIN, {action: 'signupSet', open: false, code: ''});
  assert.strictEqual((await s.publicRun({action: 'checkInvite', code: ''})).ok, false);
});
t('loginFail counts per day and ignores unknown ids', async () => {
  let now = 1000;
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth(), now: () => now});
  await s.publicRun({action: 'loginFail', id: 'u1'});
  await s.publicRun({action: 'loginFail', id: 'u1', locked: true});
  await s.publicRun({action: 'loginFail', id: 'zzz'});
  let f = db.store.get('_kzAdmin/loginFails');
  assert.deepStrictEqual(f.u1, {n: 2, last: 1000, locked: false});
  await s.publicRun({action: 'loginFail', id: 'u1', locked: true});
  f = db.store.get('_kzAdmin/loginFails');
  assert.deepStrictEqual(f.u1, {n: 3, last: 1000, locked: true});
  assert.ok(!f.zzz);
  await s.run(ADMIN, {action: 'unlock', id: 'u1'});
  assert.ok(!db.store.get('_kzAdmin/loginFails').u1);
  now += 2 * 864e5;
});

t('version bump and logs', async () => {
  let n = 100;const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth(), now: () => ++n});
  assert.deepStrictEqual(await s.publicRun({action: 'versionInfo'}), {v: 0, theme: 'auto'});
  await s.run(ADMIN, {action: 'themeSet', season: 'winter'});
  assert.strictEqual((await s.publicRun({action: 'versionInfo'})).theme, 'winter');
  await s.run(ADMIN, {action: 'versionBump'});
  assert.ok((await s.publicRun({action: 'versionInfo'})).v > 0);
  await s.run(ME, {action: 'log', kind: '콘티', text: '10/11 콘티 업로드'});
  await s.run(ADMIN, {action: 'setStatus', id: 'u1', status: 'suspended'});
  const r = await s.run(ADMIN, {action: 'logs'});
  assert.ok(r.items.length >= 3);
  assert.ok(r.items.some(x => x.text.includes('김태양 · 상태 변경 (정지)')));
  await assert.rejects(s.run(ME, {action: 'logs'}), e => e.status === 403);
});

t('approve turns a pending request into an approved account', async () => {
  const db = fakeDb({...seed(), 'accounts/u3': {id: 'u3', name: '박새벽'}, 'accounts/u4': {id: 'u4', name: '김 태양', status: 'pending'}});
  const s = createAdminService({db, auth: fakeAuth(), now: () => 500});
  await assert.rejects(s.run(ME, {action: 'approve', id: 'u2'}), e => e.status === 403);
  await assert.rejects(s.run(ADMIN, {action: 'approve', id: 'u2', rank: '팀원', parts: ['세션']}), e => e.status === 400);
  const r = await s.run(ADMIN, {action: 'approve', id: 'u2', rank: '선임싱어', parts: ['엔지니어', '없는파트'], slots: ['드럼']});
  assert.strictEqual(r.account.status, 'approved');
  const u2 = db.store.get('accounts/u2');
  assert.deepStrictEqual([u2.status, u2.rank, u2.parts.sort(), u2.slots, u2.approvedAt, u2.name], ['approved', '선임싱어', ['싱어', '엔지니어'].sort(), [], 500, '이하늘']);
  await assert.rejects(s.run(ADMIN, {action: 'approve', id: 'u2'}), e => e.status === 409);
  /* status가 없는 옛 문서도 승인 가능 */
  await s.run(ADMIN, {action: 'approve', id: 'u3', rank: '팀원', parts: ['세션'], slots: ['건반']});
  assert.deepStrictEqual(db.store.get('accounts/u3').slots, ['건반']);
  /* 이미 승인된 같은 이름이 있으면 막음 */
  await assert.rejects(s.run(ADMIN, {action: 'approve', id: 'u4'}), e => e.status === 409);
  const logs = await s.run(ADMIN, {action: 'logs'});
  assert.ok(logs.items.some(x => x.text.includes('가입 승인')));
});

t('public requests are throttled per IP', async () => {
  let now = 1000;
  const db = fakeDb(seed()), s = createAdminService({db, auth: fakeAuth(), now: () => now});
  await s.run(ADMIN, {action: 'signupSet', open: true, code: 'DREAM26'});
  for (let i = 0; i < 10; i++) assert.strictEqual((await s.publicRun({action: 'checkInvite', code: 'WRONG' + i}, '1.2.3.4')).ok, false);
  const r = await s.publicRun({action: 'checkInvite', code: 'DREAM26'}, '1.2.3.4');
  assert.strictEqual(r.ok, false); assert.ok(/15분/.test(r.reason));
  assert.strictEqual((await s.publicRun({action: 'checkInvite', code: 'DREAM26'}, '5.6.7.8')).ok, true);
  now += 16 * 60e3;
  assert.strictEqual((await s.publicRun({action: 'checkInvite', code: 'DREAM26'}, '1.2.3.4')).ok, true);
});

t('loginLookup finds only approved accounts by name', async () => {
  const s = createAdminService({db: fakeDb(seed()), auth: fakeAuth()});
  const r = await s.publicRun({action: 'loginLookup', name: ' 김 태양 '}, '9.9.9.9');
  assert.strictEqual(r.found, true); assert.strictEqual(r.account.id, 'u1'); assert.ok(!('rank' in r.account));
  assert.strictEqual((await s.publicRun({action: 'loginLookup', name: '이하늘'}, '9.9.9.9')).found, false);
  assert.strictEqual((await s.publicRun({action: 'loginLookup', name: '관리계정'}, '9.9.9.9')).found, false);
});

t('새로 시작: management only, keeps 일정·콘티·공지·악보·가사·예배 없는 주일, deletes accounts and records', async () => {
  const db = fakeDb({...seed(), 'settings/members': {list: [{name: '김태양'}]}, 'settings/noService': {days: {'2026-10-25': 'x'}}, 'settings/markerPresets': {a: 1},
    'attendance/a1': {name: '김태양'}, 'care/c1': {name: '김태양'}, 'weeks/2026-10-25': {ment: '콘티'}, 'notices/n1': {title: '공지'}, 'events/e1': {title: '일정'}, 'library/l1': {name: '악보'}, 'lyrics/s_x': {title: '가사'},
    'minutes/m1': {title: '회의록'}, '_kzAdmin/loginFails': {u1: {n: 2}}, 'passkeys/pm': {accountId: 'management'}});
  const auth = fakeAuth(), s = createAdminService({db, auth, now: () => 9});
  await assert.rejects(s.run(ME, {action: 'resetInfo'}), {status: 403});
  const info = await s.run(ADMIN, {action: 'resetInfo'});
  assert.equal(info.targets.find(x => x.k === 'accounts').n, 2);
  const dump = await s.run(ADMIN, {action: 'resetDump', k: 'attendance'}); assert.equal(dump.items.length, 1);
  await assert.rejects(s.run(ADMIN, {action: 'resetStep', confirm: '새로'}), {status: 400});
  let r, n = 0; do { r = await s.run(ADMIN, {action: 'resetStep', confirm: '새로 시작'}); n++; } while (!r.done && n < 50);
  assert.ok(r.done);
  for (const k of ['accounts/management', 'weeks/2026-10-25', 'notices/n1', 'events/e1', 'library/l1', 'lyrics/s_x', 'settings/noService', 'settings/markerPresets', 'minutes/m1', 'passkeys/pm']) assert.ok(db.store.has(k), 'kept ' + k);
  for (const k of ['accounts/u1', 'accounts/u2', 'passkeys/c1', 'settings/members', 'attendance/a1', 'care/c1', '_kzAdmin/loginFails']) assert.ok(!db.store.has(k), 'deleted ' + k);
  assert.ok(auth.calls.some(c => c[0] === 'delete' && c[1] === 'u1'));
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) { try { await f(); console.log('ok -', n); } catch (e) { fail++; console.log('FAIL -', n, e); } }
  console.log(`${tests.length - fail}/${tests.length} admin tests passed`);
  if (fail) process.exit(1);
})();
