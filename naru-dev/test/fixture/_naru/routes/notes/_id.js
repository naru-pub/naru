export default async function (ctx, { params }) {
  const { rows } =
    await ctx.sql`SELECT text FROM notes WHERE id = ${Number(params.id)}`;
  if (!rows.length) return { status: 404, html: "<p>no such note</p>" };
  return {
    file: "index.html",
    head: `<meta name="note" content="${rows[0].text.replace(/[&<>"]/g, "")}">`,
  };
}
