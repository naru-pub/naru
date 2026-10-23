"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { IMAGE_FILE_EXTENSIONS, AUDIO_FILE_EXTENSIONS } from "@/lib/const";
import { getPublicAssetUrl } from "@/lib/site-urls";
import ImageViewer, { ImageViewerRef } from "./ImageViewer";
import { Button } from "@/components/ui/button";
import { extensionOf } from "./file-tree";

// Files the editor doesn't open: images to zoom, audio to play, and the rest
// to open or download. Text files open in CodeEditor.

export interface FileViewerRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

interface FileViewerProps {
  filePath: string;
  userLoginName: string;
}

const FileViewer = forwardRef<FileViewerRef, FileViewerProps>(
  function FileViewer({ filePath, userLoginName }, ref) {
    const imageViewerRef = useRef<ImageViewerRef>(null);

    const fileName = filePath.split("/").pop() || "";
    const fileExtension = extensionOf(filePath);

    const isImage = IMAGE_FILE_EXTENSIONS.includes(fileExtension);
    const isAudio = AUDIO_FILE_EXTENSIONS.includes(fileExtension);

    useImperativeHandle(
      ref,
      () => ({
        zoomIn: () => imageViewerRef.current?.zoomIn(),
        zoomOut: () => imageViewerRef.current?.zoomOut(),
        resetZoom: () => imageViewerRef.current?.resetZoom(),
      }),
      [],
    );

    // Handle different file types
    if (isImage) {
      const imageSrc = getPublicAssetUrl(userLoginName, filePath);
      return (
        <ImageViewer
          ref={imageViewerRef}
          src={imageSrc}
          alt={fileName}
          filename={fileName}
        />
      );
    }

    if (isAudio) {
      const audioSrc = getPublicAssetUrl(userLoginName, filePath);
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center max-w-md">
            <div className="text-6xl mb-4">🎵</div>
            <h3 className="text-lg font-medium text-foreground mb-4">
              {fileName}
            </h3>
            <audio controls className="w-full mb-4" src={audioSrc}>
              Your browser does not support the audio element.
            </audio>
            <Button variant="outline" asChild>
              <a href={audioSrc} target="_blank" rel="noopener noreferrer">
                다운로드
              </a>
            </Button>
          </div>
        </div>
      );
    }

    // For other file types, show download option
    const fileUrl = getPublicAssetUrl(userLoginName, filePath);
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-6xl mb-4">📄</div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            {fileName}
          </h3>
          <p className="text-muted-foreground mb-4">
            이 파일 형식은 미리보기를 지원하지 않습니다
          </p>
          <div className="space-y-2">
            <Button variant="outline" asChild>
              <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                새 탭에서 열기
              </a>
            </Button>
            <br />
            <Button variant="outline" asChild>
              <a href={fileUrl} download>
                다운로드
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

export default FileViewer;
