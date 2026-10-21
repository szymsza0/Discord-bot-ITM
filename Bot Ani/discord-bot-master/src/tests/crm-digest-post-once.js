// Jednorazowe wysłanie porannego przeglądu CRM na Discorda bez uruchamiania
// całego bota (bez komend i crona) - np. pierwsza wiadomość po akceptacji
// podglądu z crm-digest-dry-run.js. Bez --send tylko loguje się, sprawdza
// kanał i pokazuje, co by wysłał.
//   node src/tests/crm-digest-post-once.js [--channel <id>] [--send]
// Kanał domyślnie z DISCOVERY_CHANNEL_ID. Potrzebne DISCORD_TOKEN, TRELLO_KEY,
// TRELLO_TOKEN (opcjonalnie ANTHROPIC_API_KEY).
import { Client, GatewayIntentBits } from "discord.js";
import { DISCORD_TOKEN, DISCOVERY_CHANNEL_ID } from "../config.js";
import { prepareCrmDigestMessage } from "../commands/discovery.js";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const send = args.includes("--send");
const channelId = option("--channel") || DISCOVERY_CHANNEL_ID;

if (!channelId) {
  console.error("❌ Podaj --channel <id> albo ustaw DISCOVERY_CHANNEL_ID.");
  process.exit(1);
}
if (!DISCORD_TOKEN) {
  console.error("❌ Brak DISCORD_TOKEN w środowisku.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
try {
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(channelId);
  console.log(`Kanał: #${channel.name} (serwer: ${channel.guild?.name || "?"})`);

  const message = await prepareCrmDigestMessage(channel);
  if (!message) {
    console.log("Nic do wysłania - przegląd byłby pominięty.");
  } else if (!send) {
    const [embed] = message.embeds;
    console.log(`\n${message.content}\n\n# ${embed.title}\n\n${embed.description}`);
    for (const field of embed.fields) console.log(`\n## ${field.name}\n${field.value}`);
    console.log(`\n-- ${embed.footer.text}`);
    console.log("\nNIE wysłano. Dodaj --send, żeby wysłać tę wiadomość na kanał.");
  } else {
    const sent = await channel.send(message);
    console.log(`✅ Wysłano: ${sent.url}`);
  }
} finally {
  await client.destroy();
}
