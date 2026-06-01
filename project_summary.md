# Project Summary: Usage Dashboard — LLM Scraper & Mobiele Sync

Volledig handoff-document voor AI-assistenten en ontwikkelaars. Bevat architectuur, werkwijze, versiebeheer-protocol en actuele staat van het project.

---

## ⚠️ VERSIEBEHEER-PROTOCOL — VERPLICHT BIJ ELKE WIJZIGING

> **Dit is een harde afspraak. Elke code-aanpassing die wordt gecommit MOET vergezeld gaan van een versie-bump. Geen uitzonderingen.**

### Stappen bij elke wijziging

1. **Pas de code aan**
2. **Update `CHANGELOG.md`** — voeg bovenaan een nieuwe sectie toe: `## [X.Y.Z] — YYYY-MM-DD` met bulletpoints wat er veranderd is
3. **Voer het bump-script uit:**
   ```powershell
   .\bump-version.ps1 -Version X.Y.Z
   ```
   Dit werkt automatisch bij in één keer:
   - `manifest.json` → `"version"`
   - `app.js` → `APP_VERSION`
   - `sw.js` → `APP_BUILD`, `CACHE_NAME`, `?v=` query strings
   - `index.html` → `?v=` query strings

4. **Commit + tag + push:**
   ```
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. **GitHub Action maakt automatisch een Release aan** (via `.github/workflows/release.yml`)
6. **Extensie reloaden:** `chrome://extensions` → Reload knop

### Versie-schema (SemVer)

| Type | Wanneer | Voorbeeld |
|------|---------|---------|
| **PATCH** `+0.0.1` | Bugfix, kleine UI-tweak | `0.6.3 → 0.6.4` |
| **MINOR** `+0.1.0` | Nieuwe feature, zichtbare gedragswijziging | `0.6.4 → 0.7.0` |
| **MAJOR** `+1.0.0` | Breaking change, grote architectuurwijziging | `0.9.x → 1.0.0` |

### Nooit vergeten

- Het `bump-version.ps1` script staat in de root van het project
- De CHANGELOG.md altijd bijwerken **vóór** het uitvoeren van het bump-script
- Na een bump: altijd `chrome://extensions → Reload` — de extensie update **niet** automatisch
- De PWA op agents-controller update **wel** automatisch via de systemd timer (binnen 5 min na git push)

---

## 1. Project Architectuur

```
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│  PC — Chrome Browser            │     │  Telefoon — Safari/Chrome    │
│                                 │     │                              │
│  ┌─────────────────────────┐   │     │  ┌────────────────────────┐  │
│  │ Chrome Extensie         │   │     │  │ PWA                    │  │
│  │ (background.js +        │   │     │  │ (agents-controller via │  │
│  │  content.js + app.js)   │   │     │  │  Tailscale HTTPS)      │  │
│  └──────────┬──────────────┘   │     │  └───────────┬────────────┘  │
│             │ scrape            │     │              │ poll 25s      │
└─────────────┼───────────────────┘     └──────────────┼───────────────┘
              │                                         │
              ▼                                         ▼
         ┌─────────────────────────────────────────────┐
         │          npoint.io cloud JSON bin           │
         │      (E2E XOR-encrypted payload)            │
         └─────────────────────────────────────────────┘
```

### De drie omgevingen

1. **Chrome Extensie (PC)** — `background.js` + `content.js` + `app.js`
   - Content scripts scrapen claude.ai, chatgpt.com, gemini.google.com
   - Background service worker verwerkt data en pusht naar npoint.io
   - Dashboard UI (`index.html`) toont limieten, grafieken, instellingen

2. **PWA (Telefoon)** — dezelfde `app.js`/`index.html`/`style.css`, gehost op:
   - **GitHub Pages (default, publiek)**: `https://dcs-rob.github.io/usage-dashboard/` — werkt op elke telefoon zónder Tailscale. Auto-deploy via `.github/workflows/pages.yml` bij elke push naar `main`.
   - **agents-controller (optioneel, privé)**: `https://agents-controller.tail00aec2.ts.net:9000` (vereist Tailscale op telefoon). Auto-update via systemd timer: elke 5 minuten `git pull` + service restart.
   - De host is per gebruiker instelbaar in Instellingen → Mobiele Synchronisatie (opgeslagen onder `lt_pwa_host`); leeg veld = GitHub Pages.

3. **Cloud Sync** — `https://api.npoint.io/<binId>`
   - Gratis JSON bin, E2E versleuteld via XOR cipher
   - PC pusht, telefoon pollt elke 25s

---

## 2. Remote Refresh Flow (Telefoon → PC)

1. Telefoon drukt op Ververs → `requestRemoteRefresh()` schrijft `refreshRequested: true` naar npoint.io
2. PC background alarm (`checkForRemoteRefreshRequestBG`, elke 30s) detecteert de vlag
3. Throttle: max 1 scrape per 90s, opgeslagen in `chrome.storage.local` (overleeft SW-restarts)
4. Scrapers starten op achtergrond (`triggerScrapeFromBackground`, `active: false` — geen schermwissel)
5. Background.js pusht verse data + `refreshRequested: false` naar npoint.io
6. Telefoon fast-poll (2.5s interval, max 90s) detecteert nieuwere `lastSynced` → UI update

> **Let op:** Er is maar **één** poller — de background alarm. De dashboard-poller die vroeger in `app.js` zat is verwijderd omdat die dubbele scrape-triggers veroorzaakte.

---

## 3. Bestandsoverzicht

| Bestand | Type | Verantwoordelijkheid |
|---------|------|---------------------|
| `manifest.json` | MV3 manifest | Permissies, extensie-ID (vaste key), versie |
| `background.js` | Service Worker | Data verwerking, cloud push, remote refresh poller, invite-link acceptatie |
| `content.js` | Content Script | Scraper voor claude.ai, chatgpt.com, gemini.google.com |
| `app.js` | UI Controller | Dashboard UI, dual storage (EXT/PWA), sync |
| `index.html` | HTML | Structuur, alle inline-JS verwijderd (MV3 CSP) |
| `style.css` | CSS | Glassmorphism UI, animaties, responsive |
| `sw.js` | Service Worker | PWA cache (stale-while-revalidate) |
| `manifest.webmanifest` | PWA manifest | Installeerbaar als app op telefoon |
| `lib/chart.min.js` | Bibliotheek | Chart.js lokaal gebundeld (CDN geblokkeerd door MV3) |
| `lib/qrcode.min.js` | Bibliotheek | Lokale QR-code generatie voor mobiele pairing (geen externe QR-provider) |
| `bump-version.ps1` | Script | Werkt alle versienummers bij in één keer |
| `CHANGELOG.md` | Documentatie | Versiegeschiedenis |
| `.github/workflows/release.yml` | CI/CD | Maakt automatisch GitHub Release bij tag push |
| `.github/workflows/pages.yml` | CI/CD | Deployt de PWA naar GitHub Pages bij push naar `main` |

---

## 4. Deployment

### Chrome Extensie (PC)
- Geladen als **unpacked extension** via `chrome://extensions → Load unpacked`
- Map: `G:\Gedeelde drives\DiederenCS - LXDG\Diederen CS\Antigravity\Usage Dashboard`
- Vaste extensie-ID via `manifest.json` → `"key"` veld (RSA 2048 publieke sleutel)
- Privésleutel bewaard op: `G:\Gedeelde drives\DiederenCS - LXDG\Diederen CS\Antigravity\usage-dashboard-extension.key.pem`
- **Update:** `chrome://extensions → Reload knop` (handmatig na elke versie-bump)

### PWA — publieke host (GitHub Pages, default)
- Auto-deploy via `.github/workflows/pages.yml` naar `https://dcs-rob.github.io/usage-dashboard/`
- Publiceert **alleen** de PWA-bestanden (index.html, app.js, style.css, sw.js, manifest.webmanifest, assets/, lib/) — geen extensie-manifest, background.js of content.js
- Veilig omdat de data E2E-versleuteld in npoint.io staat; zonder `pairingKey` (alleen via QR naar de eigen telefoon) valt er niets te lezen
- Pages-bron staat op "GitHub Actions": `gh api -X PUT repos/DCS-Rob/usage-dashboard/pages -f build_type=workflow`

### PWA — privé host (agents-controller, optioneel)
- Node.js static file server op poort 9000 (`/home/agents/Repositories/usage-dashboard/serve.js`)
- Bereikbaar via Tailscale HTTPS: `https://agents-controller.tail00aec2.ts.net:9000`
- **Auto-update:** systemd timer checkt elke 5 min op nieuwe GitHub commits → `git pull` + service restart
- Service: `usage-dashboard.service` + `usage-dashboard-autoupdate.timer`
- Invullen in het PWA-host-veld op het dashboard om voor je eigen telefoon te gebruiken

### GitHub
- Repo: `https://github.com/DCS-Rob/usage-dashboard` (publiek)
- Elke `git push --tags` met een `vX.Y.Z` tag → GitHub Action maakt automatisch een Release aan
- Release notes worden gevuld vanuit `CHANGELOG.md`

---

## 5. MV3 CSP-regels (belangrijk voor toekomstige wijzigingen)

Chrome Manifest V3 heeft een strikte Content Security Policy. Verboden:

| Verboden | Alternatief |
|----------|-------------|
| `onclick="..."` in HTML | Event listener in `app.js` |
| `onfocus="..."` in HTML | Event listener in `app.js` |
| `<script src="https://...">` | Bestand lokaal downloaden naar `lib/` |
| `eval()`, `innerHTML` met scripts | Niet doen |

---

## 6. Versiegeschiedenis

| Versie | Datum | Wijziging |
|--------|-------|-----------|
| **0.12.5** | 2026-06-01 | Header toont aparte environment badge: `Extension` voor scraper-dashboard of `PWA` voor mobiele/webweergave zonder scrape-capability. |
| **0.12.4** | 2026-06-01 | Deploy-sync indicator hernoemd naar duidelijkere PWA/mobile labels: `PWA Synced`, `PWA Behind`, `PWA Unknown`. |
| **0.12.3** | 2026-06-01 | Fix: invite-links zonder extensie wissen oude mobile-client config en blijven na reload op de install-assistent in plaats van read-only dashboard. |
| **0.12.2** | 2026-06-01 | Deploy-sync lampje in header vergelijkt actieve app-versie met live GitHub Pages en meldt `Pages Live`, `Pages Behind` of `Deploy Unknown`. |
| **0.12.1** | 2026-06-01 | Install-assistent voor invite-links zonder extensie: bestaande unpacked folder-route, GitHub ZIP-download en invite-link kopiëren voor na installatie. |
| **0.12.0** | 2026-06-01 | Invite-flow voor extra Chrome-profielen: `join=1` links, extension accept-overlay via `chrome.scripting.executeScript`, PWA fallback-melding met GitHub repo-link. |
| **0.8.0-beta.1** | 2026-05-29 | Beta veilige pairing: 256-bit `LT2` keys, URL-fragment pairing, lokale QR-generatie, AES-GCM `secureData` met legacy rollback-fallback. |
| **0.7.0** | 2026-05-29 | Publieke mobiele hosting via GitHub Pages (`dcs-rob.github.io/usage-dashboard`) + configureerbare PWA-host. webmanifest icon-pad + scope fix. |
| **0.6.6** | 2026-05-29 | Claude wekelijkse resettimer: NL "u" (uur)-parsing, dagnaam-lookup, en tomorrow/today + "Herstelt over" formaten toegevoegd. |
| **0.6.5** | 2026-05-26 | Codex/ChatGPT oneindige reload-lus opgelost (`window.location.reload()` verwijderd uit content.js). |
| **0.6.4** | 2026-05-26 | Dubbele ChatGPT-tab refreshes opgelost (dashboard-poller verwijderd, alleen background alarm). MV3 CSP-fouten opgelost (inline handlers → app.js, Chart.js lokaal). broadcastStateUpdate .catch() fix. |
| **0.6.3** | 2026-05-25 | Netlify volledig verwijderd. bump-version.ps1 script. GitHub Releases via tags. CHANGELOG.md aangemaakt. |
| **0.6.2** | 2026-05-24 | "Onthoud mij" auto-login. Vaste extensie-ID via manifest key. PWA op agents-controller (Tailscale). Host-selector mobiele sync. |
| **0.6.1** | 2026-05-25 | Netlify-status paneel met deploy-knop en credits-waarschuwing. agents-controller auto-sync timer. |
| **0.6.0** | 2026-05-25 | Host-selector (Lokaal/Netlify) in mobiele synchronisatie-instellingen. |
| **0.5.9** | 2026-05-25 | PWA verhuisd van Netlify naar agents-controller. Node.js server + systemd + Tailscale Serve. |
| **0.5.8** | 2026-05-25 | Claude wekelijkse tijdsbalk (grijze balk) gerepareerd. |
| **0.5.7** | 2026-05-23 | build-info-slot zichtbaar op mobiel. |
| **0.5.6** | 2026-05-23 | Build info-strip inline in Settings. PWA forceert SW-update bij start. |
| **0.5.0** | 2026-05-23 | Remote refresh via background alarm. Telefoon-refresh werkt zonder open dashboard tab. |
| **0.1–0.4** | 2026-05 | Initiële extensie, scrapers, analytics, mobiele sync. |

---

## 7. Roadmap

### TODO-1: Server-side scraper (langetermijn)
Playwright/Puppeteer headless scraper op agents-controller zodat de PC-browser niet open hoeft te staan.

### TODO-2: npoint.io vervangen (langetermijn)
Eigen JSON opslag op agents-controller via kleine REST API — geen externe afhankelijkheid meer.
