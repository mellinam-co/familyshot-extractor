# Familyshot Product Extractor (MVP)

Kleiner externer Webservice fuer den amber-MVP. Er nimmt eine minilu Produkt-URL und versucht, Varianten derselben Produktfamilie inklusive SKU, Farbe und Originalbild zu ermitteln.

## Endpoints

- `/` - Testformular
- `/extract?url=...` - HTML-Ausgabe, gut zum Oeffnen per amber Websuche
- `/api/extract?url=...` - JSON-Ausgabe
- `/health` - Healthcheck

## Lokal mit Docker

```bash
docker build -t familyshot-extractor .
docker run --rm -p 10000:10000 familyshot-extractor
```

Danach: http://localhost:10000

## Render

1. Repo nach GitHub pushen.
2. Render -> New -> Web Service.
3. GitHub-Repo verbinden.
4. Language: Docker.
5. Deploy.
6. Die Render-URL oeffnen, z. B. `https://familyshot-extractor.onrender.com/`.

## Wichtiger MVP-Hinweis

Die Variantenerkennung ist absichtlich heuristisch. Wenn minilu Varianten nicht als Links oder eingebettete URLs in der Produktseite bereitstellt, kann bei einzelnen Produkten nur die aktuelle Variante gefunden werden. Dann muss die Discovery anhand des echten minilu-Frontend-Verhaltens erweitert werden.

Der Service akzeptiert aus Sicherheitsgruenden nur URLs auf `minilu.de` / `www.minilu.de`.
