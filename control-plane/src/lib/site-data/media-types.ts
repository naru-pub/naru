// The types Naru Media stores: an upload of any other is refused
// (media.ts), so site SQL's _naru_uploads holds only these.
export const MEDIA_TYPES = Object.freeze([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "application/pdf",
  "application/zip",
  "text/plain",
] as const);
