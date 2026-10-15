import type { Metadata } from "next";
import type { ReactNode } from "react";
import Code from "../../Code";
import DocsNav from "../../DocsNav";

export const metadata: Metadata = {
  title: "미디어 사용 안내 | 나루",
  description: "나루 미디어 라이브러리와 웹 SDK로 이미지와 파일을 다루는 방법",
};

const sections = [
  ["upload", "01 · 웹 SDK로 올리기"],
  ["limits", "02 · 한도와 허용 형식"],
  ["manage", "03 · 관리와 삭제"],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 space-y-5 border-t pt-8">
      <h2 className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default function MediaDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="media" version="1.1.0" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">
            NARU / DOCS / MEDIA / SDK 1.1.0
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            사이트가 올린 이미지와 파일을 다루세요.
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            글에 넣을 사진 등 데이터베이스 문서와 함께 쓰는 파일을 보관합니다.
          </p>
          <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
            <a href="/media">미디어 라이브러리 열기 →</a>
            <a href="/docs/1.1.0/database">데이터베이스 사용 안내 →</a>
            <a href="/docs/sdk/1.1.0#Admin">Media API →</a>
          </div>
        </header>

        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <nav
            aria-label="문서 목차"
            className="self-start rounded-lg border p-5 lg:sticky lg:top-8"
          >
            <p className="mb-4 font-bold">이 페이지에서</p>
            <ul className="space-y-3 text-sm">
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a
                    className="underline-offset-4 hover:underline"
                    href={`#${id}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <article className="min-w-0 space-y-12 leading-8 [&_a]:underline [&_a]:underline-offset-4">
            <Section id="upload" title="01 · 웹 SDK로 올리기">
              <p>
                <a href="/docs/1.1.0/database#admin">관리자 로그인</a> 후{" "}
                <code>admin.media.upload()</code>로 파일을 올리고, 돌려받은{" "}
                <code>url</code>을 문서에 저장하세요.
              </p>
              <Code>{`const admin = await naru.auth.session();

const image = await admin.media.upload(fileInput.files[0]);
// → { url, name, contentType, size }

await admin.collection("posts").set("hello", {
  title: "안녕하세요",
  coverImage: image.url,
});`}</Code>
              <p>
                진행 상황을 보여 주려면 <code>onProgress</code>를 넘기세요.
                사진을 줄이고 준비하는 동안 <code>preparing</code>, 보내는 동안
                보낸 바이트 수와 함께 <code>uploading</code>, 마무리하는 동안{" "}
                <code>finishing</code>이 전달됩니다.
              </p>
              <Code>{`await admin.media.upload(file, {
  onProgress(progress) {
    if (progress.phase === "uploading")
      bar.value = progress.loaded / progress.total;
  },
});`}</Code>
              <p>
                큰 사진은 자동으로 줄여지거나 지원되는 형식으로 변환될 수
                있습니다. 구체적인 크기와 변환 방식은 바뀔 수 있으므로 돌려받은
                파일 정보와 URL을 쓰세요.
              </p>
            </Section>

            <Section id="limits" title="02 · 한도와 허용 형식">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  파일당 <strong>25 MiB</strong>, 사이트당{" "}
                  <strong>250 MiB</strong>의 한도가 있습니다.
                </li>
                <li>
                  이미지(JPEG, PNG, WebP, AVIF, GIF), 오디오, PDF, ZIP, 텍스트를
                  지원합니다.
                </li>
              </ul>
            </Section>

            <Section id="manage" title="03 · 관리와 삭제">
              <p>
                가장 쉬운 방법은 <code>managed: true</code>로 올리는 것입니다.
                그러면 파일을 따로 지울 필요가 없습니다. 어느 문서든 파일의
                URL을 담고 있는 동안 파일이 남고, 글을 고치거나 지워 URL을 담은
                문서가 하나도 없게 되면 나루가 15분 안팎에 지웁니다. 올린 뒤 한
                시간이 지나도록 어떤 문서에도 쓰이지 않은 파일도 지웁니다.
              </p>
              <Code>{`const image = await member.media.upload(file, { managed: true });
await posts.add({ title: "사진", image: image.url });
// 글을 지우거나 다른 사진으로 바꾸면, 나루가 이 파일을 지웁니다.`}</Code>
              <p>
                <code>managed</code> 없이 올린 파일은 지울 때까지 남습니다.
                업로드 결과에는 파일 ID가 있습니다. URL과 함께 문서에 저장하고,
                더 이상 사용하는 문서가 없을 때 ID로 삭제하세요. 회원은 자신이
                올린 파일만 지울 수 있습니다.
              </p>
              <Code>{`const uploaded = await member.media.upload(file);
await posts.add({ image: uploaded.url, imageId: uploaded.id });
// 참조하는 문서를 먼저 삭제하거나 이미지를 교체한 뒤:
await member.media.delete(uploaded.id);`}</Code>
              <p>
                사이트 소유자가 웹페이지에서 삭제하려면 로그인할 때 미디어 삭제
                권한을 따로 요청해야 합니다. 기존 로그인에는 이 권한이 없습니다.
              </p>
              <Code>{`await naru.auth.signIn({ collections: ["posts"], mediaDelete: true });
const admin = await naru.auth.session();
await admin.media.delete(fileId);`}</Code>
              <p>
                삭제 실패는 나중에 다시 시도할 수 있습니다. 공유 파일은 마지막
                참조가 없어질 때 지우고, 외부 이미지 URL에서 ID를 추측하지
                마세요. 저장소 정리와 할당량 반영에는 시간이 걸릴 수 있으며,
                공개 URL의 캐시가 즉시 사라지는 것은 아닙니다.
              </p>
              <p>
                <a href="/media">미디어 라이브러리</a>에서 파일을 올리고,
                사용량을 확인하고, URL을 복사하고, 지울 수 있습니다. 사이트를
                이루는 HTML·CSS 파일은 <a href="/files">파일</a>에서 따로
                관리합니다.
              </p>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
