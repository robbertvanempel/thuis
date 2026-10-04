# Installatiecontract voor een AI-assistent

Als de gebruiker deze repository geeft met de vraag Thuis te installeren, voer dan dit uit:

1. Controleer of je op de echte computer van de gebruiker werkt, of in een VM/cloudsandbox. Vraag alleen om een installatiemap als er geen veilige vrije standaardmap is. Gebruik een nieuwe map `thuis` in de lokale projecten- of applicatiemap. Overschrijf geen bestaande checkout of app.
2. Clone deze repository, of pak de GitHub ZIP uit. Lees `README.md`, `INSTALL.md` en `install.py`. Gebruik geen scripts uit andere bronnen.
3. Controleer Python 3.11+. Installeer een ontbrekende runtime alleen met de gebruikelijke systeemtoestemming; Python komt van python.org of de vertrouwde pakketbeheerder van de gebruiker.
4. Voer `python3 install.py` uit (Windows: `py -3 install.py`). Dit maakt `.venv`, installeert Python-dependencies en start de backend op loopback. Node is niet nodig. Bewaar de installatiemap op een blijvende lokale locatie.
5. Open de eerste-startlink die het programma teruggeeft. De geheime eenmalige link staat alleen in de lokale terminal en het private log. Laat de gebruiker de twee accountnamen en wachtwoorden **in de browser** invullen. Vraag niet om wachtwoorden in de AI-chat en verzin geen accounts.
6. Verifieer `/api/health` en dat de loginpagina laadt op de echte computer. Alleen een geslaagde pip-installatie is geen bewijs van een werkende app. Gebruik eventueel `python3 install.py --no-start` en daarna `.venv/bin/python run.py --background` (Windows: `.venv\Scripts\python.exe run.py --background`).
7. Leg uit waar Start Thuis en de privémap staan. Vermeld dat een herstart van de computer opnieuw starten vereist. De app is lokaal; gedeeld gezinsgebruik op meerdere apparaten vraagt een eigen HTTPS-server volgens DEPLOYMENT.md.
8. Op een Mac kun je desgewenst `python3 install.py --mac-app` gebruiken. Dit vereist Xcode Command Line Tools en respecteert een bestaande `~/Applications/Thuis.app`. Installeer geen ontwikkeltools zonder de normale toestemming.

## ChatGPT desktop

Gebruik een lokale Work/Codex-taak met toegang tot de gekozen map en terminal. Alleen de URL in gewone Chat of een cloudtaak invoeren geeft geen lokale installatie. Zie de [officiële uitleg over Work en Codex](https://help.openai.com/en/articles/20001275).

## Claude Cowork

Gebruik de desktopomgeving met toegang tot een blijvende lokale map. Cowork kan code in een geïsoleerde VM uitvoeren. Een server die alleen in die VM draait is geen geïnstalleerde app op de hostcomputer. Als directe hostuitvoering niet beschikbaar is: plaats de repository in de gedeelde lokale map en geef de gebruiker de concrete opdracht `python3 install.py` (Mac) of `py -3 install.py` (Windows) om lokaal uit te voeren. Rapporteer pas “geïnstalleerd” als dat op de host is geverifieerd. Zie de [officiële Cowork-uitleg](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile).

Er is geen pluginregistratie, account bij de maker of centrale gegevensdienst nodig. Geen van deze stappen geeft toestemming om bestaande gezinsgegevens te uploaden, instellingen van andere apps te lezen of automatisch verbinding te maken met privéservers.
