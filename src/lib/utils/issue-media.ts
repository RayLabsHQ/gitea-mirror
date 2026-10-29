const MEDIA_PLACEHOLDER = "[media omitted]";

/**
 * Image and attachment hosts GitHub uses in issue bodies and comments. They are
 * the expensive ones to load and the reason a mirror may want to drop media.
 */
const GITHUB_MEDIA_URL =
  /https?:\/\/(?:[^\s/]+\.)?githubusercontent\.com\/[^\s)>\]]+|https?:\/\/github\.com\/user-attachments\/assets\/[^\s)>\]]+/gi;

/**
 * Markdown links whose target is one of those media hosts. This runs before
 * the bare URL pass so `[screenshot](https://user-images...)` becomes one
 * placeholder instead of a broken empty link.
 */
const MARKDOWN_MEDIA_LINK =
  /\[([^\]]*)\]\((https?:\/\/(?:[^\s/]+\.)?githubusercontent\.com\/[^\s)]+|https?:\/\/github\.com\/user-attachments\/assets\/[^\s)]+)(?:\s+"[^"]*")?\)/gi;

/** Inline Markdown images, with optional title. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** HTML media blocks/tags that can be embedded in Markdown. */
const HTML_MEDIA = [
  /<picture\b[^>]*>[\s\S]*?<\/picture>/gi,
  /<video\b[^>]*>[\s\S]*?<\/video>/gi,
  /<audio\b[^>]*>[\s\S]*?<\/audio>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  /<(?:img|source)\b[^>]*\/?>/gi,
];

/**
 * Remove images, videos and attachment links from an issue body or comment.
 *
 * With the "issue media" option off we still want the text of the issue, so
 * this drops only the media references and leaves everything else intact. It
 * does not download anything; it just prevents the mirrored copy from pointing
 * at GitHub-hosted media that would be loaded every time the issue is opened.
 */
export function stripIssueMedia(value: string | null | undefined): string {
  if (!value) return "";

  // Code blocks may document Markdown/HTML media syntax. Protect them so the
  // cleanup only touches content the author actually rendered as media.
  const codeBlocks: string[] = [];
  let result = value.replace(/```[\s\S]*?```|`[^`\n]*`/g, (block) => {
    const index = codeBlocks.push(block) - 1;
    return `\u0000${index}\u0000`;
  });

  // Images first: their target URL is often a media host, and running the
  // link pass first would leave the leading `![...]` behind.
  result = result.replace(MARKDOWN_IMAGE, MEDIA_PLACEHOLDER);
  result = result.replace(MARKDOWN_MEDIA_LINK, MEDIA_PLACEHOLDER);
  for (const pattern of HTML_MEDIA) {
    result = result.replace(pattern, MEDIA_PLACEHOLDER);
  }
  result = result.replace(GITHUB_MEDIA_URL, MEDIA_PLACEHOLDER);

  // An image wrapped in a link leaves either `[](url)` or a link whose text is
  // just the placeholder behind; collapse both so the body does not keep a
  // meaningless link.
  result = result.replace(
    /\[\[media omitted\]\]\([^)]*\)/g,
    MEDIA_PLACEHOLDER
  );
  result = result.replace(/\[\]\([^)]*\)/g, MEDIA_PLACEHOLDER);

  // Removing block-level media leaves runs of blank lines behind. Keep the
  // author's paragraph spacing but avoid growing the body with empty space.
  result = result.replace(/\n{3,}/g, "\n\n");

  result = result.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return codeBlocks[Number.parseInt(index, 10)] ?? "";
  });

  return result.trim();
}

/** Apply the media option without changing bodies when media is enabled. */
export function applyIssueMediaOption(
  value: string | null | undefined,
  includeMedia: boolean
): string {
  return includeMedia ? value ?? "" : stripIssueMedia(value);
}
