import { BoardError } from "./board-error";

// Template tags are whatever their authors type, kept to one spelling where a
// machine can tell: no leading #, no spaces, lower case. "자캐 커뮤" and
// "#자캐커뮤" are one tag. For the form and the server alike.
export const MAX_TEMPLATE_TAGS = 3;
export const MAX_TAG_LENGTH = 20;

export function normalizeTag(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\s+/g, "")
    .replace(/^#+/, "")
    .toLowerCase();
}

export function isValidTag(tag: string): boolean {
  return (
    tag.length > 0 &&
    tag.length <= MAX_TAG_LENGTH &&
    /^[\p{L}\p{N}_-]+$/u.test(tag)
  );
}

export function validateTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BoardError(400, "태그가 올바르지 않습니다.");
  }
  const tags = [
    ...new Set(
      value.map((tag) => (typeof tag === "string" ? normalizeTag(tag) : "")),
    ),
  ];
  if (!tags.every(isValidTag)) {
    throw new BoardError(
      400,
      `태그는 ${MAX_TAG_LENGTH}자 안의 글자와 숫자로 적어 주세요.`,
    );
  }
  if (tags.length > MAX_TEMPLATE_TAGS) {
    throw new BoardError(
      400,
      `태그는 ${MAX_TEMPLATE_TAGS}개까지 달 수 있어요.`,
    );
  }
  return tags;
}
