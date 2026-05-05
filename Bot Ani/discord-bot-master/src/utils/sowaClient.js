import fetch from "node-fetch";
import { SOWA_COMMAND_SECRET, SOWA_COMMAND_URL } from "../config.js";

const REQUEST_TIMEOUT_MS = 10000;

function pickString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function isSowaConfigured() {
  return Boolean(pickString(SOWA_COMMAND_URL));
}

export async function executeSowaCommand({ command, args = [], text = "" }) {
  const endpoint = pickString(SOWA_COMMAND_URL);
  if (!endpoint) {
    throw new Error(
      "Brak konfiguracji SOWA_COMMAND_URL. Ustaw pełny URL endpointu komend SOWA."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(pickString(SOWA_COMMAND_SECRET)
          ? { "x-discord-command-secret": pickString(SOWA_COMMAND_SECRET) }
          : {}),
      },
      body: JSON.stringify({
        command,
        args,
        text,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        payload?.message ||
        payload?.error ||
        `SOWA API zwróciło błąd HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Timeout połączenia z SOWA API (10s).");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

