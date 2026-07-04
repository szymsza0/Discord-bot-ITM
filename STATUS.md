# Discord-Rozpierdalator-v2 - Status

## 2026-07-04

- [x] Nowa komenda `!skrypt` - generator skryptów reklamowych AI:
  - baza kategorii zabiegów i skrypt referencyjny czytane z Google Sheets,
  - ogólny wzór/wytyczne + wskazówki nagraniowe czytane z Google Docs (cache w pamięci),
  - brief per zabieg podawany przez operatora (link do Google Doc),
  - generowanie przez Claude (tool-use + walidacja zod + jedna runda naprawy błędów schematu),
  - zapis nowego skryptu jako Google Doc w folderze Drive + nowy wiersz w arkuszu bazy,
  - prompt caching (Anthropic `cache_control`) na statycznym bloku wytycznych.
  - Wymaga nowych ENV: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
    `GOOGLE_SCRIPTS_SHEET_ID`, `GOOGLE_SCRIPT_TEMPLATE_DOC_ID`, `GOOGLE_SCRIPTS_DRIVE_FOLDER_ID`
    (patrz `.env.example`) - do ustawienia lokalnie i w Railway.

## 2026-05-05

- [x] Hardening integracji SOWA w adapterze bota:
  - wykrywanie odpowiedzi nie-JSON (np. HTML po Cloudflare Access redirect),
  - walidacja `payload.ok === true` po stronie klienta SOWA,
  - jawny błąd zamiast fałszywego sukcesu komendy `!sowa`.
- [x] Rozszerzenie komend bota o obsługę PM:
  - `!sowa pm` - lista aktywnych PM-ów z SOWA,
  - `!sowa przypisz <NIP lub nazwa klienta> | <Imię Nazwisko PM>` - przypisanie klienta do PM.
- [x] Rozszerzenie podpowiedzi `!sowa faktury` o składnię filtrów:
  - `!sowa faktury --pm <PM> --klient <NIP/nazwa>`.
