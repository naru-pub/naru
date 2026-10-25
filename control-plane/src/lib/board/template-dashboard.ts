// The developer portal's 내 템플릿 page: what Naru records of the templates
// a person published and their workflow runs, beside what the template's
// post shows (getTemplateForPost). Installs are not shown yet.
import { db } from "@/lib/database";
import { getTemplateForPost, type TemplateDetail } from "./templates";

// The workflow runs shown, newest first.
const RUNS_SHOWN = 5;

export type WorkflowRun = {
  id: string;
  createdAt: Date;
  sha: string;
  // published: made `version`; unchanged: the latest version's files again,
  // so no new version; planned: uploading, or not finalized yet.
  outcome: "published" | "unchanged" | "planned" | "failed" | "expired";
  version: number | null;
  error: string | null;
};

export interface TemplateDashboard {
  postId: string;
  title: string;
  template: TemplateDetail;
  runs: WorkflowRun[];
}

/** The templates `userId` published, newest first, to pick one from. */
export async function publishedTemplates(
  userId: string,
): Promise<{ postId: string; title: string }[]> {
  return db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select(["p.id as postId", "p.title"])
    .where("t.user_id", "=", userId)
    .where("p.deleted_at", "is", null)
    .orderBy("p.created_at", "desc")
    .execute();
}

/** `userId`'s template posted as `postId`, with its workflow runs. */
export async function templateDashboard(
  userId: string,
  postId: string,
): Promise<TemplateDashboard | null> {
  const post = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select(["t.id", "p.title"])
    .where("t.user_id", "=", userId)
    .where("p.id", "=", postId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!post) return null;

  const [template, runs] = await Promise.all([
    getTemplateForPost(postId),
    db
      .selectFrom("board_template_uploads as u")
      .leftJoin("board_template_versions as v", "v.id", "u.version_id")
      .select([
        "u.id",
        "u.created_at",
        "u.github_sha",
        "u.status",
        "u.error_message",
        "v.version",
        "v.created_at as version_created_at",
      ])
      .where("u.template_id", "=", post.id)
      .orderBy("u.created_at", "desc")
      .limit(RUNS_SHOWN)
      .execute(),
  ]);
  if (!template) return null;

  return {
    postId,
    title: post.title,
    template,
    runs: runs.map((run) => ({
      id: run.id,
      createdAt: run.created_at,
      sha: run.github_sha,
      outcome:
        run.status !== "finalized"
          ? run.status
          : // A run that made no version points at the one already there.
            run.version_created_at && run.version_created_at < run.created_at
            ? "unchanged"
            : "published",
      version: run.version,
      error: run.error_message,
    })),
  };
}
