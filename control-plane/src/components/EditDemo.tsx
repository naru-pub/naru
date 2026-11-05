"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { BrowserFrame, SiteAddress } from "@/components/BrowserFrame";
import { Button } from "@/components/ui/button";

// The home page's picture of the file editor, beside AskDemo's picture of the
// AI apps: the same sample site, written by hand. It's a small stand-in rather
// than the real editor, whose Monaco is far too much for the page every visitor
// loads. Nothing leaves the browser, and what a visitor types runs in a frame
// sandboxed against scripts.
const FILES = {
  "index.html": `<link rel="stylesheet" href="style.css">

<h1>안녕하세요, 하루예요</h1>
<p>좋아하는 책과 동네 산책 이야기를
천천히 적어 두는 곳이에요.</p>

<a href="books.html">책장</a>
<a href="walks.html">산책 지도</a>
`,
  "style.css": `body {
  margin: 28px 24px;
  background: #FFFFFF;
  color: #111318;
  font: 14px/1.9 sans-serif;
  word-break: keep-all;
}

h1 {
  font-size: 24px;
  line-height: 1.3;
}

a {
  display: block;
  color: #1E48D6;
}
`,
};

type FileName = keyof typeof FILES;
const FILE_NAMES = Object.keys(FILES) as FileName[];

// As a site's own page does, the HTML takes the stylesheet from its link, so
// removing the link removes the styles. Links open nowhere: the frame may not
// open a window, and without this they'd navigate it to a page of ours.
function renderSite(files: typeof FILES) {
  const page = files["index.html"].replace(
    /<link[^>]*style\.css[^>]*>/,
    () => `<style>${files["style.css"]}</style>`,
  );
  return `<!doctype html><base target="_blank"><meta charset="utf-8">${page}`;
}

// One capture group per kind of token, in TOKEN_KINDS' order.
const HTML_TOKENS =
  /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w-]*|\/?>)|("[^"]*")|([a-zA-Z-]+(?==))/g;
const CSS_TOKENS =
  /(\/\*[\s\S]*?\*\/)|([^{};\s][^{};]*(?=\{))|("[^"]*"|#[0-9a-fA-F]{3,8}\b)|([a-z-]+(?=\s*:))/g;

const TOKEN_KINDS = [
  "text-muted-foreground", // comment
  "font-semibold text-primary", // tag, selector
  "text-link", // string, colour
  "text-muted-foreground", // attribute, property
];

function Highlighted({ code, file }: { code: string; file: FileName }) {
  const pieces: React.ReactNode[] = [];
  let position = 0;
  const tokens = file.endsWith(".css") ? CSS_TOKENS : HTML_TOKENS;
  for (const match of code.matchAll(tokens)) {
    const kind = match.slice(1).findIndex((group) => group !== undefined);
    pieces.push(
      <Fragment key={`text-${match.index}`}>
        {code.slice(position, match.index)}
      </Fragment>,
      <span key={`token-${match.index}`} className={TOKEN_KINDS[kind]}>
        {match[0]}
      </span>,
    );
    position = match.index + match[0].length;
  }
  pieces.push(<Fragment key="rest">{code.slice(position)}</Fragment>);
  return pieces;
}

// Textarea over the same text in colour, so the type has to match exactly.
const CODE_TYPE =
  "whitespace-pre font-mono text-base leading-6 md:text-[13px] md:leading-6";

/** `href` is where the button leads: the editor, through signup if need be. */
export function EditDemo({ href }: { href: string }) {
  const [file, setFile] = useState<FileName>("index.html");
  const [drafts, setDrafts] = useState(FILES);
  const [saved, setSaved] = useState(FILES);

  const code = drafts[file];
  const isDirty = (name: FileName) => drafts[name] !== saved[name];
  const dirty = FILE_NAMES.some(isDirty);
  const changed = FILE_NAMES.some((name) => drafts[name] !== FILES[name]);
  const lines = code.split("\n").length;

  return (
    <section
      id="edit"
      aria-labelledby="edit-heading"
      className="mx-auto flex max-w-7xl scroll-mt-20 flex-row-reverse flex-wrap items-center gap-14 px-4 py-14 sm:px-6 lg:px-8"
    >
      <div className="flex min-w-0 flex-[1_1_400px] flex-col gap-6">
        <p className="flex items-center gap-2.5 text-sm font-medium text-muted-foreground">
          <span aria-hidden="true" className="size-2.5 bg-primary" />
          직접 만들기
        </p>
        <h2
          id="edit-heading"
          className="text-[clamp(2rem,4vw,3.25rem)] font-bold leading-[1.16] tracking-[-0.035em]"
        >
          <span className="highlight">저장</span>하면
          <br />
          바로 공개돼요
        </h2>
        <p className="max-w-[30em] text-[17px] leading-relaxed text-muted-foreground">
          프로그램을 설치하지 않아도 돼요. 브라우저의 편집기에서 내 사이트의
          파일을 열고, 고치고, 바로 확인하세요.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild size="lg">
            <Link href={href}>편집기 열기 →</Link>
          </Button>
          <p className="text-sm text-muted-foreground">HTML, CSS, JS 등</p>
        </div>
        <p className="border-t-2 border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          자동 완성과 코드 정리, 저장 전 변경 사항 보기를 갖췄어요. 이미 만든
          파일은 끌어다 놓으면 올라가요.
        </p>
      </div>

      <div className="flex min-w-0 flex-[1.25_1_520px] flex-col gap-4">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            이름을 바꾸고 저장해 보세요
          </p>
          {changed && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDrafts(FILES);
                setSaved(FILES);
              }}
            >
              처음으로
            </Button>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(270px,100%),1fr))] items-stretch gap-4">
          <div className="flex min-w-0 flex-col border-2 border-line bg-card md:min-h-[400px]">
            <div className="flex h-7 items-center justify-between border-b-2 border-line px-3 text-xs font-medium">
              <span>파일 편집기</span>
              <span
                aria-live="polite"
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className={`size-2 ${dirty ? "bg-sun" : "bg-primary"}`}
                />
                {dirty ? "저장 안 됨" : "저장됨"}
              </span>
            </div>
            <div className="flex items-stretch justify-between gap-2 border-b-2 border-border pr-1.5">
              <div className="flex min-w-0">
                {FILE_NAMES.map((name) => (
                  <Button
                    key={name}
                    type="button"
                    variant="ghost"
                    onClick={() => setFile(name)}
                    aria-pressed={name === file}
                    className={`h-11 px-3 font-mono text-xs ${
                      name === file ? "bg-accent" : "text-muted-foreground"
                    }`}
                  >
                    {name}
                    {isDirty(name) && <span aria-label="저장 안 됨"> ●</span>}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setSaved(drafts)}
                disabled={!dirty}
                className="my-1.5"
              >
                저장
              </Button>
            </div>
            <div className="flex h-80 min-h-0 flex-1 overflow-auto">
              <div
                aria-hidden="true"
                className={`sticky left-0 z-10 h-fit min-h-full shrink-0 select-none bg-card py-3 pl-3 pr-2.5 text-right text-muted-foreground ${CODE_TYPE}`}
              >
                {Array.from({ length: lines }, (_, line) => (
                  <div key={line}>{line + 1}</div>
                ))}
              </div>
              <div className="relative grid h-fit min-h-full min-w-max flex-1">
                <pre
                  aria-hidden="true"
                  className={`col-start-1 row-start-1 py-3 pr-4 ${CODE_TYPE}`}
                >
                  <Highlighted code={code} file={file} />
                  {"\n"}
                </pre>
                {/* eslint-disable-next-line react/forbid-elements -- transparent over the highlighted text; Textarea's box would misalign it */}
                <textarea
                  key={file}
                  value={code}
                  onChange={(event) =>
                    setDrafts({ ...drafts, [file]: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                      event.preventDefault();
                      setSaved(drafts);
                    }
                  }}
                  aria-label={`${file} 내용`}
                  wrap="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className={`col-start-1 row-start-1 size-full resize-none overflow-hidden bg-transparent py-3 pr-4 text-transparent caret-foreground outline-none selection:bg-primary/25 selection:text-transparent ${CODE_TYPE}`}
                />
              </div>
            </div>
          </div>

          <BrowserFrame
            address={<SiteAddress loginName="내이름" />}
            className="flex min-w-0 flex-col shadow-hard-lg md:min-h-[400px]"
          >
            <iframe
              srcDoc={renderSite(saved)}
              sandbox=""
              title="저장한 사이트 미리보기"
              className="min-h-80 w-full flex-1 bg-white"
            />
          </BrowserFrame>
        </div>
      </div>
    </section>
  );
}
