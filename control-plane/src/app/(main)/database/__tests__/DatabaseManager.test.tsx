import "@testing-library/jest-dom/jest-globals";
import { beforeEach, expect, jest, test } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

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
const { default: DatabaseManager } =
  require("../DatabaseManager") as typeof import("../DatabaseManager");
const { ConfirmProvider } =
  require("@/components/ui/confirm") as typeof import("@/components/ui/confirm");

// jsdom has no ResizeObserver, which the Radix tabs measure with.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
const fetchMock = global.fetch as jest.Mock<typeof fetch>;
let collections: { name: string; read_access: string; write_access: string }[];
const deleted: string[] = [];
const restored: string[] = [];
const allowed: string[] = [];
const tablePages: string[] = [];
const queries: string[] = [];
let created = 0;
let requests = 0;
let failing = false;
const json = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;

beforeEach(() => {
  deleted.length = 0;
  restored.length = 0;
  allowed.length = 0;
  tablePages.length = 0;
  queries.length = 0;
  created = 0;
  requests = 0;
  failing = false;
  collections = ["alpha", "beta", "gamma"].map((name) => ({
    name,
    read_access: "admin",
    write_access: "admin",
  }));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/account/database" && method === "GET")
      return json({ collections });
    if (url === "/api/account/database" && method === "DELETE") {
      const { names } = JSON.parse(String(init?.body));
      requests += 1;
      // All or nothing, as the site's object does it.
      if (failing) return json({ error: "busy" }, false);
      deleted.push(...names);
      collections = collections.filter((c) => !names.includes(c.name));
      return json({ deleted: names });
    }
    if (url === "/api/account/restore-points") {
      if (method === "POST" && JSON.parse(String(init?.body)).create) {
        created += 1;
        return json({
          saved: {
            name: "manual-1790000000000.ndjson.gz",
            createdAt: 1_790_000_000_000,
            kind: "manual",
            generation: null,
            size: 4096,
          },
        });
      }
      if (method === "POST") {
        restored.push(JSON.parse(String(init?.body)).name);
        return json({
          revision: null,
          saved: {
            name: "before-restore-1790000000000.json",
            createdAt: 1_790_000_000_000,
            kind: "before-restore",
            generation: null,
          },
        });
      }
      return json({
        restorePoints: [
          {
            name: "019a2b3c-4d5e-7000-8000-000000000001.json",
            createdAt: 0x019a2b3c4d5e,
            kind: "release",
            generation: "019a2b3c-4d5e-7000-8000-000000000001",
            size: 2048,
          },
        ],
      });
    }
    if (url === "/api/account/stopped-queries") {
      if (method === "POST") {
        allowed.push(JSON.parse(String(init?.body)).key);
        return json({ cleared: allowed.at(-1) });
      }
      return json({
        trips: [
          {
            id: "019a2b3c-4d5e-7000-8000-000000000009",
            at: 1_790_000_000_000,
            kind: "query",
            file: "posts",
            name: "list",
            key: "query:posts:list:abc",
            statement: "abc",
            text: "SELECT count(*) FROM posts p1 JOIN posts p2 ON p2.board = p1.board",
            strikes: 3,
            until: 1_790_000_300_000,
            repeated: false,
            clearedAt: allowed.length ? 1_790_000_100_000 : null,
            notifiedAt: null,
            pausedUntil: allowed.length ? null : 1_790_000_300_000,
          },
        ],
      });
    }
    if (url === "/api/account/site-tables" && method === "POST") {
      const { query } = JSON.parse(String(init?.body));
      queries.push(query);
      return query.startsWith("DELETE")
        ? json(
            {
              error: {
                status: 400,
                message: "Invalid SQL: a read-only query cannot write.",
              },
            },
            false,
          )
        : json({
            columns: ["id", "n"],
            rows: [
              [1, 2],
              [3, null],
            ],
            more: true,
          });
    }
    if (url === "/api/account/site-tables")
      return json({
        tables: [
          { name: "posts", view: false, columns: [] },
          { name: "titled", view: true, columns: [] },
        ],
      });
    if (url.startsWith("/api/account/site-tables?")) {
      const params = new URL(url, "http://localhost").searchParams;
      tablePages.push(`${params.get("table")}:${params.get("after")}`);
      return params.get("after") === null
        ? json({
            table: "posts",
            columns: ["id", "title", "cover"],
            rows: [
              [1, { text: "a".repeat(1000), length: 1500 }, { blob: 2048 }],
              [2, "second", null],
            ],
            next: 2,
            count: { rows: 10_000, more: true },
          })
        : json({
            table: "posts",
            columns: ["id", "title", "cover"],
            rows: [[3, "third", null]],
            next: null,
          });
    }
    if (url.startsWith("/api/account/site-members"))
      return json({
        admission: "open",
        verifiedEmail: false,
        members: [],
        nextCursor: null,
      });
    return json({ clients: [] });
  });
});

const renderManager = () =>
  render(
    <ConfirmProvider>
      <DatabaseManager site="alice" websiteUrl="https://alice.naru.pub/" />
    </ConfirmProvider>,
  );
async function deleteChecked(names: string[]) {
  for (const name of names)
    fireEvent.click(
      await screen.findByRole("checkbox", { name: `${name} 선택` }),
    );
  fireEvent.click(
    screen.getByRole("button", {
      name: `선택한 컬렉션 삭제 (${names.length})`,
    }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent(names.join(", "));
  fireEvent.click(
    within(dialog).getByRole("button", { name: `${names.length}개 삭제` }),
  );
}

test("checked collections are deleted in one request after one confirmation", async () => {
  renderManager();
  await deleteChecked(["alpha", "beta"]);
  await waitFor(() => expect(deleted).toEqual(["alpha", "beta"]));
  expect(requests).toBe(1);
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: "alpha 선택" })).toBeNull(),
  );
  expect(
    screen.getByRole("checkbox", { name: "gamma 선택" }),
  ).not.toBeChecked();
});

test("a failed deletion deletes nothing and keeps the checks", async () => {
  failing = true;
  renderManager();
  await deleteChecked(["alpha", "beta"]);
  expect(await screen.findByText("busy")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "alpha 선택" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "beta 선택" })).toBeChecked();
});

test("select all checks every collection", async () => {
  render(
    <ConfirmProvider>
      <DatabaseManager site="alice" websiteUrl="https://alice.naru.pub/" />
    </ConfirmProvider>,
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "모든 컬렉션 선택" }),
  );
  expect(
    screen.getByRole("button", { name: "선택한 컬렉션 삭제 (3)" }),
  ).toBeInTheDocument();
});

test("a restore point is restored after a confirmation that says what happens", async () => {
  renderManager();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "복원 지점" }), {
    button: 0,
  });
  const row = (await screen.findByText(/릴리스 직전/)).closest("tr")!;
  expect(row).toHaveTextContent("2 KB");
  // Kept a week from when it was made.
  expect(row).toHaveTextContent(
    `${new Date(0x019a2b3c4d5e + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("ko-KR", { dateStyle: "medium" })} 삭제 예정`,
  );
  expect(screen.getByText(/7일 동안 보관/)).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "복원" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent(/그 뒤에 생기거나 바뀐 데이터는/);
  expect(dialog).toHaveTextContent(/되돌릴 수 있습니다/);
  expect(dialog).toHaveTextContent(/다음에 _naru 파일을 올릴 때 다시 적용/);
  fireEvent.click(within(dialog).getByRole("button", { name: "복원" }));
  await waitFor(() =>
    expect(restored).toEqual(["019a2b3c-4d5e-7000-8000-000000000001.json"]),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    /복원 전 상태는 .* 복원 지점으로 남겼습니다/,
  );
});

test("a restore point is made on request, and each one downloads", async () => {
  renderManager();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "복원 지점" }), {
    button: 0,
  });
  const row = (await screen.findByText(/릴리스 직전/)).closest("tr")!;
  expect(within(row).getByRole("link", { name: "내려받기" })).toHaveAttribute(
    "href",
    "/api/account/restore-points?download=019a2b3c-4d5e-7000-8000-000000000001.json",
  );
  // Kept the same week as the others, which the page says.
  expect(screen.getByText(/직접 만든 것을 포함해/)).toHaveTextContent(
    /7일 동안 보관/,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "지금 복원 지점 만들기" }),
  );
  await waitFor(() => expect(created).toBe(1));
  expect(await screen.findByRole("status")).toHaveTextContent(
    /복원 지점을 만들었습니다/,
  );
});

test("a paused statement is shown with its SQL and let run again", async () => {
  renderManager();
  const section = (
    await screen.findByRole("heading", { name: "중지된 쿼리" })
  ).closest("section")!;
  expect(section).toHaveTextContent("posts:list");
  expect(section).toHaveTextContent(/JOIN posts p2 ON p2.board = p1.board/);
  expect(section).toHaveTextContent(/까지 멈춤/);
  fireEvent.click(within(section).getByRole("button", { name: "다시 허용" }));
  await waitFor(() => expect(allowed).toEqual(["query:posts:list:abc"]));
  expect(await within(section).findByText(/다시 허용됨/)).toBeInTheDocument();
  expect(
    within(section).queryByRole("button", { name: "다시 허용" }),
  ).not.toBeInTheDocument();
});

test("each tab has a permalink: ?tab= opens it, and opening a tab puts it in the address", async () => {
  window.history.replaceState(null, "", "/database?tab=restore");
  render(
    <ConfirmProvider>
      <DatabaseManager
        site="alice"
        websiteUrl="https://alice.naru.pub/"
        tab="restore"
      />
    </ConfirmProvider>,
  );
  expect(screen.getByRole("tab", { name: "복원 지점" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await screen.findByText(/릴리스 직전/)).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "사이트 회원" }), {
    button: 0,
  });
  expect(window.location.search).toBe("?tab=members");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "컬렉션과 문서" }), {
    button: 0,
  });
  expect(window.location.pathname + window.location.search).toBe("/database");
  window.history.replaceState(null, "", "/");
});

test("a site's table is paged read only", async () => {
  renderManager();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "테이블" }), {
    button: 0,
  });
  // Views are listed, not browsed.
  expect(await screen.findByText("titled (뷰)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "posts" }));
  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("10,000개 이상 행 중 1–2번째");
  const first = screen.getByText("second").closest("tr")!;
  expect(first).toHaveTextContent("NULL");
  expect(screen.getByText(/BLOB 2 KB/)).toBeInTheDocument();
  expect(screen.getByText(/1,500자/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이전" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  expect(await screen.findByText("third")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "10,000개 이상 행 중 101–101번째",
  );
  expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "이전" }));
  expect(await screen.findByText("second")).toBeInTheDocument();
  expect(tablePages).toEqual(["posts:null", "posts:2", "posts:null"]);
  // Nothing on the page edits a row.
  const panel = screen
    .getByRole("heading", { name: "테이블" })
    .closest("section")!;
  expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
});

test("the owner runs a read-only query beside the tables", async () => {
  renderManager();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "테이블" }), {
    button: 0,
  });
  const panel = (
    await screen.findByRole("heading", { name: "SQL 조회" })
  ).closest("section")!;
  const sql = within(panel).getByRole("textbox", { name: "SQL" });
  // The example names the site's first table, not a view.
  await waitFor(() =>
    expect(sql).toHaveAttribute("placeholder", "SELECT * FROM posts LIMIT 10"),
  );
  const run = within(panel).getByRole("button", { name: "실행" });
  expect(run).toBeDisabled();
  fireEvent.change(sql, { target: { value: "SELECT id, n FROM posts" } });
  fireEvent.click(run);
  expect(
    await within(panel).findByText("처음 2개 행만 보입니다."),
  ).toBeInTheDocument();
  expect(within(panel).getByRole("table")).toHaveTextContent("NULL");
  // Cmd/Ctrl+Enter runs too, and the object's refusal is shown as it is.
  fireEvent.change(sql, { target: { value: "DELETE FROM posts" } });
  fireEvent.keyDown(sql, { key: "Enter", metaKey: true });
  expect(await within(panel).findByRole("alert")).toHaveTextContent(
    "a read-only query cannot write",
  );
  expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
  expect(queries).toEqual(["SELECT id, n FROM posts", "DELETE FROM posts"]);
});
