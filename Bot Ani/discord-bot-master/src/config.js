import dotenv from 'dotenv';
dotenv.config();

export const TRELLO_API_BASE = "https://api.trello.com/1";
export const TRELLO_KEY = process.env.TRELLO_KEY;
export const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID;
// Kanał, na który !discovery wysyła codzienny przegląd dla Agnieszki i Szymona
export const DISCOVERY_CHANNEL_ID = process.env.DISCOVERY_CHANNEL_ID;
export const SOWA_COMMAND_URL = process.env.SOWA_COMMAND_URL;
export const SOWA_COMMAND_SECRET = process.env.SOWA_COMMAND_SECRET;

// Google OAuth2 (client_id/secret + long-lived refresh_token, not a service account)
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Baza skryptów reklamowych ITM
export const GOOGLE_SCRIPTS_SHEET_ID = process.env.GOOGLE_SCRIPTS_SHEET_ID;
export const GOOGLE_SCRIPT_TEMPLATE_DOC_ID = process.env.GOOGLE_SCRIPT_TEMPLATE_DOC_ID;
export const GOOGLE_SCRIPTS_DRIVE_FOLDER_ID = process.env.GOOGLE_SCRIPTS_DRIVE_FOLDER_ID;
