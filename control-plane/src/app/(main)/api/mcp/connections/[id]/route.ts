import { validateRequest } from "@/lib/auth";
import { appResponse } from "@/lib/app-api/http";
import { revokeGrant } from "@/lib/mcp/oauth";
import { DataError, sameOrigin } from "@/lib/site-data/validation";
import { parseUuid } from "@/lib/uuid";

// 연결 끊기 on /account: ends the connection and both its tokens.
export const DELETE = (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) =>
  appResponse(async () => {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user)
      throw new DataError(401, "나루에 다시 로그인해 주세요.", "AUTH_REQUIRED");
    const id = parseUuid((await params).id);
    if (!id) throw new DataError(404, "연결을 찾을 수 없습니다.");
    await revokeGrant(user.id, id);
  });
