# Een eigen gezinsserver

De standaardinstallatie luistert uitsluitend op `127.0.0.1:8771`. Dat maakt hem niet bereikbaar op internet of op andere apparaten. Maak de eerste twee accounts eerst lokaal aan, voordat je gedeeld gebruik inricht.

Voor gedeeld gebruik: installeer op een eigen Linux-server, stel een HTTPS-reverse-proxy (bijvoorbeeld Caddy) in voor een **eigen domein** en laat deze doorsturen naar `127.0.0.1:8771`. De Python-server is niet bedoeld om rechtstreeks aan internet bloot te stellen. Gebruik een aparte servicegebruiker en bewaar de private map buiten de webroot. Stel `FAMILY_DASHBOARD_ORIGINS=https://jouw-eigen-domein` in op de server. Configureer je reverse proxy zo dat alleen deze host wordt geaccepteerd en dat `X-Forwarded-Proto: https` wordt doorgestuurd. Gebruik een passende maximale uploadgrootte en time-outs (pagina-bestanden tot 100 MB, chatbestanden tot 25 MB per bestand).

Maak accounts met een lokale terminal of SSH-portforward. Voor de eerste webinstallatie kun je poort 8771 via SSH naar localhost doorsturen en de lokaal geprinte installatielink gebruiken. Publiceer de eerste-startlink nooit. Een reeds ingestelde database kan niet via de eerste-startpagina opnieuw worden ingesteld.

Voor permanent draaien kun je de eigen servicebeheerder van de server gebruiken. De opdracht is `/pad/naar/thuis/.venv/bin/python /pad/naar/thuis/server.py --host 127.0.0.1 --port 8771`, met `FAMILY_DASHBOARD_DATA` naar de eigen privémap en `FAMILY_DASHBOARD_ORIGINS` naar je HTTPS-origin. Zet automatische herstart aan. Gebruik voor een Windows-server het equivalente Python-pad.

Open op ieder apparaat dezelfde HTTPS-URL. In een ondersteunende browser kun je de webapp installeren of aan het beginscherm toevoegen. De Mac-client heeft een instelbaar serveradres. Pushmeldingen vragen toestemming, browserondersteuning en een `push_contact` in de private configuratie. VAPID-sleutels worden per installatie nieuw aangemaakt; er worden geen sleutels van een andere installatie gedeeld.

## Configuratievoorbeelden

Voeg alleen de onderdelen toe die je gebruikt aan de door de eerste installatie gemaakte config.json. Behoud de ingestelde `members`.

```json
{
  "calendars": [{"name": "Gezin", "file": "agenda.ics", "category": "family"}],
  "photo_links": [{"title": "Onze albums", "url": "https://photos.google.com/"}],
  "holiday_links": [{"title": "Reisplannen", "url": "https://example.com/"}],
  "weather": {"latitude": 0, "longitude": 0},
  "nextcloud_url": "https://cloud.example.com",
  "push_contact": "mailto:beheer@example.com"
}
```

Deze waarden zijn fictief: vul eigen waarden in. Voor een abonnement gebruik je `url` in plaats van `file`. Een geheime ICS-link geeft toegang tot je agenda; bewaar hem alleen in de privéconfiguratie. Categorieën zijn `me`, `family` en `qa` (overig). De agenda en weerweergave gebruiken Europe/Amsterdam en Nederlandse labels.

## Updates en back-up

Stop de server, maak een back-up van de complete privémap, update de broncode en voer `python3 install.py --no-start` uit. Start daarna de server opnieuw. Verwijder bij een update nooit de privémap. Bij verwijderen van de software blijft die privémap bewust bewaard; verwijder persoonsgegevens alleen op uitdrukkelijk verzoek van de eigenaar.
