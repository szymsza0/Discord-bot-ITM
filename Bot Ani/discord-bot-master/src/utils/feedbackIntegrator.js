import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, GOOGLE_SCRIPT_TEMPLATE_DOC_ID } from "../config.js";
import { getScriptTemplate, FEEDBACK_SECTION_HEADING } from "./scriptTemplate.js";
import { getDocsClient } from "./googleAuth.js";
import { fetchDocPlainText } from "./googleDocs.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
// Reasoning about whether new feedback contradicts existing guidance (and how
// to phrase a consistent update) benefits from a stronger model than the
// per-script generation call, per an explicit ask for "a more advanced model".
const FEEDBACK_MODEL = "claude-opus-4-8";
const TOOL_NAME = "integrate_feedback";

const integrateFeedbackTool = {
  name: TOOL_NAME,
  description:
    "Ocenia nowy feedback od operatora na tle obowiazujacych zasad pisania skryptow i przygotowuje zwiezly wpis do dziennika uwag.",
  input_schema: {
    type: "object",
    properties: {
      hasConflict: {
        type: "boolean",
        description: "Czy ten feedback wydaje sie sprzeczny z jakas istniejaca zasada w dokumencie.",
      },
      conflictNote: {
        type: "string",
        description:
          "Jesli hasConflict=true: krotkie, konkretne wyjasnienie z ktora zasada koliduje i dlaczego (po polsku).",
      },
      entryText: {
        type: "string",
        description:
          "Zwiezly (1-4 zdania), dobrze napisany wpis integrujacy ten feedback do zapisania w dzienniku uwag. " +
          "Jesli feedback aktualizuje lub zasteruje istniejaca zasade, wpis powinien to jasno wskazywac " +
          "(np. 'Aktualizacja: ... zamiast ...'), zeby dziennik pozostal spojny, a nie sprzeczny sam ze soba.",
      },
    },
    required: ["hasConflict", "entryText"],
  },
};

/**
 * Sends operator feedback (from the post-generation prompt or the standalone
 * !feedback command) to Claude for a consistency-aware assessment against the
 * current style guide, appends the resulting journal entry to the
 * FEEDBACK_SECTION_HEADING section at the end of the template doc (created if
 * missing), and refreshes the in-memory template cache so the next !skrypt
 * generation immediately sees it. Only ever appends - never rewrites existing
 * doc content - to keep the risk of a bad automated edit bounded; genuine
 * conflicts are flagged back to the human instead of being silently resolved.
 */
export async function integrateScriptFeedback({ feedbackText, scriptLink, authorName }) {
  const template = await getScriptTemplate();

  const userPrompt = [
    `Obowiazujace zasady pisania skryptow (aktualna tresc dokumentu, wraz z dotychczasowym dziennikiem uwag):\n${template.rulesText}`,
    scriptLink ? `Ten feedback dotyczy konkretnego skryptu: ${scriptLink}` : null,
    `Nowy feedback od ${authorName}:\n${feedbackText}`,
    `Oceń ten feedback względem powyższych zasad i przygotuj wpis do dziennika uwag, wywołując narzędzie ${TOOL_NAME}.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: FEEDBACK_MODEL,
    max_tokens: 1024,
    tools: [integrateFeedbackTool],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude nie zwróciło ustrukturyzowanej oceny feedbacku.");
  }

  const { hasConflict, conflictNote, entryText } = toolUse.input;
  const dateStr = new Date().toISOString().slice(0, 10);
  const source = [authorName, scriptLink].filter(Boolean).join(", ");
  const journalEntry = `- [${dateStr}]${source ? ` (${source})` : ""}: ${entryText}`;

  await appendFeedbackJournalEntry(journalEntry);
  await getScriptTemplate({ forceRefresh: true });

  return { hasConflict: !!hasConflict, conflictNote: conflictNote || null, entryText };
}

async function appendFeedbackJournalEntry(journalEntry) {
  const docs = getDocsClient();
  const fullText = await fetchDocPlainText(GOOGLE_SCRIPT_TEMPLATE_DOC_ID);

  // insertText with endOfSegmentLocation appends at the true end of the doc
  // body without needing to compute any character indices - safe regardless
  // of how the rest of the (evolving, work-in-progress) doc is structured.
  const text = fullText.includes(FEEDBACK_SECTION_HEADING)
    ? `\n${journalEntry}\n`
    : `\n\n${FEEDBACK_SECTION_HEADING}\n\n${journalEntry}\n`;

  await docs.documents.batchUpdate({
    documentId: GOOGLE_SCRIPT_TEMPLATE_DOC_ID,
    requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
  });
}
