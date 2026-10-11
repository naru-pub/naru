// The 1.0.0 suite, run against 1.1.0: everything it describes still holds.
process.env.NARU_SDK_VERSION = "1.1.0";
await import("./naru-data-sdk.test.mjs");
