import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "../config.js";
import { ASSUMPTION_MARKER } from "./lpGenerator.js";

/**
 * Generator copy dla szablonu "nowy" (src/templates/lp-new-v1.html).
 *
 * Celowo OSOBNY plik od lpGenerator.js: stary szablon (strona-wzorzec WP) ma
 * swój kontrakt kluczy i nie chcemy go ruszać. Ten sam sprawdzony wzorzec:
 * tool-use z wymuszonym schematem + walidacja zod + jedna runda naprawy.
 */

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const GENERATION_MODEL = "claude-sonnet-5";
const TOOL_NAME = "generate_new_lp_copy";

const nullableString = z.string().nullable().optional();

const NewLpCopySchema = z.object({
  business: z.object({
    name: nullableString,
    address: nullableString,
    phone: nullableString,
    email: nullableString,
    hours: nullableString,
  }),
  seo: z.object({ title: z.string().min(1), metaDescription: z.string().min(1) }),
  nav: z.object({
    logo: z.string().min(1),
    logo_sub: nullableString,
    cta_label: z.string().min(1),
  }),
  hero: z.object({
    badge: nullableString,
    headline: z.string().min(1),
    headline_em: nullableString,
    lead: z.string().min(1),
    note: nullableString,
    cta_label: z.string().min(1),
  }),
  trust: z.array(z.object({ strong: z.string().min(1), label: z.string().min(1) })).optional().default([]),
  fit: z.object({
    title: z.string().min(1),
    subtitle: nullableString,
    items: z.array(z.string()).optional().default([]),
    cta_label: z.string().min(1),
  }),
  efekty: z.object({ title: z.string().min(1), subtitle: nullableString, cta_label: z.string().min(1) }),
  opinie: z.object({
    title: z.string().min(1),
    subtitle: nullableString,
    cta_label: z.string().min(1),
    items: z.array(z.object({ quote: z.string().min(1), name: z.string().min(1) })).optional().default([]),
  }),
  offer: z.object({
    title: z.string().min(1),
    subtitle: nullableString,
    eyebrow: nullableString,
    product_title: z.string().min(1),
    includes: z.array(z.string()).optional().default([]),
    bonus_line: nullableString,
    price_regular: nullableString,
    price_promo: nullableString,
    price_promo_label: nullableString,
    savings_line: nullableString,
    countdown_minutes: nullableString,
    form_title: nullableString,
    form_sub: nullableString,
  }),
  why_us: z.object({
    title: z.string().min(1),
    subtitle: nullableString,
    cta_label: z.string().min(1),
    cards: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) })).optional().default([]),
  }),
  how: z.object({
    title: z.string().min(1),
    subtitle: nullableString,
    lead_title: z.string().min(1),
    lead_paras: z.array(z.string()).optional().default([]),
    cta_label: z.string().min(1),
    steps: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) })).optional().default([]),
  }),
  metamorfozy: z.object({ title: nullableString, subtitle: nullableString }).optional().default({}),
  packages: z
    .object({
      title: z.string().min(1),
      subtitle: nullableString,
      note: nullableString,
      cta_label: nullableString,
      items: z
        .array(
          z.object({
            name: z.string().min(1),
            count: z.string().min(1),
            price_regular: nullableString,
            price_total: z.string().min(1),
            price_per: nullableString,
            saving: nullableString,
            tag: nullableString,
            featured: z.boolean().optional().default(false),
            cta_label: nullableString,
          })
        )
        .optional()
        .default([]),
    })
    .optional()
    .default({ title: "Pakiety zabiegów", subtitle: null, note: null, cta_label: null, items: [] }),
  midcta: z.object({ title: z.string().min(1), body: nullableString, cta_label: z.string().min(1) }),
  faq: z.object({
    title: nullableString,
    subtitle: nullableString,
    cta_label: z.string().min(1),
    items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).optional().default([]),
  }),
  final: z.object({
    eyebrow: nullableString,
    title: z.string().min(1),
    sub: nullableString,
    info_eyebrow: nullableString,
    info_title: z.string().min(1),
    contact_lines: z.array(z.string()).optional().default([]),
    price_line: nullableString,
    form_title: nullableString,
    form_sub: nullableString,
  }),
  footer: z.object({ brand: nullableString, line: nullableString, copyright: nullableString }).optional().default({}),
});

export class NewLPGenerationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "NewLPGenerationError";
    this.details = details;
  }
}

const ns = { type: ["string", "null"] };
const strArr = { type: "array", items: { type: "string" } };

const generateNewLpCopyTool = {
  name: TOOL_NAME,
  description:
    "Zwraca kompletne copy landing page'a w układzie szablonu 'nowy' (hero -> to dla Ciebie -> efekty -> oferta+formularz -> opinie -> dlaczego my -> jak działa -> metamorfozy -> mid CTA -> FAQ -> final+formularz).",
  input_schema: {
    type: "object",
    properties: {
      business: {
        type: "object",
        properties: { name: ns, address: ns, phone: ns, email: ns, hours: ns },
        required: ["name", "address", "phone", "email", "hours"],
      },
      seo: {
        type: "object",
        properties: {
          title: { type: "string", description: "Tytuł strony pod SEO." },
          metaDescription: { type: "string", description: "Meta opis pod SEO, do ~155 znaków." },
        },
        required: ["title", "metaDescription"],
      },
      nav: {
        type: "object",
        properties: {
          logo: { type: "string", description: "Nazwa marki w logo (zwykle nazwa gabinetu/kliniki)." },
          logo_sub: { ...ns, description: "Podpis pod logo, np. 'Imię Nazwisko · Miasto'." },
          cta_label: { type: "string", description: "Krótki tekst przycisku w nawigacji, np. 'Zarezerwuj wizytę'." },
        },
        required: ["logo", "cta_label"],
      },
      hero: {
        type: "object",
        properties: {
          badge: { ...ns, description: "Krótki badge nad H1, np. 'Miasto · Jedyny gabinet z X'." },
          headline: { type: "string", description: "Nazwij problem klienta wprost. To jest część H1 przed wyróżnieniem." },
          headline_em: { ...ns, description: "Druga część H1 (wyróżniona kursywą) - obietnica rezultatu." },
          lead: { type: "string", description: "1-2 zdania: co to za zabieg i jaka korzyść. Mało technologii." },
          note: { ...ns, description: "Pasek 'w cenie: ...' BEZ podawania kwoty (cena tylko przy formularzu)." },
          cta_label: { type: "string", description: "Czasownik + niskie ryzyko, np. 'Zarezerwuj wizytę'." },
        },
        required: ["headline", "lead", "cta_label"],
      },
      trust: {
        type: "array",
        description: "Pasek zaufania pod hero, zwykle 3 punkty.",
        items: {
          type: "object",
          properties: {
            strong: { type: "string", description: "Mocny, krótki fakt, np. 'Jedyny gabinet z X'." },
            label: { type: "string", description: "Dopowiedzenie, np. 'na całym Podhalu'." },
          },
          required: ["strong", "label"],
        },
      },
      fit: {
        type: "object",
        description: "Sekcja 'To dla Ciebie' - konkretne sytuacje, w których klientka się rozpozna.",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          items: { ...strArr, description: "6-8 konkretnych, jednozdaniowych sytuacji/problemów." },
          cta_label: { type: "string" },
        },
        required: ["title", "items", "cta_label"],
      },
      efekty: {
        type: "object",
        description: "Nagłówki sekcji przed/po (zdjęcia dostarcza operator osobno).",
        properties: { title: { type: "string" }, subtitle: ns, cta_label: { type: "string" } },
        required: ["title", "cta_label"],
      },
      opinie: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          cta_label: { type: "string" },
          items: {
            type: "array",
            description:
              "Wyciągnięte z briefu najmocniejsze cytaty klientek + imię. NIE wymyślaj treści opinii ani tożsamości - jeśli brief nie podaje opinii, zostaw pustą tablicę.",
            items: {
              type: "object",
              properties: { quote: { type: "string" }, name: { type: "string" } },
              required: ["quote", "name"],
            },
          },
        },
        required: ["title", "cta_label"],
      },
      offer: {
        type: "object",
        description: "Pakiet wartości + ceny. Ceny przepisz 1:1 z briefu, nigdy nie zmyślaj ani nie zaokrąglaj.",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          eyebrow: ns,
          product_title: { type: "string", description: "Nazwa oferty/zabiegu jako nagłówek karty." },
          includes: { ...strArr, description: "Co zawiera pakiet - 4-6 punktów (konsultacja, zabieg, pielęgnacja, bonusy...)." },
          bonus_line: { ...ns, description: "Linijka z bonusami, np. '+ BONUS: analiza skóry w cenie · + BONUS: infuzja tlenowa'." },
          price_regular: { ...ns, description: "Cena regularna 1:1 z briefu (np. '350 zł'). Null jeśli brief nie podaje." },
          price_promo: { ...ns, description: "Cena promocyjna 1:1 z briefu (np. '269 zł'). Null jeśli brief nie podaje." },
          price_promo_label: { ...ns, description: "Etykieta przy cenie promo, np. 'Cena promocyjna'." },
          savings_line: { ...ns, description: "Linijka o oszczędności przy serii, np. 'Przy zakupie serii oszczędzasz do 400 zł'." },
          countdown_minutes: { ...ns, description: "Liczba minut licznika (sama liczba, np. '15'). Null = domyślnie 15." },
          form_title: ns,
          form_sub: ns,
        },
        required: ["title", "product_title", "includes", "price_regular", "price_promo"],
      },
      why_us: {
        type: "object",
        description: "Dlaczego my - doświadczenie, indywidualne podejście, specjaliści, komfort, realne efekty.",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          cta_label: { type: "string" },
          cards: {
            type: "array",
            description: "6 kart {title, body}.",
            items: {
              type: "object",
              properties: { title: { type: "string" }, body: { type: "string" } },
              required: ["title", "body"],
            },
          },
        },
        required: ["title", "cta_label", "cards"],
      },
      how: {
        type: "object",
        description: "Jak działa zabieg - technologia NA KOŃCU strony.",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          lead_title: { type: "string" },
          lead_paras: { ...strArr, description: "2-3 akapity wyjaśniające metodę." },
          cta_label: { type: "string" },
          steps: {
            type: "array",
            description: "3 kroki {title, body} (np. analiza -> zabieg -> efekt/pielęgnacja).",
            items: {
              type: "object",
              properties: { title: { type: "string" }, body: { type: "string" } },
              required: ["title", "body"],
            },
          },
        },
        required: ["title", "lead_title", "lead_paras", "cta_label", "steps"],
      },
      metamorfozy: {
        type: "object",
        properties: { title: ns, subtitle: ns },
      },
      packages: {
        type: "object",
        description:
          "Opcjonalna sekcja z pakietami/seriami zabiegów (kilka wizyt w niższej cenie za sztukę). Wypełnij items TYLKO jeśli brief albo uwagi operatora faktycznie opisują pakiety - ceny 1:1 z tych źródeł, nigdy nie zmyślaj i nie licz samodzielnie liczb, których tam nie ma. Jeśli klient nie oferuje pakietów, zwróć items jako pustą tablicę - cała sekcja wtedy w ogóle nie trafi na stronę.",
        properties: {
          title: { type: "string" },
          subtitle: ns,
          note: { ...ns, description: "Krótka pigułka nad kartami, np. 'Im większy pakiet, tym niższa cena zabiegu'." },
          cta_label: ns,
          items: {
            type: "array",
            description: "Karty pakietów (zwykle 3, np. 3/4/5 zabiegów). Wszystkie ceny wyłącznie z briefu/uwag operatora.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "np. 'Pakiet 3 zabiegów'." },
                count: { type: "string", description: "np. '3x'." },
                price_regular: { ...ns, description: "Suma cen regularnych za pojedyncze zabiegi w pakiecie, tylko jeśli podana wprost." },
                price_total: { type: "string", description: "Cena całego pakietu, 1:1 ze źródła." },
                price_per: { ...ns, description: "Cena za pojedynczy zabieg w pakiecie - policz tylko jeśli obie liczby (suma i cena pakietu) są podane wprost." },
                saving: { ...ns, description: "Ile klientka oszczędza względem ceny regularnej - policz tylko jeśli policzalne z podanych liczb." },
                tag: { ...ns, description: "Etykieta na wyróżnionej karcie, np. 'Najczęściej wybierany'. Null dla pozostałych kart." },
                featured: { type: "boolean", description: "true dla jednej, zwykle środkowej/najpopularniejszej karty." },
                cta_label: ns,
              },
              required: ["name", "count", "price_total"],
            },
          },
        },
        required: ["title", "items"],
      },
      midcta: {
        type: "object",
        properties: { title: { type: "string" }, body: ns, cta_label: { type: "string" } },
        required: ["title", "cta_label"],
      },
      faq: {
        type: "object",
        description: "FAQ nastawione na OBIEKCJE ZAKUPOWE: ból, efekty i utrzymanie, liczba zabiegów, funkcjonowanie po zabiegu, przygotowanie, przeciwwskazania, okolice ciała, cena, jak zarezerwować.",
        properties: {
          title: ns,
          subtitle: ns,
          cta_label: { type: "string" },
          items: {
            type: "array",
            description: "8-10 par {q, a} pokrywających powyższe obiekcje. W odpowiedzi o cenę NIE podawaj konkretnych kwot - odeślij do kontaktu (cena tylko przy formularzu).",
            items: {
              type: "object",
              properties: { q: { type: "string" }, a: { type: "string" } },
              required: ["q", "a"],
            },
          },
        },
        required: ["cta_label", "items"],
      },
      final: {
        type: "object",
        properties: {
          eyebrow: ns,
          title: { type: "string" },
          sub: ns,
          info_eyebrow: ns,
          info_title: { type: "string" },
          contact_lines: { ...strArr, description: "Adres, telefon, godziny - każda linia osobno. Tylko dane z briefu, nie zmyślaj." },
          price_line: { ...ns, description: "Linijka z ceną przy formularzu końcowym, np. 'Cena regularna: 350 zł -> 269 zł. W cenie analiza skóry...'. To jedyne miejsce (poza sekcją Oferta), gdzie cena może się pojawić." },
          form_title: ns,
          form_sub: ns,
        },
        required: ["title", "info_title"],
      },
      footer: {
        type: "object",
        properties: { brand: ns, line: ns, copyright: ns },
      },
    },
    required: ["business", "seo", "nav", "hero", "fit", "efekty", "opinie", "offer", "why_us", "how", "midcta", "faq", "final"],
  },
};

const DASH_RE = /[—–]/g;
function stripDashes(value) {
  if (typeof value === "string") return value.replace(DASH_RE, "-");
  if (Array.isArray(value)) return value.map(stripDashes);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripDashes(v);
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
  const parsed = NewLpCopySchema.safeParse(toolUse.input);
  return { toolUse, parsed };
}

function buildUserPrompt({ briefText, formName, beforeAfterCount, opinieCount, additionalNotes, packagesInfo }) {
  const parts = [];
  parts.push(`--- BRIEF TEJ LANDING PAGE ---\n${briefText}`);

  if (additionalNotes) {
    parts.push(
      "--- DODATKOWE UWAGI OPERATORA (mają pierwszeństwo nad ogólnym stylem, ale NIE nad faktami z briefu) ---\n" +
        additionalNotes
    );
  }

  parts.push(
    packagesInfo
      ? "--- PAKIETY / SERIE ZABIEGÓW (podane przez operatora, mają pierwszeństwo nad opisem pakietów w briefie jeśli się różnią) ---\n" +
          packagesInfo +
          "\nWypełnij packages.items na tej podstawie. Jeśli brief RÓWNIEŻ opisuje pakiety, potraktuj to jako uzupełnienie - " +
          "nigdy nie zmyślaj ani nie licz liczb, których nie podano wprost w żadnym z tych dwóch źródeł."
      : "--- PAKIETY / SERIE ZABIEGÓW ---\nOperator nie podał osobno informacji o pakietach. Jeśli BRIEF opisuje pakiety/serie " +
          "zabiegów (np. 'pakiet 3 zabiegów za X zł'), wypełnij packages.items na tej podstawie, 1:1 z liczbami z briefu. " +
          "Jeśli ani brief, ani operator nic o pakietach nie mówią, zwróć packages.items jako pustą tablicę - sekcja wtedy w ogóle nie trafi na stronę."
  );

  parts.push(
    "--- KONTEKST MEDIÓW I FORMULARZA (dostarczone osobno przez operatora) ---\n" +
      `- Zdjęcie HERO: 1 szt.\n` +
      `- Zdjęcia przed/po: ${beforeAfterCount} szt. (te same trafiają do obu karuzel).\n` +
      `- Zdjęcia opinii: ${opinieCount} szt. (to są realne screeny recenzji Google). W opinie.items podaj TYLKO realne, mocne cytaty z briefu + imię, parowane po kolejności ze zdjęciami. Jeśli brief nie ma tylu cytatów - podaj mniej pozycji albo pustą tablicę. NIGDY nie wymyślaj treści opinii ani nazwisk (to realne osoby) - karta bez cytatu pokaże samo zdjęcie.\n` +
      `- Formularz: shortcode CF7 o nazwie "${formName}" wstawiamy w 2 miejscach - Ty nie generujesz pól formularza.`
  );

  parts.push(
    "--- UKŁAD STRONY (nowy szablon) ---\n" +
      "Kolejność sekcji jest stała: HERO -> pasek zaufania -> 'To dla Ciebie' -> Efekty przed/po -> Oferta+formularz -> Opinie -> Dlaczego my -> Jak działa (technologia) -> Metamorfozy -> pasek CTA -> FAQ -> Final+formularz.\n" +
      "Zasady treści:\n" +
      "1) CENA tylko w sekcji Oferta i w final.price_line. Nigdzie indziej (hero.note, FAQ, trust) NIE podawaj kwot.\n" +
      "2) Technologia/metoda dopiero w sekcji 'Jak działa' - hero i górne sekcje mają być o problemie i rezultacie.\n" +
      "3) FAQ = obiekcje zakupowe (ból, efekty, liczba zabiegów, funkcjonowanie po zabiegu, przygotowanie, przeciwwskazania, okolice, cena, rezerwacja).\n" +
      "4) CTA (wszystkie *_cta / cta_label) krótkie, czasownikowe, niskie ryzyko."
  );

  parts.push(
    "--- ZASADA WYPEŁNIANIA BRAKUJĄCYCH DANYCH ---\n" +
      "1) NIGDY nie zmyślaj (null / pusta tablica, jeśli brief nie podaje): business.name/address/phone/email/hours, " +
      "offer.price_regular/price_promo/countdown_minutes/savings_line, final.contact_lines, oraz quote/name w opinie.items " +
      "(tożsamość i treść realnej opinii).\n" +
      `2) DLA POZOSTAŁYCH pól tekstowych: jeśli brief nie daje konkretów, NIE zostawiaj pusto ani krótszych list niż wskazane ` +
      `(fit.items 6-8, why_us.cards 6, how.steps 3, faq.items 8-10). Napisz sensowną, ogólną treść pasującą do branży, ` +
      `ale zacznij ją od "${ASSUMPTION_MARKER}" żeby operator widział, że to założenie do weryfikacji.\n` +
      "3) NIGDY nie używaj długiego myślnika (—) ani półpauzy (–) - użyj przecinka, kropki albo zwykłego łącznika (-).\n\n" +
      `Wywołaj narzędzie ${TOOL_NAME} z kompletnymi argumentami.`
  );

  return parts.join("\n\n");
}

/**
 * @param {object} args
 * @param {string} args.templateRulesText  wytyczne copywriterskie (getLPTemplate().rulesText) - cache_control
 * @param {string} args.briefText
 * @param {string} args.formName            nazwa formularza CF7 (do kontekstu, nie do pól)
 * @param {number} args.beforeAfterCount
 * @param {number} args.opinieCount
 * @param {string|null} args.additionalNotes
 * @param {string|null} args.packagesInfo   info o pakietach/seriach zabiegów podane osobno przez operatora
 */
export async function generateNewLpCopy({
  templateRulesText,
  briefText,
  formName = "",
  beforeAfterCount = 0,
  opinieCount = 0,
  additionalNotes = null,
  packagesInfo = null,
}) {
  const messages = [
    {
      role: "user",
      content: buildUserPrompt({ briefText, formName, beforeAfterCount, opinieCount, additionalNotes, packagesInfo }),
    },
  ];

  const system = [];
  if (templateRulesText) {
    system.push({ type: "text", text: templateRulesText, cache_control: { type: "ephemeral" } });
  }
  system.push({
    type: "text",
    text:
      "Jesteś copywriterem landing page'y beauty/medycyny estetycznej. Trzymasz się kontraktu kluczy narzędzia " +
      `${TOOL_NAME} i zasad z promptu użytkownika. Piszesz po polsku, konkretnie, bez waty i bez myślników (—, –).`,
  });

  const baseParams = {
    model: GENERATION_MODEL,
    max_tokens: 8192,
    system,
    tools: [generateNewLpCopyTool],
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
            content: `Odpowiedź nie przeszła walidacji schematu, popraw ją i wywołaj ${TOOL_NAME} ponownie. Błędy: ${formatZodErrorForClaude(
              parsed.error
            )}`,
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: `Nie wywołałeś narzędzia ${TOOL_NAME}. Wywołaj wyłącznie to narzędzie z kompletnymi argumentami.`,
      });
    }

    response = await anthropic.messages.create({ ...baseParams, messages });
    ({ toolUse, parsed } = extractAndValidate(response));
  }

  if (!parsed.success) {
    throw new NewLPGenerationError(
      "Nie udało się wygenerować poprawnego copy LP (nowy szablon) po próbie naprawy.",
      parsed.error ? formatZodErrorForClaude(parsed.error) : "Brak odpowiedzi narzędzia od Claude."
    );
  }

  return stripDashes(parsed.data);
}
