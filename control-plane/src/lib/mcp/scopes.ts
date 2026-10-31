// What a Naru MCP connection may do, shared by the server and the consent
// page (which can't import oauth.ts's database code). write changes what
// the connection may read: files and collections, and with database its
// documents too.
export const SCOPES = ["read", "write", "database"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
  read: "사이트 정보, 파일, 컬렉션 설정 읽기",
  write: "파일과 컬렉션 만들기, 고치기, 옮기기, 지우기",
  database: "데이터베이스 문서 읽기 (수정을 허용하면 고치기도)",
};
