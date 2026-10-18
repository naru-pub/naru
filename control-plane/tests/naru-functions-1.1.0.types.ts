// functions.d.ts is written by hand: site code checks against it.
import type {
  ErrorCode,
  Json,
  Mutation,
  MutationCtx,
  Query,
  QueryCtx,
} from "../public/sdk/1.1.0/functions.js";
import type * as Sdk from "../public/sdk/1.1.0/naru.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameJson: Same<Json, Sdk.Json> = true;
const sameCodes: Same<ErrorCode, Sdk.NaruErrorCode> = true;

// A query reads the site's tables; it has no collections.
export const posts: Query<{ board: string }, { id: number }[]> = async (
  ctx,
  { board },
) => {
  // @ts-expect-error Queries reach tables through sql only.
  await ctx.get("posts", "1");
  // @ts-expect-error Only a mutation grants roles.
  await ctx.setRoles("m-1", []);
  // @ts-expect-error Only a mutation notifies.
  await ctx.notify(["m-1"], { title: "t" });
  // @ts-expect-error Only a mutation hashes passwords.
  await ctx.passwords.hash("pw");
  const { rows } = await ctx.sql<{
    id: number;
  }>`SELECT id FROM posts WHERE board = ${board}`;
  return rows;
};
export const write: Mutation<{ title: string }, number> = async (
  ctx,
  { title },
) => {
  if (!ctx.member) return ctx.fail("AUTH_REQUIRED", "로그인해 주세요.");
  if (!ctx.member.roles.includes("writer"))
    await ctx.setRoles(ctx.member.id, [...ctx.member.roles, "writer"]);
  const hash: string = await ctx.passwords.hash(title);
  await ctx.notify([ctx.member.id], { title: "새 글", path: "/posts/1" });
  // @ts-expect-error A notification has a title, and members come as a list.
  await ctx.notify(ctx.member.id, { body: "x" });
  return (
    await ctx.sql("INSERT INTO posts (title, hash) VALUES (?, ?)", [
      title,
      hash,
    ])
  ).changes;
};
// ctx typed where it is declared, so ctx.fail (never) narrows what follows.
export async function check(ctx: QueryCtx, { id }: { id: number }) {
  const { rows } = await ctx.sql<{
    hash: string | null;
  }>`SELECT hash FROM posts WHERE id = ${id}`;
  if (!rows[0]?.hash) ctx.fail("NOT_FOUND", "없는 글입니다.");
  return ctx.passwords.verify("pw", rows[0].hash, `post:${id}`);
}
const asMutation: MutationCtx extends QueryCtx ? true : false = true;

export const checks = { sameJson, sameCodes, asMutation };
