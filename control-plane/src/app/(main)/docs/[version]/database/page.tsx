import { notFound } from "next/navigation";
import Stable from "../../_guides/1.0.0/database";
import Development from "../../_guides/1.1.0/database";
import { DOC_VERSIONS, isDocsVersion } from "../../versions";
export function generateStaticParams() {
  return DOC_VERSIONS.map((version) => ({ version }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  if (!isDocsVersion(version)) return {};
  return { title: `SDK ${version} · database | 나루` };
}
export default async function Page({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  if (!isDocsVersion(version)) notFound();
  return version === "1.0.0" ? <Stable /> : <Development />;
}
