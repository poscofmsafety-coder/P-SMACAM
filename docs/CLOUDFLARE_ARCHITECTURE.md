# Cloudflare 배포 아키텍처 v2

```text
현장 노트북/휴대폰 브라우저
  ├─ getUserMedia 카메라·마이크
  ├─ PPE ONNX Web Worker
  ├─ 한국어 음성 경고
  ├─ WebRTC 영상/무전 ─────────────┐
  └─ Heartbeat/Event/Preview       │ P2P media
                    │               │
                    ▼               │
Cloudflare Worker + Static Assets   │
  ├─ Session Cookie 인증            │
  ├─ REST API                        │
  ├─ PPE 모델 캐시 프록시           │
  └─ Durable Object WebSocket 신호 ─┘
                    │
                    ▼
Cloudflare D1
  ├─ 장치
  ├─ 이벤트
  ├─ 위험구역/규칙
  └─ 저용량 이벤트 이미지
```

## 실시간 영상

영상 본문은 D1에 반복 저장하지 않고 브라우저 간 WebRTC P2P로 전달합니다. Durable Object는 SDP/ICE/호출 상태 같은 작은 신호 메시지만 전달합니다.

## WebSocket

장치 ID마다 `SignalingRoom` Durable Object가 하나 생성됩니다. 관리자와 현장 사용자는 해당 방에 WebSocket으로 접속합니다. Hibernation API를 사용해 유휴 시간 비용을 줄입니다.

## 무전

실시간 영상과 별도의 WebRTC 오디오 연결을 사용합니다. 호출 요청은 WebSocket으로 전달하며, 통화 연결 후에는 `누르고 말하기` 버튼으로 마이크 트랙을 켜고 끕니다.

## 보안

- 관리자/사용자 PIN 분리
- HMAC 서명 HttpOnly Session Cookie
- 관리자 API 권한 검사
- HTTPS 카메라/마이크 권한
- 이벤트 이미지만 D1에 저장

운영 환경에서는 PIN과 SESSION_SECRET을 Wrangler 파일이 아닌 Cloudflare Secret으로 관리해야 합니다.
