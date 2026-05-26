# Changelog — Usage Dashboard

Alle wijzigingen per versie. Meest recente versie bovenaan.

---

## [0.6.4] — 2026-05-26

### Opgelost
- ChatGPT/Codex tab werd meerdere keren achter elkaar herladen door twee onafhankelijke pollers (background alarm + dashboard interval 15s)
- Dashboard-poller (`initRemoteRefreshListener`, `checkForRemoteRefreshRequest`, `resetRemoteRefreshRequestFlag`) verwijderd uit `app.js` — background alarm is de enige poller
- Throttle in `background.js` opgeslagen in `chrome.storage.local` (90s cooldown) zodat het SW-restarts overleeft
- MV3 CSP: `onclick` op Reports/Help knoppen verplaatst naar `app.js` event listeners
- MV3 CSP: `onfocus`/`onblur` op koppel-URL input verplaatst naar `app.js` event listeners
- Chart.js lokaal gebundeld als `lib/chart.min.js` (CDN geblokkeerd door MV3 CSP)
- `broadcastStateUpdate` gebruikt nu `.catch()` voor async MV3 Promise-fouten

---

## [0.6.3] — 2026-05-25

### Verwijderd
- Alle Netlify-referenties verwijderd (paneel, deploy-knop, `checkNetlifySync()`, `NETLIFY_URL`)
- Netlify als PWA-host optie verwijderd uit de mobiele synchronisatie-instellingen
- `netlify.toml` verwijderd

### Verbeterd
- PWA host-selector vereenvoudigd: agents-controller is nu de vaste en enige host
- Versiebeheer gestroomlijnd via `bump-version.ps1` en GitHub Releases + tags

---

## [0.6.2] — 2026-05-24

### Toegevoegd
- "Onthoud mij op dit apparaat" checkbox op het inlogscherm (auto-login)
- Vaste extensie-ID via `manifest.json` key-veld (RSA 2048)
- PWA gehost op agents-controller via Tailscale HTTPS (poort 9000)
- Host-selector in Mobiele Synchronisatie: Lokaal (agents-controller) of Netlify
- Netlify Status paneel met deploy-knop en kredietwaarschuwing
- Auto-update timer op agents-controller (haalt elke 5 min updates van GitHub)

### Opgelost
- Claude Pro wekelijkse timerbalk toonde grijs/0% (regex fix voor "Resets in" prefix)
- Bitwarden autofill werkt niet op nieuwe extensie-ID (workaround via "Onthoud mij")
- Remote refresh werkt nu zonder open dashboard-tabblad
- Build-info strip zichtbaar op zowel PC als telefoon

---

## [0.6.1] — 2026-05-23

### Toegevoegd
- Remote refresh: telefoon kan PC-scrapers op afstand activeren via npoint.io
- Fast-poll detectie op basis van `lastSynced` timestamp (immuun voor caching)
- Baseline-vergelijking voorkomt vroeg klaar melden bij stale cloud-data

### Opgelost
- PC tab-switching tijdens sync onderbroken dashboard-weergave
- Telefoon UI werd niet bijgewerkt na remote refresh

---

## [0.6.0] — 2026-05-22

### Toegevoegd
- Mobiele Synchronisatie (PWA) met npoint.io cloud JSON-bin
- End-to-end XOR-encryptie voor sync-data
- QR-code koppellink voor eenvoudige installatie op telefoon
- Cookie-opslag als back-up voor iOS Safari localStorage purges
- Exponential backoff retry bij mislukte cloud-sync

---

## [0.5.x] — eerder

- Initiële Chrome extensie met scraper voor Claude Pro en ChatGPT Business
- Gemini handmatige teller
- Analytics-grafiek (Chart.js)
- Parallelle voortgangsbalken (Pace-indicator)
- Wekelijkse limiet weergave voor Claude Pro
