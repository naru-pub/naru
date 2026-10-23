"use client";

import { useState, useRef, useEffect } from "react";
import { FileNode } from "@/lib/fileUtils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "sonner";
import {
  Folder,
  FolderOpen,
  Upload,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
  Eye,
  ExternalLink,
} from "lucide-react";
import { loadingFetch } from "@/lib/loading-bar";
import { getFileIcon } from "./file-icons";
import { findNode, isHtml, parentOf, renameSelection } from "./file-tree";

interface DirectoryTreeProps {
  files: FileNode[];
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (filePath: string, isDirectory: boolean) => void;
  onFolderToggle: (folderPath: string) => void;
  onRefresh: () => Promise<void>;
  uploading: boolean;
  onUpload: (files: File[], directory: string) => Promise<boolean>;
  // Files with unsaved edits, marked with a dot.
  dirtyPaths: ReadonlySet<string>;
  // The item whose name is being edited in place, if any.
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onCancelRename: () => void;
  onRename: (path: string, newName: string, isDirectory: boolean) => void;
  onCreated: (path: string) => void;
  onDeleted: (path: string) => void;
  onMoved: (from: string, to: string) => void;
  onPreview: (path: string) => void;
  publicUrl: (path: string) => string | null;
}

// What every row needs from the tree, passed down as one prop.
interface TreeActions {
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (filePath: string, isDirectory: boolean) => void;
  onFolderToggle: (folderPath: string) => void;
  onDelete: (filePath: string) => void;
  flashingItems: Set<string>;
  onMoveFile: (sourcePath: string, targetDirectory: string) => void;
  dragOverDirectory: string | null;
  onDragOverDirectoryChange: (directory: string | null) => void;
  dirtyPaths: ReadonlySet<string>;
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onCancelRename: () => void;
  onRename: (path: string, newName: string, isDirectory: boolean) => void;
  onNewFile: (directory: string) => void;
  onNewFolder: (directory: string) => void;
  onPreview: (path: string) => void;
  publicUrl: (path: string) => string | null;
}

// A name edited in place, as in an editor's file tree: Enter or leaving the
// field renames, Esc cancels. It starts with the name, extension aside,
// selected.
function RenameInput({
  node,
  onRename,
  onCancel,
}: {
  node: FileNode;
  onRename: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(node.name);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(
      0,
      renameSelection(node.name, node.isDirectory),
    );
  }, [node.name, node.isDirectory]);

  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const name = value.trim();
    if (commit && name && name !== node.name) onRename(name);
    else onCancel();
  };

  return (
    <Input
      ref={ref}
      value={value}
      aria-label="새 이름"
      className="h-6 min-w-0 flex-1 px-1 py-0 text-sm md:text-sm"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") settle(true);
        else if (e.key === "Escape") settle(false);
      }}
      onBlur={() => settle(true)}
    />
  );
}

function TreeNode({
  node,
  level = 0,
  actions,
}: {
  node: FileNode;
  level?: number;
  actions: TreeActions;
}) {
  const {
    selectedFile,
    expandedFolders,
    onFileSelect,
    onFolderToggle,
    onDelete,
    flashingItems,
    onMoveFile,
    dragOverDirectory,
    onDragOverDirectoryChange,
  } = actions;
  const confirm = useConfirm();
  const [isDragging, setIsDragging] = useState(false);
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = selectedFile === node.path;
  const isFlashing = flashingItems.has(node.path);
  const isDragOver = dragOverDirectory === node.path;
  const isInDragTargetSubtree = dragOverDirectory ? (node.path === dragOverDirectory || node.path.startsWith(dragOverDirectory + "/")) : false;
  
  const handleClick = () => {
    if (node.isDirectory) {
      onFolderToggle(node.path);
      onFileSelect(node.path, true);
    } else {
      onFileSelect(node.path, false);
    }
  };

  const handleDelete = async () => {
    if (node.isDirectory) {
      // For directories, show all files that will be deleted
      const getFilesInDirectory = (dirNode: FileNode): string[] => {
        const files: string[] = [];
        if (dirNode.children) {
          for (const child of dirNode.children) {
            if (child.isDirectory) {
              files.push(...getFilesInDirectory(child));
            } else {
              files.push(child.path);
            }
          }
        }
        return files;
      };

      const affectedFiles = getFilesInDirectory(node);
      const fileCount = affectedFiles.length;

      let description: string;

      if (fileCount > 0) {
        description = `이 작업으로 ${fileCount}개의 파일이 함께 삭제됩니다:`;
        const maxShowFiles = 10;
        const filesToShow = affectedFiles.slice(0, maxShowFiles);
        description += `\n• ${filesToShow.join('\n• ')}`;

        if (fileCount > maxShowFiles) {
          description += `\n... 그리고 ${fileCount - maxShowFiles}개 파일 더`;
        }
      } else {
        description = '(빈 폴더입니다)';
      }

      if (
        await confirm({
          title: `정말로 폴더 "${node.name}"을(를) 삭제하시겠습니까?`,
          description,
          confirmText: "삭제",
          destructive: true,
        })
      ) {
        onDelete(node.path);
      }
    } else {
      // For files, simple confirmation
      if (
        await confirm({
          title: `정말로 "${node.name}"을(를) 삭제하시겠습니까?`,
          confirmText: "삭제",
          destructive: true,
        })
      ) {
        onDelete(node.path);
      }
    }
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent) => {
    if (node.isDirectory) {
      e.preventDefault(); // Don't allow dragging directories
      return;
    }
    setIsDragging(true);
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  // Drop handlers (only for directories)
  const handleDragOver = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    // Set this directory as the current drag target
    if (dragOverDirectory !== node.path) {
      onDragOverDirectoryChange(node.path);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();

    // Set this directory as the current drag target
    onDragOverDirectoryChange(node.path);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();

    // Only clear if we're the current drag target and actually leaving
    if (dragOverDirectory === node.path) {
      const relatedTarget = e.relatedTarget as Element;
      if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
        onDragOverDirectoryChange(null);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();

    onDragOverDirectoryChange(null);

    const sourcePath = e.dataTransfer.getData("text/plain");
    if (sourcePath && sourcePath !== node.path) {
      // Don't allow moving into a subdirectory of itself
      if (sourcePath.startsWith(node.path + "/")) {
        toast.error("파일을 하위 디렉토리로 이동할 수 없습니다.");
        return;
      }
      onMoveFile(sourcePath, node.path);
    }
  };

  return (
    <div
      className={isInDragTargetSubtree && node.isDirectory ? "bg-accent" : ""}
      onDragOver={node.isDirectory ? handleDragOver : undefined}
      onDragEnter={node.isDirectory ? handleDragEnter : undefined}
      onDragLeave={node.isDirectory ? handleDragLeave : undefined}
      onDrop={node.isDirectory ? handleDrop : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={`flex items-center py-1 px-2 cursor-pointer hover:bg-accent text-sm transition-all duration-300 border-2 border-dashed ${
              isSelected ? "bg-primary/10 font-medium text-primary" : ""
            } ${isFlashing ? "bg-success/10 animate-pulse" : ""} ${
              isDragging ? "opacity-50" : ""
            } ${isDragOver && node.isDirectory ? "bg-primary/20 border-primary" : isInDragTargetSubtree && node.isDirectory ? "border-primary/50" : "border-transparent"}`}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            draggable={!node.isDirectory}
            onClick={handleClick}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {node.isDirectory && (
              <span className="mr-1 text-xs">
                {isExpanded ? "▼" : "▶"}
              </span>
            )}
            <span className="mr-2">{getFileIcon(node.name, node.isDirectory)}</span>
            {actions.renamingPath === node.path ? (
              <RenameInput
                node={node}
                onRename={(name) =>
                  actions.onRename(node.path, name, node.isDirectory)
                }
                onCancel={actions.onCancelRename}
              />
            ) : (
              <span className="text-sm text-foreground truncate">{node.name}</span>
            )}
            {actions.dirtyPaths.has(node.path) && (
              <span
                className="ml-auto size-2 shrink-0 rounded-full bg-primary"
                title="저장하지 않은 변경 사항"
                aria-label="저장하지 않음"
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              actions.onNewFile(node.isDirectory ? node.path : parentOf(node.path))
            }
          >
            <FilePlus /> 새 파일
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              actions.onNewFolder(
                node.isDirectory ? node.path : parentOf(node.path),
              )
            }
          >
            <FolderPlus /> 새 폴더
          </ContextMenuItem>
          <ContextMenuSeparator />
          {isHtml(node.path) && (
            <ContextMenuItem onSelect={() => actions.onPreview(node.path)}>
              <Eye /> 미리보기
            </ContextMenuItem>
          )}
          {!node.isDirectory && actions.publicUrl(node.path) && (
            <ContextMenuItem
              onSelect={() =>
                window.open(
                  actions.publicUrl(node.path)!,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <ExternalLink /> 새 탭에서 열기
            </ContextMenuItem>
          )}
          {node.path !== "index.html" && (
            <ContextMenuItem onSelect={() => actions.onStartRename(node.path)}>
              <Pencil /> 이름 변경 <span className="ml-auto pl-4 text-xs text-muted-foreground">F2</span>
            </ContextMenuItem>
          )}
          <ContextMenuItem destructive onSelect={handleDelete}>
            <Trash2 /> 삭제
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {node.isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DirectoryTree({
  files,
  selectedFile,
  expandedFolders,
  onFileSelect,
  onFolderToggle,
  onRefresh,
  uploading,
  onUpload,
  dirtyPaths,
  renamingPath,
  onStartRename,
  onCancelRename,
  onRename,
  onCreated,
  onDeleted,
  onMoved,
  onPreview,
  publicUrl,
}: DirectoryTreeProps) {
  const [newDirectoryName, setNewDirectoryName] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [showNewDirectoryInput, setShowNewDirectoryInput] = useState(false);
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  // New HTML files start from a page skeleton unless this is unchecked.
  const [useTemplate, setUseTemplate] = useState(true);
  const [flashingItems, setFlashingItems] = useState<Set<string>>(new Set());
  const [isRootDropZone, setIsRootDropZone] = useState(false);
  const [dragOverDirectory, setDragOverDirectory] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get current directory based on selected file/folder
  const getCurrentDirectory = () => {
    if (!selectedFile) return "";
    return findNode(files, selectedFile)?.isDirectory
      ? selectedFile
      : parentOf(selectedFile);
  };

  const targetDirectory = getCurrentDirectory();

  // Flash effect for new items
  const flashItem = (itemPath: string) => {
    setFlashingItems(prev => new Set(prev.add(itemPath)));
    setTimeout(() => {
      setFlashingItems(prev => {
        const newSet = new Set(prev);
        newSet.delete(itemPath);
        return newSet;
      });
    }, 2000); // Flash for 2 seconds
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (uploading) return;
    const selected = Array.from(files);
    try {
      if (await onUpload(selected, targetDirectory)) {
        selected.forEach(file => flashItem(targetDirectory ? `${targetDirectory}/${file.name}` : file.name));
      }
    }
    finally { if (fileInputRef.current) fileInputRef.current.value = ""; }
  };

  const handleCreateDirectory = async () => {
    if (!newDirectoryName.trim()) return;

    try {
      const response = await loadingFetch("/api/files/create-directory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: targetDirectory ? `${targetDirectory}/${newDirectoryName}` : newDirectoryName,
        }),
      });

      const result = await response.json();
      
      if (result.success) {
        const newDirPath = targetDirectory ? `${targetDirectory}/${newDirectoryName}` : newDirectoryName;
        setNewDirectoryName("");
        setShowNewDirectoryInput(false);
        onRefresh();
        flashItem(newDirPath);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Create directory error:", error);
      toast.error("디렉토리 생성에 실패했습니다.");
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;

    try {
      const response = await loadingFetch("/api/files/create-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: targetDirectory,
          filename: newFileName,
          template: useTemplate,
        }),
      });

      const result = await response.json();
      
      if (result.success) {
        const newFilePath = targetDirectory ? `${targetDirectory}/${newFileName}` : newFileName;
        setNewFileName("");
        setShowNewFileInput(false);
        await onRefresh();
        flashItem(newFilePath);
        onCreated(newFilePath);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Create file error:", error);
      toast.error("파일 생성에 실패했습니다.");
    }
  };

  const handleDelete = async (filePath: string) => {
    try {
      const response = await loadingFetch("/api/files/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filename: filePath,
        }),
      });

      const result = await response.json();

      if (result.success) {
        onRefresh();
        onDeleted(filePath);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("파일 삭제에 실패했습니다.");
    }
  };

  const handleMoveFile = async (sourcePath: string, targetDirectory: string) => {
    try {
      const response = await loadingFetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourcePath,
          targetDirectory,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // If moving into a subdirectory, expand it (only if not already expanded)
        if (targetDirectory && !expandedFolders.has(targetDirectory)) {
          onFolderToggle(targetDirectory);
        }

        onRefresh();

        if (result.newPath) {
          onMoved(sourcePath, result.newPath);
        }

        // Flash the moved file in its new location
        if (result.newPath) {
          flashItem(result.newPath);
        }

        // Show success toast
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Move file error:", error);
      toast.error("파일 이동 중 오류가 발생했습니다.");
    }
  };

  // Root drop zone handlers
  const handleRootDragOver = (e: React.DragEvent) => {
    // Only handle if dragging from within our file tree and not over a specific directory
    if (e.dataTransfer.types.includes("text/plain") && !dragOverDirectory) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleRootDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain") && !dragOverDirectory) {
      e.preventDefault();
      setIsRootDropZone(true);
    }
  };

  const handleRootDragLeave = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      // Only hide if we're leaving the container entirely and not moving to a directory
      if (!e.currentTarget.contains(e.relatedTarget as Node) && !dragOverDirectory) {
        setIsRootDropZone(false);
      }
    }
  };

  const handleRootDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      setIsRootDropZone(false);
      setDragOverDirectory(null);

      const sourcePath = e.dataTransfer.getData("text/plain");
      if (sourcePath) {
        // Move to root directory (empty string)
        handleMoveFile(sourcePath, "");
      }
    }
  };

  const handleDragOverDirectoryChange = (directory: string | null) => {
    setDragOverDirectory(directory);
    // Clear root drop zone when over a specific directory
    if (directory) {
      setIsRootDropZone(false);
    }
  };

  const actions: TreeActions = {
    selectedFile,
    expandedFolders,
    onFileSelect,
    onFolderToggle,
    onDelete: handleDelete,
    flashingItems,
    onMoveFile: handleMoveFile,
    dragOverDirectory,
    onDragOverDirectoryChange: handleDragOverDirectoryChange,
    dirtyPaths,
    renamingPath,
    onStartRename,
    onCancelRename,
    onRename,
    onNewFile: (directory) => {
      onFileSelect(directory, true);
      setShowNewDirectoryInput(false);
      setShowNewFileInput(true);
    },
    onNewFolder: (directory) => {
      onFileSelect(directory, true);
      setShowNewFileInput(false);
      setShowNewDirectoryInput(true);
    },
    onPreview,
    publicUrl,
  };

  return (
    <div
      // Focusable, so F2 renames what is selected after a click in the tree.
      tabIndex={-1}
      className="outline-none"
      onKeyDown={(e) => {
        if (
          e.key === "F2" &&
          selectedFile &&
          selectedFile !== "index.html" &&
          !renamingPath
        ) {
          e.preventDefault();
          onStartRename(selectedFile);
        }
      }}
    >
      {/* Toolbar */}
      <div className="p-2 border-b border-border bg-secondary">
        <div className="space-y-2">
          <div className="text-xs mb-1 truncate">
            <span className="text-muted-foreground select-none">$ cd </span>
            <span className="text-muted-foreground">~/{targetDirectory}</span>
          </div>
          <div className="flex space-x-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-xs gap-1"
            >
              <Upload size={12} className="shrink-0" />
              {uploading ? "업로드중..." : "업로드"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNewDirectoryInput(!showNewDirectoryInput)}
              className="text-xs gap-1"
            >
              <FolderPlus size={12} className="shrink-0" /> 폴더
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNewFileInput(!showNewFileInput)}
              className="text-xs gap-1"
            >
              <FilePlus size={12} className="shrink-0" /> 파일
            </Button>
          </div>

          {showNewDirectoryInput && (
            <div className="flex space-x-1">
              <Input
                type="text"
                value={newDirectoryName}
                onChange={(e) => setNewDirectoryName(e.target.value)}
                placeholder="폴더 이름"
                className="h-8 min-w-0 flex-1 px-2 py-1 text-xs md:text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateDirectory();
                  else if (e.key === "Escape") setShowNewDirectoryInput(false);
                }}
              />
              <Button size="sm" onClick={handleCreateDirectory} className="h-8 text-xs">
                생성
              </Button>
            </div>
          )}

          {showNewFileInput && (
            <div className="space-y-1">
              <div className="flex space-x-1">
                <Input
                  type="text"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="파일 이름 (예: test.html)"
                  className="h-8 min-w-0 flex-1 px-2 py-1 text-xs md:text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFile();
                    else if (e.key === "Escape") setShowNewFileInput(false);
                  }}
                />
                <Button size="sm" onClick={handleCreateFile} className="h-8 text-xs">
                  생성
                </Button>
              </div>
              {isHtml(newFileName.trim()) && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={useTemplate}
                    onCheckedChange={(checked) => setUseTemplate(checked === true)}
                    className="size-4"
                  />
                  HTML 기본 틀로 시작
                </label>
              )}
            </div>
          )}
        </div>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleUpload}
          multiple
          className="hidden"
        />
      </div>

      {/* File Tree */}
      <div className="p-2">
        {files.map((file) => (
          <TreeNode key={file.path} node={file} actions={actions} />
        ))}

        {files.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <FolderOpen size={40} className="mx-auto mb-2" strokeWidth={1.25} />
            <p className="text-sm">파일이 없습니다</p>
          </div>
        )}

        {/* Root Drop Zone at bottom */}
        <div
          className={`mt-4 p-4 border-2 border-dashed text-center transition-all duration-200 ${
            isRootDropZone
              ? "bg-primary/20 border-primary text-primary"
              : "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50"
          }`}
          onDragOver={handleRootDragOver}
          onDragEnter={handleRootDragEnter}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          <Folder size={24} className="mx-auto mb-2" strokeWidth={1.25} />
          <div className="text-sm font-medium">
            {isRootDropZone ? "루트 폴더로 이동" : "루트 폴더"}
          </div>
          <div className="text-xs text-muted-foreground/70 mt-1">
            파일을 여기로 드래그하여 루트로 이동
          </div>
        </div>
      </div>
    </div>
  );
}
