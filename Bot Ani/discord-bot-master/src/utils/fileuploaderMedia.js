import fetch from "node-fetch";

/**
 * Converts an itm.fileuploader.pl share/view link into the direct file URL.
 * Port of fileuploader_direct() from meta_creator.py (Meta ad creation
 * script) - same source, same hash format, just JS instead of Python since
 * !LP needs to fetch bytes with node-fetch instead of handing Meta a URL.
 */
export function fileuploaderDirect(url) {
  const trimmed = (url || "").trim();
  const match = trimmed.match(/\/(?:view|share)\/([a-f0-9]{40,})/);
  if (!match) return trimmed; // already a direct URL or unknown format
  const base = trimmed.match(/^https?:\/\/[^/]+/)[0];
  return `${base}/api/view/${match[1]}/file`;
}

/**
 * Downloads the raw bytes of a fileuploader link. Unlike the Meta Graph API
 * (which accepts a URL and fetches the image itself), WP's REST
 * /wp/v2/media endpoint requires the bytes in the POST body - the bot has to
 * download the file itself, not just pass a link along.
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
 * Parses the `materialy:` inline argument (or its interactive-prompt
 * equivalent) into labeled ("slot: link", the preferred/recommended path -
 * zero guessing needed later) and unlabeled entries (plain links, routed to
 * mediaMatcher.js for Claude-vision slot matching). Items are split on
 * newlines or commas, same free-form style as other multi-line
 * parseInlineArgs fields in skrypt.js.
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
