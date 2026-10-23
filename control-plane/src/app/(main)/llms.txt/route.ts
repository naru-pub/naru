import { AI_PROMPT, AI_PROMPT_SDK_VERSION } from "@/lib/ai-prompt";
import { SDK_URL } from "@/lib/const";

// /llms.txt (llmstxt.org): what an AI assistant reads to build a site for
// Naru — a summary and links, then the same prompt /docs/ai offers to paste.
export const dynamic = "force-static";

const sdk = `${SDK_URL}/${AI_PROMPT_SDK_VERSION}`;

const body = `# 나루 (Naru)

> 나루는 개인 웹사이트 호스팅입니다. 올린 파일이 <아이디>.naru.pub에서 열리고, 데이터 SDK(naru.js)로 서버 없이 사이트에 데이터베이스를 더합니다.

## 문서

- [AI로 사이트 만들기](https://naru.pub/docs/ai): 아래 안내를 사람이 AI에게 붙여 넣는 페이지
- [데이터베이스 사용 안내](https://naru.pub/docs/${AI_PROMPT_SDK_VERSION}/database): 컬렉션, 공개 범위, 관리자 로그인, 목록
- [미디어 사용 안내](https://naru.pub/docs/${AI_PROMPT_SDK_VERSION}/media): 이미지와 파일 올리기
- [SDK 레퍼런스](https://naru.pub/docs/sdk/${AI_PROMPT_SDK_VERSION}): 모든 함수와 타입
- [naru.d.ts](${sdk}/naru.d.ts): SDK의 TypeScript 타입

## 템플릿

- [데이터베이스 템플릿](https://naru.pub/board?kind=template&database=1): 바로 적용할 수 있는 사이트

---

${AI_PROMPT}`;

export function GET() {
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
