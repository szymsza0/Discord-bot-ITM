import dotenv from "dotenv";
dotenv.config();

import { findHeaderRow, listZabiegCategories } from "../utils/scriptSheet.js";
import { GOOGLE_SCRIPTS_SHEET_ID } from "../config.js";

async function testScriptSheet() {
  try {
    console.log("→ Szukam wiersza naglowka...");
    const header = await findHeaderRow(GOOGLE_SCRIPTS_SHEET_ID);
    console.log("✅ Naglowek:", header);

    console.log("→ Pobieram liste kategorii zabiegow...");
    const categories = await listZabiegCategories(GOOGLE_SCRIPTS_SHEET_ID);
    console.log("✅ Kategorie:", categories);
  } catch (error) {
    console.error("\n❌ Błąd:");
    console.error("Typ:", error.constructor.name);
    console.error("Wiadomość:", error.message);
  }
}

testScriptSheet();
