import { DataError } from "@/lib/site-data/validation";
import {
  StoreOwnershipError,
  StoreVerificationError,
} from "@/lib/payments/store/ledger";
import {
  claimAppleTransactions,
  claimPlayPurchase,
  supporterStatus,
  type SupporterStatus,
} from "@/lib/payments/store/sync";
import type { Store } from "@/lib/payments/store/products";
import type { AppUser } from "./tokens";

// The supporter plan in the apps: its state for the app's store, and the
// purchases the app hands over to be granted (lib/payments/store).

export function storeParam(value: string | null): Store {
  if (value === "apple" || value === "google") return value;
  throw new DataError(400, "알 수 없는 스토어입니다.");
}

export function appSupporter(user: AppUser, store: Store) {
  return supporterStatus(user.id, store);
}

async function claiming(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreOwnershipError)
      throw new DataError(409, error.message);
    if (error instanceof StoreVerificationError) {
      console.warn("[app-supporter] refused a purchase:", error.message);
      throw new DataError(400, "구매 내역을 확인하지 못했습니다.");
    }
    throw error;
  }
}

const MAX_TRANSACTIONS = 20;

export async function claimApplePurchases(
  user: AppUser,
  body: unknown,
): Promise<SupporterStatus> {
  const items = (body as { transactions?: unknown })?.transactions;
  if (
    !Array.isArray(items) ||
    items.length > MAX_TRANSACTIONS ||
    !items.every(
      (item) =>
        typeof item?.transaction === "string" &&
        item.transaction.length < 20_000 &&
        (item.renewalInfo == null ||
          (typeof item.renewalInfo === "string" &&
            item.renewalInfo.length < 20_000)),
    )
  )
    throw new DataError(400, "구매 내역을 읽지 못했습니다.");
  await claiming(() => claimAppleTransactions(user.id, items));
  return supporterStatus(user.id, "apple");
}

export async function claimGooglePurchase(
  user: AppUser,
  body: unknown,
): Promise<SupporterStatus> {
  const token = (body as { purchaseToken?: unknown })?.purchaseToken;
  if (typeof token !== "string" || !token || token.length > 1000)
    throw new DataError(400, "구매 내역을 읽지 못했습니다.");
  await claiming(() => claimPlayPurchase(user.id, token));
  return supporterStatus(user.id, "google");
}
