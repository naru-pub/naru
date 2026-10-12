import { notFound } from "next/navigation";
import DocsIndex from "../_guides/Index";
import { DOC_VERSIONS, isDocsVersion } from "../versions";
export function generateStaticParams() {
  return DOC_VERSIONS.map((version) => ({ version }));
}
export default async function Page({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  if (!isDocsVersion(version)) notFound();
  return <DocsIndex version={version} />;
}
