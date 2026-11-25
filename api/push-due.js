'use strict';
/* 예약된 콘티 알림 중 시간이 된 것만 보내요. 시간이 안 된 건 건드리지 않으니 누가 불러도 안전해요.
   GitHub Actions(.github/workflows/push-due.yml)가 5분마다 부르고, 앱을 연 사람도 10분마다 불러요. */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  try {
    const out = await require('../lib/community-runtime.cjs').getRuntime().run({system: true}, {action: 'pushDue'});
    return res.status(200).json({ok: true, due: out.due || 0});
  } catch (e) {
    console.error('[push-due]', e && (e.code || e.message));
    return res.status(500).json({error: '처리하지 못했어요'});
  }
};
