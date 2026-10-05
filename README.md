# 꿈자리 찬양팀 웹앱

기준본 HTML을 변경하지 않고 Vercel 정적 배포용으로 `index.html`로 보존한 패키지입니다.

## 배포 구조
- 소스 코드: GitHub
- 웹 배포: Vercel
- 공용 데이터: Firebase Firestore
- 악보/이미지 저장: Firebase Storage
- 코드 업데이트와 사용자 데이터 저장소는 분리

## 중요
현재 HTML에는 Firebase SDK와 Firestore/Storage 어댑터가 이미 포함되어 있습니다. Firebase 설정이 없으면 브라우저별 체험 모드로 동작하고, `window.FIREBASE_CONFIG`가 채워지면 팀 공유 모드로 전환됩니다.

Firebase 설정값은 다음 단계에서 연결합니다. 기준본의 UI와 기능 코드는 임의로 삭제/변경하지 않습니다.
