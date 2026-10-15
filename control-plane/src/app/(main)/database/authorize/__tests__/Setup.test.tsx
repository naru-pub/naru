import "@testing-library/jest-dom/jest-globals";
import { expect, test } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";

const { default: Setup } = require("../Setup") as typeof import("../Setup");

const input = {
  site: "alice",
  redirectUri: "https://alice.naru.pub/admin.html",
  challenge: "c".repeat(43),
  state: "s".repeat(43),
  collections: ["logs", "profiles", "wallets"],
};

test("collections to create are a table, and start private", () => {
  render(
    <Setup
      input={input}
      setup={{ register: true, create: ["profiles", "wallets"], extend: [] }}
    />,
  );
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "컬렉션읽기쓰기규칙중복 금지 필드",
    "profiles관리자만관리자만——",
    "wallets관리자만관리자만——",
  ]);
  expect(
    screen.getByText(/요청한 컬렉션 3개를 허용합니다/),
  ).toBeInTheDocument();
});
