import { fedifyWith } from "@fedify/next";
import { federation } from "@/lib/federation";

const fedify = fedifyWith(federation)();

// The Data SDK lives only at sdk.naru.pub/sdk/ (lib/const.ts SDK_URL), served
// by workerd. Its committed files sit in public/sdk/ for the builds and tests
// that read them, which Next would otherwise serve here as well: answer every
// /sdk/ path with a plain 404 instead, before the public folder is consulted.
function sdkNotFound(pathname: string) {
  return pathname === "/sdk" || pathname.startsWith("/sdk/")
    ? new Response("Not found.", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      })
    : null;
}

export default async function proxy(request: Request) {
  return sdkNotFound(new URL(request.url).pathname) ?? (await fedify(request));
}

export const config = {
  matcher: [
    { source: "/sdk" },
    { source: "/sdk/:path*" },
    {
      source: "/:path*",
      has: [
        {
          type: "header",
          key: "Accept",
          value: ".*application\\/((jrd|activity|ld)\\+json|xrd\\+xml).*",
        },
      ],
    },
    {
      source: "/:path*",
      has: [
        {
          type: "header",
          key: "content-type",
          value: ".*application\\/((jrd|activity|ld)\\+json|xrd\\+xml).*",
        },
      ],
    },
    { source: "/.well-known/nodeinfo" },
    { source: "/.well-known/x-nodeinfo2" },
  ],
};
