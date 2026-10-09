'use strict';
/* 관리계정 전용 계정 관리 API (계정 목록 · PIN 재설정 · 원격 로그아웃 · 정지 · 가입 관리).
   추가 환경변수 없이 기존 FIREBASE_SERVICE_ACCOUNT를 사용해요. */
const {admin, init, authenticate} = require('../lib/firebase.cjs');
const {createAdminService, PUBLIC, ADMIN, SELF} = require('../lib/admin-service.cjs');
let service;
function getService() {
  init();
  if (!service) service = createAdminService({db: admin.firestore(), auth: admin.auth()});
  return service;
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'POST 요청만 가능해요.'}); }
  let input;
  try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { return res.status(400).json({error: '요청 내용을 확인해 주세요.'}); }
  const a = input && input.action;
  if (!input || typeof input !== 'object' || !(PUBLIC.has(a) || ADMIN.has(a) || SELF.has(a)) || JSON.stringify(input).length > 4000) return res.status(400).json({error: '요청 내용을 확인해 주세요.'});
  try {
    const svc = getService();
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const out = PUBLIC.has(a) ? await svc.publicRun(input, ip) : await svc.run(await authenticate(req), input);
    return res.status(200).json(out);
  } catch (e) {
    const status = Number(e && e.status) || 500;
    if (status >= 500) console.error('[admin]', e && (e.code || e.message));
    return res.status(status).json({error: status >= 500 ? '서버 처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요.' : e.message});
  }
};
