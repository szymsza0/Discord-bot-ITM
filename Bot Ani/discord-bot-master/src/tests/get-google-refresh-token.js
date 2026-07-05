import http from "node:http";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

// One-off manual utility: mints a new refresh_token for the existing
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET with the scopes !skrypt actually
// needs (drive, documents, spreadsheets), without going through a third
// party site. Run locally with:
//   railway run node src/tests/get-google-refresh-token.js
// (so it uses the client_id/secret already set in Railway, no local .env
// needed), then paste the printed refresh_token back into GOOGLE_REFRESH_TOKEN.

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error("❌ Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET w środowisku.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a new refresh_token even if already authorized before
  scope: SCOPES,
});

console.log("1. Otwórz ten link w przeglądarce i zaloguj się na konto Google z dostępem do arkusza/folderu:\n");
console.log(authUrl);
console.log("\n2. Zatwierdź dostęp - zostaniesz przekierowany na localhost, ta strona wykryje to automatycznie.\n");
console.log("Czekam na autoryzację...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>Błąd autoryzacji: ${error}</h2> Możesz zamknąć tę kartę.`);
    console.error(`❌ Google zwróciło błąd: ${error}`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h2>Gotowe ✅</h2> Możesz zamknąć tę kartę i wrócić do terminala.");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("✅ Nowy refresh token (wklej jako GOOGLE_REFRESH_TOKEN):\n");
    console.log(tokens.refresh_token);
  } catch (err) {
    console.error("❌ Nie udało się wymienić kodu na tokeny:", err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
