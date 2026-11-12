import { readFile } from "node:fs/promises";
import path from "node:path";
import { WP_BASE_URL } from "../config.js";
import { getLPTemplate } from "./lpTemplate.js";
import { fetchDocPlainText } from "./googleDocs.js";
import { ASSUMPTION_MARKER } from "./lpGenerator.js";
import { generateNewLpCopy, NewLPGenerationError } from "./lpNewGenerator.js";
import { getNewLpTemplate, renderNewTemplate, mapNewCopyToTemplate, wrapWpHtmlBlock } from "./lpNewTemplate.js";
import { downloadFileuploaderBuffer, parseFileuploaderLink, fileuploaderDirect } from "./fileuploaderMedia.js";
import { wpFetch, wpUploadMedia, wpCreatePage, ensureMetaDescriptionSnippet, META_DESCRIPTION_KEY } from "./wordpressClient.js";
import { optimizeToWebp, extForMime } from "./imageOptimize.js";
import { generatePalette } from "./lpPalette.js";

/**
 * Rdzeń przepływu „nowy szablon” (lp-new-v1) komendy !lp, bez Discorda:
 * brief -> copy (Claude) -> paleta -> media do WP -> strona OPUBLIKOWANA z noindex (createLpPage).
 * Używa go src/commands/lp.js; CLI Hermesa (src/cli/hermes-lp.js) bierze stąd obsługę mediów i SEO.
 * Arkusz Baza LP i webhook zostają po stronie wywołującego.
 */

/** Błąd etapu, który przerywa budowę LP; .message to gotowy tekst dla człowieka. */
export class LpBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "LpBuildError";
  }
}

export function localSlug(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Zdejmuje prefiks "⚠️ ZAŁOŻENIE: " z KAŻDEGO stringa w obiekcie copy (strona
// ma wyglądać czysto), a ścieżki takich pól dopisuje do `out` -> raport.
export function stripAssumptionMarkers(node, out, path = "") {
  if (typeof node === "string") {
    if (node.startsWith(ASSUMPTION_MARKER)) {
      out.push(path || "(pole)");
      return node.slice(ASSUMPTION_MARKER.length).trim();
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((v, i) => stripAssumptionMarkers(v, out, `${path}[${i + 1}]`));
  if (node && typeof node === "object") {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = stripAssumptionMarkers(v, out, path ? `${path}.${k}` : k);
    return o;
  }
  return node;
}

// Meta description strony. Klucz rejestruje fragment z ensureMetaDescriptionSnippet()
// - bez niego WP po cichu odrzuca nieznane meta.
export function seoMeta(copy) {
  const d = copy?.seo?.metaDescription;
  return d ? { [META_DESCRIPTION_KEY]: d } : undefined;
}

// Fragment od meta description - przed wpCreatePage; blad nie blokuje strony.
export async function ensureSeoSnippet() {
  try {
    await ensureMetaDescriptionSnippet();
  } catch (err) {
    console.warn("[lp] nie udalo sie zapewnic fragmentu meta description:", err.message);
  }
}

/* ==========================================================================
 *  Publikacja LP (decyzja Szymona 12.11.2026): strona z !lp i od Hermesa idzie
 *  od razu jako OPUBLIKOWANA - klientka akceptuje ją z publicznego linku (nie ma
 *  dostępu do wp-admin), a w reklamach Meta podpinamy ją dopiero po akceptacji.
 *  Każda LP ma noindex, nofollow: nie zbiera ruchu organicznego.
 *
 *  noindex: zapisy-beauty.pl nie ma wtyczki SEO (Yoast / Rank Math) ani Code
 *  Snippets z REST, więc meta robots siedzi w treści strony: osobny blok wp:html
 *  na początku (<meta name="robots"> + skrypt, który dokłada ten sam tag do
 *  <head>; Google czyta też tagi dodane skryptem). Fragment PHP z
 *  `lp.sh fragment-seo --php` (wklejony raz w WPCode) dodaje noindex w <head>
 *  i wyłącza LP z wp-sitemap.xml - wtedy po stronie serwera.
 *
 *  Znacznik „strona z narzędzia LP”: meta Kadence `_kad_post_classname` (jedyne
 *  meta stron zarejestrowane w REST na tym WP) = "itm-lp itm-lp-<id>". Klasa z
 *  własnym id: kopia strony zrobiona w wp-admin (duplikator kopiuje meta) ma
 *  inne id, więc znacznika nie przejmuje. Tylko strony ze znacznikiem CLI
 *  nadpisuje, gdy są opublikowane. Skutek uboczny: klasy CSS na <body>.
 * ========================================================================== */

export const LP_MARKER = "itm-lp";
const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]*noindex/i;
const NOINDEX_BLOCK =
  "<!-- wp:html -->\n" +
  '<meta name="robots" content="noindex, nofollow">\n' +
  '<script>(function(){var m=document.createElement("meta");m.name="robots";m.content="noindex, nofollow";document.head.appendChild(m);})();</script>\n' +
  "<!-- /wp:html -->\n\n";

/* Poprawki CSS dla każdej LP (Szymon 12.11.2026): szablon (zl-) zeruje marginesy nagłówków sekcji
 * (`.zl-page h2{margin:0 !important}`), więc nagłówek dotykał treści sekcji albo na nią nachodził.
 * Selektor ma wyższą specyficzność niż reguła szablonu, więc wygrywa mimo jej !important. */
const POPRAWKI_ID = "itm-lp-poprawki";
const POPRAWKI_BLOCK =
  "<!-- wp:html -->\n" +
  `<style id="${POPRAWKI_ID}">` +
  ".zl-page section h2,.zl-page section .zl-h2{margin:0 0 clamp(20px,2.6vw,36px) !important}" +
  ".zl-page section h3{margin:0 0 clamp(10px,1.4vw,16px) !important}" +
  ".zl-page section .zl-divider + h2{margin-top:8px !important}" +
  // Telefon (Szymon 12.11.2026, SFLJ): „5,0” i gwiazdki łamały się w podsumowaniu opinii, przycisk w menu
  // zajmował dwie linie, a strzałka w przycisku spadała do nowej linii.
  ".zl-reviews__sum .big,.zl-reviews__sum .stars,.zl-rating .stars,.zl-review__stars{white-space:nowrap}" +
  ".zl-page .zl-btn{text-wrap:balance}" +
  "@media(max-width:560px){" +
  ".zl-reviews__sum{flex-wrap:wrap;justify-content:center;row-gap:4px;border-radius:22px !important;padding:12px 20px !important;text-align:center}" +
  ".zl-reviews__sum .cap{flex-basis:100%}" +
  ".zl-nav__in{gap:10px}" +
  ".zl-nav .zl-btn{white-space:nowrap;padding:9px 12px !important;font-size:12.5px !important;line-height:1.2 !important}" +
  "}" +
  "</style>\n" +
  "<!-- /wp:html -->\n\n";

/** Treść z poprawkami CSS (bez dubla). */
const POPRAWKI_RE = new RegExp(`<style id="${POPRAWKI_ID}">[\\s\\S]*?</style>`);
/** Treść z aktualnymi poprawkami CSS: dokłada blok albo podmienia starszą wersję (bez dubla). */
export const withPoprawki = (content) => {
  const c = content || "";
  const styl = POPRAWKI_BLOCK.match(POPRAWKI_RE)[0];
  return POPRAWKI_RE.test(c) ? c.replace(POPRAWKI_RE, styl) : POPRAWKI_BLOCK + c;
};

/* Blok webhooka leadów (make.sh przeplyw --typ lp, ~/itm-os/agent/make/wp.py): skrypt w treści LP, który po wysłaniu
 * formularza CF7 przekazuje lead do Make. Poprawka strony nie może go zgubić, więc zapis treści bez niego dokleja go z
 * poprzedniej wersji (usunąć go można tylko świadomie, w wp-admin). */
const WEBHOOK_LEADOW_RE = /(?:<!-- wp:html -->\s*)?<!-- itm-webhook-cf7 [\s\S]*?<!-- \/itm-webhook-cf7 -->(?:\s*<!-- \/wp:html -->)?/;

/** Nowa treść z blokiem webhooka leadów ze starej, gdy nowa go nie ma. Zwraca { content, doklejony }. */
export function zachowajWebhookLeadow(stara, nowa) {
  const m = (stara || "").match(WEBHOOK_LEADOW_RE);
  if (!m || typeof nowa !== "string" || WEBHOOK_LEADOW_RE.test(nowa)) return { content: nowa, doklejony: false };
  return { content: `${nowa.replace(/\s+$/, "")}\n\n${m[0]}\n`, doklejony: true };
}

/** Czy treść strony ma meta robots z noindex. */
export const hasNoindex = (raw) => NOINDEX_RE.test(raw || "");

/** Treść z blokiem noindex na początku (bez dubla, gdy już jest, np. w kopii innego LP). */
export const withNoindex = (content) =>
  withPoprawki(hasNoindex(content) ? content : NOINDEX_BLOCK + content);

/** Strona ma znacznik narzędzia LP z WŁASNYM id (p: odpowiedź REST z meta). */
export function isLpToolPage(p) {
  return String(p?.meta?._kad_post_classname || "").split(/\s+/).includes(`${LP_MARKER}-${p?.id}`);
}

/** Dopisuje znacznik narzędzia LP (zachowuje inne klasy Kadence). */
export async function markLpPage(id, prevClass = "") {
  const klasy = String(prevClass || "").split(/\s+/).filter((c) => c && c !== LP_MARKER && !c.startsWith(`${LP_MARKER}-`));
  await wpFetch(`/wp/v2/pages/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: { _kad_post_classname: [...klasy, LP_MARKER, `${LP_MARKER}-${id}`].join(" ") } }),
  });
}

/** Shortcode'y CF7 z zaślepką zamiast id formularza (id="XXXXXXX", „DO PODPIĘCIA”). */
export const formPlaceholders = (html) =>
  [...new Set((html || "").match(/\[contact-form-7[^\]]*\]/g) || [])].filter((f) => /X{3,}|DO PODPI/i.test(f));

/**
 * Tworzy LP: OPUBLIKOWANA, z noindex i znacznikiem narzędzia. Zwraca { id, link (publiczny), editLink, oznaczona }.
 * Brak znacznika (oznaczona: false) nie blokuje strony - tylko późniejszej poprawki CLI przez --strona.
 */
export async function createLpPage({ title, content, slug, meta }) {
  const page = await wpCreatePage({
    title,
    content: withNoindex(content),
    status: "publish",
    slug,
    meta: { ...(meta || {}), _kad_post_classname: LP_MARKER },
  });
  try {
    await markLpPage(page.id);
    page.oznaczona = true;
  } catch (err) {
    console.warn(`[lp] strona ${page.id}: nie udało się zapisać znacznika narzędzia LP:`, err.message);
    page.oznaczona = false;
  }
  return page;
}

export function splitLinks(raw) {
  if (!raw || /^\s*brak\s*$/i.test(raw)) return [];
  // wyciagnij URL-e z DOWOLNEGO miejsca w linii (Discord potrafi opakowac w <>,
  // dokleic tekst, itd.) - wczesniejszy /^https/ gubil takie linki cicho
  const urls = String(raw).match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
  return urls.map((u) => u.replace(/[.,;]+$/, ""));
}

// Operator może wkleić cały shortcode CF7 (zalecane) albo samą nazwę formularza.
export function normalizeFormShortcode(raw) {
  const t = (raw || "").trim();
  if (t.startsWith("[")) {
    const titleMatch = t.match(/title=["']([^"']+)["']/i);
    return { shortcode: t, name: titleMatch ? titleMatch[1] : "formularz CF7" };
  }
  return { shortcode: `[contact-form-7 title="${t}"]`, name: t };
}

const LOCAL_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
// Wideo (np. film w hero) idzie do WP bez konwersji i bez zmiany rozmiaru.
const VIDEO_MIME = { mp4: "video/mp4", webm: "video/webm" };

// Pobiera medium (fileuploader /view/, dowolny http[s] albo plik lokalny - CLI), konwertuje do
// WebP + ogranicza szerokosc (strona ma byc szybka) i wgrywa do WP Media
// Library. Wyjatek: obrazek juz zhostowany na naszym WP i juz w .webp -
// uzywamy go wprost, bez duplikatu.
// imageDims (opcjonalnie): obiekt, do ktorego trafia URL -> {width,height}
// wgranego pliku - renderer dopisuje z tego width/height do <img>.
export async function resolveMediaUrl(url, seoBase, imageDims = null) {
  const base = (WP_BASE_URL || "").replace(/\/$/, "");
  if (base && url.startsWith(base) && /\.(webp|mp4|webm)(\?|#|$)/i.test(url)) return url;

  const isLocal = !/^https?:\/\//i.test(url);
  const parsed = isLocal ? { type: "local" } : parseFileuploaderLink(url);
  const alt = seoBase.replace(/-/g, " ");
  try {
    let buffer, contentType;
    if (isLocal) {
      const ext = path.extname(url).slice(1).toLowerCase();
      contentType = LOCAL_MIME[ext] || VIDEO_MIME[ext];
      if (!contentType) throw new Error(`nieobsługiwany typ pliku: ${path.basename(url)}`);
      buffer = await readFile(url);
    } else if (parsed.type === "view") {
      ({ buffer, contentType } = await downloadFileuploaderBuffer(url));
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      contentType = res.headers.get("content-type") || "";
      if (!/^(image|video)\//i.test(contentType)) throw new Error(`odpowiedź to nie obraz ani wideo (${contentType || "brak content-type"})`);
      buffer = Buffer.from(await res.arrayBuffer());
    }

    if (/^video\//i.test(contentType)) {
      const mime = contentType.split(";")[0].trim().toLowerCase();
      const ext = Object.keys(VIDEO_MIME).find((k) => VIDEO_MIME[k] === mime) || "mp4";
      const up = await wpUploadMedia(buffer, `${seoBase}.${ext}`, mime, { altText: alt, title: alt });
      if (imageDims && up.width && up.height) imageDims[up.sourceUrl] = { width: up.width, height: up.height };
      return up.sourceUrl;
    }

    // 1200px: najszersze zdjecie na LP (hero) ma ~430px CSS, wiec 2x gestosc
    // i tak sie miesci; 1800px PageSpeed zglaszal jako "larger than it needs to be".
    const opt = await optimizeToWebp(buffer, contentType, { maxWidth: 1200 });
    const remember = (up) => {
      if (imageDims && up.width && up.height) imageDims[up.sourceUrl] = { width: up.width, height: up.height };
      return up.sourceUrl;
    };
    try {
      return remember(await wpUploadMedia(opt.buffer, `${seoBase}.${opt.ext}`, opt.contentType, { altText: alt, title: alt }));
    } catch (err) {
      if (!opt.converted) throw err; // np. WP w ogole nie przyjmuje uploadu
      return remember(await wpUploadMedia(buffer, `${seoBase}.${extForMime(contentType)}`, contentType, { altText: alt, title: alt }));
    }
  } catch (err) {
    // Ostatnia deska ratunku: jeśli nie udało się pobrać/wgrać pliku do WP
    // (limit uprawnień, format, timeout...), nie zostawiaj pustego <img src> -
    // dla fileuploadera /view/ jest bezposredni URL pliku (/api/view/{hash}/file,
    // patrz fileuploaderDirect) ktory dziala jako <img src> mimo ze sam upload
    // do WP sie nie udal; dla zwyklego http(s) URL-a uzyj go wprost.
    if (parsed.type === "view") {
      console.warn(`resolveMediaUrl: nie wgrano ${url} (${err.message}), używam bezpośredniego URL fileuploadera`);
      return fileuploaderDirect(url);
    }
    if (/^https?:\/\//i.test(url)) {
      console.warn(`resolveMediaUrl: nie wgrano ${url} (${err.message}), używam URL wprost`);
      return url;
    }
    throw err;
  }
}

/**
 * Buduje LP w nowym szablonie i publikuje ją w WP (noindex, znacznik narzędzia - createLpPage).
 *
 * @param {object} a
 * @param {string} a.zabieg
 * @param {string} a.briefDocId        Google Doc z briefem
 * @param {string} a.formRaw           shortcode CF7 albo nazwa formularza
 * @param {string[]} a.heroUrls        0-1 linków / ścieżek
 * @param {string[]} a.baUrls          przed/po
 * @param {string[]} a.opUrls          screeny opinii
 * @param {string|null} a.themeText    motyw kolorystyczny (null = domyślna paleta)
 * @param {string|null} a.dodatkoweUwagi
 * @param {string|null} a.pakietyInfo
 * @param {string|null} a.ratingInfo
 * @param {(text:string)=>Promise<any>|any} [a.onProgress]
 */
export async function buildNewLp({
  zabieg,
  briefDocId,
  formRaw,
  heroUrls = [],
  baUrls = [],
  opUrls = [],
  themeText = null,
  dodatkoweUwagi = null,
  pakietyInfo = null,
  ratingInfo = null,
  onProgress = () => {},
}) {
  const { shortcode: formShortcode, name: formName } = normalizeFormShortcode(formRaw);

  let briefText, template;
  try {
    [briefText, template] = await Promise.all([fetchDocPlainText(briefDocId), getLPTemplate()]);
  } catch (err) {
    console.error("Error fetching new-LP starting data:", err);
    throw new LpBuildError(`Nie udało się pobrać danych startowych: ${err.message}`);
  }

  await onProgress("⏳ Generuję copy LP (nowy szablon)...");
  let rawCopy;
  try {
    rawCopy = await generateNewLpCopy({
      templateRulesText: template.rulesText,
      briefText,
      formName,
      beforeAfterCount: baUrls.length,
      opinieCount: opUrls.length,
      additionalNotes: dodatkoweUwagi,
      packagesInfo: pakietyInfo,
      ratingInfo,
    });
  } catch (err) {
    if (err instanceof NewLPGenerationError) throw new LpBuildError(`${err.message}\n\nSzczegóły: ${err.details}`);
    throw err;
  }

  // "⚠️ ZAŁOŻENIE: " nie ma trafiać na stronę - zdejmujemy prefiks, a listę
  // założonych pól pokazujemy w raporcie.
  const assumptions = [];
  const copy = stripAssumptionMarkers(rawCopy, assumptions);

  let palette = null;
  if (themeText) {
    await onProgress("⏳ Dobieram paletę kolorów...");
    palette = await generatePalette(themeText);
  }

  await onProgress("⏳ Przetwarzam multimedia...");
  const businessSlug = localSlug(copy.business?.name || zabieg || "itm") || "itm";
  const mediaFailures = [];

  // Brak dedykowanego HERO nie powinien dawać pustego <img src> na stronie -
  // jeśli operator podał chociaż zdjęcia przed/po, pierwsze z nich jest dużo
  // lepszym hero niż nic (sekcja i tak trafia na czoło strony).
  let heroImageUrl = "";
  const imageDims = {};
  const heroSourceUrl = heroUrls[0] || baUrls[0] || null;
  if (!heroSourceUrl) {
    mediaFailures.push("HERO: nie podano prawidłowego linku (ani HERO, ani żadnego zdjęcia przed/po do zastępczego użycia)");
  } else {
    try {
      heroImageUrl = await resolveMediaUrl(heroSourceUrl, `${businessSlug}-hero`, imageDims);
      if (!heroUrls[0]) {
        mediaFailures.push("HERO: nie podano dedykowanego zdjęcia - użyto pierwszego zdjęcia przed/po jako zastępczego, sprawdź czy pasuje");
      }
    } catch (err) {
      console.error("new-LP hero media:", err);
      mediaFailures.push(`HERO: ${err.message}`);
    }
  }

  const resolveMany = async (urls, prefix) => {
    const out = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        out.push(await resolveMediaUrl(urls[i], `${businessSlug}-${prefix}-${i + 1}`, imageDims));
      } catch (err) {
        console.error(`new-LP ${prefix} #${i + 1} media:`, err);
        mediaFailures.push(`${prefix} #${i + 1}`);
      }
    }
    return out;
  };
  const baResolved = await resolveMany(baUrls, "przed-po");
  const opResolved = await resolveMany(opUrls, "opinia");

  await onProgress("⏳ Składam stronę...");
  const templateHtml = await getNewLpTemplate();
  const { tokens, repeats } = mapNewCopyToTemplate(copy, opResolved);
  repeats.beforeAfter = baResolved.map((u) => ({ BA_URL: u }));
  const { content: pageBody, remainingTokens, emptyRegions, paletteFixes } = renderNewTemplate(templateHtml, {
    tokens,
    repeats,
    heroImageUrl,
    formShortcode,
    palette,
    imageDims,
  });
  if (paletteFixes.length) console.log("[lp-new] paleta przyciemniona pod kontrast WCAG:", paletteFixes.join(", "));
  const pageContent = wrapWpHtmlBlock(pageBody);

  await onProgress("⏳ Publikuję stronę w WordPress (noindex)...");
  await ensureSeoSnippet();
  let page;
  try {
    page = await createLpPage({
      title: copy.seo?.title || `${zabieg} - ${copy.business?.name || ""}`.trim(),
      content: pageContent,
      meta: seoMeta(copy),
    });
  } catch (err) {
    console.error("Error creating new-LP WP page:", err);
    throw new LpBuildError(`Copy i media gotowe, ale nie udało się utworzyć strony WP: ${err.message}`);
  }

  return {
    page,
    copy,
    palette,
    heroImageUrl,
    baResolved,
    opResolved,
    mediaFailures,
    remainingTokens,
    emptyRegions,
    assumptions,
    formShortcode,
    formName,
  };
}

/** Listy do raportu końcowego: co zrobione i co wymaga człowieka (te same teksty co w Discordzie). */
export function summarizeNewLp(result, { themeText = null, webhookLine = null } = {}) {
  const { page, copy, palette, heroImageUrl, baResolved, opResolved, mediaFailures, remainingTokens, emptyRegions, assumptions, formShortcode } =
    result;
  const needs = [
    ...formPlaceholders(formShortcode).map((f) => `Formularz do podpięcia przed reklamą w Meta: ${f} (leady z tej LP nie przyjdą)`),
    ...remainingTokens.map((t) => `Pole bez danych: ${t}`),
    ...emptyRegions.map((r) => `Pusta sekcja (0 elementów): ${r}`),
    ...mediaFailures.map((m) => `Media - ${m}`),
  ];
  if (webhookLine && webhookLine.startsWith("Webhook: NIE")) needs.push(webhookLine);
  if (page && page.oznaczona === false) needs.push("Brak znacznika narzędzia LP (meta strony): poprawki tej strony tylko ręcznie w wp-admin");
  if (themeText && !palette) needs.push("Motyw: nie udało się wygenerować palety, została domyślna");
  if (assumptions.length) {
    needs.push(
      `Założenia AI do sprawdzenia (${assumptions.length}): ${assumptions.slice(0, 15).join(", ")}${
        assumptions.length > 15 ? " ..." : ""
      }`
    );
  }

  const done = [];
  if (copy.business?.name) done.push(`Firma: ${copy.business.name}`);
  done.push("Szablon: nowy (lp-new-v1), 1 blok wp:html");
  if (palette) done.push(`Motyw: paleta z „${themeText.length > 50 ? `${themeText.slice(0, 47)}...` : themeText}"`);
  done.push(`Formularz: ${formShortcode}`);
  done.push(`Media: HERO ${heroImageUrl ? "1" : "0"}, przed/po ${baResolved.length}, opinie ${opResolved.length}`);
  if (copy.packages?.items?.length) done.push(`Pakiety: ${copy.packages.items.length} kart(y)`);
  if (webhookLine && !webhookLine.startsWith("Webhook: NIE")) done.push(webhookLine);

  return { needs, done };
}
