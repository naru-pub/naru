import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import SignUpForm from "@/components/SignUpForm";
import { appSignInRequest } from "../authorize/request";

export const metadata: Metadata = { title: "회원가입 · 나루" };

// Where the Naru app's 나루 계정 만들기 opens its sign-in, with the request
// /app/authorize takes: signing up goes on to connect the app there.
export default async function AppSignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { query, input } = await appSignInRequest(searchParams);
  const signIn = input ? `/app/authorize?${query}` : undefined;
  // Already signed in to naru.pub: nothing to sign up for.
  if (signIn && (await validateRequest()).user) redirect(signIn);
  return (
    <div className="max-w-md mx-4 sm:mx-auto">
      <SignUpForm app signIn={signIn} />
    </div>
  );
}
