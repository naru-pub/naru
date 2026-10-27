import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// One instance shared by every documentation page, so a language is registered
// once no matter how many blocks a page renders.
const highlighter = hljs.newInstance();
highlighter.registerLanguage("bash", bash);
highlighter.registerLanguage("javascript", javascript);
highlighter.registerLanguage("json", json);
highlighter.registerLanguage("sql", sql);
highlighter.registerLanguage("typescript", typescript);
highlighter.registerLanguage("xml", xml);
highlighter.registerLanguage("yaml", yaml);

export const LANGUAGE_LABELS = {
  javascript: "JavaScript",
  json: "JSON",
  html: "HTML",
  typescript: "TypeScript",
  sql: "SQL",
  bash: "Shell",
  yaml: "YAML",
} as const;

export type Language = keyof typeof LANGUAGE_LABELS;

/** Escapes the source and wraps its tokens in highlight.js spans. */
export const highlight = (code: string, language: Language) =>
  highlighter.highlight(code, {
    language: language === "html" ? "xml" : language,
  }).value;
