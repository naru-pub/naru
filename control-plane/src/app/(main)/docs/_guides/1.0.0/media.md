---
title: 사이트가 올린 이미지와 파일을 다루세요.
pageTitle: 미디어 사용 안내 | 나루
description: 나루 미디어 라이브러리와 웹 SDK로 이미지와 파일을 다루는 방법
path: MEDIA / SDK 1.0.0
links: [미디어 라이브러리 열기 →](/media) [데이터베이스 사용 안내 →](/docs/1.0.0/database) [Media API →](/docs/sdk/1.0.0#Admin)
---

글에 넣을 사진 등 데이터베이스 문서와 함께 쓰는 파일을 보관합니다.

## 01 · 웹 SDK로 올리기 {#upload}

[관리자 로그인](/docs/1.0.0/database#admin) 후 `admin.media.upload()`로 파일을
올리고, 돌려받은 `url`을 문서에 저장하세요.

```javascript
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

```javascript
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

[미디어 라이브러리](/media)에서 파일을 올리고, 사용량을 확인하고, URL을
복사하고, 지울 수 있습니다. 사이트를 이루는 HTML·CSS 파일은 [파일](/files)에서
따로 관리합니다.
