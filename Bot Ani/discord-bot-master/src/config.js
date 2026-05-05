import dotenv from 'dotenv';
dotenv.config();

export const TRELLO_API_BASE = "https://api.trello.com/1";
export const TRELLO_KEY = process.env.TRELLO_KEY;
export const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID;
export const SOWA_COMMAND_URL = process.env.SOWA_COMMAND_URL;
export const SOWA_COMMAND_SECRET = process.env.SOWA_COMMAND_SECRET;
