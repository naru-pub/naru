import * as Sentry from "@sentry/nextjs";
import { BoardError } from "./board-error";

/**
 * A board route's answer to a page that asked for application/x-ndjson:
 * `work`'s progress as it goes, one JSON line each ({ type: "progress" }),
 * then a "done" line with its result or the message it failed with. The work
 * goes on to the end even if the page goes away. Read by `boardStream`
 * (board/_components/api.ts).
 */
export function progressResponse<Result, Progress extends object>(
  work: (report: (progress: Progress) => void) => Promise<Result>,
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
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
        const result = await work((progress) =>
          emit({ type: "progress", ...progress }),
        );
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
}

/** Whether `request` asks for its work's progress as it goes. */
export const wantsProgress = (request: Request) =>
  request.headers.get("accept")?.includes("application/x-ndjson") ?? false;
