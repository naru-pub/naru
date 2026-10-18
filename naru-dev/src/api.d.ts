// @naru-pub/dev's public API: shipped as the package's types, and what
// src/naru.ts implements (it imports these), so the two cannot disagree.

export interface StartOptions {
  /** The site's folder: its pages, and `_naru/` if it has one. */
  site: string;
  /**
   * The site's Naru name, as in `<name>.naru.pub`: lowercase letters, digits
   * and hyphens. Default `localsite`.
   */
  name?: string;
  /** The port to serve on; 0 (the default) picks a free one. */
  port?: number;
  /**
   * Where data, uploads and sign-ins are kept. Default: a new temporary
   * folder, removed by `stop()`. The CLI keeps them in `<site>/.naru-dev/`.
   */
  state?: string;
  /** Print nothing; `log` still has everything. */
  quiet?: boolean;
}

/** Who signs in: the site's owner, or a test member by name. */
export type Who = "owner" | (string & {});

export interface SignInOptions {
  /** A member's status, kept for later sign-ins too. Default `approved`. */
  status?: "approved" | "pending" | "banned";
  /**
   * The owner's: collections to make private if missing, as Naru's sign-in
   * page does for the collections a page asks for.
   */
  collections?: string[];
}

/** A sign-in, as the SDK keeps it, and a header for your own requests. */
export interface Credentials {
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** A member's id; absent for the owner. */
  memberId?: string;
  /** `{ authorization: "Bearer <accessToken>" }`, for fetch. */
  headers: { authorization: string };
}

/**
 * What `signIn` needs of a Playwright `Page` or `BrowserContext` (or any
 * browser driver with the same methods).
 */
export interface BrowserTarget {
  addInitScript(script: string): Promise<unknown>;
  evaluate?(expression: string): Promise<unknown>;
  url?(): string;
}

export interface Naru {
  /** Where the site is served, such as `http://localhost:4000`. */
  readonly origin: string;
  /** The site's Naru name. */
  readonly name: string;
  /** The folder data is kept in. */
  readonly state: string;
  /** Everything printed so far, printed or not (`quiet`). */
  readonly log: string;
  /** `origin` + `path`. */
  url(path?: string): string;
  /**
   * Signs `who` in. Given a page or browser context, its pages on this
   * origin find the session where the SDK keeps it, from their next
   * navigation (and at once, for a page already here). Returns the
   * credentials either way, usable with fetch through `headers`.
   */
  signIn(
    target: BrowserTarget | null | undefined,
    who: Who,
    options?: SignInOptions,
  ): Promise<Credentials>;
  /**
   * Empties the site: its collections, tables and uploads. `_naru/` is
   * published again, its migrations applied to the empty database; members
   * and sign-ins are kept.
   */
  reset(): Promise<void>;
  /** Stops the servers; removes `state` if `startNaru` made it. */
  stop(): Promise<void>;
}

/** Serves `options.site` on a local Naru; resolves once it answers. */
export function startNaru(options: StartOptions): Promise<Naru>;
