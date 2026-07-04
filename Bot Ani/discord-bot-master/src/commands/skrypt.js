import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from "discord.js";
import { GOOGLE_SCRIPTS_SHEET_ID, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID } from "../config.js";
import {
  listZabiegCategories,
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

const SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SCRIPTS_SHEET_ID}/edit`;
const MAX_TREATMENTS_PER_SCRIPT = 2;
const MAX_VARIANTS = 3;
const DEFAULT_VARIANTS = 2;
const PROMPT_TIMEOUT_MS = 60000;

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
      time: PROMPT_TIMEOUT_MS,
      errors: ["time"],
    });
    return collected.first().content.trim();
  } catch {
    await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!skrypt`.")] });
    return null;
  }
}

/**
 * Asks the user to pick 1-2 treatments. Uses a native multi-select dropdown
 * when the live category list from the sheet fits Discord's 25-option limit;
 * otherwise falls back to a paginated numbered list (same style as the
 * existing handleBoardSelection() pattern in utils/helpers.js).
 */
async function askTreatments(message, categories) {
  const maxValues = Math.min(MAX_TREATMENTS_PER_SCRIPT, categories.length);

  if (categories.length <= 25) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`skrypt_zabieg_select_${Date.now()}`)
      .setPlaceholder(`Wybierz 1-${maxValues} zabiegi`)
      .setMinValues(1)
      .setMaxValues(maxValues)
      .addOptions(categories.map((c) => ({ label: c.slice(0, 100), value: c })));

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const selectMessage = await message.channel.send({
      content: `📋 Wybierz zabieg (maks. ${MAX_TREATMENTS_PER_SCRIPT}):`,
      components: [row],
    });

    const filter = (interaction) =>
      interaction.customId === selectMenu.data.custom_id && interaction.user.id === message.author.id;

    try {
      const interaction = await selectMessage.awaitMessageComponent({ filter, time: PROMPT_TIMEOUT_MS });
      await interaction.update({
        content: `✅ Wybrane zabiegi: ${interaction.values.join(", ")}`,
        components: [],
      });
      return interaction.values;
    } catch {
      await selectMessage.edit({ content: "⌛ Czas minął, nie wybrano zabiegu.", components: [] });
      return null;
    }
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
          `Wybierz zabieg (numer, max ${MAX_TREATMENTS_PER_SCRIPT} po przecinku)${
            hasMore ? ' lub napisz "więcej"' : ""
          }:\n\n${listText}`
        ),
      ],
    });

    const filter = (m) => m.author.id === message.author.id;
    let collected;
    try {
      collected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: PROMPT_TIMEOUT_MS,
        errors: ["time"],
      });
    } catch {
      await message.channel.send({ embeds: [errorEmbed("Czas minął. Zacznij od nowa: `!skrypt`.")] });
      return null;
    }

    const content = collected.first().content.trim().toLowerCase();
    if (hasMore && (content === "więcej" || content === "wiecej")) {
      page++;
      continue;
    }

    const nums = content
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n > 0 && n <= categories.length);

    if (nums.length === 0 || nums.length > MAX_TREATMENTS_PER_SCRIPT) {
      await message.channel.send({
        embeds: [errorEmbed(`Podaj 1-${MAX_TREATMENTS_PER_SCRIPT} poprawne numery, oddzielone przecinkiem.`)],
      });
      continue;
    }

    return nums.map((n) => categories[n - 1]);
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
      klient = await askText(message, "Podaj nazwę klienta:");
      if (!klient) return;
    }

    let warianty = inline.warianty ? parseInt(inline.warianty, 10) : NaN;
    if (Number.isNaN(warianty)) {
      const answer = await askText(
        message,
        `Ile wariantów skryptu wygenerować? (1-${MAX_VARIANTS}, domyślnie ${DEFAULT_VARIANTS}. Wpisz liczbę lub "pomiń").`
      );
      if (answer === null) return;
      const parsedNum = parseInt(answer, 10);
      warianty = Number.isNaN(parsedNum) ? DEFAULT_VARIANTS : parsedNum;
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

    if (categories.length === 0) {
      return message.channel.send({
        embeds: [errorEmbed("Arkusz skryptów nie zawiera jeszcze żadnej kategorii zabiegu.")],
      });
    }

    let zabiegi = inline.zabiegi;
    if (zabiegi) {
      zabiegi = zabiegi
        .map((z) => categories.find((c) => c.toLowerCase() === z.toLowerCase()))
        .filter(Boolean);
      if (zabiegi.length === 0) {
        return message.channel.send({
          embeds: [errorEmbed("Podane zabiegi nie pasują do żadnej kategorii w arkuszu.")],
        });
      }
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

    const createdDocs = [];
    const previousVariantSummaries = [];

    for (let i = 1; i <= warianty; i++) {
      await processingMsg.edit({ embeds: [infoEmbed(`⏳ Generuję wariant ${i}/${warianty}...`)] });

      let variant;
      try {
        variant = await generateScriptVariant({
          templateRulesText: template.rulesText,
          briefsText,
          referenceScriptText,
          zabiegi,
          klient,
          variantIndex: i,
          totalVariants: warianty,
          previousVariantSummaries,
        });
      } catch (err) {
        if (err instanceof ScriptGenerationError) {
          await message.channel.send({
            embeds: [errorEmbed(`Wariant ${i}: ${err.message}\n\nSzczegóły: ${err.details}`)],
          });
          continue;
        }
        throw err;
      }

      previousVariantSummaries.push(`${variant.variantLabel} - hook: "${variant.rolka.hook}"`);

      const docTitle = `${klient} - ${zabiegi.join(" + ")} - skrypty i wskazówki | ITM${
        warianty > 1 ? ` (Wariant ${i} z ${warianty})` : ""
      }`;

      try {
        const { text, spans } = buildScriptDocContent(docTitle, variant, template.recordingInstructionsText);
        const docId = await createFormattedScriptDoc(docTitle, text, spans);
        await moveDocToFolder(docId, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID);
        const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

        await appendScriptRow(GOOGLE_SCRIPTS_SHEET_ID, {
          czyj: message.member?.displayName || message.author.username,
          klient,
          briefLink: briefLinks[0],
          skryptLink: docUrl,
          zabieg: zabiegi.join(" + "),
        });

        createdDocs.push({ title: docTitle, url: docUrl });
      } catch (err) {
        console.error(`Error creating doc for variant ${i}:`, err);
        await message.channel.send({
          embeds: [
            errorEmbed(
              `Wariant ${i}: skrypt wygenerowany, ale nie udało się zapisać dokumentu/arkusza: ${err.message}`
            ),
          ],
        });
      }
    }

    if (createdDocs.length === 0) {
      return processingMsg.edit({ embeds: [errorEmbed("Nie udało się utworzyć żadnego skryptu.")] });
    }

    await processingMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#00FF00")
          .setTitle("🎊 Skrypty gotowe")
          .setDescription(
            createdDocs.map((d, i) => `**${i + 1}.** [${d.title}](${d.url})`).join("\n") +
              `\n\n📊 [Zobacz w arkuszu](${SHEET_URL})`
          ),
      ],
    });
  } catch (error) {
    console.error("Error processing skrypt command:", error);
    try {
      await message.channel.send({ embeds: [errorEmbed(`Wystąpił błąd: ${error.message}`)] });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}
