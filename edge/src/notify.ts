import { DataError } from "../../control-plane/src/lib/site-data/validation";

// ctx.notify(memberIds, { title, body?, path? }): a notification in the Naru
// app (docs/design/naru-app.md). A mutation queues it in the site's
// _naru_notify_outbox, in the call's transaction; the control plane's
// app-notifications job takes the sites in `notifyPending`, reads their
// outboxes (notifyOutbox), delivers, and acknowledges (ackNotifyOutbox).
//
// The set is this Worker's memory. An object that starts with rows left in
// its outbox (a restart lost the set) adds its site again, so nothing queued
// is lost, only delayed until the site is next used.

/** Sites whose objects have queued notifications. Bounded like breakers'. */
export const notifyPending = new Set<string>();
const MAX_PENDING_SITES = 10_000;

export function markNotifyPending(site: string) {
  if (notifyPending.size < MAX_PENDING_SITES) notifyPending.add(site);
}

/** Recipients one call may name, across its ctx.notify calls. */
export const MAX_NOTIFY_RECIPIENTS = 1000;
/** Rows an outbox holds before ctx.notify refuses (the job has stalled). */
export const MAX_OUTBOX_ROWS = 10_000;
const MEMBER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Notification {
  members: string[];
  title: string;
  body: string;
  path: string;
}

const invalid = (message: string) => new DataError(400, `ctx.notify: ${message}`);

/** ctx.notify's arguments, checked: the guest's values are not trusted. */
export function notification(members: unknown, message: unknown): Notification {
  if (
    !Array.isArray(members) ||
    !members.every((id) => typeof id === "string" && MEMBER.test(id))
  )
    throw invalid("the first argument is a list of member ids.");
  const unique = [...new Set(members as string[])];
  if (unique.length > MAX_NOTIFY_RECIPIENTS)
    throw invalid(`at most ${MAX_NOTIFY_RECIPIENTS} members a call.`);
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw invalid("the second argument is { title, body?, path? }.");
  const { title, body = "", path = "/", ...rest } = message as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length)
    throw invalid(`unknown field ${Object.keys(rest)[0]}.`);
  if (typeof title !== "string" || !title.trim() || title.length > 100)
    throw invalid("title is 1–100 characters.");
  if (typeof body !== "string" || body.length > 500)
    throw invalid("body is at most 500 characters.");
  if (
    typeof path !== "string" ||
    path.length > 1000 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(path)
  )
    throw invalid("path is a path on the site, such as /posts/12.");
  return { members: unique, title, body, path };
}
