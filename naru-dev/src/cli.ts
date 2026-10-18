// naru-dev [site folder] [--site name] [--port 4000] [--state dir] [--quiet]
//
// Serves the site on http://localhost:<port> until stopped (Ctrl-C), with its
// data in <site folder>/.naru-dev/ unless --state says otherwise. The
// package's command (bin.ts) and a Naru checkout's `pnpm naru-dev`
// (control-plane/scripts/naru-dev.mts) both run this.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { start, type Resources } from "./naru";

/** What the running naru-dev is: printed first, and by --version. */
export interface Info {
  version: string;
  /** The naru-pub commit it was built from. */
  commit: string;
}

const HELP = `Usage: naru-dev [site folder] [options]

Serves a Naru site locally: its pages, the Data SDK, _naru/ (migrations,
queries, mutations, routes) on the real edge Worker, one-click owner and
member sign-in, and uploads.

Options:
  --site <name>   the site's Naru name (<name>.naru.pub); default localsite
  --port <port>   default 4000; 0 picks a free one
  --state <dir>   where data is kept; default <site folder>/.naru-dev
  --quiet         print only the address
  --version       print the version and exit
  --help          print this and exit
`;

export async function main(
  argv: string[],
  resources: Resources,
  info: Info,
): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args.splice(index, 1), true) : false;
  };
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${name} needs a value.`);
    return args.splice(index, 2)[1];
  };
  const sdk = readdirSync(resources.sdkDir)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort();
  const banner = `@naru-pub/dev ${info.version} (naru-pub ${info.commit}), SDK ${sdk.join(", ")}`;
  try {
    if (flag("--help") || flag("-h")) {
      console.log(HELP);
      return 0;
    }
    if (flag("--version") || flag("-v")) {
      console.log(banner);
      return 0;
    }
    const quiet = flag("--quiet");
    const port = Number(option("--port") ?? 4000);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new UsageError("--port takes a port number.");
    const name = option("--site");
    if (name !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
      throw new UsageError(
        "--site takes a Naru login name: lowercase letters, digits, hyphens.",
      );
    const stateOption = option("--state");
    const unknown = args.find((arg) => arg.startsWith("-"));
    if (unknown) throw new UsageError(`Unknown option ${unknown}.`);
    if (args.length > 1) throw new UsageError("Give one site folder.");
    const folder = resolve(args[0] ?? ".");
    if (!quiet) console.log(banner);
    const naru = await start(
      {
        site: folder,
        name,
        port,
        state: stateOption ? resolve(stateOption) : join(folder, ".naru-dev"),
        quiet,
      },
      resources,
    );
    if (quiet) console.log(naru.origin);
    await new Promise<void>((done) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void naru.stop().then(done);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`naru-dev: ${error.message}\n\n${HELP}`);
      return 2;
    }
    console.error(`naru-dev: ${(error as Error).message}`);
    return 1;
  }
}

class UsageError extends Error {}
