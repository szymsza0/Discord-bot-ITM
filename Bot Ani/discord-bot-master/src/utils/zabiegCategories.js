/**
 * Normalizes the free-text "Zabieg" values from the scripts sheet into a
 * short list of canonical groups for the !skrypt picker. The sheet has grown
 * organically, so the same treatment shows up under many spellings
 * ("Depilacja laserowa", "epilacja", "Depilacja woskiem", "A + B" combos) -
 * listing them raw made the picker long and split reference lookups.
 *
 * Problem-aware scripts are tagged in the sheet by appending
 * PROBLEM_AWARE_SUFFIX to the Zabieg value, e.g. "Depilacja / epilacja
 * (problem aware)", so they can be told apart from standard scripts later.
 */

export const PROBLEM_AWARE_SUFFIX = " (problem aware)";

const PROBLEM_AWARE_RE = /\s*\(\s*problem[\s-]*aware\s*\)\s*$/i;

// Order matters: first matching rule wins. Patterns are tested against the
// lowercased value with Polish diacritics stripped.
const GROUPS = [
  { label: "Depilacja / epilacja", re: /\b(depil|epil|usuwanie owlosienia|laser diodow)/ },
  { label: "Toksyna botulinowa (botoks)", re: /\b(botoks|botox|toksyn|botul|bruksizm|nadpotliwos)/ },
  { label: "Usta (modelowanie / powiększanie)", re: /\b(usta|ust|ustach|warg\w*)\b/ },
  { label: "Mezoterapia", re: /\bmezoterap/ },
  { label: "Stymulatory tkankowe / wolumetria", re: /\b(stymulator|wolumetri|kwas hialuron|wypelniacz|profhilo|sculptra|radiesse|nici|lifting nic)/ },
  { label: "Brwi (laminacja / henna / stylizacja)", re: /\bbrwi/ },
  { label: "Rzęsy (przedłużanie / lifting / laminacja)", re: /\brzes/ },
  { label: "Makijaż permanentny", re: /\b(makijaz permanent|pmu|permanent)/ },
  { label: "Peeling chemiczny / kwasy", re: /\b(peeling|kwas)/ },
  { label: "Oczyszczanie twarzy (wodorowe / Hydrafacial)", re: /\b(oczyszcz|wodorow|hydraf|hydrabrazj|mikrodermabraz)/ },
  { label: "Endermologia / modelowanie sylwetki", re: /\b(endermo|cellulit|modelowanie sylwetki|ujedrnian|lipoliz|kriolipoliz|emsculpt|wyszczuplan)/ },
  { label: "Laser frakcyjny / odmładzanie laserowe", re: /\b(frakcyj|co2|fotoodmladz|ipl|laseroterap)/ },
  { label: "Usuwanie przebarwień / trądziku", re: /\b(przebarwie|tradzik|blizn)/ },
  { label: "Manicure / pedicure", re: /\b(manicure|pedicure|paznokc|hybryd|stylizacja paznokci)/ },
  { label: "Masaż", re: /\bmasaz/ },
  { label: "Fryzjerstwo (strzyżenie / koloryzacja / keratyna)", re: /\b(fryzj|strzyz|koloryz|keratyn|wlos)/ },
];

export function stripPolishDiacritics(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L");
}

function matchKey(value) {
  return stripPolishDiacritics(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function isProblemAwareZabieg(value) {
  return PROBLEM_AWARE_RE.test(value || "");
}

export function stripProblemAwareTag(value) {
  return (value || "").replace(PROBLEM_AWARE_RE, "").trim();
}

/** Value written to the sheet's Zabieg column for a problem-aware script. */
export function tagProblemAware(zabiegLabel) {
  return `${stripProblemAwareTag(zabiegLabel)}${PROBLEM_AWARE_SUFFIX}`;
}

/**
 * Maps one raw treatment name (no "A + B" combos, no tag) to its canonical
 * group label. Unknown names keep their own spelling (first letter upper).
 */
export function canonicalZabieg(name) {
  const clean = stripProblemAwareTag(name).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const key = matchKey(clean);
  const group = GROUPS.find((g) => g.re.test(key));
  if (group) return group.label;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Splits a sheet value like "Botoks + Mezoterapia (problem aware)" into canonical groups. */
export function canonicalZabiegiOf(value) {
  return [
    ...new Set(
      stripProblemAwareTag(value)
        .split(/\s*[+,]\s*/)
        .map(canonicalZabieg)
        .filter(Boolean)
    ),
  ];
}

/**
 * Collapses raw sheet values into a deduplicated, sorted list of canonical
 * groups (case/diacritics-insensitive), ready for the picker.
 */
export function groupZabiegCategories(rawValues) {
  const byKey = new Map();
  for (const raw of rawValues) {
    for (const label of canonicalZabiegiOf(raw)) {
      const key = matchKey(label);
      if (!byKey.has(key)) byKey.set(key, label);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "pl"));
}

/** True if the sheet value covers the given (canonical or raw) treatment. */
export function zabiegMatches(sheetValue, zabieg) {
  const target = matchKey(canonicalZabieg(zabieg));
  return canonicalZabiegiOf(sheetValue).some((label) => matchKey(label) === target);
}
