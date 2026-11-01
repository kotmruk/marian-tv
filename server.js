const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_TARGET = "https://meta.vcdn.biz/..."; // Twój domyślny URL

// --- KONFIGURACJA BEZPIECZEŃSTWA (opcjonalna, ale zalecana) ---
// Biała lista dozwolonych hostów, aby zapobiec SSRF.
// Jeśli chcesz zezwolić na dowolny host, pozostaw pustą tablicę.
const ALLOWED_HOSTS = [
    'meta.vcdn.biz',
    'embed.megogo.net',
    // Dodaj inne zaufane hosty
];

function isHostAllowed(urlString) {
    if (ALLOWED_HOSTS.length === 0) return true; // Brak restrykcji
    try {
        const host = new URL(urlString).hostname;
        return ALLOWED_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
        return false;
    }
}

app.get('/', async (req, res) => {
    let targetUrl = req.query.url ? decodeURIComponent(req.query.url) : DEFAULT_TARGET;

    // 1. Walidacja hosta (ochrona przed SSRF)
    if (!isHostAllowed(targetUrl)) {
        return res.status(403).send("Dostęp do tego hosta jest zabroniony.");
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 sekund timeoutu

        const response = await fetch(targetUrl, {
            signal: controller.signal,
            redirect: 'follow', // Domyślnie podąża za przekierowaniami
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://embed.megogo.net/',
                'Origin': 'https://embed.megogo.net',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // Jeśli serwer źródłowy zwrócił błąd, przekaż go dalej
            return res.status(response.status).send(`Błąd źródła: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

        // 2. Obsługa strumieni (segmenty, klucze, obrazy itp.)
        if (!isM3U8) {
            // Dla plików binarnych (np. .ts, .key) przekazujemy strumień bez buforowania
            // i obsługujemy Range requests, jeśli są obecne.
            res.setHeader('Access-Control-Allow-Origin', '*');
            const range = req.headers.range;
            if (range) {
                // Przekaż nagłówek Range do źródła
                const rangeResponse = await fetch(targetUrl, {
                    headers: { ...response.headers.raw(), 'Range': range },
                    // ... (obsługa timeoutu i błędów)
                });
                if (rangeResponse.status === 206) {
                    res.status(206);
                    res.setHeader('Content-Range', rangeResponse.headers.get('content-range'));
                    res.setHeader('Accept-Ranges', 'bytes');
                }
                return rangeResponse.body.pipe(res);
            }
            return response.body.pipe(res);
        }

        // 3. Przetwarzanie manifestu M3U8
        let bodyText = await response.text();

        // Walidacja, czy to na pewno manifest
        if (!bodyText.trim().startsWith('#EXTM3U')) {
            console.warn("Ostrzeżenie: Odpowiedź nie jest prawidłowym manifestem M3U8.");
            // Mimo to spróbujmy przepisać, bo może to być nietypowy format
        }

        const baseUrl = new URL(targetUrl);
        const host = req.get('host');
        const protocol = req.protocol;
        const proxyBase = `${protocol}://${host}/?url=`;

        // 4. Zaawansowane przepisywanie linii manifestu
        bodyText = bodyText.split(/\r?\n/).map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine === '') return line; // Puste linie pozostaw

            // Przepisz atrybuty URI w tagach #EXT-X-*
            if (trimmedLine.startsWith('#')) {
                // Szukaj URI="..." wewnątrz tagów
                return trimmedLine.replace(/URI="([^"]+)"/g, (match, uri) => {
                    try {
                        const absoluteUri = new URL(uri, baseUrl).href;
                        return `URI="${proxyBase}${encodeURIComponent(absoluteUri)}"`;
                    } catch {
                        return match; // Jeśli URI jest nieprawidłowy, pozostaw bez zmian
                    }
                });
            }

            // Przepisz zwykłe linie z segmentami
            try {
                const absoluteUrl = new URL(trimmedLine, baseUrl).href;
                return `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
            } catch {
                return line; // Jeśli nie można sparsować, pozostaw linię
            }
        }).join('\n');

        // 5. Ustawienie bezpiecznych nagłówków odpowiedzi
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        // Usuń potencjalnie problematyczne nagłówki
        res.removeHeader('Content-Encoding');
        res.removeHeader('Content-Length');

        return res.send(bodyText);

    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).send("Przekroczono limit czasu oczekiwania na odpowiedź serwera źródłowego.");
        }
        console.error("Błąd proxy:", err);
        res.status(500).send("Błąd proxy: " + err.message);
    }
});

app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
});
