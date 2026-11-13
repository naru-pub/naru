import { jest, test, expect } from "@jest/globals";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentOrigin } from "@/app/(admin)/admin/_components/PaymentOrigin";

jest.mock("@/lib/database", () => ({ db: {} }));

const first = {
  subscription_id: "subscription",
  billing_interval: "year",
  registered_at: new Date("2026-11-07T01:00:00Z"),
  claimed_at: new Date("2026-11-06T22:00:00Z"),
  ends_at: new Date("2026-11-12T22:00:00Z"),
  scheduled_at: new Date("2026-11-07T01:00:00Z"),
  has_prior_payment: false,
};

const render = (origin: typeof first) =>
  renderToStaticMarkup(createElement(PaymentOrigin, { origin }));

test("scheduled first annual charge after a trial is not labeled renewal", () => {
  const html = render(first);
  expect(html).toContain("무료 체험 후 ");
  expect(html).toContain("첫 연간 결제");
  expect(html).toContain("무료 체험 종료");
  expect(html).not.toContain("갱신");
});

test("a later charge on the same subscription is a renewal", () => {
  const html = render({ ...first, has_prior_payment: true });
  expect(html).toContain("연간 갱신");
  expect(html).not.toContain("무료 체험 후");
  expect(html).not.toContain("첫 결제 예약");
});

test("an expired trial does not explain a newly scheduled first charge", () => {
  const html = render({
    ...first,
    scheduled_at: new Date("2026-11-13T01:00:00Z"),
  });
  expect(html).toContain("첫 연간 결제");
  expect(html).not.toContain("무료 체험 후");
});

test("a trial claimed after scheduling does not explain the deferral", () => {
  const html = render({
    ...first,
    claimed_at: new Date("2026-11-08T01:00:00Z"),
  });
  expect(html).not.toContain("무료 체험 후");
});

test("one-time payments are distinct from subscriptions", () => {
  const html = renderToStaticMarkup(
    createElement(PaymentOrigin, {
      origin: { ...first, subscription_id: null },
    }),
  );
  expect(html).toContain("한 번만 결제");
});
