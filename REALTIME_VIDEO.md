# 실시간 영상·무전 설계

## 현재 구현

```text
현장 브라우저 카메라
  └─ WebRTC P2P 영상/음성
       ├─ Durable Objects WebSocket: SDP/ICE 신호만 전달
       └─ 관리자 브라우저: 실시간 영상·무전 재생
```

영상 본문은 Cloudflare D1을 거치지 않습니다. D1에는 장치상태, 이벤트, 저용량 스냅숏만 저장합니다.

## 자연스러운 영상 개선

- 카메라 1280×720, 24~30fps 목표
- 대화면 `high`: 최대 약 2.5Mbps/30fps
- 카드 `low`: 최대 약 700Kbps/18fps
- `degradationPreference=maintain-framerate`
- H.264 → VP8 → VP9 순서의 코덱 우선
- ICE candidate pool
- 연결 실패 시 ICE 재시작 및 재호출
- 대시보드 재렌더링 시 기존 `<video>`와 MediaStream 유지
- 비관제 페이지에서는 불필요한 영상 연결 해제

## Kakao FaceTalk과의 관계

상용 메신저의 사유 기술을 복제하는 방식이 아니라, 동일한 국제 표준인 WebRTC의 적응형 비트레이트·NAT 통과·SFU/TURN 구조를 적용합니다.

## 운영형 확장

현재 P2P는 시연과 소규모 관제에 적합합니다. 다음 조건에서는 Cloudflare Realtime SFU 전환을 권장합니다.

- 관리자 여러 명이 동일 영상을 동시에 봄
- 현장 장치가 다수이고 항상 모든 영상을 재생함
- 녹화·서버측 합성·다자간 화상회의가 필요함
- 현장 업로드 대역폭을 한 번만 사용해야 함

사내 방화벽 또는 대칭형 NAT 때문에 P2P 연결이 실패하는 경우에는 먼저 TURN을 설정합니다.
