import type { Metadata } from "next";
import Image from "next/image";
import "../(main)/globals.css";
import { fontVariables } from "../fonts";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = { title: "나루 앱 로그인 · 나루" };

// The pages the Naru app opens in a browser (/app/authorize, /app/callback,
// /app/signup and the documents it links to, /app/account/delete). Their own root layout, not the site's: no navigation or
// footer, so nothing on them leads to the supporter (payment) pages, which
// App Store review doesn't allow the app to reach.
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning className={fontVariables}>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <div className="bg-background min-h-screen pb-8">
            <div className="flex items-center justify-center gap-2.5 px-4 pt-8 pb-6">
              <Image
                src="/logo.png"
                alt=""
                width={32}
                height={32}
                priority
                className="[image-rendering:pixelated]"
                style={{ filter: "var(--logo-filter, none)" }}
              />
              <span className="text-2xl font-bold tracking-tight">나루</span>
            </div>
            {/* The sign-in pages narrow themselves (APP_PANEL); the documents
              take the width they take on the site. */}
            <main>{children}</main>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
