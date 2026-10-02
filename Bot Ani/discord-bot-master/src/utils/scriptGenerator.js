import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";
import {
  PROBLEM_AWARE_HOOK_COUNT,
  PROBLEM_AWARE_MAX_CHARS,
  PROBLEM_AWARE_SHORTEN_ABOVE_CHARS,
  PROBLEM_AWARE_REFERENCE_SCRIPT,
  PROBLEM_AWARE_RULES,
} from "./problemAwareTemplate.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const GENERATION_MODEL = "claude-sonnet-5";
const TOOL_NAME = "generate_script_variant";

export const ScriptVariantSchema = z.object({
  variantLabel: z.string().min(1),
  rolka: z.object({
    hook: z.string().min(10),
    hookVariantB: z.string().min(10).optional(),
    body: z.array(z.string().min(10)).min(3).max(5),
    promocja: z.string().min(10),
    cta: z.string().min(5),
  }),
  krotszaRolka: z.object({ tekst: z.string().min(20) }),
  sugerowanaNazwaPliku: z.string().min(5),
});

export const SCRIPT_TYPES = {
  STANDARD: "standard",
  PROBLEM_AWARE: "problem_aware",
};

// Problem-aware variants carry 5 alternative hooks instead of hook + hook B.
// rolka.hook is still filled (= hooks[0]) so downstream code that only knows
// about a single hook keeps working.
/** Character count of the main problem-aware reel (hooks + body + promo + CTA), without the short reel. */
export function problemAwareRolkaLength(variant) {
  const r = variant.rolka;
  return [...r.hooks, ...r.body, r.promocja, r.cta].reduce((sum, t) => sum + t.length, 0);
}

export const ProblemAwareVariantSchema = z.object({
  variantLabel: z.string().min(1),
  rolka: z.object({
    hooks: z.array(z.string().min(10)).length(PROBLEM_AWARE_HOOK_COUNT),
    body: z.array(z.string().min(10)).min(3).max(5),
    promocja: z.string().min(10),
    cta: z.string().min(5),
  }),
  krotszaRolka: z.object({ tekst: z.string().min(20) }),
  sugerowanaNazwaPliku: z.string().min(5),
});

export class ScriptGenerationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ScriptGenerationError";
    this.details = details;
  }
}

const generateScriptVariantTool = {
  name: TOOL_NAME,
  description:
    "Zwraca jeden kompletny, oryginalny wariant skryptu reklamowego (rolka dluzsza + krotsza) zgodny ze struktura Hook -> Kwestia 1..N -> Promocja -> CTA.",
  input_schema: {
    type: "object",
    properties: {
      variantLabel: {
        type: "string",
        description: "Krotka etykieta kreatywnego kata tego wariantu, np. 'Pytanie o problem' albo 'Future pacing'.",
      },
      rolka: {
        type: "object",
        properties: {
          hook: { type: "string", description: "Hook (ok. 3-6 sekund)." },
          hookVariantB: { type: "string", description: "Opcjonalny, alternatywny hook do testow A/B." },
          body: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 5,
            description: "3-5 blokow 'Kwestia N' skladajacych sie na Body.",
          },
          promocja: { type: "string", description: "Osobny blok promocji." },
          cta: { type: "string", description: "Wezwanie do dzialania." },
        },
        required: ["hook", "body", "promocja", "cta"],
      },
      krotszaRolka: {
        type: "object",
        properties: {
          tekst: { type: "string", description: "Skondensowana wersja rolki 15-30s (Hook + 1-2 zdania Body + Promocja + CTA)." },
        },
        required: ["tekst"],
      },
      sugerowanaNazwaPliku: {
        type: "string",
        description: "Sugerowana nazwa dokumentu wg schematu '[Klient] - [zabieg] - skrypty i wskazowki | ITM'.",
      },
    },
    required: ["variantLabel", "rolka", "krotszaRolka", "sugerowanaNazwaPliku"],
  },
};

const PROBLEM_AWARE_TOOL_NAME = "generate_problem_aware_script_variant";

const generateProblemAwareVariantTool = {
  name: PROBLEM_AWARE_TOOL_NAME,
  description:
    `Zwraca jeden kompletny wariant skryptu typu PROBLEM AWARE: ${PROBLEM_AWARE_HOOK_COUNT} alternatywnych hookow adresujacych grupe docelowa (lokalizacja + wiek), Kwestie 1..N, Promocja, CTA oraz krotsza rolka.`,
  input_schema: {
    type: "object",
    properties: {
      variantLabel: {
        type: "string",
        description: "Krotka etykieta kata tego wariantu, np. 'Wstyd bez makijazu'.",
      },
      rolka: {
        type: "object",
        properties: {
          hooks: {
            type: "array",
            items: { type: "string" },
            minItems: PROBLEM_AWARE_HOOK_COUNT,
            maxItems: PROBLEM_AWARE_HOOK_COUNT,
            description: `Dokladnie ${PROBLEM_AWARE_HOOK_COUNT} alternatywnych hookow, kazdy z innym katem; wiekszosc z lokalizacja i konkretnym przedzialem wieku.`,
          },
          body: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 5,
            description: "3-5 blokow 'Kwestia N': empatia/problem -> jest sposob + dowod -> zasluga/emocja.",
          },
          promocja: { type: "string", description: "Blok promocji." },
          cta: { type: "string", description: "Wezwanie do dzialania." },
        },
        required: ["hooks", "body", "promocja", "cta"],
      },
      krotszaRolka: {
        type: "object",
        properties: {
          tekst: { type: "string", description: "Skondensowana wersja rolki 15-30s w jednym akapicie." },
        },
        required: ["tekst"],
      },
      sugerowanaNazwaPliku: {
        type: "string",
        description: "Sugerowana nazwa dokumentu wg schematu '[Klient] - [zabieg] (problem aware) - skrypty i wskazowki | ITM'.",
      },
    },
    required: ["variantLabel", "rolka", "krotszaRolka", "sugerowanaNazwaPliku"],
  },
};

const ANALYZE_COVERAGE_TOOL_NAME = "analyze_brief_coverage";

const BriefCoverageSchema = z.object({
  results: z.array(
    z.object({
      question: z.string().min(1),
      answered: z.boolean(),
      source: z.enum(["opis", "historia_klienta", "brak"]),
      suggestedAnswer: z.string().optional(),
    })
  ),
});

const analyzeBriefCoverageTool = {
  name: ANALYZE_COVERAGE_TOOL_NAME,
  description:
    "Dla kazdego pytania briefowego okresla, czy odpowiedz juz wynika z opisu podanego przez operatora lub z historii klienta, " +
    "i jesli tak - podaje krotka sugerowana odpowiedz (cytat/parafraze ze zrodla).",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "Jeden wpis na kazde pytanie, w tej samej kolejnosci co pytania w promptcie.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "Tresc pytania, dokladnie jak w promptcie." },
            answered: { type: "boolean", description: "Czy odpowiedz da sie ustalic z opisu lub historii klienta." },
            source: {
              type: "string",
              enum: ["opis", "historia_klienta", "brak"],
              description: "Skad pochodzi odpowiedz: z opisu operatora, z historii klienta, albo brak (nie ustalono).",
            },
            suggestedAnswer: {
              type: "string",
              description: "Krotka sugerowana odpowiedz, jesli answered=true. Pomin, jesli answered=false.",
            },
          },
          required: ["question", "answered", "source"],
        },
      },
    },
    required: ["results"],
  },
};

/**
 * Best-effort check of which of the new-client brief questions are already
 * answered by the operator's pasted description and/or the client's prior
 * briefs/scripts, so !skrypt only has to ask about genuine gaps instead of
 * re-asking things already on record. Any failure here (bad response, schema
 * mismatch) should be treated by the caller as "nothing resolved" - it's a
 * shortcut, not a hard requirement.
 */
export async function analyzeBriefCoverage({ questions, description, clientHistoryText }) {
  const parts = [`Opis zabiegu / USP podany przez operatora:\n${description}`];
  if (clientHistoryText) {
    parts.push(`Historia tego klienta w bazie (poprzednie briefy/skrypty):\n${clientHistoryText}`);
  }
  parts.push(
    "Ponizsze pytania nalezy sprawdzic - dla kazdego okresl, czy odpowiedz juz wynika z powyzszych tresci " +
      "(opisu operatora lub historii klienta), czy trzeba o nia dopytac operatora:\n" +
      questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  );
  parts.push(
    `Wywolaj narzedzie ${ANALYZE_COVERAGE_TOOL_NAME} z dokladnie ${questions.length} wpisami w results, po jednym na kazde pytanie, w tej samej kolejnosci.`
  );

  const response = await anthropic.messages.create({
    model: GENERATION_MODEL,
    max_tokens: 2048,
    tools: [analyzeBriefCoverageTool],
    tool_choice: { type: "tool", name: ANALYZE_COVERAGE_TOOL_NAME },
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Brak odpowiedzi narzedzia przy analizie pokrycia briefu.");

  const parsed = BriefCoverageSchema.safeParse(toolUse.input);
  if (!parsed.success) throw new Error(formatZodErrorForClaude(parsed.error));
  if (parsed.data.results.length !== questions.length) {
    throw new Error("Liczba wynikow analizy pokrycia briefu nie zgadza sie z liczba pytan.");
  }

  return parsed.data.results;
}

function formatZodErrorForClaude(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function extractAndValidate(response, schema) {
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { toolUse: null, parsed: { success: false, error: null } };
  const parsed = schema.safeParse(toolUse.input);
  return { toolUse, parsed };
}

function buildUserPrompt({
  klient,
  zabiegi,
  briefsText,
  referenceScriptText,
  variantIndex,
  totalVariants,
  previousVariantSummaries,
  scriptType,
  grupaDocelowa,
  toolName,
}) {
  const isProblemAware = scriptType === SCRIPT_TYPES.PROBLEM_AWARE;
  const parts = [];
  parts.push(`Klient: ${klient}`);
  parts.push(`Zabieg(i) do uwzglednienia w tym skrypcie: ${zabiegi.join(", ")}`);
  if (isProblemAware) {
    parts.push(PROBLEM_AWARE_RULES);
    parts.push(
      grupaDocelowa
        ? `Grupa docelowa (uzyj w hookach - lokalizacja i wiek): ${grupaDocelowa}`
        : "Grupa docelowa nie zostala podana wprost - ustal lokalizacje i przedzial wieku z briefu, a jesli ich brak, dobierz typowy przedzial wieku dla tego zabiegu."
    );
    parts.push(
      "--- WZOR SKRYPTU PROBLEM AWARE (bazowa struktura, ton i rytm - przenies na ten zabieg i klienta, NIE kopiuj zdan 1:1; wzor jest nieco dluzszy niz limit dlugosci - Twoja wersja ma byc zwiezlejsza) ---\n" +
        PROBLEM_AWARE_REFERENCE_SCRIPT
    );
  }
  parts.push(`To jest wariant ${variantIndex} z ${totalVariants} generowanych w tej samej turze.`);

  if (previousVariantSummaries.length) {
    parts.push(
      "Poprzednie warianty w tej turze uzyly juz ponizszych hookow/katow - ten wariant MUSI byc wyraznie inny (inny kat, inny hook, inne sformulowania):\n" +
        previousVariantSummaries.map((s, i) => `Wariant ${i + 1}: ${s}`).join("\n")
    );
  }

  parts.push(`--- BRIEF(Y) DLA TEGO ZABIEGU/ZABIEGOW ---\n${briefsText}`);

  if (referenceScriptText) {
    parts.push(
      (isProblemAware
        ? "--- WCZESNIEJSZE SKRYPTY PROBLEM AWARE Z BAZY (inspiracja stylem i tonem, NIE kopiuj tresci ani konkretow klienta) ---\n"
        : "--- PRZYKLADOWY, WCZESNIEJSZY SKRYPT DLA TEJ SAMEJ KATEGORII ZABIEGU (inspiracja stylem i tonem, NIE kopiuj tresci ani konkretow klienta) ---\n") +
        referenceScriptText
    );
  }

  parts.push(`Napisz nowy, oryginalny skrypt reklamowy zgodny z powyzszymi wytycznymi, wywolujac narzedzie ${toolName}.`);
  return parts.join("\n\n");
}

/**
 * Generates one validated script variant. Uses Claude's tool-use with a
 * strict JSON schema so malformed output is a structured, catchable error
 * rather than a silently broken doc: on the first schema-validation failure,
 * the exact zod error is fed back to Claude as a tool_result error for one
 * automatic repair round-trip. If that still fails, throws
 * ScriptGenerationError instead of ever creating a Doc/Sheet row.
 *
 * templateRulesText is passed with cache_control so the (large, static)
 * style-guide prompt is only billed at full price once per process, and
 * reused across every variant/repair call within a run.
 */
export async function generateScriptVariant({
  templateRulesText,
  briefsText,
  referenceScriptText,
  zabiegi,
  klient,
  variantIndex,
  totalVariants,
  previousVariantSummaries = [],
  scriptType = SCRIPT_TYPES.STANDARD,
  grupaDocelowa = null,
}) {
  const isProblemAware = scriptType === SCRIPT_TYPES.PROBLEM_AWARE;
  const toolName = isProblemAware ? PROBLEM_AWARE_TOOL_NAME : TOOL_NAME;
  const schema = isProblemAware ? ProblemAwareVariantSchema : ScriptVariantSchema;

  const messages = [
    {
      role: "user",
      content: buildUserPrompt({
        klient,
        zabiegi,
        briefsText,
        referenceScriptText,
        variantIndex,
        totalVariants,
        previousVariantSummaries,
        scriptType,
        grupaDocelowa,
        toolName,
      }),
    },
  ];

  const baseParams = {
    model: GENERATION_MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: templateRulesText, cache_control: { type: "ephemeral" } }],
    tools: [isProblemAware ? generateProblemAwareVariantTool : generateScriptVariantTool],
    tool_choice: { type: "tool", name: toolName },
  };

  let response = await anthropic.messages.create({ ...baseParams, messages });
  let { toolUse, parsed } = extractAndValidate(response, schema);

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
            content: `Odpowiedz nie przeszla walidacji schematu, popraw ja i wywolaj narzedzie ${toolName} ponownie z poprawnymi argumentami. Bledy: ${formatZodErrorForClaude(
              parsed.error
            )}`,
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: `Nie wywolales narzedzia ${toolName}. Sprobuj ponownie i wywolaj wylacznie to narzedzie z kompletnymi argumentami.`,
      });
    }

    response = await anthropic.messages.create({ ...baseParams, messages });
    ({ toolUse, parsed } = extractAndValidate(response, schema));
  }

  if (!parsed.success) {
    throw new ScriptGenerationError(
      `Nie udalo sie wygenerowac poprawnego skryptu dla "${zabiegi.join(", ")}" po probie naprawy.`,
      parsed.error ? formatZodErrorForClaude(parsed.error) : "Brak odpowiedzi narzedzia od Claude."
    );
  }

  if (isProblemAware) {
    let data = parsed.data;
    const length = problemAwareRolkaLength(data);
    if (length > PROBLEM_AWARE_SHORTEN_ABOVE_CHARS) {
      // Soft limit: one shortening pass, and the shorter valid result wins.
      // A failed/longer retry just keeps the original - never an error.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content:
              `Rolka (${PROBLEM_AWARE_HOOK_COUNT} hookow + Kwestie + Promocja + CTA) ma ${length} znakow, a wytyczna to ok. ${PROBLEM_AWARE_MAX_CHARS}. ` +
              `Skroc ja do ok. ${PROBLEM_AWARE_MAX_CHARS} znakow: krotsze hooki (jedno zdanie), zwiezlejsze Kwestie, bez powtorzen - zachowaj kat, grupe docelowa (miasto + wiek) i strukture. ` +
              `Wywolaj ${toolName} ponownie z pelnym, skroconym wariantem.`,
          },
        ],
      });
      try {
        const shortened = extractAndValidate(await anthropic.messages.create({ ...baseParams, messages }), schema);
        if (shortened.parsed.success && problemAwareRolkaLength(shortened.parsed.data) < length) {
          data = shortened.parsed.data;
        }
      } catch (err) {
        console.warn("Skracanie skryptu problem aware nie powiodlo sie, zostawiam oryginal:", err.message);
      }
    }
    return { ...data, scriptType, rolka: { ...data.rolka, hook: data.rolka.hooks[0] } };
  }
  return { ...parsed.data, scriptType };
}
