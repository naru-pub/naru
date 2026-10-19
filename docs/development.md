# 개발 환경 설정

## 사전 요구사항

- **Node.js** 18+
- **PostgreSQL** 15+
- **Cloudflare R2** 계정 (또는 AWS S3)

## 1. 저장소 클론

```bash
git clone https://github.com/your-username/naru-pub.git
cd naru-pub
```

## 2. Control Plane 설정

```bash
cd control-plane

# 의존성 설치 (pnpm 사용; npm 사용 금지)
pnpm install

# 환경 변수 설정
cp .env.template .env
```

`.env` 파일을 편집하여 다음 환경 변수들을 설정하세요:

```env
# 데이터베이스
DATABASE_URL=postgresql://username:password@localhost:5432/naru

# S3/R2 설정
S3_BUCKET_NAME=your-bucket-name
S3_PRIVATE_BUCKET_NAME=your-private-bucket-name
SITE_DATA_MEDIA_BUCKET=naru-media
SITE_DATA_MEDIA_ORIGIN=https://media.naru.pub
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# 기타
NEXT_PUBLIC_DOMAIN=naru.pub
CUSTOM_DOMAIN_CNAME_TARGET=customers.naru.pub
CLOUDFLARE_ZONE_ID=your-cloudflare-zone-id
CLOUDFLARE_USER_API_TOKEN=your-cloudflare-api-token

# Toss Payments (결제 흐름) — 테스트 키 사용. 자동결제와 한 번만 결제는 MID가 달라 키도 따로입니다.
TOSS_BILLING_CLIENT_KEY=your-toss-billing-client-key
TOSS_BILLING_SECRET_KEY=your-toss-billing-secret-key
TOSS_PAYMENT_CLIENT_KEY=your-toss-payment-client-key
TOSS_PAYMENT_SECRET_KEY=your-toss-payment-secret-key
```

`naru-media`에는 `media.naru.pub` 공개 커스텀 도메인을 연결하세요. 객체 쓰기는
서명된 R2 API URL로만 허용합니다. 브라우저가 직접 업로드할 수 있도록 버킷 CORS에서
웹사이트 출처의 `PUT`과 `Content-Type` 헤더를 허용해야 합니다. R2 API 토큰에는
`naru-media`의 객체 읽기·쓰기 권한도 필요합니다.

## 3. 데이터베이스 설정

```bash
# 데이터베이스 마이그레이션 실행
pnpm migrate

# 타입 생성 (선택사항)
pnpm kysely-codegen
```

## 4. Edge Worker 설정

호스팅 사이트(`<login>.naru.pub`와 커스텀 도메인)는 Cloudflare Worker인 `edge/`가 R2에서 바로 서빙합니다. 사이트 데이터베이스와 페이지뷰 기록도 이 Worker에 있습니다.

```bash
cd ../edge
pnpm install
pnpm test
```

Control Plane 테스트 가운데 Worker가 필요한 것은 `control-plane/scripts/with-edge-worker.sh`가 Worker를 `wrangler dev --env local`로 띄운 채 실행합니다. `local` 환경(`edge/wrangler.jsonc`의 `env.local`)은 배포되는 Worker와 달리 사이트 데이터베이스(`SiteData`)를 직접 가집니다. 배포되는 Worker에는 없고, 맥 미니의 workerd에만 있습니다.

> 커스텀 도메인 운영 설정(Cloudflare for SaaS, Worker 라우트)은 [커스텀 도메인](custom-domains.md)을, 결제 흐름 설정은 [유료 서비스와 결제](billing.md)를 참고하세요.

## 5. 개발 서버 실행

**Control Plane:**

```bash
cd control-plane
pnpm dev
```

이제 다음 주소에서 Control Plane에 접근할 수 있습니다:

- Control Plane: http://localhost:3000

## 사이트 하나를 로컬에서 실행하기 (naru-dev)

Naru 데이터 SDK를 쓰는 사이트를 실제 edge Worker로 로컬에서 실행합니다.
사이트 개발자는 Naru 체크아웃 없이 npm 패키지로 씁니다
([naru-dev/README.md](../naru-dev/README.md)):

```bash
npx @naru-pub/dev ~/Git/neo-avocado --site neo-avocado
```

이 체크아웃의 코드로 돌리려면 `edge/`와 `control-plane/`에서 `pnpm install`을
마친 뒤 같은 코드를 소스에서 실행합니다(edge Worker를 `naru-dev/.worker/`로
먼저 묶습니다):

```bash
cd control-plane && pnpm naru-dev ~/Git/neo-avocado --site neo-avocado
```

http://localhost:4000 에서 사이트 파일, SDK, 데이터 API를 함께 제공하고,
운영자·회원 로그인은 한 번의 클릭으로 끝납니다. `_naru/`를 고치면 바로 다시
게시합니다. 데이터는 사이트 폴더의 `.naru-dev/`에 남습니다. 자세한 내용은
[sdk-v1-api.md](sdk-v1-api.md#local-development-naru-dev)를 참고하세요.

패키지(`naru-dev/`)는 `pnpm install`(그 폴더와 `edge/`) 뒤 `pnpm build`로
`dist/`에 빌드하고, `scripts/check-package.sh <폴더>`로 npm에 올릴 tarball을
만들어 저장소 밖에 설치해 smoke test(`test/smoke.mjs`)를 돌립니다. CI가 push마다
같은 검사를 하고, `dev-v<버전>` 태그를 push하면 npm에 게시합니다
(`.github/workflows/publish-naru-dev.yml`).

## 프로젝트 구조

```
naru-pub/
├── control-plane/          # Next.js 웹 애플리케이션
│   ├── src/
│   │   ├── app/           # Next.js App Router
│   │   ├── components/    # React 컴포넌트
│   │   ├── lib/          # 유틸리티 및 설정
│   │   └── migrations/   # 데이터베이스 마이그레이션
│   └── package.json
├── edge/                  # Cloudflare Worker (호스팅 사이트, 사이트 데이터베이스, 페이지뷰)
│   ├── src/
│   └── wrangler.jsonc
├── docs/                  # 문서
└── README.md
```

## 테스트

```bash
# Control Plane 테스트
cd control-plane
pnpm test

# E2E 테스트 (Playwright)
pnpm exec playwright test
```

## 사용 가능한 스크립트

### Control Plane

```bash
pnpm dev                  # 개발 서버 실행
pnpm build                # 프로덕션 빌드
pnpm start                # 프로덕션 서버 실행
pnpm lint                 # 코드 린팅
pnpm migrate              # 데이터베이스 마이그레이션
pnpm kysely-codegen       # 데이터베이스 타입 생성
pnpm charge-subscriptions # 구독 자동 갱신 청구 (cron이 매일 실행)
```

### Edge

```bash
pnpm test                 # 테스트
pnpm typecheck            # 타입 검사
pnpm dev                  # wrangler dev --env local로 실행 (사이트 데이터베이스 포함)
```
