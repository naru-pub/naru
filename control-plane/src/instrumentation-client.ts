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

  // Scripts that browsers, in-app browsers and extensions inject into the
  // page, failing on globals of their own hosts.
  ignoreErrors: [
    "__firefox__",
    "window.webkit.messageHandlers",
    "Invalid call to runtime.sendMessage(). Tab not found.",
  ],

  beforeSend(event) {
    return isMonacoInternalError(event) || isFromInjectedScript(event)
      ? null
      : event;
  },
});

// Errors Monaco raises inside itself that nothing of ours causes or can
// handle, with nothing visible broken:
// - deferred work on timers firing after its editor is disposed;
// - Canceled, the rejection of its own cancelled promises, which it leaves
//   unhandled;
// - layout reads on timers after the editor's DOM is gone;
// - its HTML worker's parser recursing too deep on deeply nested markup.
// Monaco reports what it catches by rethrowing it on a timer as
// "message\n\nstack", so only the first line is the message.
const MONACO_INTERNAL_ERRORS = [
  /^AbstractContextKeyService has been disposed$/,
  /^InstantiationService has been disposed$/,
  /^Canceled$/,
  /\boffsetWidth\b/,
  /^Maximum call stack size exceeded$/,
];

function isMonacoInternalError(event: Sentry.ErrorEvent) {
  const exception = event.exception?.values?.[0];
  const message = exception?.value?.split("\n\n")[0];
  if (!message || !MONACO_INTERNAL_ERRORS.some((error) => error.test(message))) {
    return false;
  }
  const frames = exception?.stacktrace?.frames;
  return frames?.at(-1)?.filename?.includes("/monaco-editor") ?? false;
}

// Extensions that wrap the page's functions (fetch, timers) throw from their
// own scripts, served from paths naru.pub has none of.
const INJECTED_SCRIPTS = [/\/executors\/\d+\.js$/, /\/js\/injected\//];

function isFromInjectedScript(event: Sentry.ErrorEvent) {
  return (
    event.exception?.values?.some((exception) =>
      exception.stacktrace?.frames?.some((frame) =>
        INJECTED_SCRIPTS.some((path) => path.test(frame.filename ?? "")),
      ),
    ) ?? false
  );
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
