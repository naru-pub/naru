// Client-side calls to /api/board. Every mutating route takes JSON (the
// routes refuse anything else), so even DELETE sends a body.
export async function boardRequest<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown = {},
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok || !data?.success) {
    throw new Error(data?.message ?? "요청을 처리하지 못했습니다.");
  }
  return data as T;
}

/**
 * A board request whose route streams its progress (application/x-ndjson):
 * `onProgress` with each progress line, resolving with the "done" line's
 * result. A route that answers with plain JSON instead (an error before the
 * work started) is read as `boardRequest` reads it.
 */
export async function boardStream<Result, Progress>(
  url: string,
  body: unknown,
  onProgress: (progress: Progress) => void,
  method: "POST" | "DELETE" = "POST",
): Promise<Result> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(body),
  });
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  ) {
    let data: any = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok || !data?.success)
      throw new Error(data?.message ?? "요청을 처리하지 못했습니다.");
    return data.result as Result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const { type, ...event } = JSON.parse(line);
        if (type === "progress") onProgress(event as Progress);
        else if (type === "done") {
          if (!event.success) throw new Error(event.message);
          return event.result as Result;
        }
      }
      if (chunk.done)
        throw new Error(
          "연결이 끊겼어요. 사이트의 파일을 확인한 뒤에 다시 해 주세요.",
        );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// A template's own preview image, sent as the request body.
export async function uploadTemplatePreview(
  templateId: string,
  file: File,
): Promise<void> {
  const response = await fetch(`/api/board/templates/${templateId}/preview`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  let data: any = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok || !data?.success) {
    throw new Error(data?.message ?? "미리보기 이미지를 올리지 못했습니다.");
  }
}
