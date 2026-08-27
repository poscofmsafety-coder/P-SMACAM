# Cloudflare 배포 아키텍처

```text
현장 노트북 브라우저
  getUserMedia 카메라
  TensorFlow.js 사람 감지
  위험구역 판정·한국어 음성
          │
          │ HTTPS heartbeat / JPEG preview / event
          ▼
Cloudflare Worker
  API + Static Assets
          │
          ▼
Cloudflare D1
  devices / events / media / config
          │
          ▼
관리자 통합 대시보드
  장치 상태 / 5초 프리뷰 / 위험구역 / 이벤트
```

## Cloudflare 리소스

- Workers Static Assets: `public/`
- Worker API: `src/worker.js`
- D1 binding: `DB`
- R2: 사용하지 않음

## 데이터 주기

- Heartbeat: 10초
- 카메라 프리뷰: 5초
- 원격 설정 동기화: 10초
- 대시보드 갱신: 5초

## 브라우저 현장 지킴이

- 현장 사용자는 `/guard` 또는 관리자 화면 상단의 `지킴이 ON`으로 시작합니다.
- 브라우저별 고유 장치 ID는 Local Storage에 저장됩니다.
- 카메라 영상은 브라우저에서 처리하고 저용량 JPEG 프리뷰 및 이벤트 스냅숏만 서버에 보냅니다.
- 지킴이 탭을 닫거나 OFF를 누르면 장치를 오프라인으로 표시합니다.

## 운영 전 보강 항목

- 관리자 로그인과 현장 장치 페어링 코드
- 이미지 보존기간 및 자동 삭제
- 영상정보처리기기·개인정보 정책 검토
- 장기 운영 시 R2 또는 사내 영상 저장소 전환
- 안전모·보안경·안전대·후크·중장비 전용 모델
- 연속 실시간 영상이 필요할 경우 WebRTC/SFU 별도 구성
