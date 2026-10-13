/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  jsonBody,
  MAX_DOCUMENT_BYTES,
  functionModule,
  functionReference,
} from "../validation";

describe("request validation", () => {
  test("rejects oversized bodies without Content-Length", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(MAX_DOCUMENT_BYTES) }),
    });
    await expect(jsonBody(request)).rejects.toMatchObject({ status: 413 });
  });
  test.each(["[]", "null", "{"])(
    "rejects malformed envelope %s",
    async (body) => {
      await expect(
        jsonBody(
          new Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});

describe("nested function references", () => {
  test("separates the module path from its export", () => {
    expect(functionReference("community/boards:list")).toEqual({
      file: "community/boards",
      fn: "list",
    });
    expect(functionModule("shop/cart")).toBe("shop/cart");
  });
  test.each([
    "../shop:buy",
    "shop/../cart:buy",
    "shop/./cart:buy",
    "shop//cart:buy",
    "/shop:buy",
    "shop/:buy",
    "shop:buy:more",
    "shop\\cart:buy",
    "shop/%2f:buy",
    "shop:buy/other",
    "shop/buy",
    "shop:",
    ":buy",
  ])("rejects %s", (value) => {
    expect(() => functionReference(value)).toThrow();
  });
});
