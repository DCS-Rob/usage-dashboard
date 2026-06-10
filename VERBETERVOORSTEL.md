# Verbetervoorstel Usage Dashboard — voor uitvoering door Sonnet 4.6

Geschreven 2026-06-10 na een live werking-check (v0.18.0). Dit document is het werkplan
voor de volgende ontwikkelsessies. Lees éérst `project_summary.md` (architectuur +
versiebeheer-protocol) — dat blijft leidend. Dit document beschrijft **wat** er beter
moet, **waarom** (met meetgegevens), en **hoe** (gefaseerd, klein beginnen).

---

## 0. Bevindingen uit de live check (2026-06-10)

Gecontroleerd via Firebase REST (de gedeelde bin op pad `profiles/<binId>`) en code-analyse:

| Bevinding | Meting | Oordeel |
|---|---|---|
| Bin bereikbaar, security rules blokkeren listing zonder bin-ID | root/shallow read → `Permission denied` | ✅ goed |
| Structuur klopt: alles (profiles, dashboardConfig, logs) zit ín het versleutelde `data`-veld | top-level keys: alleen `data` | ✅ by design |
| **Documentgrootte: 255 KB** — wordt bij élke read én write volledig overgedragen | `255.251 bytes` | ⚠️ te groot |
| Download-latency Firebase europe-west1 | ~0,3 s per fetch | ✅ netwerk is niet het probleem |
| PWA pollt het volledige document elke **25 s** (app.js ~408) | 255 KB × 144/uur ≈ **36 MB/uur** dataverbruik op mobiel | ⚠️ |
| Remote-refresh keten: vlag → PC-alarm **30 s** → throttle **90 s** → scrape 5–15 s → fast-poll detectie | worst-case > 2 min; fast-poll stopt na 90 s **zonder melding** | ⚠️ hoofdoorzaak klachten 1 & 2 |
| Read-modify-write zonder conditional writes | gelijktijdige schrijvers kunnen elkaar overschrijven (race) | ⚠️ latent risico |
| "Encryptie" is XOR met de pairing key | geen echte cryptografie; patroonlek bij bekende plaintext | ⚠️ (er bestond al AES-GCM code in v0.8.0-beta) |

**Conclusie:** het netwerk is snel, maar het *protocol* is traag (polling-ketens) en het
*document* is te dik (logs/threads van alle profielen in één blob). Beide zijn oplosbaar
zonder de architectuur om te gooien.

---

## 1. Klacht: "Syncen duurt erg lang"

### Oorzaken
1. **Polling-keten** i.p.v. push: telefoon schrijft `refreshRequested` → PC-achtergrondalarm checkt pas elke 30 s → throttle staat max 1 scrape per 90 s toe → daarna moet de telefoon de nieuwe data nog zelf oppikken (fast-poll 2,5 s).
2. **Vol document per transfer**: elke sync verplaatst 255 KB, waarvan het overgrote deel (logs/threads-historie) zelden verandert.
3. PWA-achtergrondverversing is een traag 25 s-interval; desktop leest cloud-profielen elke 60 s.

### Oplossing A (quick win, ~klein): Firebase **streaming** i.p.v. polling
Firebase RTDB REST ondersteunt **Server-Sent Events**: `GET .../profiles/<binId>.json` met
header `Accept: text/event-stream` geeft realtime push bij elke wijziging.
- PWA: vervang de 25 s-poll door een `EventSource`-verbinding (met fallback naar de huidige poll voor npoint).
- Extensie-dashboard: idem voor de 60 s-cloudprofielen-reload.
- Resultaat: wijziging op profiel A is **<1 s** zichtbaar op B; einde aan "convergentie ≤60 s".
- Let op: alleen voor Firebase; npoint blijft pollen (fallback-pad behouden).

### Oplossing B (structureel, ~middel): document opsplitsen
Nieuw datamodel in de bin (één migratiestap, met fallback-lezing van het oude formaat):

```
profiles/<binId>/
  meta/                     ← KLEIN (~1 KB), géén zware historie
    refreshRequested, refreshRequestedAt
    profiles/<pid>/ { label, lastSeen, version }
    config                  ← versleutelde dashboardConfig
  status/<pid>              ← versleuteld syncStatus-snapshot per profiel (~2 KB)
  archive/<pid>             ← versleutelde logs/threads per profiel (alleen bij wijziging geschreven)
```

- Telefoon streamt/pollt alleen `meta` + `status` (paar KB i.p.v. 255 KB → ~99% minder dataverkeer).
- Schrijvers raken alleen hun eigen node → **einde aan het read-modify-write-risico** voor de hete paden (de gouden regel blijft gelden voor `meta/config`).
- Gebruik Firebase **conditional writes** (`X-Firebase-ETag: true` bij lezen, `if-match: <etag>` bij schrijven, retry bij 412) voor de nodes die wél gedeeld zijn.

### Oplossing C (quick win, ~klein): remote-refresh keten verkorten
- Throttle van 90 s → 30 s (de oorspronkelijke reden — dubbele triggers — is al opgelost door de enkele poller).
- Fast-poll niet stoppen na 90 s maar terugvallen op een rustige poll **mét statusmelding** (zie klacht 2).
- Met Oplossing A kan het PC-alarm de `refreshRequested`-vlag ook via streaming zien → reactie in seconden i.p.v. tot 30 s wachten.

**Aanbevolen volgorde: C → A → B** (elk los shipbaar met eigen versie-bump).

---

## 2. Klacht: "Syncen op mobiel werkt vaker niet"

### Oorzaken
1. **De PC moet aan staan** met Chrome open; bij slapende PC gebeurt er niets — en de PWA **meldt dat nergens**. De fast-poll geeft na 90 s stil op; voor de gebruiker is dat onzichtbaar "kapot".
2. MV3 service worker kan door Chrome gestopt worden; het alarm wekt hem wel, maar een gestrande scrape (bv. tabblad-fout, niet ingelogd) wordt niet gerapporteerd.
3. Meerdere Chrome-profielen draaien elk hun eigen alarm + delen de throttle niet → het "verkeerde" profiel kan de refresh claimen en niets leveren.

### Oplossingen
1. **Status-transparantie in de PWA (eerst doen, ~klein):**
   - Heartbeat: elke achtergrond-poll schrijft `meta/profiles/<pid>/lastSeen` (kleine write).
   - PWA toont per profiel: 🟢 online (lastSeen < 2 min) / 🟡 traag / 🔴 offline — "PC offline sinds 12:34, laatste data van 12:31".
   - Refresh-knop geeft een duidelijk verloop: *aangevraagd → PC gezien → bezig met scrapen → klaar* (of: *PC reageert niet*). Dit haalt 80% van de "werkt niet"-frustratie weg, ook als de oorzaak (PC uit) blijft bestaan.
2. **Refresh-claim per profiel (~klein):** `refreshRequested` wordt `refreshClaims/<pid>` zodat zichtbaar is wíe hem oppakt en een tweede profiel het kan overnemen als de eerste na 60 s niets levert.
3. **Scrape-foutrapportage (~klein):** als `triggerScrapeFromBackground` faalt (geen login, tab-fout), schrijf `meta/profiles/<pid>/lastError` zodat de PWA de echte oorzaak kan tonen ("Niet ingelogd op claude.ai op profiel DCS").
4. **Definitieve fix (roadmap TODO-2, ~groot):** server-side scraper (Playwright op agents-controller) zodat de PC-afhankelijkheid helemaal verdwijnt. Pas oppakken na 1–3.

---

## 3. Klacht: "Waar staat de data en hoe benader ik die?"

### Feiten (nu al, ter referentie)
- **Primair:** Firebase Realtime Database, project `usage-dashboard-98f1d`, regio `europe-west1`, pad `profiles/<binId>` (de bin-ID staat in de extensie-opslag als onderdeel van `lt_sync_config`).
- **Console:** `https://console.firebase.google.com/project/usage-dashboard-98f1d/database` — maar de payload is daar versleuteld, dus je ziet alleen een blob.
- **Fallback:** npoint.io bin (zelfde versleutelde vorm).

### Oplossing: "Data & Sync"-paneel in Settings (~middel)
Eén plek in het dashboard die alles toont wat je nu niet kunt zien:
- Verbinding: provider (Firebase/npoint), bin-ID (kopieerbaar), regio, link naar de Firebase-console.
- Gezondheid: documentgrootte, laatste push/pull per profiel, latency-test-knop.
- **Data-inzage:** knop "Bekijk mijn data" → toont de *ontsleutelde* JSON (read-only viewer met inklapbare secties), want het dashboard hééft de pairing key al. Plus "Download als JSON" (export/backup) en "Importeer JSON" (restore).
- Opruimen: logs/threads-historie inkorten ("bewaar laatste 90 dagen") — drukt meteen de documentgrootte van klacht 1.

---

## 4. Klacht: "Niet makkelijk overdraagbaar naar iemand anders"

### Analyse
De invite-flow deelt jóuw bin + key (= meekijken in jouw dashboard). Voor iemand die een
**eigen** dashboard wil (eigen abonnementen, eigen data) is er geen begeleide route: die
moet nu zelf de repo clonen, unpacked laden, en snappen hoe pairing werkt.

### Oplossingen
1. **Onboarding-wizard bij eerste start (~middel):** twee duidelijke keuzes:
   - *"Start een eigen dashboard"* → genereert automatisch een nieuwe bin-ID + pairing key (zero-config; de gedeelde Firebase kan meerdere bins aan, rules blokkeren listing) en begeleidt: log in op je AI-accounts → blokken verschijnen vanzelf.
   - *"Sluit aan bij een bestaand dashboard"* → de huidige invite-link-flow.
2. **Chrome Web Store, unlisted (~klein, eenmalig ±$5):** 1-klik installatie + auto-update. Lost ook het grootste overdraagbaarheids-probleem op: "stuur deze link" i.p.v. ZIP + unpacked + handmatig herladen per versie. (De `key` in manifest.json borgt dat de extensie-ID gelijk blijft.)
3. **`ONBOARDING.md` in de repo (~klein):** stap-voor-stap voor een nieuwe gebruiker, gelinkt vanaf de PWA-installatie-assistent.

---

## 5. Klacht: "Meerdere abonnementen van één persoon (Kevin) koppelen gaat niet lekker"

### Analyse — de harde grens éérst
Eén Chrome-profiel heeft één ingelogde sessie per provider (zie ROADMAP §2). Kevin met
drie ChatGPT-abonnementen (op jouw plan / eigen bedrijf / privé) heeft dus **drie
Chrome-profielen** nodig — daar is niet omheen te bouwen. Wat wél beter kan, is hoe het
dashboard die situatie begeleidt en toont:

1. **Abonnement-labels per kaart (~klein):** `dashboardConfig.labels["<pid>|<provider>"] = "Kevin — bedrijf"`, instelbaar via een ✎ op de kaart. Nu heet alles naar het Chrome-profiel; drie ChatGPT-kaarten van Kevin zijn niet uit elkaar te houden.
2. **Account-detectie in de scraper (~middel):** `content.js` leest op de usage-pagina ook het ingelogde account/de organisatie (e-mail of workspace-naam staat op de pagina) en stuurt dat mee in `syncStatus.<provider>.account`. De kaart toont het als ondertitel, én het dashboard kan **waarschuwen als het account wisselt** ("Dit profiel scrapte eerst *kevin@bedrijf*, nu *kevin@gmail* — klopt dat?"). Dit voorkomt dat data van het verkeerde abonnement in de verkeerde kaart belandt — de kern van het "niet lekker koppelen".
3. **Begeleide koppel-flow (~klein):** bij "Add a usage block" voor een provider waar dit profiel al op is ingelogd met een ánder account: leg uit dat hiervoor een extra Chrome-profiel nodig is + knop die de invite-link genereert. Nu faalt dit stil.
4. **Groepering per persoon** (= profielgroepen, ROADMAP Fase 1-restant, ~middel): kaarten clusteren onder "Rob" / "Kevin" met een kopregel per persoon.

---

## 6. Klacht: "Hoofdmenu overzichtelijker; profielen in een submenu"

### Voorstel (~middel)
- **Profielenbalk uit de header** → uitklapbaar zijpaneel/submenu "Profielen & verbinding" (hamburger of avatar-stack-icoon met badge voor het aantal online profielen). Daarin: profielenlijst met status-dots, hernoemen, ✕ verwijderen, invite-knop, en het Data & Sync-paneel uit klacht 3.
- **Header reduceren tot functionele info:** titel, sync-status (PWA Synced/Behind), refresh-knop, settings-tandwiel. Environment-badge (Extension/PWA) en versienummer naar de settings/het zijpaneel.
- **Restore-chips en "Add a usage block"** samenvoegen tot één "+"-knop rechtsboven de kaarten-grid (menu: blok toevoegen / verborgen blokken terugzetten). De chips-balk verdwijnt uit het hoofdbeeld.
- **Optioneel:** compacte kaart-modus (alleen ring + percentage + resettijd; klik = uitklappen naar volledige pace-balken). De volledige pace-balken blijven de standaard — die zijn heilig (zie project_summary).

---

## 7. Prioritering & fasering (voorstel)

| Fase | Versie | Inhoud | Omvang |
|---|---|---|---|
| 1 | 0.19.0 | Quick wins betrouwbaarheid: heartbeat + status in PWA (2.1), refresh-claim (2.2), scrape-foutmelding (2.3), throttle 90→30 s (1.C), fast-poll-fallback met melding | klein–middel |
| 2 | 0.20.0 | Firebase **streaming** voor PWA + extensie (1.A) | klein–middel |
| 3 | 0.21.0 | **Datamodel-split** meta/status/archive + ETag-writes + logs-retentie (1.B, deel 3) | groot — eigen plan + migratiepad eerst |
| 4 | 0.22.0 | Data & Sync-paneel incl. ontsleutelde data-viewer + export/import (3) | middel |
| 5 | 0.23.0 | Abonnement-labels + account-detectie + koppel-flow (5.1–5.3) | middel |
| 6 | 0.24.0 | UI-herindeling: profielen-zijpaneel, header opschonen, "+"-menu (6) | middel |
| 7 | 1.0.0? | Onboarding-wizard + Web Store unlisted + ONBOARDING.md (4); evt. AES-GCM-migratie (zie hieronder) | middel |

Los van de fasen, meenemen wanneer het pad toch openligt:
- **AES-GCM i.p.v. XOR**: de WebCrypto-code bestond al in v0.8.0-beta (`secureData`). XOR met de pairing key is geen echte encryptie. Migratie = nieuwe payload-versie met fallback-lezing van XOR.
- Profielgroepen & drag-to-reorder blijven op de roadmap (combineren met fase 5/6 waar logisch).

## 8. Werkafspraken voor de uitvoerende sessie (Sonnet 4.6)

1. **Lees eerst `project_summary.md`** — versiebeheer-protocol is verplicht: CHANGELOG → `.\bump-version.ps1 -Version X.Y.Z` → commit + tag + push → extensie handmatig herladen in **alle** Chrome-profielen.
2. **Gouden regel blijft:** elke schrijf naar een gedeelde node = read-modify-write (en bij fase 3: ETag-conditional). Nooit een gedeeld document blind overschrijven.
3. **Eén fase per keer**, elk los getest (Claude_Preview MCP `usage-dashboard-pwa`, sync-provider stubben via `SYNC_PROVIDERS.npoint.read/write`) en los geshipt. Niet vooruitgrijpen op latere fasen.
4. **Fase 3 (datamodel-split) niet beginnen zonder eerst een migratieplan voor te leggen** — dat is de enige wijziging die bestaande data raakt. Oud formaat moet leesbaar blijven tot alle clients over zijn.
5. De volledige pace-balken en provider-kleuren (Claude oranje, ChatGPT groen, Gemini blauw) zijn onaantastbaar.
6. Veiligheidsregels: geen accounts aanmaken, geen credentials/keys invoeren, privésleutel blijft buiten de extensie-map.
