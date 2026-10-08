'use strict';
/* Face ID · 지문 로그인(패스키). 추가 환경변수 없이 기존 FIREBASE_SERVICE_ACCOUNT를 사용.
   (다른 주소에서 쓰려면 PASSKEY_RP_ID 환경변수로 도메인을 지정할 수 있어요.) */
const {admin, init, authenticate, MANAGER_EMAIL} = require('../lib/firebase.cjs');
const {createPasskeyService} = require('../lib/passkey.cjs');

const ACTIONS = new Set(['registerOptions', 'register', 'loginOptions', 'login', 'remove']);
const AUTHED = new Set(['registerOptions', 'register', 'remove']);
let service;

function getService() {
  init();
  if (service) return service;
  let secret = '';
  try { secret = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}').private_key || ''; } catch {}
  service = createPasskeyService({db: admin.firestore(), auth: admin.auth(), secret});
  return service;
}
function rpIdOf(req) {
  const fixed = String(process.env.PASSKEY_RP_ID || '').trim();
  if (fixed) return fixed;
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}
async function isApproved(rec) {
  if (rec.accountId === 'management') {
    try { return (await admin.auth().getUser(rec.uid)).email === MANAGER_EMAIL; } catch { return false; }
  }
  if (rec.accountId !== rec.uid) return false;
  const s = await admin.firestore().doc('accounts/' + rec.uid).get();
  return s.exists && s.data().status === 'approved';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'POST 요청만 가능해요.'}); }
  let input;
  try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { return res.status(400).json({error: '요청 내용을 확인해 주세요.'}); }
  if (!input || typeof input !== 'object' || !ACTIONS.has(input.action) || JSON.stringify(input).length > 60000) return res.status(400).json({error: '요청 내용을 확인해 주세요.'});
  try {
    const svc = getService(), rpId = rpIdOf(req);
    if (!rpId) return res.status(400).json({error: '사이트 주소를 확인할 수 없어요.'});
    let out;
    if (AUTHED.has(input.action)) {
      const actor = await authenticate(req);
      if (input.action === 'registerOptions') out = {...await svc.registerOptions(actor), rpId};
      else if (input.action === 'register') out = await svc.register(actor, input, rpId);
      else out = await svc.remove(actor, input);
    } else if (input.action === 'loginOptions') out = {...await svc.loginOptions(input), rpId};
    else out = await svc.login(input, rpId, isApproved);
    return res.status(200).json(out);
  } catch (e) {
    const status = Number(e && e.status) || 500;
    if (status >= 500) console.error('[passkey]', e);
    return res.status(status).json({error: status >= 500 ? 'Face ID·지문 로그인 처리 중 오류가 났어요. PIN으로 접속해 주세요.' : e.message, code: e.code || ''});
  }
};
