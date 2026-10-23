#!/usr/bin/env node
// CLI dla Hermesa (agent ITM na serwerze): te same wzory, formatowanie dokumentu i baza skryptów
// co komenda !skrypt, ale tekst skryptu pisze sam agent (bez wywołania API z bota).
// Uruchamiany przez ~/itm-os/agent/skrypty.sh, który ładuje dane Google z ~/.config/itm-os/google.env.
//
//   lista                      (klienci i grupy zabiegów z bazy: dokładne nazwy do --klient i --zabiegi)
//   kontekst --klient K --zabiegi "A,B" [--typ standard|problem-aware] [--brief URL[,URL]] [--grupa "..."]
//   zapisz   --plik warianty.json --klient K --zabiegi "A,B" [--typ ...] [--brief URL|opis] [--czyj "..."]
//            [--poprawka URL]   (poprawka nadpisuje ten sam dokument i jego wiersz, bez nowego wiersza)
//   duble    [--usun]          (poprawki tego samego skryptu: ten sam klient + zabieg + dzień)
//   wyslij   --do briefy|leady PLIK [--nazwa "..."]
import fs from "node:fs";
import path from "node:path";
import { getDocsClient, getDriveClient, getSheetsClient } from "../utils/googleAuth.js";
import {
  fetchDocPlainText,
  buildScriptDocContent,
  createFormattedScriptDoc,
  moveDocToFolder,
  googleErrorMessage,
} from "../utils/googleDocs.js";
import {
  findHeaderRow,
  appendScriptRow,
  findReferenceScriptForZabieg,
  findProblemAwareReferences,
  findClientHistory,
  listKlienci,
  listZabiegCategories,
} from "../utils/scriptSheet.js";
import { getScriptTemplate, FIXED_CTA_NOTE } from "../utils/scriptTemplate.js";
import { ScriptVariantSchema, ProblemAwareVariantSchema, SCRIPT_TYPES } from "../utils/scriptGenerator.js";
import {
  PROBLEM_AWARE_RULES,
  PROBLEM_AWARE_REFERENCE_SCRIPT,
  PROBLEM_AWARE_HOOK_COUNT,
  PROBLEM_AWARE_MAX_CHARS,
  PROBLEM_AWARE_SEED_KLIENT,
} from "../utils/problemAwareTemplate.js";
import { tagProblemAware } from "../utils/zabiegCategories.js";

const SHEET_ID = process.env.GOOGLE_SCRIPTS_SHEET_ID;
const SCRIPTS_FOLDER_ID = process.env.GOOGLE_SCRIPTS_DRIVE_FOLDER_ID;
const FOLDERY = { briefy: process.env.GOOGLE_BRIEFY_FOLDER_ID, leady: process.env.GOOGLE_LEADY_FOLDER_ID };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

function lista(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function docIdFromUrl(url) {
  const match = (url || "").match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function wymagaj(args, ...keys) {
  const brak = keys.filter((k) => !args[k] || args[k] === true);
  if (brak.length) throw new Error(`Brak argumentów: ${brak.map((k) => "--" + k).join(", ")}`);
}

function typSkryptu(args) {
  return /problem/i.test(args.typ || "") ? SCRIPT_TYPES.PROBLEM_AWARE : SCRIPT_TYPES.STANDARD;
}

function tytulDokumentu(klient, zabiegi, scriptType) {
  const label = zabiegi.join(" + ");
  const zabiegLabel = scriptType === SCRIPT_TYPES.PROBLEM_AWARE ? tagProblemAware(label) : label;
  return { zabiegLabel, docTitle: `${klient} - ${zabiegLabel} - skrypty i wskazówki | ITM` };
}

function normalize(value) {
  return (value || "").toString().trim().toLowerCase();
}

async function kontekst(args) {
  wymagaj(args, "klient", "zabiegi");
  const klient = args.klient;
  const zabiegi = lista(args.zabiegi);
  const scriptType = typSkryptu(args);
  const isPA = scriptType === SCRIPT_TYPES.PROBLEM_AWARE;
  const template = await getScriptTemplate();
  const out = [];

  out.push(`# Kontekst skryptu: ${klient}, ${zabiegi.join(" + ")}${isPA ? " (problem aware)" : ""}`);
  out.push("## Wytyczne ITM (dokument szablonu, jak w !skrypt)\n" + template.rulesText);
  if (isPA) {
    out.push(`## Zasady problem aware\n${PROBLEM_AWARE_RULES}`);
    out.push(
      args.grupa
        ? `Grupa docelowa (użyj w hookach: lokalizacja i wiek): ${args.grupa}`
        : "Grupa docelowa nie jest podana: ustal lokalizację i przedział wieku z briefu, a gdy ich brak, dobierz typowy przedział wieku dla zabiegu."
    );
    out.push(
      "## Wzór skryptu problem aware (struktura, ton i rytm; przenieś na ten zabieg, nie kopiuj zdań; Twoja wersja ma być zwięźlejsza, ok. " +
        `${PROBLEM_AWARE_MAX_CHARS} znaków rolki)\n` + PROBLEM_AWARE_REFERENCE_SCRIPT
    );
  }

  const briefy = lista(args.brief).filter((b) => docIdFromUrl(b));
  if (briefy.length) {
    const teksty = [];
    for (const url of briefy) teksty.push(await fetchDocPlainText(docIdFromUrl(url)));
    out.push("## Brief(y)\n" + teksty.join("\n\n---\n\n") + "\n\n" + FIXED_CTA_NOTE);
  } else {
    out.push(
      "## Brief\nBrak linku do briefu: użyj opisu zabiegu i USP z rozmowy. Brakujące informacje uzupełnij pytaniami:\n" +
        template.briefQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n") + "\n\n" + FIXED_CTA_NOTE
    );
  }

  const refTexts = [];
  if (isPA) {
    for (const ref of await findProblemAwareReferences(SHEET_ID, zabiegi)) {
      if (ref.klient === PROBLEM_AWARE_SEED_KLIENT || !docIdFromUrl(ref.skryptLink)) continue;
      refTexts.push(`Zabieg: ${ref.zabieg} (klient: ${ref.klient}):\n${await fetchDocPlainText(docIdFromUrl(ref.skryptLink))}`);
    }
  } else {
    for (const zabieg of zabiegi) {
      const ref = await findReferenceScriptForZabieg(SHEET_ID, zabieg);
      if (ref?.skryptLink && docIdFromUrl(ref.skryptLink)) {
        refTexts.push(`Zabieg: ${zabieg} (klient: ${ref.klient}):\n${await fetchDocPlainText(docIdFromUrl(ref.skryptLink))}`);
      }
    }
  }
  if (refTexts.length) {
    out.push("## Wcześniejsze skrypty z bazy (inspiracja stylem i tonem, nie kopiuj treści ani konkretów klienta)\n" + refTexts.join("\n\n---\n\n"));
  }

  const historia = await findClientHistory(SHEET_ID, klient);
  out.push(
    historia.length
      ? "## Historia klienta w bazie\n" + historia.map((h) => `- ${h.zabieg}: ${h.skryptLink || "(bez linku)"}`).join("\n")
      : "## Historia klienta w bazie\nBrak (nowy klient w bazie skryptów)."
  );

  const { docTitle } = tytulDokumentu(klient, zabiegi, scriptType);
  const przyklad = isPA
    ? { variantLabel: "Kąt wariantu", rolka: { hooks: Array(PROBLEM_AWARE_HOOK_COUNT).fill("Hook ..."), body: ["Kwestia 1 ...", "Kwestia 2 ...", "Kwestia 3 ..."], promocja: "...", cta: "..." }, krotszaRolka: { tekst: "..." }, sugerowanaNazwaPliku: docTitle }
    : { variantLabel: "Kąt wariantu", rolka: { hook: "...", hookVariantB: "(opcjonalnie)", body: ["Kwestia 1 ...", "Kwestia 2 ...", "Kwestia 3 ..."], promocja: "...", cta: "..." }, krotszaRolka: { tekst: "..." }, sugerowanaNazwaPliku: docTitle };
  out.push(
    "## Wynik do zapisu\n" +
      `Zapisz warianty (domyślnie 2, każdy z innym kątem i hookiem) jako tablicę JSON w pliku i wywołaj \`skrypty.sh zapisz --plik <plik> ...\`. ` +
      `Kwestii 3-5. Krótsza rolka: 15-30 s w jednym akapicie. Tytuł dokumentu: „${docTitle}”.\n` +
      "```json\n" + JSON.stringify([przyklad], null, 2) + "\n```"
  );
  process.stdout.write(out.join("\n\n") + "\n");
}

async function nadpiszDokument(documentId, text, spans) {
  const docs = getDocsClient();
  const doc = await docs.documents.get({ documentId });
  const end = doc.data.body.content.at(-1).endIndex;
  const requests = [];
  if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
  requests.push({ insertText: { location: { index: 1 }, text } });
  for (const span of spans) {
    const range = { startIndex: span.start + 1, endIndex: span.end + 1 };
    requests.push(
      span.style === "BOLD"
        ? { updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } }
        : { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: span.style }, fields: "namedStyleType" } }
    );
  }
  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
}

function dzisiaj() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(-2)}`;
}

async function wierszeBazy() {
  const { headerRowIndex, columnMap, sheetName } = await findHeaderRow(SHEET_ID);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A${headerRowIndex + 2}:Z` });
  const rows = (res.data.values || []).map((row, i) => ({
    nr: headerRowIndex + 2 + i, // numer wiersza w arkuszu (1-based)
    klient: row[columnMap.klient] || "",
    zabieg: row[columnMap.zabieg] || "",
    skryptLink: row[columnMap.skryptLink] || "",
    data: columnMap.data !== undefined ? row[columnMap.data] || "" : "",
  }));
  return { rows, columnMap, sheetName };
}

function kolumna(index) {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  return letter;
}

async function zapisz(args) {
  wymagaj(args, "plik", "klient", "zabiegi");
  const klient = args.klient;
  const zabiegi = lista(args.zabiegi);
  const scriptType = typSkryptu(args);
  const isPA = scriptType === SCRIPT_TYPES.PROBLEM_AWARE;
  const schema = isPA ? ProblemAwareVariantSchema : ScriptVariantSchema;

  const surowe = JSON.parse(fs.readFileSync(args.plik, "utf8"));
  const warianty = (Array.isArray(surowe) ? surowe : [surowe]).map((v, i) => {
    const parsed = schema.safeParse(v);
    if (!parsed.success) {
      const bledy = parsed.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ");
      throw new Error(`Wariant ${i + 1} nie pasuje do wzoru: ${bledy}`);
    }
    return isPA ? { ...parsed.data, rolka: { ...parsed.data.rolka, hook: parsed.data.rolka.hooks[0] } } : parsed.data;
  });

  const template = await getScriptTemplate();
  const { zabiegLabel, docTitle } = tytulDokumentu(klient, zabiegi, scriptType);
  const { text, spans } = buildScriptDocContent(docTitle, warianty, template.recordingInstructionsText);
  const czyj = args.czyj && args.czyj !== true ? args.czyj : "Hermes";
  const briefLink = args.brief && args.brief !== true ? args.brief : "Brief tekstowy (bez linku, opis + USP)";

  if (args.poprawka) {
    const docId = docIdFromUrl(args.poprawka);
    if (!docId) throw new Error(`Nieprawidłowy link do poprawianego dokumentu: ${args.poprawka}`);
    await nadpiszDokument(docId, text, spans);
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    const { rows, columnMap, sheetName } = await wierszeBazy();
    const wiersz = rows.find((r) => docIdFromUrl(r.skryptLink) === docId);
    if (wiersz && columnMap.data !== undefined) {
      await getSheetsClient().spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!${kolumna(columnMap.data)}${wiersz.nr}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[dzisiaj()]] },
      });
    } else if (!wiersz) {
      await appendScriptRow(SHEET_ID, { czyj, klient, briefLink, skryptLink: docUrl, zabieg: zabiegLabel });
    }
    console.log(JSON.stringify({ akcja: "poprawka", dokument: docUrl, wiersz: wiersz ? wiersz.nr : "dopisany", warianty: warianty.length }));
    return;
  }

  const docId = await createFormattedScriptDoc(docTitle, text, spans);
  await moveDocToFolder(docId, SCRIPTS_FOLDER_ID);
  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  await appendScriptRow(SHEET_ID, { czyj, klient, briefLink, skryptLink: docUrl, zabieg: zabiegLabel });
  console.log(JSON.stringify({ akcja: "nowy", dokument: docUrl, tytul: docTitle, warianty: warianty.length }));
}

async function duble(args) {
  const { rows } = await wierszeBazy();
  const grupy = new Map();
  for (const r of rows) {
    if (!r.klient && !r.skryptLink) continue;
    // Poprawka tego samego skryptu = ten sam klient + zabieg tego samego dnia, albo ten sam link.
    const klucze = [`k:${normalize(r.klient)}|${normalize(r.zabieg)}|${r.data.trim()}`];
    if (r.skryptLink) klucze.push(`l:${docIdFromUrl(r.skryptLink) || r.skryptLink.trim()}`);
    for (const k of klucze) {
      if (k.startsWith("k:") && !r.data.trim()) continue;
      grupy.set(k, [...(grupy.get(k) || []), r]);
    }
  }
  const doUsuniecia = new Map();
  const raport = [];
  for (const [klucz, lista] of grupy) {
    if (lista.length < 2) continue;
    const zostaje = lista.at(-1); // najnowszy wiersz (niżej w arkuszu)
    raport.push({ klucz: klucz.slice(2), zostaje: zostaje.nr, usuwane: lista.slice(0, -1).map((r) => r.nr) });
    for (const r of lista.slice(0, -1)) if (r.nr !== zostaje.nr) doUsuniecia.set(r.nr, r);
  }
  if (!args.usun) {
    console.log(JSON.stringify({ duble: raport, wierszy_do_usuniecia: doUsuniecia.size }, null, 2));
    return;
  }
  const sheets = getSheetsClient();
  const { sheetName } = await findHeaderRow(SHEET_ID);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: "sheets.properties" });
  const sheetId = meta.data.sheets.find((s) => s.properties.title === sheetName).properties.sheetId;
  // Od dołu, żeby numery wyższych wierszy się nie przesuwały.
  const nry = [...doUsuniecia.keys()].sort((a, b) => b - a);
  if (nry.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: nry.map((nr) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: nr - 1, endIndex: nr } } })),
      },
    });
  }
  console.log(JSON.stringify({ usunieto: nry.length, wiersze: nry.sort((a, b) => a - b) }));
}

const KONWERSJE = {
  ".docx": "application/vnd.google-apps.document",
  ".doc": "application/vnd.google-apps.document",
  ".txt": "application/vnd.google-apps.document",
  ".md": "application/vnd.google-apps.document",
  ".odt": "application/vnd.google-apps.document",
  ".xlsx": "application/vnd.google-apps.spreadsheet",
  ".xls": "application/vnd.google-apps.spreadsheet",
  ".csv": "application/vnd.google-apps.spreadsheet",
  ".ods": "application/vnd.google-apps.spreadsheet",
};

// Typ wysyłanego pliku: bez niego Drive odrzuca konwersję (400 Bad Request).
const TYPY_PLIKOW = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".pdf": "application/pdf",
};

async function wyslij(args) {
  const plik = args._[1];
  const folderId = FOLDERY[args.do];
  if (!folderId) throw new Error("Podaj --do briefy albo --do leady.");
  if (!plik || !fs.existsSync(plik)) throw new Error(`Nie ma pliku: ${plik || "(brak)"}`);
  const ext = path.extname(plik).toLowerCase();
  const nazwa = args.nazwa && args.nazwa !== true ? args.nazwa : path.basename(plik, KONWERSJE[ext] ? ext : "");
  const drive = getDriveClient();
  const q = `'${folderId}' in parents and name = '${nazwa.replace(/'/g, "\\'")}' and trashed = false`;
  const istniejace = await drive.files.list({ q, fields: "files(id, webViewLink)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  const media = { mimeType: TYPY_PLIKOW[ext] || "application/octet-stream", body: fs.createReadStream(plik) };
  let plikDrive;
  if (istniejace.data.files.length) {
    // Ten sam plik w folderze: nowa wersja zamiast dubla.
    plikDrive = (await drive.files.update({ fileId: istniejace.data.files[0].id, media, fields: "id, webViewLink", supportsAllDrives: true })).data;
  } else {
    const requestBody = { name: nazwa, parents: [folderId], ...(KONWERSJE[ext] ? { mimeType: KONWERSJE[ext] } : {}) };
    plikDrive = (await drive.files.create({ requestBody, media, fields: "id, webViewLink", supportsAllDrives: true })).data;
  }
  console.log(JSON.stringify({ akcja: istniejace.data.files.length ? "nowa wersja" : "nowy", nazwa, link: plikDrive.webViewLink }));
}

async function listaBazy() {
  const [klienci, zabiegi] = await Promise.all([listKlienci(SHEET_ID), listZabiegCategories(SHEET_ID)]);
  console.log(JSON.stringify({ klienci, zabiegi }, null, 1));
}

const KOMENDY = { lista: listaBazy, kontekst, zapisz, duble, wyslij };

const args = parseArgs(process.argv.slice(2));
const komenda = KOMENDY[args._[0]];
if (!komenda) {
  console.error("Użycie: skrypty.sh lista|kontekst|zapisz|duble|wyslij ... (opis na górze src/cli/hermes-skrypty.js)");
  process.exit(2);
}
komenda(args).catch((err) => {
  console.error(`Błąd: ${googleErrorMessage(err)}`);
  process.exit(1);
});
