// Production timings. Inside a Worker the clock stops while code runs, so a
// Durable Object can't time itself: the Worker times one RPC that makes n
// calls inside the object, minus one empty RPC. Usage: node measure.mjs base
const base = process.argv[2];
const headers = { "x-spike-token": process.env.SPIKE_TOKEN ?? "" };
const post = async (path, body, site = "spike") => {
  const t = performance.now();
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}site=${site}`, {
    method: "POST", headers, body: JSON.stringify(body ?? null),
  });
  const text = await response.text();
  try { return { ...JSON.parse(text), clientMs: performance.now() - t }; }
  catch { return { status: response.status, text: text.slice(0, 300), clientMs: performance.now() - t }; }
};
const show = (label, value) => console.log(`${label}:`, JSON.stringify(value));
const r1 = (x) => Math.round(x * 1000) / 1000;

console.log("== cold start");
const fresh = `cold-${Date.now()}`;
const { readFileSync } = await import("node:fs");
const source = readFileSync(new URL("./fixtures/functions.js", import.meta.url), "utf8");
const deploy = (site) => fetch(`${base}/deploy?site=${site}`, { method: "POST", headers, body: source });
await deploy(fresh);
const cold = await post("/call/probe", null, fresh);
show("first call on a new object", { workerMs: r1(cold.workerMs), clientMs: Math.round(cold.clientMs), timings: cold.timings });
const warm = await post("/call/probe", null, fresh);
show("second call", { workerMs: r1(warm.workerMs), clientMs: Math.round(warm.clientMs), timings: warm.timings, dateNowAdvanced: warm.dateNowAdvanced });

console.log("== frozen clock");
const spin = await post("/call/spin", null, fresh);
show("spin (budget 2000 checks)", { error: spin.error?.message, checks: spin.interruptChecks, dateNowAdvancedInDO: spin.dateNowAdvanced, workerMs: Math.round(spin.workerMs) });

console.log("== per-call cost: (bench RPC - empty RPC) / n");
const seed = (collection, n, make, site = "spike") =>
  post(`/seed/${collection}`, Array.from({ length: n }, (_, i) => make(i)), site);
await deploy("spike");
await seed("shop", 300, (i) => ({ price: 100, stock: 1e6, value: i }));
await seed("gacha", 300, (i) => ({ from: i / 3, to: (i + 1) / 3, item: "prize-" + i }));
await seed("inventory", 1000, () => ({ owner: "wallets-0", item: "x", value: 1 }));
await seed("wallets", 1, () => ({ balance: 1e12 }));
const rpcs = [];
for (let i = 0; i < 20; i++) rpcs.push((await post("/noop")).rpcMs);
const rpc = rpcs.sort((a, b) => a - b)[10];
show("empty RPC worker→DO (median)", r1(rpc));
for (const [name, args, n] of [
  ["probe", null, 300], ["buy", { item: "shop-5" }, 300], ["gacha", null, 300],
  ["appraise", null, 100], ["spinFor", { n: 1e5 }, 100], ["spin", null, 20],
]) {
  const row = {};
  for (const mode of ["call", "reuse"]) {
    const samples = [];
    for (let k = 0; k < 3; k++) {
      const r = await post(`/bench/${name}?n=${n}&mode=${mode}`, args);
      if (r.workerMs === undefined) { row[mode] = r; break; }
      samples.push((r.workerMs - rpc) / n);
      row.inDOClock = r1(r.perCallMs);
    }
    row[mode] = r1(Math.min(...samples));
  }
  show(name, row);
}

console.log("== memory cap and stack in production");
for (const [label, path] of [
  ["hog, 32 MiB cap", "/call/hog"],
  ["keepKind repeat x100, 32 MiB cap", "/call/keepKind"],
]) {
  const r = await post(path, label.startsWith("keep") ? { n: 100, kind: "repeat" } : null);
  show(label, { ok: r.ok, error: r.error?.message ?? r.error, workerMs: Math.round(r.workerMs ?? -1), status: r.status, text: r.text });
}
for (const stack of [262144, 327680, 393216, 524288, 1048576]) {
  const r = await post(`/call/depth?stack=${stack}`);
  show(`depth, stack ${stack / 1024} KiB`, { ok: r.ok, value: r.value, error: r.error?.message ?? r.error, status: r.status });
}
