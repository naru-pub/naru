import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { db } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { expireTemplateUploads } from "@/lib/board/template-uploads";

async function deletePrefix(prefix: string) {
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken,
      }),
    );

    const keys =
      response.Contents?.map((object) => object.Key).filter(
        (key): key is string => Boolean(key),
      ) ?? [];

    if (keys.length > 0) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Delete: {
            Objects: keys.map((Key) => ({ Key })),
          },
        }),
      );
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

async function main() {
  const expiredDeployments = await db
    .selectFrom("github_deployments")
    .select(["id", "upload_prefix"])
    .where("status", "=", "planned")
    .where("expires_at", "<=", new Date())
    .execute();

  console.log(
    `[cleanup-expired-github-deployments] ${expiredDeployments.length} expired deployment(s)`,
  );

  for (const deployment of expiredDeployments) {
    try {
      await deletePrefix(deployment.upload_prefix);
      await db
        .updateTable("github_deployments")
        .set({
          status: "expired",
          error_message: "Deployment expired before finalize",
        })
        .where("id", "=", deployment.id)
        .where("status", "=", "planned")
        .execute();

      console.log(
        `[cleanup-expired-github-deployments] expired ${deployment.id}`,
      );
    } catch (error) {
      console.error(
        `[cleanup-expired-github-deployments] failed ${deployment.id}:`,
        error,
      );
    }
  }
}

async function expireTemplates() {
  // A template version's workflow stages its files the same way.
  const count = await expireTemplateUploads();
  console.log(
    `[cleanup-expired-github-deployments] ${count} expired template upload(s)`,
  );
}

main()
  .then(expireTemplates)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[cleanup-expired-github-deployments] fatal:", error);
    process.exit(1);
  });
