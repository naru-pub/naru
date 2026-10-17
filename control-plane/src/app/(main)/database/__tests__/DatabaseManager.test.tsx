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
let created = 0;
let requests = 0;
let failing = false;
const json = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;

beforeEach(() => {
  deleted.length = 0;
  restored.length = 0;
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
