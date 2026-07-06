import { Client, GatewayIntentBits } from "discord.js";
import { DISCORD_TOKEN } from "./config.js";
import { executeBoards } from "./commands/boards.js";
import { executeLists } from "./commands/lists.js";
import { executeList } from "./commands/list.js";
import { executeTask } from "./commands/task.js";
import { processConnectCommand } from "./commands/connect.js";
import { processDisconnectCommand } from "./commands/connect.js";
import { getConnectionsCommand } from "./commands/connect.js";
import { processLekcjeCommand } from "./commands/lekcje.js"; // Dodany import
import { processFakturyCommand } from "./commands/faktury.js"; //dodany import
import { processSowaCommand } from "./commands/sowa.js";
import { processSkryptCommand } from "./commands/skrypt.js";
import { processFeedbackCommand } from "./commands/feedback.js";
import { processDiscoveryCommand } from "./commands/discovery.js";

import { initDatabase } from "./utils/database.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

(async () => {
  try {
    await initDatabase();
    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    // You might want to exit the process if database initialization fails
    // process.exit(1);
  }
})();

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!boards") {
    await executeBoards(message);
  }

  if (message.content === "!lists") {
    await executeLists(message);
  }

  if (message.content.startsWith("!list")) {
    await executeList(message);
  }

  if (message.content.startsWith("!task") || message.content.startsWith("!t")) {
    await executeTask(message);
  }

  if (message.content.startsWith("!connect")) {
    console.log("!connect command detected");
    try {
      await processConnectCommand(message);
    } catch (error) {
      console.error("Error in processConnectCommand:", error);
      message.reply("An error occurred while processing the connect command.");
    }
  }

  if (message.content === "!connections") {
    await getConnectionsCommand(message);
  }

  if (message.content.startsWith("!disconnect")) {
    await processDisconnectCommand(message);
  }

  if (message.content.startsWith("!lekcje")) {
    await processLekcjeCommand(message);
  }

  if (message.content.startsWith("!faktury")) {
    await processFakturyCommand(message);
  }

  if (message.content.startsWith("!sowa")) {
    await processSowaCommand(message);
  }

  if (message.content.startsWith("!skrypt")) {
    await processSkryptCommand(message);
  }

  if (message.content.startsWith("!feedback")) {
    await processFeedbackCommand(message);
  }

  if (message.content.startsWith("!discovery")) {
    await processDiscoveryCommand(message);
  }
});

client.once("ready", () => {
  console.log(
    `✅ Logged in as ${client.user.tag} and can be used in any Discord server.`
  );
});

client.login(DISCORD_TOKEN);
