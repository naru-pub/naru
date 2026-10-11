// A site's functions.js, as an owner would write it.
export function buy(ctx, { item }) {
  const wallet = ctx.get("wallets", ctx.member.id);
  const listing = ctx.get("shop", item);
  if (!listing) return { ok: false, reason: "no_such_item" };
  if (listing.data.stock < 1) return { ok: false, reason: "sold_out" };
  const balance = wallet ? wallet.data.balance : 0;
  if (balance < listing.data.price) return { ok: false, reason: "not_enough_money" };
  ctx.set("wallets", ctx.member.id, { balance: balance - listing.data.price });
  ctx.set("shop", item, { ...listing.data, stock: listing.data.stock - 1 });
  ctx.add("inventory", { owner: ctx.member.id, item });
  return { ok: true, balance: balance - listing.data.price };
}

// Writes, then fails: everything must roll back.
export function buyThenThrow(ctx, args) {
  buy(ctx, args);
  throw new Error("boom after writing");
}

// Gacha: roll against a table of 300 entries and grant the prize.
export function gacha(ctx) {
  const table = ctx.list("gacha");
  const roll = ctx.random() * 100;
  const prize = table.find((row) => roll >= row.data.from && roll < row.data.to);
  ctx.add("inventory", { owner: ctx.member.id, item: prize.data.item, roll });
  return { roll, item: prize.data.item };
}

// Heavier read: sum a member's 1,000-row inventory in the guest.
export function appraise(ctx) {
  const rows = ctx.list("inventory", { owner: ctx.member.id });
  let total = 0;
  for (const row of rows) total += (row.data.value ?? 0);
  return { count: rows.length, total };
}

// Pure CPU: a tight loop of n iterations.
export function spinFor(ctx, { n }) {
  let x = 0;
  for (let i = 0; i < n; i++) x = (x + i) | 0;
  return x;
}

export function spin() { for (;;) {} }
export function spinAfterWrite(ctx) { ctx.set("wallets", ctx.member.id, { balance: 1e9 }); for (;;) {} }
export function hog() { const a = []; for (;;) a.push("x".repeat(1e5) + a.length); }
export function recurse() { return recurse(); }
export function promise() { return Promise.resolve(1); }
export function noSuchCollection(ctx) { return ctx.get("nope", "x"); }
export function badWrite(ctx) { return ctx.set("x", "y", undefined); }

export function probe() {
  return {
    fetch: typeof fetch, require: typeof require, process: typeof process,
    std: typeof std, os: typeof os, WebAssembly: typeof WebAssembly,
    setTimeout: typeof setTimeout, eval: typeof eval, Function: typeof Function,
    mathRandom: typeof Math.random, date: typeof Date.now(),
    host: typeof __host, globals: Object.getOwnPropertyNames(globalThis).sort(),
  };
}

// Is state kept between calls? (It must not be, by default.)
let counter = 0;
export function leak() { globalThis.leaked = (globalThis.leaked ?? 0) + 1; return { counter: ++counter, leaked: globalThis.leaked }; }

// Memory-bomb variants, to find what is slow.
export function hogNumbers() { const a = []; for (;;) a.push(a.length); }
export function hogObjects() { const a = []; for (;;) a.push({ n: a.length }); }
export function hogBigString() { let s = "x"; for (;;) s = s + s; }
export function hogRepeat() { const a = []; for (let i = 0; i < 70; i++) a.push("x".repeat(1e5) + i); return a.length; }
export function hogSized(ctx, { size, concat }) { const a = []; for (;;) a.push(concat ? "x".repeat(size) + a.length : "x".repeat(size)); }
export function hogTimed(ctx, { size }) {
  const a = []; const t0 = Date.now(); let last = t0; const steps = [];
  try { for (;;) { a.push("x".repeat(size)); const n = Date.now(); steps.push(n - last); last = n; } }
  catch (e) { const t1 = Date.now(); a.length = 0; return { pushes: steps.length, slowestPush: Math.max(...steps), toFail: t1 - t0, lastStep: t1 - last, error: String(e) }; }
}
export function bigOnce(ctx, { size }) { const s = "x".repeat(size); return s.length; }
export function bigArray(ctx, { size }) { const a = new Array(size).fill(1); return a.length; }
export function bigBuffer(ctx, { size }) { return new Uint8Array(size).length; }
export function keep(ctx, { n, size }) { const a = []; for (let i = 0; i < n; i++) a.push("x".repeat(size) + i); return a.reduce((t, s) => t + s.length, 0); }
export function keepKind(ctx, { n, kind }) {
  const a = [];
  for (let i = 0; i < n; i++)
    a.push(kind === "repeat" ? "x".repeat(1e6)
      : kind === "concat" ? "x".repeat(1e6) + i
      : kind === "join" ? new Array(1e5).fill("abcdefghij").join("")
      : kind === "bytes" ? new Uint8Array(1e6)
      : new Array(125000).fill(i));
  return a.length;
}
export function catchRecurse() { const f = () => f(); try { f(); } catch (e) { return String(e); } }
export function depth() { let n = 0; const f = () => { n++; f(); }; try { f(); } catch (e) { return { n, e: String(e) }; } }
// Worst case for rows written: overwrite one document until interrupted, or n times.
export function writeForever(ctx) { for (let i = 0; ; i++) ctx.set("junk", "one", { i }); }
export function writeMany(ctx, { n, distinct }) { for (let i = 0; i < n; i++) ctx.set("junk", distinct ? "d" + i : "one", { i }); return n; }
