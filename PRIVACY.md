# Privégrens

Deze repository bevat functionaliteit en neutrale UI-assets. De publicatie is opgebouwd uit geselecteerde bronbestanden in een nieuwe Git-repository; de geschiedenis en data van de oorspronkelijke privé-installatie zijn niet overgenomen.

Niet inbegrepen: gebruikers of wachtwoordhashes, databases, berichten, taken, agenda-items, geïmporteerde pagina’s, bijlagen, profielfoto’s, vakantiegegevens, persoonlijke serveradressen, sleutels, back-ups, logs of screenshots van een echt gezin. De eerste installatie creëert nieuwe accounts; de inhoudstabellen beginnen leeg.

Eigen data staat standaard in ~/.thuis, buiten de checkout. De server geeft alleen vooraf toegestane frontendbestanden publiek terug. API-data, pagina’s, bijlagen en profielfoto’s vereisen een sessie. De private configuratie wordt niet als statisch bestand geserveerd. Mutaties vereisen een geldige Origin. Wachtwoorden worden gehasht; sessietokens staan gehasht in SQLite. De database en uploads zijn niet volledig versleuteld: bescherm de computer, schijf en back-ups met de middelen van je besturingssysteem.

Er is geen telemetry en geen account bij de maker. Externe verzoeken ontstaan alleen door ingestelde functies of handelingen: weer via Open-Meteo, eigen kalenderabonnementen, eigen Nextcloud, geopende links en ingesloten media, of optionele browser-push. Tijdens installatie worden dependencies gedownload. Bij ingeschakelde push kunnen een afzender en een kort berichtfragment op het vergrendelscherm verschijnen, volgens de instellingen van je apparaat.

De twee chataccounts hebben gedeeld toegang tot de chat. Algemene taken, pagina’s en bestanden worden gedeeld tussen ingelogde accounts. Er zijn geen afzonderlijke rechten voor kinderen of individuele pagina’s.

De .gitignore is een vangnet, geen privacycontrole. Publiceer uitsluitend gecontroleerde bronbestanden; ook commitgeschiedenis, gegenereerde binaries en release-archieven moeten worden gecontroleerd. Gebruik alleen fictieve gegevens voor tests of demonstraties.
