/** @jest-environment node */
import { expect, jest, test, beforeEach } from "@jest/globals";
jest.mock("@/lib/s3", () => ({ s3Client: { send: jest.fn() } }));
const { s3Client } = jest.requireMock<typeof import("@/lib/s3")>("@/lib/s3");
const { deleteRevision, deleteSiteRuntime } = jest.requireActual<
  typeof import("@/lib/site-functions/storage")
>("@/lib/site-functions/storage");
const send = jest.mocked(s3Client.send) as unknown as jest.Mock<
  (command: any) => Promise<any>
>;
beforeEach(() => {
  send.mockReset();
});
test("deletes only one revision, handles pagination and keeps the task lease alive", async () => {
  const prefix = `_naru-runtime/alice/revisions/${"a".repeat(64)}/`;
  const calls: any[] = [];
  send.mockImplementation(async (command) => {
    calls.push(command);
    if (command.constructor.name === "ListObjectsV2Command") {
      expect(command.input.Prefix).toBe(prefix);
      expect(command.input.Bucket).toBe("test-private-bucket");
      return command.input.ContinuationToken
        ? { Contents: [{ Key: prefix + "manifest.json", ETag: "m", Size: 1 }] }
        : {
            Contents: [
              { Key: prefix + "modules/shared.js", ETag: "s", Size: 1 },
            ],
            IsTruncated: true,
            NextContinuationToken: "next",
          };
    }
    return {};
  });
  const heartbeat = jest.fn<() => Promise<void>>().mockResolvedValue();
  await deleteRevision("alice", "a".repeat(64), heartbeat);
  expect(
    calls
      .filter((command) => command.constructor.name === "DeleteObjectsCommand")
      .flatMap((command) => command.input.Delete.Objects),
  ).toEqual([
    { Key: prefix + "modules/shared.js" },
    { Key: prefix + "manifest.json" },
  ]);
  expect(heartbeat).toHaveBeenCalledTimes(4);
});
test("partial S3 deletion failures are retried rather than acknowledged", async () => {
  send
    .mockResolvedValueOnce({ Contents: [{ Key: "one", ETag: "e", Size: 1 }] })
    .mockResolvedValueOnce({ Errors: [{ Code: "AccessDenied" }] });
  await expect(
    deleteRevision("alice", "a".repeat(64), async () => {}),
  ).rejects.toThrow("AccessDenied");
});

test("an account's deletion takes every key under its _naru-runtime/ folder from the private bucket", async () => {
  const prefix = "_naru-runtime/alice/";
  const deleted: string[] = [];
  send.mockImplementation(async (command) => {
    expect(command.input.Bucket).toBe("test-private-bucket");
    if (command.constructor.name === "ListObjectsV2Command") {
      expect(command.input.Prefix).toBe(prefix);
      return command.input.ContinuationToken
        ? {
            Contents: [
              {
                Key: prefix + "restore-points/manual-1.ndjson.gz",
                ETag: "r",
                Size: 1,
              },
            ],
          }
        : {
            Contents: [{ Key: prefix + "routes.json", ETag: "j", Size: 1 }],
            IsTruncated: true,
            NextContinuationToken: "next",
          };
    }
    deleted.push(...command.input.Delete.Objects.map((o: any) => o.Key));
    return {};
  });
  await deleteSiteRuntime("alice");
  expect(deleted).toEqual([
    prefix + "routes.json",
    prefix + "restore-points/manual-1.ndjson.gz",
  ]);
  await expect(deleteSiteRuntime("../bob")).rejects.toThrow();
});
