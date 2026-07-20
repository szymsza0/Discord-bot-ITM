import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const GENERATION_MODEL = "claude-sonnet-5";
const TOOL_NAME = "generate_lp_copy";

// Prefix for marketing-copy fields Claude fills in without brief support -
// visible directly on the draft page, so the operator sees exactly which
// sentences are a guess and need review/replacement before publishing.
// Never used for hard facts (prices, contact info, real testimonials,
// stats) - those still come back null/empty if the brief doesn't provide
// them, per the "never zmyślaj" rule.
export const ASSUMPTION_MARKER = "⚠️ ZAŁOŻENIE: ";

// Nullable AND optional: Claude may either omit a factual key entirely or
// return null for it - both mean "brief didn't say, don't invent it" and
// lpContentBuilder.js treats them identically (token stays unfilled).
const nullableString = z.string().nullable().optional();

/**
 * Mirrors the key contract in COPYWRITING_GUIDE.md ("Kontrakt kluczy") plus
 * `seo` (spec section 5, point 2 - LP title/meta description). Factual
 * fields (business.*, offer.price_*, etc.) are nullable so a missing answer
 * in the brief comes back as an explicit null, never a guess - see
 * COPYWRITING_GUIDE.md's "nigdy nie zmyślaj cen/adresu/lat doświadczenia".
 */
export const LPCopySchema = z.object({
  business: z.object({
    name: nullableString,
    address: nullableString,
    phone: nullableString,
    email: nullableString,
  }),
  hero: z.object({
    eyebrow: nullableString,
    headline: z.string().min(1),
    subheadline: z.string().min(1),
    body: nullableString,
    cta_label: z.string().min(1),
  }),
  stats: z.array(z.object({ value: nullableString, label: nullableString })).optional().default([]),
  usp: z.object({ title: z.string(), body: z.string() }).nullable().optional(),
  problems: z.array(z.object({ title: z.string(), body: z.string() })).optional().default([]),
  methods: z
    .array(z.object({ eyebrow: nullableString, title: z.string(), body: z.string() }))
    .optional()
    .default([]),
  synergy: z.object({ eyebrow: nullableString, title: z.string(), body: z.string() }).nullable().optional(),
  offer: z.object({
    name: nullableString,
    duration_label: nullableString,
    price_regular: nullableString,
    price_promo: nullableString,
    savings_label: nullableString,
    countdown_minutes: nullableString,
    limited_label: nullableString,
    // Cena omnibus (wymóg dyrektywy Omnibus UE przy pokazywaniu przeceny) i
    // etykieta CTA konkretnie tego bloku oferty - osobna od hero.cta_label,
    // bo w realnym szablonie to dwa różne przyciski z różnym tekstem.
    omnibus_price: nullableString,
    cta_label: z.string().min(1),
  }),
  gallery: z
    .object({
      title: nullableString,
      subtitle: nullableString,
      image_keys: z.array(z.string()).optional().default([]),
    })
    .optional()
    .default({ image_keys: [] }),
  trust: z.object({ title: nullableString, body_1: nullableString, body_2: nullableString }).nullable().optional(),
  testimonials: z
    .array(z.object({ name: z.string(), position: nullableString, quote: z.string() }))
    .optional()
    .default([]),
  steps: z
    .array(z.object({ title: z.string(), body: z.string(), bullets: z.array(z.string()).optional().default([]) }))
    .optional()
    .default([]),
  pricing_table: z.array(z.object({ name: z.string(), price: z.string() })).optional().default([]),
  pricing_note: nullableString,
  final_cta: z.object({ eyebrow: nullableString, title: z.string(), body: z.string() }),
  form: z.object({
    fields: z.array(z.string()).optional().default([]),
    dropdown_options: z.array(z.string()).optional().default([]),
    submit_label: z.string(),
  }),
  footer: z.object({ copyright: nullableString }).optional().default({}),
  seo: z.object({ title: z.string(), metaDescription: z.string() }),
});

export class LPGenerationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "LPGenerationError";
    this.details = details;
  }
}

const nullableStringSchema = { type: ["string", "null"] };

const generateLPCopyTool = {
  name: TOOL_NAME,
  description:
    "Zwraca kompletny, gotowy do wstawienia na stronę zestaw copy landing page'a, zgodny z kontraktem kluczy z wytycznych LP.",
  input_schema: {
    type: "object",
    properties: {
      business: {
        type: "object",
        properties: {
          name: { ...nullableStringSchema, description: "Pełna nazwa firmy/gabinetu/kliniki, 1:1 z briefu." },
          address: nullableStringSchema,
          phone: nullableStringSchema,
          email: nullableStringSchema,
        },
        required: ["name", "address", "phone", "email"],
      },
      hero: {
        type: "object",
        properties: {
          eyebrow: nullableStringSchema,
          headline: { type: "string", description: "Rzeczownik + korzyść, bez trybu rozkazującego." },
          subheadline: { type: "string", description: "Nazwij problem klienta wprost, potem obietnicę." },
          body: { ...nullableStringSchema, description: "Opcjonalny dodatkowy akapit pod subheadline, jeśli szablon go przewiduje." },
          cta_label: { type: "string", description: "Czasownik + niskie ryzyko, np. 'Umów się na bezpłatną konsultację'." },
        },
        required: ["headline", "subheadline", "cta_label"],
      },
      stats: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: {
              ...nullableStringSchema,
              description:
                "SAMA LICZBA, bez '+' ani innego tekstu (np. '113', nie '113+') - część szablonów wstawia to do atrybutu HTML animujący licznik (data-end), więc musi być czystą liczbą; ewentualny '+' jest już wpisany na stałe w szablonie.",
            },
            label: nullableStringSchema,
          },
          required: ["value", "label"],
        },
        description: "Np. {value:'113', label:'zadowolonych klientek'}. Pomiń jeśli brief nie daje liczb.",
      },
      usp: {
        type: ["object", "null"],
        properties: { title: { type: "string" }, body: { type: "string" } },
        description: "2-3 zdania: kto robi zabieg, dlaczego podejście jest inne, że jest indywidualne. Null jeśli brak materiału.",
      },
      problems: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title", "body"],
        },
        description: "Karty problemów klienta (zwykle 3).",
      },
      methods: {
        type: "array",
        items: {
          type: "object",
          properties: { eyebrow: nullableStringSchema, title: { type: "string" }, body: { type: "string" } },
          required: ["title", "body"],
        },
        description: "Bloki technologii/metody (zwykle 2-3).",
      },
      synergy: {
        type: ["object", "null"],
        properties: { eyebrow: nullableStringSchema, title: { type: "string" }, body: { type: "string" } },
        description: "Tylko jeśli usługa łączy dwie technologie/metody - inaczej null.",
      },
      offer: {
        type: "object",
        properties: {
          name: nullableStringSchema,
          duration_label: nullableStringSchema,
          price_regular: nullableStringSchema,
          price_promo: nullableStringSchema,
          savings_label: nullableStringSchema,
          countdown_minutes: nullableStringSchema,
          limited_label: nullableStringSchema,
          omnibus_price: {
            ...nullableStringSchema,
            description: "Najniższa cena z ostatnich 30 dni (wymóg dyrektywy Omnibus przy promocji) - przepisz 1:1 z briefu, null jeśli brief nie podaje.",
          },
          cta_label: { type: "string", description: "CTA konkretnie bloku oferty - może różnić się od hero.cta_label, np. 'Zarezerwuj i odbierz rabat'." },
        },
        required: [
          "name",
          "duration_label",
          "price_regular",
          "price_promo",
          "savings_label",
          "countdown_minutes",
          "limited_label",
          "omnibus_price",
          "cta_label",
        ],
        description: "Ceny/czas przepisz 1:1 z briefu, nigdy nie zaokrąglaj ani nie zmyślaj.",
      },
      gallery: {
        type: "object",
        properties: {
          title: nullableStringSchema,
          subtitle: nullableStringSchema,
          image_keys: {
            type: "array",
            items: { type: "string" },
            description: "TYLKO klucze slotów mediów faktycznie dostępnych (patrz lista w user prompt) - nigdy nie wymyślaj slotów, których nie ma.",
          },
        },
        required: ["image_keys"],
      },
      trust: {
        type: ["object", "null"],
        properties: { title: nullableStringSchema, body_1: nullableStringSchema, body_2: nullableStringSchema },
      },
      testimonials: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            position: {
              ...nullableStringSchema,
              description:
                "Stanowisko/pozycja autora opinii. Jeśli brief podaje - przepisz 1:1. Jeśli nie - NIE zostawiaj null: wpisz ogólną, bezpieczną etykietę z prefiksem założenia (np. '⚠️ ZAŁOŻENIE: Klientka'), nigdy nie zmyślaj konkretnego stanowiska/firmy dla realnej osoby.",
            },
            quote: { type: "string" },
          },
          required: ["name", "position", "quote"],
        },
        description: "Nie edytuj treści opinii poza literówkami - ma brzmieć jak prawdziwa osoba.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            bullets: {
              type: "array",
              items: { type: "string" },
              description: "Opcjonalna lista krótkich punktów pod krokiem (np. lista efektów) - tylko jeśli szablon przewiduje taką listę dla tego konkretnego kroku, inaczej pusta tablica.",
            },
          },
          required: ["title", "body"],
        },
      },
      pricing_table: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, price: { type: "string" } },
          required: ["name", "price"],
        },
      },
      pricing_note: {
        ...nullableStringSchema,
        description:
          "To pole to w praktyce PROMOCJA/bonus dołączony do cennika (np. 'Do każdego zabiegu: plan pielęgnacyjny na rok w cenie'), nie techniczna adnotacja - pisz jak realną, konkretną korzyść, nie disclaimer.",
      },
      final_cta: {
        type: "object",
        properties: {
          eyebrow: { ...nullableStringSchema, description: "Krótki kicker nad tytułem final CTA, np. 'Czas na zmianę'." },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
      form: {
        type: "object",
        properties: {
          fields: { type: "array", items: { type: "string" } },
          dropdown_options: { type: "array", items: { type: "string" } },
          submit_label: { type: "string" },
        },
        required: ["submit_label"],
      },
      footer: {
        type: "object",
        properties: { copyright: nullableStringSchema },
      },
      seo: {
        type: "object",
        properties: {
          title: { type: "string", description: "Tytuł strony pod SEO." },
          metaDescription: { type: "string", description: "Meta opis pod SEO." },
        },
        required: ["title", "metaDescription"],
      },
    },
    required: ["business", "hero", "offer", "gallery", "final_cta", "form", "seo"],
  },
};

// Prompt compliance on "never use em/en dashes" isn't reliable enough on its
// own (LLMs reach for — as a stylistic default) - this is a deterministic
// backstop applied to every string in the result regardless of what the
// model actually did, so the guideline is always enforced, not just usually.
const DASH_RE = /[—–]/g;

function stripDashes(value) {
  if (typeof value === "string") return value.replace(DASH_RE, "-");
  if (Array.isArray(value)) return value.map(stripDashes);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = stripDashes(v);
    return out;
  }
  return value;
}

function formatZodErrorForClaude(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function extractAndValidate(response) {
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { toolUse: null, parsed: { success: false, error: null } };
  const parsed = LPCopySchema.safeParse(toolUse.input);
  return { toolUse, parsed };
}

function buildUserPrompt({ briefText, referenceLPText, filledMediaSlots, additionalNotes }) {
  const parts = [];
  parts.push(`--- BRIEF TEJ LANDING PAGE ---\n${briefText}`);

  if (referenceLPText) {
    parts.push(
      "--- BRIEF REFERENCYJNEJ LP TEJ SAMEJ KATEGORII (inspiracja stylem i tonem, NIE kopiuj tresci ani konkretow klienta) ---\n" +
        referenceLPText
    );
  }

  if (additionalNotes) {
    parts.push(
      "--- DODATKOWE UWAGI OPERATORA DO TEJ KONKRETNEJ STRONY (maja pierwszenstwo nad ogolnymi wytycznymi stylu " +
        "ponizej, jesli sa ze soba sprzeczne - ale NIE ponad faktami z briefu: nadal nie zmyslaj cen/adresu/faktow) ---\n" +
        additionalNotes
    );
  }

  parts.push(
    filledMediaSlots.length
      ? `Sloty mediow faktycznie dostepne na tej stronie: ${filledMediaSlots.join(", ")}. Wstaw do gallery.image_keys wylacznie klucze z tej listy.`
      : "Brak dostepnych slotow mediow w tym przebiegu - NIE pisz o galerii/zdjeciach, zostaw gallery.image_keys jako pusta tablice."
  );

  parts.push(
    "--- ZASADA WYPEŁNIANIA BRAKUJĄCYCH DANYCH ---\n" +
      "Dwie różne kategorie pól, dwie różne zasady:\n\n" +
      "1) NIGDY nie zmyślaj (zostaw null / pustą tablicę, jeśli brief tego nie podaje): business.name/address/phone/email, " +
      "wszystkie ceny i czas w offer.* (price_regular, price_promo, duration_label, countdown_minutes, omnibus_price, savings_label), " +
      "cały stats[] (konkretne liczby), cały pricing_table[] (realne ceny), oraz name/quote w testimonials[] (tożsamość i treść " +
      "prawdziwej opinii klienta - nigdy nie wymyślaj całej opinii). To są konkretne, weryfikowalne fakty - zmyślenie ich jest " +
      "ryzykowne prawnie/etycznie.\n\n" +
      `2) DLA WSZYSTKICH INNYCH pól tekstowych (hero.eyebrow/body, problems, methods, synergy, usp, trust, steps ` +
      "(title/body/bullets), gallery.title/subtitle, pricing_note, final_cta.eyebrow, footer.copyright, testimonials[].position) - " +
      `jeśli brief nie daje wystarczających konkretów, NIE zostawiaj pustego pola ani krótszej niż typowo tablicy (np. problems ` +
      `zwykle 3 pozycje, methods zwykle 2-3). Napisz sensowną, ogólną treść pasującą do tego typu zabiegu/branży, ale zacznij ją ` +
      `od "${ASSUMPTION_MARKER}" żeby operator od razu widział na stronie, że to założenie do weryfikacji przed publikacją.\n\n` +
      "3) NIGDY nie używaj długiego myślnika (—) ani półpauzy (–) w żadnym polu tekstowym - zamiast nich użyj przecinka, kropki, " +
      "albo zwykłego łącznika (-).\n\n" +
      `Napisz copy tej landing page zgodnie z powyzszymi wytycznymi, wywolujac narzedzie ${TOOL_NAME}.`
  );

  return parts.join("\n\n");
}

/**
 * Generates the full LP copy object. Same tool-use + zod + one repair
 * round-trip pattern as generateScriptVariant() in scriptGenerator.js:
 * a first schema-validation failure is fed back to Claude as an
 * is_error tool_result for one automatic fix attempt, and only THEN
 * throws LPGenerationError - so a broken generation never reaches
 * buildPageContent()/wpCreatePage().
 *
 * templateRulesText carries cache_control so the (large, static)
 * copywriting-guide prompt is billed at full price once per process.
 */
export async function generateLPCopy({
  templateRulesText,
  briefText,
  referenceLPText,
  filledMediaSlots = [],
  additionalNotes = null,
}) {
  const messages = [
    { role: "user", content: buildUserPrompt({ briefText, referenceLPText, filledMediaSlots, additionalNotes }) },
  ];

  const baseParams = {
    model: GENERATION_MODEL,
    max_tokens: 8192,
    system: [{ type: "text", text: templateRulesText, cache_control: { type: "ephemeral" } }],
    tools: [generateLPCopyTool],
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
    throw new LPGenerationError(
      "Nie udalo sie wygenerowac poprawnego copy LP po probie naprawy.",
      parsed.error ? formatZodErrorForClaude(parsed.error) : "Brak odpowiedzi narzedzia od Claude."
    );
  }

  return stripDashes(parsed.data);
}
