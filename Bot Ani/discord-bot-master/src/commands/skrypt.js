import {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { GOOGLE_SCRIPTS_SHEET_ID, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID } from "../config.js";
import {
  listZabiegCategories,
  listKlienci,
  findReferenceScriptForZabieg,
  appendScriptRow,
} from "../utils/scriptSheet.js";
import { getScriptTemplate } from "../utils/scriptTemplate.js";
import {
  fetchDocPlainText,
  buildScriptDocContent,
  createFormattedScriptDoc,
  moveDocToFolder,
} from "../utils/googleDocs.js";
import { generateScriptVariant, ScriptGenerationError } from "../utils/scriptGenerator.js";
import { integrateScriptFeedback } from "../utils/feedbackIntegrator.js";

const FEEDBACK_PROMPT_TIMEOUT_MS = 180000;

const SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SCRIPTS_SHEET_ID}/edit`;
const MAX_TREATMENTS_PER_SCRIPT = 2;
const MAX_VARIANTS = 3;
const DEFAULT_VARIANTS = 2;
// Text prompts (free-form answers, e.g. brief link) need the user to type and
// send a message, so they get a slightly longer window than component clicks.
const TEXT_PROMPT_TIMEOUT_MS = 90000;
// Component interactions (select menus / buttons) resolve with a single click,
// no typing required, so they can afford a generous window without any of the
// prior back-and-forth messages piling up in the channel.
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

function parseInlineArgs(content) {
  const result = { klient: null, warianty: null, zabiegi: null, brief: null };
  if (!content) return result;

  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(klient|warianty|zabiegi?|brief(?:y)?)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "klient") result.klient = value;
    else if (key === "warianty") result.warianty = value;
    else if (key.startsWith("zabieg"))
      result.zabiegi = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key.startsWith("brief")) result.brief = value;
  }

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
    await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!skrypt`.")] });
    return null;
  }
}

/**
 * Single-message select menu with a built-in "Inne" (other) option so the
 * operator can always type a brand-new value (new client, new treatment)
 * instead of being limited to what's already in the sheet. Resolves via one
 * click (interaction.update), so it never spams follow-up messages and, since
 * each menu's customId is unique per invocation, two people can run !skrypt
 * concurrently in the same channel without colliding.
 */
async function askOptionsOrOther(message, { options, placeholder, maxValues, otherPrompt }) {
  const limitedOptions = options.slice(0, 24);
  const selectOptions = [
    ...limitedOptions.map((o) => ({ label: o.slice(0, 100), value: o })),
    { label: "Inne (wpisz nowe)", value: OTHER_VALUE, description: "Wpisz wartość ręcznie" },
  ];

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`skrypt_select_${Date.now()}`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(Math.min(maxValues, selectOptions.length))
    .addOptions(selectOptions);

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const selectMessage = await message.channel.send({ content: `📋 ${placeholder}`, components: [row] });

  const filter = (interaction) =>
    interaction.customId === selectMenu.data.custom_id && interaction.user.id === message.author.id;

  let values;
  try {
    const interaction = await selectMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    values = interaction.values;
    await interaction.update({ content: `✅ Wybrano: ${values.join(", ")}`, components: [] });
  } catch {
    await selectMessage.edit({ content: "⌛ Czas minął, nie dokonano wyboru.", components: [] }).catch(() => {});
    return null;
  }

  if (values.includes(OTHER_VALUE)) {
    const concrete = values.filter((v) => v !== OTHER_VALUE);
    const typed = await askText(message, otherPrompt);
    if (typed === null) return null;
    const typedValues = typed.split(",").map((s) => s.trim()).filter(Boolean);
    return [...concrete, ...typedValues];
  }

  return values;
}

async function askClient(message) {
  let klienci = [];
  try {
    klienci = await listKlienci(GOOGLE_SCRIPTS_SHEET_ID);
  } catch (err) {
    console.warn("Nie udało się pobrać listy klientów, przechodzę na pole tekstowe:", err.message);
  }

  if (klienci.length === 0) {
    return askText(message, "Podaj nazwę klienta:");
  }

  const values = await askOptionsOrOther(message, {
    options: klienci,
    placeholder: "Wybierz klienta:",
    maxValues: 1,
    otherPrompt: "Podaj nazwę nowego klienta:",
  });

  return values ? values[0] : null;
}

/**
 * Single-message button row for the 1-3 variant count - a plain click
 * instead of typing a number, with the default visually highlighted.
 */
async function askVariantCount(message) {
  const row = new ActionRowBuilder().addComponents(
    Array.from({ length: MAX_VARIANTS }, (_, idx) => idx + 1).map((n) =>
      new ButtonBuilder()
        .setCustomId(`skrypt_warianty_${n}_${Date.now()}`)
        .setLabel(n === DEFAULT_VARIANTS ? `${n} (domyślnie)` : `${n}`)
        .setStyle(n === DEFAULT_VARIANTS ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  const promptMessage = await message.channel.send({
    content: "🔢 Ile wariantów skryptu wygenerować?",
    components: [row],
  });

  const filter = (interaction) =>
    interaction.user.id === message.author.id && interaction.customId.startsWith("skrypt_warianty_");

  try {
    const interaction = await promptMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    const n = parseInt(interaction.customId.split("_")[2], 10);
    await interaction.update({ content: `✅ Liczba wariantów: ${n}`, components: [] });
    return n;
  } catch {
    await promptMessage
      .edit({ content: `⌛ Czas minął — użyto wartości domyślnej (${DEFAULT_VARIANTS}).`, components: [] })
      .catch(() => {});
    return DEFAULT_VARIANTS;
  }
}

/**
 * Asks the user to pick 1-2 treatments. Uses a native multi-select dropdown
 * (with a built-in "Inne" option) when the live category list from the sheet
 * fits Discord's 25-option limit; otherwise falls back to a paginated
 * numbered list (same style as the existing handleBoardSelection() pattern
 * in utils/helpers.js) where typing a name instead of a number is treated as
 * a new, custom treatment.
 */
async function askTreatments(message, categories) {
  if (categories.length <= 24) {
    const values = await askOptionsOrOther(message, {
      options: categories,
      placeholder: `Wybierz zabieg (maks. ${MAX_TREATMENTS_PER_SCRIPT}):`,
      maxValues: MAX_TREATMENTS_PER_SCRIPT,
      otherPrompt: "Podaj nazwę nowego zabiegu (jeśli więcej niż jeden, oddziel przecinkiem):",
    });
    return values ? values.slice(0, MAX_TREATMENTS_PER_SCRIPT) : null;
  }

  const pageSize = 25;
  let page = 0;
  for (;;) {
    const pageItems = categories.slice(page * pageSize, page * pageSize + pageSize);
    const hasMore = (page + 1) * pageSize < categories.length;
    const listText = pageItems.map((c, i) => `**${page * pageSize + i + 1}.** ${c}`).join("\n");

    await message.channel.send({
      embeds: [
        infoEmbed(
          `Wybierz zabieg (numer, max ${MAX_TREATMENTS_PER_SCRIPT} po przecinku), wpisz nazwę nowego zabiegu,` +
            `${hasMore ? ' lub napisz "więcej"' : ""}:\n\n${listText}`
        ),
      ],
    });

    const filter = (m) => m.author.id === message.author.id;
    let collected;
    try {
      collected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: TEXT_PROMPT_TIMEOUT_MS,
        errors: ["time"],
      });
    } catch {
      await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!skrypt`.")] });
      return null;
    }

    const content = collected.first().content.trim();
    const lower = content.toLowerCase();
    if (hasMore && (lower === "więcej" || lower === "wiecej")) {
      page++;
      continue;
    }

    const isNumberList = /^\d+(\s*,\s*\d+)*$/.test(content);
    if (isNumberList) {
      const nums = content
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0 && n <= categories.length);

      if (nums.length === 0 || nums.length > MAX_TREATMENTS_PER_SCRIPT) {
        await message.channel.send({
          embeds: [errorEmbed(`Podaj 1-${MAX_TREATMENTS_PER_SCRIPT} poprawne numery, oddzielone przecinkiem.`)],
        });
        continue;
      }
      return nums.map((n) => categories[n - 1]);
    }

    // Not a number list - treat the raw text as one or more new, custom
    // treatment names (this is the "Inne" path for the paginated fallback).
    const custom = content.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_TREATMENTS_PER_SCRIPT);
    if (custom.length === 0) {
      await message.channel.send({ embeds: [errorEmbed("Podaj co najmniej jeden zabieg.")] });
      continue;
    }
    return custom;
  }
}

/**
 * Optional, best-effort feedback prompt shown right after a successful
 * generation. Not required - if it times out (or the operator is done),
 * `!feedback <link> <tekst>` remains available standalone at any later time.
 */
async function askForFeedback(message, scriptLink) {
  await message.channel.send({
    embeds: [
      infoEmbed(
        `💬 Masz feedback do tych skryptów? Napisz go tutaj w ciągu 3 minut, albo później użyj \`!feedback ${scriptLink} <treść>\`.`
      ),
    ],
  });

  const filter = (m) => m.author.id === message.author.id && !m.content.startsWith("!");
  let collected;
  try {
    collected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: FEEDBACK_PROMPT_TIMEOUT_MS,
      errors: ["time"],
    });
  } catch {
    return; // no feedback given - fine, it's optional
  }

  const feedbackText = collected.first().content.trim();
  if (!feedbackText) return;

  const processingMsg = await message.channel.send({
    embeds: [infoEmbed("⏳ Analizuję feedback i aktualizuję wytyczne...")],
  });

  try {
    const authorName = message.member?.displayName || message.author.username;
    const result = await integrateScriptFeedback({ feedbackText, scriptLink, authorName });

    const embed = new EmbedBuilder()
      .setColor(result.hasConflict ? "#FFA500" : "#00FF00")
      .setTitle(result.hasConflict ? "⚠️ Feedback zapisany (możliwa sprzeczność)" : "✅ Feedback zapisany")
      .setDescription(result.entryText);

    if (result.hasConflict && result.conflictNote) {
      embed.addFields({ name: "Do przejrzenia", value: result.conflictNote });
    }

    await processingMsg.edit({ embeds: [embed] });
  } catch (err) {
    console.error("Error integrating feedback:", err);
    await processingMsg.edit({ embeds: [errorEmbed(`Nie udało się zapisać feedbacku: ${err.message}`)] });
  }
}

export async function processSkryptCommand(message) {
  try {
    const content = message.content.slice("!skrypt".length).trim();

    if (/^(admin\s+refresh|odśwież|odswiez)$/i.test(content)) {
      try {
        await getScriptTemplate({ forceRefresh: true });
        return message.reply({
          embeds: [new EmbedBuilder().setColor("#00FF00").setDescription("✅ Szablon skryptów odświeżony.")],
        });
      } catch (err) {
        return message.reply({ embeds: [errorEmbed(`Nie udało się odświeżyć szablonu: ${err.message}`)] });
      }
    }

    const inline = parseInlineArgs(content);

    let klient = inline.klient;
    if (!klient) {
      klient = await askClient(message);
      if (!klient) return;
    }

    let warianty = inline.warianty ? parseInt(inline.warianty, 10) : NaN;
    if (Number.isNaN(warianty)) {
      warianty = await askVariantCount(message);
    }
    warianty = Math.min(MAX_VARIANTS, Math.max(1, warianty));

    const categoriesMsg = await message.channel.send({
      embeds: [infoEmbed("⏳ Pobieram listę zabiegów z arkusza...")],
    });
    let categories;
    try {
      categories = await listZabiegCategories(GOOGLE_SCRIPTS_SHEET_ID);
    } catch (err) {
      console.error("Error fetching zabieg categories:", err);
      return categoriesMsg.edit({
        embeds: [errorEmbed(`Nie udało się pobrać listy zabiegów z arkusza: ${err.message}`)],
      });
    }
    await categoriesMsg.delete().catch(() => {});

    let zabiegi = inline.zabiegi;
    if (zabiegi) {
      zabiegi = zabiegi.map((z) => {
        const known = categories.find((c) => c.toLowerCase() === z.toLowerCase());
        return known || z; // unknown value = a new, custom treatment name
      });
    } else {
      zabiegi = await askTreatments(message, categories);
      if (!zabiegi) return;
    }
    zabiegi = zabiegi.slice(0, MAX_TREATMENTS_PER_SCRIPT);

    let briefLinksRaw = inline.brief;
    if (!briefLinksRaw) {
      briefLinksRaw = await askText(
        message,
        `Podaj link(i) do briefu (Google Doc) dla: ${zabiegi.join(", ")}.\n` +
          `Jeśli brief jest wspólny, wklej jeden link. Jeśli osobne, wklej po przecinku w tej samej kolejności co zabiegi.`
      );
      if (!briefLinksRaw) return;
    }
    const briefLinks = briefLinksRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (briefLinks.length === 0) {
      return message.channel.send({ embeds: [errorEmbed("Nie podano żadnego linku do briefu.")] });
    }

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#FFA500")
          .setTitle("📝 Podsumowanie")
          .addFields(
            { name: "Klient", value: klient },
            { name: "Zabiegi", value: zabiegi.join(", ") },
            { name: "Liczba wariantów", value: String(warianty) },
            { name: "Brief", value: briefLinks.join("\n") }
          ),
      ],
    });

    const processingMsg = await message.channel.send({
      embeds: [infoEmbed("⏳ Przetwarzanie: pobieram szablon, brief i przykład...")],
    });

    let template;
    try {
      template = await getScriptTemplate();
    } catch (err) {
      console.error("Error fetching script template:", err);
      return processingMsg.edit({ embeds: [errorEmbed(`Nie udało się pobrać szablonu skryptów: ${err.message}`)] });
    }

    const docTextCache = new Map();
    async function fetchDocTextCached(url) {
      const docId = extractGoogleDocId(url);
      if (!docId) throw new Error(`Nieprawidłowy link do dokumentu: ${url}`);
      if (docTextCache.has(docId)) return docTextCache.get(docId);
      const text = await fetchDocPlainText(docId);
      docTextCache.set(docId, text);
      return text;
    }

    let briefsText;
    try {
      const briefTexts = await Promise.all(
        zabiegi.map(async (zabieg, i) => {
          const link = briefLinks[i] || briefLinks[0];
          const text = await fetchDocTextCached(link);
          return `Zabieg: ${zabieg}\nBrief:\n${text}`;
        })
      );
      briefsText = briefTexts.join("\n\n---\n\n");
    } catch (err) {
      console.error("Error fetching brief docs:", err);
      return processingMsg.edit({ embeds: [errorEmbed(`Nie udało się pobrać treści briefu: ${err.message}`)] });
    }

    let referenceScriptText = null;
    try {
      const refTexts = [];
      for (const zabieg of zabiegi) {
        const ref = await findReferenceScriptForZabieg(GOOGLE_SCRIPTS_SHEET_ID, zabieg);
        if (ref?.skryptLink && extractGoogleDocId(ref.skryptLink)) {
          const text = await fetchDocTextCached(ref.skryptLink);
          refTexts.push(`Zabieg: ${zabieg} (klient: ${ref.klient}):\n${text}`);
        }
      }
      referenceScriptText = refTexts.length ? refTexts.join("\n\n---\n\n") : null;
    } catch (err) {
      console.warn("Nie udało się pobrać przykładowego skryptu referencyjnego:", err);
    }

    const variants = [];
    const previousVariantSummaries = [];

    for (let i = 1; i <= warianty; i++) {
      await processingMsg.edit({ embeds: [infoEmbed(`⏳ Generuję wariant ${i}/${warianty}...`)] });

      try {
        const variant = await generateScriptVariant({
          templateRulesText: template.rulesText,
          briefsText,
          referenceScriptText,
          zabiegi,
          klient,
          variantIndex: i,
          totalVariants: warianty,
          previousVariantSummaries,
        });
        variants.push(variant);
        previousVariantSummaries.push(`${variant.variantLabel} - hook: "${variant.rolka.hook}"`);
      } catch (err) {
        if (err instanceof ScriptGenerationError) {
          await message.channel.send({
            embeds: [errorEmbed(`Wariant ${i}: ${err.message}\n\nSzczegóły: ${err.details}`)],
          });
          continue;
        }
        throw err;
      }
    }

    if (variants.length === 0) {
      return processingMsg.edit({ embeds: [errorEmbed("Nie udało się wygenerować żadnego wariantu skryptu.")] });
    }

    // All variants from this one request go into a single doc/sheet row, not
    // one per variant, so one !skrypt call always yields exactly one link.
    const docTitle = `${klient} - ${zabiegi.join(" + ")} - skrypty i wskazówki | ITM`;
    let docUrl;
    try {
      const { text, spans } = buildScriptDocContent(docTitle, variants, template.recordingInstructionsText);
      const docId = await createFormattedScriptDoc(docTitle, text, spans);
      await moveDocToFolder(docId, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID);
      docUrl = `https://docs.google.com/document/d/${docId}/edit`;

      await appendScriptRow(GOOGLE_SCRIPTS_SHEET_ID, {
        czyj: message.member?.displayName || message.author.username,
        klient,
        briefLink: briefLinks[0],
        skryptLink: docUrl,
        zabieg: zabiegi.join(" + "),
      });
    } catch (err) {
      console.error("Error creating script doc:", err);
      return processingMsg.edit({
        embeds: [errorEmbed(`Skrypty wygenerowane, ale nie udało się zapisać dokumentu/arkusza: ${err.message}`)],
      });
    }

    await processingMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#00FF00")
          .setTitle("🎊 Skrypty gotowe")
          .setDescription(
            `[${docTitle}](${docUrl})\n\n(${variants.length}/${warianty} wariantów w jednym dokumencie)` +
              `\n\n📊 [Zobacz w arkuszu](${SHEET_URL})`
          ),
      ],
    });

    await askForFeedback(message, docUrl);
  } catch (error) {
    console.error("Error processing skrypt command:", error);
    try {
      await message.channel.send({ embeds: [errorEmbed(`Wystąpił błąd: ${error.message}`)] });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}
