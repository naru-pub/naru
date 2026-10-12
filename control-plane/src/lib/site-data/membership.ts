import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { DataError, uuidId } from "./validation";
import type { AdmissionMode, MembershipStatus } from "./member-auth";

type MemberPage = {
  admission: AdmissionMode;
  members: { id: string; status: MembershipStatus; createdAt: Date }[];
  nextCursor: string | null;
};
export function manageMembership(
  ownerId: string,
  method: "GET",
  body?: Record<string, unknown>,
  after?: string,
): Promise<MemberPage>;
export function manageMembership(
  ownerId: string,
  method: string,
  body?: Record<string, unknown>,
  after?: string,
): Promise<
  | MemberPage
  | { admission: AdmissionMode }
  | { id: string; status: MembershipStatus }
>;
export async function manageMembership(
  ownerId: string,
  method: string,
  body: Record<string, unknown> = {},
  after?: string,
) {
  if (!(await userHasFeature(ownerId, "database")))
    throw new DataError(403, "Database access is not enabled for this site.");
  if (method === "GET") {
    const settings = await db
      .selectFrom("users")
      .select("site_member_admission")
      .where("id", "=", ownerId)
      .executeTakeFirstOrThrow();
    let query = db
      .selectFrom("site_members")
      .select(["id", "status", "created_at"])
      .where("site_user_id", "=", ownerId)
      .orderBy("id")
      .limit(101);
    if (after) query = query.where("id", ">", uuidId(after));
    const rows = await query.execute();
    const members = rows.slice(0, 100).map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
    }));
    return {
      admission: settings.site_member_admission,
      members,
      nextCursor: rows.length > 100 ? members.at(-1)!.id : null,
    };
  }
  if (method !== "PATCH") throw new DataError(405, "Method not allowed.");
  const keys = Object.keys(body);
  if (
    keys.length === 1 &&
    keys[0] === "admission" &&
    typeof body.admission === "string" &&
    ["open", "approval", "closed"].includes(String(body.admission))
  ) {
    const admission = body.admission as AdmissionMode;
    await db
      .updateTable("users")
      .set({ site_member_admission: admission })
      .where("id", "=", ownerId)
      .execute();
    return { admission };
  }
  if (
    keys.length !== 2 ||
    !keys.includes("id") ||
    !keys.includes("status") ||
    typeof body.status !== "string" ||
    !["pending", "approved", "banned"].includes(String(body.status))
  )
    throw new DataError(400, "Provide admission, or a member id and status.");
  const id = uuidId(body.id);
  const status = body.status as MembershipStatus;
  return db.transaction().execute(async (tx) => {
    // Same lock as admission at sign-in: a concurrent sign-in cannot undo a ban.
    await tx
      .selectFrom("users")
      .select("id")
      .where("id", "=", ownerId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const member = await tx
      .updateTable("site_members")
      .set({ status })
      .where("site_user_id", "=", ownerId)
      .where("id", "=", id)
      .returning(["id", "status"])
      .executeTakeFirst();
    if (!member) throw new DataError(404, "Member not found.");
    return member;
  });
}
