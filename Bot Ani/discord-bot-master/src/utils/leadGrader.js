// src/utils/leadGrader.js
// Ocena "temperatury" leadów z CRM przez Claude Haiku (ostatnie komentarze),
// z cache po id karty + dacie ostatniej aktywności i zapasową oceną regułami
// (crmDigest.gradeByRules), gdy API nie odpowie albo zwróci złe dane.
// Haiku działa, gdy jest ANTHROPIC_API_KEY i nie ustawiono CRM_DIGEST_AI=0;
// inaczej oceniają same reguły słów kluczowych.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import dayjs from "dayjs";
import { ANTHROPIC_API_KEY, CRM_DIGEST_AI_DISABLED } from "../config.js";
import { TEMPERATURES, gradeByRules, applyStalenessCap, daysBetween, truncate } from "./crmDigest.js";

const GRADING_MODEL = "claude-haiku-5-5";
const TOOL_NAME = "ocen_leady";
const BATCH_SIZE = 15;
const COMMENTS_PER_CARD = 5;
// Ocena z cache jest ważna, dopóki karta się nie zmieni, ale nie dłużej niż
// tydzień - "dni bez ruchu" rosną także bez aktywności na karcie.
const CACHE_MAX_AGE_DAYS = 7;
const CACHE_PATH = path.join(process.cwd(), "data", "crm_grade_cache.json");

/** Czy ocena przez Claude jest włączona: jest klucz API i nie wyłączono jej CRM_DIGEST_AI=0. */
export function aiGradingConfigured(apiKey = ANTHROPIC_API_KEY, disabled = CRM_DIGEST_AI_DISABLED) {
  return Boolean(apiKey) && !disabled;
}

const anthropic = aiGradingConfigured() ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const GradeSchema = z.object({
  oceny: z.array(
    z.object({
      id: z.string().min(1),
      temperatura: z.enum(TEMPERATURES),
      powod: z.string().min(1),
      nastepny_krok: z.string().min(1),
      lost: z.boolean(),
    })
  ),
});

const gradeTool = {
  name: TOOL_NAME,
  description: "Zapisuje ocenę temperatury każdego leada z listy.",
  input_schema: {
    type: "object",
    properties: {
      oceny: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "id karty dokładnie jak w danych" },
            temperatura: { type: "string", enum: TEMPERATURES },
            powod: { type: "string", description: "jedno krótkie zdanie po polsku, max ok. 100 znaków" },
            nastepny_krok: { type: "string", description: "konkretny następny krok, max ok. 60 znaków" },
            lost: {
              type: "boolean",
              description: "true, gdy komentarze mówią, że klientka de facto zrezygnowała",
            },
          },
          required: ["id", "temperatura", "powod", "nastepny_krok", "lost"],
        },
      },
    },
    required: ["oceny"],
  },
};

const SYSTEM_PROMPT = `Oceniasz leady sprzedażowe agencji marketingowej ITM Beauty (kampanie Meta dla salonów beauty).
Każdy lead to karta w Trello z listą (etapem), terminem i komentarzami handlowców. Dla każdej karty wybierz temperaturę:
- gorący: decyzja na tak albo tuż przed nią (np. "zdecydowana", "99% na tak", "leci umowa", "poszła umowa", "decyzja na tak", "CA jutro"), umowa lub faktura w drodze.
- ciepły: rozmowa trwa, jest umówione spotkanie, oferta wysłana i klientka się odzywa.
- chłodny: brak odzewu od kilku dni, odkładanie decyzji, "ponowny kontakt za miesiąc".
- zimny: de facto stracony albo martwy: "pas", "rezygnuje", "nie stać", "już kogoś znalazła", "współpracę z inną", "nie jest zainteresowana", powtarzane "NOD" (nie odbiera), długo bez ruchu.
Najnowszy komentarz waży najwięcej. "lost" = true tylko, gdy komentarze mówią, że klientka zrezygnowała lub wybrała kogoś innego.
Powód: jedno zdanie, najlepiej z krótkim cytatem i datą komentarza. Następny krok: konkret dla handlowca (kto/co/kiedy), bez ogólników.
Pisz po polsku. Oceń wszystkie karty, wywołując narzędzie ${TOOL_NAME} raz.`;

// Telefonów i e-maili klientek nie wysyłamy do API - do oceny nie są potrzebne.
function redact(text) {
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[e-mail]")
    .replace(/\+?\d[\d \-]{7,}\d/g, "[telefon]");
}

function cardPrompt(entry, now) {
  const days = daysBetween(entry.dateLastActivity, now);
  const due = entry.due
    ? `${dayjs(entry.due).format("DD.MM.YYYY HH:mm")}${entry.dueComplete ? " (odhaczony)" : dayjs(entry.due).isBefore(now) ? " (minął)" : ""}`
    : "brak";
  const comments = entry.comments.slice(0, COMMENTS_PER_CARD);
  const commentLines = comments.length
    ? comments
        .map((c) => `  - ${dayjs(c.date).format("DD.MM")} ${c.author || "?"}: ${truncate(redact(c.text).replace(/\s+/g, " "), 400)}`)
        .join("\n")
    : "  (brak komentarzy)";
  return [
    `id: ${entry.id}`,
    `lead: ${redact(entry.name)}`,
    `lista: ${entry.listName}`,
    `opiekun: ${entry.owners.join(", ") || "brak"}`,
    `dni od ostatniej aktywności: ${days ?? "?"}`,
    `termin: ${due}`,
    `komentarze (najnowsze pierwsze):\n${commentLines}`,
  ].join("\n");
}

function formatZodError(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function extractAndValidate(response) {
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { toolUse: null, parsed: { success: false, error: null } };
  return { toolUse, parsed: GradeSchema.safeParse(toolUse.input) };
}

/**
 * Jedno wywołanie Haiku dla paczki kart, z jedną rundą naprawy przy błędzie
 * walidacji (ten sam wzorzec co scriptGenerator.js). Rzuca, gdy się nie uda.
 */
async function gradeBatchWithClaude(batch, now) {
  const today = dayjs(now).format("DD.MM.YYYY");
  const messages = [
    {
      role: "user",
      content: `Dziś jest ${today}. Oceń ${batch.length} kart:\n\n${batch
        .map((e) => cardPrompt(e, now))
        .join("\n\n---\n\n")}`,
    },
  ];
  const baseParams = {
    model: GRADING_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [gradeTool],
    tool_choice: { type: "tool", name: TOOL_NAME },
  };

  let response = await anthropic.messages.create({ ...baseParams, messages });
  let { toolUse, parsed } = extractAndValidate(response);

  if (!parsed.success) {
    if (toolUse) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Odpowiedź nie przeszła walidacji, popraw ją i wywołaj ${TOOL_NAME} ponownie. Błędy: ${formatZodError(parsed.error)}`,
          },
        ],
      });
    } else {
      messages.push({ role: "user", content: `Nie wywołałeś narzędzia ${TOOL_NAME}. Wywołaj wyłącznie to narzędzie.` });
    }
    response = await anthropic.messages.create({ ...baseParams, messages });
    ({ toolUse, parsed } = extractAndValidate(response));
  }

  if (!parsed.success) {
    throw new Error(parsed.error ? formatZodError(parsed.error) : "Brak wywołania narzędzia w odpowiedzi.");
  }
  return parsed.data.oceny;
}

async function loadCache(cachePath) {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch {
    return {};
  }
}

async function saveCache(cache, cachePath) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache));
  } catch (err) {
    console.warn("⚠️ Nie udało się zapisać cache ocen CRM:", err.message);
  }
}

function cacheKey(entry) {
  return `${entry.id}|${entry.dateLastActivity}`;
}

/**
 * Ocenia karty: najpierw cache, potem Claude Haiku w paczkach, a dla tego,
 * czego nie udało się ocenić - reguły. Zwraca { grades, aiError }: grades to
 * mapa id karty → { temperature, reason, nextStep, lost, source }, aiError to
 * krótki opis błędu Claude (do stopki przeglądu) albo null.
 * @param {Array} entries - karty z prepareEntries (tylko oceniane listy)
 * @param {object} [options]
 * @param {boolean} [options.useAi=true] - false wymusza reguły nawet przy włączonym CRM_DIGEST_AI
 * @param {string} [options.cachePath] - plik cache (domyślnie data/crm_grade_cache.json)
 */
export async function gradeEntries(entries, now, { useAi = true, cachePath = CACHE_PATH } = {}) {
  const grades = {};
  let aiError = null;
  const cache = await loadCache(cachePath);
  const freshCache = {};
  const toGrade = [];

  for (const entry of entries) {
    const cached = cache[cacheKey(entry)];
    if (cached && daysBetween(cached.gradedAt, now) < CACHE_MAX_AGE_DAYS) {
      grades[entry.id] = applyStalenessCap({ ...cached.grade, source: "Claude (cache)" }, entry, now);
      freshCache[cacheKey(entry)] = cached;
    } else {
      toGrade.push(entry);
    }
  }

  if (useAi && anthropic && toGrade.length) {
    for (let i = 0; i < toGrade.length; i += BATCH_SIZE) {
      const batch = toGrade.slice(i, i + BATCH_SIZE);
      try {
        const results = await gradeBatchWithClaude(batch, now);
        const byId = Object.fromEntries(results.map((r) => [r.id, r]));
        for (const entry of batch) {
          const r = byId[entry.id];
          if (!r) continue;
          const grade = {
            temperature: r.temperatura,
            reason: truncate(r.powod, 140),
            nextStep: truncate(r.nastepny_krok, 90),
            lost: r.lost,
          };
          freshCache[cacheKey(entry)] = { grade, gradedAt: dayjs(now).toISOString() };
          grades[entry.id] = applyStalenessCap({ ...grade, source: "Claude" }, entry, now);
        }
      } catch (err) {
        console.error(`🚨 Ocena leadów przez Claude nie powiodła się (paczka ${i / BATCH_SIZE + 1}):`, err.message);
        aiError = err instanceof Anthropic.APIError && err.status ? `HTTP ${err.status}` : "błąd odpowiedzi";
        // Zły / wygasły klucz albo brak uprawnień - kolejne paczki skończą się tak samo.
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) break;
      }
    }
  }

  for (const entry of entries) {
    if (!grades[entry.id]) grades[entry.id] = gradeByRules(entry, now);
  }

  // Zapisujemy tylko oceny kart widzianych w tym przebiegu - reszta wypada.
  await saveCache(freshCache, cachePath);
  return { grades, aiError };
}
