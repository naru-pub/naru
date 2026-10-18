import { db } from "@/lib/database";
import { renewingStoreSubscription } from "@/lib/payments/store/ledger";

// Deleting the account cannot stop an App Store subscription: only its
// subscriber can cancel it. A Play subscription's renewal 나루 switches off.
export default async function StoreDeletionNotice({
  userId,
}: {
  userId: string;
}) {
  const plan = await renewingStoreSubscription(db, userId);
  if (!plan) return null;
  return plan.store === "apple" ? (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      App Store에서 구독 중입니다. 계정을 삭제해도 구독은 해지되지 않으니,
      iPhone의 설정 앱에서 Apple 계정 → 구독으로 가서 먼저 해지해 주세요.
    </p>
  ) : (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      Google Play에서 구독 중입니다. 계정을 삭제하면 자동 갱신이 해지되고, 이미
      결제한 기간은 환불되지 않습니다.
    </p>
  );
}
