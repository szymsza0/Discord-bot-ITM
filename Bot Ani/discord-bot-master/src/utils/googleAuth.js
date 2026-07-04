import { google } from "googleapis";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} from "../config.js";

let oauth2Client;

/**
 * Shared OAuth2 client for Sheets/Docs/Drive, authenticated via a long-lived
 * refresh_token (not a service account) - the googleapis client library
 * refreshes the access token automatically as needed.
 */
export function getOAuthClient() {
  if (oauth2Client) return oauth2Client;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Brak konfiguracji Google OAuth: ustaw GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN."
    );
  }

  oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

export function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getOAuthClient() });
}

export function getDocsClient() {
  return google.docs({ version: "v1", auth: getOAuthClient() });
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getOAuthClient() });
}
