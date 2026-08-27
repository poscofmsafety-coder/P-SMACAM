# API

## 상태·대시보드

- `GET /api/health`
- `GET /api/dashboard/summary`
- `GET /api/devices`
- `GET /api/events`
- `GET /api/reports/daily`

## 브라우저 현장 지킴이

- `POST /api/agents/register`
- `POST /api/agents/heartbeat`
- `POST /api/agents/offline`
- `POST /api/agents/preview/:deviceId` — JPEG binary
- `POST /api/agents/event`

## 관리자 설정

- `DELETE /api/devices/:deviceId`
- `POST /api/devices/cleanup-offline`
- `GET /api/devices/:deviceId/config`
- `PUT /api/devices/:deviceId/config`
- `POST /api/events/:eventId/ack`
- `POST /api/admin/clear-all`

## 미디어

- `GET /media/:key` — D1에 저장된 JPEG 프리뷰 또는 이벤트 스냅숏
