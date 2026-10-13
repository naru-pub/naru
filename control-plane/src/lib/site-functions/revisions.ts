import { createHash, randomUUID } from "node:crypto";
import { DataError } from "../site-data/validation";
import {
  loadModuleGraph,
  modulePath,
  moduleImports,
  readOnlyExports,
  MAX_MODULE_BYTES,
  type ModuleSources,
} from "./modules";
/** Minimal object storage contract shared by the S3 publisher and R2 reader. */
export interface RevisionBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string; etag: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(
    key: string,
  ): Promise<{ etag: string; size: number; text(): Promise<string> } | null>;
  put(
    key: string,
    source: string,
    options?: { onlyIf: { etagDoesNotMatch: string } },
  ): Promise<unknown>;
}
const MAX_FILES = 256,
  MAX_REVISION_BYTES = 4 * 1024 * 1024,
  CACHE_BYTES = 8 * 1024 * 1024;
type Manifest = {
  version: 2;
  publication: string;
  files: Record<string, string>;
  /** Each functions module's read-only exports, when it declares any. */
  readOnly?: Record<string, string[]>;
};
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const conflict = () =>
  new DataError(
    409,
    "Function files changed while publishing. Retry the update.",
    "CONFLICT",
  );
/** Immutable module snapshots. Mutable working files are never fetched during execution. */
export class FunctionRevisions {
  private manifests = new Map<string, Manifest>();
  private sources = new Map<string, string>();
  private dependencies = new Map<string, string[]>();
  private bytes = 0;
  constructor(
    private bucket: RevisionBucket,
    private site: string,
  ) {}
  private key(revision: string, path: string) {
    return `_naru-runtime/${this.site}/revisions/${revision}/${path}`;
  }
  private async files() {
    const files: Array<{ path: string; key: string; etag: string }> = [];
    for (const folder of ["functions", "modules", "rules"]) {
      const prefix = `${this.site}/_naru/${folder}/`;
      let cursor: string | undefined;
      do {
        const page = await this.bucket.list({ prefix, cursor });
        for (const object of page.objects)
          if (/\.m?js$/.test(object.key)) {
            if (object.size > MAX_MODULE_BYTES)
              throw new DataError(400, "Function module exceeds 256 KiB.");
            files.push({
              path: modulePath(`${folder}/${object.key.slice(prefix.length)}`),
              key: object.key,
              etag: object.etag,
            });
            if (files.length > MAX_FILES)
              throw new DataError(
                400,
                "A function revision supports at most 256 files.",
              );
          }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async publish(): Promise<string> {
    const files = await this.files(),
      sources: ModuleSources = Object.create(null),
      digests: Record<string, string> = Object.create(null);
    let bytes = 0;
    for (let offset = 0; offset < files.length; offset += 16) {
      const batch = await Promise.all(
        files.slice(offset, offset + 16).map(async (file) => {
          const object = await this.bucket.get(file.key);
          if (!object || object.etag !== file.etag) throw conflict();
          return { file, source: await object.text() };
        }),
      );
      for (const { file, source } of batch) {
        const size = new TextEncoder().encode(source).byteLength;
        if (size > MAX_MODULE_BYTES)
          throw new DataError(400, "Function module exceeds 256 KiB.");
        bytes += size;
        if (bytes > MAX_REVISION_BYTES)
          throw new DataError(400, "Function revision exceeds 4 MiB.");
        sources[file.path] = source;
        digests[file.path] = hash(source);
      }
    }
    for (const filename of Object.keys(sources))
      if (
        filename.endsWith(".mjs") &&
        Object.hasOwn(sources, filename.slice(0, -4) + ".js")
      )
        throw new DataError(
          400,
          `Both _naru/${filename.slice(0, -4)}.js and .mjs exist; keep one.`,
        );
    for (const [filename, source] of Object.entries(sources))
      for (const dependency of moduleImports(source, filename)) {
        if (!Object.hasOwn(sources, dependency))
          throw new DataError(
            400,
            `Missing import ${dependency} in ${filename}.`,
          );
      }
    const readOnly: Record<string, string[]> = Object.create(null);
    for (const [filename, source] of Object.entries(sources))
      if (filename.startsWith("functions/")) {
        const names = readOnlyExports(source, filename);
        if (names.length) readOnly[filename] = names;
      }
    if (JSON.stringify(files) !== JSON.stringify(await this.files()))
      throw conflict();
    const manifest: Manifest = {
      version: 2,
      publication: randomUUID(),
      files: digests,
      ...(Object.keys(readOnly).length ? { readOnly } : {}),
    };
    const body = JSON.stringify(manifest),
      revision = hash(body);
    const entries = Object.entries(sources);
    for (let offset = 0; offset < entries.length; offset += 16)
      await Promise.all(
        entries.slice(offset, offset + 16).map(([filename, source]) =>
          this.bucket.put(this.key(revision, filename), source, {
            onlyIf: { etagDoesNotMatch: "*" },
          }),
        ),
      );
    await this.bucket.put(this.key(revision, "manifest.json"), body, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    this.manifests.set(revision, manifest);
    if (this.manifests.size > 4)
      this.manifests.delete(this.manifests.keys().next().value!);
    return revision;
  }
  private async manifest(revision: string): Promise<Manifest> {
    if (!/^[a-f0-9]{64}$/.test(revision))
      throw new DataError(503, "Invalid function revision.");
    const cached = this.manifests.get(revision);
    if (cached) return cached;
    const object = await this.bucket.get(this.key(revision, "manifest.json"));
    if (!object) throw new DataError(503, "Function revision is unavailable.");
    if (object.size > 256 * 1024)
      throw new DataError(503, "Invalid function manifest.");
    const body = await object.text();
    if (hash(body) !== revision)
      throw new DataError(
        503,
        "Function manifest failed integrity verification.",
      );
    const manifest = JSON.parse(body) as Manifest;
    if (
      manifest.version !== 2 ||
      typeof manifest.publication !== "string" ||
      !manifest.files ||
      Object.keys(manifest.files).length > MAX_FILES
    )
      throw new DataError(503, "Invalid function manifest.");
    for (const [filename, digest] of Object.entries(manifest.files))
      if (modulePath(filename) !== filename || !/^[a-f0-9]{64}$/.test(digest))
        throw new DataError(503, "Invalid function manifest.");
    for (const [filename, names] of Object.entries(manifest.readOnly ?? {}))
      if (
        !Object.hasOwn(manifest.files, filename) ||
        !Array.isArray(names) ||
        names.some((name) => typeof name !== "string")
      )
        throw new DataError(503, "Invalid function manifest.");
    this.manifests.set(revision, manifest);
    if (this.manifests.size > 4)
      this.manifests.delete(this.manifests.keys().next().value!);
    return manifest;
  }
  /**
   * The published file for `path` without its extension, such as
   * `functions/shop`: `.js`, or `.mjs` when that is what the site has.
   */
  async entry(revision: string, path: string) {
    const manifest = await this.manifest(revision);
    return Object.hasOwn(manifest.files, `${path}.mjs`)
      ? `${path}.mjs`
      : `${path}.js`;
  }
  /** Whether `entry`'s export `name` is declared read-only. */
  async isReadOnly(revision: string, entry: string, name: string) {
    const manifest = await this.manifest(revision);
    return manifest.readOnly?.[entry]?.includes(name) ?? false;
  }
  async graph(revision: string, entry: string): Promise<ModuleSources> {
    const manifest = await this.manifest(revision);
    if (!Object.hasOwn(manifest.files, entry))
      throw new DataError(404, `This site has no _naru/${entry}.`);
    return loadModuleGraph(
      entry,
      async (filename) => {
        const digest = manifest.files[filename];
        if (!digest) return null;
        const cached = this.sources.get(digest);
        if (cached !== undefined) {
          this.sources.delete(digest);
          this.sources.set(digest, cached);
          return cached;
        }
        const object = await this.bucket.get(this.key(revision, filename));
        if (!object)
          throw new DataError(503, "Function module is unavailable.");
        if (object.size > MAX_MODULE_BYTES)
          throw new DataError(503, "Invalid function module.");
        const source = await object.text();
        if (hash(source) !== digest)
          throw new DataError(
            503,
            "Function module failed integrity verification.",
          );
        const size = new TextEncoder().encode(source).byteLength;
        this.sources.set(digest, source);
        this.bytes += size;
        while (this.bytes > CACHE_BYTES || this.sources.size > 256) {
          const first = this.sources.keys().next().value!;
          this.bytes -= new TextEncoder().encode(
            this.sources.get(first)!,
          ).byteLength;
          this.sources.delete(first);
        }
        return source;
      },
      (source, filename) => {
        const key = `${filename}:${manifest.files[filename]}`;
        let dependencies = this.dependencies.get(key);
        if (!dependencies) {
          dependencies = moduleImports(source, filename);
          this.dependencies.set(key, dependencies);
          if (this.dependencies.size > 256)
            this.dependencies.delete(this.dependencies.keys().next().value!);
        }
        return dependencies;
      },
    );
  }
}
