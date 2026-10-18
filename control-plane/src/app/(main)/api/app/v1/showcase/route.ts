import { showcasePage } from "@/lib/app-api/showcase";
import { protocolError } from "@/lib/site-data/validation";

// Public: the apps show it before anyone signs in.
export async function GET(request: Request) {
  const requested = Number.parseInt(
    new URL(request.url).searchParams.get("page") ?? "1",
    10,
  );
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  try {
    return Response.json(await showcasePage(page), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    console.error("Showcase error:", error);
    return protocolError(500, "사이트 목록을 불러오지 못했습니다.");
  }
}
