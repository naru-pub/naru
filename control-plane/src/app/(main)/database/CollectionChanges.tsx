"use client";
import type { CollectionRequest } from "@/lib/site-data/owner-auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ACCESS: Record<string, string> = {
  admin: "관리자만",
  member: "회원",
  create: "누구나 새 글만",
  world: "누구나",
};
const LABELS: Record<string, string> = {
  read: "읽기",
  write: "쓰기",
  rules: "규칙",
  unique: "중복 금지 필드",
  indexes: "색인 필드",
};
const shown = (key: string, value: string) =>
  key === "read" || key === "write"
    ? (ACCESS[value] ?? value)
    : value || "없음";
// Opening a collection beyond admins is called out before the owner agrees.
const widens = (key: string, [from, to]: [string, string]) =>
  (key === "read" || key === "write") && from === "admin" && to !== "admin";

// The collections a site would get and the settings that would change, as
// tables: shown before an owner's sign-in sets a site up (authorize/Setup) and
// when a site's _naru/collections.json asks for changes (DeclaredCollections).
export default function CollectionChanges({
  setup,
  settings,
}: {
  setup: {
    create: string[];
    configure: { name: string; changes: Record<string, [string, string]> }[];
  };
  settings?: Record<string, CollectionRequest>;
}) {
  const widened = setup.configure.some(({ changes }) =>
    Object.entries(changes).some(([key, change]) => widens(key, change)),
  );
  return (
    <>
      {setup.create.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">
            새로 만들 컬렉션 ({setup.create.length})
          </h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>컬렉션</TableHead>
                  <TableHead>읽기</TableHead>
                  <TableHead>쓰기</TableHead>
                  <TableHead>규칙</TableHead>
                  <TableHead>중복 금지 필드</TableHead>
                  <TableHead>색인 필드</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {setup.create.map((collection) => {
                  const wanted = settings?.[collection];
                  return (
                    <TableRow key={collection}>
                      <TableCell className="font-mono">{collection}</TableCell>
                      <TableCell>{ACCESS[wanted?.read ?? "admin"]}</TableCell>
                      <TableCell>{ACCESS[wanted?.write ?? "admin"]}</TableCell>
                      <TableCell className="font-mono">
                        {wanted?.rules || "—"}
                      </TableCell>
                      <TableCell className="font-mono">
                        {wanted?.unique?.join(", ") || "—"}
                      </TableCell>
                      <TableCell className="font-mono">
                        {wanted?.indexes?.join(", ") || "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground">
            설정은 나중에 제어판에서 바꿀 수 있습니다.
          </p>
        </section>
      )}
      {setup.configure.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">
            설정이 바뀌는 컬렉션 ({setup.configure.length})
          </h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>컬렉션</TableHead>
                  <TableHead>항목</TableHead>
                  <TableHead>지금</TableHead>
                  <TableHead>바뀐 뒤</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {setup.configure.flatMap(({ name, changes }) =>
                  Object.entries(changes).map(([key, change], index) => (
                    <TableRow
                      key={`${name}:${key}`}
                      className={
                        widens(key, change)
                          ? "font-semibold text-destructive"
                          : undefined
                      }
                    >
                      <TableCell className="font-mono">
                        {index === 0 ? name : ""}
                      </TableCell>
                      <TableCell>{LABELS[key]}</TableCell>
                      <TableCell>{shown(key, change[0])}</TableCell>
                      <TableCell>{shown(key, change[1])}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </div>
          {widened && (
            <p className="text-sm text-destructive">
              빨간 줄은 관리자만 보던 자료를 회원이나 방문자에게 엽니다. 규칙이
              함께 설정되는지 확인하세요.
            </p>
          )}
        </section>
      )}
    </>
  );
}
