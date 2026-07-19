import fetch from "node-fetch";

const HASH_RE = "[a-f0-9]{40,}";

const EXTENSION_MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function mimeTypeFromFilename(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return EXTENSION_MIME_TYPES[ext] || null;
}

/**
 * Identifies which of itm.fileuploader.pl's two distinct link shapes a URL
 * is, since they use completely different APIs under the hood (confirmed by
 * inspecting the app's own JS bundle - not documented anywhere):
 *  - /view/{hash}  -> ONE file. Metadata at /api/view/{hash}, bytes at
 *    /api/view/{hash}/file.
 *  - /share/{hash} -> a FOLDER (created via the app's "public folder" link
 *    flow). Listing at /api/share/{hash}/files, bytes at
 *    /api/share/{hash}/download?path=<name>. There is no single-file
 *    endpoint for a share hash - /api/view/{hash}/file 404s for it.
 * Returns { type: "view"|"share"|"unknown", base, hash }.
 */
export function parseFileuploaderLink(url) {
  const trimmed = (url || "").trim();
  const shareMatch = trimmed.match(new RegExp(`^(https?://[^/]+)/share/(${HASH_RE})`, "i"));
  if (shareMatch) return { type: "share", base: shareMatch[1], hash: shareMatch[2] };
  const viewMatch = trimmed.match(new RegExp(`^(https?://[^/]+)/view/(${HASH_RE})`, "i"));
  if (viewMatch) return { type: "view", base: viewMatch[1], hash: viewMatch[2] };
  return { type: "unknown", base: null, hash: null };
}

/**
 * Converts an itm.fileuploader.pl /view/{hash} link into its direct file
 * URL. Port of fileuploader_direct() from meta_creator.py (Meta ad creation
 * script), narrowed to /view/ only - see parseFileuploaderLink's docstring
 * for why /share/ can't be handled the same way.
 */
export function fileuploaderDirect(url) {
  const parsed = parseFileuploaderLink(url);
  if (parsed.type !== "view") return (url || "").trim(); // already direct, or a /share/ folder link
  return `${parsed.base}/api/view/${parsed.hash}/file`;
}

/**
 * Downloads the raw bytes of a single-file fileuploader link (/view/{hash}
 * or an already-direct URL). Unlike the Meta Graph API (which accepts a URL
 * and fetches the image itself), WP's REST /wp/v2/media endpoint requires
 * the bytes in the POST body - the bot has to download the file itself, not
 * just pass a link along.
 */
export async function downloadFileuploaderBuffer(url) {
  const direct = fileuploaderDirect(url);
  const res = await fetch(direct);
  if (!res.ok) {
    throw new Error(`Fileuploader zwrócił ${res.status} dla ${direct}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

/**
 * Lists the files inside a /share/{hash} folder link. Returns only entries
 * with type "file" (skips any nested subfolders - !lp doesn't recurse).
 */
export async function listShareFolderFiles(shareUrl) {
  const parsed = parseFileuploaderLink(shareUrl);
  if (parsed.type !== "share") {
    throw new Error(`Nie jest to link do folderu fileuploadera (share): ${shareUrl}`);
  }
  const res = await fetch(`${parsed.base}/api/share/${parsed.hash}/files`);
  if (!res.ok) {
    throw new Error(`Fileuploader zwrócił ${res.status} przy listowaniu folderu ${shareUrl}`);
  }
  const items = await res.json();
  return items
    .filter((item) => item.type === "file")
    .map((item) => ({ name: item.name, path: item.path, size: item.size }));
}

/**
 * Downloads one named file from inside a /share/{hash} folder - the
 * "download?path=" endpoint reverse-engineered alongside listShareFolderFiles.
 */
export async function downloadShareFolderFile(shareUrl, path) {
  const parsed = parseFileuploaderLink(shareUrl);
  if (parsed.type !== "share") {
    throw new Error(`Nie jest to link do folderu fileuploadera (share): ${shareUrl}`);
  }
  const fileUrl = `${parsed.base}/api/share/${parsed.hash}/download?path=${encodeURIComponent(path)}`;
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Fileuploader zwrócił ${res.status} dla pliku "${path}" w folderze ${shareUrl}`);
  }
  const rawContentType = res.headers.get("content-type") || "application/octet-stream";
  // Confirmed by testing against a real folder: this endpoint always serves
  // "application/octet-stream" regardless of the actual file - the header is
  // useless here. Fall back to guessing from the filename extension instead,
  // since mediaMatcher.js's vision-format check depends on an accurate type.
  const contentType =
    rawContentType === "application/octet-stream" ? mimeTypeFromFilename(path) || rawContentType : rawContentType;
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

/**
 * Parses the `materialy:` inline argument (or its interactive-prompt
 * equivalent) into labeled ("slot: link", the preferred/recommended path -
 * zero guessing needed later) and unlabeled entries (plain links, routed to
 * mediaMatcher.js for Claude-vision slot matching, or - if it's a single
 * /share/ folder link - to the folder-scanning path in lp.js instead).
 * Items are split on newlines or commas, same free-form style as other
 * multi-line parseInlineArgs fields in skrypt.js.
 */
export function parseMaterialyInput(raw) {
  const items = (raw || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const labeled = [];
  const unlabeled = [];
  for (const item of items) {
    const match = item.match(/^([a-z0-9_-]+)\s*:\s*(https?:\/\/\S+)$/i);
    if (match) labeled.push({ slot: match[1].toLowerCase(), url: match[2] });
    else unlabeled.push(item);
  }
  return { labeled, unlabeled };
}
