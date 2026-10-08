'use strict';
/* Face ID · 지문 로그인(패스키 / WebAuthn) — 외부 패키지 없이 Node crypto로 검증.
   passkeys/{credId}          : 기기별 공개키. 서버만 쓰고, 값 위조를 막기 위해 서버 서명(mac)을 함께 저장.
   passkeyChallenges/{hash}   : 한 번 쓴 인증 요청을 다시 쓰지 못하게 기록(재사용 차단). */
const crypto = require('node:crypto');

const err = (status, message, code) => Object.assign(new Error(message), {status, code});
const b64u = {
  enc: buf => Buffer.from(buf).toString('base64url'),
  dec: s => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 20000) throw err(400, '인증 정보 형식이 올바르지 않아요.');
    return Buffer.from(s, 'base64url');
  }
};
const sha256 = b => crypto.createHash('sha256').update(b).digest();

/* ---------- 최소 CBOR 디코더 (attestationObject / COSE 키용) ---------- */
function cborDecode(buf, pos = 0) {
  if (pos >= buf.length) throw err(400, '인증 정보를 읽지 못했어요.');
  const ib = buf[pos++], major = ib >> 5, info = ib & 31;
  let len;
  const readLen = () => {
    if (info < 24) return info;
    if (info === 24) return buf[pos++];
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw err(400, '지원하지 않는 인증 정보 형식이에요.');
  };
  switch (major) {
    case 0: return [readLen(), pos];
    case 1: return [-1 - readLen(), pos];
    case 2: len = readLen(); if (pos + len > buf.length) throw err(400, '인증 정보가 잘렸어요.'); return [buf.subarray(pos, pos + len), pos + len];
    case 3: len = readLen(); if (pos + len > buf.length) throw err(400, '인증 정보가 잘렸어요.'); return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
    case 4: { len = readLen(); const a = []; for (let i = 0; i < len; i++) { let v; [v, pos] = cborDecode(buf, pos); a.push(v); } return [a, pos]; }
    case 5: { len = readLen(); const m = new Map(); for (let i = 0; i < len; i++) { let k, v; [k, pos] = cborDecode(buf, pos); [v, pos] = cborDecode(buf, pos); m.set(k, v); } return [m, pos]; }
    case 7: if (info === 20) return [false, pos]; if (info === 21) return [true, pos]; if (info === 22) return [null, pos]; throw err(400, '지원하지 않는 인증 정보 형식이에요.');
    default: throw err(400, '지원하지 않는 인증 정보 형식이에요.');
  }
}

function parseAuthData(ad) {
  if (ad.length < 37) throw err(400, '인증 정보가 너무 짧아요.');
  const out = {rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33)};
  if (out.flags & 0x40) {
    let p = 37 + 16;
    const idLen = ad.readUInt16BE(p); p += 2;
    out.credId = ad.subarray(p, p + idLen); p += idLen;
    const [cose] = cborDecode(ad, p);
    out.cose = cose;
  }
  return out;
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw err(400, '공개키 형식이 올바르지 않아요.');
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return {alg: -7, jwk: {kty: 'EC', crv: 'P-256', x: b64u.enc(cose.get(-2)), y: b64u.enc(cose.get(-3))}};
  if (kty === 3 && alg === -257) return {alg: -257, jwk: {kty: 'RSA', n: b64u.enc(cose.get(-1)), e: b64u.enc(cose.get(-2))}};
  throw err(400, '이 기기의 인증 방식은 지원하지 않아요.');
}

function verifySignature(alg, jwk, data, sig) {
  const key = crypto.createPublicKey({key: jwk, format: 'jwk'});
  if (alg === -7) return crypto.verify('sha256', data, {key, dsaEncoding: 'der'}, sig);
  if (alg === -257) return crypto.verify('sha256', data, {key, padding: crypto.constants.RSA_PKCS1_PADDING}, sig);
  return false;
}

/* deps: {db, auth, secret, now?}  db = firebase-admin Firestore, auth = firebase-admin Auth */
function createPasskeyService({db, auth, secret, now = () => Date.now()}) {
  if (!secret) throw err(500, '패스키 서명 키를 만들 수 없어요.');
  const key = sha256(Buffer.from('kz-passkey-v1|' + secret));
  const hmac = s => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const TTL = 5 * 60 * 1000;

  function ticket(purpose, subject) {
    const challenge = b64u.enc(crypto.randomBytes(32));
    const body = b64u.enc(Buffer.from(JSON.stringify({c: challenge, p: purpose, s: subject, e: now() + TTL})));
    return {challenge, ticket: body + '.' + hmac(body)};
  }
  function readTicket(t, purpose) {
    if (typeof t !== 'string' || t.length > 2000 || !t.includes('.')) throw err(400, '인증 요청이 올바르지 않아요. 다시 시도해 주세요.');
    const [body, mac] = t.split('.');
    const a = Buffer.from(hmac(body)), b = Buffer.from(String(mac));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw err(400, '인증 요청이 올바르지 않아요. 다시 시도해 주세요.');
    const x = JSON.parse(b64u.dec(body).toString('utf8'));
    if (x.p !== purpose) throw err(400, '인증 요청이 올바르지 않아요. 다시 시도해 주세요.');
    if (x.e < now()) throw err(400, '인증 시간이 지났어요. 다시 시도해 주세요.', 'expired');
    return x;
  }
  const recordMac = r => hmac([r.credId, r.uid, r.accountId, r.alg, JSON.stringify(r.jwk)].join('|'));
  const validRecord = r => r && typeof r.mac === 'string' && r.mac === recordMac(r);

  function checkClientData(raw, type, challenge, rpId) {
    let cd;
    try { cd = JSON.parse(raw.toString('utf8')); } catch { throw err(400, '인증 정보를 읽지 못했어요.'); }
    if (cd.type !== type) throw err(400, '인증 종류가 맞지 않아요.');
    if (cd.challenge !== challenge) throw err(400, '인증 요청이 맞지 않아요. 다시 시도해 주세요.');
    const okOrigin = cd.origin === 'https://' + rpId || (rpId === 'localhost' && /^http:\/\/localhost(:\d+)?$/.test(cd.origin));
    if (!okOrigin) throw err(400, '이 사이트에서 만든 인증이 아니에요.');
  }
  function checkAuthData(ad, rpId) {
    if (!sha256(Buffer.from(rpId)).equals(ad.rpIdHash)) throw err(400, '이 사이트에서 만든 인증이 아니에요.');
    if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw err(400, 'Face ID·지문 확인이 완료되지 않았어요.');
  }
  async function useOnce(challenge) {
    const ref = db.collection('passkeyChallenges').doc(sha256(Buffer.from(challenge)).toString('hex'));
    try { await ref.create({at: now(), expiresAt: new Date(now() + TTL)}); }
    catch (e) { if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message)))) throw err(400, '이미 사용한 인증 요청이에요. 다시 시도해 주세요.'); throw e; }
  }
  async function listFor(accountId) {
    const s = await db.collection('passkeys').where('accountId', '==', accountId).get();
    return s.docs.map(d => ({...d.data(), credId: d.id})).filter(validRecord);
  }

  return {
    /* 로그인한 사용자: 이 기기 등록 준비 */
    async registerOptions(actor) {
      const t = ticket('reg', actor.uid);
      const mine = await listFor(actor.id);
      return {...t, user: {id: b64u.enc(Buffer.from(actor.uid)), name: actor.name || '팀원', displayName: actor.name || '팀원'}, exclude: mine.map(r => r.credId)};
    },
    async register(actor, input, rpId) {
      const x = readTicket(input.ticket, 'reg');
      if (x.s !== actor.uid) throw err(403, '다른 계정의 등록 요청이에요.');
      const clientData = b64u.dec(input.clientDataJSON);
      checkClientData(clientData, 'webauthn.create', x.c, rpId);
      const [att] = cborDecode(b64u.dec(input.attestationObject));
      if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw err(400, '인증 정보를 읽지 못했어요.');
      const ad = parseAuthData(att.get('authData'));
      checkAuthData(ad, rpId);
      if (!ad.credId || !ad.cose) throw err(400, '기기 공개키가 없어요.');
      const credId = b64u.enc(ad.credId);
      if (credId !== input.id) throw err(400, '기기 정보가 맞지 않아요.');
      const {alg, jwk} = coseToJwk(ad.cose);
      crypto.createPublicKey({key: jwk, format: 'jwk'});
      await useOnce(x.c);
      const rec = {credId, uid: actor.uid, accountId: actor.id, alg, jwk};
      const label = String(input.label || '').slice(0, 60);
      await db.collection('passkeys').doc(credId).set({uid: rec.uid, accountId: rec.accountId, alg, jwk, mac: recordMac(rec), signCount: ad.signCount, label, createdAt: now(), lastUsedAt: 0});
      return {ok: true, credId};
    },
    /* 로그인 전: 이 계정에 등록된 기기 목록으로 인증 요청 */
    async loginOptions(input) {
      const accountId = String(input.accountId || '').slice(0, 128);
      if (!accountId) throw err(400, '계정을 선택해 주세요.');
      const list = await listFor(accountId);
      if (!list.length) throw err(404, '이 계정은 Face ID·지문 로그인이 등록돼 있지 않아요. PIN으로 접속해 주세요.', 'none');
      return {...ticket('auth', accountId), allow: list.map(r => r.credId)};
    },
    async login(input, rpId, isApproved) {
      const x = readTicket(input.ticket, 'auth');
      const credId = String(input.id || '');
      const ref = db.collection('passkeys').doc(credId.slice(0, 1500) || '_');
      const snap = await ref.get();
      const rec = snap.exists ? {...snap.data(), credId} : null;
      if (!validRecord(rec) || rec.accountId !== x.s) throw err(401, '등록되지 않은 기기예요. PIN으로 접속한 뒤 다시 켜 주세요.', 'unknown');
      const clientData = b64u.dec(input.clientDataJSON), rawAd = b64u.dec(input.authenticatorData);
      checkClientData(clientData, 'webauthn.get', x.c, rpId);
      const ad = parseAuthData(rawAd);
      checkAuthData(ad, rpId);
      const ok = verifySignature(rec.alg, rec.jwk, Buffer.concat([rawAd, sha256(clientData)]), b64u.dec(input.signature));
      if (!ok) throw err(401, 'Face ID·지문 확인에 실패했어요. PIN으로 접속해 주세요.');
      if (ad.signCount && rec.signCount && ad.signCount <= rec.signCount) throw err(401, '복제된 인증기일 수 있어 막았어요. PIN으로 접속해 주세요.');
      await useOnce(x.c);
      if (!(await isApproved(rec))) throw err(403, '승인된 계정만 이용할 수 있어요.');
      await ref.set({signCount: ad.signCount, lastUsedAt: now()}, {merge: true});
      return {token: await auth.createCustomToken(rec.uid), accountId: rec.accountId};
    },
    async remove(actor, input) {
      const credId = String(input.credId || '');
      if (credId) {
        const ref = db.collection('passkeys').doc(credId.slice(0, 1500));
        const s = await ref.get();
        if (s.exists && s.data().uid === actor.uid) await ref.delete();
        return {ok: true};
      }
      // credId를 모르면(이 기기 기록이 지워진 경우) 이 계정의 모든 기기를 해제
      const list = await listFor(actor.id);
      await Promise.all(list.filter(r => r.uid === actor.uid).map(r => db.collection('passkeys').doc(r.credId).delete()));
      return {ok: true, removed: list.length};
    }
  };
}

module.exports = {createPasskeyService, cborDecode, parseAuthData, coseToJwk, verifySignature, b64u};
