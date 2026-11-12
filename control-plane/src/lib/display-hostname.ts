// Hostnames are stored and sent to Cloudflare and DNS in their ASCII form
// (xn--3l3bz7e1zj.love), but people read them as they typed them
// (지새벽.love). Display only: DNS record names stay ASCII, which is what
// registrars and Cloudflare expect.
//
// A Punycode (RFC 3492) decoder small enough to run in client components,
// where node:url's domainToUnicode isn't available.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, firstTime: boolean) {
  delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

function digit(code: number) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26; // 0-9
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  return BASE;
}

/** Decodes one Punycode label (without "xn--"), or null if it's malformed. */
function decodeLabel(input: string): string | null {
  const output: number[] = [];
  const basicEnd = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basicEnd, 0); j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }

  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length;) {
    const oldI = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const d = digit(input.charCodeAt(index++));
      if (d >= BASE) return null;
      i += d * w;
      if (!Number.isSafeInteger(i)) return null;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    n += Math.floor(i / length);
    if (n > 0x10ffff) return null;
    i %= length;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** A hostname as people read it: each xn-- label decoded to Unicode. */
export function displayHostname(hostname: string) {
  return hostname
    .split(".")
    .map((label) =>
      label.toLowerCase().startsWith("xn--")
        ? (decodeLabel(label.slice(4)) ?? label)
        : label,
    )
    .join(".");
}

/** A URL's text as people read it: its host in Unicode, the rest as is. */
export function displayUrl(url: string) {
  return url.replace(
    /^(https?:\/\/)?([^/?#:]+)/i,
    (_, scheme: string | undefined, host: string) =>
      (scheme ?? "") + displayHostname(host),
  );
}
