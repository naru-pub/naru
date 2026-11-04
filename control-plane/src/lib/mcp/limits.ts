// How much a Naru MCP connection may do. Any account may connect and change its
// site's files, by script as easily as by hand, so the limits are the account's
// (one account can make many connections), and tighter without a plan. Kept in
// memory: a release forgets them, which errs on letting work through. The caps
// on writes are soft, for the owner and the operator to hear of; only far past
// them is a write refused. The request rate is firm.
//
// The numbers leave room for building a site: of the sites without a plan, in
// November 2026, the 99th percentile held 67 MB and the largest 791 MB.

export const PLAN_REQUESTS_PER_MINUTE = 120;
export const FREE_REQUESTS_PER_MINUTE = 60;
export const FREE_WRITES_PER_DAY = 300;
export const FREE_WRITE_BYTES_PER_DAY = 100 * 1024 * 1024;
export const FREE_SITE_BYTES = 1024 * 1024 * 1024;
/** How far past a soft cap a write is still let through: stops a runaway. */
export const HARD_CAP_FACTOR = 10;

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PRUNE_ABOVE = 10_000;

const minutes = new Map<string, { start: number; count: number }>();
const days = new Map<
  string,
  { start: number; writes: number; bytes: number; over: boolean }
>();

function prune<T extends { start: number }>(
  windows: Map<string, T>,
  length: number,
  now: number,
) {
  if (windows.size <= PRUNE_ABOVE) return;
  for (const [id, window] of windows)
    if (now - window.start >= length) windows.delete(id);
}

/** Counts a request of the account's; whether it is past the minute's limit. */
export function overRequestLimit(
  userId: string,
  entitled: boolean,
  now = Date.now(),
) {
  prune(minutes, MINUTE, now);
  const window = minutes.get(userId);
  if (!window || now - window.start >= MINUTE) {
    minutes.set(userId, { start: now, count: 1 });
    return false;
  }
  window.count += 1;
  return (
    window.count >
    (entitled ? PLAN_REQUESTS_PER_MINUTE : FREE_REQUESTS_PER_MINUTE)
  );
}

export type FreeWrite =
  /** Refused: past HARD_CAP_FACTOR times a cap. Why, for the owner. */
  | { refused: string }
  /** `over` says which cap it is past; `crossed` when this write went past. */
  | { refused?: undefined; over: string | null; crossed: boolean };

/**
 * Counts a write of `bytes` by an account without a plan, given what its site
 * held at the last daily measure (`siteBytes`, which what it wrote since is
 * added to). The caps are soft: past one the write goes through, and says so.
 */
export function freeWrite(
  userId: string,
  bytes: number,
  siteBytes: number,
  now = Date.now(),
): FreeWrite {
  prune(days, DAY, now);
  let window = days.get(userId);
  if (!window || now - window.start >= DAY) {
    window = { start: now, writes: 0, bytes: 0, over: false };
    days.set(userId, window);
  }
  const site = siteBytes + window.bytes + bytes;
  const dayBytes = window.bytes + bytes;
  const writes = window.writes + 1;
  const past = (factor: number) =>
    site > FREE_SITE_BYTES * factor
      ? `The site is over ${(FREE_SITE_BYTES * factor) / GB} GB`
      : writes > FREE_WRITES_PER_DAY * factor
        ? `The site has written over ${FREE_WRITES_PER_DAY * factor} files through AI apps today`
        : dayBytes > FREE_WRITE_BYTES_PER_DAY * factor
          ? `The site has written over ${(FREE_WRITE_BYTES_PER_DAY * factor) / MB} MB through AI apps today`
          : null;
  const hard = past(HARD_CAP_FACTOR);
  if (hard) return { refused: `${hard}, so this write was refused.` };
  window.writes = writes;
  window.bytes = dayBytes;
  const over = past(1);
  const crossed = over !== null && !window.over;
  if (over) window.over = true;
  return { over, crossed };
}

/** For tests: forgets every account's counts. */
export function resetLimits() {
  minutes.clear();
  days.clear();
}
