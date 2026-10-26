"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import UploadStatus from "./UploadStatus";
import { useFileUpload } from "./useFileUpload";
import DirectoryTree from "./DirectoryTree";
import FileViewer, { FileViewerRef } from "./FileViewer";
import CodeEditor, { type CodeEditorInstance } from "./CodeEditor";
import PreviewPane from "./PreviewPane";
import QuickOpen from "./QuickOpen";
import { useOpenFiles } from "./useOpenFiles";
import { readStored, useStoredState, writeStored } from "./useStoredState";
import { getFileIcon } from "./file-icons";
import { canFormat } from "./format";
import {
  ancestorsOf,
  basename,
  editorUrl,
  filePaths,
  findNode,
  isEditable,
  isHtml,
  isWithin,
  parentOf,
} from "./file-tree";
import { FileNode } from "@/lib/fileUtils";
import { IMAGE_FILE_EXTENSIONS } from "@/lib/const";
import { getPublicAssetUrl } from "@/lib/site-urls";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FolderOpen,
  Upload,
  ArrowUpToLine,
  X,
  Search,
  Eye,
  Settings2,
  Loader2,
  CircleHelp,
} from "lucide-react";
import { loadingFetch } from "@/lib/loading-bar";

interface FileExplorerProps {
  initialFiles: FileNode[];
  userLoginName: string;
  // The file /files/edit/<path> opens, if it exists.
  initialSelectedFile?: string | null;
}

interface Preferences {
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  preview: boolean;
  sidebarWidth: number;
  previewWidth: number;
}

// Module constants, so useStoredState's values keep their identity.
const DEFAULT_PREFERENCES: Preferences = {
  wordWrap: true,
  minimap: true,
  formatOnSave: false,
  preview: false,
  sidebarWidth: 320,
  previewWidth: 480,
};
const NO_PATHS: string[] = [];
const PREFERENCES_KEY = "naru:files:preferences";

const subscribeNothing = () => () => {};

export default function FileExplorer({
  initialFiles,
  userLoginName,
  initialSelectedFile = null,
}: FileExplorerProps) {
  const confirm = useConfirm();
  const [files, setFiles] = useState<FileNode[]>(initialFiles);
  // The tree's selection: a file, or the folder new files go in.
  const [selectedFile, setSelectedFile] = useState<string | null>(
    initialSelectedFile,
  );
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileViewerRef = useRef<FileViewerRef>(null);
  const editorRef = useRef<CodeEditorInstance | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // The file the diff view is showing, while it is shown.
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  // Open files, most recently active first.
  const [recent, setRecent] = useState<string[]>([]);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [resizing, setResizing] = useState<"sidebar" | "preview" | null>(null);

  const [preferences, setPreferences] = useStoredState(
    PREFERENCES_KEY,
    DEFAULT_PREFERENCES,
  );
  const setPreference = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
      setPreferences((previous) => ({
        ...DEFAULT_PREFERENCES,
        ...previous,
        [key]: value,
      })),
    [setPreferences],
  );
  const prefs = { ...DEFAULT_PREFERENCES, ...preferences };

  const expandedKey = `naru:files:${userLoginName}:expanded`;
  const tabsKey = `naru:files:${userLoginName}:tabs`;
  const [expandedList, setExpandedList] = useStoredState(expandedKey, NO_PATHS);
  const expandedFolders = useMemo(
    () => new Set(["", ...expandedList]),
    [expandedList],
  );
  const expand = useCallback(
    (paths: string[]) =>
      setExpandedList((previous) => [...new Set([...previous, ...paths])]),
    [setExpandedList],
  );

  const isMac = useSyncExternalStore(
    subscribeNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true,
  );
  const mod = isMac ? "⌘" : "Ctrl+";

  const {
    monaco,
    tabs,
    active,
    dirty,
    status,
    open,
    restore,
    close,
    closeWithin,
    save,
    reload,
    moved,
    getModel,
    isLoaded,
    savedText,
  } = useOpenFiles();

  const allFiles = useMemo(() => filePaths(files), [files]);

  const activate = useCallback(
    (path: string) => {
      setRecent((previous) => [path, ...previous.filter((p) => p !== path)]);
      setSelectedFile(path);
      expand(ancestorsOf(path));
      open(path);
    },
    [expand, open],
  );

  // The tabs open last time, and the file the address names. Only this
  // browser knows the former, so they open once mounted, after hydration.
  useEffect(() => {
    const stored = readStored<{ tabs: string[]; active: string | null }>(
      tabsKey,
      { tabs: [], active: null },
    );
    const exists = new Set(filePaths(initialFiles));
    const restored = stored.tabs.filter((path) => exists.has(path));
    restore(
      restored,
      stored.active && exists.has(stored.active)
        ? stored.active
        : (restored[0] ?? null),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialSelectedFile) activate(initialSelectedFile);
    // Only on mount: later changes are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    writeStored(tabsKey, { tabs, active });
  }, [tabsKey, tabs, active]);

  // The address names the open file, so reloading or sharing it reopens it.
  useEffect(() => {
    const url = editorUrl(active);
    if (window.location.pathname !== url) {
      window.history.replaceState(null, "", url);
    }
  }, [active]);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (dirty.size === 0) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const handleRefresh = useCallback(async () => {
    try {
      const response = await loadingFetch("/api/files/tree");
      const result = await response.json();

      if (result.success) {
        setFiles(result.files);
      } else {
        console.error("Failed to refresh files:", result.message);
      }
    } catch (error) {
      console.error("Failed to refresh files:", error);
    }
  }, []);

  const saveFile = useCallback(
    async (path: string) => {
      if (!isLoaded(path)) return;
      const editor = editorRef.current;
      if (
        prefs.formatOnSave &&
        canFormat(path) &&
        editor &&
        editor.getModel() === getModel(path)
      ) {
        await editor.getAction("editor.action.formatDocument")?.run();
      }
      let result = await save(path);
      if (result === "conflict") {
        const overwrite = await confirm({
          title: `"${basename(path)}" 파일이 다른 곳에서 변경되었습니다.`,
          description:
            "연 뒤에 MCP, 앱 또는 다른 탭에서 저장된 버전이 있습니다. 덮어쓰면 그 변경 사항은 사라집니다.",
          confirmText: "덮어쓰기",
          destructive: true,
        });
        if (overwrite) {
          result = await save(path, { force: true });
        } else {
          toast("저장하지 않았습니다.", {
            description: "편집한 내용은 그대로 남아 있습니다.",
            duration: 15000,
            action: {
              label: "저장된 버전 불러오기",
              onClick: () => reload(path),
            },
          });
        }
      }
      if (result === "saved") {
        setDiffFor((current) => (current === path ? null : current));
        setPreviewVersion((version) => version + 1);
      }
    },
    [confirm, getModel, isLoaded, prefs.formatOnSave, reload, save],
  );

  const closeTab = useCallback(
    async (path: string) => {
      if (
        dirty.has(path) &&
        !(await confirm({
          title: `"${basename(path)}"의 변경 사항을 저장하지 않았습니다.`,
          description: "닫으면 저장하지 않은 변경 사항이 사라집니다.",
          confirmText: "저장하지 않고 닫기",
          destructive: true,
        }))
      ) {
        return;
      }
      setRecent((previous) => previous.filter((p) => p !== path));
      close(path);
    },
    [close, confirm, dirty],
  );

  const formatActive = useCallback(() => {
    editorRef.current?.getAction("editor.action.formatDocument")?.run();
  }, []);

  // Shortcuts that work anywhere on the page, the editor included.
  const shortcuts = useRef({ saveFile, active });
  useEffect(() => {
    shortcuts.current = { saveFile, active };
  }, [saveFile, active]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        const { active, saveFile } = shortcuts.current;
        if (active) saveFile(active);
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Resizing the tree and the preview by their edges.
  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handleMouseMove = (e: MouseEvent) => {
      if (resizing === "sidebar") {
        setPreference("sidebarWidth", Math.min(Math.max(e.clientX, 200), 600));
      } else {
        const rect = mainRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPreference(
          "previewWidth",
          Math.min(Math.max(rect.right - e.clientX, 280), rect.width - 300),
        );
      }
    };
    const handleMouseUp = () => setResizing(null);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizing, setPreference]);

  const handleFileSelect = (filePath: string, isDirectory: boolean) => {
    if (isDirectory) {
      // A folder becomes where new files and uploads go.
      setSelectedFile(filePath);
    } else if (filePath) {
      activate(filePath);
    }
  };

  const handleFolderToggle = (folderPath: string) => {
    setExpandedList((previous) =>
      previous.includes(folderPath)
        ? previous.filter((path) => path !== folderPath)
        : [...previous, folderPath],
    );
  };

  const remapAfterMove = (from: string, to: string) => {
    const remap = (path: string) =>
      isWithin(path, from) ? to + path.slice(from.length) : path;
    moved(from, to);
    setSelectedFile((current) => (current === null ? null : remap(current)));
    setRecent((previous) => previous.map(remap));
    setExpandedList((previous) => previous.map(remap));
  };

  const handleRename = async (
    path: string,
    newName: string,
    isDirectory: boolean,
  ) => {
    setRenamingPath(null);
    const parent = parentOf(path);
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (!isDirectory && findNode(files, newPath)) {
      const overwrite = await confirm({
        title: `"${newName}" 파일이 이미 존재합니다.`,
        description: "기존 파일을 덮어쓰시겠습니까?",
        confirmText: "덮어쓰기",
        destructive: true,
      });
      if (!overwrite) return;
    }
    try {
      const response = await loadingFetch("/api/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldFilename: path,
          newFilename: newName,
          isDirectory,
        }),
      });
      const result = await response.json();
      if (result.success) {
        // A file renamed over another replaces it, so its tab goes.
        if (!isDirectory && tabs.includes(newPath)) closeWithin(newPath);
        remapAfterMove(path, result.newPath ?? newPath);
        await handleRefresh();
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Rename error:", error);
      toast.error("이름 변경에 실패했습니다.");
    }
  };

  const handleDeleted = (path: string) => {
    closeWithin(path);
    setRecent((previous) => previous.filter((p) => !isWithin(p, path)));
    setSelectedFile((current) =>
      current !== null && isWithin(current, path) ? parentOf(path) : current,
    );
  };

  const publicUrl = useCallback(
    (path: string) => {
      if (path === "_naru" || path.startsWith("_naru/")) return null;
      // A folder's index page by the folder's own address.
      const page = /(^|\/)index\.html?$/i.test(path)
        ? path.replace(/index\.html?$/i, "")
        : path;
      return getPublicAssetUrl(userLoginName, page);
    },
    [userLoginName],
  );

  // The page the preview shows: the open HTML file, else the one open last,
  // else the home page.
  const previewPath =
    (active && isHtml(active) ? active : null) ??
    recent.find((path) => isHtml(path) && allFiles.includes(path)) ??
    (allFiles.includes("index.html") ? "index.html" : null);
  const previewUrl = previewPath ? publicUrl(previewPath) : null;

  const getCurrentDirectory = () => {
    if (!selectedFile) return "";
    return findNode(files, selectedFile)?.isDirectory
      ? selectedFile
      : parentOf(selectedFile);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;

    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current = 0;
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    await handleUpload(droppedFiles, getCurrentDirectory());
  };

  const {
    uploading,
    progress: uploadProgress,
    upload: handleUpload,
  } = useFileUpload(handleRefresh);

  const activeIsText = !!active && isEditable(active);
  const activeStatus = active ? status[active] : undefined;
  const activeReady =
    activeIsText && !!monaco && isLoaded(active) && !activeStatus?.loading;
  // The editor stays mounted while any text file is loaded, showing the
  // active one, so switching tabs keeps each file's state.
  const editorPath = activeReady
    ? active
    : (tabs.find((path) => isEditable(path) && isLoaded(path)) ?? null);
  const activeModel = activeReady ? getModel(active) : null;
  const diff =
    activeReady && diffFor === active && activeModel
      ? { original: savedText(active), modified: activeModel.getValue() }
      : null;
  const isImage =
    !!active &&
    IMAGE_FILE_EXTENSIONS.includes(
      active.split(".").pop()?.toLowerCase() ?? "",
    );

  // Tabs that share a name show their folder too.
  const tabLabel = (path: string) => {
    const name = basename(path);
    const twin = tabs.some((tab) => tab !== path && basename(tab) === name);
    return twin && parentOf(path) ? `${name} — ${parentOf(path)}` : name;
  };

  return (
    <div
      className="flex h-full bg-card overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Left Sidebar - Directory Tree */}
      <div
        className="bg-muted overflow-auto shrink-0"
        style={{ width: prefs.sidebarWidth }}
      >
        <div className="h-12 flex items-center gap-2 px-3 border-b border-border bg-secondary">
          <h3 className="min-w-0 flex-1 font-medium text-foreground truncate">
            <span className="text-muted-foreground select-none">~/</span>
            {userLoginName}
          </h3>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setQuickOpen(true)}
            title={`파일로 이동 (${mod}P)`}
            aria-label="파일로 이동"
          >
            <Search />
          </Button>
          {/* A new tab, so unsaved edits here stay. */}
          <Button variant="ghost" size="icon" className="size-8" asChild>
            <a
              href="/help/files"
              target="_blank"
              rel="noopener"
              title="파일 편집기 도움말"
              aria-label="파일 편집기 도움말"
            >
              <CircleHelp />
            </a>
          </Button>
        </div>
        <DirectoryTree
          files={files}
          selectedFile={selectedFile}
          expandedFolders={expandedFolders}
          onFileSelect={handleFileSelect}
          onFolderToggle={handleFolderToggle}
          onRefresh={handleRefresh}
          uploading={uploading}
          onUpload={handleUpload}
          dirtyPaths={dirty}
          renamingPath={renamingPath}
          onStartRename={setRenamingPath}
          onCancelRename={() => setRenamingPath(null)}
          onRename={handleRename}
          onCreated={activate}
          onDeleted={handleDeleted}
          onMoved={remapAfterMove}
          onPreview={(path) => {
            activate(path);
            setPreference("preview", true);
          }}
          publicUrl={publicUrl}
        />
      </div>

      {/* Resize Handle */}
      <div
        className="w-1 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors shrink-0"
        onMouseDown={(e) => {
          e.preventDefault();
          setResizing("sidebar");
        }}
      />

      {/* Right Main Area - tabs, toolbar, editor and preview */}
      <div
        ref={mainRef}
        className="flex-1 flex flex-col min-w-0 overflow-hidden"
      >
        {tabs.length > 0 && (
          <div
            role="tablist"
            aria-label="열린 파일"
            className="flex h-10 shrink-0 overflow-x-auto border-b border-border bg-muted"
          >
            {tabs.map((path) => {
              const isActive = path === active;
              const isDirty = dirty.has(path);
              return (
                <div
                  key={path}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  title={path}
                  className={`group flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pl-3 pr-1 text-sm ${
                    isActive
                      ? "bg-card font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                  onClick={() => activate(path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate(path);
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(path);
                    }
                  }}
                >
                  {getFileIcon(path, false)}
                  <span className="truncate">{tabLabel(path)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-6 shrink-0 [&_svg]:size-3.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(path);
                    }}
                    title="닫기"
                    aria-label={`${basename(path)} 닫기`}
                  >
                    {isDirty && (
                      <span
                        className="absolute size-2 rounded-full bg-primary group-hover:hidden"
                        aria-label="저장하지 않음"
                      />
                    )}
                    <X
                      className={isDirty ? "invisible group-hover:visible" : ""}
                    />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="shrink-0 h-12 flex items-center gap-2 px-3 border-b border-border bg-secondary">
          {active ? (
            <>
              <div className="min-w-0 flex-1 truncate text-sm">
                <span className="text-muted-foreground">
                  {parentOf(active) ? `${parentOf(active)}/` : ""}
                </span>
                <span
                  className="font-medium text-foreground"
                  onDoubleClick={() =>
                    active !== "index.html" && setRenamingPath(active)
                  }
                  title="더블클릭하여 이름 변경 (F2)"
                >
                  {basename(active)}
                </span>
                {activeIsText && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {dirty.has(active)
                      ? "저장하지 않음"
                      : activeStatus?.savedAt
                        ? `저장됨 ${new Date(activeStatus.savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
                        : ""}
                  </span>
                )}
              </div>
              {activeIsText && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={formatActive}
                    disabled={!activeReady || !canFormat(active)}
                    title="Prettier로 포맷 (Shift+Alt+F)"
                  >
                    포맷
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDiffFor((current) =>
                        current === active ? null : active,
                      )
                    }
                    disabled={
                      !activeReady || (!dirty.has(active) && diffFor !== active)
                    }
                  >
                    {diffFor === active ? "편집" : "변경 사항"}
                  </Button>
                  <Button
                    variant={prefs.preview ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setPreference("preview", !prefs.preview)}
                    aria-pressed={prefs.preview}
                    title="미리보기"
                  >
                    <Eye /> 미리보기
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="px-2"
                        title="편집기 설정"
                        aria-label="편집기 설정"
                      >
                        <Settings2 />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuCheckboxItem
                        checked={prefs.wordWrap}
                        onCheckedChange={(checked) =>
                          setPreference("wordWrap", checked === true)
                        }
                      >
                        자동 줄바꿈
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        checked={prefs.minimap}
                        onCheckedChange={(checked) =>
                          setPreference("minimap", checked === true)
                        }
                      >
                        미니맵
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        checked={prefs.formatOnSave}
                        onCheckedChange={(checked) =>
                          setPreference("formatOnSave", checked === true)
                        }
                      >
                        저장할 때 포맷
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    onClick={() => saveFile(active)}
                    disabled={!activeReady}
                    title={`저장 (${mod}S)`}
                  >
                    저장
                  </Button>
                </div>
              )}
              {isImage && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileViewerRef.current?.zoomOut()}
                  >
                    축소
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileViewerRef.current?.resetZoom()}
                  >
                    원본
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileViewerRef.current?.zoomIn()}
                  >
                    확대
                  </Button>
                </div>
              )}
            </>
          ) : (
            <h3 className="font-medium text-foreground">파일을 선택하세요</h3>
          )}
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="relative flex-1 min-w-0 overflow-hidden">
            {editorPath && (
              <div className={activeReady ? "h-full" : "invisible h-full"}>
                <CodeEditor
                  path={editorPath}
                  preferences={prefs}
                  diff={diff}
                  onMount={(editor) => {
                    editorRef.current = editor;
                  }}
                />
              </div>
            )}
            {activeIsText && !activeReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-card">
                {activeStatus?.error ? (
                  <div className="text-center">
                    <p className="text-destructive mb-2">
                      파일을 불러올 수 없습니다
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {activeStatus.error}
                    </p>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 파일을 불러오는
                    중...
                  </p>
                )}
              </div>
            )}
            {active && !activeIsText && (
              <div className="absolute inset-0 overflow-auto bg-card">
                <FileViewer
                  key={active}
                  ref={fileViewerRef}
                  filePath={active}
                  userLoginName={userLoginName}
                />
              </div>
            )}
            {!active && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  <FolderOpen
                    size={60}
                    className="mx-auto mb-4"
                    strokeWidth={1.25}
                  />
                  <p>왼쪽에서 파일을 선택하여 내용을 확인하세요</p>
                  <p className="mt-2 text-sm">
                    {mod}P 파일로 이동 · {mod}S 저장
                  </p>
                </div>
              </div>
            )}
          </div>

          {prefs.preview && (
            <>
              <div
                className="w-1 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors shrink-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setResizing("preview");
                }}
              />
              <div
                className="shrink-0"
                style={{ width: prefs.previewWidth, maxWidth: "60%" }}
              >
                <PreviewPane
                  url={previewUrl}
                  version={previewVersion}
                  onClose={() => setPreference("preview", false)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* The preview's frame would swallow the mouse while resizing. */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      <QuickOpen
        open={quickOpen}
        onOpenChange={setQuickOpen}
        paths={allFiles}
        recent={recent}
        onPick={activate}
      />

      {/* Drag and Drop Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card p-6 text-center border-4 border-dashed border-primary">
            <Upload
              size={60}
              className="mx-auto mb-4 text-primary"
              strokeWidth={1.25}
            />
            <p className="text-xl font-semibold text-primary">
              파일을 여기에 드롭하세요
            </p>
            <p className="text-sm mt-2 text-muted-foreground">
              {getCurrentDirectory() || "루트 폴더"}에 업로드됩니다
            </p>
          </div>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {uploading && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card p-6 border-2 border-line text-center">
            <ArrowUpToLine size={28} className="mx-auto mb-2" />
            {uploadProgress && <UploadStatus progress={uploadProgress} />}
          </div>
        </div>
      )}
    </div>
  );
}
