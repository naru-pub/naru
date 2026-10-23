import { format as prettierFormat } from "prettier/standalone";
import prettierPluginHtml from "prettier/plugins/html";
import prettierPluginCss from "prettier/plugins/postcss";
import prettierPluginBabel from "prettier/plugins/babel";
import prettierPluginEstree from "prettier/plugins/estree";
import prettierPluginMarkdown from "prettier/plugins/markdown";
import { extensionOf } from "./file-tree";

const PRETTIER_PARSER_MAP: Record<string, { parser: string; plugins: any[] }> =
  {
    html: { parser: "html", plugins: [prettierPluginHtml] },
    htm: { parser: "html", plugins: [prettierPluginHtml] },
    xhtml: { parser: "html", plugins: [prettierPluginHtml] },
    xml: { parser: "html", plugins: [prettierPluginHtml] },
    svg: { parser: "html", plugins: [prettierPluginHtml] },
    css: { parser: "css", plugins: [prettierPluginCss] },
    js: {
      parser: "babel",
      plugins: [prettierPluginBabel, prettierPluginEstree],
    },
    mjs: {
      parser: "babel",
      plugins: [prettierPluginBabel, prettierPluginEstree],
    },
    json: {
      parser: "json",
      plugins: [prettierPluginBabel, prettierPluginEstree],
    },
    md: { parser: "markdown", plugins: [prettierPluginMarkdown] },
    markdown: { parser: "markdown", plugins: [prettierPluginMarkdown] },
    mdx: { parser: "mdx", plugins: [prettierPluginMarkdown] },
  };

export const canFormat = (path: string) => extensionOf(path) in PRETTIER_PARSER_MAP;

/** The file's text as Prettier formats it; throws on a syntax error. */
export function formatCode(path: string, text: string) {
  const config = PRETTIER_PARSER_MAP[extensionOf(path)];
  if (!config) throw new Error("이 파일 형식은 포맷을 지원하지 않습니다");
  return prettierFormat(text, config);
}
