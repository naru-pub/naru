import "@testing-library/jest-dom/jest-globals";
import { beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BreakerTrip } from "@/lib/edge/breakers";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
const { Problems, DatabaseAndUsage } =
  require("../Status") as typeof import("../Status");

const fetchMock = global.fetch as jest.Mock<typeof fetch>;
const json = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;
const DAY = 24 * 60 * 60 * 1000;
const trip = (
  id: string,
  at: number,
  pausedUntil: number | null,
): BreakerTrip => ({
  id,
  at,
  kind: "query",
  file: "posts",
  name: id,
  key: `query:posts:${id}`,
  statement: null,
  text: "SELECT 1",
  strikes: 3,
  until: at + 5 * 60_000,
  repeated: false,
  clearedAt: null,
  notifiedAt: null,
  pausedUntil,
});
let trips: BreakerTrip[];
const allowed: string[] = [];

beforeEach(() => {
  allowed.length = 0;
  trips = [
    trip("recent", Date.now() - 60_000, Date.now() + 60_000),
    trip("old", Date.now() - 30 * DAY, null),
  ];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/account/stopped-queries") {
      if (init?.method === "POST") {
        const { key } = JSON.parse(String(init.body));
        allowed.push(key);
        trips = trips.map((t) =>
          t.key === key
            ? { ...t, pausedUntil: null, clearedAt: Date.now() }
            : t,
        );
        return json(null);
      }
      return json({ trips });
    }
    if (url === "/api/account/site-tables")
      return json({
        tables: [
          { name: "posts", view: false, columns: [] },
          { name: "recent", view: true, columns: [] },
        ],
      });
    if (url === "/api/account/restore-points")
      return json({
        restorePoints: [
          { kind: "release" },
          { kind: "release" },
          { kind: "manual" },
        ],
      });
    if (url === "/api/account/database")
      return json({
        collections: [],
        usage: {
          documents: 1200,
          bytes: 5 * 1024 * 1024,
          requests: { used: 900, limit: 1000, resetsAt: Date.now() + DAY },
        },
      });
    throw new Error(`unexpected ${url}`);
  });
});

test("문제 lists recent paused statements and refused releases, and allows one again", async () => {
  render(
    <Problems
      days={7}
      refused={[
        {
          id: "d1",
          at: Date.now() - 2 * 60_000,
          where: "demo/site@abc1234",
          message: "Migration 0002_tags.sql comes before an applied one.",
        },
      ]}
    />,
  );
  expect(await screen.findByText("posts:recent")).toBeInTheDocument();
  // Over and older than the window: left out.
  expect(screen.queryByText("posts:old")).not.toBeInTheDocument();
  expect(screen.getByText("demo/site@abc1234")).toBeInTheDocument();
  expect(screen.getByText(/comes before an applied one/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 허용" }));
  await waitFor(() => expect(allowed).toEqual(["query:posts:recent"]));
  expect(
    await screen.findByText(/멈췄다가 다시 허용됐어요/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 허용" })).toBeNull();
});

test("문제 says so when there is nothing, and when it can't read", async () => {
  trips = [];
  const { unmount } = render(<Problems days={7} refused={[]} />);
  expect(await screen.findByText("지금은 문제가 없어요.")).toBeInTheDocument();
  unmount();
  fetchMock.mockImplementation(async () =>
    json({ error: { message: "away" } }, false),
  );
  render(<Problems days={7} refused={[]} />);
  expect(
    await screen.findByText("멈춘 문장을 불러오지 못했어요."),
  ).toBeInTheDocument();
  expect(screen.queryByText("지금은 문제가 없어요.")).toBeNull();
});

test("database and usage show what the owner's routes report", async () => {
  render(
    <DatabaseAndUsage
      migrations={["0001.sql", "0002.sql", "0003.sql", "0004.sql", "0005.sql"]}
    />,
  );
  expect(await screen.findByText("테이블 1개 · 뷰 1개")).toBeInTheDocument();
  expect(
    await screen.findByText(/릴리스 전에 2개 · 직접 남긴 것 1개/),
  ).toBeInTheDocument();
  expect(screen.getByText("… 0005.sql")).toBeInTheDocument();
  expect(screen.queryByText("0004.sql")).toBeNull();
  expect(await screen.findByText("900 / 1,000")).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "이번 달 요청 90%" }),
  ).toBeInTheDocument();
});
