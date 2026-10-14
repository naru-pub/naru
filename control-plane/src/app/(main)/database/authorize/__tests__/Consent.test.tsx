import "@testing-library/jest-dom/jest-globals";
import { expect, test } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";

const { default: Consent } =
  require("../Consent") as typeof import("../Consent");

test("the collections to allow are a table with their current access", () => {
  render(
    <Consent
      input={{
        site: "alice",
        redirectUri: "https://alice.naru.pub/admin.html",
        challenge: "c".repeat(43),
        state: "s".repeat(43),
        collections: ["logs", "wallets"],
      }}
      collections={[
        { name: "logs", read: "world", write: "admin", rules: "board" },
        { name: "wallets", read: "admin", write: "admin", rules: null },
      ]}
      tokenLifetimeSeconds={3600}
    />,
  );
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "컬렉션지금 읽기지금 쓰기규칙",
    "logs누구나관리자만board",
    "wallets관리자만관리자만—",
  ]);
  expect(
    screen.getByText(/나루 미디어 라이브러리에 파일을/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Naru Media/)).toBeNull();
});
