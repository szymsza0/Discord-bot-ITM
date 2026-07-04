import { getSheetsClient } from "./googleAuth.js";

const HEADER_LABELS = {
  czyj: "Czyj?",
  klient: "Klient",
  briefLink: "Link do briefu",
  skryptLink: "Link do skryptu",
  zabieg: "Zabieg",
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
    row.some((cell) => normalize(cell) === normalize(HEADER_LABELS.zabieg))
  );

  if (headerRowIndex === -1) {
    throw new Error(
      `Nie znaleziono wiersza naglowka (kolumna "Zabieg") w pierwszych 50 wierszach arkusza skryptow.`
    );
  }

  const headerRow = rows[headerRowIndex];
  const columnMap = {};
  for (const [key, label] of Object.entries(HEADER_LABELS)) {
    const colIndex = headerRow.findIndex((cell) => normalize(cell) === normalize(label));
    if (colIndex === -1) {
      throw new Error(`Nie znaleziono kolumny "${label}" w naglowku arkusza skryptow.`);
    }
    columnMap[key] = colIndex;
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
 * Returns the distinct, non-empty "Zabieg" values currently in the sheet,
 * sorted alphabetically - used to populate the treatment picker in Discord.
 */
export async function listZabiegCategories(spreadsheetId) {
  return listDistinctColumnValues(spreadsheetId, "zabieg");
}

/**
 * Returns the distinct, non-empty "Klient" values currently in the sheet,
 * sorted alphabetically - used to populate the client picker in Discord.
 */
export async function listKlienci(spreadsheetId) {
  return listDistinctColumnValues(spreadsheetId, "klient");
}

/**
 * Returns the first sheet row whose Zabieg column matches the given
 * category (case-insensitive), used as a single style/reference example for
 * the AI generator. Returns null if no past script exists for that category.
 */
export async function findReferenceScriptForZabieg(spreadsheetId, zabieg) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();
  const startRow = headerRowIndex + 2;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A${startRow}:Z`,
  });

  const rows = res.data.values || [];
  const match = rows.find((row) => normalize(row[columnMap.zabieg]) === normalize(zabieg));
  if (!match) return null;

  return {
    czyj: match[columnMap.czyj] || "",
    klient: match[columnMap.klient] || "",
    briefLink: match[columnMap.briefLink] || "",
    skryptLink: match[columnMap.skryptLink] || "",
  };
}

/**
 * Appends one new row to the scripts sheet using values.append, which finds
 * the end of the contiguous table itself starting from the header row - the
 * blank rows above the header are never touched.
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
