import {
  Folder,
  Globe,
  Palette,
  FileCode,
  Braces,
  FileText,
  Image as ImageIcon,
  Music,
  File as FileIcon,
} from "lucide-react";
import {
  EDITABLE_FILE_EXTENSIONS,
  IMAGE_FILE_EXTENSIONS,
  AUDIO_FILE_EXTENSIONS,
} from "@/lib/const";
import { extensionOf } from "./file-tree";

export function getFileIcon(
  fileName: string,
  isDirectory: boolean,
): React.ReactNode {
  const cls = "inline-block align-middle shrink-0";
  const size = 16;
  if (isDirectory) return <Folder size={size} className={cls} />;

  const extension = extensionOf(fileName);

  if (EDITABLE_FILE_EXTENSIONS.includes(extension)) {
    switch (extension) {
      case "html":
      case "htm":
        return <Globe size={size} className={cls} />;
      case "css":
        return <Palette size={size} className={cls} />;
      case "js":
      case "mjs":
        return <FileCode size={size} className={cls} />;
      case "json":
        return <Braces size={size} className={cls} />;
      case "md":
      case "markdown":
        return <FileText size={size} className={cls} />;
      default:
        return <FileIcon size={size} className={cls} />;
    }
  }

  if (IMAGE_FILE_EXTENSIONS.includes(extension)) {
    return <ImageIcon size={size} className={cls} />;
  }

  if (AUDIO_FILE_EXTENSIONS.includes(extension)) {
    return <Music size={size} className={cls} />;
  }

  return <FileIcon size={size} className={cls} />;
}
