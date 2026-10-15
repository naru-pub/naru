"use client";
import { useEffect, useState } from "react";
import type { CollectionRequest } from "@/lib/site-data/owner-auth";
import type { DeclaredPlan } from "@/lib/site-data/declared-collections";
import { Button } from "@/components/ui/button";
import CollectionChanges from "./CollectionChanges";

// What the site's _naru/collections.json still asks for: new collections Naru
// could not create as the file arrived, and changes to existing ones, which
// wait for the owner. Shows nothing when the site has no declaration or
// everything it declares is in place.
export default function DeclaredCollections({
  onApplied,
}: {
  onApplied: () => void;
}) {
  const [state, setState] = useState<{
    declared: Record<string, CollectionRequest>;
    plan: DeclaredPlan;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function fetchDeclaration() {
    const response = await fetch("/api/account/collection-declaration");
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(body?.message ?? "컬렉션 선언을 확인하지 못했습니다.");
    return body?.declared ? body : null;
  }
  useEffect(() => {
    fetchDeclaration()
      .then(setState)
      .catch((failure) => setError((failure as Error).message));
  }, []);

  async function apply() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/collection-declaration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(body?.message ?? "적용하지 못했습니다.");
      setState(await fetchDeclaration());
      onApplied();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <p role="alert" className="border-2 border-destructive p-3 text-sm">
        <code>_naru/collections.json</code>: {error}
      </p>
    );
  if (!state || (!state.plan.create.length && !state.plan.configure.length))
    return null;
  return (
    <section
      aria-label="컬렉션 선언"
      className="space-y-4 border-2 border-line bg-card p-4"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-bold">
          사이트가 요청한 컬렉션 설정이 있습니다
        </h2>
        <p className="text-sm text-muted-foreground">
          사이트의 <code>_naru/collections.json</code>이 아래 내용을 요청합니다.
          기존 컬렉션의 설정은 확인한 뒤에만 바뀝니다.
        </p>
      </div>
      <CollectionChanges setup={state.plan} settings={state.declared} />
      <Button disabled={busy} onClick={() => void apply()}>
        {busy ? "적용하는 중…" : "적용하기"}
      </Button>
    </section>
  );
}
