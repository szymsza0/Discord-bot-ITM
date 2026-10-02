import { getSheetsClient } from "./googleAuth.js";
import { groupZabiegCategories, isProblemAwareZabieg, zabiegMatches } from "./zabiegCategories.js";
import { PROBLEM_AWARE_SEED_KLIENT } from "./problemAwareTemplate.js";

const REQUIRED_HEADER_LABELS = {
  czyj: "Czyj?",
  klient: "Klient",
  briefLink: "Link do briefu",
  skryptLink: "Link do skryptu",
  zabieg: "Zabieg",
};

// Optional: populated when present, but its absence doesn't break older
// copies of the sheet that don't have this column yet.
const OPTIONAL_HEADER_LABELS = {
  data: "Data",
};

function columnIndexToLetter(index) {
  let letter = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function normalize(value) {
  return (value || "").toString().trim().toLowerCase();
}

async function getFirstSheetTitle(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const title = meta.data.sheets?.[0]?.properties?.title;
  if (!title) {
    throw new Error("Nie udalo sie odczytac nazwy zakladki arkusza skryptow.");
  }
  return title;
}

/**
 * The scripts sheet has several blank leading rows before the real header
 * row, so we can't assume a fixed row index - we scan for the row that
 * contains "Zabieg" and derive the column layout from it.
 */
export async function findHeaderRow(spreadsheetId, sheetName) {
  const resolvedSheetName = sheetName || (await getFirstSheetTitle(spreadsheetId));
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!A1:Z50`,
  });

  const rows = res.data.values || [];
  const headerRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalize(cell) === normalize(REQUIRED_HEADER_LABELS.zabieg))
  );

  if (headerRowIndex === -1) {
    throw new Error(
      `Nie znaleziono wiersza naglowka (kolumna "Zabieg") w pierwszych 50 wierszach arkusza skryptow.`
    );
  }

  const headerRow = rows[headerRowIndex];
  const columnMap = {};
  for (const [key, label] of Object.entries(REQUIRED_HEADER_LABELS)) {
    const colIndex = headerRow.findIndex((cell) => normalize(cell) === normalize(label));
    if (colIndex === -1) {
      throw new Error(`Nie znaleziono kolumny "${label}" w naglowku arkusza skryptow.`);
    }
    columnMap[key] = colIndex;
  }
  for (const [key, label] of Object.entries(OPTIONAL_HEADER_LABELS)) {
    const colIndex = headerRow.findIndex((cell) => normalize(cell) === normalize(label));
    if (colIndex !== -1) columnMap[key] = colIndex;
  }

  return { headerRowIndex, columnMap, sheetName: resolvedSheetName };
}

async function listDistinctColumnValues(spreadsheetId, columnKey) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();
  const colLetter = columnIndexToLetter(columnMap[columnKey]);
  const startRow = headerRowIndex + 2; // 1-based, first row after header

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${colLetter}${startRow}:${colLetter}`,
  });

  const values = (res.data.values || []).flat().map((v) => (v || "").toString().trim());
  const unique = [...new Set(values.filter(Boolean))];
  return unique.sort((a, b) => a.localeCompare(b, "pl"));
}

/**
 * Returns the treatment picker list: raw "Zabieg" values grouped into
 * canonical categories (depilacja/epilacja etc. merged, "A + B" combos split,
 * "(problem aware)" tag stripped) - see zabiegCategories.js.
 */
export async function listZabiegCategories(spreadsheetId) {
  return groupZabiegCategories(await listDistinctColumnValues(spreadsheetId, "zabieg"));
}

/**
 * Returns the distinct, non-empty "Klient" values currently in the sheet,
 * sorted alphabetically - used to populate the client picker in Discord.
 * The seeded problem-aware pattern row is not a real client, so it's hidden.
 */
export async function listKlienci(spreadsheetId) {
  const klienci = await listDistinctColumnValues(spreadsheetId, "klient");
  return klienci.filter((k) => normalize(k) !== normalize(PROBLEM_AWARE_SEED_KLIENT));
}

async function readDataRows(spreadsheetId) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A${headerRowIndex + 2}:Z`,
  });
  return (res.data.values || []).map((row) => ({
    czyj: row[columnMap.czyj] || "",
    klient: row[columnMap.klient] || "",
    briefLink: row[columnMap.briefLink] || "",
    skryptLink: row[columnMap.skryptLink] || "",
    zabieg: row[columnMap.zabieg] || "",
  }));
}

/**
 * Returns the first standard (non-problem-aware) row whose Zabieg falls in
 * the same canonical category, used as a single style/reference example for
 * the AI generator. Returns null if no past script exists for that category.
 */
export async function findReferenceScriptForZabieg(spreadsheetId, zabieg) {
  const rows = await readDataRows(spreadsheetId);
  return rows.find((r) => !isProblemAwareZabieg(r.zabieg) && zabiegMatches(r.zabieg, zabieg)) || null;
}

/**
 * Returns up to `limit` problem-aware rows to use as examples, those for the
 * same treatment category first, then the newest of the rest (which always
 * includes the seeded base pattern once it's in the sheet).
 */
export async function findProblemAwareReferences(spreadsheetId, zabiegi, limit = 2) {
  const rows = (await readDataRows(spreadsheetId)).filter((r) => isProblemAwareZabieg(r.zabieg) && r.skryptLink);
  const sameCategory = rows.filter((r) => zabiegi.some((z) => zabiegMatches(r.zabieg, z)));
  const others = rows.filter((r) => !sameCategory.includes(r)).reverse();
  return [...sameCategory, ...others].slice(0, limit);
}

/** True if the seeded problem-aware base pattern row already exists. */
export async function hasProblemAwareSeed(spreadsheetId) {
  const rows = await readDataRows(spreadsheetId);
  return rows.some(
    (r) => normalize(r.klient) === normalize(PROBLEM_AWARE_SEED_KLIENT) && isProblemAwareZabieg(r.zabieg)
  );
}

/**
 * Returns every past row for the given client (case-insensitive), used by
 * !skrypt to detect whether a client already exists in the "database" (this
 * sheet) so it can reuse their prior treatments/scripts as context instead of
 * asking the new-client brief questions.
 */
export async function findClientHistory(spreadsheetId, klient) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();
  const startRow = headerRowIndex + 2;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A${startRow}:Z`,
  });

  const rows = res.data.values || [];
  const matches = rows.filter((row) => normalize(row[columnMap.klient]) === normalize(klient));

  return matches.map((row) => ({
    zabieg: row[columnMap.zabieg] || "",
    briefLink: row[columnMap.briefLink] || "",
    skryptLink: row[columnMap.skryptLink] || "",
  }));
}

function todayDateStr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

/**
 * Appends one new row to the scripts sheet using values.append, which finds
 * the end of the contiguous table itself starting from the header row - the
 * blank rows above the header are never touched. Populates the "Data" column
 * with today's date if that column exists in the sheet (older copies of the
 * sheet without it are unaffected).
 */
export async function appendScriptRow(spreadsheetId, { czyj, klient, briefLink, skryptLink, zabieg }) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();

  const row = [];
  row[columnMap.czyj] = czyj || "";
  row[columnMap.klient] = klient || "";
  row[columnMap.briefLink] = briefLink || "";
  row[columnMap.skryptLink] = skryptLink || "";
  row[columnMap.zabieg] = zabieg || "";
  if (columnMap.data !== undefined) {
    row[columnMap.data] = todayDateStr();
  }
  for (let i = 0; i < row.length; i++) {
    if (row[i] === undefined) row[i] = "";
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A${headerRowIndex + 1}:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}
