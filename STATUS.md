# Discord-Rozpierdalator-v2 - Status

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
