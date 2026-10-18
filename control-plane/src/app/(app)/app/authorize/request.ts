import { authorizeInput } from "@/lib/app-api/tokens";

const FIELDS = [
  "client",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
];

// The app's sign-in request, as /app/authorize and /app/signup are opened
// with it: only the recognized scalar fields, so a page never carries or
// redirects with anything else. input is null when the request is not valid.
export async function appSignInRequest(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of FIELDS)
    if (typeof params[key] === "string") query.set(key, params[key]);
  try {
    return {
      query: query.toString(),
      input: authorizeInput(Object.fromEntries(query)),
    };
  } catch {
    return { query: query.toString(), input: null };
  }
}
