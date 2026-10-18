export async function add(ctx, { text }) {
  const author = ctx.owner ? "owner" : (ctx.member?.id ?? null);
  const { rows } = await ctx.sql`
    INSERT INTO notes (text, author, created_at)
    VALUES (${text}, ${author}, ${ctx.now}) RETURNING id`;
  return rows[0].id;
}
