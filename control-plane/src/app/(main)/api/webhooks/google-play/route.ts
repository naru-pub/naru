import { NextRequest, NextResponse } from "next/server";
import { readCappedBody } from "@/lib/payments/toss-webhooks";
import { verifyPushAuthorization } from "@/lib/payments/store/google";
import { handlePlayNotification } from "@/lib/payments/store/notifications";

// Google Play Real-Time Developer Notifications, through an authenticated
// Pub/Sub push subscription. The message only names a purchase; what it is
// is asked of the Play Developer API.
export async function POST(request: NextRequest) {
  if (!(await verifyPushAuthorization(request.headers.get("authorization"))))
    return NextResponse.json({}, { status: 401 });
  const raw = await readCappedBody(request, 64 * 1024);
  if (raw === null) return NextResponse.json({}, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  const { status } = await handlePlayNotification(body);
  return NextResponse.json({ received: status < 500 }, { status });
}
