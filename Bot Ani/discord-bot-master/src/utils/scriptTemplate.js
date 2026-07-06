import { GOOGLE_SCRIPT_TEMPLATE_DOC_ID } from "../config.js";
import { fetchGoogleDocPlainText } from "./googleDocs.js";

const INSTRUCTIONS_MARKER = "Zalacznik: wskazowki nagraniowe dla klienta";
// Kept as a fixed placeholder heading only - the template doc is a
// work-in-progress style guide, and the "Zalacznik" section it contains today
// runs straight into an unrelated worked example + duplicate rules list with
// no clean end marker, so pulling everything after "Zalacznik" verbatim into
// every generated script also pulled in that unrelated content. Until the
// client-facing recording instructions are finalized as their own
// self-contained section, only the heading is appended to generated docs.
const RECORDING_INSTRUCTIONS_PLACEHOLDER = "Załącznik: wskazówki nagraniowe dla klienta";

// Feedback (see feedbackIntegrator.js) is journaled under this heading at the
// very end of the template doc, and its content is folded back into
// rulesText below so future generations immediately account for it.
export const FEEDBACK_SECTION_HEADING = "Uwagi z feedbacku (na bieżąco)";

function stripPolishDiacritics(str) {
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L");
}

function findMarker(normalizedText, marker) {
  return normalizedText.toLowerCase().indexOf(stripPolishDiacritics(marker).toLowerCase());
}

let cachedTemplate = null;

/**
 * Fetches and caches the ITM script style-guide doc once per process
 * lifetime (network + generation-prompt tokens are only spent once, not on
 * every !skrypt invocation). The doc is split into:
 *  - rulesText: structure/style rules fed to Claude as the (cached) system
 *    prompt, with any accumulated feedback-journal entries folded in at the end
 *  - recordingInstructionsText: a fixed placeholder heading appended to every
 *    generated doc (see comment above)
 * Pass forceRefresh: true (via an admin subcommand, or after integrating new
 * feedback) to pick up doc changes.
 */
export async function getScriptTemplate({ forceRefresh = false } = {}) {
  if (cachedTemplate && !forceRefresh) return cachedTemplate;

  const fullText = await fetchGoogleDocPlainText(GOOGLE_SCRIPT_TEMPLATE_DOC_ID);
  const normalizedFull = stripPolishDiacritics(fullText);

  const instructionsIndex = findMarker(normalizedFull, INSTRUCTIONS_MARKER);
  if (instructionsIndex === -1) {
    throw new Error(`Nie znaleziono sekcji "${INSTRUCTIONS_MARKER}" w dokumencie szablonu skryptow.`);
  }

  let rulesText = fullText.slice(0, instructionsIndex).trim();

  const feedbackIndex = findMarker(normalizedFull, FEEDBACK_SECTION_HEADING);
  if (feedbackIndex !== -1) {
    rulesText += "\n\n" + fullText.slice(feedbackIndex).trim();
  }

  cachedTemplate = {
    rulesText,
    recordingInstructionsText: RECORDING_INSTRUCTIONS_PLACEHOLDER,
    fetchedAt: new Date(),
  };

  return cachedTemplate;
}
