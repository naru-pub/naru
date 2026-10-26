"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  OwnerQueryAnswer,
  SiteTable,
  TableCell,
  TableRowsPage,
} from "@/lib/site-data/site-tables-http";

async function get<T>(query = ""): Promise<T> {
  const response = await fetch(`/api/account/site-tables${query}`, {
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "테이블을 불러오지 못했습니다.");
  return result;
}

const bytes = (n: number) =>
  n < 1024
    ? `${n.toLocaleString("ko-KR")} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024).toLocaleString("ko-KR")} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

function Cell({ value }: { value: TableCell }) {
  if (value === null)
    return <span className="text-muted-foreground">NULL</span>;
  if (typeof value === "object" && "blob" in value)
    return (
      <span className="text-muted-foreground">BLOB {bytes(value.blob)}</span>
    );
  if (typeof value === "object")
    return (
      <span title={`${value.length.toLocaleString("ko-KR")}자 중 앞부분`}>
        {value.text}
        <span className="text-muted-foreground">
          … ({value.length.toLocaleString("ko-KR")}자)
        </span>
      </span>
    );
  return <>{String(value)}</>;
}

function Grid({ columns, rows }: { columns: string[]; rows: TableCell[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            {columns.map((column, i) => (
              <th key={i} className="py-2 pr-4 font-mono">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t align-top">
              {row.map((value, j) => (
                <td
                  key={j}
                  className="py-2 pr-4 max-w-xs break-words whitespace-pre-wrap"
                >
                  <Cell value={value} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One read-only statement of the owner's own SQL (SELECT, VALUES or WITH …
 * SELECT) over the site's tables, its first 1,000 rows shown as a table's
 * page shows them. Writes and schema changes are refused by the site's
 * object, as a query of the site's own is.
 */
function Console({ example }: { example: string }) {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<OwnerQueryAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/site-tables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "조회하지 못했습니다.");
      setAnswer(result);
    } catch (e) {
      setAnswer(null);
      setError(e instanceof Error ? e.message : "조회하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="min-w-0 border p-5 space-y-4">
      <h2 className="font-bold">SQL 조회</h2>
      <p className="text-sm text-muted-foreground">
        SELECT 문 하나로 테이블을 조회합니다. 업로드(
        <code>_naru_uploads</code>)도 함께 읽을 수 있습니다. 데이터를 바꾸는
        문장은 실행하지 않으며, 결과는 처음 1,000행까지 보입니다.
      </p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Textarea
          aria-label="SQL"
          className="min-h-24 font-mono"
          placeholder={example}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={busy || !text.trim()}>
          실행
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {answer && (
        <div className="space-y-3">
          <p className="text-sm" role="status">
            {answer.more
              ? `처음 ${answer.rows.length.toLocaleString("ko-KR")}개 행만 보입니다.`
              : `${answer.rows.length.toLocaleString("ko-KR")}개 행`}
          </p>
          {answer.rows.length > 0 && (
            <Grid columns={answer.columns} rows={answer.rows} />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The site's own SQL tables (1.1.0), read only: each table's rows a page at
 * a time, in the order they were added. Views and Naru's own tables are not
 * browsed; rows change only through the site's mutations or a restore.
 */
export default function SiteTables() {
  const [tables, setTables] = useState<SiteTable[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [page, setPage] = useState<TableRowsPage | null>(null);
  const [count, setCount] = useState<TableRowsPage["count"]>();
  // Each shown page's `after`: the first page's is null.
  const [trail, setTrail] = useState<(number | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    get<{ tables: SiteTable[] }>()
      .then(({ tables }) => {
        if (active) setTables(tables);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function open(table: string, after: number | null, back: boolean) {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ table });
      if (after !== null) params.set("after", String(after));
      const next = await get<TableRowsPage>(`?${params}`);
      setChosen(table);
      setPage(next);
      if (next.count) setCount(next.count);
      setTrail((trail) =>
        after === null ? [null] : back ? trail.slice(0, -1) : [...trail, after],
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "테이블을 불러오지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  const shownFrom =
    page && trail.length ? (trail.length - 1) * 100 + 1 : undefined;

  const firstTable = tables?.find((table) => !table.view)?.name;
  return (
    <div className="space-y-6">
      <section className="min-w-0 border p-5 space-y-4">
        <h2 className="font-bold">테이블</h2>
        <p className="text-sm text-muted-foreground">
          사이트의 SQL 테이블(<code>_naru/migrations/</code>로 만든 것)과 그
          행을 봅니다. 여기서는 읽기만 하며, 행은 사이트의 뮤테이션이나 복원
          지점으로 바뀝니다. 긴 텍스트는 앞부분만, BLOB은 크기만 보입니다.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {tables && !tables.length && (
          <p>
            아직 테이블이 없습니다. SDK 1.0.0의 데이터는 컬렉션과 문서 탭에
            있습니다.
          </p>
        )}
        {tables && tables.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="테이블 목록">
            {tables.map((table) => (
              <li key={table.name}>
                {table.view ? (
                  <span
                    className="inline-block px-3 py-1.5 text-sm text-muted-foreground"
                    title="뷰는 여기서 보지 않습니다."
                  >
                    {table.name} (뷰)
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant={chosen === table.name ? "default" : "outline"}
                    aria-pressed={chosen === table.name}
                    disabled={busy}
                    onClick={() => void open(table.name, null, false)}
                  >
                    {table.name}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {page && (
          <div className="space-y-3">
            <p className="text-sm" role="status">
              {page.table}:{" "}
              {count
                ? `${count.rows.toLocaleString("ko-KR")}개${count.more ? " 이상" : ""} 행`
                : ""}
              {page.rows.length > 0 &&
                shownFrom !== undefined &&
                ` 중 ${shownFrom.toLocaleString("ko-KR")}–${(shownFrom + page.rows.length - 1).toLocaleString("ko-KR")}번째`}
            </p>
            {page.rows.length === 0 ? (
              <p>행이 없습니다.</p>
            ) : (
              <Grid columns={page.columns} rows={page.rows} />
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || trail.length < 2}
                onClick={() =>
                  void open(page.table, trail[trail.length - 2], true)
                }
              >
                이전
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || page.next === null}
                onClick={() => void open(page.table, page.next, false)}
              >
                다음
              </Button>
            </div>
          </div>
        )}
      </section>
      <Console example={`SELECT * FROM ${firstTable ?? "posts"} LIMIT 10`} />
    </div>
  );
}
