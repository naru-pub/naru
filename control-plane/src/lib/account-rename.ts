import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { purgeSite } from "@/lib/cache-purge";
import { LOGIN_NAME_REGEX, isReservedLoginName } from "@/lib/const";
import { deleteObjects, listObjects } from "@/lib/board/storage";
import { eraseSiteData, siteDataWorker } from "@/lib/edge/client";
import { fetchDump, sendDump } from "@/lib/edge/dumps";
import { pushEdgeDomainsSoon } from "@/lib/edge/domains";
import { getSiteScreenshotKey } from "@/lib/site-urls";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";

// Renaming an account (operators only, /admin/users/<login>). The login is
// the site's storage key everywhere, so a rename moves what is kept under it:
//
//   <login>/...                 site bucket (and its _naru/ code, which the
//                               shared S3 client keeps in the private bucket)
//   _screenshots/<login>.png    site bucket
//   _naru-runtime/<login>/...   private bucket: releases, routes, restore points
//   the site's database         the site object named <login> (workerd)
//
// Everything is copied to the new name first, then `users.login_name`
// changes, then the old copies go. A failure before the switch leaves the
// account as it was (the partial copy under the new name is removed); a
// failure after it leaves only stale copies under the old name.
//
// What other tables hold is keyed by the user's id and needs nothing. Not
// carried over: the old address (<old>.naru.pub, r2.naru.pub/<old>/…) stops
// answering, the fediverse actor /users/<old> becomes /users/<new> without a
// Move, and visitors' member sign-ins on the old origin end. Writes the site
// takes while its files and database are copied may be lost, so a rename is
// for a quiet moment. Suspended sites, whose files are in _suspended/, are
// refused.

export class RenameError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const siteBucket = () => process.env.S3_BUCKET_NAME!;
const privateBucket = () => process.env.S3_PRIVATE_BUCKET_NAME!;
const runtimePrefix = (login: string) => `_naru-runtime/${login}/`;

async function copy(bucket: string, from: string, to: string) {
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      // The copy source is a URL path, so each segment is encoded.
      CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
      Key: to,
    }),
  );
}

/** Copies every object under `from` to the same path under `to`. */
async function copyPrefix(bucket: string, from: string, to: string) {
  const objects = await listObjects(from, bucket);
  const targets: string[] = [];
  for (let i = 0; i < objects.length; i += 16) {
    await Promise.all(
      objects.slice(i, i + 16).map(async ({ key }) => {
        const target = to + key.slice(from.length);
        await copy(bucket, key, target);
        targets.push(target);
      }),
    );
  }
  return targets;
}

async function deleteListed(prefix: string, bucket: string) {
  const objects = await listObjects(prefix, bucket);
  await deleteObjects(
    objects.map((object) => object.key),
    bucket,
  );
}

/** Why `name` can't be a new login, or null when it can. */
export function invalidLoginName(name: unknown): string | null {
  if (typeof name !== "string" || !LOGIN_NAME_REGEX.test(name))
    return "아이디는 영문 소문자, 숫자와 하이픈(-)만 쓸 수 있습니다.";
  if (isReservedLoginName(name)) return "예약된 아이디입니다.";
  return null;
}

export type RenameResult = {
  from: string;
  to: string;
  files: number;
  runtimeFiles: number;
  databaseRows: number;
};

export async function renameAccount(
  from: string,
  to: string,
): Promise<RenameResult> {
  const invalid = invalidLoginName(to);
  if (invalid) throw new RenameError(invalid);
  if (from === to) throw new RenameError("지금과 같은 아이디입니다.");
  // Operators are named by login (PAYMENT_OPERATOR_USERS).
  if (PAYMENT_OPERATOR_USERS.has(from))
    throw new RenameError("운영자 계정은 이름을 바꿀 수 없습니다.");

  const user = await db
    .selectFrom("users")
    .select(["id", "site_moderation"])
    .where("login_name", "=", from)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!user) throw new RenameError("계정이 없습니다.", 404);
  if (user.site_moderation === "suspended")
    throw new RenameError("정지된 사이트는 이름을 바꿀 수 없습니다.");
  // Deleted accounts keep their login, so it stays taken.
  const taken = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", to)
    .executeTakeFirst();
  if (taken) throw new RenameError("이미 사용 중인 아이디입니다.", 409);
  // Nothing may already be kept under the new name: it would be mixed in.
  for (const [prefix, bucket] of [
    [`${to}/`, siteBucket()],
    [runtimePrefix(to), privateBucket()],
  ] as const)
    if ((await listObjects(prefix, bucket)).length > 0)
      throw new RenameError(
        `${bucket}/${prefix}에 이미 파일이 있어 이름을 바꿀 수 없습니다.`,
        409,
      );

  const copied: { bucket: string; keys: string[] }[] = [];
  let databaseRows = 0;
  let restored = false;
  try {
    const files = await copyPrefix(siteBucket(), `${from}/`, `${to}/`);
    copied.push({ bucket: siteBucket(), keys: files });
    const screenshots = await listObjects(getSiteScreenshotKey(from));
    for (const { key } of screenshots)
      if (key === getSiteScreenshotKey(from)) {
        await copy(siteBucket(), key, getSiteScreenshotKey(to));
        copied.push({ bucket: siteBucket(), keys: [getSiteScreenshotKey(to)] });
      }
    const runtime = await copyPrefix(
      privateBucket(),
      runtimePrefix(from),
      runtimePrefix(to),
    );
    copied.push({ bucket: privateBucket(), keys: runtime });

    // The whole database, meta (owner, active release) included; `restore`
    // refuses a site that already holds anything.
    const target = siteDataWorker();
    databaseRows = (await sendDump(target, to, await fetchDump(target, from)))
      .rows;
    restored = true;

    const updated = await db
      .updateTable("users")
      .set({ login_name: to })
      .where("id", "=", user.id)
      .where("login_name", "=", from)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1)
      throw new RenameError("계정이 그사이 바뀌었습니다.", 409);

    console.info(
      `Renamed ${from} to ${to}: ${files.length} files, ${runtime.length} runtime objects, ${databaseRows} database rows`,
    );
    // Past the switch: what fails below only leaves stale copies behind.
    await removeOld(from);
    await purgeSite(to).catch((error) =>
      console.error(`Purging ${to} after the rename failed`, error),
    );
    await pushEdgeDomainsSoon();
    return {
      from,
      to,
      files: files.length,
      runtimeFiles: runtime.length,
      databaseRows,
    };
  } catch (error) {
    const switched = await db
      .selectFrom("users")
      .select("login_name")
      .where("id", "=", user.id)
      .executeTakeFirst()
      .then((row) => row?.login_name === to)
      .catch(() => true);
    if (!switched) {
      for (const { bucket, keys } of copied)
        await deleteObjects(keys, bucket).catch((cleanup) =>
          console.error(`Removing the copy under ${to} failed`, cleanup),
        );
      if (restored)
        await eraseSiteData(to).catch((cleanup) =>
          console.error(`Erasing ${to}'s copied database failed`, cleanup),
        );
    }
    throw error;
  }
}

/** Removes what was kept under the old name, once the account has the new. */
async function removeOld(from: string) {
  const steps: [string, () => Promise<unknown>][] = [
    ["files", () => deleteListed(`${from}/`, siteBucket())],
    [
      "screenshot",
      () => deleteObjects([getSiteScreenshotKey(from)], siteBucket()),
    ],
    ["runtime", () => deleteListed(runtimePrefix(from), privateBucket())],
    ["database", () => eraseSiteData(from)],
    ["cache", () => purgeSite(from)],
  ];
  for (const [what, step] of steps)
    await step().catch((error) =>
      console.error(
        `Removing ${from}'s old ${what} after the rename failed`,
        error,
      ),
    );
}
