import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";
import { downloadFileuploaderBuffer } from "./fileuploaderMedia.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MATCH_MODEL = "claude-sonnet-5";
const TOOL_NAME = "match_media_to_slots";

/**
 * Fixed slot config for now (spec section 4: "na razie stały config w
 * kodzie"), mirroring the keys already used in media/manifest.yaml from the
 * prep session. If this ever needs to vary per category, move it to a column
 * in Baza LP instead of guessing at per-category rules here.
 */
export const DEFAULT_MEDIA_SLOTS = [
  "logo",
  "hero_image",
  "offer_image",
  "expert_photo",
  "before_after_1",
  "before_after_2",
  "before_after_3",
  "before_after_4",
  "before_after_5",
];

// Claude vision only accepts these raster formats - SVG logos, video, PDFs
// etc. can't be "looked at", so they're routed to `skipped` instead of sent
// to the model.
const SUPPORTED_VISION_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const AssignmentSchema = z.object({
  sourceUrl: z.string().min(1),
  slot: z.string().nullable(),
  seoFileName: z.string().min(1),
  seoAltText: z.string().min(1),
  seoTitle: z.string().optional().default(""),
});

export const MatchMediaResultSchema = z.object({
  assignments: z.array(AssignmentSchema),
  unmatchedRequiredSlots: z.array(z.string()).optional().default([]),
});

export class MediaMatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "MediaMatchError";
    this.details = details;
  }
}

const matchMediaTool = {
  name: TOOL_NAME,
  description: "Dopasowuje pliki graficzne (bez etykiety) do slotow strony i generuje ich SEO nazwe/alt/tytul.",
  input_schema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sourceUrl: { type: "string", description: "oryginalny link fileuploadera dla tego pliku (z etykiety 'Plik: <url>')" },
            slot: { type: ["string", "null"], description: "klucz slotu, np. 'before_after_2', albo null jesli nic nie pasuje" },
            seoFileName: { type: "string", description: "nowa nazwa pliku, kebab-case, po polsku bez ogonkow" },
            seoAltText: { type: "string" },
            seoTitle: { type: "string" },
          },
          required: ["sourceUrl", "slot", "seoFileName", "seoAltText"],
        },
      },
      unmatchedRequiredSlots: { type: "array", items: { type: "string" } },
    },
    required: ["assignments", "unmatchedRequiredSlots"],
  },
};

function formatZodErrorForClaude(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function extractAndValidate(response) {
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { toolUse: null, parsed: { success: false, error: null } };
  const parsed = MatchMediaResultSchema.safeParse(toolUse.input);
  return { toolUse, parsed };
}

/**
 * Downloads each unlabeled fileuploader link (`unlabeledUrls`) and/or takes
 * already-fetched files (`items` - e.g. from a /share/ folder scan in lp.js,
 * where the bytes were already pulled down while listing the folder, so
 * there's no reason to fetch them a second time), sends the vision-readable
 * ones to Claude in one tool-use call alongside the list of slots still
 * needing a file, and returns the model's slot assignment + SEO metadata
 * (tool-use + zod + one repair round-trip, same pattern as generateLPCopy /
 * generateScriptVariant). Files whose content-type vision can't read (svg,
 * video, pdf...) come back in `skipped` instead of being sent to the model -
 * there's no way to "look" at them, so they're surfaced for the human
 * report (section 7) instead of silently dropped.
 */
export async function matchMediaToSlots({ unlabeledUrls = [], items = [], remainingSlots }) {
  if (unlabeledUrls.length === 0 && items.length === 0) {
    return { assignments: [], unmatchedRequiredSlots: remainingSlots, skipped: [] };
  }

  const fetchedFromUrls = await Promise.all(
    unlabeledUrls.map(async (url) => {
      const { buffer, contentType } = await downloadFileuploaderBuffer(url);
      return { url, buffer, contentType };
    })
  );
  const downloads = [...fetchedFromUrls, ...items];

  const visionReady = downloads.filter((d) => SUPPORTED_VISION_MIME_TYPES.has(d.contentType));
  const skipped = downloads
    .filter((d) => !SUPPORTED_VISION_MIME_TYPES.has(d.contentType))
    .map((d) => ({ url: d.displayName || d.url, contentType: d.contentType }));

  if (visionReady.length === 0) {
    return { assignments: [], unmatchedRequiredSlots: remainingSlots, skipped };
  }

  const imageBlocks = visionReady.flatMap((d) => [
    { type: "text", text: `Plik: ${d.url}` },
    { type: "image", source: { type: "base64", media_type: d.contentType, data: d.buffer.toString("base64") } },
  ]);

  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Dopasuj kazdy z ponizszych plikow do najlepiej pasujacego slotu z listy niewypelnionych slotow: ${remainingSlots.join(", ")}.\n` +
            `Jesli zaden slot nie pasuje do danego pliku, zwroc dla niego slot: null. Kazdy plik ma tekstowa etykiete "Plik: <url>" ` +
            `bezposrednio przed obrazkiem - uzyj tego url jako sourceUrl.\n` +
            `Wygeneruj tez SEO: nazwe pliku (kebab-case, po polsku, bez ogonkow), alt text i tytul.\n` +
            `Wywolaj narzedzie ${TOOL_NAME}.`,
        },
        ...imageBlocks,
      ],
    },
  ];

  const baseParams = {
    model: MATCH_MODEL,
    max_tokens: 2048,
    tools: [matchMediaTool],
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
            content: `Odpowiedz nie przeszla walidacji schematu, popraw ja i wywolaj narzedzie ${TOOL_NAME} ponownie. Bledy: ${formatZodErrorForClaude(
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
    throw new MediaMatchError(
      "Nie udalo sie dopasowac materialow do slotow po probie naprawy.",
      parsed.error ? formatZodErrorForClaude(parsed.error) : "Brak odpowiedzi narzedzia od Claude."
    );
  }

  return { ...parsed.data, skipped };
}
