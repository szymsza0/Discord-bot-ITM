import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";

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

function formatZodErrorForClaude(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function extractAndValidate(response) {
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { toolUse: null, parsed: { success: false, error: null } };
  const parsed = ScriptVariantSchema.safeParse(toolUse.input);
  return { toolUse, parsed };
}

function buildUserPrompt({ klient, zabiegi, briefsText, referenceScriptText, variantIndex, totalVariants, previousVariantSummaries }) {
  const parts = [];
  parts.push(`Klient: ${klient}`);
  parts.push(`Zabieg(i) do uwzglednienia w tym skrypcie: ${zabiegi.join(", ")}`);
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
      "--- PRZYKLADOWY, WCZESNIEJSZY SKRYPT DLA TEJ SAMEJ KATEGORII ZABIEGU (inspiracja stylem i tonem, NIE kopiuj tresci ani konkretow klienta) ---\n" +
        referenceScriptText
    );
  }

  parts.push(`Napisz nowy, oryginalny skrypt reklamowy zgodny z powyzszymi wytycznymi, wywolujac narzedzie ${TOOL_NAME}.`);
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
}) {
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
      }),
    },
  ];

  const baseParams = {
    model: GENERATION_MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: templateRulesText, cache_control: { type: "ephemeral" } }],
    tools: [generateScriptVariantTool],
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
            content: `Odpowiedz nie przeszla walidacji schematu, popraw ja i wywolaj narzedzie ${TOOL_NAME} ponownie z poprawnymi argumentami. Bledy: ${formatZodErrorForClaude(
              parsed.error
            )}`,
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: `Nie wywolales narzedzia ${TOOL_NAME}. Sprobuj ponownie i wywolaj wylacznie to narzedzie z kompletnymi argumentami.`,
      });
    }

    response = await anthropic.messages.create({ ...baseParams, messages });
    ({ toolUse, parsed } = extractAndValidate(response));
  }

  if (!parsed.success) {
    throw new ScriptGenerationError(
      `Nie udalo sie wygenerowac poprawnego skryptu dla "${zabiegi.join(", ")}" po probie naprawy.`,
      parsed.error ? formatZodErrorForClaude(parsed.error) : "Brak odpowiedzi narzedzia od Claude."
    );
  }

  return parsed.data;
}
