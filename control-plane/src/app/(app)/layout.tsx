import type { Metadata } from "next";
import Image from "next/image";
import "../(main)/globals.css";
import { fontVariables } from "../fonts";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = { title: "나루 앱 로그인 · 나루" };

// The pages the Naru app opens in the system browser (/app/authorize,
// /app/callback). Their own root layout, not the site's: no navigation or
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
          <div className="bg-background min-h-screen">
            <div className="max-w-md mx-auto px-4 py-8 space-y-6">
              <div className="flex items-center justify-center gap-2.5">
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
              <main>{children}</main>
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
