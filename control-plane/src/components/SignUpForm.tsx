"use client";

import Link from "next/link";

import { safeNextPath } from "@/lib/next-path";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { isReservedLoginName, LOGIN_NAME_REGEX } from "@/lib/const";

const formSchema = z
  .object({
    username: z
      .string()
      .regex(LOGIN_NAME_REGEX, {
        message:
          "아이디는 영문 소문자, 숫자, 하이픈(-)만 사용할 수 있으며, 하이픈은 연속으로 사용할 수 없습니다.",
      })
      .min(2, {
        message: "아이디는 2자 이상이어야 합니다.",
      })
      .max(50, {
        message: "아이디는 50자 이하여야 합니다.",
      })
      .refine((value) => !value.startsWith("-") && !value.endsWith("-"), {
        message: "아이디는 하이픈으로 시작하거나 끝날 수 없습니다.",
      })
      .refine((value) => !isReservedLoginName(value), {
        message: "사용할 수 없는 아이디입니다.",
      }),
    password: z.string().min(8, {
      message: "비밀번호는 8자 이상이어야 합니다.",
    }),
    passwordConfirm: z.string().min(8, {
      message: "비밀번호는 8자 이상이어야 합니다.",
    }),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "비밀번호가 일치하지 않습니다.",
    path: ["passwordConfirm"],
  });

const usernamePlaceholder = "example";

// The sign-up form of /signup and of /app/signup, the page the Naru app opens.
// In the app's version the agreements link to the app's copies of the
// documents, and signing up goes on to signIn, the app's /app/authorize, which
// then asks to connect the app; without one (the app's releases that opened
// /app/signup in a browser) it ends on this page instead of leading into the
// site.
export default function SignUpForm({
  app = false,
  signIn,
}: {
  app?: boolean;
  signIn?: string;
}) {
  const [signedUp, setSignedUp] = useState("");
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: "",
      password: "",
      passwordConfirm: "",
    },
  });

  // The front page's address box sends the name it was given here.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "username",
    );
    if (requested) {
      form.setValue("username", requested.trim().toLowerCase());
    }
  }, [form]);

  // react-hook-form's watch() is opaque to the React Compiler, which reports a
  // skipped compilation rather than a defect. The live domain preview needs it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const username = form.watch("username");
  const domain = `${username === "" ? usernamePlaceholder : username}.${
    process.env.NEXT_PUBLIC_DOMAIN
  }`;

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const response = await fetch("/api/account/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          login_name: values.username,
          password: values.password,
        }),
      });

      const res = await response.json();
      if (res.success && signIn) {
        window.location.assign(signIn);
      } else if (res.success && app) {
        setSignedUp(values.username);
      } else if (res.success) {
        window.location.href =
          safeNextPath(
            new URLSearchParams(window.location.search).get("next"),
          ) ?? "/";
      } else {
        form.setError("username", {
          type: "manual",
          message: res.message,
        });
      }
    } catch (error) {
      form.setError("username", {
        type: "manual",
        message: "가입 중 오류가 발생했습니다.",
      });
    }
  }

  if (signedUp)
    return (
      <div className="bg-card border-2 border-line rounded-lg p-6 space-y-3">
        <h1 className="text-2xl font-bold">가입했습니다</h1>
        <p>
          <strong>{signedUp}</strong> 계정을 만들었습니다. 나루 앱으로 돌아가
          로그인해 주세요.
        </p>
      </div>
    );
  const docs = app ? "/app" : "";

  return (
    <div className={app ? "" : "max-w-md mx-auto p-6"}>
      <div className="bg-card border-2 border-line rounded-lg p-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">회원가입</h1>
          <p className="text-muted-foreground">
            나루에서 당신만의 웹 공간을 만드세요
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground font-medium">
                    아이디
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={usernamePlaceholder}
                      autoCapitalize="none"
                      {...field}
                      className="border-border focus:border-primary bg-card"
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground text-sm">
                    로그인과 홈페이지 도메인에 사용될 아이디입니다. ({domain})
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground font-medium">
                    비밀번호
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      {...field}
                      className="border-border focus:border-primary bg-card"
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground text-sm">
                    비밀번호는 8자 이상이어야 합니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="passwordConfirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground font-medium">
                    비밀번호 확인
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      {...field}
                      className="border-border focus:border-primary bg-card"
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground text-sm">
                    위에서 입력한 비밀번호를 한 번 더 입력해주세요.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary/90 text-white border border-primary font-medium"
            >
              회원 가입
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              가입하시면{" "}
              <Link href={`${docs}/policy`} className="text-primary underline">
                커뮤니티 가이드라인
              </Link>
              을 지키는 데 동의하신 것으로 봅니다. 개인정보는{" "}
              <Link href={`${docs}/privacy`} className="text-primary underline">
                개인정보 처리방침
              </Link>
              에 따라 처리합니다.
            </p>
            {signIn && (
              <p className="text-sm text-muted-foreground text-center">
                이미 계정이 있나요?{" "}
                <Link href={signIn} className="text-link underline">
                  로그인
                </Link>
              </p>
            )}
          </form>
        </Form>
      </div>
    </div>
  );
}
