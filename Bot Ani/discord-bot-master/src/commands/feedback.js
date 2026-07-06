import { EmbedBuilder } from "discord.js";
import { integrateScriptFeedback } from "../utils/feedbackIntegrator.js";
import { GOOGLE_SCRIPT_TEMPLATE_DOC_ID } from "../config.js";

const TEMPLATE_DOC_URL = `https://docs.google.com/document/d/${GOOGLE_SCRIPT_TEMPLATE_DOC_ID}/edit`;

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

/**
 * Standalone `!feedback <link opcjonalny> <tresc>` command - exists
 * independently of the post-generation prompt in skrypt.js so feedback can
 * still be recorded after that prompt has already timed out.
 */
export async function processFeedbackCommand(message) {
  try {
    const content = message.content.slice("!feedback".length).trim();

    if (!content) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("#FF0000")
            .setDescription("❌ Użycie: `!feedback <link do skryptu (opcjonalnie)> <treść uwagi>`"),
        ],
      });
    }

    const link = extractFirstUrl(content);
    const feedbackText = (link ? content.replace(link, "") : content).trim();

    if (!feedbackText) {
      return message.reply({
        embeds: [new EmbedBuilder().setColor("#FF0000").setDescription("❌ Podaj treść feedbacku, nie tylko link.")],
      });
    }

    const processingMsg = await message.reply({
      embeds: [new EmbedBuilder().setColor("#0079BF").setDescription("⏳ Analizuję feedback i aktualizuję wytyczne...")],
    });

    const authorName = message.member?.displayName || message.author.username;
    const result = await integrateScriptFeedback({ feedbackText, scriptLink: link, authorName });

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
  } catch (error) {
    console.error("Error processing feedback command:", error);
    try {
      await message.reply({
        embeds: [new EmbedBuilder().setColor("#FF0000").setDescription(`❌ Wystąpił błąd: ${error.message}`)],
      });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}
