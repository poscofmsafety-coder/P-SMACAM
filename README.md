# POSCO Future M 스마트 안전지킴이 v2

브라우저 카메라를 AI 안전 CCTV로 사용하고 Cloudflare Workers에서 여러 현장을 통합 관제하는 GitHub 업로드용 프로젝트입니다.

## v2 주요 기능

- WebRTC P2P 실시간 영상: 기존 5초 간격 컷 프리뷰 방식 개선
- 브라우저 Web Worker 기반 PPE AI: 안전모·보안경·안전대 미착용 의심 박스 표시
- 안전모 미착용 반복 감지 시 `안전모를 착용해주세요.` 한국어 자동 음성
- 관리자 ↔ 현장 사용자 양방향 무전과 호출 벨
- 관리자 모드와 사용자 모드 분리
- 현장 접속 QR 코드
- 노트북·휴대폰 반응형 UI
- 위험구역 원격 설정, 이벤트 스냅숏, D1 기록
- 메인 UI와 AI 추론을 분리해 화면 멈춤 완화

## GitHub / Cloudflare 배포

1. 이 폴더 안의 파일을 GitHub 저장소 루트에 그대로 덮어씁니다.
2. Commit & Push 합니다.
3. Cloudflare Workers Builds에서 자동 배포를 확인합니다.

배포 설정:

```text
Build command: 없음
Deploy command: npx wrangler deploy
Root directory: /
```

이번 버전은 D1과 SQLite 기반 Durable Objects를 자동 프로비저닝합니다.

## 최초 로그인

기본값은 `wrangler.jsonc`에 있습니다.

```text
관리자 PIN: 2468
사용자 PIN: 1357
```

시연 후 반드시 다음 값을 변경하세요.

```text
ADMIN_PIN
USER_PIN
SESSION_SECRET
```

Cloudflare Dashboard의 Worker Settings > Variables and Secrets에서 Secret으로 등록하는 방식이 권장됩니다.

## 사용 흐름

### 관리자

1. 관리자 모드 로그인
2. 현장 QR 코드 열기
3. 휴대폰 또는 다른 노트북에서 QR 스캔
4. 실시간 관제에서 WebRTC 영상 확인
5. `무전 호출`로 현장과 통화

### 현장 사용자

1. 사용자 모드 로그인
2. `지킴이 시작` 클릭
3. 카메라·마이크 허용
4. 장치 이름·사업장·설치구역 저장
5. 현장 탭을 열어 둔 상태로 운영

## 보호구 AI 모델

브라우저는 `/models/ppe.onnx`를 통해 PPE ONNX 모델을 최초 1회 다운로드합니다. 모델은 안전모, 미착용 안전모, 보안경, 미착용 보안경, 안전대 미착용, 넘어짐 등의 클래스를 제공합니다.

첫 로딩은 네트워크 속도에 따라 시간이 걸릴 수 있습니다. 모델은 Cloudflare Cache와 브라우저 캐시에 저장됩니다.

> 이 기능은 관리자 확인을 돕는 PoC입니다. 오탐·미탐이 가능하므로 징계·법적 판단의 단독 근거로 사용하지 마십시오.

## WebRTC 연결 참고

기본값은 Cloudflare 공개 STUN을 사용한 P2P 연결입니다. 회사 방화벽이나 대칭 NAT 환경에서는 영상 또는 무전 연결이 실패할 수 있습니다. 그런 환경에서는 Cloudflare TURN의 단기 자격증명을 발급해 `TURN_ICE_SERVERS`에 추가해야 합니다.

## 주요 파일

```text
public/index.html       화면 구조
public/styles.css       PC/모바일 반응형 UI
public/app.js           관제·카메라·WebRTC·무전·음성·QR
public/ppe-worker.js    보호구 AI 전용 Web Worker
src/worker.js           API·D1·인증·Durable Object 신호 서버
wrangler.jsonc          Cloudflare 배포 설정
```
