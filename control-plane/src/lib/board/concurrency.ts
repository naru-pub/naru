// R2 copies run a few at a time: one at a time, a template of a few hundred
// files takes a minute to publish or apply; all at once, R2 throttles.
export const COPY_CONCURRENCY = 16;

/**
 * Runs `work` for every item, at most `limit` at once. After a failure no
 * further item starts, and the first error is thrown only once every running
 * one has settled, so a caller undoing the work knows nothing is still
 * landing behind it.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  limit = COPY_CONCURRENCY,
): Promise<void> {
  const state: { next: number; failure: { error: unknown } | null } = {
    next: 0,
    failure: null,
  };
  const worker = async () => {
    while (!state.failure && state.next < items.length) {
      const item = items[state.next++];
      try {
        await work(item);
      } catch (error) {
        state.failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (state.failure) throw state.failure.error;
}
