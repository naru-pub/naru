import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireUser } from "@/lib/board/access";
import {
  BoardError,
  boardErrorResponse,
  parseId,
  readJson,
} from "@/lib/board/errors";
import { applyTemplate, type ApplyProgress } from "@/lib/board/templates";

// Applying writes only to the person's own site, so it needs a login but not
// a verified email.
//
// A page that asks for application/x-ndjson gets the application's progress
// as it goes, one JSON line each, and then a "done" line with the result or
// the message: a template of a few hundred files takes a while. Anything
// else gets the result as one JSON answer.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const versionId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const input = {
      targetPath: body.targetPath,
      backup: body.backup,
      createCollections: body.createCollections,
      updates: body.updates,
    };
    if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
      const result = await applyTemplate(user, versionId, input);
      return NextResponse.json({ success: true, result });
    }
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      // The application goes on to the end even if the page goes away.
      async start(controller) {
        const emit = (event: object) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            open = false;
          }
        };
        try {
          const result = await applyTemplate(user, versionId, {
            ...input,
            onProgress: (progress: ApplyProgress) =>
              emit({ type: "progress", ...progress }),
          });
          emit({ type: "done", success: true, result });
        } catch (error) {
          if (!(error instanceof BoardError)) {
            console.error("[board]", error);
            Sentry.captureException(error);
          }
          emit({
            type: "done",
            success: false,
            message:
              error instanceof BoardError
                ? error.message
                : "요청을 처리하지 못했습니다.",
          });
        }
        if (open) controller.close();
      },
      cancel() {
        open = false;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
