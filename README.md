# Familyshot Product Extractor – Vercel MVP

Ein kleiner Vercel-Service, der eine minilu.de Produkt-URL öffnet und versucht, Varianten, SKU und Originalbilder zu extrahieren.

## Deploy auf Vercel

1. Neues GitHub-Repository erstellen.
2. Alle Dateien dieses Projekts in das Repository hochladen.
3. In Vercel: **Add New → Project → GitHub Repository importieren**.
4. Framework Preset: **Other** / automatische Erkennung verwenden.
5. Deploy klicken.

Danach z. B.:

- `https://DEIN-PROJEKT.vercel.app/`
- `https://DEIN-PROJEKT.vercel.app/health`
- `https://DEIN-PROJEKT.vercel.app/api/extract?url=ENCODED_MINILU_URL`
- `https://DEIN-PROJEKT.vercel.app/extract?url=ENCODED_MINILU_URL`

## Beispiel

Produkt:

`https://www.minilu.de/shop/product/mundspuelbecher-pp-180ml/111207`

Amber-freundliche URL:

`https://DEIN-PROJEKT.vercel.app/extract?url=https%3A%2F%2Fwww.minilu.de%2Fshop%2Fproduct%2Fmundspuelbecher-pp-180ml%2F111207`

## Amber MVP

Aktiviere im Amber-Agenten Websuche/Webzugriff und gib ihm die öffentliche `/extract?...` URL. Der Endpoint rendert eine einfache HTML-Tabelle, damit Amber nicht mit einem MCP-Handshake arbeiten muss.

## Sicherheit

Dieser MVP akzeptiert absichtlich nur `minilu.de` Produkt-URLs. Dadurch wird der öffentliche Endpoint nicht zu einem beliebigen Browser-Proxy.

## Diagnose

Wenn nur eine Variante gefunden wird, öffne die JSON-URL `/api/extract?...`. Unter `discovery` siehst du, wie viele Kandidaten gefunden wurden. Dann muss ggf. die minilu-spezifische Variant-API oder DOM-Struktur ergänzt werden.

## Hinweis

Der Extractor nutzt einen Headless-Chromium-Browser. Je nach Vercel-Plan/Funktionslimits kann ein Browser-Aufruf länger dauern oder mehr Speicher benötigen. In `vercel.json` sind 60 Sekunden und 2048 MB als Zielwerte gesetzt; falls dein Plan niedrigere Limits erzwingt, passt Vercel die effektiven Limits entsprechend an.
