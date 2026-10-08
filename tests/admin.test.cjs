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
  return {store, doc: docRef, collection: col};
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
  await s.run(ADMIN, {action: 'resetPin', id: 'u1', pin: '4821'});
  assert.deepStrictEqual(auth.calls[0], ['update', 'u1', {password: 'Kz!4821#uabc123'}]);
  assert.ok(auth.calls.some(c => c[0] === 'revoke'));
  assert.strictEqual(db.store.get('accounts/u1').mustChangePin, true);
  assert.ok(!('u1' in (db.store.get('_kzAdmin/loginFails') || {})));
  await assert.rejects(s.run(ADMIN, {action: 'resetPin', id: 'u1', pin: '12'}), e => e.status === 400);
  await assert.rejects(s.run(ADMIN, {action: 'resetPin', id: 'management', pin: '1234'}), e => e.status === 400);
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
  assert.deepStrictEqual(f.u1, {n: 2, last: 1000, locked: true});
  assert.ok(!f.zzz);
  await s.run(ADMIN, {action: 'unlock', id: 'u1'});
  assert.ok(!db.store.get('_kzAdmin/loginFails').u1);
  now += 2 * 864e5;
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) { try { await f(); console.log('ok -', n); } catch (e) { fail++; console.log('FAIL -', n, e); } }
  console.log(`${tests.length - fail}/${tests.length} admin tests passed`);
  if (fail) process.exit(1);
})();
