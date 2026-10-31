# Template marketplace

Authors can put a price on a template. Buyers pay through Toss, and
authors are paid out through Toss's 지급대행 (payouts) API
(<https://docs.tosspayments.com/guides/v2/payouts>). The code is in
`control-plane/src/lib/market/`.

## Money flow

1. **Price.** An author registers as a seller (`/account/market`), then sets
   a price on the template's edit page. Prices are 0 (free), or 1,000 to
   1,000,000 won in steps of 100 (`board_templates.price`).
2. **Purchase.** The buyer opens Toss's payment window on the **market MID**
   for an order 나루 created at the price it recorded
   (`POST /api/market/templates/:id/purchase`). Toss sends the buyer back to
   `/market/callback`, which hands the `paymentKey` to
   `POST /api/market/purchases/confirm`. An Absurd task
   (`confirm_template_purchase`, run by the payment worker) approves the
   payment for the recorded amount. Purchases are recorded in
   `template_purchases`, with 나루's fee (`MARKET_FEE_PERCENT`, 20%) fixed
   at order time. If two tabs' orders for the same template are approved
   at once, the second is refunded.
3. **Access.** A paid template can be applied, and updated to newer
   versions, by its author, its buyers, and anyone who applied it while it
   was free (`lib/market/access.ts`). A purchase stops counting once its
   refund is requested, and an application made under a purchase later
   refunded doesn't count either. The check runs in the board's apply,
   plan and update paths. Version files (`_templates/<id>/v<n>/…`) are
   stored in the private bucket (`lib/site-code-bucket.ts`), so they can't
   be fetched from `r2.<domain>`. Preview images stay public. Once a
   template has buyers, its author can't delete its post, since that would
   take what they paid for; only a board admin can take it down. An
   author who deletes their account takes their templates with them; the
   purchases stay on record by title (`template_id` becomes null).
4. **Refund.** A buyer can request a refund within `REFUND_WINDOW_DAYS` (7)
   days, as long as they have not applied the template and it has not been
   paid out. Digital content that has been used can't be withdrawn
   (전자상거래법 제17조 제2항 제5호). The `refund_template_purchase` task
   cancels the payment. A refund made from the Toss dashboard arrives as a
   `PAYMENT_STATUS_CHANGED` webhook and is reconciled. If that sale is
   already in a payout Toss hasn't started (`REQUESTED`), the payout is
   canceled (in place if it hasn't been sent to Toss yet) and its other
   sales go in the next one; past that, operators get a
   `template_refund_after_payout` alert to settle with the seller.
5. **Payout.** The `market-payouts` maintenance job runs daily at 10:00 KST.
   For each seller whose Toss status allows payouts (`PARTIALLY_APPROVED`,
   `APPROVED`), it adds up sales older than `PAYOUT_HOLD_DAYS` (10) that
   are not yet paid out or held for a refund. It skips sellers who have an
   open payout or a completed one from the past 7 days. When the total is
   at least 1,000 won, it writes one `seller_payouts` row and claims those
   purchases in the same transaction. The `request_payout` task then sends
   it to Toss as a `SCHEDULED` payout for the next weekday, using the row's
   id as both `refPayoutId` and idempotency key. If Toss refuses the payout
   (a public holiday, a balance not yet settled), the row is marked failed
   and its purchases are released for the next run. A payout Toss took and
   the bank then turned down waits a week, or until the seller changes
   their account; one Toss rejects in its answer is tried the next day. A
   payout whose task gave up before Toss took it is sent again by the
   daily job, under the same idempotency key. The
   `payout.changed` and `seller.changed` webhooks are treated only as
   notices (a payout is matched by Toss's id or by `refPayoutId`): the
   tasks (`sync_payout`, `sync_seller`) fetch the payout or seller from
   Toss before writing anything. The daily job also re-syncs open payouts in
   case a webhook was missed.

## Sellers

`POST /v2/sellers` takes the seller's identity, contact details and bank
account. 나루 sends these to Toss and keeps only the display name, bank
code, the account's last four digits and the holder name
(`market_sellers`). Account numbers, phone numbers, emails and business
numbers are masked in `toss_calls`. An individual seller starts as
`APPROVAL_REQUIRED` and must complete the identity check Toss sends them.
They can sell before that, and their earnings accumulate until it is done.
A registration Toss refuses is retried under a new `refSellerId`, since
Toss keeps the refusal under the old one's idempotency key.
Sales over 10,000,000 won a week, or a periodic review, move a seller to
`KYC_REQUIRED`, which stops payouts until Toss's review is complete.

In Toss's test environment, only `CORPORATE` sellers with a real business
number can be registered, and they can never reach `APPROVED`.

## Encryption

Payout and seller `POST` requests that have a body are sent as compact JWE
(`alg: dir`, `enc: A256GCM`, with `iat` and `nonce` in the protected
header), `Content-Type: text/plain`, and
`TossPayments-api-security-mode: ENCRYPTION`. They are encrypted with
`TOSS_MARKET_SECURITY_KEY`. Toss encrypts its answers to these requests the
same way, and `lib/payments/toss.ts` decrypts them (`lib/market/jwe.ts`).

## Configuration

| Variable                   |                                                  |
| -------------------------- | ------------------------------------------------ |
| `TOSS_MARKET_CLIENT_KEY`   | API 개별 연동 클라이언트 키 for the market MID   |
| `TOSS_MARKET_SECRET_KEY`   | its secret key; payments and payouts both use it |
| `TOSS_MARKET_MID`          | the MID, checked against Toss's records          |
| `TOSS_MARKET_SECURITY_KEY` | the 보안 키, 64 hex characters                   |

Payouts must be enabled on the market MID by contract with Toss.

## Deploying

The migration is additive. Version files must already be in the private
bucket: that came separately, with `cli/move-template-files-private`, which
has to have been run after its deploy.
