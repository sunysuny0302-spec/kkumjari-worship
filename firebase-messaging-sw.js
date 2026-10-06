/* 꿈자리 찬양팀 — 푸시 알림 수신 (사이트를 닫아 두어도 알림을 표시) */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyA-lb09RLMgiZV8LBYfcrvxZB-umwPCR-I",
  authDomain: "kkumjari-worship.firebaseapp.com",
  projectId: "kkumjari-worship",
  storageBucket: "kkumjari-worship.firebasestorage.app",
  messagingSenderId: "888617439047",
  appId: "1:888617439047:web:ab26d984fd4b9f4b3e4662"
});
const messaging = firebase.messaging();
/* 알림 내용(notification)이 있는 메시지는 Firebase가 자동으로 표시합니다.
   혹시 데이터만 온 경우를 위해 직접 표시합니다. */
messaging.onBackgroundMessage(function (p) {
  if (p && p.notification) return;
  var d = (p && p.data) || {};
  return self.registration.showNotification(d.title || '꿈자리 찬양팀', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { link: d.link || '/' }, tag: d.tag || undefined
  });
});
self.addEventListener('notificationclick', function (e) {
  var link = (e.notification && e.notification.data && (e.notification.data.link || (e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link))) || '/';
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) { list[i].navigate && list[i].navigate(link).catch(function(){}); return list[i].focus(); } }
    return clients.openWindow(link);
  }));
});
