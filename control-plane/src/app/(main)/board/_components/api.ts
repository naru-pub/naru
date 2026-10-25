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
