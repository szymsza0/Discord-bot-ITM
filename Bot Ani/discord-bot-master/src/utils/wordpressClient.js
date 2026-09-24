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

  const md = created.media_details || {};
  return { id: created.id, sourceUrl: created.source_url, width: md.width || null, height: md.height || null };
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

/* ==========================================================================
 *  Meta description bez wtyczki SEO. Strona nie ma Yoasta / Rank Matha, wiec
 *  WP po cichu odrzucal `meta.description` wysylane przy tworzeniu strony
 *  (niezarejestrowany klucz) i w <head> nie bylo opisu (PageSpeed SEO:
 *  "Document does not have a meta description"). Globalny fragment PHP
 *  rejestruje klucz META_DESCRIPTION_KEY w REST i wypisuje go w wp_head.
 * ========================================================================== */

export const META_DESCRIPTION_KEY = "itm_meta_description";
const META_SNIPPET_NAME = "ITM :: meta description (LP)";
const META_SNIPPET_CODE = `add_action('init', function () {
  foreach (array('page', 'post') as $type) {
    register_post_meta($type, '${META_DESCRIPTION_KEY}', array(
      'type' => 'string',
      'single' => true,
      'show_in_rest' => true,
      'sanitize_callback' => 'sanitize_text_field',
      'auth_callback' => function () { return current_user_can('edit_posts'); },
    ));
  }
});
add_action('wp_head', function () {
  if (!is_singular()) return;
  // wtyczka SEO (jesli kiedys dojdzie) wypisuje opis sama - nie dubluj
  if (defined('WPSEO_VERSION') || defined('RANK_MATH_VERSION') || defined('AIOSEO_VERSION') || defined('SEOPRESS_VERSION')) return;
  $d = get_post_meta(get_queried_object_id(), '${META_DESCRIPTION_KEY}', true);
  if ($d) echo '<meta name="description" content="' . esc_attr($d) . '">' . "\\n";
}, 1);`;

let metaSnippetEnsured = false;

/**
 * Upewnia sie (raz na proces), ze fragment od meta description istnieje i jest
 * aktywny. Musi pojsc PRZED wpCreatePage - inaczej REST odrzuci meta.
 * Blad nie jest krytyczny: strona powstaje, tylko bez opisu.
 */
export async function ensureMetaDescriptionSnippet() {
  if (metaSnippetEnsured) return;
  await wpUpsertSnippet({
    name: META_SNIPPET_NAME,
    code: META_SNIPPET_CODE,
    scope: "global",
    description: `Rejestruje ${META_DESCRIPTION_KEY} (REST) i wypisuje <meta name="description"> - zarzadzane przez bota ITM (!lp).`,
    tags: ["itm", "seo"],
    active: true,
  });
  metaSnippetEnsured = true;
}

/* ==========================================================================
 *  Wtyczka "Code Snippets" (pl: "Fragmenty kodu") - REST API code-snippets/v1
 *  Uzywane przez komende !webhook do wstawiania skryptu webhooka jako
 *  fragmentu HTML w stopce (scope: site-footer). Wymaga konta WP z
 *  uprawnieniem manage_options (Application Password administratora).
 * ========================================================================== */

function snippetEditLink(id) {
  return `${WP_BASE_URL.replace(/\/$/, "")}/wp-admin/admin.php?page=edit-snippet&id=${id}`;
}

/** Lista fragmentow (opcjonalnie filtr po tagu). */
export async function wpListSnippets({ tag } = {}) {
  const qs = tag ? `?tags=${encodeURIComponent(tag)}` : "";
  const data = await wpFetch(`/code-snippets/v1/snippets${qs}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Tworzy lub aktualizuje fragment Code Snippets identyfikowany po dokladnej
 * nazwie (marker). Zwraca { id, created, editLink }.
 *
 * scope domyslnie "site-footer" = fragment HTML wstrzykiwany przez wp_footer
 * na calej stronie (kod HTML w Code Snippets nie przechodzi przez KSES, wiec
 * <script> przezywa). Dla fragmentu wpietego tylko na wybranych stronach
 * uzyj wlasnego guardu w samym kodzie (np. sprawdzenie window.location).
 */
export async function wpUpsertSnippet({
  name,
  code,
  scope = "site-footer",
  description = "",
  tags = [],
  priority = 10,
  active = true,
}) {
  if (!name || !code) throw new Error("wpUpsertSnippet: wymagane pola 'name' i 'code'.");

  const all = await wpListSnippets();
  const existing = all.find((s) => s.name === name);

  const payload = {
    name,
    code,
    desc: description,
    scope,
    tags,
    priority,
    active,
    network: false,
  };

  const saved = existing
    ? await wpFetch(`/code-snippets/v1/snippets/${existing.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    : await wpFetch("/code-snippets/v1/snippets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

  const id = saved?.id || existing?.id;

  // Niektore wersje wtyczki nie honoruja 'active' przy zapisie - dobij aktywacja.
  if (active && id && saved?.active === false) {
    await wpFetch(`/code-snippets/v1/snippets/${id}/activate`, { method: "POST" }).catch(() => {});
  }

  return { id, created: !existing, editLink: snippetEditLink(id) };
}
