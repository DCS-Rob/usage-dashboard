# Fase 7 — Onboarding-wizard & overdraagbaarheid

Bron: `VERBETERVOORSTEL.md`, Fase 7 / beoogde versie `0.25.0`.

Doel van deze fase: het dashboard gebruiksvriendelijk overdraagbaar maken naar nieuwe gebruikers of teamleden, zonder dat zij de huidige technische stappen hoeven te begrijpen. Dit is vooral relevant voordat Kevin, Sorin of andere gebruikers hun eigen ChatGPT/Claude-profielen gaan koppelen.

---

## 1. Probleem

De huidige invite-flow werkt voor aansluiten op een bestaand dashboard, maar is nog technisch:

- gebruiker moet weten of hij de extensie of PWA gebruikt;
- unpacked extension moet per Chrome-profiel handmatig geladen en herladen worden;
- iemand met een eigen dashboard moet nu zelf snappen hoe repo, Firebase/bin, pairing key en profielnaam samenhangen;
- meerdere abonnementen van dezelfde persoon vereisen meerdere Chrome-profielen, maar de UI begeleidt dat nog niet volledig.

De harde technische grens blijft:

> Eén Chrome-profiel = één actieve ChatGPT/Claude-sessie per provider.

Dus Kevin met drie ChatGPT-abonnementen heeft drie Chrome-profielen of drie machines nodig. De wizard moet dit uitleggen en begeleiden, niet proberen te omzeilen.

---

## 2. Scope Voor Fase 7

### 2.1 Onboarding-wizard bij eerste start

Toon een wizard wanneer:

- extensie-dashboard voor het eerst opent zonder actieve `lt_sync_config`;
- PWA invite-link wordt geopend zonder extensie;
- gebruiker expliciet kiest voor `Add profile` / `Add team member`.

Wizard-keuzes:

1. **Start my own dashboard**
   - genereert een nieuwe pairing key;
   - maakt een nieuwe Firebase/npoint bin via bestaande providerlaag;
   - zet lokaal `lt_sync_config`;
   - vraagt om een herkenbare profielnaam;
   - begeleidt naar usage-pagina's om data te vullen.

2. **Join an existing dashboard**
   - gebruikt bestaande invite-flow;
   - detecteert of de extensie aanwezig is;
   - toont gerichte instructies:
     - extensie aanwezig maar oud/niet herladen: reload in `chrome://extensions`;
     - extensie ontbreekt: load unpacked of download ZIP;
     - later eventueel Web Store-link.

3. **Add another account/person**
   - legt uit dat een extra ChatGPT/Claude-account een extra Chrome-profiel nodig heeft;
   - genereert invite-link;
   - toont checklist: nieuw Chrome-profiel maken, extensie laden, invite accepteren, inloggen bij provider, usage-pagina openen.

### 2.2 ONBOARDING.md

Maak een aparte `ONBOARDING.md` voor niet-technische gebruikers met:

- installatie als unpacked extension;
- verschil tussen `Extension` en `PWA`;
- wat `PWA Synced` / `PWA Behind` betekent;
- stappen voor “eigen dashboard starten”;
- stappen voor “aansluiten bij bestaand dashboard”;
- stappen voor “extra ChatGPT-account koppelen”;
- troubleshooting:
  - geen kaart zichtbaar;
  - verkeerde account gescraped;
  - extensie niet up-to-date;
  - PC/Chrome offline;
  - PWA loopt achter.

### 2.3 Integratie Met Fase 5

Fase 5 is al deels/volledig aanwezig:

- kaartlabels via ✎;
- account-detectie voor Claude en ChatGPT;
- één kaart per profiel × abonnement;
- account/e-mail als subtitel als detectie lukt.

Fase 7 moet daarop voortbouwen:

- wizard stelt meteen een duidelijke profielnaam voor, bijvoorbeeld `Sorin - ChatGPT`;
- na eerste scrape wijst de UI op de ✎-knop om het abonnementlabel te verfijnen;
- als account-detectie een ander account ziet dan verwacht, later waarschuwing tonen.

---

## 3. Buiten Scope / Later

Niet meteen in deze fase doen zonder aparte beslissing:

- automatische login bij ChatGPT/Claude;
- credentials opslaan;
- twee accounts uit één Chrome-profiel uitlezen;
- migratie naar Chrome Web Store publiceren;
- automatische update van unpacked extensions;
- volledige AES-GCM-migratie, tenzij bewust als aparte subfase gestart.

Wel voorbereiden:

- tekst en UI zo schrijven dat een Web Store-link later makkelijk de ZIP/unpacked route kan vervangen;
- onboarding zo ontwerpen dat AES-GCM later geen UX-breuk geeft.

---

## 4. Mogelijke Implementatievolgorde

### Stap 1 — ONBOARDING.md

Eerst documenteren, zodat de wizardtekst en echte stappen gelijk lopen.

Deliverable:

- `ONBOARDING.md`
- link ernaar vanuit de PWA install-assistent.

### Stap 2 — Wizard-shell

Maak een eenvoudige wizard-component in `index.html`/`app.js`:

- modal of inline panel;
- drie keuzes;
- geen nieuwe sync-logica, alleen bestaande functies aanroepen.

### Stap 3 — Start My Own Dashboard

Herbruik bestaande mobile sync setup:

- provider kiezen, standaard Firebase;
- pairing key/bin genereren;
- profielnaam opslaan;
- dashboard openen;
- usage-pagina knoppen tonen.

### Stap 4 — Join Existing Dashboard Verbeteren

Huidige invite-flow uitbreiden:

- extensie-detectie duidelijker;
- reload-stap prominent;
- na accept uitleg: “log in op ChatGPT/Claude in dit Chrome-profiel en open de usage pagina”.

### Stap 5 — Add Another Account/Person

Nieuwe wizardroute voor Rob/Kevin/Sorin-test:

- persoon/accountnaam invullen;
- provider kiezen;
- invite-link genereren;
- stappen tonen voor nieuw Chrome-profiel of andere computer.

---

## 5. Testscenario Sorin

Doel: Sorin’s ChatGPT-account als aparte kaart zichtbaar krijgen.

1. Hoofddashboard opent `Add another account/person`.
2. Naam: `Sorin`.
3. Provider: `ChatGPT`.
4. Wizard genereert invite-link.
5. In nieuw Chrome-profiel `Sorin`:
   - extensie laden/reloaden;
   - invite-link openen;
   - invite accepteren;
   - inloggen op Sorin’s ChatGPT-account;
   - ChatGPT usage/analytics pagina openen.
6. Dashboard toont in `All profiles` een aparte ChatGPT-kaart.
7. Label eventueel aanpassen naar `Sorin - ChatGPT`.
8. Account/e-mail subtitel controleren.

Succescriteria:

- geen login-scherm na invite accept;
- profiel verschijnt in profile switcher;
- ChatGPT-kaart verschijnt na scrape;
- label wordt gedeeld via `dashboardConfig.labels`;
- PWA toont dezelfde kaart na `PWA Synced`.

---

## 6. Beslispunten Voor Uitvoering

Voor implementatie bevestigen:

1. Moet Fase 7 alleen onboarding + docs zijn, of ook direct “Start my own dashboard” volledig werkend?
2. Willen we de wizard primair Engels houden, zoals de rest van de UI?
3. Moet Chrome Web Store/unlisted nu al voorbereid worden als tekstoptie, of nog niet zichtbaar zijn?
4. AES-GCM-migratie wel of niet meenemen in Fase 7? Advies: niet combineren met onboarding; apart plan maken.

---

## 7. Advies

Begin met:

1. `ONBOARDING.md`
2. wizard voor `Join existing dashboard`
3. wizard voor `Add another account/person`

Laat `Start my own dashboard` en AES-GCM daarna volgen. Dat is veiliger, omdat Sorin/Kevin testen vooral gaat over bestaande dashboard-invite + extra Chrome-profielen.
