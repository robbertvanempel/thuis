# Thuis

Je eigen plek voor het gezin: agenda, taken, privéchat, pagina’s en bestanden. Dezelfde kleurrijke webapp op computer, tablet en telefoon, met een optionele native Mac-app.

**Deze openbare versie begint leeg.** Er zijn geen bestaande accounts, wachtwoorden, gezinsfoto’s, documenten, agenda’s, chats of privékoppelingen meegeleverd. Gebruikersgegevens blijven in een aparte lokale map.

## Laat je AI-assistent Thuis installeren

Kopieer dit naar **ChatGPT desktop (Work Local/Codex met lokale toegang)** of **Claude Cowork met toegang tot een lokale map**:

> Installeer Thuis vanaf https://github.com/robbertvanempel/thuis op mijn computer. Lees eerst README.md en INSTALL.md. Gebruik een nieuwe lokale map en voer de installatie uit. Start de app en open de eerste installatiepagina in mijn browser, zodat ik daar zelf mijn accountnamen en wachtwoorden kan invullen. Bewaar mijn gegevens buiten de repository. Controleer dat de app werkelijk op mijn computer draait. Als jouw omgeving alleen een tijdelijke sandbox is, maak dan een lokale startinstructie en leg uit welke stap ik zelf moet uitvoeren.

Een link plakken is een opdracht aan de assistent; het is geen appstore-installatieprotocol. De assistent heeft lokale bestands- en uitvoeringstoegang nodig. Een gewoon chatgesprek of een tijdelijke cloud/VM-sessie kan geen blijvende installatie op je eigen computer garanderen. Zie [INSTALL.md](INSTALL.md) voor de concrete stappen.

## Zelf installeren

Vereist: **Python 3.11 of nieuwer**, internet voor de eerste dependency-installatie en Git (of download de repository als ZIP).

```sh
git clone https://github.com/robbertvanempel/thuis.git
cd thuis
python3 install.py
```

Op Windows gebruik je `py -3 install.py`. De installer maakt een eigen Python-omgeving, een **Start Thuis**-snelkoppeling in de installatiemap, start de server op deze computer en opent het eerste-startscherm. Vul daar twee eigen accountnamen en wachtwoorden in. Er zijn geen standaardwachtwoorden. Daarna log je in op **http://localhost:8771/**.

De installatie overschrijft geen bestaande database. De server draait op de achtergrond zolang je computer aanstaat. Na een herstart dubbelklik je op **Start Thuis.command** (Mac/Linux) of **Start Thuis.cmd** (Windows). Houd de installatiemap op zijn plek.

## Wat zit erin?

- Home met agenda voor zeven dagen, optioneel weer, taken en eigen fotolinks.
- Taken voor vandaag, morgen en later; toewijzen aan de twee ingestelde leden, datums en herinneringen.
- Privéchat tussen die twee accounts, leesbevestigingen, ongelezen teller, bijlagen en optionele meldingen.
- Pagina’s en subpagina’s met een rijke teksteditor, tabellen, afbeeldingen, PDF-preview, toegestane embeds, reacties, bestanden, sortering en herstelbare prullenbak.
- Eigen profielfoto’s; optionele Nextcloud-login en zoeken op bestandsnaam.
- Een plek voor eigen vakantie- en albumlinks.
- Installeerbare webapp (PWA) en native Mac-client met Dock-teller en bestandsdownloads.

De chat en taaktoewijzing volgen het oorspronkelijke **twee-accountmodel**. Extra accounts kunnen via de beheeropdracht pagina’s en algemene taken gebruiken; er zijn geen kindrollen, aparte groepschats of ouderlijk-toezichtfuncties.

## Eigen koppelingen

Bewerk na de eerste installatie `~/.thuis/config.json`. Op Windows is dit `.thuis` in je gebruikersmap. Gebruik [config.example.json](config.example.json) als uitleg, en behoud de ingestelde `members`. **Accountnamen niet achteraf handmatig wijzigen**: die namen horen ook bij bestaande records in de database. Herstart de server na configuratiewijzigingen.

Alles is aanvankelijk uitgeschakeld:

- **Agenda:** je eigen HTTPS-ICS-abonnement (bijvoorbeeld de geheime iCal-link van je Google Agenda), of een `.ics`-bestand binnen de privémap. Herhalende afspraken worden verwerkt. Dit is een alleen-lezen koppeling; bewerk afspraken in je eigen agenda-app. Geheime agendalinks worden niet naar de browser gestuurd.
- **Weer:** stel zelf breedte- en lengtegraad in. Alleen dan vraagt je browser voorspellingen op bij Open-Meteo.
- **Nextcloud:** stel je eigen HTTPS-server in; ieder chataccount koppelt vervolgens zijn eigen Nextcloud-account. De app gebruikt geen centrale opslagdienst.
- **Foto’s/vakanties:** voeg eigen HTTPS-links toe. Er zijn geen meegeleverde gezinsalbums of reisverslagen.
- **Pushmeldingen:** configureer je eigen `push_contact` (een `mailto:`-contactadres of HTTPS-URL). Voor betrouwbaar gebruik op telefoons is een eigen HTTPS-installatie nodig; toestemming en browserondersteuning blijven vereist.

## Telefoons en meerdere computers

De lokale installatie is alleen bereikbaar op de computer waarop ze draait. Voor gedeeld gebruik heb je **één eigen, blijvend draaiende server met HTTPS** nodig. Alle gezinsleden verbinden daarmee, zodat ze dezelfde gegevens zien. Zie [DEPLOYMENT.md](DEPLOYMENT.md). Een aparte lokale installatie op ieder apparaat deelt geen gegevens.

## Mac-app

Met Xcode Command Line Tools geïnstalleerd:

```sh
python3 install.py --mac-app
```

Dit bouwt een universele Mac-client (Apple Silicon en Intel, macOS 13+) in `~/Applications/Thuis.app`. Een bestaande app wordt niet overschreven. De server wordt door de installer gestart; na een herstart gebruik je eerst **Start Thuis**. Kies in het appmenu **Serveradres…** voor een eigen HTTPS-server. De app is ad-hoc ondertekend en niet genotariseerd door Apple.

De [release](https://github.com/robbertvanempel/thuis/releases/latest) bevat ook de Mac-client. Die is een venster naar je eigen server en bevat zelf geen backend of gezinsgegevens.

## Gegevens, back-up en beheer

Standaard staat alles in `~/.thuis`: database, uploads, profielfoto’s, eigen configuratie en optionele integratiesleutels. Kies een andere map met `FAMILY_DASHBOARD_DATA`. Gebruik een privémap buiten de checkout. Maak back-ups van de **hele** privémap terwijl de server gestopt is. Alleen de SQLite-database kopiëren is onvoldoende voor bijlagen en integraties.

Extra account of wachtwoord opnieuw instellen (via een lokale, verborgen terminalprompt):

```sh
.venv/bin/python server.py --add-user "Accountnaam"
```

Windows: `.venv\Scripts\python.exe server.py --add-user "Accountnaam"`. Een wachtwoordwijziging trekt bestaande sessies van dat account in. De twee primaire chataccounts kies je bij de eerste start.

Stop de achtergrondserver met het PID uit `~/.thuis/local-server.json`, nadat je in Activiteitenweergave/Taakbeheer hebt gecontroleerd dat dit de juiste Thuis-server is. Voor gebruik in een terminal: `.venv/bin/python run.py`; stop met Ctrl+C.

## Ontwikkelen

De editor en PDF-assets zijn al gebouwd, dus Node.js is niet nodig voor normaal gebruik. Voor wijzigingen aan de editor is Node.js 22+ nodig:

```sh
npm ci
npm run build
.venv/bin/python -m unittest discover -s tests
npm run test:editor
```

Zie [PRIVACY.md](PRIVACY.md) voor de publicatiegrens en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) voor bibliotheken en lettertypen. Eigen broncode: [MIT](LICENSE).
