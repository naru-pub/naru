---
title: 사이트가 올린 이미지와 파일을 다루세요.
pageTitle: 미디어 사용 안내 | 나루
description: 나루 미디어 라이브러리와 웹 SDK로 이미지와 파일을 다루는 방법
path: MEDIA / SDK 1.1.0
links: [미디어 라이브러리 열기 →](/media) [데이터베이스 사용 안내 →](/docs/1.1.0/database) [Media API →](/docs/sdk/1.1.0#Admin)
---

글에 넣을 사진 등 데이터베이스와 함께 쓰는 파일을 보관합니다.

## 01 · 웹 SDK로 올리기 {#upload}

[관리자 로그인](/docs/1.1.0/database#admin) 후 `admin.media.upload()`로 파일을
올리고, 돌려받은 `url`을 문서에 저장하세요.

```
const admin = await naru.auth.session();

const image = await admin.media.upload(fileInput.files[0]);
// → { url, name, contentType, size }

await admin.collection("posts").set("hello", {
  title: "안녕하세요",
  coverImage: image.url,
});
```

진행 상황을 보여 주려면 `onProgress`를 넘기세요. 사진을 줄이고 준비하는 동안
`preparing`, 보내는 동안 보낸 바이트 수와 함께 `uploading`, 마무리하는 동안
`finishing`이 전달됩니다.

```
await admin.media.upload(file, {
  onProgress(progress) {
    if (progress.phase === "uploading")
      bar.value = progress.loaded / progress.total;
  },
});
```

큰 사진은 자동으로 줄여지거나 지원되는 형식으로 변환될 수 있습니다. 구체적인
크기와 변환 방식은 바뀔 수 있으므로 돌려받은 파일 정보와 URL을 쓰세요.

## 02 · 한도와 허용 형식 {#limits}

- 파일당 **25 MiB**, 사이트당 **250 MiB**의 한도가 있습니다.
- 이미지(JPEG, PNG, WebP, AVIF, GIF), 오디오, PDF, ZIP, 텍스트를 지원합니다.

## 03 · 관리와 삭제 {#manage}

나루는 파일을 스스로 지우지 않습니다. 파일 주소는 문서 밖 어디에서든 쓰일 수
있기 때문입니다. 대신 어떤 컬렉션 문서가 파일의 URL을 담고 있는지 살피고, 담은
문서가 없는 파일을 미디어 라이브러리에 &lsquo;문서 참조 없음&rsquo;으로
표시합니다. 일반 필드든 HTML 안이든 URL이 들어 있으면 참조로 셉니다. 사이트 SQL
테이블이나 사이트 파일이 쓰는지는 보지 않으니, 필요 없는 파일만 그곳에서
지우세요.

```
const image = await admin.media.upload(file);
await admin.collection("posts").set("spring", { title: "사진", image: image.url });
// 글을 지우거나 다른 사진으로 바꾸면, 이 파일은 미디어 라이브러리에
// '문서 참조 없음'으로 표시됩니다.
```

[회원](/docs/1.1.0/database#members)은 `member.media.upload()`로 파일을
올리고(한 시간에 30개까지), 받은 URL이나 ID를 사이트의 뮤테이션에 넘겨 테이블에
저장합니다. 페이지와 사이트 코드(쿼리와 뮤테이션)는 파일을 지우지 않습니다.
회원이 올린 파일도 사이트 소유자가 미디어 라이브러리에서 지웁니다.

```
const uploaded = await member.media.upload(file);
await member.mutate("profile:setAvatar", {
  url: uploaded.url,
  fileId: uploaded.id,
});
```

[미디어 라이브러리](/media)에서 파일을 올리고, 사용량을 확인하고, URL을
복사하고, 지울 수 있습니다. 지운 파일의 저장소 정리와 할당량 반영에는 시간이
걸릴 수 있으며, 공개 URL의 캐시가 즉시 사라지는 것은 아닙니다. 사이트를 이루는
HTML·CSS 파일은 [파일](/files)에서 따로 관리합니다.
