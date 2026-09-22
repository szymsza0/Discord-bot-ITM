import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from "discord.js";
import { GOOGLE_LP_SHEET_ID, WP_LP_TEMPLATE_PAGE_ID } from "../config.js";
import { listZabiegiLP, findReferenceLPForZabieg, upsertLPRow } from "../utils/lpSheet.js";
import { getLPTemplate } from "../utils/lpTemplate.js";
import { fetchDocPlainText } from "../utils/googleDocs.js";
import { generateLPCopy, LPGenerationError, ASSUMPTION_MARKER } from "../utils/lpGenerator.js";
import {
  parseMaterialyInput,
  downloadFileuploaderBuffer,
  parseFileuploaderLink,
  fileuploaderDirect,
  listShareFolderFiles,
  downloadShareFolderFile,
} from "../utils/fileuploaderMedia.js";
import { matchMediaToSlots, MediaMatchError, DEFAULT_MEDIA_SLOTS } from "../utils/mediaMatcher.js";
import { buildPageContent } from "../utils/lpContentBuilder.js";
import { wpGetPageRawContent, wpUploadMedia, wpCreatePage, wpUpsertSnippet } from "../utils/wordpressClient.js";
import { generateNewLpCopy, NewLPGenerationError } from "../utils/lpNewGenerator.js";
import {
  getNewLpTemplate,
  renderNewTemplate,
  mapNewCopyToTemplate,
  wrapWpHtmlBlock,
} from "../utils/lpNewTemplate.js";
import { buildWebhookSnippetCode, slugify } from "./webhook.js";
import { optimizeToWebp, extForMime } from "../utils/imageOptimize.js";
import { generatePalette } from "../utils/lpPalette.js";

const SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_LP_SHEET_ID}/edit`;
const TEXT_PROMPT_TIMEOUT_MS = 90000;
const COMPONENT_TIMEOUT_MS = 120000;
const OTHER_VALUE = "__other__";

function errorEmbed(desc) {
  return new EmbedBuilder().setColor("#FF0000").setDescription(`❌ ${desc}`);
}
function infoEmbed(desc) {
  return new EmbedBuilder().setColor("#0079BF").setDescription(desc);
}

function extractGoogleDocId(url) {
  const match = (url || "").match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length <= max ? str : `${str.slice(0, max - 3)}...`;
}

// Bezpieczna wartość pola embeda: Discord wymaga 1-1024 znaków.
function fv(value) {
  const s = String(value ?? "").trim();
  return (s || "—").slice(0, 1024);
}

// Rozpakowanie zbiorczego błędu walidacji discord.js (@sapphire/shapeshift),
// którego .message to samo "Received one or more errors".
function errDetail(error) {
  const subs = Array.isArray(error?.errors) ? error.errors.map((e) => e?.message ?? String(e)) : [];
  const base = error?.message || String(error);
  return subs.length ? `${base} — ${subs.join(" | ")}` : base;
}

// Zdejmuje prefiks "⚠️ ZAŁOŻENIE: " z KAŻDEGO stringa w obiekcie copy (strona
// ma wyglądać czysto), a ścieżki takich pól dopisuje do `out` -> raport.
function stripAssumptionMarkers(node, out, path = "") {
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

function localSlug(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};
function extensionForMime(mimeType) {
  return MIME_EXTENSIONS[mimeType] || "bin";
}

// Deliberately conservative: only unambiguous keywords get auto-assigned by
// filename alone. "before_after_*" is NOT matched this way - "przed"/"po"
// are far too common as filename substrings (false positives), and Claude
// vision is genuinely well-suited to telling a before photo from an after
// photo, so those are always left to matchMediaToSlots() instead.
const SLOT_FILENAME_KEYWORDS = [
  { slot: "logo", keywords: ["logo"] },
  { slot: "hero_image", keywords: ["hero"] },
  { slot: "offer_image", keywords: ["ofert", "offer"] },
  { slot: "expert_photo", keywords: ["ekspert", "expert"] },
];

function matchSlotByFilename(filename) {
  const normalized = localSlug(filename);
  for (const { slot, keywords } of SLOT_FILENAME_KEYWORDS) {
    if (keywords.some((k) => normalized.includes(k))) return slot;
  }
  return null;
}

/**
 * Unlike !skrypt's line-per-field parseInlineArgs, `materialy:` needs to
 * absorb several following lines (one fileuploader link per line) as a
 * single field, not just the rest of its own line - so once a recognized
 * key is seen, subsequent non-key lines keep accumulating into it until the
 * next recognized key or the end of the message.
 */
function parseInlineArgs(content) {
  const result = { zabieg: null, brief: null, materialy: null, uwagi: null, szablon: null };
  if (!content) return result;

  const buffers = { zabieg: [], brief: [], materialy: [], uwagi: [], szablon: [] };
  let currentKey = null;

  for (const rawLine of content.split("\n")) {
    const match = rawLine.match(/^\s*(zabiegi?|briefy?|materia?ly|uwag[ai]|notatki|szablon)\s*:\s*(.*)$/i);
    if (match) {
      const label = match[1].toLowerCase();
      currentKey = label.startsWith("brief")
        ? "brief"
        : label.startsWith("zabieg")
        ? "zabieg"
        : label.startsWith("szablon")
        ? "szablon"
        : label.startsWith("uwag") || label.startsWith("notatk")
        ? "uwagi"
        : "materialy";
      if (match[2].trim()) buffers[currentKey].push(match[2].trim());
      continue;
    }
    if (currentKey && rawLine.trim()) buffers[currentKey].push(rawLine.trim());
  }

  result.zabieg = buffers.zabieg.length ? buffers.zabieg.join(", ") : null;
  result.brief = buffers.brief.length ? buffers.brief.join(", ") : null;
  result.materialy = buffers.materialy.length ? buffers.materialy.join("\n") : null;
  result.uwagi = buffers.uwagi.length ? buffers.uwagi.join("\n") : null;
  result.szablon = buffers.szablon.length ? buffers.szablon.join(" ").trim().toLowerCase() : null;
  return result;
}

async function askText(message, promptText, { optional = false } = {}) {
  await message.channel.send({ embeds: [infoEmbed(promptText)] });
  const filter = (m) => m.author.id === message.author.id;
  try {
    const collected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: TEXT_PROMPT_TIMEOUT_MS,
      errors: ["time"],
    });
    return collected.first().content.trim();
  } catch {
    // optional = krok dodatkowy / po utworzeniu strony: nie strasz "zacznij od nowa"
    if (!optional) {
      await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!lp`.")] });
    } else {
      await message.channel.send({ embeds: [infoEmbed("⏭️ Brak odpowiedzi - pomijam ten krok.")] });
    }
    return null;
  }
}

// Same single-message select-with-"Inne" pattern as skrypt.js's
// askOptionsOrOther - resolves via one click, unique customId per
// invocation so concurrent !lp runs in the same channel don't collide.
async function askOptionsOrOther(message, { options, placeholder, otherPrompt }) {
  // Discord: label i value 1-100 znaków, oba wymagane. Puste / za długie wpisy
  // z arkusza wywalały cały embed jako "Received one or more errors".
  const limitedOptions = (options || [])
    .map((o) => String(o ?? "").trim())
    .filter(Boolean)
    .slice(0, 24);
  const selectOptions = [
    ...limitedOptions.map((o) => ({ label: o.slice(0, 100), value: o.slice(0, 100) })),
    { label: "Inne (wpisz nowe)", value: OTHER_VALUE, description: "Wpisz wartość ręcznie" },
  ];

  if (limitedOptions.length === 0) {
    return askText(message, otherPrompt);
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`lp_select_${Date.now()}`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(selectOptions);

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const selectMessage = await message.channel.send({ content: `📋 ${placeholder}`, components: [row] });

  const filter = (interaction) =>
    interaction.customId === selectMenu.data.custom_id && interaction.user.id === message.author.id;

  let value;
  try {
    const interaction = await selectMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    value = interaction.values[0];
    await interaction.update({ content: `✅ Wybrano: ${value}`, components: [] });
  } catch {
    await selectMessage.edit({ content: "⌛ Czas minął, nie dokonano wyboru.", components: [] }).catch(() => {});
    return null;
  }

  if (value === OTHER_VALUE) {
    return askText(message, otherPrompt);
  }
  return value;
}

async function askZabieg(message) {
  let zabiegi = [];
  try {
    zabiegi = await listZabiegiLP(GOOGLE_LP_SHEET_ID);
  } catch (err) {
    console.warn("Nie udało się pobrać listy zabiegów LP, przechodzę na pole tekstowe:", err.message);
  }

  if (zabiegi.length === 0) {
    return askText(message, "Podaj zabieg/ofertę tej landing page:");
  }

  return askOptionsOrOther(message, {
    options: zabiegi,
    placeholder: "Wybierz zabieg LP:",
    otherPrompt: "Podaj nazwę nowego zabiegu:",
  });
}

// ============================================================================
//  NOWY SZABLON (lp-new-v1): cała strona w jednym bloku wp:html, media +
//  formularz podawane wprost w komendzie. Stary przepływ zostaje nietknięty.
// ============================================================================

function normalizeTemplateKind(raw) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return null;
  if (/^(nowy|new|v2|n-?v1|lp-new)/.test(v)) return "nowy";
  if (/^(stary|old|wzorzec|kadence|v1)/.test(v)) return "stary";
  return null;
}

async function askTemplateKind(message) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`lp_tpl_${Date.now()}`)
    .setPlaceholder("Który szablon LP?")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: "Nowy szablon", value: "nowy", description: "Jeden blok HTML (lp-new-v1). Media i formularz podajesz w komendzie." },
      { label: "Stary szablon", value: "stary", description: "Strona-wzorzec WP z tokenami - jak dotychczas." }
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const selectMessage = await message.channel.send({ content: "📐 Wybierz szablon landing page:", components: [row] });
  const filter = (i) => i.customId === selectMenu.data.custom_id && i.user.id === message.author.id;

  try {
    const interaction = await selectMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    await interaction.update({ content: `✅ Szablon: ${interaction.values[0]}`, components: [] });
    return interaction.values[0];
  } catch {
    await selectMessage.edit({ content: "⌛ Czas minął, nie wybrano szablonu.", components: [] }).catch(() => {});
    return null;
  }
}

function splitLinks(raw) {
  if (!raw || /^\s*brak\s*$/i.test(raw)) return [];
  // wyciagnij URL-e z DOWOLNEGO miejsca w linii (Discord potrafi opakowac w <>,
  // dokleic tekst, itd.) - wczesniejszy /^https/ gubil takie linki cicho
  const urls = String(raw).match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
  return urls.map((u) => u.replace(/[.,;]+$/, ""));
}

// Operator może wkleić cały shortcode CF7 (zalecane) albo samą nazwę formularza.
function normalizeFormShortcode(raw) {
  const t = (raw || "").trim();
  if (t.startsWith("[")) {
    const titleMatch = t.match(/title=["']([^"']+)["']/i);
    return { shortcode: t, name: titleMatch ? titleMatch[1] : "formularz CF7" };
  }
  return { shortcode: `[contact-form-7 title="${t}"]`, name: t };
}

// Pobiera medium (fileuploader /view/ albo dowolny http[s]), konwertuje do
// WebP + ogranicza szerokosc (strona ma byc szybka) i wgrywa do WP Media
// Library. Wyjatek: obrazek juz zhostowany na naszym WP i juz w .webp -
// uzywamy go wprost, bez duplikatu.
async function resolveMediaUrl(url, seoBase) {
  const base = (WP_BASE_URL || "").replace(/\/$/, "");
  if (base && url.startsWith(base) && /\.webp(\?|#|$)/i.test(url)) return url;

  const parsed = parseFileuploaderLink(url);
  const alt = seoBase.replace(/-/g, " ");
  try {
    let buffer, contentType;
    if (parsed.type === "view") {
      ({ buffer, contentType } = await downloadFileuploaderBuffer(url));
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      contentType = res.headers.get("content-type") || "";
      if (!/^image\//i.test(contentType)) throw new Error(`odpowiedź to nie obraz (${contentType || "brak content-type"})`);
      buffer = Buffer.from(await res.arrayBuffer());
    }

    const opt = await optimizeToWebp(buffer, contentType);
    try {
      const up = await wpUploadMedia(opt.buffer, `${seoBase}.${opt.ext}`, opt.contentType, { altText: alt, title: alt });
      return up.sourceUrl;
    } catch (err) {
      if (!opt.converted) throw err; // np. WP w ogole nie przyjmuje uploadu
      const up = await wpUploadMedia(buffer, `${seoBase}.${extForMime(contentType)}`, contentType, { altText: alt, title: alt });
      return up.sourceUrl;
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

async function runNewLpFlow(message, { inline }) {
  const zabieg = inline.zabieg || (await askZabieg(message));
  if (!zabieg) return;

  const briefLink = inline.brief || (await askText(message, "Podaj link do briefu (Google Doc):"));
  if (!briefLink) return;
  const briefDocId = extractGoogleDocId(briefLink);
  if (!briefDocId) {
    await message.channel.send({ embeds: [errorEmbed(`Nieprawidłowy link do briefu: ${briefLink}`)] });
    return;
  }

  const heroRaw = await askText(message, "🖼️ Zdjęcie HERO - podaj **1 link** (fileuploader `/view/...` albo bezpośredni URL):");
  if (heroRaw === null) return;

  const baRaw = await askText(
    message,
    "🖼️ Zdjęcia PRZED/PO - podaj linki, **po jednym w linii** (te same trafią do obu karuzel). Jeśli brak: `brak`."
  );
  if (baRaw === null) return;

  const opRaw = await askText(
    message,
    "🖼️ Zdjęcia OPINII (screeny) - podaj linki, **po jednym w linii**. Kolejność = kolejność cytatów. Jeśli brak: `brak`."
  );
  if (opRaw === null) return;

  const formRaw = await askText(
    message,
    'Formularz CF7 - wklej **cały shortcode**, np. `[contact-form-7 id="f606427" title="ZT Geneo"]` ' +
      "(albo samą nazwę, jeśli Twój CF7 rozwiązuje formularz po tytule). Formularz ma być gołym szkieletem - stylizuje go strona."
  );
  if (!formRaw) return;

  const themeRaw = await askText(
    message,
    "🎨 Motyw kolorystyczny strony (np. `ciepły beż i mauve`, `szałwia i biel`, `granat i złoto`). " +
      "Napisz `domyślny` albo pomiń, żeby zostawić obecną paletę:",
    { optional: true }
  );
  const themeText =
    themeRaw && !/^\s*(domy[śs]ln|default|standard)/i.test(themeRaw) ? themeRaw.trim() : null;

  const uwagiRaw = await askText(
    message,
    "📝 Uwagi do treści przed publikacją (na co nacisk, czego unikać, ton). `brak` albo pomiń:",
    { optional: true }
  );
  const uwagiFromPrompt = uwagiRaw && !/^\s*brak\s*$/i.test(uwagiRaw) ? uwagiRaw.trim() : null;
  const dodatkoweUwagi = [inline.uwagi, uwagiFromPrompt].filter(Boolean).join("\n") || null;

  const pakietyRaw = await askText(
    message,
    "📦 Pakiety zabiegów (jeśli klient je oferuje) - liczba zabiegów i cena za każdy pakiet, np. " +
      "`3 zabiegi - 550 zł, 4 zabiegi - 700 zł (polecany), 5 zabiegów - 800 zł`. " +
      "Jeśli brief już to opisuje albo klient nie oferuje pakietów, napisz `brak` albo pomiń:",
    { optional: true }
  );
  const pakietyInfo = pakietyRaw && !/^\s*brak\s*$/i.test(pakietyRaw) ? pakietyRaw.trim() : null;

  const heroUrls = splitLinks(heroRaw);
  const baUrls = splitLinks(baRaw);
  const opUrls = splitLinks(opRaw);
  const { shortcode: formShortcode, name: formName } = normalizeFormShortcode(formRaw);

  await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("📝 Podsumowanie (nowy szablon)")
        .addFields(
          { name: "Zabieg", value: fv(zabieg) },
          { name: "Brief", value: fv(briefLink) },
          { name: "Media", value: fv(`HERO: ${heroUrls.length} · przed/po: ${baUrls.length} · opinie: ${opUrls.length}`) },
          { name: "Formularz", value: fv(truncate(formShortcode, 500)) },
          { name: "Motyw", value: fv(themeText || "domyślny"), inline: true },
          { name: "Uwagi", value: fv(dodatkoweUwagi || "brak"), inline: true },
          { name: "Pakiety", value: fv(pakietyInfo || "brak / z briefu"), inline: true }
        ),
    ],
  });

  const processingMsg = await message.channel.send({
    embeds: [infoEmbed("⏳ Nowy szablon: pobieram brief i wytyczne...")],
  });

  let briefText, template;
  try {
    [briefText, template] = await Promise.all([fetchDocPlainText(briefDocId), getLPTemplate()]);
  } catch (err) {
    console.error("Error fetching new-LP starting data:", err);
    return processingMsg.edit({ embeds: [errorEmbed(`Nie udało się pobrać danych startowych: ${err.message}`)] });
  }

  await processingMsg.edit({ embeds: [infoEmbed("⏳ Generuję copy LP (nowy szablon)...")] });
  let copy;
  try {
    copy = await generateNewLpCopy({
      templateRulesText: template.rulesText,
      briefText,
      formName,
      beforeAfterCount: baUrls.length,
      opinieCount: opUrls.length,
      additionalNotes: dodatkoweUwagi,
      packagesInfo: pakietyInfo,
    });
  } catch (err) {
    if (err instanceof NewLPGenerationError) {
      return processingMsg.edit({ embeds: [errorEmbed(`${err.message}\n\nSzczegóły: ${err.details}`)] });
    }
    throw err;
  }

  // "⚠️ ZAŁOŻENIE: " nie ma trafiać na stronę - zdejmujemy prefiks, a listę
  // założonych pól pokazujemy w raporcie.
  const assumptions = [];
  copy = stripAssumptionMarkers(copy, assumptions);

  let palette = null;
  if (themeText) {
    await processingMsg.edit({ embeds: [infoEmbed("⏳ Dobieram paletę kolorów...")] });
    palette = await generatePalette(themeText);
  }

  await processingMsg.edit({ embeds: [infoEmbed("⏳ Przetwarzam multimedia...")] });
  const businessSlug = localSlug(copy.business?.name || zabieg || "itm") || "itm";
  const mediaFailures = [];

  // Brak dedykowanego HERO nie powinien dawać pustego <img src> na stronie -
  // jeśli operator podał chociaż zdjęcia przed/po, pierwsze z nich jest dużo
  // lepszym hero niż nic (sekcja i tak trafia na czoło strony).
  let heroImageUrl = "";
  const heroSourceUrl = heroUrls[0] || baUrls[0] || null;
  if (!heroSourceUrl) {
    mediaFailures.push("HERO: nie podano prawidłowego linku (ani HERO, ani żadnego zdjęcia przed/po do zastępczego użycia)");
  } else {
    try {
      heroImageUrl = await resolveMediaUrl(heroSourceUrl, `${businessSlug}-hero`);
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
        out.push(await resolveMediaUrl(urls[i], `${businessSlug}-${prefix}-${i + 1}`));
      } catch (err) {
        console.error(`new-LP ${prefix} #${i + 1} media:`, err);
        mediaFailures.push(`${prefix} #${i + 1}`);
      }
    }
    return out;
  };
  const baResolved = await resolveMany(baUrls, "przed-po");
  const opResolved = await resolveMany(opUrls, "opinia");

  await processingMsg.edit({ embeds: [infoEmbed("⏳ Składam stronę...")] });
  const templateHtml = await getNewLpTemplate();
  const { tokens, repeats } = mapNewCopyToTemplate(copy, opResolved);
  repeats.beforeAfter = baResolved.map((u) => ({ BA_URL: u }));
  const { content: pageBody, remainingTokens, emptyRegions } = renderNewTemplate(templateHtml, {
    tokens,
    repeats,
    heroImageUrl,
    formShortcode,
    palette,
  });
  const pageContent = wrapWpHtmlBlock(pageBody);

  await processingMsg.edit({ embeds: [infoEmbed("⏳ Tworzę szkic strony w WordPress...")] });
  let page;
  try {
    page = await wpCreatePage({
      title: copy.seo?.title || `${zabieg} - ${copy.business?.name || ""}`.trim(),
      content: pageContent,
      status: "draft",
      meta: copy.seo?.metaDescription ? { description: copy.seo.metaDescription } : undefined,
    });
  } catch (err) {
    console.error("Error creating new-LP WP page:", err);
    return processingMsg.edit({
      embeds: [errorEmbed(`Copy i media gotowe, ale nie udało się utworzyć strony WP: ${err.message}`)],
    });
  }

  try {
    await upsertLPRow(GOOGLE_LP_SHEET_ID, {
      klient: copy.business?.name || "",
      zabieg,
      briefLink,
      materialy: [heroRaw, baRaw, opRaw].filter((x) => x && !/^\s*brak\s*$/i.test(x)).join("\n"),
      strona: page.editLink,
      czyj: message.member?.displayName || message.author.username,
    });
  } catch (err) {
    console.error("Error updating Baza LP row (new template):", err);
    await message.channel.send({
      embeds: [errorEmbed(`Strona utworzona, ale nie udało się zaktualizować arkusza Baza LP: ${err.message}`)],
    });
  }

  // Opcjonalnie (już PO utworzeniu strony): webhook -> fragment w Code Snippets.
  // Cały krok w try - cokolwiek się tu wywali, raport i tak musi dojść.
  let webhookLine = null;
  try {
    const webhookAns = await askText(
      message,
      "➕ (opcjonalnie) Wstawić webhook formularza jako fragment w Code Snippets? Wklej **URL webhooka** albo `nie`:",
      { optional: true }
    );
    const webhookUrl = webhookAns && !/^\s*nie\s*$/i.test(webhookAns) ? (webhookAns.match(/https?:\/\/\S+/i) || [])[0] : null;
    if (webhookUrl) {
      const slugGuess = slugify(copy.seo?.title || zabieg || "");
      const slugRaw = await askText(
        message,
        `Slug strony do guardu webhooka (\`brak\` = wszędzie). Domyślnie: \`${slugGuess || "brak"}\``,
        { optional: true }
      );
      const pageSlug = slugRaw == null ? slugGuess : /^\s*brak\s*$/i.test(slugRaw) ? "" : slugRaw.trim() || slugGuess;
      const formLabel = slugify(formName) || "cf7";
      const code = await buildWebhookSnippetCode({ webhookUrl, formName: formLabel, pageSlug });
      const markerKey = slugify(pageSlug || formLabel || "global") || "global";
      const snip = await wpUpsertSnippet({
        name: `ITM webhook :: ${markerKey}`,
        code,
        scope: "site-footer",
        description: `Webhook CF7 -> ${webhookUrl} (formularz: ${formLabel}${pageSlug ? `, slug: ${pageSlug}` : ""})`,
        tags: ["itm", "webhook", "cf7"],
        active: true,
      });
      webhookLine = `Webhook: fragment #${snip.id} ${snip.created ? "utworzony" : "zaktualizowany"} (${pageSlug || "wszędzie"})`;
    }
  } catch (err) {
    console.error("new-LP webhook snippet:", err);
    webhookLine = `Webhook: NIE zapisano - ${err.message}`;
  }

  // -------- RAPORT KOŃCOWY --------
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
  if (palette) done.push(`Motyw: paleta z „${truncate(themeText, 50)}"`);
  done.push(`Formularz: ${formShortcode}`);
  done.push(`Media: HERO ${heroImageUrl ? "1" : "0"}, przed/po ${baResolved.length}, opinie ${opResolved.length}`);
  if (copy.packages?.items?.length) done.push(`Pakiety: ${copy.packages.items.length} kart(y)`);
  if (webhookLine && !webhookLine.startsWith("Webhook: NIE")) done.push(webhookLine);

  const pageUrl = page.link || page.editLink;
  const finalEmbed = new EmbedBuilder()
    .setColor(needs.length ? "#FFA500" : "#00FF00")
    .setTitle(needs.length ? "🎊 LP gotowa - zerknij, czego nie udało się zrobić" : "🎊 LP (nowy szablon) wdrożona")
    .addFields(
      { name: "✅ Zrobione", value: fv(truncate(done.join("\n"), 1000)) },
      { name: "⚠️ Czego nie udało się zrobić / do sprawdzenia", value: fv(truncate(needs.join("\n") || "Nic, wszystko poszło.", 1000)) },
      { name: "🔗 Linki", value: fv(`[Strona (podgląd)](${pageUrl})\n[Edytuj szkic](${page.editLink})\n📊 [Arkusz Baza LP](${SHEET_URL})`) }
    )
    .setFooter({ text: "Czegoś brakuje albo coś poprawić? Napisz, dorzucę." });

  try {
    await processingMsg.edit({ embeds: [finalEmbed] });
  } catch {
    await message.channel.send({ embeds: [finalEmbed] });
  }
  await message.channel.send(`🔗 Strona: ${pageUrl}`);
}

export async function processLpCommand(message) {
  try {
    const content = message.content.slice("!lp".length).trim();

    if (/^(admin\s+refresh|odśwież|odswiez)$/i.test(content)) {
      try {
        await getLPTemplate({ forceRefresh: true });
        return message.reply({
          embeds: [new EmbedBuilder().setColor("#00FF00").setDescription("✅ Wytyczne LP odświeżone.")],
        });
      } catch (err) {
        return message.reply({ embeds: [errorEmbed(`Nie udało się odświeżyć wytycznych: ${err.message}`)] });
      }
    }

    const inline = parseInlineArgs(content);

    let templateKind = normalizeTemplateKind(inline.szablon);
    if (!templateKind) {
      templateKind = await askTemplateKind(message);
      if (!templateKind) return;
    }

    if (templateKind === "nowy") {
      await runNewLpFlow(message, { inline });
      return;
    }

    // ===================== STARY SZABLON (przepływ bez zmian) =====================
    if (!WP_LP_TEMPLATE_PAGE_ID) {
      return message.channel.send({
        embeds: [errorEmbed("Brak konfiguracji WP_LP_TEMPLATE_PAGE_ID - ustaw ją w .env/Railway (WP page ID strony-wzorca).")],
      });
    }

    let zabieg = inline.zabieg;
    if (!zabieg) {
      zabieg = await askZabieg(message);
      if (!zabieg) return;
    }

    let briefLink = inline.brief;
    if (!briefLink) {
      briefLink = await askText(message, "Podaj link do briefu (Google Doc) dla tej landing page:");
      if (!briefLink) return;
    }

    let materialyRaw = inline.materialy;
    if (materialyRaw === null || materialyRaw === undefined) {
      materialyRaw = await askText(
        message,
        "Podaj materiały:\n" +
          "• Najprościej: **jeden link do folderu** z fileuploadera (`.../share/...`) - bot sam przeskanuje zawartość i dopasuje pliki do slotów.\n" +
          "• Albo pojedyncze linki (`.../view/...`), po jednym na linię/przecinek, opcjonalnie z etykietą slotu (zero zgadywania): `hero_image: <link>`, `logo: <link>`, `before_after_1: <link>`...\n" +
          "Jeśli brak materiałów, napisz `brak`."
      );
      if (materialyRaw === null) return;
    }

    // Purely optional and inline-only - no interactive prompt, since forcing
    // an "additional notes" question on every run would slow down the
    // common case where there's nothing extra to say.
    const dodatkoweUwagi = inline.uwagi || null;

    const summaryFields = [
      { name: "Zabieg", value: zabieg },
      { name: "Brief", value: briefLink },
      { name: "Materiały", value: truncate(materialyRaw || "brak", 1000) },
    ];
    if (dodatkoweUwagi) {
      summaryFields.push({ name: "Dodatkowe uwagi", value: truncate(dodatkoweUwagi, 1000) });
    }

    await message.channel.send({
      embeds: [new EmbedBuilder().setColor("#FFA500").setTitle("📝 Podsumowanie").addFields(summaryFields)],
    });

    const processingMsg = await message.channel.send({
      embeds: [infoEmbed("⏳ Przetwarzanie: pobieram brief, wytyczne i referencje...")],
    });

    const briefDocId = extractGoogleDocId(briefLink);
    if (!briefDocId) {
      return processingMsg.edit({ embeds: [errorEmbed(`Nieprawidłowy link do briefu: ${briefLink}`)] });
    }

    const templatePageId = WP_LP_TEMPLATE_PAGE_ID;

    // Brief + guidelines are critical - the whole command depends on them,
    // so a failure here genuinely has to stop everything. The sheet
    // reference lookup is purely a nice-to-have style hint (see
    // findReferenceLPForZabieg's docstring) - zabieg/brief/materialy always
    // come from the message itself, never from the sheet, so a sheet whose
    // layout doesn't match what this code expects should never block the
    // command. It gets its own try/catch, separate from the critical fetch,
    // so one bad column lookup can't take down brief/guidelines fetching too.
    let briefText, template;
    try {
      [briefText, template] = await Promise.all([fetchDocPlainText(briefDocId), getLPTemplate()]);
    } catch (err) {
      console.error("Error fetching LP starting data:", err);
      return processingMsg.edit({ embeds: [errorEmbed(`Nie udało się pobrać danych startowych: ${err.message}`)] });
    }

    let reference = null;
    try {
      reference = await findReferenceLPForZabieg(GOOGLE_LP_SHEET_ID, zabieg);
    } catch (err) {
      console.warn("Nie udało się pobrać referencyjnej LP z arkusza (pomijam):", err.message);
    }

    let referenceBriefText = null;
    if (reference?.briefLink) {
      const refDocId = extractGoogleDocId(reference.briefLink);
      if (refDocId) {
        try {
          referenceBriefText = await fetchDocPlainText(refDocId);
        } catch (err) {
          console.warn("Nie udało się pobrać referencyjnego briefu LP:", err.message);
        }
      }
    }

    const { labeled, unlabeled } = parseMaterialyInput(materialyRaw);
    const unlabeledUrls = unlabeled.filter((u) => /^https?:\/\//i.test(u));

    const labeledSlots = new Set(labeled.map((l) => l.slot));
    const remainingSlots = DEFAULT_MEDIA_SLOTS.filter((s) => !labeledSlots.has(s));

    // Labeled links always win outright - an explicit human label is never
    // second-guessed by the model or by filename keyword matching.
    const slotAssignments = new Map();
    for (const { slot, url } of labeled) {
      slotAssignments.set(slot, { url, source: "labeled" });
    }

    // Folder mode: exactly one unlabeled link, and it's a /share/{hash}
    // folder rather than a single /view/{hash} file - list its contents,
    // assign the unambiguous ones by filename, and hand the rest to the same
    // Claude-vision matcher used for individually-pasted unlabeled links.
    const folderCandidate = unlabeledUrls.length === 1 ? parseFileuploaderLink(unlabeledUrls[0]) : null;
    const isFolderMode = folderCandidate?.type === "share";

    let matchResult = { assignments: [], unmatchedRequiredSlots: remainingSlots, skipped: [] };
    const bufferByKey = new Map();

    if (isFolderMode) {
      await processingMsg.edit({ embeds: [infoEmbed("⏳ Skanuję folder z materiałami...")] });
      const folderUrl = unlabeledUrls[0];

      let files = [];
      try {
        files = await listShareFolderFiles(folderUrl);
      } catch (err) {
        console.error("Error listing share folder:", err);
        await message.channel.send({ embeds: [errorEmbed(`Nie udało się odczytać folderu materiałów: ${err.message}`)] });
      }

      const slotsStillOpen = remainingSlots.filter((s) => !slotAssignments.has(s));
      const visionItems = [];

      for (const file of files) {
        const keywordSlot = matchSlotByFilename(file.name);
        const canUseKeyword = keywordSlot && slotsStillOpen.includes(keywordSlot) && !slotAssignments.has(keywordSlot);

        try {
          const { buffer, contentType } = await downloadShareFolderFile(folderUrl, file.path);
          if (canUseKeyword) {
            slotAssignments.set(keywordSlot, { buffer, contentType, displayName: file.name, source: "folder-keyword" });
            slotsStillOpen.splice(slotsStillOpen.indexOf(keywordSlot), 1);
          } else {
            const key = `${folderUrl}#${file.name}`;
            bufferByKey.set(key, { buffer, contentType, displayName: file.name });
            visionItems.push({ url: key, buffer, contentType, displayName: file.name });
          }
        } catch (err) {
          console.error(`Błąd pobierania pliku "${file.name}" z folderu:`, err);
        }
      }

      await processingMsg.edit({ embeds: [infoEmbed("⏳ Dopasowuję pozostałe materiały do slotów...")] });

      try {
        matchResult = await matchMediaToSlots({ items: visionItems, remainingSlots: slotsStillOpen });
      } catch (err) {
        if (err instanceof MediaMatchError) {
          await message.channel.send({
            embeds: [errorEmbed(`Dopasowanie materiałów nie powiodło się: ${err.message}\n\nSzczegóły: ${err.details}`)],
          });
        } else {
          throw err;
        }
      }
    } else {
      await processingMsg.edit({ embeds: [infoEmbed("⏳ Dopasowuję materiały do slotów...")] });
      try {
        matchResult = await matchMediaToSlots({ unlabeledUrls, remainingSlots });
      } catch (err) {
        if (err instanceof MediaMatchError) {
          await message.channel.send({
            embeds: [errorEmbed(`Dopasowanie materiałów nie powiodło się: ${err.message}\n\nSzczegóły: ${err.details}`)],
          });
        } else {
          throw err;
        }
      }
    }

    for (const a of matchResult.assignments) {
      if (a.slot && !slotAssignments.has(a.slot)) {
        const cached = bufferByKey.get(a.sourceUrl);
        slotAssignments.set(a.slot, {
          url: cached ? undefined : a.sourceUrl,
          buffer: cached?.buffer,
          contentType: cached?.contentType,
          displayName: cached?.displayName,
          seoFileName: a.seoFileName,
          seoAltText: a.seoAltText,
          seoTitle: a.seoTitle,
          source: "matched",
        });
      }
    }

    const filledMediaSlots = [...slotAssignments.keys()];

    await processingMsg.edit({ embeds: [infoEmbed("⏳ Generuję copy LP...")] });

    let copy;
    try {
      copy = await generateLPCopy({
        templateRulesText: template.rulesText,
        briefText,
        referenceLPText: referenceBriefText,
        filledMediaSlots,
        additionalNotes: dodatkoweUwagi,
      });
    } catch (err) {
      if (err instanceof LPGenerationError) {
        return processingMsg.edit({ embeds: [errorEmbed(`${err.message}\n\nSzczegóły: ${err.details}`)] });
      }
      throw err;
    }

    // "⚠️ ZAŁOŻENIE: " nie ma trafiać na stronę - zdejmujemy prefiks.
    const assumptions = [];
    copy = stripAssumptionMarkers(copy, assumptions);

    await processingMsg.edit({ embeds: [infoEmbed("⏳ Wgrywam materiały do WordPress Media Library...")] });

    const mediaBySlot = {};
    const uploadFailures = [];
    for (const [slot, info] of slotAssignments) {
      try {
        // Folder-sourced files (keyword-matched or vision-matched) already
        // have their bytes from the folder scan above - re-downloading them
        // here would be a wasted second network round-trip for no reason.
        const src = info.buffer
          ? { buffer: info.buffer, contentType: info.contentType }
          : await downloadFileuploaderBuffer(info.url);
        const businessSlug = localSlug(copy.business?.name || "itm") || "itm";

        // Konwersja do WebP + limit szerokosci przed wgraniem (szybkosc strony).
        const opt = await optimizeToWebp(src.buffer, src.contentType);

        // "folder-keyword" is treated the same as "labeled" for local SEO
        // naming - it was a deterministic filename match, not a Claude guess,
        // so it doesn't have (or need) seoFileName/seoAltText from the model.
        const isDeterministic = info.source === "labeled" || info.source === "folder-keyword";
        const baseName = isDeterministic
          ? `${businessSlug}-${localSlug(slot)}`
          : info.seoFileName
          ? info.seoFileName.replace(/\.[a-z0-9]+$/i, "")
          : localSlug(slot);
        const seoAltText = isDeterministic
          ? `${copy.business?.name || ""} - ${slot.replace(/_/g, " ")}`.trim()
          : info.seoAltText || slot;

        let uploaded;
        try {
          uploaded = await wpUploadMedia(opt.buffer, `${baseName}.${opt.ext}`, opt.contentType, {
            altText: seoAltText,
            title: seoAltText,
          });
        } catch (err) {
          if (!opt.converted) throw err;
          uploaded = await wpUploadMedia(src.buffer, `${baseName}.${extensionForMime(src.contentType)}`, src.contentType, {
            altText: seoAltText,
            title: seoAltText,
          });
        }
        mediaBySlot[slot] = uploaded.sourceUrl;
      } catch (err) {
        console.error(`Błąd wgrywania medium dla slotu ${slot}:`, err);
        uploadFailures.push(slot);
      }
    }

    await processingMsg.edit({ embeds: [infoEmbed("⏳ Wstawiam treść na stronę...")] });

    let templateRawContent;
    try {
      templateRawContent = await wpGetPageRawContent(templatePageId);
    } catch (err) {
      console.error("Error fetching WP template page:", err);
      return processingMsg.edit({
        embeds: [errorEmbed(`Nie udało się pobrać strony-wzorca WP #${templatePageId}: ${err.message}`)],
      });
    }

    const { content: pageContent, remainingTokens } = buildPageContent(templateRawContent, copy, mediaBySlot);

    let page;
    try {
      page = await wpCreatePage({
        title: copy.seo?.title || `${zabieg} - ${copy.business?.name || ""}`.trim(),
        content: pageContent,
        status: "draft",
        meta: copy.seo?.metaDescription ? { description: copy.seo.metaDescription } : undefined,
      });
    } catch (err) {
      console.error("Error creating WP page:", err);
      return processingMsg.edit({
        embeds: [errorEmbed(`Copy i materiały gotowe, ale nie udało się utworzyć strony WP: ${err.message}`)],
      });
    }

    // Only touch the sheet after the page actually exists - see upsertLPRow's
    // docstring for why a failed wpCreatePage() must never reach here.
    try {
      await upsertLPRow(GOOGLE_LP_SHEET_ID, {
        klient: copy.business?.name || "",
        zabieg,
        briefLink,
        materialy: materialyRaw,
        strona: page.editLink,
        czyj: message.member?.displayName || message.author.username,
      });
    } catch (err) {
      console.error("Error updating Baza LP row:", err);
      await message.channel.send({
        embeds: [errorEmbed(`Strona utworzona, ale nie udało się zaktualizować arkusza Baza LP: ${err.message}`)],
      });
    }

    const unmatchedRequiredSlots = matchResult.unmatchedRequiredSlots || [];
    const skipped = matchResult.skipped || [];

    const implementedLines = [];
    if (copy.business?.name) implementedLines.push(`Firma: ${copy.business.name}`);
    implementedLines.push("Copy (hero, oferta, USP i pozostałe wypełnione pola) - patrz szkic.");
    if (filledMediaSlots.length) implementedLines.push(`Media wgrane do slotów: ${filledMediaSlots.join(", ")}`);

    const placeholderLines = [
      ...remainingTokens.map((t) => `Token bez danych: ${t}`),
      ...unmatchedRequiredSlots.map((s) => `Brak pliku dla slotu: ${s}`),
      ...uploadFailures.map((s) => `Błąd wgrywania pliku dla slotu: ${s}`),
      ...skipped.map((s) => `Pominięty plik (nieobsługiwany format ${s.contentType}): ${s.url}`),
    ];
    if (assumptions.length) {
      placeholderLines.push(
        `Założenia AI do sprawdzenia (${assumptions.length}): ${assumptions.slice(0, 15).join(", ")}${
          assumptions.length > 15 ? " ..." : ""
        }`
      );
    }

    const pageUrl = page.link || page.editLink;
    const finalEmbed = new EmbedBuilder()
      .setColor(placeholderLines.length ? "#FFA500" : "#00FF00")
      .setTitle(placeholderLines.length ? "🎊 LP wdrożona (są placeholdery)" : "🎊 LP wdrożona")
      .addFields(
        { name: "✅ Wdrożono", value: truncate(implementedLines.join("\n") || "—", 1000) },
        { name: "⚠️ Czego nie udało się zrobić / do sprawdzenia", value: truncate(placeholderLines.join("\n") || "Nic, wszystko poszło.", 1000) },
        { name: "🔗 Linki", value: `[Strona (podgląd)](${pageUrl})\n[Edytuj szkic](${page.editLink})\n📊 [Arkusz Baza LP](${SHEET_URL})` }
      )
      .setFooter({ text: "Czegoś brakuje albo coś poprawić? Napisz, dorzucę." });

    try {
      await processingMsg.edit({ embeds: [finalEmbed] });
    } catch {
      await message.channel.send({ embeds: [finalEmbed] });
    }
    await message.channel.send(`🔗 Strona: ${pageUrl}`);
  } catch (error) {
    console.error("Error processing lp command:", error);
    try {
      await message.channel.send({ embeds: [errorEmbed(`Wystąpił błąd: ${truncate(errDetail(error), 1500)}`)] });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}
