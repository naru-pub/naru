import { describe, expect, test, vi } from "vitest";
import {
  collectDump,
  dumpLines,
  DumpFormatError,
  legacyDumpLines,
  LineSplitter,
  lines,
} from "../../control-plane/src/lib/site-data/dump-format";
import {
  dumpStream,
  gunzip,
  gzip,
  LineBuffer,
  PartPacker,
  uploadDump,
  type DumpBucket,
} from "./dump";

const encoder = new TextEncoder();
/** `text`'s bytes, cut at each of `cuts` (byte offsets). */
function cut(text: string, cuts: number[]) {
  const bytes = encoder.encode(text);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const offset of [...cuts, bytes.byteLength]) {
    pieces.push(bytes.subarray(at, offset));
    at = offset;
  }
  return pieces;
}
async function* from(pieces: Uint8Array[]) {
  for (const piece of pieces) yield piece;
}
const streamOf = (pieces: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
const ndjson = (...values: unknown[]) =>
  values.map((value) => `${JSON.stringify(value)}\n`).join("");
const header = { type: "header", version: 2, schema: ["CREATE TABLE t (x)"] };
const row = (x: unknown, table = "site:t") => ({
  type: "row",
  table,
  row: { x },
});
const collect = async <T>(source: AsyncIterable<T>) => {
  const all: T[] = [];
  for await (const value of source) all.push(value);
  return all;
};

describe("the dump's line reader", () => {
  test("joins a line that spans chunks, at every byte", async () => {
    const text = "first line\nsecond, longer line\n\nthird";
    for (let at = 0; at <= encoder.encode(text).byteLength; at++)
      expect(await collect(lines(from(cut(text, [at]))))).toEqual([
        "first line",
        "second, longer line",
        "",
        "third",
      ]);
  });

  test("keeps a multibyte character whose bytes are split across chunks", async () => {
    // 한 is three bytes, 😀 four: cut inside each.
    const text = "가한\n😀x\n";
    const bytes = encoder.encode(text).byteLength;
    for (let a = 0; a <= bytes; a++)
      for (let b = a; b <= bytes; b++)
        expect(await collect(lines(from(cut(text, [a, b]))))).toEqual([
          "가한",
          "😀x",
        ]);
    // One byte a chunk, from a stream.
    const single = [...encoder.encode(text)].map((byte) => Uint8Array.of(byte));
    expect(await collect(lines(streamOf(single)))).toEqual(["가한", "😀x"]);
  });

  test("refuses bytes that are not UTF-8, and a line too long", () => {
    expect(() => new LineSplitter().push(Uint8Array.of(0xff, 0x0a))).toThrow(
      DumpFormatError,
    );
    const short = new LineSplitter(4);
    expect(short.push(encoder.encode("abcd\n"))).toEqual(["abcd"]);
    expect(() => short.push(encoder.encode("abc"))).not.toThrow();
    expect(() => short.push(encoder.encode("de"))).toThrow(/too long/);
  });

  test("reads a whole dump, rows in order", async () => {
    const text = ndjson(
      header,
      row(1),
      row({ $base64: "AAE=" }),
      row("한글", "meta"),
      { type: "end", rows: 3 },
    );
    const dump = await collectDump(streamOf(cut(text, [7, 40, 41])));
    expect(dump).toEqual({
      schema: header.schema,
      tables: {
        "site:t": [{ x: 1 }, { x: { $base64: "AAE=" } }],
        meta: [{ x: "한글" }],
      },
      rows: 3,
    });
  });

  test("refuses a dump without its end line, and only once it ends", async () => {
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const { line } of dumpLines(
        streamOf(cut(ndjson(header, row(1), row(2)), [])),
      ))
        seen.push(line);
    })();
    await expect(reading).rejects.toThrow(/incomplete/);
    // Every row came before the refusal: it is the caller's to discard them.
    expect(seen).toHaveLength(3);
  });

  test("refuses an end line with the wrong count, lines after it, and a dump that does not start with its header", async () => {
    const refused = (text: string) =>
      collectDump(streamOf([encoder.encode(text)]));
    await expect(
      refused(ndjson(header, row(1), { type: "end", rows: 2 })),
    ).rejects.toThrow(/ends after 1 rows, but says it has 2/);
    await expect(
      refused(ndjson(header, { type: "end", rows: 0 }, row(1))),
    ).rejects.toThrow(/after its end line/);
    await expect(
      refused(ndjson(row(1), { type: "end", rows: 1 })),
    ).rejects.toThrow(/header/);
    await expect(
      refused(ndjson({ ...header, version: 1 }, { type: "end", rows: 0 })),
    ).rejects.toThrow(/header/);
    await expect(refused("")).rejects.toThrow(/empty/);
    await expect(refused(`${ndjson(header)}{"type":"row"`)).rejects.toThrow(
      /not JSON/,
    );
    await expect(
      refused(ndjson(header, { type: "row", table: "t", row: { x: [1] } })),
    ).rejects.toThrow(/not a row/);
  });

  test("stops reading a stream it refuses", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("not a dump\n"));
      },
      cancel,
    });
    await expect(collectDump(stream)).rejects.toThrow(DumpFormatError);
    expect(cancel).toHaveBeenCalled();
  });

  test("reads a dump in the format before NDJSON as the lines it would be now", () => {
    const lines = [
      ...legacyDumpLines({
        tables: { meta: [{ key: "a", value: "1" }], documents: [] },
        site: {
          schema: ["CREATE TABLE t (x)"],
          tables: { t: [{ x: 1 }] },
          migrations: [{ name: "0001.sql" }],
          roles: [{ member: "m" }],
        },
      }),
    ].map((entry) => entry.line);
    expect(lines).toEqual([
      header,
      { type: "row", table: "meta", row: { key: "a", value: "1" } },
      row(1),
      { type: "row", table: "_naru_migrations", row: { name: "0001.sql" } },
      { type: "row", table: "_naru_roles", row: { member: "m" } },
    ]);
    // From before site tables: no schema, nothing of the site's.
    expect([...legacyDumpLines({ tables: { meta: [] } })]).toEqual([
      { line: { ...header, schema: [] }, length: 0 },
    ]);
    expect(() => [...legacyDumpLines({} as never)]).toThrow(DumpFormatError);
  });
});

describe("the dump's writer", () => {
  test("cuts bytes into parts of exactly one size, and the rest", () => {
    const packer = new PartPacker(4);
    expect(packer.push(Uint8Array.of(1, 2, 3))).toEqual([]);
    expect(packer.push(Uint8Array.of(4, 5, 6, 7, 8, 9, 10, 11, 12))).toEqual([
      Uint8Array.of(1, 2, 3, 4),
      Uint8Array.of(5, 6, 7, 8),
      Uint8Array.of(9, 10, 11, 12),
    ]);
    expect(packer.push(Uint8Array.of(13))).toEqual([]);
    expect(packer.rest()).toEqual(Uint8Array.of(13));
    expect(packer.rest()).toEqual(new Uint8Array(0));
  });

  /** A bucket that keeps what was put and each multipart upload's parts. */
  function bucket(fail?: (part: number) => boolean) {
    const puts: Record<string, Uint8Array | string> = {};
    const uploads: {
      key: string;
      parts: Uint8Array[];
      completed: boolean;
      aborted: boolean;
    }[] = [];
    const store: DumpBucket = {
      put: async (key, value) => {
        puts[key] = value;
      },
      createMultipartUpload: async (key) => {
        const upload = {
          key,
          parts: [] as Uint8Array[],
          completed: false,
          aborted: false,
        };
        uploads.push(upload);
        return {
          uploadPart: async (partNumber, value) => {
            if (fail?.(partNumber)) throw new Error("R2 refused a part.");
            upload.parts[partNumber - 1] = value.slice();
            return { partNumber, etag: `e${partNumber}` };
          },
          complete: async (parts) => {
            expect(parts.map((part) => part.partNumber)).toEqual(
              upload.parts.map((_, i) => i + 1),
            );
            upload.completed = true;
          },
          abort: async () => {
            upload.aborted = true;
          },
        };
      },
    };
    return { store, puts, uploads };
  }
  const pieces = (sizes: number[]) =>
    sizes.map((size, n) => new Uint8Array(size).fill(n + 1));

  test("puts a dump smaller than a part at once", async () => {
    const { store, puts, uploads } = bucket();
    expect(await uploadDump(store, "k", from(pieces([3, 4])), 10)).toBe(7);
    expect(uploads).toEqual([]);
    expect(puts.k).toEqual(Uint8Array.of(1, 1, 1, 2, 2, 2, 2));
  });

  test("uploads a larger one in equal parts and a shorter last", async () => {
    const { store, puts, uploads } = bucket();
    expect(await uploadDump(store, "k", from(pieces([7, 9, 2])), 5)).toBe(18);
    expect(puts).toEqual({});
    expect(uploads).toHaveLength(1);
    expect(uploads[0].parts.map((part) => part.byteLength)).toEqual([
      5, 5, 5, 3,
    ]);
    expect(uploads[0].completed).toBe(true);
    const joined = new Uint8Array(18);
    let at = 0;
    for (const part of uploads[0].parts) {
      joined.set(part, at);
      at += part.byteLength;
    }
    expect([...joined]).toEqual([
      ...new Array(7).fill(1),
      ...new Array(9).fill(2),
      ...new Array(2).fill(3),
    ]);
    // A dump of exactly two parts has no empty last one.
    const exact = bucket();
    await uploadDump(exact.store, "k", from(pieces([10])), 5);
    expect(exact.uploads[0].parts.map((part) => part.byteLength)).toEqual([
      5, 5,
    ]);
  });

  test("aborts the upload when a part fails, or the dump does", async () => {
    const failing = bucket((part) => part === 2);
    await expect(
      uploadDump(failing.store, "k", from(pieces([12])), 5),
    ).rejects.toThrow("R2 refused a part.");
    expect(failing.uploads[0]).toMatchObject({
      completed: false,
      aborted: true,
    });
    const broken = bucket();
    async function* breaking() {
      yield new Uint8Array(6);
      throw new Error("The snapshot is gone.");
    }
    await expect(uploadDump(broken.store, "k", breaking(), 5)).rejects.toThrow(
      "The snapshot is gone.",
    );
    expect(broken.uploads[0].aborted).toBe(true);
    expect(broken.puts).toEqual({});
  });

  test("gzips a dump into parts of one size, typed and not encoded, that read back whole", async () => {
    const { store, uploads } = bucket();
    const options: unknown[] = [];
    const typed: DumpBucket = {
      ...store,
      createMultipartUpload: async (key, given) => {
        options.push(given);
        return store.createMultipartUpload(key);
      },
    };
    // Random bytes, which do not compress: several 64 KiB parts' worth.
    const source = Array.from({ length: 40 }, () => {
      const piece = new Uint8Array(8 * 1024);
      crypto.getRandomValues(piece);
      return piece;
    });
    const total = source.reduce((n, piece) => n + piece.byteLength, 0);
    const written = await uploadDump(
      typed,
      "k.ndjson.gz",
      gzip(from(source)),
      64 * 1024,
      "application/gzip",
    );
    expect(options).toEqual([
      { httpMetadata: { contentType: "application/gzip" } },
    ]);
    const parts = uploads[0].parts;
    expect(parts.length).toBeGreaterThan(2);
    expect(
      parts.slice(0, -1).every((part) => part.byteLength === 64 * 1024),
    ).toBe(true);
    expect(written).toBe(parts.reduce((n, part) => n + part.byteLength, 0));
    const compressed = new Blob(parts).stream();
    const back: Uint8Array[] = [];
    for await (const chunk of gunzip(compressed, () => new Error("bad")))
      back.push(chunk);
    const joined = new Uint8Array(await new Blob(back).arrayBuffer());
    expect(joined.byteLength).toBe(total);
    expect(joined).toEqual(
      new Uint8Array(await new Blob(source).arrayBuffer()),
    );
  });

  test("a gzip file cut short fails as not whole", async () => {
    const parts: Uint8Array[] = [];
    for await (const chunk of gzip(
      from([new TextEncoder().encode('{"type":"header"}\n'.repeat(1000))]),
    ))
      parts.push(chunk);
    const whole = new Uint8Array(await new Blob(parts).arrayBuffer());
    const cut = new Blob([whole.slice(0, whole.byteLength - 12)]).stream();
    await expect(
      (async () => {
        for await (const _ of gunzip(
          cut,
          () => new DumpFormatError("not whole"),
        ));
      })(),
    ).rejects.toThrow("not whole");
  });

  test("collects lines and hands them on as bytes", () => {
    const buffer = new LineBuffer();
    buffer.add(header);
    buffer.add(row("한"));
    expect(buffer.size).toBe(ndjson(header, row("한")).length);
    expect(new TextDecoder().decode(buffer.take())).toBe(
      ndjson(header, row("한")),
    );
    expect(buffer.size).toBe(0);
  });

  test("streams a dump, ending it once however it ends", async () => {
    async function* parts() {
      yield encoder.encode("a\n");
      yield encoder.encode("b\n");
    }
    const read = vi.fn();
    expect(await new Response(dumpStream(parts(), read)).text()).toBe("a\nb\n");
    expect(read).toHaveBeenCalledTimes(1);

    const canceled = vi.fn();
    const stream = dumpStream(parts(), canceled);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(canceled).toHaveBeenCalledTimes(1);

    const failed = vi.fn();
    async function* failing() {
      yield encoder.encode("a\n");
      throw new Error("no");
    }
    await expect(
      new Response(dumpStream(failing(), failed)).text(),
    ).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  test("gives up a dump left unread", async () => {
    vi.useFakeTimers();
    try {
      const left = vi.fn();
      async function* parts() {
        yield encoder.encode("a\n");
        yield encoder.encode("b\n");
      }
      const reader = dumpStream(parts(), left, 1000).getReader();
      expect((await reader.read()).done).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(left).toHaveBeenCalledTimes(1);
      await expect(reader.read()).rejects.toThrow(/unread/);
    } finally {
      vi.useRealTimers();
    }
  });
});
