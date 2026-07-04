import dotenv from "dotenv";
dotenv.config();

import { getSheetsClient } from "../utils/googleAuth.js";
import { fetchDocPlainText } from "../utils/googleDocs.js";
import {
  GOOGLE_SCRIPTS_SHEET_ID,
  GOOGLE_SCRIPT_TEMPLATE_DOC_ID,
} from "../config.js";

async function testGoogleAuth() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.error("❌ Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN w .env");
    return;
  }

  try {
    console.log("→ Test odczytu arkusza (Sheets API)...");
    const sheets = getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SCRIPTS_SHEET_ID,
      fields: "sheets.properties.title",
    });
    console.log("✅ Nazwa zakładki:", meta.data.sheets?.[0]?.properties?.title);

    console.log("→ Test odczytu dokumentu szablonu (Drive export)...");
    const text = await fetchDocPlainText(GOOGLE_SCRIPT_TEMPLATE_DOC_ID);
    console.log("✅ Pierwsze 300 znakow szablonu:\n", text.slice(0, 300));
  } catch (error) {
    console.error("\n❌ Błąd:");
    console.error("Typ:", error.constructor.name);
    console.error("Wiadomość:", error.message);
    if (error.response?.data) {
      console.error("Odpowiedz API:", JSON.stringify(error.response.data));
    }
  }
}

testGoogleAuth();
