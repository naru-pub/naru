import type { BrowserContext, Page } from "playwright";

// The apps' site icons, rendered by update-screenshots from the page it holds
// open for the screenshot. The code that runs in the page is a string: tsx
// (esbuild's keepNames) wraps named functions in a __name helper the page
// doesn't have.

// The icon's side in CSS pixels; the context's 2x scale makes the PNG 128px.
const ICON_SIZE = 64;

// The page's icon links, best first (declared size, apple-touch-icon ahead),
// then /favicon.ico.
const ICON_CANDIDATES = `(() => {
  const score = (link) => {
    const sizes = (link.sizes && link.sizes.value) || "";
    const size = sizes === "any" ? 1024
      : Math.max(0, ...sizes.split(/\\s+/).map((s) => parseInt(s, 10) || 0));
    return size + (/apple-touch-icon/i.test(link.rel) ? 180 : 0);
  };
  const links = [...document.querySelectorAll("link[rel][href]")]
    .filter((link) => /(^|\\s)(icon|apple-touch-icon(-precomposed)?)(\\s|$)/i.test(link.rel))
    .map((link) => ({ href: link.href, score: score(link) }))
    .sort((a, b) => b.score - a.score)
    .map((link) => link.href);
  return [...links, new URL("/favicon.ico", location.href).href]
    .filter((href) => /^https?:/.test(href));
})()`;

// Loads one image into the canvas page's <img>; true once it shows.
const LOAD_IMAGE = (src: string) => `new Promise((resolve) => {
  const img = document.querySelector("img");
  const timer = setTimeout(() => resolve(false), 5000);
  img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0); };
  img.onerror = () => { clearTimeout(timer); resolve(false); };
  img.src = ${JSON.stringify(src)};
})`;

/**
 * The page's icon as a square PNG: the largest of its apple-touch-icon and
 * icon links, else /favicon.ico. Drawn by Chromium on a transparent page, so
 * any format it shows (ICO, SVG, PNG, WebP) comes out as PNG; null when the
 * site has none that loads.
 */
export async function renderIcon(context: BrowserContext, page: Page) {
  const candidates = (await page.evaluate(ICON_CANDIDATES)) as string[];
  const canvas = await context.newPage();
  try {
    await canvas.setViewportSize({ width: ICON_SIZE, height: ICON_SIZE });
    for (const href of [...new Set(candidates)]) {
      await canvas.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block;width:${ICON_SIZE}px;height:${ICON_SIZE}px;object-fit:contain}</style><img>`,
      );
      const loaded = await canvas.evaluate(LOAD_IMAGE(href)).catch(() => false);
      if (loaded === true) return await canvas.screenshot({ omitBackground: true });
    }
    return null;
  } finally {
    await canvas.close();
  }
}
