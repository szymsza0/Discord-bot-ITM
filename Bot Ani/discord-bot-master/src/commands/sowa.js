import { EmbedBuilder } from "discord.js";
import { executeSowaCommand, isSowaConfigured } from "../utils/sowaClient.js";

function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor("#0079BF")
    .setTitle("🦉 SOWA - komendy")
    .setDescription(
      [
        "`!sowa ping` - test połączenia z SOWA",
        "`!sowa pm` - lista aktywnych PM-ów",
        "`!sowa faktury` - lista nieopłaconych faktur",
        "`!sowa faktury <PM>` - filtrowanie po ownerze/PM",
        "`!sowa oplacona <NUMER_FAKTURY>` - ręczne oznaczenie opłacenia",
        "`!sowa przypisz <NIP lub nazwa klienta> | <Imię Nazwisko PM>` - przypisanie klienta do PM",
      ].join("\n")
    )
    .setFooter({ text: "Adapter Discord -> SOWA" });
}

function toCurrency(value, currency = "PLN") {
  const amount =
    typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  if (!Number.isFinite(amount)) return "—";
  return `${amount.toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatDueDate(value) {
  if (!value || typeof value !== "string") return "brak";
  return value;
}

function fakturyEmbeds(payload, authorTag) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const count = typeof payload?.count === "number" ? payload.count : items.length;
  const ownerFilter = payload?.ownerFilter || null;

  if (count === 0) {
    return [
      new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("📭 Brak nieopłaconych faktur")
        .setDescription(
          ownerFilter
            ? `Brak pozycji dla filtra PM: **${ownerFilter}**`
            : "Brak nieopłaconych faktur."
        )
        .setFooter({ text: `Wywołał: ${authorTag}` }),
    ];
  }

  const maxPerEmbed = 8;
  const chunks = [];
  for (let i = 0; i < items.length; i += maxPerEmbed) {
    chunks.push(items.slice(i, i + maxPerEmbed));
  }

  return chunks.map((chunk, index) => {
    const lines = chunk.map((item) => {
      const left = toCurrency(item.remainingAmount, item.currency || "PLN");
      const owner = item.ownerName ? ` • PM: ${item.ownerName}` : "";
      return `• **${item.number}** · ${left} · termin: ${formatDueDate(item.dueDate)}${owner}`;
    });

    return new EmbedBuilder()
      .setColor("#0079BF")
      .setTitle(
        index === 0
          ? `🧾 Nieopłacone faktury (${count})`
          : `🧾 Nieopłacone faktury (${count}) - cz. ${index + 1}`
      )
      .setDescription(lines.join("\n"))
      .setFooter({
        text: ownerFilter
          ? `Filtr PM: ${ownerFilter} • Wywołał: ${authorTag}`
          : `Wywołał: ${authorTag}`,
      });
  });
}

function pmEmbeds(payload, authorTag) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    return [
      new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("👥 Brak aktywnych PM-ów")
        .setDescription("W SOWA nie ma aktywnych project managerów.")
        .setFooter({ text: `Wywołał: ${authorTag}` }),
    ];
  }

  const lines = items.map((item) => {
    const discord = item?.discordUsername
      ? ` (@${item.discordUsername})`
      : "";
    return `• **${item?.fullName || "—"}**${discord}`;
  });

  return [
    new EmbedBuilder()
      .setColor("#0079BF")
      .setTitle(`👥 Project managerowie (${items.length})`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Wywołał: ${authorTag}` }),
  ];
}

export async function processSowaCommand(message) {
  const rawInput = message.content.slice("!sowa".length).trim();
  if (!rawInput) {
    return message.reply({ embeds: [createHelpEmbed()] });
  }

  if (!isSowaConfigured()) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setTitle("❌ SOWA nie jest skonfigurowana")
          .setDescription(
            "Brak `SOWA_COMMAND_URL` w env bota. Skonfiguruj adapter i spróbuj ponownie."
          ),
      ],
    });
  }

  const [subcommandRaw, ...args] = rawInput.split(/\s+/).filter(Boolean);
  const subcommand = (subcommandRaw || "").toLowerCase();
  const authorTag = message.author?.tag || message.author?.username || "użytkownik";

  if (!["ping", "pm", "faktury", "oplacona", "przypisz"].includes(subcommand)) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setTitle("❌ Nieznana komenda SOWA")
          .setDescription("Dostępne: `ping`, `pm`, `faktury`, `oplacona`, `przypisz`"),
      ],
    });
  }

  if (subcommand === "oplacona" && args.length === 0) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setTitle("❌ Brak numeru faktury")
          .setDescription("Użycie: `!sowa oplacona FV/2026/04/012`"),
      ],
    });
  }

  if (subcommand === "przypisz" && !args.join(" ").includes("|")) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setTitle("❌ Nieprawidłowy format komendy")
          .setDescription(
            "Użycie: `!sowa przypisz <NIP lub nazwa klienta> | <Imię Nazwisko PM>`"
          ),
      ],
    });
  }

  const pending = await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor("#0079BF")
        .setDescription(`⏳ SOWA: wykonuję \`${subcommand}\`...`),
    ],
  });

  try {
    const payload = await executeSowaCommand({
      command: subcommand,
      args,
      text: args.join(" "),
    });

    if (subcommand === "ping") {
      return pending.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#2E8B57")
            .setTitle("✅ SOWA online")
            .setDescription("Połączenie z API SOWA działa.")
            .setFooter({ text: `Wywołał: ${authorTag}` }),
        ],
      });
    }

    if (subcommand === "oplacona") {
      return pending.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#2E8B57")
            .setTitle("✅ Oznaczono jako opłacona")
            .setDescription(
              `Faktura **${payload?.invoiceNumber || args[0]}** została ustawiona jako **${payload?.status || "paid"}**.`
            )
            .setFooter({ text: `Wywołał: ${authorTag}` }),
        ],
      });
    }

    if (subcommand === "przypisz") {
      return pending.edit({
        embeds: [
          new EmbedBuilder()
            .setColor("#2E8B57")
            .setTitle("✅ Zaktualizowano przypisanie PM")
            .setDescription(
              `Klient **${payload?.clientName || "—"}** został przypisany do **${payload?.ownerName || "—"}**.`
            )
            .setFooter({ text: `Wywołał: ${authorTag}` }),
        ],
      });
    }

    if (subcommand === "faktury") {
      const embeds = fakturyEmbeds(payload, authorTag);
      await pending.edit({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) {
        await message.channel.send({ embeds: [embeds[i]] });
      }
      return;
    }

    if (subcommand === "pm") {
      const embeds = pmEmbeds(payload, authorTag);
      return pending.edit({ embeds: [embeds[0]] });
    }

    return pending.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#2E8B57")
          .setTitle("✅ Komenda wykonana")
          .setDescription("SOWA zwróciła odpowiedź."),
      ],
    });
  } catch (error) {
    const text = error?.message || "Nieznany błąd wywołania SOWA API.";
    return pending.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setTitle("🚨 Błąd komendy SOWA")
          .setDescription(text),
      ],
    });
  }
}
