export async function list(ctx) {
  const { rows } =
    await ctx.sql`SELECT id, text, author FROM notes ORDER BY id`;
  return rows;
}
