import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PALETTE_KEYS } from "./lpPalette.js";

/**
 * Renderer dla szablonu "nowy" (src/templates/lp-new-v1.html).
 *
 * W przeciwieństwie do starego szablonu (strona-wzorzec w WP z tokenami
 * {{TOKEN}}, patrz lpContentBuilder.js), nowy szablon:
 *  - jest PLIKIEM w repo (wersjonowany), nie stroną WP,
 *  - wchodzi na stronę jako JEDEN blok wp:html,
 *  - ma sekcje o zmiennej liczbie elementów (przed/po, opinie, FAQ, ...),
 *    więc oprócz {{TOKEN}} obsługuje regiony powtarzalne:
 *      <!--BEGIN:nazwa--> ...wiersz z {{KLUCZ}}... <!--END:nazwa-->
 *
 * Formularz jest wstawiany jako goły shortcode CF7 ({{FORM_SHORTCODE}}) -
 * cała jego stylizacja pochodzi z <style> w szablonie (reguły
 * `.zl-form-box .wpcf7-form ...`), zgodnie z założeniem "formularz = szkielet".
 */

const TEMPLATE_PATH = fileURLToPath(new URL("../templates/lp-new-v1.html", import.meta.url));

let cachedTemplate = null;

export async function getNewLpTemplate({ forceRefresh = false } = {}) {
  if (cachedTemplate && !forceRefresh) return cachedTemplate;
  const raw = await readFile(TEMPLATE_PATH, "utf8");
  // Zdejmij wiodący blok-komentarz z dokumentacją szablonu (wszystko przed <style>):
  // nie ma po co trafiać na stronę i psułby raport "do uzupełnienia".
  cachedTemplate = raw.replace(/^﻿?[\s\S]*?(<style)/, "$1");
  return cachedTemplate;
}

/** Zawija gotowy HTML w jeden blok Gutenberga "Custom HTML". */
export function wrapWpHtmlBlock(html) {
  return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`;
}

// Wszystkie regiony powtarzalne obecne w lp-new-v1.html. "beforeAfter"
// występuje 2x (dwie karuzele) - regex jest globalny, więc oba wystąpienia
// dostają ten sam zestaw wierszy.
const REGION_NAMES = [
  "trust",
  "fit",
  "beforeAfter",
  "opinie",
  "offerIncludes",
  "why",
  "howParas",
  "howSteps",
  "packages",
  "faq",
  "contact",
];

// Sekcje, które (w przeciwieństwie do reszty szablonu) mają w ogóle zniknąć
// ze strony, gdy odpowiadający im region jest pusty - np. "pakiety" ma sens
// tylko dla części klientów. W pliku szablonu owijają CAŁĄ sekcję (łącznie
// z <section>...</section>) komentarzami <!--SECTION_IF:nazwa--> ... <!--/SECTION_IF:nazwa-->.
const OPTIONAL_SECTIONS = ["packages"];

function fillRow(rowTemplate, item) {
  let out = rowTemplate;
  // [[if KLUCZ]] ... [[/if]] - zostaw wnetrze tylko gdy item[KLUCZ] jest niepuste
  out = out.replace(/\[\[if (\w+)\]\]([\s\S]*?)\[\[\/if\]\]/g, (_m, key, inner) => {
    const v = item ? item[key] : undefined;
    return v == null || v === "" ? "" : inner;
  });
  for (const [key, value] of Object.entries(item || {})) {
    out = out.replaceAll(`{{${key}}}`, value == null ? "" : String(value));
  }
  return out;
}

function expandRegion(content, name, rows) {
  const re = new RegExp(`<!--BEGIN:${name}-->([\\s\\S]*?)<!--END:${name}-->`, "g");
  return content.replace(re, (_match, inner) => (rows || []).map((item) => fillRow(inner, item)).join(""));
}

/**
 * @param {string} templateHtml  surowy szablon (getNewLpTemplate())
 * @param {object} args
 * @param {Object<string,string>} args.tokens         skalarne {{TOKEN}} -> wartość
 * @param {Object<string,Array<object>>} args.repeats  nazwa regionu -> lista {KLUCZ: wartość}
 * @param {string} args.heroImageUrl                   URL do {{MEDIA:hero_image}}
 * @param {string} args.formShortcode                  shortcode CF7 do {{FORM_SHORTCODE}}
 * @param {Object<string,string>|null} args.palette    {cream, ink, mauveDeep, ...} #RRGGBB (generatePalette)
 * @returns {{ content:string, remainingTokens:string[], emptyRegions:string[] }}
 */
export function renderNewTemplate(
  templateHtml,
  { tokens = {}, repeats = {}, heroImageUrl = "", formShortcode = "", palette = null }
) {
  let content = templateHtml;

  // 0) motyw kolorystyczny: podmien wartosci zmiennych --zl-* w :root
  if (palette) {
    for (const [key, cssVar] of Object.entries(PALETTE_KEYS)) {
      const hex = palette[key];
      if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) continue;
      content = content.replace(new RegExp(`(${cssVar}\\s*:\\s*)#[0-9a-fA-F]{3,8}`, "g"), `$1${hex}`);
    }
  }

  // 0.6) sekcje w całości opcjonalne - usuń CAŁY blok <!--SECTION_IF:nazwa-->...<!--/SECTION_IF:nazwa-->
  // (włącznie z otaczającym <section>), gdy odpowiadający region nie ma żadnych wierszy.
  // Musi zajść PRZED zwykłym rozwinięciem regionów, żeby usunięty blok nie trafił do emptyRegions.
  for (const name of OPTIONAL_SECTIONS) {
    const hasRows = (repeats[name] || []).length > 0;
    const re = new RegExp(`<!--SECTION_IF:${name}-->([\\s\\S]*?)<!--\\/SECTION_IF:${name}-->`, "g");
    content = content.replace(re, (_match, inner) => (hasRows ? inner : ""));
  }

  // 1) regiony powtarzalne
  const emptyRegions = [];
  for (const name of REGION_NAMES) {
    const rows = repeats[name] || [];
    if (rows.length === 0 && new RegExp(`<!--BEGIN:${name}-->`).test(content)) emptyRegions.push(name);
    content = expandRegion(content, name, rows);
  }
  // usuń ewentualne nieznane regiony, żeby komentarze BEGIN/END nie zostały w treści
  content = content.replace(/<!--BEGIN:[a-zA-Z0-9_]+-->[\s\S]*?<!--END:[a-zA-Z0-9_]+-->/g, "");

  // 2) media HERO + shortcode formularza
  content = content.replaceAll("{{MEDIA:hero_image}}", heroImageUrl || "");
  content = content.replaceAll("{{FORM_SHORTCODE}}", formShortcode || "");

  // 3) skalarne tokeny (null / "" -> token zostaje i trafia do raportu)
  for (const [token, value] of Object.entries(tokens)) {
    if (value === null || value === undefined || value === "") continue;
    content = content.replaceAll(`{{${token}}}`, String(value));
  }

  const remainingTokens = [
    ...new Set([...content.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0])),
  ];

  return { content, remainingTokens, emptyRegions };
}

/**
 * Mapuje obiekt copy z generateNewLpCopy() na { tokens, repeats } dla
 * renderNewTemplate(). Trzymane osobno od komendy, żeby kształt szablonu
 * i kształt copy były w jednym miejscu.
 *
 * @param {object} copy        wynik generateNewLpCopy()
 * @param {string[]} opinieImageUrls  URL-e opinii (parowane z copy.opinie.items po indeksie)
 */
export function mapNewCopyToTemplate(copy, opinieImageUrls = []) {
  const c = copy || {};
  const s = (v) => (v == null ? "" : String(v));

  const tokens = {
    NAV_LOGO: s(c.nav?.logo),
    NAV_LOGO_SUB: s(c.nav?.logo_sub),
    NAV_CTA: s(c.nav?.cta_label),

    HERO_BADGE: s(c.hero?.badge),
    HERO_HEADLINE: s(c.hero?.headline),
    HERO_HEADLINE_EM: s(c.hero?.headline_em),
    HERO_LEAD: s(c.hero?.lead),
    HERO_NOTE: s(c.hero?.note),
    HERO_CTA: s(c.hero?.cta_label),

    FIT_TITLE: s(c.fit?.title),
    FIT_SUBTITLE: s(c.fit?.subtitle),
    FIT_CTA: s(c.fit?.cta_label),

    EFEKTY_TITLE: s(c.efekty?.title),
    EFEKTY_SUB: s(c.efekty?.subtitle),
    EFEKTY_CTA: s(c.efekty?.cta_label),

    OPINIE_TITLE: s(c.opinie?.title),
    OPINIE_SUB: s(c.opinie?.subtitle),
    OPINIE_CTA: s(c.opinie?.cta_label),

    OFFER_TITLE: s(c.offer?.title),
    OFFER_SUB: s(c.offer?.subtitle),
    OFFER_EYEBROW: s(c.offer?.eyebrow),
    OFFER_PRODUCT_TITLE: s(c.offer?.product_title),
    OFFER_BONUS_LINE: s(c.offer?.bonus_line),
    OFFER_PRICE_REGULAR: s(c.offer?.price_regular),
    OFFER_PRICE_PROMO: s(c.offer?.price_promo),
    OFFER_PRICE_PROMO_LABEL: s(c.offer?.price_promo_label) || "Cena promocyjna",
    OFFER_SAVINGS_LINE: s(c.offer?.savings_line),
    OFFER_COUNTDOWN_MINUTES: s(c.offer?.countdown_minutes) || "15",
    OFFER_FORM_TITLE: s(c.offer?.form_title) || "Zostaw kontakt - oddzwonimy",
    OFFER_FORM_SUB: s(c.offer?.form_sub),

    WHY_TITLE: s(c.why_us?.title),
    WHY_SUB: s(c.why_us?.subtitle),
    WHY_CTA: s(c.why_us?.cta_label),

    HOW_TITLE: s(c.how?.title),
    HOW_SUB: s(c.how?.subtitle),
    HOW_LEAD_TITLE: s(c.how?.lead_title),
    HOW_CTA: s(c.how?.cta_label),

    META_TITLE: s(c.metamorfozy?.title) || "Zobacz metamorfozy krok po kroku",
    META_SUB: s(c.metamorfozy?.subtitle) || "Kolejne efekty naszych klientek - przesuń, aby zobaczyć więcej.",

    PACKAGES_TITLE: s(c.packages?.title) || "Pakiety zabiegów",
    PACKAGES_SUB: s(c.packages?.subtitle),
    PACKAGES_NOTE: s(c.packages?.note),

    MIDCTA_TITLE: s(c.midcta?.title),
    MIDCTA_BODY: s(c.midcta?.body),
    MIDCTA_CTA: s(c.midcta?.cta_label),

    FAQ_TITLE: s(c.faq?.title) || "Pytania i odpowiedzi",
    FAQ_SUB: s(c.faq?.subtitle),
    FAQ_CTA: s(c.faq?.cta_label),

    FINAL_EYEBROW: s(c.final?.eyebrow),
    FINAL_TITLE: s(c.final?.title),
    FINAL_SUB: s(c.final?.sub),
    FINAL_INFO_EYEBROW: s(c.final?.info_eyebrow),
    FINAL_INFO_TITLE: s(c.final?.info_title),
    FINAL_PRICE_LINE: s(c.final?.price_line),
    FINAL_FORM_TITLE: s(c.final?.form_title) || "Zostaw kontakt - oddzwonimy",
    FINAL_FORM_SUB: s(c.final?.form_sub),

    FOOTER_BRAND: s(c.footer?.brand) || s(c.business?.name),
    FOOTER_LINE: s(c.footer?.line),
    FOOTER_COPYRIGHT: s(c.footer?.copyright),
  };

  const repeats = {
    trust: (c.trust || []).map((t) => ({ T_STRONG: s(t.strong), T_LABEL: s(t.label) })),
    fit: (c.fit?.items || []).map((x) => ({ FIT_ITEM: s(x) })),
    // Renderujemy tyle kart, ile jest ZDJĘĆ opinii (to realne screeny). Cytat
    // i imię dokładamy tylko gdy AI je zwróciło (real, nie zmyślone) - inaczej
    // karta to samo zdjęcie.
    opinie: Array.from(
      { length: Math.max((c.opinie?.items || []).length, opinieImageUrls.length) },
      (_unused, i) => {
        const it = (c.opinie?.items || [])[i] || {};
        return { OP_QUOTE: s(it.quote), OP_NAME: s(it.name), OP_IMAGE: s(opinieImageUrls[i] || "") };
      }
    ),
    offerIncludes: (c.offer?.includes || []).map((x) => ({ OFFER_INCLUDE: s(x) })),
    why: (c.why_us?.cards || []).map((card) => ({ WHY_CARD_TITLE: s(card.title), WHY_CARD_BODY: s(card.body) })),
    howParas: (c.how?.lead_paras || []).map((p) => ({ HOW_PARA: s(p) })),
    howSteps: (c.how?.steps || []).map((st, i) => ({ STEP_N: String(i + 1), STEP_TITLE: s(st.title), STEP_BODY: s(st.body) })),
    packages: (c.packages?.items || []).map((p) => ({
      PKG_FEATURED: p.featured ? "1" : "",
      PKG_TAG: s(p.tag),
      PKG_NAME: s(p.name),
      PKG_COUNT: s(p.count),
      PKG_PRICE_REGULAR: s(p.price_regular),
      PKG_PRICE_TOTAL: s(p.price_total),
      PKG_PRICE_PER: s(p.price_per),
      PKG_SAVING: s(p.saving),
      PKG_CTA: s(p.cta_label) || s(c.packages?.cta_label) || "Wybieram ten pakiet",
    })),
    faq: (c.faq?.items || []).map((f) => ({ FAQ_Q: s(f.q), FAQ_A: s(f.a) })),
    contact: (c.final?.contact_lines || []).map((l) => ({ CONTACT_LINE: s(l) })),
  };

  return { tokens, repeats };
}
