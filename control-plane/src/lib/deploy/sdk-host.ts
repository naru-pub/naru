// The Data SDK is served from Seoul at sdk.naru.pub (edge/seoul/), and pages
// that load it from naru.pub/sdk/ cross the Pacific for it. Site files are
// pointed at the new host: once by the point-sites-at-sdk-host CLI, and on
// every GitHub deploy after, which publishes them rewritten. All of a file's
// references change together, since a page that loaded both URLs would run
// two copies of the SDK.
//
// Set SDK_ORIGIN (https://sdk.naru.pub) once it serves; unset, nothing is
// rewritten.

/** Files that can name the SDK's URL: pages, scripts and import maps. */
export const SDK_REFERENCE_FILE = /\.(?:html?|m?js|json)$/i;

/** `text` with every naru.pub/sdk/ URL on SDK_ORIGIN, or null if it has none. */
export function pointAtSdkHost(
  text: string,
  origin = process.env.SDK_ORIGIN,
): string | null {
  if (!origin) return null;
  const host = new URL(origin).host;
  let changed = false;
  const rewritten = text.replace(
    /(https?:)?\/\/naru\.pub\/sdk\//g,
    (_, scheme: string | undefined) => {
      changed = true;
      // A protocol-relative URL stays one; http becomes https.
      return `${scheme ? "https:" : ""}//${host}/sdk/`;
    },
  );
  return changed ? rewritten : null;
}

/**
 * The same for a file's bytes, whatever its encoding: the URL is ASCII, so
 * reading each byte as one character (latin1) and back changes nothing else.
 * Older pages are often EUC-KR, which a UTF-8 round trip would ruin.
 */
export function pointBytesAtSdkHost(
  bytes: Uint8Array,
  origin = process.env.SDK_ORIGIN,
): Buffer | null {
  const rewritten = pointAtSdkHost(
    Buffer.from(bytes).toString("latin1"),
    origin,
  );
  return rewritten === null ? null : Buffer.from(rewritten, "latin1");
}
