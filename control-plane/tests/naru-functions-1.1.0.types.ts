// functions.d.ts is written by hand: site code checks against it, and its
// query language stays the one naru.d.ts gives pages.
import type {
  CanWrite,
  Ctx,
  Filter,
  Mutation,
  Predicate,
  Query,
  Present,
  Queryable,
  Readable,
  SiteFunction,
  Sort,
} from "../public/sdk/1.1.0/functions.js";
import type * as Sdk from "../public/sdk/1.1.0/naru.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const samePredicate: Same<Predicate, Sdk.Predicate> = true;
const sameFilter: Same<Filter, Sdk.Filter> = true;
const sameSort: Same<Sort, Sdk.Sort> = true;

interface Wallet {
  balance: number;
}

// ctx typed where it is declared, so ctx.fail (never) narrows what follows.
export async function buy(ctx: Ctx, { item }: { item: string }) {
  const wallet = await ctx.get<Wallet>("wallets", ctx.member!.id);
  if (!wallet || wallet.data.balance < 10)
    ctx.fail("CONFLICT", "잔액이 부족합니다.", { reason: "short" });
  await ctx.set<Wallet>(
    "wallets",
    wallet.id,
    { balance: wallet.data.balance - 10 },
    { condition: { revision: wallet.revision } },
  );
  const added = await ctx.add("inventory", { item }, { secret: "pw" });
  const author: string | null = added.createdBy;
  await ctx.delete("carts", item);
  ctx.notify(ctx.member!.id, { bought: item });
  const page = await ctx.list("inventory", {
    where: { gte: [{ metadata: "createdAt" }, "2026-10-01T00:00:00Z"] },
    sort: [[{ metadata: "createdAt" }, "desc"]],
    after: null,
  });
  return { author, more: page.nextCursor !== null };
}
const typed: SiteFunction<{ item: string }> = buy;

export async function check(ctx: Ctx, id: string) {
  return ctx.secretMatches("guestbook", id, "pw");
}

export const readable: Readable = async (ctx, args) => {
  if (args.operation === "getMany")
    return { in: [{ metadata: "id" }, args.ids] };
  if (args.operation === "get")
    return (await ctx.get("posts", args.id)) !== null;
  // @ts-expect-error A rule reads; it cannot write.
  await ctx.add("posts", {});
  return ctx.visitor ? { ne: ["secret", true] } : true;
};

export const canWrite: CanWrite = (ctx, args) => {
  if (args.operation === "create")
    return args.after.createdBy === ctx.member?.id;
  return args.before.data.owner === ctx.member?.id;
};

export const present: Present = (ctx, { document }) => {
  const { note, ...shown } = document.data;
  return note === undefined ? document.data : shown;
};

export const queryable: Queryable = ["board"];

// A query reads the site's tables; it has no collections.
export const posts: Query<{ board: string }, { id: number }[]> = async (
  ctx,
  { board },
) => {
  // @ts-expect-error Queries reach tables through sql only.
  await ctx.get("posts", "1");
  const { rows } = await ctx.sql<{
    id: number;
  }>`SELECT id FROM posts WHERE board = ${board}`;
  return rows;
};
export const write: Mutation<{ title: string }, number> = async (
  ctx,
  { title },
) => {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "로그인해 주세요.");
  return (await ctx.sql("INSERT INTO posts (title) VALUES (?)", [title]))
    .changes;
};

export const checks = { samePredicate, sameFilter, sameSort, typed };
