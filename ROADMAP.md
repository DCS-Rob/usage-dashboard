# Roadmap — Usage Dashboard → Multi-account & Team (v0.8+)

Forward-looking plan. Bevat visie, het kerninzicht dat de architectuur bepaalt,
haalbaarheid (wat wel/niet kan), de gekozen richting en een gefaseerde uitwerking.
Dit document is leidend voor de grote update; details kunnen per fase bijgesteld worden.

> **Stand van zaken (v0.25.0):** Fase 1 grotendeels af. Fase 2 deels live. Fase 5 (labels +
> account-detectie) en Fase 6 (UI-herindeling: profiel-switcher in hoofdbalk, blokbeheer in
> dropdown) zijn volledig opgeleverd. Fase 7 onboarding-wizard + `ONBOARDING.md` is live.
> Firebase SSE-streaming actief (< 1s latency). Twee
> Chrome-profielen live getest en gekoppeld. Open: drag-to-reorder, profielgroepen, Fase 3 analyse.

---

## 1. Visie

Van een **persoonlijk** usage-tool naar een **multi-account & team** dashboard:

- Meerdere accounts volgen (bv. "GPT — Kevin", "GPT — Rob", later ook Claude), zowel binnen als buiten hetzelfde ChatGPT-team.
- Individuele dashboards (kaarten) per profiel: **aan/uit togglen, tonen/verbergen en herordenen**.
- **Gratis** blijven en zo **gebruiksvriendelijk** mogelijk delen.
- **Globale updates via GitHub** (zonder dat iedereen handmatig moet bijwerken).
- Later: **gedeelde database** voor diepere usage-analyse.

## 2. Het kerninzicht (bepaalt alles)

De extensie scrapet de **account die op dat moment is ingelogd** in de browser.
Gevolg: **één browser(profiel) = één ChatGPT-sessie.** Je kunt niet twee ChatGPT-accounts
tegelijk uit één sessie lezen.

**Robuust model:** elk account wordt gevoed door een **eigen Chrome-profiel** (eigen login),
of door een **eigen machine** (teamlid). Alle data komt samen in één gedeelde **database**,
en het dashboard toont per account/persoon een kaart.

Daarom is de database geen "fase 2 nice-to-have" maar het **fundament**.

## 3. Beta-beleid & versienummering

Het project is in **beta** zolang de eigenaar niet expliciet besluit tot publieke vrijgave. Alle versies `0.x.x` zijn intern/beta — functioneel volledig, maar niet officieel vrijgegeven. `v1.0.0` wordt **uitsluitend** getagd op expliciete eigenaarsbeslissing na volledige test en goedkeuring (bv. bij keuze voor Web Store-distributie of brede teamdeling). Nooit automatisch bumpen naar 1.0.0. Zie het versie-schema in `project_summary.md`.

## 4. Gekozen richting (op basis van beslissingen)

| Beslissing | Keuze |
|---|---|
| Profiel-model | **Vooral ikzelf, meerdere accounts** (Chrome-profielen). Team-delen volgt later op hetzelfde fundament. |
| Distributie | **Gratis + gebruiksvriendelijk** → dunne scraper-extensie + dashboard-UI op de PWA (GitHub Pages). |
| Database | **Naar voren gehaald** → Firebase als fundament. |

### Aanbevolen doelarchitectuur

```
┌────────────────────────────┐      ┌─────────────────────────────┐
│  Dunne scraper-extensie     │      │  Dashboard-UI (PWA)         │
│  (per Chrome-profiel)       │      │  GitHub Pages — auto-update │
│  • content.js + background  │      │  • toont alle profiel-kaarten│
│  • scrapet actieve sessie   │      │  • toggle/herorden/analyse  │
│  • schrijft naar Firebase   │      │  • leest uit Firebase       │
└─────────────┬───────────────┘      └──────────────┬──────────────┘
              │  write                                │ read (realtime)
              ▼                                       ▼
        ┌──────────────────────────────────────────────────┐
        │   Firebase (gratis) — profielen, usage, historie   │
        │   E2E waar zinvol; security rules per profiel/team │
        └──────────────────────────────────────────────────┘
```

**Waarom dit gratis + gebruiksvriendelijk is:**
- UI-updates → gratis & automatisch via GitHub Pages (geen Web Store-kosten).
- De extensie wordt klein en stabiel → bijna nooit handmatig bijwerken.
- De PWA is de viewer; de extensie alleen de "voeler". Beide delen dezelfde codebasis.

> Optioneel later: extensie naar de **Chrome Web Store (unlisted, eenmalig ±$5)** voor
> 1-klik installatie + auto-update. Niet nodig om te starten; puur extra gemak.

## 4. Haalbaarheid — wat kan wel/niet

### Kan (goed)
- Meerdere benoemde profiel-kaarten per provider (Kevin, Rob, …).
- Meerdere accounts op één PC via **aparte Chrome-profielen**.
- Profiel toevoegen/hernoemen/verwijderen; klik op provider-logo → "profiel koppelen".
- Kaarten **togglen (tonen/verbergen)** en **herordenen** (drag-and-drop, lokaal gebundelde lib i.v.m. MV3).
- Per-persoon **profielgroepen** ("folders"-gevoel) + **JSON export/import**.
- Globale UI-updates via GitHub (PWA).
- Gedeelde database + later teamtracking + analyse.

### Kan niet / niet zo
- **Accounts automatisch inloggen/koppelen** — verboden + technisch niet hoe scraping werkt. "Koppelen" = profiel benoemen en de juiste sessie ernaartoe laten scrapen.
- **Twee accounts van dezelfde provider uit één sessie** — Chrome heeft één sessie per site per profiel → aparte Chrome-profielen nodig.
- **Per-teamlid limieten zien vanuit één admin-account** — providers tonen dat niet scrapebaar; ieder trackt zijn eigen.
- **Echte OS-mappen vanuit het dashboard** — sandbox; vervangen door profielgroepen + JSON export/import.
- **Auto-update van een "unpacked" extensie via GitHub** — bestaat niet voor gewone gebruikers; daarom UI op PWA + (optioneel) Web Store.

## 5. Gefaseerd plan

### Fase 1 — Database-fundament + multi-account profielen + kaartbeheer  ✅ grotendeels af
- ✅ Firebase erin als opslag (primair, npoint als fallback), achter de bestaande provider-laag.
- ✅ **Multi-profiel**: elk Chrome-profiel pusht onder eigen `profileId`; dashboard toont één kaart per (profiel × abonnement).
- ✅ **Profiel-beheer**: toevoegen via invite-link, hernoemen, verwijderen (✕ op de profiel-tab).
- ✅ **Toggle tonen/verbergen** per kaart + auto-zichtbaarheid op basis van data. Sinds v0.18.0 **gesynct over alle profielen** via gedeelde `dashboardConfig` (configureer op het ene profiel → zichtbaar op de andere).
- ⬜ **drag-to-reorden** van kaarten — nog te doen.
- ⬜ **Profielgroepen** ("folders"-gevoel) — nog te doen.
- ✅ **Multi-account via Chrome-profielen**: scraper tagt data aan het ingelogde profiel.
- ✅ Werkt in zowel extensie als PWA (gedeelde code).

### Fase 2 — Dashboard-UI als primaire PWA + team-delen  🔶 deels live
- ✅ PWA (GitHub Pages) leest uit Firebase → gratis globale updates.
- ✅ Auto-login extensiemodus; de extensie schrijft per profiel naar de cloud.
- ✅ **Team-delen (basis)**: anderen accepteren een invite-link, schrijven hun profiel naar de gedeelde bin en verschijnen als kaarten.
- ⬜ Selectie/groepen van welke profielen je toont (per-persoon groepen).

### Fase 3 — Analyse-database & inzichten
- Historische usage per profiel/model/tijd; "waar gaat mijn/ons verbruik aan op".
- Grafieken, trends, teamvergelijking, exports.

### Taal
- **Nu: Engels-first** — de hele zichtbare UI is naar het Engels omgezet zodat het hele team ermee kan werken.
- **Later: NL/EN-keuze (i18n)** — een taalschakelaar; teksten in een centrale strings-tabel zodat uitbreiden naar meer talen makkelijk is.
- De scraper (`content.js`) blijft **meertalig matchen** (EN + NL woorden) zodat het uitlezen werkt ongeacht de taal van het Claude/ChatGPT-account.

## 6. Wat ik van jou nodig heb
- **Eenmalig een Firebase-project aanmaken** (±10 min). Ik lever een klik-voor-klik stappenplan + de config om te plakken. Ik kan zelf geen accounts aanmaken (veiligheidsregel).
- Bevestiging per fase voordat ik de volgende start.

## 7. Veiligheid & privacy
- Geen automatische logins; scraping leest alleen de actieve sessie.
- Firebase security rules per profiel/team; gevoelige sync-payloads versleuteld.
- Publieke PWA-hosting blijft veilig zolang data versleuteld/afgeschermd is.

---

*Status (v0.25.0): Fase 1 grotendeels af, Fase 2 deels live, Fase 5 + 6 volledig opgeleverd, Fase 7 onboarding live. Resterend: drag-to-reorder & profielgroepen (Fase 1/2), analyse-database (Fase 3), eventuele AES-GCM-migratie als aparte fase.*
