// src/commands/faktury.js
import { EmbedBuilder } from "discord.js";
import { fetchInvoiceCards, groupCardsByPerson, getStawkaFromCard } from "../utils/trello.js";import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config.js";
import dayjs from "dayjs";
import "dayjs/locale/pl.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("pl");
dayjs.tz.setDefault("Europe/Warsaw");

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

/**
 * Parsuje polskie komendy używając Claude AI
 * @param {string} input - Tekst komendy (np. "na ten tydzień dla Agnieszki")
 * @returns {Promise<Object>} - { period: string, memberName: string|null }
 */
async function parsePolishCommand(input) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Przeanalizuj polską komendę i wyciągnij z niej parametry jako JSON:

ZASADY PARSOWANIA:
1. **period** - zamień na jeden z: "week", "month", "7days"
   - "tydzień/tygodniu/ten tydzień/do końca tygodnia" → "week"
   - "miesiąc/miesięcy/ten miesiąc/do końca miesiąca" → "month"  
   - "7 dni/siedem dni/następne 7 dni/przez 7 dni" → "7days"

2. **memberName** - wyciągnij imię osoby (jeśli jest)
   - "dla Agnieszki/Agnieszka/Agi" → "Agnieszka"
   - "dla Szymona/Szymon" → "Szymon"
   - "dla Olgi/Olga" → "Olga"
   - Jeśli brak imienia → null

3. **Aktualna data:** ${dayjs().format('YYYY-MM-DD')} (niedzela = koniec tygodnia)

PRZYKŁADY:
- "na ten tydzień" → {"period": "week", "memberName": null}
- "7 dni dla Agnieszki" → {"period": "7days", "memberName": "Agnieszka"}
- "miesiąc Szymon" → {"period": "month", "memberName": "Szymon"}
- "do końca tygodnia dla Agi" → {"period": "week", "memberName": "Agnieszka"}

KOMENDA DO PARSOWANIA: "${input}"

Odpowiedz TYLKO JSON bez dodatkowego tekstu:`
        }
      ]
    });

    let text = "";
    if (Array.isArray(message.content) && message.content.length > 0) {
      text = message.content[0].text || "";
    }

    // Wyciągnij JSON z odpowiedzi
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Claude nie zwrócił poprawnego JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    console.log(`🤖 Claude sparsował: "${input}" → period: "${parsed.period}", memberName: "${parsed.memberName}"`);
    
    return {
      period: parsed.period || null,
      memberName: parsed.memberName || null
    };

  } catch (error) {
    console.error("🚨 Błąd parsowania z Claude:", error);
    
    // Fallback - spróbuj proste dopasowanie
    return parseSimpleFallback(input);
  }
}

/**
 * Prosty fallback parsing bez Claude (jeśli Claude nie działa)
 */
function parseSimpleFallback(input) {
  const text = input.toLowerCase();
  
  let period = null;
  let memberName = null;
  
  // Rozpoznaj okres
  if (text.includes('tydzień') || text.includes('tygodniu') || text.includes('week')) {
    period = 'week';
  } else if (text.includes('miesiąc') || text.includes('miesięcy') || text.includes('month')) {
    period = 'month';
  } else if (text.includes('7') || text.includes('siedem')) {
    period = '7days';
  }
  
  // Rozpoznaj imiona (proste dopasowanie)
  const names = ['agnieszka', 'aga', 'szymon', 'olga', 'paulina'];
  for (const name of names) {
    if (text.includes(name)) {
      memberName = name.charAt(0).toUpperCase() + name.slice(1);
      if (name === 'aga') memberName = 'Agnieszka';
      break;
    }
  }
  
  console.log(`⚠️ Fallback parsing: "${input}" → period: "${period}", memberName: "${memberName}"`);
  
  return { period, memberName };
}

/**
 * Główna funkcja obsługująca komendę !faktury
 * Teraz obsługuje polskie komendy!
 */
export async function processFakturyCommand(message) {
  try {
    // Pobierz tekst po "!faktury"
    const input = message.content.slice("!faktury".length).trim();
    
    if (!input) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle("❌ Błędna składnia")
            .setDescription(
              "**Użycie (po polsku!):**\n" +
              "`!faktury na ten tydzień` - do końca tygodnia\n" +
              "`!faktury do końca miesiąca` - do końca miesiąca\n" +
              "`!faktury następne 7 dni` - następne 7 dni\n" +
              "`!faktury tydzień dla Agnieszki` - tydzień dla konkretnej osoby\n\n" +
              "**Przykłady:**\n" +
              "`!faktury ten miesiąc`\n" +
              "`!faktury 7 dni dla Szymona`\n" +
              "`!faktury do końca tygodnia dla Agi`"
            )
        ]
      });
    }

    // Wyślij wiadomość o przetwarzaniu
    const processingMsg = await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#0079BF")
          .setDescription("⏳ Parsuję komendę i przetwarzam faktury...")
      ]
    });

    console.log(`🧾 Przetwarzanie polskiej komendy: "${input}"`);

    // Parsuj polską komendę używając Claude
    const { period, memberName } = await parsePolishCommand(input);

    // Walidacja okresu
    const validPeriods = ["week", "month", "7days"];
    if (!period || !validPeriods.includes(period)) {
      return processingMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#FF0000")
            .setDescription(
              `❌ **Nie rozpoznałem okresu w: "${input}"**\n\n` +
              "Spróbuj napisać:\n" +
              "• `na ten tydzień` lub `do końca tygodnia`\n" +
              "• `ten miesiąc` lub `do końca miesiąca`\n" +
              "• `7 dni` lub `następne 7 dni`"
            )
        ]
      });
    }

    // Pobierz karty faktury
    const cards = await fetchInvoiceCards(period, memberName);

    if (!cards || cards.length === 0) {
      const periodText = getPeriodDisplayText(period);
      const userText = memberName ? ` dla użytkownika **${memberName}**` : "";
      
      return processingMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#FFA500")
            .setTitle("📭 Brak faktury")
            .setDescription(
              `Nie znaleziono kart z deadline'ami **${periodText}**${userText} w board'zie **[[ C-Level ]] Szymon**.`
            )
        ]
      });
    }

    // Pogrupuj karty według osób
    const groupedCards = groupCardsByPerson(cards);

    // Stwórz embedy z wynikami
    const embeds = createPersonBasedEmbeds(groupedCards, period, memberName, input);

    // Wyślij wyniki
    await processingMsg.edit({ embeds: [embeds[0]] });

    // Jeśli jest więcej embedów, wyślij je jako osobne wiadomości
    for (let i = 1; i < embeds.length; i++) {
      await message.channel.send({ embeds: [embeds[i]] });
    }

  } catch (error) {
    console.error("🚨 Błąd w processFakturyCommand:", error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor("#FF0000")
      .setTitle("🚨 Błąd")
      .setDescription(
        `Wystąpił błąd podczas pobierania faktury:\n\`\`\`${error.message}\`\`\``
      );

    return message.reply({ embeds: [errorEmbed] });
  }
}

/**
 * Tworzy embedy Discord z kartami pogrupowanymi według osób
 */
function createPersonBasedEmbeds(groupedCards, period, memberName, originalCommand) {
  const embeds = [];
  const periodText = getPeriodDisplayText(period);
  const userText = memberName ? ` - ${memberName}` : " - wszyscy użytkownicy";
  
  // Policz łączną liczbę kart
  const totalCards = Object.values(groupedCards).reduce((sum, cards) => sum + cards.length, 0);

  // Główny embed z podsumowaniem
  const mainEmbed = new EmbedBuilder()
    .setColor("#0079BF")
    .setTitle(`🧾 Faktury - ${periodText}`)
    .setDescription(
      `**Board:** [[ C-Level ]] Szymon\n` +
      `**Komenda:** "${originalCommand}"\n` +
      `**Okres:** ${periodText}\n` +
      `**Filtr:**${userText}\n` +
      `**Łącznie kart:** ${totalCards}\n\n` +
      `${createPersonSummary(groupedCards)}`
    )
    .setTimestamp()
    .setFooter({ text: "Ostatnie odświeżenie" });

  embeds.push(mainEmbed);

  // Twórz szczegółowe embedy dla każdej osoby
  Object.entries(groupedCards).forEach(([personName, cards]) => {
    if (cards.length === 0) return;

    const embed = createDetailedPersonEmbed(personName, cards);
    embeds.push(embed);
  });

  return embeds;
}

/**
 * Tworzy podsumowanie osób dla głównego embed'a
 */
function createPersonSummary(groupedCards) {
  let summary = "";
  
  Object.entries(groupedCards).forEach(([personName, cards]) => {
    if (cards.length > 0) {
      const projectText = cards.length === 1 ? "projekt" : 
                         cards.length <= 4 ? "projekty" : "projektów";
      summary += `👤 **[${personName}]** (${cards.length} ${projectText})\n`;
    }
  });

  return summary || "*Brak kart do wyświetlenia*";
}

/**
 * Tworzy szczegółowy embed dla konkretnej osoby
 */
function createDetailedPersonEmbed(personName, cards) {
  const embed = new EmbedBuilder()
    .setColor("#4CAF50")
    .setTitle(`👤 ${personName} (${cards.length})`)
    .setDescription(`Szczegóły kart dla: **${personName}**`);

  // Sortuj karty według deadline'a (najwcześniejsze na górze)
  const sortedCards = cards.sort((a, b) => {
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });

  // Dodaj karty jako fields (maksymalnie 25 na embed)
  sortedCards.slice(0, 25).forEach((card, index) => {
    const dueText = card.due 
      ? dayjs(card.due).tz("Europe/Warsaw").format("DD.MM.YYYY, HH:mm")
      : "Brak deadline'a";
    
    // Wyciągnij labele związane z fakturowaniem
    const invoiceLabels = card.labels ? 
      card.labels
        .filter(label => label.name.toLowerCase().includes('klient') || 
                        label.name.toLowerCase().includes('przed startem'))
        .map(label => label.name)
        .join(", ") : "";
    
    const labelText = invoiceLabels ? `**Label:** ${invoiceLabels}\n` : "";// Dodaj kwotę (custom field "Stawka")
    const stawka = getStawkaFromCard(card, card.boardCustomFields);
    const stawkaText = stawka !== "Brak" ? `**Kwota:** ${stawka}\n` : "";

    embed.addFields({
      name: `📎 ${card.name}`,
      value: 
        `**Deadline:** ${dueText}\n` +
        labelText +
        stawkaText +
        `[🔗 Zobacz w Trello](${card.url})`,
      inline: false
    });
  });

  // Jeśli jest więcej niż 25 kart, dodaj informację
  if (sortedCards.length > 25) {
    embed.setFooter({ 
      text: `Pokazano 25 z ${sortedCards.length} kart. Pozostałe karty w kolejnym embed'zie.` 
    });
  }

  return embed;
}

/**
 * Konwertuje kod okresu na czytelny tekst
 */
function getPeriodDisplayText(period) {
  switch (period) {
    case "week":
      return "do końca tego tygodnia";
    case "month":
      return "do końca tego miesiąca";
    case "7days":
      return "w ciągu 7 dni";
    default:
      return period;
  }
}