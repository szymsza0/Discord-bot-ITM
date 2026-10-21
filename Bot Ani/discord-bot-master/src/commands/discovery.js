// src/commands/discovery.js
import {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
} from "discord.js";
import {
  fetchTrelloBoardDetails,
  fetchTrelloLists,
  fetchBoardMembers,
  fetchListCards,
  fetchBoardActions,
  trelloGetStrict,
  normalizeName,
  LIST_CARD_FIELDS,
} from "../utils/trello.js";
import { getAllUserMappings } from "../utils/database.js";
import { DISCOVERY_CHANNEL_ID } from "../config.js";
import {
  TZ,
  GRADED_ROLES,
  classifyNiche,
  listRole,
  isWeekend,
  prepareEntries,
  assembleDigest,
  buildDigestMessage,
  peopleToMention,
} from "../utils/crmDigest.js";
import { gradeEntries } from "../utils/leadGrader.js";
import dayjs from "dayjs";
import "dayjs/locale/pl.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("pl");
dayjs.tz.setDefault("Europe/Warsaw");

// https://trello.com/b/DfUfi8d6/itm-crm - board resolved by shortLink instead
// of by name search, since Trello lets a shortLink stand in for a board ID.
const CRM_BOARD_SHORT_LINK = "DfUfi8d6";
// [[ C-Level ]] Projekty - tu trafiają sprzedane karty (sprawdzamy, czy
// każdy "Won" ma tu swoją kartę). ID z apps_script_leady_trello.js.
const PROJEKTY_BOARD_ID = "677acb7a9e55538cd27e7b85";
// Listy skanowane w !discovery. Dopasowanie ignoruje wielkość liter i
// polskie znaki diakrytyczne (patrz isListMatch), więc realne nazwy list
// w Trello mogą mieć polskie znaki ("Spotkanie umówione" itd.).
const TARGET_LIST_NAMES = [
  "leady z ads",
  "spotkanie umowione",
  "oferta wyslana",
  "fv poszla",
  "ponowny kontakt",
];
// Historia komentarzy i przeniesień brana do porannego przeglądu.
const ACTIONS_HISTORY_DAYS = 120;
// Setter (umawia spotkania z "Leady z ADS") - wzmianka, gdy są nowe leady.
const SETTER_NAME = "Marlena";
const DAYS_AHEAD = 3;
const SELECT_TIMEOUT_MS = 60000;

// Leady fachowców nie trafiają ani do porannego przeglądu, ani do ręcznego
// !discovery - reguła rozpoznania niszy jest w utils/crmDigest.js (classifyNiche).
function isCardNotifyExcluded(card, labelNamesById) {
  return classifyNiche(card, labelNamesById).niche !== "beauty";
}

function errorEmbed(desc) {
  return new EmbedBuilder().setColor("#FF0000").setDescription(`❌ ${desc}`);
}
function infoEmbed(desc) {
  return new EmbedBuilder().setColor("#0079BF").setDescription(desc);
}

function isListMatch(listName, targetName) {
  const a = normalizeName(listName);
  const b = normalizeName(targetName);
  return a === b || a.includes(b) || b.includes(a);
}

// "Otwarta i do zrobienia": karta nie ma odhaczonego terminu (dueComplete)
// i jej due jest przed granicą (przeterminowane lub w ciągu DAYS_AHEAD dni).
function isDueInScope(card, deadline) {
  if (!card.due || card.dueComplete) return false;
  return dayjs(card.due).isBefore(deadline);
}

/**
 * Wczytuje board ITM CRM, jego listy (dopasowane do TARGET_LIST_NAMES) i
 * członków. Wspólne dla trybu interaktywnego (!discovery) i zaplanowanego
 * (runScheduledDiscovery), więc obie ścieżki patrzą na te same dane.
 */
async function resolveCrmBoard() {
  const board = await fetchTrelloBoardDetails(CRM_BOARD_SHORT_LINK);
  if (!board || !board.id) {
    throw new Error(
      `Nie udało się wczytać board'a ITM CRM (trello.com/b/${CRM_BOARD_SHORT_LINK}).`
    );
  }

  const [lists, members, labels] = await Promise.all([
    fetchTrelloLists(board.id),
    fetchBoardMembers(board.id),
    trelloGetStrict(`boards/${board.id}/labels`, { fields: "name", limit: 1000 }).catch((err) => {
      console.error("🚨 Nie udało się pobrać etykiet CRM:", err.message);
      return null;
    }),
  ]);

  if (!lists || lists.length === 0) {
    throw new Error("Nie znaleziono list na board'zie CRM.");
  }
  if (!members || members.length === 0) {
    throw new Error("Nie udało się pobrać członków board'a CRM.");
  }

  const matchedLists = TARGET_LIST_NAMES.map((targetName) =>
    lists.find((l) => isListMatch(l.name, targetName))
  ).filter(Boolean);

  if (matchedLists.length === 0) {
    throw new Error(
      `Nie znalazłem żadnej z list: ${TARGET_LIST_NAMES.join(", ")}.`
    );
  }

  return {
    boardName: board.name || "ITM CRM",
    matchedLists,
    members,
    labelNamesById: Object.fromEntries((labels || []).map((l) => [l.id, l.name])),
    labelsFailed: labels === null,
  };
}

/**
 * Skanuje dopasowane listy pod kątem otwartych kart przypisanych do
 * memberId, z terminem przeterminowanym lub w ciągu DAYS_AHEAD dni.
 * Listy, których nie udało się pobrać, trafiają do failedLists (zamiast
 * po cichu udawać pustą listę).
 */
async function scanMemberCards(matchedLists, memberId, labelNamesById = {}) {
  const now = dayjs().tz("Europe/Warsaw");
  const deadline = now.add(DAYS_AHEAD, "day").endOf("day");

  const listResults = [];
  const failedLists = [];
  for (const list of matchedLists) {
    let cards;
    try {
      cards = await fetchListCards(list.id, { throwOnError: true, fields: `${LIST_CARD_FIELDS},desc` });
    } catch {
      failedLists.push(list.name);
      continue;
    }
    const memberCards = cards
      .filter(
        (card) =>
          card.idMembers?.includes(memberId) &&
          isDueInScope(card, deadline) &&
          !isCardNotifyExcluded(card, labelNamesById)
      )
      .sort((a, b) => new Date(a.due) - new Date(b.due));

    listResults.push({ listName: list.name, cards: memberCards });
  }

  return { listResults, failedLists, now };
}

/**
 * Buduje embedy Discorda (główny + po jednym na listę) z wyników scanMemberCards.
 */
function buildDiscoveryEmbeds({
  memberLabel,
  boardName,
  matchedLists,
  listResults,
  failedLists = [],
  now,
}) {
  const totalCards = listResults.reduce((sum, r) => sum + r.cards.length, 0);
  const incompleteNote = failedLists.length
    ? `⚠️ **Dane niepełne** - nie udało się pobrać list: ${failedLists.join(", ")}.\n`
    : "";

  if (totalCards === 0 && failedLists.length) {
    return [
      new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("⚠️ Dane niepełne")
        .setDescription(
          `${incompleteNote}W pozostałych listach brak kart przeterminowanych lub z terminem w ciągu ${DAYS_AHEAD} dni dla **${memberLabel}**.`
        ),
    ];
  }

  if (totalCards === 0) {
    return [
      new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("📭 Brak wyników")
        .setDescription(
          `Brak kart przeterminowanych lub z terminem w ciągu ${DAYS_AHEAD} dni dla **${memberLabel}**\n` +
            `w listach: ${matchedLists.map((l) => l.name).join(", ")}.`
        ),
    ];
  }

  const embeds = [];

  embeds.push(
    new EmbedBuilder()
      .setColor("#0079BF")
      .setTitle(`🔎 Discovery - ${memberLabel}`)
      .setDescription(
        incompleteNote +
          `**Board:** ${boardName}\n` +
          `**Kryteria:** przeterminowane lub do zrobienia w ciągu ${DAYS_AHEAD} dni\n` +
          `**Listy:** ${matchedLists.map((l) => l.name).join(", ")}\n` +
          `**Łącznie kart:** ${totalCards}`
      )
      .setTimestamp()
  );

  for (const { listName, cards } of listResults) {
    if (cards.length === 0) continue;

    let current = new EmbedBuilder()
      .setColor("#4CAF50")
      .setTitle(`📋 ${listName} (${cards.length})`);

    cards.forEach((card, index) => {
      if (index % 25 === 0 && index !== 0) {
        embeds.push(current);
        current = new EmbedBuilder()
          .setColor("#4CAF50")
          .setTitle(`📋 ${listName} - c.d.`);
      }

      const due = dayjs(card.due).tz("Europe/Warsaw");
      const overdue = due.isBefore(now);
      const dueText = due.format("DD.MM.YYYY, HH:mm");

      current.addFields({
        name: `📎 ${card.name}`,
        value:
          `${overdue ? "🔴 **Przeterminowane:**" : "🟡 **Termin:**"} ${dueText}\n` +
          `[🔗 Zobacz w Trello](${card.url})`,
      });
    });

    if (current.data.fields?.length) embeds.push(current);
  }

  return embeds;
}

/**
 * Pojedynczy select menu do wyboru osoby (członka board'a CRM).
 */
async function askMember(message, members) {
  const limited = members.slice(0, 25);
  const options = limited.map((m) => ({
    label: (m.fullName || m.username || "Nieznany użytkownik").slice(0, 100),
    description: m.username ? `@${m.username}`.slice(0, 100) : undefined,
    value: m.id,
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`discovery_member_${Date.now()}`)
    .setPlaceholder("Wybierz osobę")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const selectMessage = await message.reply({
    content: "👤 Dla kogo sprawdzić karty w CRM?",
    components: [row],
  });

  const filter = (interaction) =>
    interaction.customId === selectMenu.data.custom_id &&
    interaction.user.id === message.author.id;

  try {
    const interaction = await selectMessage.awaitMessageComponent({
      filter,
      time: SELECT_TIMEOUT_MS,
    });
    const selectedMember = limited.find((m) => m.id === interaction.values[0]);
    await interaction.update({
      content: `✅ Wybrano: ${selectedMember?.fullName || selectedMember?.username}`,
      components: [],
    });
    return selectedMember || null;
  } catch {
    await selectMessage
      .edit({ content: "⌛ Czas minął, nie wybrano osoby.", components: [] })
      .catch(() => {});
    return null;
  }
}

export async function processDiscoveryCommand(message) {
  try {
    const processingMsg = await message.reply({
      embeds: [infoEmbed("⏳ Wczytuję board ITM CRM...")],
    });

    let resolved;
    try {
      resolved = await resolveCrmBoard();
    } catch (err) {
      return processingMsg.edit({ embeds: [errorEmbed(err.message)] });
    }

    await processingMsg.delete().catch(() => {});

    const selectedMember = await askMember(message, resolved.members);
    if (!selectedMember) return;

    const memberLabel = selectedMember.fullName || selectedMember.username;

    const workingMsg = await message.channel.send({
      embeds: [infoEmbed(`⏳ Skanuję karty dla **${memberLabel}**...`)],
    });

    const { listResults, failedLists, now } = await scanMemberCards(
      resolved.matchedLists,
      selectedMember.id,
      resolved.labelNamesById
    );

    const embeds = buildDiscoveryEmbeds({
      memberLabel,
      boardName: resolved.boardName,
      matchedLists: resolved.matchedLists,
      listResults,
      failedLists: resolved.labelsFailed ? [...failedLists, "etykiety (filtr fachowców)"] : failedLists,
      now,
    });

    await workingMsg.edit({ embeds: [embeds[0]] });
    for (let i = 1; i < embeds.length; i++) {
      await message.channel.send({ embeds: [embeds[i]] });
    }
  } catch (error) {
    console.error("🚨 Błąd w processDiscoveryCommand:", error);
    await message.channel
      .send({
        embeds: [
          errorEmbed(`Wystąpił błąd podczas discovery: \`${error.message}\``),
        ],
      })
      .catch(() => {});
  }
}

/**
 * Próbuje zamienić członka Trello na wzmiankę Discorda, korzystając z
 * mapowania zapisanego przez !connect (discord_username → trello_username).
 * Jeśli mapowania brak albo nie uda się znaleźć osoby na serwerze, zwraca
 * samo pogrubione imię - bez wzmianki, ale bez wywalania całego runu.
 */
async function resolveMentionPrefix(guild, trelloMember) {
  const fallback = `**${trelloMember.fullName || trelloMember.username}**`;
  try {
    const mappings = await getAllUserMappings();
    const discordUsername = Object.entries(mappings).find(
      ([, trelloUsername]) =>
        trelloUsername.toLowerCase() === trelloMember.username.toLowerCase()
    )?.[0];

    if (!discordUsername || !guild) return fallback;

    const found = await guild.members.fetch({ query: discordUsername, limit: 5 });
    const match = found.find(
      (m) => m.user.username.toLowerCase() === discordUsername.toLowerCase()
    );
    return match ? `<@${match.id}>` : fallback;
  } catch (err) {
    console.warn(
      `⚠️ Nie udało się rozwiązać wzmianki Discorda dla "${trelloMember.username}":`,
      err.message
    );
    return fallback;
  }
}

/**
 * Pobiera wszystko, czego potrzebuje poranny przegląd: listy, etykiety,
 * członków i karty CRM, komentarze/przeniesienia z ostatnich
 * ACTIONS_HISTORY_DAYS dni oraz karty tablicy Projekty. Błąd pojedynczego
 * zapytania nie przerywa przeglądu - trafia do snapshot.errors i w
 * wiadomości pojawia się "⚠️ Dane niepełne". Rzuca tylko, gdy nie ma z czego
 * zbudować przeglądu (board albo listy).
 */
export async function loadCrmSnapshot(now = dayjs()) {
  const board = await fetchTrelloBoardDetails(CRM_BOARD_SHORT_LINK);
  if (!board || !board.id) {
    throw new Error(
      `Nie udało się wczytać board'a ITM CRM (trello.com/b/${CRM_BOARD_SHORT_LINK}).`
    );
  }

  const errors = [];
  const attempt = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`🚨 Przegląd CRM: nie udało się pobrać "${label}":`, err.message);
      errors.push(label);
      return fallback;
    }
  };

  const lists = await trelloGetStrict(`boards/${board.id}/lists`, { fields: "name,closed" });
  const crmLists = lists.filter((l) => !l.closed && listRole(l.name));
  const since = dayjs(now).subtract(ACTIONS_HISTORY_DAYS, "day").toISOString();

  const [labels, members, actions, projektyCards, ...cardsPerList] = await Promise.all([
    attempt("etykiety (filtr fachowców)", () => trelloGetStrict(`boards/${board.id}/labels`, { fields: "name", limit: 1000 }), []),
    attempt("członkowie tablicy", () => trelloGetStrict(`boards/${board.id}/members`, { fields: "fullName,username" }), []),
    attempt("komentarze i historia kart", () => fetchBoardActions(board.id, { filter: "commentCard,updateCard:idList", since }), []),
    attempt("tablica [[ C-Level ]] Projekty", () => trelloGetStrict(`boards/${PROJEKTY_BOARD_ID}/cards/all`, { fields: "name,desc,closed" }), null),
    ...crmLists.map((list) =>
      attempt(`lista „${list.name}”`, () => fetchListCards(list.id, { throwOnError: true, fields: `${LIST_CARD_FIELDS},desc` }), [])
    ),
  ]);

  return {
    boardName: board.name || "ITM CRM",
    lists,
    labels,
    members,
    actions,
    projektyCards,
    cards: cardsPerList.flat(),
    historySince: since,
    errors,
  };
}

/**
 * Buduje poranny przegląd CRM (bez wysyłania): pobranie danych, pominięcie
 * fachowców, ocena temperatury (Claude Haiku + reguły) i złożenie sekcji.
 * Używane przez runScheduledDiscovery i skrypt podglądu
 * (src/tests/crm-digest-dry-run.js).
 * @param {object} [options]
 * @param {object} [options.snapshot] - gotowe dane zamiast pobierania z Trello
 * @param {boolean} [options.useAi=true] - false = tylko reguły, bez API Claude
 */
export async function buildCrmDigest({ now = dayjs().tz(TZ), snapshot = null, useAi = true } = {}) {
  const data = snapshot || (await loadCrmSnapshot(now));
  const { entries, excluded } = prepareEntries(data);
  const grades = await gradeEntries(
    entries.filter((e) => GRADED_ROLES.includes(e.role)),
    now,
    { useAi }
  );
  const digest = assembleDigest({
    entries,
    excluded,
    grades,
    errors: data.errors || [],
    projektyCards: data.projektyCards,
    now,
  });
  return { digest, entries, excluded, snapshot: data };
}

/**
 * Codzienny poranny przegląd CRM (patrz cron w src/index.js): JEDNA
 * wiadomość na DISCOVERY_CHANNEL_ID z leadami ITM Beauty pogrupowanymi wg
 * temperatury, spotkaniami na jutro i brakami w danych. W weekend i gdy nie
 * ma czego pokazać - nic nie wysyła.
 */
export async function runScheduledDiscovery(client) {
  const now = dayjs().tz(TZ);
  if (isWeekend(now)) return;

  if (!DISCOVERY_CHANNEL_ID) {
    console.error(
      "🚨 Poranny przegląd CRM pominięty: brak DISCOVERY_CHANNEL_ID w konfiguracji."
    );
    return;
  }

  const channel = await client.channels.fetch(DISCOVERY_CHANNEL_ID).catch((err) => {
    console.error("🚨 Nie udało się pobrać kanału dla porannego przeglądu CRM:", err);
    return null;
  });
  if (!channel) return;

  let result;
  try {
    result = await buildCrmDigest({ now });
  } catch (err) {
    console.error("🚨 Poranny przegląd CRM: błąd budowania przeglądu:", err);
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor("#FFA500")
            .setTitle("⚠️ Dane niepełne - przegląd CRM pominięty")
            .setDescription(`Nie udało się pobrać danych z Trello: \`${err.message}\``),
        ],
      })
      .catch(() => {});
    return;
  }

  const { digest, snapshot } = result;
  const members = snapshot.members || [];
  const setter = members.find((m) =>
    normalizeName(m.fullName || m.username || "").includes(normalizeName(SETTER_NAME))
  );
  const mentionIds = peopleToMention(digest, { setterId: setter?.id || null });
  const mentions = [];
  for (const id of mentionIds) {
    const member = members.find((m) => m.id === id);
    if (member) mentions.push(await resolveMentionPrefix(channel.guild, member));
  }

  const message = buildDigestMessage(digest, { mentions: mentions.join(" ") });
  if (!message) return;
  await channel.send(message);
}
