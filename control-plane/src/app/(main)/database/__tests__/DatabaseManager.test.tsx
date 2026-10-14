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
let requests = 0;
let failing = false;
const json = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;

beforeEach(() => {
  deleted.length = 0;
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
