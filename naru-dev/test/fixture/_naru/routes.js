export default async function (ctx, { path }) {
  const id = Number(path.split("/")[2]);
  const { rows } = await ctx.sql`SELECT text FROM notes WHERE id = ${id}`;
  if (!rows.length) return { status: 404, html: "<p>no such note</p>" };
  return {
    file: "index.html",
    head: `<meta name="note" content="${rows[0].text.replace(/[&<>"]/g, "")}">`,
  };
}
