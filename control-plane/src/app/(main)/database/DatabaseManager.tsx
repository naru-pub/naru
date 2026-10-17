"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ui/confirm";
import CollectionName from "@/components/CollectionName";
import WebsiteAccess from "./WebsiteAccess";
import MembershipManager from "./MembershipManager";
import RestorePoints from "./RestorePoints";
import DeclaredCollections from "./DeclaredCollections";
import { MAX_DOCUMENTS, MAX_SITE_BYTES } from "@/lib/site-data/validation";
import { SDK_URL } from "@/lib/const";

type Collection = {
  name: string;
  read_access: string;
  write_access: string;
  unique?: string[];
  indexes?: string[];
};
type Document = { id: string; data: unknown };
type Usage = {
  documents: number;
  bytes: number;
  requests: { used: number; limit: number; resetsAt: number };
};
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
/** The site's limits, as the database enforces them. */
const LIMITS = { documents: MAX_DOCUMENTS, bytes: MAX_SITE_BYTES };
/** What is near or at its limit, worded for the owner; nothing when all is well. */
function warnings(usage: Usage) {
  const parts: string[] = [];
  const near = (used: number, limit: number, what: string, effect: string) => {
    if (used >= limit) parts.push(`${what}을 다 써서 ${effect}`);
    else if (used >= limit * 0.8) parts.push(`${what}이 80%를 넘었습니다`);
  };
  near(
    usage.documents,
    LIMITS.documents,
    "문서 수",
    "새 문서를 쓸 수 없습니다",
  );
  near(usage.bytes, LIMITS.bytes, "용량", "새 문서를 쓸 수 없습니다");
  near(
    usage.requests.used,
    usage.requests.limit,
    "이번 달 요청",
    "회원과 방문자의 요청이 거절되고 있습니다",
  );
  return parts;
}
async function api(path = "", method = "GET", body?: unknown) {
  const response = await fetch(`/api/account/database${path}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function failureMessage(e: unknown) {
  return e instanceof Error ? e.message : "요청에 실패했습니다.";
}
export default function DatabaseManager({
  site,
  websiteUrl,
}: {
  site: string;
  websiteUrl: string;
}) {
  const [view, setView] = useState("collections");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState("");
  // Collections checked for deleting several at once.
  const [marked, setMarked] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [read, setRead] = useState("admin");
  const [write, setWrite] = useState("admin");
  const [unique, setUnique] = useState("");
  const [indexes, setIndexes] = useState("");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [json, setJson] = useState('{\n  "message": "안녕하세요!"\n}');
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const confirm = useConfirm();
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const next: Collection[] = (await api()).collections;
    setCollections(next);
    setMarked((current) =>
      current.filter((name) => next.some((c) => c.name === name)),
    );
  }
  /** Deletes every checked collection with its documents, after one confirmation. */
  async function deleteMarked() {
    const names = [...marked];
    if (
      !names.length ||
      !(await confirm({
        title: `컬렉션 ${names.length}개와 그 안의 모든 문서를 영구 삭제할까요?`,
        description: names.join(", "),
        confirmText: `${names.length}개 삭제`,
        destructive: true,
      }))
    )
      return;
    // One request, one transaction in the site's object: all are deleted,
    // or none are and the checks stay for another try.
    await run(async () => {
      await api("", "DELETE", { names });
      if (names.includes(selected)) {
        setSelected("");
        setDocuments([]);
        setTotal(null);
      }
      setMarked([]);
      await refresh();
    });
  }
  async function load(collection: string, after?: string) {
    // The list is paged, so the collection's real size comes with the first
    // page rather than from however many rows happen to be on screen.
    const result = await api(
      `/${collection}${after ? `?after=${encodeURIComponent(after)}` : "?includeTotal=1"}`,
    );
    setDocuments((previous) =>
      after ? [...previous, ...result.documents] : result.documents,
    );
    setCursor(result.nextCursor);
    if (!after) setTotal(result.totalCount);
  }
  useEffect(() => {
    api()
      .then((result) => {
        setCollections(result.collections);
        setUsage(result.usage ?? null);
      })
      .catch((e) => setError(failureMessage(e)))
      .finally(() => setBusy(false));
  }, []);
  // A page on the site's own subdomain needs no site option; custom domains do.
  const snippet = `import { createNaru } from "${SDK_URL}/1/naru.js";\nconst naru = createNaru({ site: ${JSON.stringify(site)} });\nconst entries = naru.collection(${JSON.stringify(selected || "guestbook")});\nconst page = await entries.list();`;
  return (
    <div className="mx-auto w-full max-w-7xl p-4 space-y-6 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="space-y-2 min-w-0">
          <p className="text-sm text-muted-foreground break-all">
            {site} · JSON 문서 저장소
          </p>
          <h1 className="text-2xl font-bold tracking-tight">데이터베이스</h1>
          <p className="text-sm text-muted-foreground">
            최대 100 MiB · 문서 100,000개 · 컬렉션 100개
          </p>
          {usage && (
            <p
              className={`text-sm ${
                warnings(usage).length
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              사용 중: 문서 {usage.documents.toLocaleString("ko-KR")}개 ·{" "}
              {mib(usage.bytes)} MiB · 이번 달 회원·방문자 요청{" "}
              {usage.requests.used.toLocaleString("ko-KR")} /{" "}
              {usage.requests.limit.toLocaleString("ko-KR")}회 (
              {new Date(usage.requests.resetsAt).toLocaleDateString("ko-KR")}에
              초기화)
              {warnings(usage).length
                ? ` — ${warnings(usage).join(", ")}.`
                : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/media">미디어 라이브러리 →</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/docs/database">사용 안내 및 예제 블로그 →</Link>
          </Button>
        </div>
      </header>
      <DeclaredCollections onApplied={() => void run(refresh)} />
      <Tabs value={view} onValueChange={setView} className="space-y-6">
        <TabsList aria-label="데이터베이스 메뉴">
          <TabsTrigger value="collections">컬렉션과 문서</TabsTrigger>
          <TabsTrigger value="access">웹사이트 관리자 로그인</TabsTrigger>
          <TabsTrigger value="members">사이트 회원</TabsTrigger>
          <TabsTrigger value="restore">복원 지점</TabsTrigger>
          <TabsTrigger value="sdk">웹 SDK</TabsTrigger>
        </TabsList>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {/* Panels stay mounted so each keeps its state across tab switches. */}
        <TabsContent
          value="collections"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <fieldset
            disabled={busy}
            aria-busy={busy}
            className="grid min-w-0 gap-6 disabled:opacity-60 lg:grid-cols-[240px_minmax(0,1fr)]"
          >
            <aside className="min-w-0 space-y-4 border bg-muted/20 p-4 self-start">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">컬렉션</h2>
                <span className="text-sm text-muted-foreground">
                  {collections.length} / 100
                </span>
              </div>
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const created = newName;
                    await api("", "POST", { name: created });
                    setSelected(created);
                    setRead("admin");
                    setWrite("admin");
                    setId("");
                    setDocuments([]);
                    setTotal(null);
                    setCursor(null);
                    setNewName("");
                    await refresh();
                    await load(created);
                  });
                }}
              >
                <label
                  htmlFor="new-collection-name"
                  className="text-sm font-medium"
                >
                  새 컬렉션 이름
                </label>
                <Input
                  id="new-collection-name"
                  aria-label="새 컬렉션 이름"
                  placeholder="예: guestbook"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                  pattern="[a-zA-Z0-9_\-]{1,64}"
                />
                <Button type="submit">컬렉션 만들기</Button>
              </form>
              {collections.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      aria-label="모든 컬렉션 선택"
                      checked={
                        marked.length === 0
                          ? false
                          : marked.length === collections.length
                            ? true
                            : "indeterminate"
                      }
                      onCheckedChange={(checked) =>
                        setMarked(
                          checked === true
                            ? collections.map((c) => c.name)
                            : [],
                        )
                      }
                    />
                    모두 선택
                  </label>
                  {marked.length > 0 && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void deleteMarked()}
                    >
                      선택한 컬렉션 삭제 ({marked.length})
                    </Button>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-2" aria-label="컬렉션 목록">
                {collections.map((c) => (
                  <div key={c.name} className="flex items-center gap-2">
                    <Checkbox
                      aria-label={`${c.name} 선택`}
                      checked={marked.includes(c.name)}
                      onCheckedChange={(checked) =>
                        setMarked((current) =>
                          checked === true
                            ? [...current, c.name]
                            : current.filter((name) => name !== c.name),
                        )
                      }
                    />
                    <Button
                      className="h-auto flex-1 justify-start whitespace-normal text-left"
                      aria-pressed={selected === c.name}
                      variant={selected === c.name ? "default" : "outline"}
                      onClick={() =>
                        void run(async () => {
                          setSelected(c.name);
                          setRead(c.read_access);
                          setWrite(c.write_access);
                          setUnique((c.unique ?? []).join(", "));
                          setIndexes((c.indexes ?? []).join(", "));
                          setId("");
                          setDocuments([]);
                          setTotal(null);
                          setCursor(null);
                          await load(c.name);
                        })
                      }
                    >
                      <CollectionName name={c.name} />
                    </Button>
                  </div>
                ))}
              </div>
              {!collections.length && (
                <p className="text-sm text-muted-foreground">
                  첫 컬렉션을 만들어 문서를 저장하세요.
                </p>
              )}
            </aside>
            <div className="min-w-0 space-y-5">
              {!selected && (
                <section className="border border-dashed p-10 text-center space-y-2">
                  <h2 className="font-semibold">컬렉션을 선택하세요</h2>
                  <p className="text-sm text-muted-foreground">
                    컬렉션을 선택하면 문서를 조회하고 편집할 수 있습니다.
                  </p>
                </section>
              )}
              {selected && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold">
                      <CollectionName name={selected} />
                    </h2>
                    <span className="text-sm text-muted-foreground">
                      {total === null
                        ? `불러온 문서 ${documents.length}개`
                        : `문서 ${total}개 중 ${documents.length}개 불러옴`}
                    </span>
                  </div>
                  <details className="border p-4 space-y-4">
                    <summary className="cursor-pointer font-medium">
                      접근 권한 및 컬렉션 설정
                    </summary>
                    <p className="text-sm text-muted-foreground">
                      공개 읽기는 누구나 조회할 수 있습니다. 공개 생성은 추가만,
                      전체 공개 쓰기는 덮어쓰기와 삭제까지 허용합니다.
                    </p>
                    <h2 className="font-bold">
                      <CollectionName name={selected} /> · 접근 권한
                    </h2>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        읽기
                        <Select
                          value={read}
                          onChange={(e) => setRead(e.target.value)}
                        >
                          <option value="admin">관리자만</option>
                          <option value="world">누구나</option>
                        </Select>
                      </label>
                      <label className="flex items-center gap-2 text-sm font-medium">
                        쓰기
                        <Select
                          value={write}
                          onChange={(e) => setWrite(e.target.value)}
                        >
                          <option value="admin">관리자만</option>
                          <option value="create">누구나 생성만</option>
                          <option value="world">
                            누구나 생성·덮어쓰기·삭제
                          </option>
                        </Select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-sm">고유 필드</span>
                        <Input
                          value={unique}
                          onChange={(event) => setUnique(event.target.value)}
                          placeholder="예: nick (쉼표로 최대 3개)"
                        />
                        <p className="text-xs text-muted-foreground">
                          두 문서가 이 필드에 같은 문자열이나 숫자를 가질 수
                          없습니다. 이미 겹치는 문서가 있으면 저장되지 않습니다.
                        </p>
                      </label>
                      <label className="space-y-1">
                        <span className="text-sm">색인 필드</span>
                        <Input
                          value={indexes}
                          onChange={(event) => setIndexes(event.target.value)}
                          placeholder="예: board, owner (쉼표로 최대 5개)"
                        />
                        <p className="text-xs text-muted-foreground">
                          자주 거르는 필드를 적으면 문서가 많아도 그 필드로 거른
                          목록을 빨리 읽습니다. 쓰기는 조금 느려집니다.
                        </p>
                      </label>
                      <Button
                        onClick={async () => {
                          if (
                            write === "world" &&
                            !(await confirm({
                              title:
                                "누구나 이 컬렉션의 문서를 덮어쓰거나 삭제할 수 있습니다. 허용할까요?",
                              confirmText: "허용",
                              destructive: true,
                            }))
                          )
                            return;
                          void run(async () => {
                            await api(`/${selected}`, "PATCH", {
                              read,
                              write,
                              unique: unique
                                .split(",")
                                .map((field) => field.trim())
                                .filter(Boolean),
                              indexes: indexes
                                .split(",")
                                .map((field) => field.trim())
                                .filter(Boolean),
                            });
                            await refresh();
                          });
                        }}
                      >
                        권한 저장
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `컬렉션 ${selected} 및 모든 문서를 영구 삭제할까요?`,
                              confirmText: "삭제",
                              destructive: true,
                            })
                          )
                            void run(async () => {
                              await api(`/${selected}`, "DELETE");
                              setSelected("");
                              setDocuments([]);
                              setTotal(null);
                              await refresh();
                            });
                        }}
                      >
                        컬렉션 삭제
                      </Button>
                    </div>
                  </details>
                  <div className="grid xl:grid-cols-2 gap-5 min-w-0">
                    <section className="min-w-0 border p-4 space-y-3">
                      <h2 className="font-bold">문서</h2>
                      <Button
                        variant="outline"
                        onClick={() => void run(() => load(selected))}
                      >
                        새로고침
                      </Button>
                      {!documents.length && (
                        <p className="text-muted-foreground">
                          문서가 없습니다.
                        </p>
                      )}
                      {documents.map((d) => (
                        <div className="border p-3 space-y-2" key={d.id}>
                          <Button
                            variant="link"
                            className="block h-auto whitespace-normal break-all p-0 text-left underline"
                            onClick={() => {
                              setId(d.id);
                              setJson(JSON.stringify(d.data, null, 2));
                            }}
                          >
                            {d.id}
                          </Button>
                          <pre className="text-xs overflow-auto max-h-32">
                            {JSON.stringify(d.data, null, 2)}
                          </pre>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `문서 ${d.id}를 삭제할까요?`,
                                  confirmText: "삭제",
                                  destructive: true,
                                })
                              )
                                void run(async () => {
                                  await api(`/${selected}/${d.id}`, "DELETE");
                                  await load(selected);
                                });
                            }}
                          >
                            삭제
                          </Button>
                        </div>
                      ))}
                      {cursor && (
                        <Button
                          variant="outline"
                          onClick={() => void run(() => load(selected, cursor))}
                        >
                          더 보기
                        </Button>
                      )}
                    </section>
                    <form
                      className="min-w-0 self-start border p-4 space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          const data = JSON.parse(json);
                          await api(
                            `/${selected}${id ? `/${id}` : ""}`,
                            id ? "PUT" : "POST",
                            { data },
                          );
                          await load(selected);
                        });
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-bold">
                          {id ? "문서 편집" : "새 문서"}
                        </h2>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setId("");
                            setJson("{\n\n}");
                          }}
                        >
                          새 문서
                        </Button>
                      </div>
                      <Input
                        aria-label="문서 ID"
                        placeholder="문서 ID (비워두면 자동 생성)"
                        value={id}
                        pattern="[a-zA-Z0-9_\-]{1,64}"
                        onChange={(e) => setId(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        기존 ID를 사용하면 문서 전체를 덮어씁니다. 요청 본문은
                        최대 64 KiB입니다.
                      </p>
                      <Textarea
                        aria-label="JSON 데이터"
                        className="h-80 p-3 font-mono text-sm"
                        value={json}
                        onChange={(e) => setJson(e.target.value)}
                        spellCheck={false}
                      />
                      <Button type="submit">문서 저장</Button>
                    </form>
                  </div>
                </>
              )}
            </div>
          </fieldset>
        </TabsContent>
        <TabsContent
          value="access"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <WebsiteAccess collections={collections} websiteUrl={websiteUrl} />
        </TabsContent>
        <TabsContent
          value="members"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <MembershipManager />
        </TabsContent>
        {/* Loaded when opened: most visits never list restore points. */}
        <TabsContent value="restore">
          {view === "restore" && <RestorePoints />}
        </TabsContent>
        <TabsContent
          value="sdk"
          forceMount
          asChild
          className="data-[state=inactive]:hidden"
        >
          <section className="min-w-0 border p-5 space-y-4">
            <h2 className="font-bold">웹 SDK</h2>
            <p className="text-sm">
              사이트의 &lt;script type=&quot;module&quot;&gt;에서 사용하세요.
            </p>
            <pre className="p-4 bg-muted overflow-auto text-sm">{snippet}</pre>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
