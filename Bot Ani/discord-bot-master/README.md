# TIM Discord Bot

Bot Discord dla komend operacyjnych (Trello + SOWA).

## Konfiguracja

Wymagane ENV:

- `DISCORD_TOKEN`
- `TRELLO_KEY`
- `TRELLO_TOKEN`
- `ANTHROPIC_API_KEY` (dla istniejących komend AI)

Nowe ENV dla adaptera SOWA:

- `SOWA_COMMAND_URL` - pełny URL endpointu komend SOWA, np.  
  `https://sowa.sayupdate.com/api/integrations/discord/bot/<commandToken>`
- `SOWA_COMMAND_SECRET` - opcjonalny sekret wysyłany w nagłówku  
  `x-discord-command-secret`

## Uruchomienie

```bash
npm install
npm run start
```

Dev:

```bash
npm run dev
```

## Komendy SOWA (adapter)

- `!sowa ping`
- `!sowa faktury`
- `!sowa faktury <PM>`
- `!sowa oplacona <NUMER_FAKTURY>`

Komendy SOWA działają jako cienki adapter HTTP do API SOWA. Logika biznesowa faktur pozostaje po stronie SOWA.

