import { getSheetsClient } from "./googleAuth.js";

// The "LP" tab lives in the same spreadsheet as the scripts sheet, so unlike
// scriptSheet.js this can't just read the first tab in the workbook - it
// must always target this tab by name explicitly.
const SHEET_NAME = "LP";

// Baza LP ("LP" tab) columns, as they actually exist:
// Data | Czyj? (PM) | Klient | Link do briefu | Link do materiału | Link do LP | Zabieg
const REQUIRED_HEADER_LABELS = {
  zabieg: "Zabieg",
  klient: "Klient",
  briefLink: "Link do briefu",
  strona: "Link do LP",
  czyj: "Czyj? (PM)",
};

// Optional so an older/hand-edited copy of the sheet missing these columns
// doesn't break the rest of the bot - same tolerance as scriptSheet.js's
// "Data" column.
const OPTIONAL_HEADER_LABELS = {
  materialy: "Link do materiału",
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

/**
 * Same tolerant-header-scan approach as scriptSheet.js's findHeaderRow: the
 * sheet may have blank leading rows, so scan for the row containing "Zabieg"
 * instead of assuming a fixed row index. Always targets the "LP" tab by
 * name (not the first tab in the workbook) since this spreadsheet also
 * holds the unrelated scripts sheet as another tab.
 */
export async function findHeaderRow(spreadsheetId, sheetName = SHEET_NAME) {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z50`,
  });

  const rows = res.data.values || [];
  const headerRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalize(cell) === normalize(REQUIRED_HEADER_LABELS.zabieg))
  );

  if (headerRowIndex === -1) {
    throw new Error(`Nie znaleziono wiersza nagłówka (kolumna "Zabieg") w pierwszych 50 wierszach arkusza "${sheetName}".`);
  }

  const headerRow = rows[headerRowIndex];
  const columnMap = {};
  for (const [key, label] of Object.entries(REQUIRED_HEADER_LABELS)) {
    const colIndex = headerRow.findIndex((cell) => normalize(cell) === normalize(label));
    if (colIndex === -1) {
      throw new Error(`Nie znaleziono kolumny "${label}" w nagłówku arkusza "${sheetName}".`);
    }
    columnMap[key] = colIndex;
  }
  for (const [key, label] of Object.entries(OPTIONAL_HEADER_LABELS)) {
    const colIndex = headerRow.findIndex((cell) => normalize(cell) === normalize(label));
    if (colIndex !== -1) columnMap[key] = colIndex;
  }

  return { headerRowIndex, columnMap, sheetName };
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
 * Distinct, non-empty "Zabieg" values - populates the treatment picker in
 * Discord (askOptionsOrOther, same UI pattern as !skrypt's own picker).
 */
export async function listZabiegiLP(spreadsheetId) {
  return listDistinctColumnValues(spreadsheetId, "zabieg");
}

async function getDataRows(spreadsheetId) {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(spreadsheetId);
  const sheets = getSheetsClient();
  const startRow = headerRowIndex + 2;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A${startRow}:Z`,
  });

  return { rows: res.data.values || [], headerRowIndex, columnMap, sheetName, startRow };
}

/**
 * Returns the brief link (NOT the finished page) of the first existing LP row
 * for the same "Zabieg" - used purely as a style/tone reference for
 * generateLPCopy, same anti-copying principle as !skrypt's reference script:
 * inspiration, never content to copy.
 */
export async function findReferenceLPForZabieg(spreadsheetId, zabieg) {
  const { rows, columnMap } = await getDataRows(spreadsheetId);
  const match = rows.find(
    (row) => normalize(row[columnMap.zabieg]) === normalize(zabieg) && row[columnMap.briefLink]
  );
  if (!match) return null;

  return {
    klient: match[columnMap.klient] || "",
    briefLink: match[columnMap.briefLink] || "",
  };
}

function todayDateStr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

/**
 * Unlike appendScriptRow (always appends), !LP wants exactly one row per
 * (Klient, Zabieg) - updated in place on repeat deployments rather than
 * piling up duplicate rows. Matches an existing row by Brief link first (the
 * more specific key), falling back to (Klient + Zabieg); if found, only
 * Link do LP/Data are overwritten (existing Link do materiału/Czyj stay as
 * they were). If nothing matches, appends a brand-new row with every field.
 *
 * Called ONLY after wpCreatePage() succeeds (see lp.js) - if the page never
 * got created, there is nothing worth recording here.
 */
export async function upsertLPRow(spreadsheetId, { klient, zabieg, briefLink, materialy, strona, czyj }) {
  const { rows, columnMap, sheetName, startRow, headerRowIndex } = await getDataRows(spreadsheetId);
  const sheets = getSheetsClient();

  const existingIndex = rows.findIndex((row) => {
    const rowBrief = row[columnMap.briefLink];
    if (briefLink && rowBrief && normalize(rowBrief) === normalize(briefLink)) return true;
    return (
      normalize(row[columnMap.klient]) === normalize(klient) &&
      normalize(row[columnMap.zabieg]) === normalize(zabieg)
    );
  });

  if (existingIndex !== -1) {
    const sheetRowNumber = startRow + existingIndex;
    const updates = [
      { col: "strona", value: strona },
      { col: "data", value: todayDateStr() },
    ].filter(({ col }) => columnMap[col] !== undefined);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates.map(({ col, value }) => ({
          range: `${sheetName}!${columnIndexToLetter(columnMap[col])}${sheetRowNumber}`,
          values: [[value ?? ""]],
        })),
      },
    });
    return { updated: true, rowNumber: sheetRowNumber };
  }

  const row = [];
  row[columnMap.zabieg] = zabieg || "";
  row[columnMap.klient] = klient || "";
  row[columnMap.briefLink] = briefLink || "";
  row[columnMap.strona] = strona || "";
  row[columnMap.czyj] = czyj || "";
  if (columnMap.materialy !== undefined) row[columnMap.materialy] = materialy || "";
  if (columnMap.data !== undefined) row[columnMap.data] = todayDateStr();
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
  return { updated: false };
}
