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
  settings: {
    logs: { read: "world" as const, write: "admin" as const, rules: "board" },
    profiles: {
      read: "admin" as const,
      write: "admin" as const,
      unique: ["nick"],
    },
  },
};

test("collections to create and settings to change are tables", () => {
  render(
    <Setup
      input={input}
      setup={{
        register: true,
        create: ["profiles", "wallets"],
        extend: [],
        configure: [
          {
            name: "logs",
            changes: { read: ["admin", "world"], rules: ["", "board"] },
          },
        ],
      }}
    />,
  );
  const [created, changed] = screen.getAllByRole("table");
  const rows = within(created).getAllByRole("row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "컬렉션읽기쓰기규칙중복 금지 필드",
    "profiles관리자만관리자만—nick",
    "wallets관리자만관리자만——",
  ]);
  const changes = within(changed).getAllByRole("row").slice(1);
  expect(changes.map((row) => row.textContent)).toEqual([
    "logs읽기관리자만누구나",
    "규칙없음board",
  ]);
  // Opening admin-only data to visitors is marked.
  expect(changes[0]).toHaveClass("text-destructive");
  expect(changes[1]).not.toHaveClass("text-destructive");
  expect(screen.getByText(/빨간 줄은/)).toBeInTheDocument();
  expect(
    screen.getByText(/요청한 컬렉션 3개를 허용합니다/),
  ).toBeInTheDocument();
});
