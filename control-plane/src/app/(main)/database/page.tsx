import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import DatabaseManager from "./DatabaseManager";
import { isTab } from "./tabs";
import { getHomepageUrl } from "@/lib/site-urls";
import { userHasFeature } from "@/lib/entitlements";

export default async function DatabasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await searchParams;
  const { user } = await validateRequest();
  if (!user) redirect("/supporter");
  if (!(await userHasFeature(user.id, "database"))) redirect("/supporter");
  return (
    <DatabaseManager
      site={user.loginName}
      websiteUrl={`${getHomepageUrl(user.loginName)}/`}
      tab={isTab(tab) ? tab : undefined}
    />
  );
}
