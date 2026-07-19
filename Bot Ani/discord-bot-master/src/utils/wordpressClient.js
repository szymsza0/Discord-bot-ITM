import fetch from "node-fetch";
import { WP_BASE_URL, WP_APP_USER, WP_APP_PASSWORD } from "../config.js";

let cachedAuthHeader;

function authHeader() {
  if (cachedAuthHeader) return cachedAuthHeader;
  if (!WP_BASE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
    throw new Error(
      "Brak konfiguracji WordPress: ustaw WP_BASE_URL, WP_APP_USER, WP_APP_PASSWORD (Application Password, nie główne hasło)."
    );
  }
  cachedAuthHeader = `Basic ${Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
  return cachedAuthHeader;
}

function apiUrl(path) {
  return `${WP_BASE_URL.replace(/\/$/, "")}/wp-json${path}`;
}

/**
 * Shared fetch wrapper: adds Basic Auth, and - same problem/same fix as
 * sowaClient.js's SOWA API wrapper - detects when WP returns HTML instead of
 * JSON (maintenance mode, a security plugin blocking REST, a WAF challenge
 * page) so that failure shows up as a readable error instead of a confusing
 * "Unexpected token < in JSON" deep in JSON.parse.
 */
async function wpFetch(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { Authorization: authHeader(), ...headers },
    body,
  });

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json().catch(() => ({})) : null;

  if (!isJson) {
    throw new Error(
      `WordPress REST API zwróciło nie-JSON (content-type: ${contentType || "brak"}, status ${res.status}) dla ${path}. ` +
        `Sprawdź czy WP_BASE_URL jest poprawny i czy REST API nie jest blokowane (plugin bezpieczeństwa / maintenance mode).`
    );
  }

  if (!res.ok) {
    const message = payload?.message || `WordPress REST API zwróciło błąd HTTP ${res.status} dla ${path}.`;
    const error = new Error(message);
    error.status = res.status;
    error.code = payload?.code;
    throw error;
  }

  return payload;
}

/**
 * Fetches the raw (unrendered) block markup of a WP page - `context=edit`
 * requires auth but is what returns `content.raw`, the editable Kadence
 * block source (with `<!-- wp:kadence/... -->` comments and any `{{TOKEN}}`
 * placeholders authored into it), as opposed to `content.rendered` which is
 * already-compiled HTML and useless for token replacement.
 */
export async function wpGetPageRawContent(pageId) {
  const data = await wpFetch(`/wp/v2/pages/${pageId}?context=edit`);
  if (typeof data?.content?.raw !== "string") {
    throw new Error(`Strona-wzorzec WP #${pageId} nie zwróciła content.raw - sprawdź uprawnienia konta WP.`);
  }
  return data.content.raw;
}

/**
 * Uploads a file to the WP Media Library as raw bytes (Content-Disposition
 * header carries the filename - no multipart/FormData needed, WP's REST API
 * accepts a raw binary body this way), then a second call to set
 * alt_text/title/caption (the initial POST doesn't reliably apply these on
 * all WP/plugin configs). Returns the new attachment id + its public URL.
 */
export async function wpUploadMedia(buffer, filename, mimeType, { altText = "", title = "" } = {}) {
  const created = await wpFetch("/wp/v2/media", {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
    body: buffer,
  });

  if (altText || title) {
    await wpFetch(`/wp/v2/media/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: altText, title, caption: title }),
    });
  }

  return { id: created.id, sourceUrl: created.source_url };
}

/**
 * Creates a new WP page from the token-substituted content, always as a
 * draft (never auto-published - a human reviews it in wp-admin first). The
 * final Discord report builds its edit link from the returned id.
 */
export async function wpCreatePage({ title, content, status = "draft", slug, meta }) {
  const body = { title, content, status };
  if (slug) body.slug = slug;
  if (meta) body.meta = meta;

  const created = await wpFetch("/wp/v2/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    id: created.id,
    link: created.link,
    editLink: `${WP_BASE_URL.replace(/\/$/, "")}/wp-admin/post.php?post=${created.id}&action=edit`,
  };
}
