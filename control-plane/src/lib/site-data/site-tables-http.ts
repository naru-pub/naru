import { validateRequest } from "@/lib/auth";
import { callSiteObject } from "@/lib/edge/client";
import { siteOf } from "@/lib/site-functions/restore";
import {
  DataError,
  protocolError,
  sameOrigin,
  withRetryAfter,
} from "./validation";

/** A table or view of the site's own (1.1.0), as the object lists them. */
export type SiteTable = {
  name: string;
  view: boolean;
  columns: { name: string; type: string; nullable: boolean }[];
};
/** A value as a page shows it (edge/src/table-rows.ts). */
export type TableCell =
  null | number | string | { blob: number } | { text: string; length: number };
export type TableRowsPage = {
  table: string;
  columns: string[];
  rows: TableCell[][];
  next: number | null;
  count?: { rows: number; more: boolean };
};

/**
 * The owner's view of the site's own tables on the control panel, read
 * only: GET lists them, GET `?table=<name>&after=<next>` is a page of one
 * (`tableRows`, edge/src/table-rows.ts). Same origin and the owner's
 * session only, as restore points (restore-points-http.ts).
 */
export async function siteTablesOwnerRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user) throw new DataError(401, "Sign in required.");
    const site = await siteOf(user.id);
    const params = new URL(request.url).searchParams;
    const table = params.get("table");
    if (table === null)
      return Response.json(
        { tables: await callSiteObject<SiteTable[]>(site, "siteTables", {}) },
        { headers },
      );
    const after = params.get("after");
    if (after !== null && !/^-?\d{1,16}$/.test(after))
      throw new DataError(400, "after must be the last page's next.");
    return Response.json(
      await callSiteObject<TableRowsPage>(site, "tableRows", {
        table,
        ...(after === null ? {} : { after: Number(after) }),
      }),
      { headers },
    );
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        withRetryAfter(headers, error.retryAfter),
      );
    console.error("Site table request failed", error);
    return protocolError(500, "Site table request failed.", undefined, headers);
  }
}
