// What a Naru MCP connection may do, shared by the server and the consent
// page (which can't import oauth.ts's database code).
export const SCOPES = ["read", "write"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
  read: "사이트 정보와 파일 읽기",
  write: "파일 만들기, 고치기, 옮기기, 지우기",
};
