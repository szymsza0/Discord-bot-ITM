import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from "discord.js";
import { GOOGLE_LP_SHEET_ID, WP_LP_TEMPLATE_PAGE_ID } from "../config.js";
import { listZabiegiLP, findReferenceLPForZabieg, upsertLPRow } from "../utils/lpSheet.js";
import { getLPTemplate } from "../utils/lpTemplate.js";
import { fetchDocPlainText } from "../utils/googleDocs.js";
import { generateLPCopy, LPGenerationError } from "../utils/lpGenerator.js";
import {
  parseMaterialyInput,
  downloadFileuploaderBuffer,
  parseFileuploaderLink,
  listShareFolderFiles,
  downloadShareFolderFile,
} from "../utils/fileuploaderMedia.js";
import { matchMediaToSlots, MediaMatchError, DEFAULT_MEDIA_SLOTS } from "../utils/mediaMatcher.js";
import { buildPageContent } from "../utils/lpContentBuilder.js";
import { wpGetPageRawContent, wpUploadMedia, wpCreatePage } from "../utils/wordpressClient.js";

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
  const result = { zabieg: null, brief: null, materialy: null, uwagi: null };
  if (!content) return result;

  const buffers = { zabieg: [], brief: [], materialy: [], uwagi: [] };
  let currentKey = null;

  for (const rawLine of content.split("\n")) {
    const match = rawLine.match(/^\s*(zabiegi?|briefy?|materia?ly|uwag[ai]|notatki)\s*:\s*(.*)$/i);
    if (match) {
      const label = match[1].toLowerCase();
      currentKey = label.startsWith("brief")
        ? "brief"
        : label.startsWith("zabieg")
        ? "zabieg"
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
  return result;
}

async function askText(message, promptText) {
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
    await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!lp`.")] });
    return null;
  }
}

// Same single-message select-with-"Inne" pattern as skrypt.js's
// askOptionsOrOther - resolves via one click, unique customId per
// invocation so concurrent !lp runs in the same channel don't collide.
async function askOptionsOrOther(message, { options, placeholder, otherPrompt }) {
  const limitedOptions = options.slice(0, 24);
  const selectOptions = [
    ...limitedOptions.map((o) => ({ label: o.slice(0, 100), value: o })),
    { label: "Inne (wpisz nowe)", value: OTHER_VALUE, description: "Wpisz wartość ręcznie" },
  ];

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

    if (!WP_LP_TEMPLATE_PAGE_ID) {
      return message.channel.send({
        embeds: [errorEmbed("Brak konfiguracji WP_LP_TEMPLATE_PAGE_ID - ustaw ją w .env/Railway (WP page ID strony-wzorca).")],
      });
    }

    const inline = parseInlineArgs(content);

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

    await processingMsg.edit({ embeds: [infoEmbed("⏳ Wgrywam materiały do WordPress Media Library...")] });

    const mediaBySlot = {};
    const uploadFailures = [];
    for (const [slot, info] of slotAssignments) {
      try {
        // Folder-sourced files (keyword-matched or vision-matched) already
        // have their bytes from the folder scan above - re-downloading them
        // here would be a wasted second network round-trip for no reason.
        const { buffer, contentType } = info.buffer
          ? { buffer: info.buffer, contentType: info.contentType }
          : await downloadFileuploaderBuffer(info.url);
        const ext = extensionForMime(contentType);
        const businessSlug = localSlug(copy.business?.name || "itm") || "itm";

        // "folder-keyword" is treated the same as "labeled" for local SEO
        // naming - it was a deterministic filename match, not a Claude guess,
        // so it doesn't have (or need) seoFileName/seoAltText from the model.
        const isDeterministic = info.source === "labeled" || info.source === "folder-keyword";
        const seoFileName = isDeterministic
          ? `${businessSlug}-${localSlug(slot)}.${ext}`
          : info.seoFileName || `${localSlug(slot)}.${ext}`;
        const seoAltText = isDeterministic
          ? `${copy.business?.name || ""} - ${slot.replace(/_/g, " ")}`.trim()
          : info.seoAltText || slot;

        const uploaded = await wpUploadMedia(buffer, seoFileName, contentType, {
          altText: seoAltText,
          title: seoAltText,
        });
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

    const finalEmbed = new EmbedBuilder()
      .setColor(placeholderLines.length ? "#FFA500" : "#00FF00")
      .setTitle(placeholderLines.length ? "🎊 LP wdrożona (są placeholdery)" : "🎊 LP wdrożona")
      .addFields(
        { name: "✅ Wdrożono", value: truncate(implementedLines.join("\n") || "—", 1000) },
        { name: "⚠️ Do uzupełnienia", value: truncate(placeholderLines.join("\n") || "Brak - wszystko wypełnione.", 1000) },
        { name: "🔗 Linki", value: `[Szkic strony](${page.editLink})\n📊 [Arkusz Baza LP](${SHEET_URL})` }
      );

    await processingMsg.edit({ embeds: [finalEmbed] });
  } catch (error) {
    console.error("Error processing lp command:", error);
    try {
      await message.channel.send({ embeds: [errorEmbed(`Wystąpił błąd: ${error.message}`)] });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}
