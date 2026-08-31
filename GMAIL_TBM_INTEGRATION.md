# Gmail D-안전회의 메일 자동수신

이 연동은 Gmail에 특정 라벨이 붙은 D-안전회의 메일을 10분마다 확인해 스마트 안전지킴이 TBM API로 전달합니다.

## 1. Gmail 라벨 생성

```text
D-SAFETY
```

D-안전회의 메일에 해당 라벨을 자동으로 붙이는 Gmail 필터를 설정합니다.

## 2. Apps Script 생성

1. Google Apps Script 새 프로젝트를 만듭니다.
2. `integrations/gmail-apps-script/Code.gs` 내용을 붙여 넣습니다.
3. 프로젝트 설정에서 Script Properties를 등록합니다.

```text
WORKER_URL=https://<worker-name>.<subdomain>.workers.dev
TBM_TOKEN=<Cloudflare TBM_INBOUND_TOKEN과 동일>
MANAGER_EMAIL=manager@example.com
SOURCE_LABEL=D-SAFETY
PROCESSED_LABEL=SSG-TBM-PROCESSED
WORK_DATE_OFFSET_DAYS=1
```

## 3. 최초 승인 및 시험

Apps Script에서 `syncTbmEmails`를 직접 한 번 실행합니다. Gmail 읽기·라벨 수정·외부 요청 권한을 승인합니다.

성공한 메일에는 다음 라벨이 추가됩니다.

```text
SSG-TBM-PROCESSED
```

## 4. 자동 실행

`installTbmTrigger`를 한 번 실행하면 `syncTbmEmails`가 10분마다 실행됩니다.

## 5. 처리 흐름

```text
D-안전회의 메일 수신
→ Gmail 필터가 D-SAFETY 라벨 부여
→ Apps Script가 메일 제목·본문·보낸 사람을 읽음
→ /api/tbm/inbound-email 전송
→ AI TBM 요약 생성
→ 사용자 화면에 활성 TBM 표시
→ 담당자 이메일 발송(설정 시)
→ Gmail에 처리완료 라벨 부여
```

## 보안

- `TBM_TOKEN`은 GitHub 코드에 직접 넣지 않습니다.
- Cloudflare에서는 Secret으로, Apps Script에서는 Script Property로 저장합니다.
- 메일 본문에는 개인정보·영업비밀이 포함될 수 있으므로 사내 보안정책과 외부 AI 전송 허용범위를 먼저 확인합니다.
