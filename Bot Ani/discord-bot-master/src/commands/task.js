import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_API_KEY,
  TRELLO_API_BASE,
  TRELLO_KEY,
  TRELLO_TOKEN,
  ALLOWED_GUILD_ID,
} from "../config.js";
import {
  getListIdByName,
  getTrelloMemberId,
  fetchTrelloBoardDetails,
} from "../utils/trello.js";
import { EmbedBuilder } from "discord.js";
import { getBoardIdWithConfirmation } from "../utils/helpers.js";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import "dayjs/locale/pl.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import {
  findTrelloMembersByName,
  askUserToSelectTrelloMember,
} from "../utils/userMapping.js";

import {
  getTrelloMemberIdFromDiscord,
  getMentionedTrelloMembers,
  getTrelloMemberIdFromListName,
} from "../utils/userMapping.js";
dayjs.extend(localizedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("pl");
dayjs.tz.setDefault("Europe/Warsaw");

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

async function parseTaskWithClaude(input) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Extract the following fields from this task request as a **JSON object**:
          - **taskName**: The name of the task.
          - **person**: The list name (assignee).
          - **project**: The **exact project name from Trello**.
          - **optionalDeadline**: A date and time in **YYYY-MM-DD HH:mm** format, or \`null\` if not provided.
- **description**: Any additional details about the task, or \`null\` if not provided.
          Extract the following fields from this task request as a **JSON object**:
- **taskName**: The name of the task.
- **person**: The list name (assignee).
- **project**: The **exact project name from Trello** (make sure to include any important prefixes if they exist, but remove any leading numbers or tags like "[XX] 1 -").

🔹 **Name Variation Handling Rules**
- When extracting the **person** field, normalize common Polish name variations:
  - If you see a common diminutive or nickname, convert it to the standard form.
  - Examples:
    - "Aga" → "Agnieszka"

- Normalize common Polish name variations **and inflected forms (e.g., "dla Ani" → "Ania")**:
  - "Ani", "Ania" → **Ania**
  - "Agi", "Aga", "Agnieszki" → **Agnieszka**
  - "Kasi" → **Kasia**
  - "Patryka", "Patryk" → **Patryk**
  - If the name appears in a form like **"dla Ani"**, extract it as the nominative: **"Ania"**


- Apply similar name normalization for all Polish and international names you recognize.
- If you're not sure about a name variation, keep it as provided.


🔹 **🚨 Board Name Normalization Rules**
- **If the board name starts with a tag in brackets (e.g., "[OZ] 1 - Franki Kancelaria"), remove the tag and the number but keep the main name.**
  - **Example:**  
        [[ITM]] Admin -> extract just 'Admin'
        [[ ITM ]] Nowi / ITM -> extract just 'Nowi / ITM'
    - **"[OZ] 1 - Franki Kancelaria"** → Extract "Franki Kancelaria"
    - **"[AG] 11 - Beauty Inn"** → Extract "Beauty Inn"
- **If there is a Trello board that matches this extracted name, return the full Trello board name.**

          
          🔹 **🚨 STRICT Date Handling (No Guessing Allowed)**
          - **🚨 The current year is ${new Date().getFullYear()}**. If the user provides a date **without a year**, assume **${new Date().getFullYear()}**.
          - **🚨 The current date is ${dayjs()
            .tz("Europe/Warsaw")
            .format(
              "YYYY-MM-DD"
            )}**. Any relative date (e.g., "jutro") must be calculated **from this exact date**.
          - If the user writes **only a day and month** (e.g., "11-02" or "11.02"), assume the year is **${new Date().getFullYear()}** and return it as **YYYY-MM-DD 10:00**.
          
          🔹 **Polish Date Recognition Rules (Strict Conversion)**
          - Convert all natural language dates into **YYYY-MM-DD HH:mm** format:
            - **"jutro"** → Tomorrow **(${dayjs()
              .add(1, "day")
              .format("YYYY-MM-DD")}) at 10:00 AM**  
            - **"pojutrze"** → The day after tomorrow **(${dayjs()
              .add(2, "day")
              .format("YYYY-MM-DD")}) at 10:00 AM**  
            - **"za 3 dni"** → Three days from today **(${dayjs()
              .add(3, "day")
              .format("YYYY-MM-DD")}) at 10:00 AM**  
            - **"w poniedziałek"** → Next Monday **(${dayjs()
              .day(8)
              .format("YYYY-MM-DD")}) at 10:00 AM**  
          - **🚨 If the date is ambiguous, return an array of possible matches.**
          - **🚨 DO NOT GUESS dates or reformat them beyond the exact format requested.**
          
          🔍 **Request to process:** "${input}"
          `,
        },
      ],
    });
    console.log(
      "🔍 Claude Raw Response:",
      JSON.stringify(message.content, null, 2)
    );

    let text = "";
    if (Array.isArray(message.content) && message.content.length > 0) {
      text = message.content[0].text || "";
    } else if (typeof message.content === "string") {
      text = message.content;
    }
    console.log("📝 Extracted Text from Claude:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in response");
    }

    let parsedData = JSON.parse(jsonMatch[0]);

    console.log(
      `🔍 Extracted Task: "${parsedData.taskName}", List: "${parsedData.person}", Project: "${parsedData.project}", Deadline: "${parsedData.optionalDeadline}"`
    );

    if (parsedData.optionalDeadline) {
      parsedData.optionalDeadline = parsePolishDate(
        parsedData.optionalDeadline
      );
    }

    return parsedData;
  } catch (error) {
    console.error("🚨 Error in parseTaskWithClaude:", error);
    throw error;
  }
}
async function callClaudeWithRetry(input, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await parseTaskWithClaude(input);
    } catch (error) {
      if (error.status === 529 && attempt < retries) {
        console.warn(
          `⚠️ Claude is overloaded. Retrying in ${delay}ms (Attempt ${attempt})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        console.error("❌ Final failure or unrecoverable error:", error);
        throw error;
      }
    }
  }
}

function parsePolishDate(dateString) {
  const now = dayjs().tz("Europe/Warsaw");
  const currentYear = now.year();

  const exactMatch = dateString.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/
  );
  if (exactMatch) {
    return dayjs
      .tz(dateString, "YYYY-MM-DD HH:mm", "Europe/Warsaw")
      .toISOString();
  }

  const shortDateMatch = dateString.match(/^(\d{1,2})[-.](\d{1,2})$/);
  if (shortDateMatch) {
    const day = shortDateMatch[1].padStart(2, "0");
    const month = shortDateMatch[2].padStart(2, "0");

    return dayjs
      .tz(
        `${currentYear}-${month}-${day} 10:00`,
        "YYYY-MM-DD HH:mm",
        "Europe/Warsaw"
      )
      .toISOString();
  }

  if (
    dateString.toLowerCase() === "jutro" ||
    dateString.toLowerCase() === "na jutro"
  ) {
    return now.add(1, "day").hour(10).minute(0).toISOString();
  }

  if (
    dateString.toLowerCase() === "pojutrze" ||
    dateString.toLowerCase() === "na pojutrze"
  ) {
    return now.add(2, "day").hour(10).minute(0).toISOString();
  }

  const daysMatch = dateString.match(/za (\d+) dni/);
  if (daysMatch) {
    return now.add(parseInt(daysMatch[1], 10)).hour(10).minute(0).toISOString();
  }

  console.log(`❌ Unrecognized date format: "${dateString}"`);
  return null;
}
// Modified portion of the executeTask function

// Fixed portion of the executeTask function

export async function executeTask(message) {
  const input = message.content.slice(6).trim();
  if (!input) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setDescription("❌ Proszę podać szczegóły zadania."),
      ],
    });
  }

  let processingMsg;
  try {
    processingMsg = await message.reply({
      embeds: [{ color: 0x0079bf, description: "⏳ Zapisuję..." }],
    });
  } catch (error) {
    console.error("🚨 Error sending initial message:", error);
    return;
  }

  try {
    console.log(`📝 Processing input: "${input}"`);
    const data = await callClaudeWithRetry(input);

    if (!data) throw new Error("Claude did not return valid data.");

    // Use the improved board selection method
    const boardId = await getBoardIdWithConfirmation(
      data.project,
      message,
      processingMsg
    );

    if (!boardId) {
      // If null was returned, the error was already displayed to the user
      return;
    }

    // Get board details
    const boardDetails = await fetchTrelloBoardDetails(boardId);
    if (!boardDetails || boardDetails.idOrganization !== ALLOWED_GUILD_ID) {
      return processingMsg.edit({
        embeds: [
          {
            color: 0xff0000,
            description: `🚫 **Projekt "${data.project}" nie jest w dozwolonym workspace.**`,
          },
        ],
      });
    }

    if (boardDetails.closed) {
      console.error(
        `🚨 Board "${data.project}" is closed. Cannot create tasks.`
      );
      return processingMsg.edit({
        embeds: [
          {
            color: 0xff0000,
            description: `🚨 **Tablica "${boardDetails.name}" jest zamknięta i nie można na niej tworzyć zadań.**`,
          },
        ],
      });
    }

    console.log(`✅ Board "${boardDetails.name}" is open and active.`);

    // Get list ID logic
    let listId = await getListIdByName(boardId, data.person);
    let usedDefaultList = false;
    let actualListName = data.person;

    // Special handling for Aga/Agnieszka
    if (!listId) {
      if (data.person.toLowerCase() === "agnieszka") {
        console.log(
          `⚠️ Lista "Agnieszka" nie istnieje. Próbuję użyć listy "Aga".`
        );
        listId = await getListIdByName(boardId, "Aga");
        if (listId) {
          actualListName = "Aga";
        }
      } else if (data.person.toLowerCase() === "aga") {
        console.log(
          `⚠️ Lista "Aga" nie istnieje. Próbuję użyć listy "Agnieszka".`
        );
        listId = await getListIdByName(boardId, "Agnieszka");
        if (listId) {
          actualListName = "Agnieszka";
        }
      }
    }

    // Fallback to "bazowe" list
    if (!listId) {
      console.log(
        `⚠️ Lista "${data.person}" nie istnieje. Próbuję użyć listy "bazowe".`
      );
      listId = await getListIdByName(boardId, "bazowe");

      if (!listId) {
        return processingMsg.edit({
          embeds: [
            {
              color: 0xff0000,
              description: `❌ **Nie znaleziono ani listy "${data.person}", ani listy "bazowe" w projekcie "${boardDetails.name}".**`,
            },
          ],
        });
      }

      usedDefaultList = true;
      actualListName = "bazowe";
    }

    // Get the creator's Trello ID
    console.log(
      `🔍 Looking up Trello ID for Discord user: ${message.author.username}`
    );
    const creatorMemberId = await getTrelloMemberIdFromDiscord(
      message.author.username
    );

    // Log whether we got the creator's ID
    if (creatorMemberId) {
      console.log(
        `✅ Got task creator's Trello ID: ${creatorMemberId} for ${message.author.username}`
      );
    } else {
      console.log(
        `⚠️ Could not find Trello ID for Discord user: ${message.author.username}`
      );
    }

    // Get mentioned users' Trello member IDs
    const mentionedMemberIds = await getMentionedTrelloMembers(
      input,
      message.client
    );

    // Try to find a Trello member matching the list name
    let listNameMemberId = null;
    if (actualListName && actualListName.toLowerCase() !== "bazowe") {
      try {
        // Send a temporary message while we search for members
        let searchingMsg = null;
        try {
          searchingMsg = await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor("#0079BF")
                .setDescription(
                  `🔍 Szukam użytkownika Trello pasującego do listy "${actualListName}"...`
                ),
            ],
          });
        } catch (msgError) {
          console.error("Could not send searching message:", msgError);
        }

        // Get the member ID based on list name
        listNameMemberId = await getTrelloMemberIdFromListName(
          actualListName,
          message
        );

        // Delete the temporary message - with error handling
        if (searchingMsg) {
          try {
            await searchingMsg.delete();
          } catch (error) {
            console.error(
              "Could not delete temporary searching message:",
              error
            );
          }
        }
      } catch (searchError) {
        console.error(`Error during Trello member search:`, searchError);
      }

      if (listNameMemberId) {
        console.log(
          `✅ Found Trello member (ID: ${listNameMemberId}) for list "${actualListName}"`
        );
      } else {
        console.log(`⚠️ No Trello member found for list "${actualListName}"`);
      }
    }

    // Combine all member IDs (creator + list person + mentioned), removing duplicates
    const allMemberIds = [
      ...new Set([
        ...(creatorMemberId ? [creatorMemberId] : []),
        ...(listNameMemberId ? [listNameMemberId] : []),
        ...mentionedMemberIds,
      ]),
    ];

    console.log(
      `🧑‍💼 Adding ${allMemberIds.length} members to card: ${allMemberIds.join(
        ", "
      )}`
    );

    // Format deadline correctly
    const formattedDeadline = data.optionalDeadline
      ? dayjs(data.optionalDeadline)
          .tz("Europe/Warsaw")
          .locale("pl")
          .format("dddd, D MMMM YYYY, HH:mm")
      : "Brak";

    // Create Trello card
    const cardData = {
      key: TRELLO_KEY,
      token: TRELLO_TOKEN,
      idList: listId,
      name: data.taskName,
      desc: data.description ? data.description : " ",
      due: data.optionalDeadline || "",
    };

    // If we have valid Trello member IDs, assign them to the card
    if (allMemberIds.length > 0) {
      cardData.idMembers = allMemberIds.join(",");
    }

    // Log the card data before sending to Trello (remove sensitive info)
    console.log(`📤 Creating Trello card with data:`, {
      ...cardData,
      key: "[REDACTED]",
      token: "[REDACTED]",
      idMembers: cardData.idMembers || "None",
    });

    const cardResponse = await fetch(`${TRELLO_API_BASE}/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(cardData),
    });

    if (!cardResponse.ok) {
      const errorText = await cardResponse.text();
      console.error(
        `🚨 Trello API Error Creating Task: ${cardResponse.status} - ${errorText}`
      );
      throw new Error(`Trello API error: ${cardResponse.status}`);
    }

    const card = await cardResponse.json();
    if (!card.url) {
      throw new Error("Trello API did not provide a valid task URL.");
    }

    let listMessage;
    if (usedDefaultList) {
      listMessage = `**Lista:** bazowe *(lista "${data.person}" nie istnieje, użyto domyślnej)*`;
    } else if (actualListName !== data.person) {
      listMessage = `**Lista (dla kogo):** ${actualListName}`;
    } else {
      listMessage = `**Lista (dla kogo):** ${data.person}`;
    }

    // Get details about all assigned members for display
    let assignedMembersText = "";
    if (allMemberIds.length > 0) {
      try {
        // Get names of assigned members for display
        const memberNames = [];
        for (const memberId of allMemberIds) {
          try {
            const memberUrl = `${TRELLO_API_BASE}/members/${memberId}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
            const memberResponse = await fetch(memberUrl);

            if (memberResponse.ok) {
              const memberData = await memberResponse.json();
              memberNames.push(memberData.fullName || memberData.username);
            }
          } catch (memberError) {
            console.error(
              `Error getting member details for ${memberId}:`,
              memberError
            );
          }
        }

        // Create text listing assigned members
        if (memberNames.length > 0) {
          assignedMembersText = `\n**Przypisani użytkownicy:** ${memberNames.join(
            ", "
          )}`;
        } else {
          assignedMembersText = `\n**Przypisani użytkownicy:** ${allMemberIds.length}`;
        }
      } catch (error) {
        console.error("Error getting member details:", error);
        assignedMembersText = `\n**Przypisani użytkownicy:** ${allMemberIds.length}`;
      }
    }
    return processingMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#0079BF")
          .setTitle("✅ Zadanie utworzone!")
          .addFields([
            {
              name: "📋 **Szczegóły**",
              value: `**Zadanie:** ${
                data.taskName
              }\n${listMessage}\n**Projekt:** ${
                boardDetails.name
              }\n**Deadline:** ${formattedDeadline}${assignedMembersText}${
                data.description ? `\n**Opis:** ${data.description}` : ""
              }\n\n🔗 [Zobacz w Trello ➔](${card.url})`,
            },
          ]),
      ],
    });
  } catch (error) {
    console.error("🚨 Error in `executeTask()`:", error);
    return processingMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor("#FF0000")
          .setDescription(
            `❌ **Błąd w przetwarzaniu zadania:** ${error.message}`
          ),
      ],
    });
  }
}
