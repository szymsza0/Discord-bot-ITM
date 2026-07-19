import { GOOGLE_LP_TEMPLATE_DOC_ID } from "../config.js";
import { fetchGoogleDocPlainText } from "./googleDocs.js";

let cachedTemplate = null;

/**
 * Fetches and caches the LP copywriting guidelines doc once per process
 * lifetime, same pattern as getScriptTemplate() in scriptTemplate.js. Unlike
 * the scripts template, this doc has no "recording instructions" section to
 * split off and no feedback journal to fold back in - it's just the
 * copywriting rules (starting point: COPYWRITING_GUIDE.md), used verbatim as
 * generateLPCopy()'s cached system prompt.
 * Pass forceRefresh: true (e.g. an admin subcommand) to pick up doc edits.
 */
export async function getLPTemplate({ forceRefresh = false } = {}) {
  if (cachedTemplate && !forceRefresh) return cachedTemplate;

  const rulesText = (await fetchGoogleDocPlainText(GOOGLE_LP_TEMPLATE_DOC_ID)).trim();
  if (!rulesText) {
    throw new Error("Dokument wytycznych LP jest pusty - sprawdź GOOGLE_LP_TEMPLATE_DOC_ID.");
  }

  cachedTemplate = { rulesText, fetchedAt: new Date() };
  return cachedTemplate;
}
