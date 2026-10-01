import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";

/**
 * Z opisu motywu ("ciepły beż i mauve", "szałwia i biel", "granat i złoto")
 * generuje spójną paletę zmiennych --zl-* dla szablonu lp-new-v1.
 * Zwraca null przy błędzie - renderer zostawia wtedy paletę domyślną.
 */

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const TOOL_NAME = "set_lp_palette";

// Kolor cen po rabacie - staly dla wszystkich LP, motyw go nie zmienia
// (renderNewTemplate wymusza go na --zl-save). Kontrast ~5.4:1 na bieli.
export const PROMO_PRICE_GREEN = "#1E7B45";

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// klucz w wyniku -> nazwa zmiennej CSS w szablonie
export const PALETTE_KEYS = {
  cream: "--zl-cream",
  cream2: "--zl-cream-2",
  card: "--zl-card",
  ink: "--zl-ink",
  inkSoft: "--zl-ink-soft",
  mauve: "--zl-mauve",
  mauveDeep: "--zl-mauve-deep",
  mauveDark: "--zl-mauve-dark",
  beige: "--zl-beige",
  beigeSoft: "--zl-beige-soft",
  sale: "--zl-sale",
  save: "--zl-save",
};

const PaletteSchema = z.object(
  Object.fromEntries(Object.keys(PALETTE_KEYS).map((k) => [k, HEX]))
);

const hexProp = { type: "string", description: "kolor #RRGGBB" };
const tool = {
  name: TOOL_NAME,
  description: "Ustawia paletę kolorów landing page (12 wartości #RRGGBB) na podstawie opisu motywu.",
  input_schema: {
    type: "object",
    properties: {
      cream: { ...hexProp, description: "główne, bardzo jasne tło strony" },
      cream2: { ...hexProp, description: "drugie tło sekcji (delikatnie ciemniejsze od cream)" },
      card: { ...hexProp, description: "tło kart / formularzy (blisko bieli)" },
      ink: { ...hexProp, description: "główny kolor tekstu (ciemny, wysoki kontrast na cream)" },
      inkSoft: { ...hexProp, description: "tekst drugorzędny (jaśniejszy od ink, nadal czytelny)" },
      mauve: { ...hexProp, description: "kolor akcentu (dividery, eyebrow)" },
      mauveDeep: { ...hexProp, description: "kolor przycisków i pasków (ciemniejszy akcent, biały tekst musi być czytelny)" },
      mauveDark: { ...hexProp, description: "najciemniejszy akcent - tło sekcji finalnej (biały tekst czytelny)" },
      beige: { ...hexProp, description: "kolor obramowań / linii" },
      beigeSoft: { ...hexProp, description: "wypełnienie ikon / pigułek (jasne)" },
      sale: { ...hexProp, description: "kolor ceny przekreślonej - kontrastowy, zwykle czerwony/terakota" },
      save: { ...hexProp, description: "kolor ceny promocyjnej - ignorowany, zawsze zielony (PROMO_PRICE_GREEN)" },
    },
    required: Object.keys(PALETTE_KEYS),
  },
};

export async function generatePalette(themeText) {
  const desc = (themeText || "").trim();
  if (!desc) return null;

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [
        {
          role: "user",
          content:
            `Motyw kolorystyczny landing page: "${desc}".\n` +
            "Zbuduj spójną, elegancką paletę (beauty/premium). Zasady: wysoki kontrast tekst/tło, " +
            "biały tekst czytelny na mauveDeep i mauveDark, cream jaśniejszy niż cream2, sale kontrastowy do tła. " +
            `Wywołaj ${TOOL_NAME}.`,
        },
      ],
    });
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse) return null;
    const parsed = PaletteSchema.safeParse(toolUse.input);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn("[lpPalette] nie udało się wygenerować palety:", err.message);
    return null;
  }
}
