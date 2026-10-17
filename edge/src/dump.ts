// Writing a site's dump (control-plane/src/lib/site-data/dump-format.ts) a
// part at a time: SiteData (site.ts) reads its snapshot tables a page at a
// time and hands each page's lines here as bytes, which go to R2 in parts
// (`uploadDump`) or out as a stream (`dumpStream`). Nothing here holds more
// than about one part.

/** R2's least part but the last: every part but the last is this size. */
export const PART_BYTES = 5 * 1024 * 1024;

/** How a dump is stored: its type, and never a Content-Encoding. */
export type DumpObjectOptions = { httpMetadata?: { contentType?: string } };

/** The part of a bucket a dump is written through: R2's binding, or r2-s3.ts. */
export interface DumpBucket {
  put(
    key: string,
    value: string | Uint8Array,
    options?: DumpObjectOptions,
  ): Promise<unknown>;
  createMultipartUpload(
    key: string,
    options?: DumpObjectOptions,
  ): Promise<{
    uploadPart(
      partNumber: number,
      value: Uint8Array,
    ): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
    abort(): Promise<void>;
  }>;
}

/**
 * Cuts a stream of byte pieces into parts of exactly `size` bytes (R2 wants
 * every part but the last the same size), and the rest.
 */
export class PartPacker {
  private pieces: Uint8Array[] = [];
  private length = 0;
  constructor(private size = PART_BYTES) {}

  /** The whole parts that `bytes` completes. */
  push(bytes: Uint8Array): Uint8Array[] {
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(this.size - this.length, bytes.byteLength - offset);
      this.pieces.push(bytes.subarray(offset, offset + take));
      this.length += take;
      offset += take;
      if (this.length === this.size) parts.push(this.drain());
    }
    return parts;
  }

  /** What is left: the last part, shorter than the rest (maybe empty). */
  rest(): Uint8Array {
    return this.drain();
  }

  private drain() {
    const part = new Uint8Array(this.length);
    let at = 0;
    for (const piece of this.pieces) {
      part.set(piece, at);
      at += piece.byteLength;
    }
    this.pieces = [];
    this.length = 0;
    return part;
  }
}

/**
 * Writes `source` to `key`: one put when it is smaller than a part, else a
 * multipart upload begun once the first part is full, aborted if anything
 * fails. Returns the bytes written.
 */
export async function uploadDump(
  bucket: DumpBucket,
  key: string,
  source: AsyncIterable<Uint8Array>,
  partBytes = PART_BYTES,
  contentType?: string,
): Promise<number> {
  const options: DumpObjectOptions | undefined = contentType
    ? { httpMetadata: { contentType } }
    : undefined;
  const packer = new PartPacker(partBytes);
  let upload: Awaited<ReturnType<DumpBucket["createMultipartUpload"]>> | null =
    null;
  const parts: { partNumber: number; etag: string }[] = [];
  let bytes = 0;
  try {
    for await (const piece of source) {
      bytes += piece.byteLength;
      for (const part of packer.push(piece)) {
        upload ??= await bucket.createMultipartUpload(key, options);
        parts.push(await upload.uploadPart(parts.length + 1, part));
      }
    }
    const last = packer.rest();
    if (!upload) {
      await bucket.put(key, last, options);
      return bytes;
    }
    if (last.byteLength)
      parts.push(await upload.uploadPart(parts.length + 1, last));
    await upload.complete(parts);
    return bytes;
  } catch (error) {
    if (upload) await upload.abort().catch(() => {});
    throw error;
  }
}

/** A stream's chunks, as an iterable; leaving early cancels the stream. */
async function* chunksOf(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}

/** `source` as a stream, read as the stream is pulled. */
function streamOf(source: AsyncIterable<Uint8Array>) {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * `source` gzip-compressed (CompressionStream, in workerd and on
 * Cloudflare alike), read a piece at a time: what restore points are
 * written as.
 */
export function gzip(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return chunksOf(
    streamOf(source).pipeThrough(
      new CompressionStream("gzip") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    ),
  );
}

/**
 * A gzip file's bytes, decompressed as they are read. A file that is not
 * whole gzip, cut short or corrupt, fails as `invalid` says.
 */
export async function* gunzip(
  stream: ReadableStream<Uint8Array>,
  invalid: () => Error,
): AsyncGenerator<Uint8Array> {
  const decompressed = stream.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  try {
    yield* chunksOf(decompressed);
  } catch {
    throw invalid();
  }
}

/** How long a dump's reader may leave it unread before it is given up. */
export const DUMP_IDLE_MS = 5 * 60_000;

/**
 * `source` as a byte stream, read as its reader asks. `done` runs once,
 * however it ends: read to the end, failed, canceled by the reader, or left
 * unread for `idleMs`, so a reader that went away never holds the object's
 * dumps up for good.
 */
export function dumpStream(
  source: AsyncIterator<Uint8Array>,
  done: () => void,
  idleMs = DUMP_IDLE_MS,
): ReadableStream<Uint8Array> {
  let finished = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    clearTimeout(idle);
    if (finished) return;
    finished = true;
    done();
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const wait = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      finish();
      void source.return?.(undefined);
      controller.error(new Error("The dump was left unread."));
    }, idleMs);
  };
  return new ReadableStream<Uint8Array>({
    start(given) {
      controller = given;
      wait();
    },
    async pull(controller) {
      clearTimeout(idle);
      if (finished)
        return controller.error(new Error("The dump was left unread."));
      try {
        const next = await source.next();
        if (next.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
          wait();
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel() {
      try {
        await source.return?.();
      } finally {
        finish();
      }
    },
  });
}

/**
 * Lines collected into one string a page at a time, then encoded: what
 * SiteData yields per page of its snapshot.
 */
export class LineBuffer {
  private lines: string[] = [];
  private chars = 0;
  private encoder = new TextEncoder();
  add(value: unknown) {
    const line = `${JSON.stringify(value)}\n`;
    this.lines.push(line);
    this.chars += line.length;
  }
  get size() {
    return this.chars;
  }
  take(): Uint8Array {
    const bytes = this.encoder.encode(this.lines.join(""));
    this.lines = [];
    this.chars = 0;
    return bytes;
  }
}
