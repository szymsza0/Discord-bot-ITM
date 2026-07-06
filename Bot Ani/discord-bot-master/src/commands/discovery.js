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

    const board = await fetchTrelloBoardDetails(CRM_BOARD_SHORT_LINK);
    if (!board || !board.id) {
      return processingMsg.edit({
        embeds: [
          errorEmbed(
            `Nie udało się wczytać board'a ITM CRM (trello.com/b/${CRM_BOARD_SHORT_LINK}).`
          ),
        ],
      });
    }
    const boardId = board.id;
    const CRM_BOARD_NAME = board.name || "ITM CRM";

    const [lists, members] = await Promise.all([
      fetchTrelloLists(boardId),
      fetchBoardMembers(boardId),
    ]);

    if (!lists || lists.length === 0) {
      return processingMsg.edit({
        embeds: [errorEmbed("Nie znaleziono list na board'zie CRM.")],
      });
    }
    if (!members || members.length === 0) {
      return processingMsg.edit({
        embeds: [errorEmbed("Nie udało się pobrać członków board'a CRM.")],
      });
    }

    const matchedLists = TARGET_LIST_NAMES.map((targetName) =>
      lists.find((l) => isListMatch(l.name, targetName))
    ).filter(Boolean);

    if (matchedLists.length === 0) {
      return processingMsg.edit({
        embeds: [
          errorEmbed(
            `Nie znalazłem żadnej z list: ${TARGET_LIST_NAMES.join(", ")}.`
          ),
        ],
      });
    }

    await processingMsg.delete().catch(() => {});

    const selectedMember = await askMember(message, members);
    if (!selectedMember) return;

    const memberLabel = selectedMember.fullName || selectedMember.username;

    const workingMsg = await message.channel.send({
      embeds: [infoEmbed(`⏳ Skanuję karty dla **${memberLabel}**...`)],
    });

    const now = dayjs().tz("Europe/Warsaw");
    const deadline = now.add(DAYS_AHEAD, "day").endOf("day");

    const listResults = [];
    for (const list of matchedLists) {
      const cards = await fetchListCards(list.id);
      const memberCards = cards
        .filter(
          (card) =>
            card.idMembers?.includes(selectedMember.id) &&
            isDueInScope(card, deadline)
        )
        .sort((a, b) => new Date(a.due) - new Date(b.due));

      listResults.push({ listName: list.name, cards: memberCards });
    }

    const totalCards = listResults.reduce((sum, r) => sum + r.cards.length, 0);

    if (totalCards === 0) {
      return workingMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#FFA500")
            .setTitle("📭 Brak wyników")
            .setDescription(
              `Brak kart przeterminowanych lub z terminem w ciągu ${DAYS_AHEAD} dni dla **${memberLabel}**\n` +
                `w listach: ${matchedLists.map((l) => l.name).join(", ")}.`
            ),
        ],
      });
    }

    const mainEmbed = new EmbedBuilder()
      .setColor("#0079BF")
      .setTitle(`🔎 Discovery - ${memberLabel}`)
      .setDescription(
        `**Board:** ${CRM_BOARD_NAME}\n` +
          `**Kryteria:** przeterminowane lub do zrobienia w ciągu ${DAYS_AHEAD} dni\n` +
          `**Listy:** ${matchedLists.map((l) => l.name).join(", ")}\n` +
          `**Łącznie kart:** ${totalCards}`
      )
      .setTimestamp();

    await workingMsg.edit({ embeds: [mainEmbed] });

    for (const { listName, cards } of listResults) {
      if (cards.length === 0) continue;

      const chunks = [];
      let current = new EmbedBuilder()
        .setColor("#4CAF50")
        .setTitle(`📋 ${listName} (${cards.length})`);

      cards.forEach((card, index) => {
        if (index % 25 === 0 && index !== 0) {
          chunks.push(current);
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

      if (current.data.fields?.length) chunks.push(current);

      for (const embed of chunks) {
        await message.channel.send({ embeds: [embed] });
      }
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
