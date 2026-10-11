// Drives a running `wrangler dev` (default localhost:8799): correctness and
// sandbox checks, then timings. Usage: node check.mjs [base]
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8799";
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "x-spike-token": process.env.SPIKE_TOKEN ?? "" },
    body: typeof body === "string" ? body : JSON.stringify(body ?? null),
  });
  return response.json();
};
const call = (name, args, query = "") =>
  post(`/call/${name}?member=wallets-0${query}`, args);
const show = (label, value) => console.log(`${label}:`, JSON.stringify(value));
const brief = ({ timings, workerMs, memoryUsed, interruptChecks, hostOps, dateNowAdvanced, ...rest }) => rest;

await post("/deploy", readFileSync(new URL("./fixtures/functions.js", import.meta.url), "utf8"));
const seed = (collection, n, make) =>
  post(`/seed/${collection}`, Array.from({ length: n }, (_, i) => make(i)));
await seed("shop", 300, (i) => ({ price: 100, stock: i === 0 ? 1 : i >= 5 ? 1e6 : 5, value: i }));
await seed("wallets", 1, () => ({ balance: 150 }));
await seed("inventory", 0);
await seed("gacha", 300, (i) => ({ from: i / 3, to: (i + 1) / 3, item: "prize-" + i }));

console.log("== correctness");
const cold = await call("buy", { item: "shop-0" });
show("buy (cold)", cold);
show("buy again", brief(await call("buy", { item: "shop-0" })));
show("buy shop-1, 50 left", brief(await call("buy", { item: "shop-1" })));
show("buyThenThrow", brief(await call("buyThenThrow", { item: "shop-2" })));
show("wallets after", await post("/dump/wallets"));
show("shop-2 after", (await post("/dump/shop")).find((d) => d.id === "shop-2"));
show("inventory after", await post("/dump/inventory"));
show("gacha", brief(await call("gacha")));

console.log("== sandbox");
show("probe", brief(await call("probe")));
show("leak fresh x2", [brief(await call("leak")), brief(await call("leak"))]);
show("leak reuse x2", [brief(await call("leak", null, "&instance=isolate&reuse=1")), brief(await call("leak", null, "&instance=isolate&reuse=1"))]);
for (const name of ["spin", "spinAfterWrite", "hog", "recurse", "catchRecurse", "promise", "noSuchCollection", "badWrite"]) {
  const result = await call(name);
  show(name, { ...brief(result), workerMs: Math.round(result.workerMs), interruptChecks: result.interruptChecks, memoryUsed: result.memoryUsed, dateNowAdvanced: result.dateNowAdvanced });
}
show("wallets after spinAfterWrite", await post("/dump/wallets"));
show("still serving", brief(await call("buy", { item: "nope" })));

console.log("== interrupt calibration (loop iterations per interrupt check)");
for (const n of [1e5, 1e6, 1e7]) {
  const r = await call("spinFor", { n }, "&budget=1000000");
  show(`spinFor ${n}`, { checks: r.interruptChecks, itersPerCheck: Math.round(n / Math.max(1, r.interruptChecks)), callMs: +r.timings.call.toFixed(1), dateNowAdvanced: r.dateNowAdvanced });
}

console.log("== timings (per-call ms, averaged over n calls inside the DO)");
await seed("inventory", 1000, (i) => ({ owner: "wallets-0", item: "x", value: i }));
await seed("wallets", 1, () => ({ balance: 1e9 }));
for (const [name, args] of [
  ["probe", null],
  ["buy", { item: "shop-5" }],
  ["gacha", null],
  ["appraise", null],
  ["spinFor", { n: 1e5 }],
]) {
  const row = {};
  for (const mode of ["call", "isolate", "reuse"]) {
    const r = await post(`/bench/${name}?n=${name === "appraise" ? 50 : 200}&mode=${mode}`, args);
    row[mode] = +r.perCallMs.toFixed(3);
    row.ok = r.last.ok;
  }
  show(name, row);
}
show("cold first call timings", cold.timings);
