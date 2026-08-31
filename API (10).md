# 스마트 안전지킴이 V4 API

모든 일반 API는 로그인 세션 쿠키를 사용합니다. `/api/tbm/inbound-email`만 별도의 `x-tbm-token` 헤더를 사용합니다.

## 인증

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

## 관제

- `GET /api/dashboard/summary`
- `GET /api/devices`
- `GET /api/events`
- `POST /api/events/:id/ack`

## 현장 지킴이

- `POST /api/agents/register`
- `POST /api/agents/heartbeat`
- `POST /api/agents/offline`
- `POST /api/agents/preview/:deviceId`
- `POST /api/agents/event`
- `GET /api/devices/:deviceId/config`

## 작업중지권

- `GET /api/work-stop` 관리자
- `POST /api/work-stop` 사용자·관리자
- `POST /api/work-stop/:id/status` 관리자

### 작업중지권 요청 예시

```json
{
  "deviceId": "guard_xxx",
  "requesterName": "홍길동",
  "requesterContact": "010-0000-0000",
  "reason": "인양물 아래 작업자가 진입하여 작업중지를 요청합니다.",
  "snapshotBase64": "data:image/jpeg;base64,...",
  "autoCall": true
}
```

## AI 사진분석

- `POST /api/ai/photo-analysis`

```json
{
  "deviceId": "guard_xxx",
  "imageBase64": "data:image/jpeg;base64,...",
  "sendEmail": true,
  "notifyEmail": "manager@example.com"
}
```

## TBM

- `GET /api/tbm/sessions`
- `POST /api/tbm/sessions` 관리자
- `GET /api/tbm/active`
- `POST /api/tbm/feedback`
- `POST /api/tbm/inbound-email` 외부 메일 연동

외부 수신 헤더:

```text
x-tbm-token: <TBM_INBOUND_TOKEN>
```

## 관리자 설정

- `PUT /api/devices/:deviceId/config`
- `DELETE /api/devices/:deviceId`

## 실시간 신호

- `GET /api/realtime/:deviceId?role=admin|guard&clientId=...` WebSocket Upgrade

주요 메시지:

- 영상: `watch-start`, `watch-stop`, `offer`, `answer`, `ice`
- 무전: `call-request`, `call-accept`, `call-reject`, `call-offer`, `call-answer`, `call-ice`, `call-end`
- 긴급요청: `stop-work-request`, `stop-work-status`
- 사진분석: `photo-analysis-ready`

## 모델

- `GET /models/ppe.onnx`
