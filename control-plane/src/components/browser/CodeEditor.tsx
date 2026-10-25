"use client";

import { useEffect, useMemo, useRef } from "react";
import MonacoEditor, {
  DiffEditor,
  type Monaco,
  type OnMount,
} from "@monaco-editor/react";
import type { editor, languages } from "monaco-editor";
import { emmetCSS, emmetHTML } from "emmet-monaco-es";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { canFormat, formatCode } from "./format";
import { languageOf, modelPath } from "./useOpenFiles";

export type CodeEditorInstance = Parameters<OnMount>[0];

export interface EditorPreferences {
  wordWrap: boolean;
  minimap: boolean;
}

// Monaco registers languages' providers for the whole page, so each is
// registered once per Monaco instance, not per editor.
const prepared = new WeakSet<object>();

function prepare(monaco: Monaco) {
  if (prepared.has(monaco)) return;
  prepared.add(monaco);

  // Emmet abbreviations (ul>li*3, .card, m10) expand from the suggestions.
  emmetHTML(withTokenizedLines(monaco), ["html"]);
  emmetCSS(withTokenizedLines(monaco), ["css"]);

  // Prettier as Monaco's formatter, so Format Document (Shift+Alt+F, the
  // context menu) formats as the toolbar's button does. Monaco's own HTML,
  // CSS, JSON and JavaScript formatters would win over it, so they are off.
  // The language services are on the full editor Monaco loads, not on the
  // editor API's types.
  type Defaults = {
    modeConfiguration: object;
    setModeConfiguration(configuration: object): void;
  };
  const services = monaco.languages as unknown as Record<
    string,
    Record<string, Defaults | undefined> | undefined
  >;
  for (const defaults of [
    services.html?.htmlDefaults,
    services.css?.cssDefaults,
    services.json?.jsonDefaults,
    services.typescript?.javascriptDefaults,
  ]) {
    defaults?.setModeConfiguration({
      ...defaults.modeConfiguration,
      documentFormattingEdits: false,
      documentRangeFormattingEdits: false,
    });
  }
  for (const language of [
    "html",
    "xml",
    "css",
    "javascript",
    "json",
    "markdown",
  ]) {
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: "Prettier",
      async provideDocumentFormattingEdits(model: editor.ITextModel) {
        const path = decodeURIComponent(model.uri.path).replace(/^\//, "");
        if (!canFormat(path)) return [];
        try {
          const text = await formatCode(path, model.getValue());
          return [{ range: model.getFullModelRange(), text }];
        } catch (error) {
          toast.error(
            `포맷 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
          );
          return [];
        }
      },
    });
  }
}

// emmet-monaco-es decides whether the cursor may start an abbreviation by
// re-tokenizing its line from the tokenizer state Monaco stored for the line
// before, and throws when there is none: Monaco tokenizes a long file in the
// background, and a line scrolled to before that reaches it has no stored
// state. Its completion providers get the lines up to the cursor tokenized
// first. The state is read from Monaco's internals, so should they still not
// hold, the provider offers no abbreviations instead of throwing.
function withTokenizedLines(monaco: Monaco): Monaco {
  type Tokenized = { tokenization: { forceTokenization(line: number): void } };
  return {
    ...monaco,
    languages: {
      ...monaco.languages,
      registerCompletionItemProvider(
        language: languages.LanguageSelector,
        provider: languages.CompletionItemProvider,
      ) {
        return monaco.languages.registerCompletionItemProvider(language, {
          ...provider,
          provideCompletionItems(
            ...args: Parameters<
              languages.CompletionItemProvider["provideCompletionItems"]
            >
          ) {
            try {
              const [model, position] = args;
              (model as unknown as Tokenized).tokenization.forceTokenization(
                position.lineNumber,
              );
              return provider.provideCompletionItems(...args);
            } catch {
              return undefined;
            }
          },
        });
      },
    },
  };
}

/**
 * The file manager's one editor. It shows the model useOpenFiles keeps for
 * `path`, which must already exist; `diff` shows the unsaved changes
 * against the stored file instead.
 */
export default function CodeEditor({
  path,
  preferences,
  diff,
  onMount,
}: {
  path: string;
  preferences: EditorPreferences;
  diff: { original: string; modified: string } | null;
  onMount?: (editor: CodeEditorInstance) => void;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "vs-dark" : "light";
  const diffEditorRef = useRef<any>(null);

  const options = useMemo(
    () => ({
      minimap: { enabled: preferences.minimap },
      wordWrap: preferences.wordWrap ? ("on" as const) : ("off" as const),
      lineNumbers: "on" as const,
      folding: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      linkedEditing: true,
      fixedOverflowWidgets: true,
    }),
    [preferences.minimap, preferences.wordWrap],
  );

  // @monaco-editor/react disposes the diff models before the diff editor on
  // unmount, which makes Monaco throw "TextModel got disposed before
  // DiffEditorWidget model got reset". Keep the models in the library and
  // dispose the editor first, then its models, whenever the diff view closes.
  const showDiff = diff !== null;
  useEffect(() => {
    if (!showDiff) return;
    return () => {
      const diffEditor = diffEditorRef.current;
      diffEditorRef.current = null;
      if (!diffEditor) return;
      const model = diffEditor.getModel();
      diffEditor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, [showDiff]);

  useEffect(() => {
    // Monaco's _doFindMatchesMultiline doesn't catch invalid regex errors (monaco-editor bug).
    // Suppress them here so they don't surface as unhandled errors.
    const handleError = (event: ErrorEvent) => {
      if (
        event.message.startsWith("Invalid regular expression:") &&
        event.error?.stack?.includes("monaco-editor")
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("error", handleError);
    };
  }, []);

  return (
    <div className="relative h-full">
      {/* Hidden, not unmounted, under the diff: it keeps its models and state. */}
      <div className={showDiff ? "invisible h-full" : "h-full"}>
        <MonacoEditor
          path={modelPath(path)}
          language={languageOf(path)}
          height="100%"
          theme={theme}
          keepCurrentModel
          beforeMount={prepare}
          onMount={(editor) => onMount?.(editor)}
          options={options}
        />
      </div>
      {diff && (
        <div className="absolute inset-0">
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={languageOf(path)}
            theme={theme}
            height="100%"
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            onMount={(diffEditor) => {
              diffEditorRef.current = diffEditor;
            }}
            options={{
              ...options,
              renderSideBySide: true,
              readOnly: true,
            }}
          />
        </div>
      )}
    </div>
  );
}
