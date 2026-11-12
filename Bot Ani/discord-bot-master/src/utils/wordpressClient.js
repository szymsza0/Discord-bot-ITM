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
export async function wpFetch(path, { method = "GET", headers = {}, body } = {}) {
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
 * Creates a new WP page. Domyślnie OPUBLIKOWANA (decyzja Szymona 12.11.2026:
 * LP z !lp i od Hermesa idą od razu na żywo, z noindex - patrz lpNewBuild.js
 * createLpPage, która dokłada noindex i znacznik narzędzia). `link` to adres
 * publiczny (permalink), `editLink` - edycja w wp-admin.
 */
export async function wpCreatePage({ title, content, status = "publish", slug, meta }) {
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
}, 1);
// LP z narzedzia ITM (znacznik itm-lp w _kad_post_classname): noindex, nofollow w <head> i poza mapa strony.
add_filter('wp_robots', function ($robots) {
  if (is_singular('page') && strpos((string) get_post_meta(get_queried_object_id(), '_kad_post_classname', true), 'itm-lp') !== false) {
    $robots['noindex'] = true;
    $robots['nofollow'] = true;
  }
  return $robots;
});
add_filter('wp_sitemaps_posts_query_args', function ($args, $post_type) {
  if ($post_type === 'page') {
    $args['meta_query'] = array(
      'relation' => 'OR',
      array('key' => '_kad_post_classname', 'compare' => 'NOT EXISTS'),
      array('key' => '_kad_post_classname', 'value' => 'itm-lp', 'compare' => 'NOT LIKE'),
    );
  }
  return $args;
}, 10, 2);`;

// Ten sam kod do recznego wklejenia (np. WPCode -> PHP Snippet, Run Everywhere),
// gdy na stronie nie ma wtyczki Code Snippets z REST API.
export const META_DESCRIPTION_SNIPPET_PHP = META_SNIPPET_CODE;

let metaSnippetEnsured = false;

/** Czy klucz META_DESCRIPTION_KEY jest juz zarejestrowany w REST stron (schemat OPTIONS /wp/v2/pages). */
export async function isMetaDescriptionRegistered() {
  const schema = await wpFetch("/wp/v2/pages", { method: "OPTIONS" });
  return Boolean(schema?.schema?.properties?.meta?.properties?.[META_DESCRIPTION_KEY]);
}

/**
 * Upewnia sie (raz na proces), ze klucz meta description jest zarejestrowany.
 * Jesli rejestruje go juz jakis fragment (Code Snippets albo wklejony recznie
 * w WPCode), nic nie robi - drugi fragment dublowalby <meta> w <head>.
 * Inaczej zaklada fragment przez REST Code Snippets. Musi pojsc PRZED
 * wpCreatePage - inaczej REST odrzuci meta.
 * Blad nie jest krytyczny: strona powstaje, tylko bez opisu.
 */
export async function ensureMetaDescriptionSnippet() {
  if (metaSnippetEnsured) return;
  if (await isMetaDescriptionRegistered()) {
    metaSnippetEnsured = true;
    return;
  }
  const routes = (await wpFetch("/").catch(() => null))?.namespaces || [];
  if (!routes.includes("code-snippets/v1")) {
    throw new Error(
      `klucz ${META_DESCRIPTION_KEY} nie jest zarejestrowany, a na stronie nie ma wtyczki Code Snippets (REST code-snippets/v1). ` +
        "Fragment PHP trzeba raz wkleić ręcznie w WPCode (kod: lp.sh fragment-seo --php)."
    );
  }
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

/* ==========================================================================
 *  Contact Form 7 - REST contact-form-7/v1 (konto aplikacji = administrator).
 *  Zapis (POST /contact-forms, POST /contact-forms/<id>) dziala TYLKO z
 *  `context: "save"`: bez niego CF7 robi suchy przebieg (200 z podgladem,
 *  nic nie zapisuje - stad wczesniejsze "API CF7 nie dziala"). Odczyt po ID
 *  posta (np. 2381); w shortcodzie idzie hash (np. 5618006) z listy formularzy.
 *  Usuwania (DELETE) nie robimy: CF7 kasuje formularz od razu, bez kosza.
 * ========================================================================== */

/** Wszystkie formularze: [{ id, hash, slug, title, locale }]. */
export async function cf7ListForms() {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const partia = await wpFetch(`/contact-form-7/v1/contact-forms?per_page=100&offset=${offset}`);
    if (!Array.isArray(partia) || !partia.length) break;
    all.push(...partia);
    if (partia.length < 100) break;
  }
  return all;
}

/** Formularz po ID posta: { id, slug, title, locale, properties: { form:{content}, mail, mail_2, messages, additional_settings:{content} } }. */
export async function cf7GetForm(id) {
  return wpFetch(`/contact-form-7/v1/contact-forms/${id}`);
}

/**
 * Tworzy (bez id) albo aktualizuje (z id) formularz CF7. data: { title, locale, form (tekst zakladki
 * Formularz), mail {recipient, sender, subject, body, additional_headers, attachments, use_html,
 * exclude_blank}, mail_2 {... , active}, messages {mail_sent_ok, ...}, additional_settings (tekst) }.
 * Pola pominiete zostaja bez zmian (przy tworzeniu: domyslne z szablonu CF7).
 */
export async function cf7SaveForm(data, id = null) {
  const body = { ...data, context: "save" };
  if (!body.locale && !id) body.locale = "pl_PL";
  const saved = await wpFetch(id ? `/contact-form-7/v1/contact-forms/${id}` : "/contact-form-7/v1/contact-forms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!saved?.id || saved.id < 1) throw new Error("CF7 nie zapisał formularza (brak id w odpowiedzi).");
  return saved;
}

/**
 * Shortcode formularza (hash z listy, jak w wp-admin). Tytuł bez [ ] i cudzysłowów: „]” w tytule
 * („[KB] Autorska terapia”) kończy shortcode i CF7 pokazuje „Błąd: Brak formularza kontaktowego”.
 */
export function cf7Shortcode(f) {
  const tytul = String(f.title || "").replace(/["\[\]]/g, "").replace(/\s+/g, " ").trim();
  return `[contact-form-7 id="${f.hash || f.id}" title="${tytul}"]`;
}
