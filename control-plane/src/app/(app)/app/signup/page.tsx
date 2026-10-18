import type { Metadata } from "next";
import SignUpForm from "@/components/SignUpForm";

export const metadata: Metadata = { title: "회원가입 · 나루" };

// Where the Naru app's 나루 계정 만들기 opens.
export default function AppSignUpPage() {
  return (
    <div className="max-w-md mx-4 sm:mx-auto">
      <SignUpForm app />
    </div>
  );
}
