import { notFound } from "next/navigation";
import Previous from "../../_guides/1.0.0/media";
import Latest from "../../_guides/1.1.0/media";
import Next from "../../_guides/1.2.0/media";
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
  return { title: `SDK ${version} · media | 나루` };
}
export default async function Page({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  if (!isDocsVersion(version)) notFound();
  return version === "1.0.0" ? (
    <Previous />
  ) : version === "1.1.0" ? (
    <Latest />
  ) : (
    <Next />
  );
}
