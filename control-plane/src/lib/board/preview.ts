// Where templates live in storage, and their preview images. Apart from
// templates.ts so the screenshot CLI can use them without the web server's
// modules.

import { getSiteBucketUrl } from "@/lib/site-urls";

// A template's snapshots, in the site bucket.
export function templatePrefix(templateId: string): string {
  return `_templates/${templateId}/`;
}

export function templateFileKey(
  templateId: string,
  version: number,
  path: string,
): string {
  return `${templatePrefix(templateId)}v${version}/${path}`;
}

// Previews live in the site bucket beside the version's files.
export function templatePreviewKey(templateId: string, version: number) {
  return `${templatePrefix(templateId)}v${version}.png`;
}

// The image the template's author set in place of the screenshots.
export function templateCustomPreviewKey(templateId: string) {
  return `${templatePrefix(templateId)}preview`;
}

export function getTemplatePreviewUrl(
  templateId: string,
  version: number,
  renderedAt: Date | string | null,
): string | null {
  if (!renderedAt) return null;
  const stamp = new Date(renderedAt).getTime();
  return `${getSiteBucketUrl(templatePreviewKey(templateId, version))}?v=${stamp}`;
}

// What a template shows: its own preview image when its author set one,
// else the latest version's screenshot.
export function templatePreviewUrl(template: {
  id: string;
  customPreviewAt: Date | string | null;
  version: number | null;
  renderedAt: Date | string | null;
}): string | null {
  if (template.customPreviewAt) {
    const stamp = new Date(template.customPreviewAt).getTime();
    return `${getSiteBucketUrl(templateCustomPreviewKey(template.id))}?v=${stamp}`;
  }
  return template.version
    ? getTemplatePreviewUrl(template.id, template.version, template.renderedAt)
    : null;
}
