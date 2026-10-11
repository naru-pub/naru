import { after } from "next/server";
import { runPendingDeploys } from "./githubAppDeploy";

// Kept apart from githubAppDeploy.ts, which the maintenance CLI bundles: the
// CLIs must not import Next.

/**
 * Starts the runner once the response is sent; outside a request (a test, a
 * script) it just starts. The minute job finishes whatever this does not.
 */
export function deployInBackground() {
  const run = () =>
    runPendingDeploys().then(
      () => undefined,
      (error) => console.error("[github-app] deploys failed", error),
    );
  try {
    after(run);
  } catch {
    void run();
  }
}
