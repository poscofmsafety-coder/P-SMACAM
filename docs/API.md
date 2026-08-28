# API 요약

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

## 관리자 설정

- `PUT /api/devices/:deviceId/config`
- `DELETE /api/devices/:deviceId`

## 실시간 신호

- `GET /api/realtime/:deviceId?role=admin|guard&clientId=...` WebSocket Upgrade

메시지 유형:

- `watch-start`, `watch-stop`
- `offer`, `answer`, `ice`
- `call-request`, `call-accept`, `call-reject`
- `call-offer`, `call-answer`, `call-ice`, `call-end`

## 모델

- `GET /models/ppe.onnx`
