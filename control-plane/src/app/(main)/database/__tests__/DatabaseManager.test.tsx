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
const json = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;

beforeEach(() => {
  deleted.length = 0;
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
    const match = /^\/api\/account\/database\/([^/?]+)$/.exec(url);
    if (match && method === "DELETE") {
      // beta's deletion fails; the others go.
      if (match[1] === "beta") return json({ error: "busy" }, false);
      deleted.push(match[1]);
      collections = collections.filter((c) => c.name !== match[1]);
      return json({ success: true });
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

test("several checked collections are deleted after one confirmation", async () => {
  render(
    <ConfirmProvider>
      <DatabaseManager site="alice" websiteUrl="https://alice.naru.pub/" />
    </ConfirmProvider>,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: "alpha 선택" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "beta 선택" }));
  fireEvent.click(
    screen.getByRole("button", { name: "선택한 컬렉션 삭제 (2)" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("alpha, beta");
  fireEvent.click(within(dialog).getByRole("button", { name: "2개 삭제" }));
  await waitFor(() => expect(deleted).toEqual(["alpha"]));
  // The one that failed stays checked and is reported; gamma was never touched.
  expect(
    await screen.findByText(/삭제하지 못한 컬렉션: beta/),
  ).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "beta 선택" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "alpha 선택" })).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "gamma 선택" }),
  ).not.toBeChecked();
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
