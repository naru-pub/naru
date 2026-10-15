// Publish as _naru/rules/community-board.js and enable it on logs/comments.
const P = "neo_avocado_";
const LOGS = `${P}logs`;
const COMMENTS = `${P}comments`;
const author = (doc) => doc?.createdBy ?? doc?.data.owner;
async function access(ctx) {
  const data = ctx.member
    ? (await ctx.get(`${P}members`, ctx.member.id))?.data
    : null;
  return {
    id: ctx.member?.id,
    moderator: data?.role === "moderator",
    level:
      Number.isInteger(data?.level) && data.level >= 1 && data.level <= 10
        ? data.level
        : 2,
  };
}
async function board(ctx, id) {
  return (
    (await ctx.get(`${P}boards`, id))?.data ??
    (id === "default"
      ? {
          enabled: true,
          listLevel: 2,
          readLevel: 2,
          writeLevel: 2,
          commentLevel: 2,
          secret: "optional",
          kind: "image",
          categories: [],
        }
      : null)
  );
}
function allowed(board, actor, action) {
  if (!actor.id || !board) return false;
  if (actor.moderator)
    return ["read", "list"].includes(action) || board.enabled !== false;
  return (
    board.enabled !== false && actor.level >= (board[`${action}Level`] ?? 2)
  );
}
async function logReadable(ctx, log, actor) {
  return (
    log &&
    !log.data.deleted &&
    allowed(await board(ctx, log.data.board ?? "default"), actor, "read") &&
    (!log.data.secret || author(log) === actor.id || actor.moderator)
  );
}
export async function readable(ctx, { collection, operation, id, filter }) {
  const actor = await access(ctx);
  if (!actor.id) return false;
  if (collection === COMMENTS) {
    const logId =
      operation === "get"
        ? (await ctx.get(COMMENTS, id))?.data.logId
        : filter.logId;
    if (
      typeof logId !== "string" ||
      !(await logReadable(ctx, await ctx.get(LOGS, logId), actor))
    )
      return false;
    return { eq: ["logId", logId] };
  }
  if (collection !== LOGS) return false;
  const boardId =
    operation === "get"
      ? ((await ctx.get(LOGS, id))?.data.board ?? "default")
      : (filter.board ?? "default");
  if (typeof boardId !== "string") return false;
  const target = await board(ctx, boardId);
  // Lists return complete documents, so listing must also permit body reads.
  if (
    !allowed(target, actor, "read") ||
    (operation === "list" && !allowed(target, actor, "list"))
  )
    return false;
  return {
    all: [
      { eq: ["board", boardId] },
      { ne: ["deleted", true] },
      actor.moderator
        ? true
        : {
            any: [
              { ne: ["secret", true] },
              { eq: ["owner", actor.id] },
              { eq: [{ metadata: "createdBy" }, actor.id] },
            ],
          },
    ],
  };
}
const text = (value, max) => typeof value === "string" && value.length <= max;
const image = (value) =>
  value === null ||
  (typeof value === "string" &&
    value.length <= 2048 &&
    /^https?:\/\/[^\s]+$/i.test(value));
export async function canWrite(ctx, { collection, before, after, operation }) {
  const actor = await access(ctx);
  if (!actor.id || ![LOGS, COMMENTS].includes(collection)) return false;
  if (
    before &&
    (before.data.deleted || (author(before) !== actor.id && !actor.moderator))
  )
    return false;
  if (
    after &&
    (after.data.owner !== (before ? author(before) : actor.id) ||
      (before && after.id !== before.id))
  )
    return false;
  if (collection === COMMENTS) {
    const logId = before?.data.logId ?? after?.data.logId;
    if (typeof logId !== "string" || (after && after.data.logId !== logId))
      return false;
    const log = await ctx.get(LOGS, logId);
    if (
      !(await logReadable(ctx, log, actor)) ||
      !allowed(await board(ctx, log.data.board ?? "default"), actor, "comment")
    )
      return false;
    if (!after) return operation === "delete";
    return (
      text(after.data.text, 1000) &&
      typeof after.data.dice === "boolean" &&
      (Boolean(after.data.text.trim()) || after.data.dice)
    );
  }
  const boardId = before?.data.board ?? after?.data.board;
  if (typeof boardId !== "string" || (after && after.data.board !== boardId))
    return false;
  const target = await board(ctx, boardId);
  if (!allowed(target, actor, "write")) return false;
  // Log deletion stays in a transactional function because it has child cleanup.
  if (!after) return false;
  const data = after.data;
  if (data.deleted !== undefined && data.deleted !== before?.data.deleted)
    return false;
  if (
    typeof data.secret !== "boolean" ||
    (target.secret === "required" && !data.secret) ||
    (target.secret === "off" && data.secret && !before?.data.secret)
  )
    return false;
  if (
    !text(data.title, 120) ||
    !text(data.category, 40) ||
    (data.category && !(target.categories ?? []).includes(data.category))
  )
    return false;
  if (!text(data.text, 2000) || !image(data.image)) return false;
  return (
    (target.kind !== "image" || Boolean(data.image)) &&
    (Boolean(data.image) || Boolean(data.text.trim()))
  );
}
