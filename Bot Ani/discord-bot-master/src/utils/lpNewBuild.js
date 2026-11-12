import { readFile } from "node:fs/promises";
import path from "node:path";
import { WP_BASE_URL } from "../config.js";
import { getLPTemplate } from "./lpTemplate.js";
import { fetchDocPlainText } from "./googleDocs.js";
import { ASSUMPTION_MARKER } from "./lpGenerator.js";
import { generateNewLpCopy, NewLPGenerationError } from "./lpNewGenerator.js";
import { getNewLpTemplate, renderNewTemplate, mapNewCopyToTemplate, wrapWpHtmlBlock } from "./lpNewTemplate.js";
import { downloadFileuploaderBuffer, parseFileuploaderLink, fileuploaderDirect } from "./fileuploaderMedia.js";
import { wpUploadMedia, wpCreatePage, ensureMetaDescriptionSnippet, META_DESCRIPTION_KEY } from "./wordpressClient.js";
import { optimizeToWebp, extForMime } from "./imageOptimize.js";
import { generatePalette } from "./lpPalette.js";

/**
 * Rdzeń przepływu „nowy szablon” (lp-new-v1) komendy !lp, bez Discorda:
 * brief -> copy (Claude) -> paleta -> media do WP -> szkic strony (zawsze draft).
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

// Pobiera medium (fileuploader /view/, dowolny http[s] albo plik lokalny - CLI), konwertuje do
// WebP + ogranicza szerokosc (strona ma byc szybka) i wgrywa do WP Media
// Library. Wyjatek: obrazek juz zhostowany na naszym WP i juz w .webp -
// uzywamy go wprost, bez duplikatu.
// imageDims (opcjonalnie): obiekt, do ktorego trafia URL -> {width,height}
// wgranego pliku - renderer dopisuje z tego width/height do <img>.
export async function resolveMediaUrl(url, seoBase, imageDims = null) {
  const base = (WP_BASE_URL || "").replace(/\/$/, "");
  if (base && url.startsWith(base) && /\.webp(\?|#|$)/i.test(url)) return url;

  const isLocal = !/^https?:\/\//i.test(url);
  const parsed = isLocal ? { type: "local" } : parseFileuploaderLink(url);
  const alt = seoBase.replace(/-/g, " ");
  try {
    let buffer, contentType;
    if (isLocal) {
      contentType = LOCAL_MIME[path.extname(url).slice(1).toLowerCase()];
      if (!contentType) throw new Error(`nieobsługiwany typ pliku: ${path.basename(url)}`);
      buffer = await readFile(url);
    } else if (parsed.type === "view") {
      ({ buffer, contentType } = await downloadFileuploaderBuffer(url));
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      contentType = res.headers.get("content-type") || "";
      if (!/^image\//i.test(contentType)) throw new Error(`odpowiedź to nie obraz (${contentType || "brak content-type"})`);
      buffer = Buffer.from(await res.arrayBuffer());
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
 * Buduje LP w nowym szablonie i tworzy ją w WP jako SZKIC (status draft, zawsze).
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

  await onProgress("⏳ Tworzę szkic strony w WordPress...");
  await ensureSeoSnippet();
  let page;
  try {
    page = await wpCreatePage({
      title: copy.seo?.title || `${zabieg} - ${copy.business?.name || ""}`.trim(),
      content: pageContent,
      status: "draft",
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
  const { copy, palette, heroImageUrl, baResolved, opResolved, mediaFailures, remainingTokens, emptyRegions, assumptions, formShortcode } =
    result;
  const needs = [
    ...remainingTokens.map((t) => `Pole bez danych: ${t}`),
    ...emptyRegions.map((r) => `Pusta sekcja (0 elementów): ${r}`),
    ...mediaFailures.map((m) => `Media - ${m}`),
  ];
  if (webhookLine && webhookLine.startsWith("Webhook: NIE")) needs.push(webhookLine);
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
