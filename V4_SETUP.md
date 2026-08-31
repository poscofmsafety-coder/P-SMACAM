# V4 Cloudflare 설정 가이드

## 1. 기본 배포

```text
Cloudflare Workers
Build command: 없음
Deploy command: npx wrangler deploy
Root directory: /
```

`wrangler.jsonc`에는 다음 바인딩이 포함되어 있습니다.

- Static Assets
- D1 `DB`
- Durable Objects `SIGNALING`
- Workers AI `AI`

## 2. Cloudflare Secret 권장값

로컬 Wrangler CLI를 사용하는 경우:

```powershell
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CF_EMAIL_API_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TBM_INBOUND_TOKEN
```

Cloudflare 대시보드에서는 다음 경로에서 동일하게 등록할 수 있습니다.

```text
Worker → Settings → Variables and Secrets
```

### 반드시 변경

```text
ADMIN_PIN
USER_PIN
SESSION_SECRET
TBM_INBOUND_TOKEN
```

## 3. AI 사진분석·TBM

기본 우선순위:

```text
AI_PROVIDER=workers-ai,openai
```

Workers AI가 성공하면 이를 사용하고, 실패했을 때 `OPENAI_API_KEY`가 있으면 OpenAI Responses API로 재시도합니다.

```text
WORKERS_AI_MODEL=@cf/qwen/qwen3.8-27b
OPENAI_MODEL=gpt-5-mini
```

사진분석 프롬프트는 `src/safety-photo-prompt.js`에 포함되어 있습니다.

## 4. 이메일 발송

다음 값을 설정합니다.

```text
CLOUDFLARE_ACCOUNT_ID=<Cloudflare 계정 ID>
CF_EMAIL_API_TOKEN=<Email Sending 권한 API Token>
EMAIL_FROM=safety@verified-domain.example
ADMIN_EMAIL=manager@example.com
```

Cloudflare Email Sending을 사용할 수 없는 무료 시연 환경에서는 `RESEND_API_KEY`를 Secret으로 등록할 수 있습니다. 두 서비스가 모두 설정되어 있으면 Cloudflare를 먼저 시도하고 실패할 때 Resend로 재시도합니다. Resend도 발신 도메인 검증과 `EMAIL_FROM` 설정이 필요합니다.

이메일 서비스가 설정되지 않아도 화면 알람·D1 기록·실시간 관제는 작동하며, API 결과에는 `not_configured`로 표시됩니다.

## 5. 메시지 Webhook

```text
NOTIFY_WEBHOOK_URL=https://your-message-relay.example/webhook
```

작업중지권 요청 시 다음 JSON이 전송됩니다.

```json
{
  "type": "STOP_WORK_REQUEST",
  "id": "stop_...",
  "deviceId": "guard_...",
  "device": {
    "name": "현장 노트북 1",
    "site": "포항 사업장",
    "area": "원료 투입구역"
  },
  "requesterName": "홍길동",
  "requesterContact": "010-0000-0000",
  "reason": "인양물 하부 진입 위험",
  "requestedAt": "2026-08-28T...Z"
}
```

사내 메시지 게이트웨이, Teams/Slack/Kakao Work 중계 서버 등에서 해당 JSON을 각 서비스 형식으로 변환하면 됩니다.

## 6. TURN 설정

기본 STUN만으로 연결되지 않는 사내망에서는 `TURN_ICE_SERVERS`에 JSON 배열을 등록합니다.

```json
[
  {
    "urls": ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
    "username": "turn-user",
    "credential": "turn-password"
  }
]
```

Secret 값으로 관리하는 것을 권장합니다.

## 7. TBM 자동수신

`integrations/gmail-apps-script/` 예제를 사용합니다.

Worker Secret:

```text
TBM_INBOUND_TOKEN=<충분히 긴 임의 문자열>
```

Gmail Apps Script의 `TBM_TOKEN`에도 같은 값을 등록합니다. 자세한 내용은 [`GMAIL_TBM_INTEGRATION.md`](GMAIL_TBM_INTEGRATION.md)를 참고합니다.

## 8. 배포 후 점검

- `/api/health` 응답의 version이 `4.0.0`인지 확인
- 사용자 카메라 시작
- 관리자 대화면 WebRTC 영상 확인
- 작업중지권 긴급 알람 확인
- 무전 양방향 음성 확인
- 사진 AI 분석 제공자·메일 상태 확인
- TBM 생성·작업자 의견 제출 확인
