import { optionalAppUser } from "@/lib/app-api/http";
import { SEARCH_MAX_LENGTH, showcasePage } from "@/lib/app-api/showcase";
import { protocolError } from "@/lib/site-data/validation";

// Public: the apps show it before anyone signs in. Signed in, it leaves out
// the sites the account hid, and is the account's alone. `q` searches it.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requested = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  const search = params.get("q")?.trim() || undefined;
  if (search && search.length > SEARCH_MAX_LENGTH)
    return protocolError(400, "검색어가 너무 깁니다.");
  try {
    const user = await optionalAppUser(request);
    return Response.json(await showcasePage(page, user?.id, search), {
      headers: {
        "Cache-Control": user ? "private, no-store" : "public, max-age=60",
        Vary: "Authorization",
      },
    });
  } catch (error) {
    console.error("Showcase error:", error);
    return protocolError(500, "사이트 목록을 불러오지 못했습니다.");
  }
}
