import {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { GOOGLE_SCRIPTS_SHEET_ID, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID, GOOGLE_SCRIPT_TEMPLATE_DOC_ID } from "../config.js";
import {
  listZabiegCategories,
  listKlienci,
  findReferenceScriptForZabieg,
  findClientHistory,
  appendScriptRow,
  findProblemAwareReferences,
  hasProblemAwareSeed,
} from "../utils/scriptSheet.js";
import { getScriptTemplate, FIXED_CTA_NOTE } from "../utils/scriptTemplate.js";
import {
  fetchDocPlainText,
  buildScriptDocContent,
  createFormattedScriptDoc,
  moveDocToFolder,
  googleErrorMessage,
} from "../utils/googleDocs.js";
import {
  generateScriptVariant,
  analyzeBriefCoverage,
  ScriptGenerationError,
  SCRIPT_TYPES,
} from "../utils/scriptGenerator.js";
import { canonicalZabieg, tagProblemAware } from "../utils/zabiegCategories.js";
import {
  PROBLEM_AWARE_REFERENCE_SCRIPT,
  PROBLEM_AWARE_SEED_KLIENT,
  PROBLEM_AWARE_SEED_ZABIEG,
} from "../utils/problemAwareTemplate.js";
import { integrateScriptFeedback } from "../utils/feedbackIntegrator.js";

const FEEDBACK_PROMPT_TIMEOUT_MS = 180000;

const SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SCRIPTS_SHEET_ID}/edit`;
const TEMPLATE_DOC_URL = `https://docs.google.com/document/d/${GOOGLE_SCRIPT_TEMPLATE_DOC_ID}/edit`;
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

/**
 * Distinguishes "link(s) to a brief doc" from "pasted treatment description +
 * USP" in the same free-text prompt: true only if every comma-separated part
 * is itself a URL. A pasted description containing commas (normal prose)
 * therefore always falls through to the free-text branch.
 */
function looksLikeLinkList(text) {
  const parts = (text || "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^https?:\/\//i.test(p));
}

function parseInlineArgs(content) {
  const result = { klient: null, warianty: null, zabiegi: null, brief: null, typ: null, grupa: null };
  if (!content) return result;

  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(klient|warianty|zabiegi?|brief(?:y)?|typ|grupa)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "klient") result.klient = value;
    else if (key === "warianty") result.warianty = value;
    else if (key.startsWith("zabieg"))
      result.zabiegi = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key.startsWith("brief")) result.brief = value;
    else if (key === "typ") result.typ = /problem/i.test(value) ? SCRIPT_TYPES.PROBLEM_AWARE : SCRIPT_TYPES.STANDARD;
    else if (key === "grupa") result.grupa = value;
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

const RETRY = "retry";
const NEW_INPUT = "new_input";
const CANCEL = "cancel";

/**
 * Shown after a failed step so the operator doesn't have to restart the whole
 * !skrypt conversation: retry the same step, (optionally) provide different
 * input for it, or cancel. Resolves to RETRY / NEW_INPUT / CANCEL; a timeout
 * counts as CANCEL.
 */
async function askRetry(message, errorText, { newInputLabel = null } = {}) {
  const stamp = Date.now();
  const buttons = [
    new ButtonBuilder().setCustomId(`skrypt_retry_${RETRY}_${stamp}`).setLabel("🔁 Spróbuj ponownie").setStyle(ButtonStyle.Primary),
  ];
  if (newInputLabel) {
    buttons.push(
      new ButtonBuilder().setCustomId(`skrypt_retry_${NEW_INPUT}_${stamp}`).setLabel(newInputLabel).setStyle(ButtonStyle.Secondary)
    );
  }
  buttons.push(
    new ButtonBuilder().setCustomId(`skrypt_retry_${CANCEL}_${stamp}`).setLabel("Anuluj").setStyle(ButtonStyle.Danger)
  );

  const promptMessage = await message.channel.send({
    embeds: [errorEmbed(errorText.slice(0, 3900))],
    components: [new ActionRowBuilder().addComponents(buttons)],
  });
  const filter = (interaction) =>
    interaction.user.id === message.author.id && interaction.customId.endsWith(`_${stamp}`);

  try {
    const interaction = await promptMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    const choice = [RETRY, NEW_INPUT, CANCEL].find((c) => interaction.customId.includes(`_${c}_`));
    await interaction.update({ components: [] });
    if (choice === CANCEL) await message.channel.send({ embeds: [infoEmbed("Anulowano. Zacznij od nowa: `!skrypt`.")] });
    return choice;
  } catch {
    await promptMessage.edit({ components: [] }).catch(() => {});
    await message.channel.send({ embeds: [infoEmbed("⌛ Czas minął. Zacznij od nowa: `!skrypt`.")] });
    return CANCEL;
  }
}

/**
 * Button row choosing the script pattern: the standard ITM script, or
 * "Problem aware" (5 hooks addressing location + age, built on the
 * problem-aware base pattern - see utils/problemAwareTemplate.js).
 */
async function askScriptType(message) {
  const stamp = Date.now();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`skrypt_typ_${SCRIPT_TYPES.STANDARD}_${stamp}`)
      .setLabel("Standardowy (domyślnie)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`skrypt_typ_${SCRIPT_TYPES.PROBLEM_AWARE}_${stamp}`)
      .setLabel("Problem aware (5 hooków)")
      .setStyle(ButtonStyle.Secondary)
  );

  const promptMessage = await message.channel.send({ content: "🧩 Jaki typ skryptu?", components: [row] });
  const filter = (interaction) =>
    interaction.user.id === message.author.id && interaction.customId.endsWith(`_${stamp}`);

  try {
    const interaction = await promptMessage.awaitMessageComponent({ filter, time: COMPONENT_TIMEOUT_MS });
    const type = interaction.customId.includes(SCRIPT_TYPES.PROBLEM_AWARE)
      ? SCRIPT_TYPES.PROBLEM_AWARE
      : SCRIPT_TYPES.STANDARD;
    await interaction.update({ content: `✅ Typ skryptu: ${scriptTypeLabel(type)}`, components: [] });
    return type;
  } catch {
    await promptMessage
      .edit({ content: "⌛ Czas minął — użyto skryptu standardowego.", components: [] })
      .catch(() => {});
    return SCRIPT_TYPES.STANDARD;
  }
}

function scriptTypeLabel(type) {
  return type === SCRIPT_TYPES.PROBLEM_AWARE ? "Problem aware" : "Standardowy";
}

/**
 * Makes sure the problem-aware base pattern is stored in the scripts sheet
 * (as its own doc + a "(problem aware)" row), so it sits in the same database
 * as every other script. Idempotent and best-effort: generation still works
 * from the embedded pattern if this fails.
 */
async function ensureProblemAwareSeed() {
  if (await hasProblemAwareSeed(GOOGLE_SCRIPTS_SHEET_ID)) return false;

  const zabieg = tagProblemAware(PROBLEM_AWARE_SEED_ZABIEG);
  const title = `${PROBLEM_AWARE_SEED_KLIENT} - ${zabieg} - skrypty i wskazówki | ITM`;
  const text = `${title}\n\n${PROBLEM_AWARE_REFERENCE_SCRIPT}\n`;
  const docId = await createFormattedScriptDoc(title, text, [{ start: 0, end: title.length, style: "HEADING_1" }]);
  await moveDocToFolder(docId, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID);
  await appendScriptRow(GOOGLE_SCRIPTS_SHEET_ID, {
    czyj: "Bot (wzór problem aware)",
    klient: PROBLEM_AWARE_SEED_KLIENT,
    briefLink: "-",
    skryptLink: `https://docs.google.com/document/d/${docId}/edit`,
    zabieg,
  });
  return true;
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
      .setDescription(
        `${result.entryText}\n\n📄 Zapisano w sekcji "Uwagi z feedbacku" w [dokumencie wytycznych](${TEMPLATE_DOC_URL}).`
      );

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
        let seedNote = "";
        try {
          if (await ensureProblemAwareSeed()) seedNote = "\n➕ Dodano wzór skryptu problem aware do bazy.";
        } catch (err) {
          seedNote = `\n⚠️ Nie udało się dodać wzoru problem aware do bazy: ${err.message}`;
        }
        return message.reply({
          embeds: [new EmbedBuilder().setColor("#00FF00").setDescription(`✅ Szablon skryptów odświeżony.${seedNote}`)],
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

    const scriptType = inline.typ || (await askScriptType(message));
    const isProblemAware = scriptType === SCRIPT_TYPES.PROBLEM_AWARE;

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
        const canonical = canonicalZabieg(z);
        const known = categories.find((c) => c.toLowerCase() === canonical.toLowerCase());
        return known || canonical; // unknown value = a new, custom treatment name
      });
    } else {
      zabiegi = await askTreatments(message, categories);
      if (!zabiegi) return;
    }
    zabiegi = zabiegi.slice(0, MAX_TREATMENTS_PER_SCRIPT);

    let grupaDocelowa = inline.grupa;
    if (isProblemAware && !grupaDocelowa) {
      grupaDocelowa = await askText(
        message,
        "🎯 Do kogo kierujemy hooki? Podaj miasto i przedział wieku, np. `kobiety 18-45, Wrocław`.\n" +
          "Napisz `auto`, żeby bot dobrał wiek i lokalizację z briefu."
      );
      if (grupaDocelowa === null) return;
    }
    if (grupaDocelowa && /^auto$/i.test(grupaDocelowa.trim())) grupaDocelowa = null;

    const templateMsg = await message.channel.send({
      embeds: [infoEmbed("⏳ Pobieram szablon skryptów...")],
    });
    let template;
    try {
      template = await getScriptTemplate();
    } catch (err) {
      console.error("Error fetching script template:", err);
      return templateMsg.edit({ embeds: [errorEmbed(`Nie udało się pobrać szablonu skryptów: ${err.message}`)] });
    }
    await templateMsg.delete().catch(() => {});

    const docTextCache = new Map();
    async function fetchDocTextCached(url) {
      const docId = extractGoogleDocId(url);
      if (!docId) throw new Error(`Nieprawidłowy link do dokumentu: ${url}`);
      if (docTextCache.has(docId)) return docTextCache.get(docId);
      const text = await fetchDocPlainText(docId);
      docTextCache.set(docId, text);
      return text;
    }

    let briefInputRaw = inline.brief;
    if (!briefInputRaw) {
      briefInputRaw = await askText(
        message,
        `Podaj link(i) do briefu (Google Doc) dla: ${zabiegi.join(", ")}.\n` +
          `Jeśli brief jest wspólny, wklej jeden link. Jeśli osobne, wklej po przecinku w tej samej kolejności co zabiegi.\n` +
          `Zamiast linku możesz też wkleić krótki opis zabiegu i USP (co wyróżnia ofertę) - bot dociągnie resztę sam.`
      );
      if (!briefInputRaw) return;
    }

    const briefIsLinks = looksLikeLinkList(briefInputRaw);
    const briefLinks = briefIsLinks ? briefInputRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (briefIsLinks && briefLinks.length === 0) {
      return message.channel.send({ embeds: [errorEmbed("Nie podano żadnego linku do briefu.")] });
    }

    // Built now for the free-text branch (needs interactive Q&A before the
    // summary is printed); left null for the link branch, where it's fetched
    // right after the summary instead (matches the old flow/ordering).
    let briefsText = null;

    if (!briefIsLinks) {
      let clientHistoryContext = null;
      try {
        const history = await findClientHistory(GOOGLE_SCRIPTS_SHEET_ID, klient);
        if (history.length) {
          const zabiegiList = [...new Set(history.map((h) => h.zabieg).filter(Boolean))];
          const parts = [
            `Klient "${klient}" ma już historię w bazie skryptów - wcześniejsze zabiegi: ${
              zabiegiList.join(", ") || "brak danych"
            }.`,
          ];
          for (const row of history.slice(-3)) {
            if (row.briefLink && extractGoogleDocId(row.briefLink)) {
              try {
                const text = await fetchDocTextCached(row.briefLink);
                parts.push(`--- Wcześniejszy brief tego klienta (zabieg: ${row.zabieg || "?"}) ---\n${text}`);
              } catch {
                // best-effort - one unreadable historical doc shouldn't block generation
              }
            }
            if (row.skryptLink && extractGoogleDocId(row.skryptLink)) {
              try {
                const text = await fetchDocTextCached(row.skryptLink);
                parts.push(
                  `--- Wcześniejszy skrypt tego klienta (zabieg: ${
                    row.zabieg || "?"
                  }) - zachowaj ten sam ton i styl marki, NIE kopiuj tresci ---\n${text}`
                );
              } catch {
                // best-effort - one unreadable historical doc shouldn't block generation
              }
            }
          }
          clientHistoryContext = parts.join("\n\n");
        }
      } catch (err) {
        console.warn("Nie udało się pobrać historii klienta z bazy:", err.message);
      }

      // Only ask about genuine gaps: check which brief questions the pasted
      // description and/or the client's history already answer, and skip
      // those. A failed/malformed analysis is non-fatal - it just falls back
      // to asking the full question bank, same as before this check existed.
      const questions = template.briefQuestions;
      let questionsToAsk = questions;
      const foundAnswers = [];
      try {
        const coverage = await analyzeBriefCoverage({
          questions,
          description: briefInputRaw,
          clientHistoryText: clientHistoryContext,
        });
        questionsToAsk = [];
        coverage.forEach((r, i) => {
          if (r.answered) {
            foundAnswers.push({ question: questions[i], answer: r.suggestedAnswer || "(brak cytatu)", source: r.source });
          } else {
            questionsToAsk.push(questions[i]);
          }
        });
      } catch (err) {
        console.warn("Nie udało się przeanalizować pokrycia briefu, dopytam o wszystko:", err.message);
      }

      if (foundAnswers.length) {
        const summary = foundAnswers
          .map(
            (f) =>
              `- ${f.question}\n  → ${f.answer} (źródło: ${f.source === "historia_klienta" ? "historia klienta" : "opis"})`
          )
          .join("\n");
        await message.channel.send({
          embeds: [infoEmbed(`🔎 Znalazłem odpowiedzi na część pytań automatycznie:\n${summary}`)],
        });
      }

      const sections = [`Opis zabiegu / USP (podany bezpośrednio, bez linku do briefu):\n${briefInputRaw}`];
      if (clientHistoryContext) sections.push(clientHistoryContext);
      if (foundAnswers.length) {
        sections.push(
          "Automatycznie ustalone odpowiedzi (z opisu operatora lub historii klienta):\n" +
            foundAnswers.map((f) => `${f.question}\n${f.answer}`).join("\n\n")
        );
      }

      if (questionsToAsk.length) {
        const numbered = questionsToAsk.map((q, i) => `${i + 1}. ${q}`).join("\n");
        const answers = await askText(
          message,
          `🆕 Potrzebuję jeszcze paru informacji dla klienta "${klient}". Odpowiedz w jednej wiadomości na poniższe pytania ` +
            `(pomiń te, które nie dotyczą - napisz "brak"):\n\n${numbered}`
        );
        if (!answers) return;
        sections.push(`Pytania briefowe (dopytane):\n${numbered}\n\nOdpowiedzi:\n${answers}`);
      }

      sections.push(FIXED_CTA_NOTE);

      briefsText = sections.join("\n\n---\n\n");
    }

    const briefSummaryForEmbed = briefIsLinks ? briefLinks.join("\n") : briefInputRaw;
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#FFA500")
          .setTitle("📝 Podsumowanie")
          .addFields(
            { name: "Klient", value: klient },
            { name: "Typ skryptu", value: scriptTypeLabel(scriptType) },
            ...(isProblemAware ? [{ name: "Grupa docelowa", value: grupaDocelowa || "auto (z briefu)" }] : []),
            { name: "Zabiegi", value: zabiegi.join(", ") },
            { name: "Liczba wariantów", value: String(warianty) },
            {
              name: briefIsLinks ? "Brief" : "Brief (opis, bez linku)",
              value: briefSummaryForEmbed.slice(0, 1000) || "-",
            }
          ),
      ],
    });

    let processingMsg = await message.channel.send({
      embeds: [infoEmbed("⏳ Przetwarzanie: pobieram brief i przykład...")],
    });

    let briefLinksToFetch = briefIsLinks ? briefLinks : [];
    while (briefsText === null) {
      try {
        const briefTexts = await Promise.all(
          zabiegi.map(async (zabieg, i) => {
            const link = briefLinksToFetch[i] || briefLinksToFetch[0];
            const text = await fetchDocTextCached(link);
            return `Zabieg: ${zabieg}\nBrief:\n${text}`;
          })
        );
        briefsText = briefTexts.join("\n\n---\n\n");
      } catch (err) {
        console.error("Error fetching brief docs:", err);
        await processingMsg.delete().catch(() => {});
        const choice = await askRetry(
          message,
          `Nie udało się pobrać treści briefu: ${googleErrorMessage(err)}\n\n` +
            "Sprawdź, czy bot ma dostęp do pliku, i spróbuj ponownie - albo podaj inny link / wklej opis zabiegu i USP.",
          { newInputLabel: "✏️ Inny link lub opis" }
        );
        if (choice === CANCEL) return;
        if (choice === NEW_INPUT) {
          const newInput = await askText(
            message,
            "Wklej nowy link(i) do briefu (po przecinku) albo opis zabiegu i USP:"
          );
          if (!newInput) return;
          if (looksLikeLinkList(newInput)) {
            briefLinksToFetch = newInput.split(",").map((x) => x.trim()).filter(Boolean);
          } else {
            briefsText = `Opis zabiegu / USP (podany bezpośrednio, bez linku do briefu):\n${newInput}\n\n---\n\n${FIXED_CTA_NOTE}`;
            briefLinksToFetch = [];
          }
        }
        processingMsg = await message.channel.send({ embeds: [infoEmbed("⏳ Ponawiam: pobieram brief...")] });
      }
    }

    let referenceScriptText = null;
    if (isProblemAware) {
      try {
        await ensureProblemAwareSeed();
      } catch (err) {
        console.warn("Nie udało się zapisać wzoru problem aware w bazie:", err.message);
      }
      try {
        const refs = await findProblemAwareReferences(GOOGLE_SCRIPTS_SHEET_ID, zabiegi);
        const refTexts = [];
        for (const ref of refs) {
          if (!extractGoogleDocId(ref.skryptLink)) continue;
          // The seeded base pattern is already embedded in the prompt verbatim.
          if (ref.klient === PROBLEM_AWARE_SEED_KLIENT) continue;
          const text = await fetchDocTextCached(ref.skryptLink);
          refTexts.push(`Zabieg: ${ref.zabieg} (klient: ${ref.klient}):\n${text}`);
        }
        referenceScriptText = refTexts.length ? refTexts.join("\n\n---\n\n") : null;
      } catch (err) {
        console.warn("Nie udało się pobrać skryptów problem aware z bazy:", err);
      }
    } else {
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
    }

    const variants = [];
    const previousVariantSummaries = [];

    // Re-entered only via the retry button below (when no variant came out).
    for (;;) {
      for (let i = variants.length + 1; i <= warianty; i++) {
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
            scriptType,
            grupaDocelowa,
          });
          variants.push(variant);
          const hooksSummary = variant.rolka.hooks
            ? `hooki: ${variant.rolka.hooks.map((h) => `"${h}"`).join(" | ")}`
            : `hook: "${variant.rolka.hook}"`;
          previousVariantSummaries.push(`${variant.variantLabel} - ${hooksSummary}`);
        } catch (err) {
          // Any failure (schema or API, e.g. overload) only skips this variant;
          // if none succeed, the operator gets a retry button below.
          console.error(`Error generating variant ${i}:`, err);
          const details = err instanceof ScriptGenerationError ? `\n\nSzczegóły: ${err.details}` : "";
          await message.channel.send({ embeds: [errorEmbed(`Wariant ${i}: ${err.message}${details}`)] });
        }
      }

      if (variants.length > 0) break;
      await processingMsg.delete().catch(() => {});
      const choice = await askRetry(message, "Nie udało się wygenerować żadnego wariantu skryptu.");
      if (choice !== RETRY) return;
      processingMsg = await message.channel.send({ embeds: [infoEmbed("⏳ Ponawiam generowanie...")] });
    }

    // All variants from this one request go into a single doc/sheet row, not
    // one per variant, so one !skrypt call always yields exactly one link.
    const zabiegLabel = isProblemAware ? tagProblemAware(zabiegi.join(" + ")) : zabiegi.join(" + ");
    const docTitle = `${klient} - ${zabiegLabel} - skrypty i wskazówki | ITM`;
    // Each save step is remembered, so a retry after e.g. a failed sheet
    // append doesn't create a second copy of the doc.
    let docId = null;
    let movedToFolder = false;
    let docUrl;
    for (;;) {
      try {
        if (!docId) {
          const { text, spans } = buildScriptDocContent(docTitle, variants, template.recordingInstructionsText);
          docId = await createFormattedScriptDoc(docTitle, text, spans);
        }
        docUrl = `https://docs.google.com/document/d/${docId}/edit`;
        if (!movedToFolder) {
          await moveDocToFolder(docId, GOOGLE_SCRIPTS_DRIVE_FOLDER_ID);
          movedToFolder = true;
        }

        await appendScriptRow(GOOGLE_SCRIPTS_SHEET_ID, {
          czyj: message.member?.displayName || message.author.username,
          klient,
          briefLink: briefLinksToFetch[0] || "Brief tekstowy (bez linku, opis + USP)",
          skryptLink: docUrl,
          zabieg: zabiegLabel,
        });
        break;
      } catch (err) {
        console.error("Error creating script doc:", err);
        await processingMsg.delete().catch(() => {});
        const choice = await askRetry(
          message,
          `Skrypty wygenerowane, ale nie udało się zapisać dokumentu/arkusza: ${googleErrorMessage(err)}` +
            (docId ? `\n\nDokument już istnieje: ${docUrl}` : "")
        );
        if (choice !== RETRY) return;
        processingMsg = await message.channel.send({ embeds: [infoEmbed("⏳ Ponawiam zapis...")] });
      }
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
