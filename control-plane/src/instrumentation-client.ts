// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { announceNavigationStart } from "@/lib/loading-bar";

Sentry.init({
  dsn: "https://abb87d1e259356c7c14ecfee98d1c709@o4504757655764992.ingest.us.sentry.io/4509137772609536",

  // Add optional integrations for additional features
  integrations: [Sentry.replayIntegration()],

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  beforeSend(event) {
    return isMonacoDisposedTimerError(event) ? null : event;
  },
});

// Monaco runs deferred work on timers that can fire after its editor is
// disposed, and then throws "AbstractContextKeyService has been disposed".
// The editor is already gone, so nothing visible breaks.
function isMonacoDisposedTimerError(event: Sentry.ErrorEvent) {
  const exception = event.exception?.values?.[0];
  if (exception?.value !== "AbstractContextKeyService has been disposed") {
    return false;
  }
  const frames = exception.stacktrace?.frames;
  return frames?.at(-1)?.filename?.includes("/monaco-editor@") ?? false;
}

// Next calls this as each client-side navigation begins: link clicks,
// router.push, back and forward. Sentry traces it, and the loading bar under
// the nav starts from it.
export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
) {
  Sentry.captureRouterTransitionStart(url, navigationType);
  announceNavigationStart(url);
}
