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
  normalizeName,
} from "../utils/trello.js";
import { getAllUserMappings } from "../utils/database.js";
import { DISCOVERY_CHANNEL_ID } from "../config.js";
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
// Listy skanowane w !discovery. Dopasowanie ignoruje wielkość liter i
// polskie znaki diakrytyczne (patrz isListMatch), więc realne nazwy list
// w Trello mogą mieć polskie znaki ("Oferta do wysłania" itd.).
const TARGET_LIST_NAMES = [
  "oferta do wyslania",
  "ponowny kontakt",
  "oferta wyslana",
  "fv poszla",
];
const DAYS_AHEAD = 3;
const SELECT_TIMEOUT_MS = 60000;
// Osoby skanowane przez codzienny, zaplanowany !discovery (patrz runScheduledDiscovery).
export const SCHEDULED_TARGET_NAMES = ["Agnieszka", "Szymon"];

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

  const [lists, members] = await Promise.all([
    fetchTrelloLists(board.id),
    fetchBoardMembers(board.id),
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
  };
}

/**
 * Skanuje dopasowane listy pod kątem otwartych kart przypisanych do
 * memberId, z terminem przeterminowanym lub w ciągu DAYS_AHEAD dni.
 */
async function scanMemberCards(matchedLists, memberId) {
  const now = dayjs().tz("Europe/Warsaw");
  const deadline = now.add(DAYS_AHEAD, "day").endOf("day");

  const listResults = [];
  for (const list of matchedLists) {
    const cards = await fetchListCards(list.id);
    const memberCards = cards
      .filter(
        (card) =>
          card.idMembers?.includes(memberId) && isDueInScope(card, deadline)
      )
      .sort((a, b) => new Date(a.due) - new Date(b.due));

    listResults.push({ listName: list.name, cards: memberCards });
  }

  return { listResults, now };
}

/**
 * Buduje embedy Discorda (główny + po jednym na listę) z wyników scanMemberCards.
 */
function buildDiscoveryEmbeds({
  memberLabel,
  boardName,
  matchedLists,
  listResults,
  now,
}) {
  const totalCards = listResults.reduce((sum, r) => sum + r.cards.length, 0);

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

    const { listResults, now } = await scanMemberCards(
      resolved.matchedLists,
      selectedMember.id
    );

    const embeds = buildDiscoveryEmbeds({
      memberLabel,
      boardName: resolved.boardName,
      matchedLists: resolved.matchedLists,
      listResults,
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
 * Codzienny, zaplanowany odpowiednik !discovery (patrz cron w src/index.js).
 * Skanuje CRM dla SCHEDULED_TARGET_NAMES i publikuje wynik na
 * DISCOVERY_CHANNEL_ID, oznaczając każdą osobę (jeśli ma !connect).
 */
export async function runScheduledDiscovery(client) {
  if (!DISCOVERY_CHANNEL_ID) {
    console.error(
      "🚨 Zaplanowany !discovery pominięty: brak DISCOVERY_CHANNEL_ID w konfiguracji."
    );
    return;
  }

  const channel = await client.channels.fetch(DISCOVERY_CHANNEL_ID).catch((err) => {
    console.error("🚨 Nie udało się pobrać kanału dla zaplanowanego !discovery:", err);
    return null;
  });
  if (!channel) return;

  let resolved;
  try {
    resolved = await resolveCrmBoard();
  } catch (err) {
    console.error("🚨 Zaplanowany !discovery: błąd wczytywania board'a:", err);
    await channel.send({ embeds: [errorEmbed(err.message)] }).catch(() => {});
    return;
  }

  const todayLabel = dayjs().tz("Europe/Warsaw").format("DD.MM.YYYY");

  for (const targetName of SCHEDULED_TARGET_NAMES) {
    try {
      const normalizedTarget = normalizeName(targetName);
      const member = resolved.members.find((m) =>
        normalizeName(m.fullName || m.username || "").includes(normalizedTarget)
      );

      if (!member) {
        await channel.send({
          embeds: [
            errorEmbed(
              `Nie znalazłem "${targetName}" wśród członków board'a ${resolved.boardName}.`
            ),
          ],
        });
        continue;
      }

      const { listResults, now } = await scanMemberCards(
        resolved.matchedLists,
        member.id
      );
      const embeds = buildDiscoveryEmbeds({
        memberLabel: member.fullName || member.username,
        boardName: resolved.boardName,
        matchedLists: resolved.matchedLists,
        listResults,
        now,
      });

      const mentionPrefix = await resolveMentionPrefix(channel.guild, member);
      await channel.send({
        content: `${mentionPrefix} — poranny przegląd CRM (${todayLabel})`,
        embeds: [embeds[0]],
      });
      for (let i = 1; i < embeds.length; i++) {
        await channel.send({ embeds: [embeds[i]] });
      }
    } catch (err) {
      console.error(`🚨 Zaplanowany !discovery: błąd dla "${targetName}":`, err);
      await channel
        .send({
          embeds: [
            errorEmbed(
              `Błąd podczas przetwarzania "${targetName}": \`${err.message}\``
            ),
          ],
        })
        .catch(() => {});
    }
  }
}
