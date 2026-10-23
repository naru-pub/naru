import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Reading an MCP app's Client ID Metadata Document (the MCP authorization
// spec, draft-ietf-oauth-client-id-metadata-document): the app's client_id
// is an https URL, and the document there names the app and the redirects it
// may use. The URL comes from whoever opens /mcp/authorize, so fetching it is
// a server-side request to an address someone else chose (the draft's §6.5,
// SSRF): only https on port 443, only public addresses, checked on the
// address the connection actually uses (so a name can't resolve to a public
// address when checked and a private one when connected), no redirects, and
// a small, quick answer.

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

/** Addresses no metadata document is fetched from. */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

/** Whether an address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, "ipv4");
  if (family !== 6) return false;
  // An IPv4-mapped address is the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return !PRIVATE.check(address, "ipv6");
}

/** Whether a client_id is a metadata document's URL rather than a registration. */
export function isMetadataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname !== "/" &&
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.port === "" || url.port === "443")
    );
  } catch {
    return false;
  }
}

// dns.lookup, refusing a name whose address isn't public: the connection
// uses the address this returns, so what's checked is what's reached.
const publicLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error, "", 0);
    if (!isPublicAddress(address as string))
      return callback(
        Object.assign(new Error(`${hostname} is not a public address`), {
          code: "EADDRNOTPUBLIC",
        }),
        "",
        0,
      );
    callback(null, address as string, family);
  });

/** The document at a metadata URL, parsed, or an Error saying why not. */
export function fetchMetadataDocument(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (isIP(target.hostname.replace(/^\[|\]$/g, "")))
      return reject(
        new Error("The client_id must name a host, not an address."),
      );
    const req = request(
      target,
      {
        method: "GET",
        lookup: publicLookup,
        timeout: TIMEOUT_MS,
        headers: { Accept: "application/json" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return reject(
            new Error(`The client metadata answered ${response.statusCode}.`),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("The client metadata is over 64 KiB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("The client metadata is not JSON."));
          }
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("The client metadata did not answer in time.")),
    );
    req.on("error", reject);
    req.end();
  });
}
