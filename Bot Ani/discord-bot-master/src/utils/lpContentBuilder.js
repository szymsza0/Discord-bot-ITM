// camelCase -> SNAKE_CASE segment, e.g. "metaDescription" -> "META_DESCRIPTION"
function toTokenSegment(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Recursively turns the generateLPCopy() output into a flat {TOKEN: value}
 * map matching the `{{HERO_HEADLINE}}`-style tokens authored into the WP
 * template page (spec section 6, variant B). Objects nest with "_"
 * (business.name -> BUSINESS_NAME), arrays get a 1-based index
 * (problems[0].title -> PROBLEMS_1_TITLE) since the WP template is a fixed
 * set of Kadence blocks, not a loop - however many repeated items exist in
 * the template page is the max this will ever fill.
 *
 * null/undefined leaves are skipped on purpose: the token then stays
 * unreplaced in the page content, which is exactly how buildPageContent()
 * below detects "brief didn't have this" without any separate bookkeeping.
 */
export function flattenCopyToTokens(copy) {
  const tokens = {};

  function walk(value, prefix) {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${prefix}_${i + 1}`));
      return;
    }

    if (typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        walk(v, prefix ? `${prefix}_${toTokenSegment(key)}` : toTokenSegment(key));
      }
      return;
    }

    if (value === "") return; // empty string = same as "no data", leave token in place
    tokens[prefix] = String(value);
  }

  for (const [key, value] of Object.entries(copy || {})) {
    walk(value, toTokenSegment(key));
  }

  return tokens;
}

/**
 * Substitutes `{{TOKEN}}` text tokens (from flattenCopyToTokens) and
 * `{{MEDIA:slot}}` image tokens (from the WP Media Library URLs uploaded in
 * mediaMatcher.js / fileuploaderMedia.js) into the template page's raw
 * Kadence block content. Whatever `{{...}}` is left afterwards is exactly
 * what wasn't filled - the caller (lp.js) reports `remainingTokens` verbatim
 * as "⚠️ placeholder / do uzupełnienia" (spec section 7), so a missing brief
 * answer or missing media file is always visible instead of silently
 * shipping literal `{{TOKEN}}` text to a live page.
 */
export function buildPageContent(templateRawContent, copy, mediaBySlot = {}) {
  let content = templateRawContent;

  const tokenMap = flattenCopyToTokens(copy);
  for (const [token, value] of Object.entries(tokenMap)) {
    content = content.replaceAll(`{{${token}}}`, value);
  }

  for (const [slot, url] of Object.entries(mediaBySlot)) {
    if (!url) continue;
    content = content.replaceAll(`{{MEDIA:${slot}}}`, url);
  }

  const remainingTokens = [...new Set([...content.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]))];
  return { content, remainingTokens };
}
