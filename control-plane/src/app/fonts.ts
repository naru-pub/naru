import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";

// Shared by both root layouts. Korean comes in ~100 unicode-range slices per
// weight; the browser fetches only the ones a page uses, so nothing is
// preloaded.
const sans = IBM_Plex_Sans_KR({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  preload: false,
});
const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const fontVariables = `${sans.variable} ${mono.variable}`;
