import { NextRequest, NextResponse } from "next/server";
import { readCappedBody } from "@/lib/payments/toss-webhooks";
import { handleAppleNotification } from "@/lib/payments/store/notifications";

// App Store Server Notifications V2, set in App Store Connect for both the
// production and sandbox environments. Signed by Apple; checked in
// lib/payments/store/apple.
export async function POST(request: NextRequest) {
  const raw = await readCappedBody(request, 256 * 1024);
  if (raw === null) return NextResponse.json({}, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  const { status } = await handleAppleNotification(body);
  return NextResponse.json({ received: status < 500 }, { status });
}
