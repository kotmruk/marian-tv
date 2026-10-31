const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// Domyślny link do Megogo
const DEFAULT_TARGET = "https://meta.vcdn.biz/dab0e9e1db10fcadc4c1a18bd29121c4_megogo/live/hls/b/700_2490_4000/u_sid/0/o/156751011/rsid/b67e3736-66e3-449c-a855-3c618c5a250f/u_uid/0/u_vod/0/u_device/cms_html5/u_devicekey/_site/lip/5.173.149.85*asn/u_srvc/81255/u_did/web_5aaf9878498706b0b922a7f691015de9d5adfc267a1e1f3d76814e0d04cc3fe6/type.live/playlist.m3u8";

app.get('/', async (req, res) => {
    let targetUrl = req.query.url ? decodeURIComponent(req.query.url) : DEFAULT_TARGET;

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://embed.megogo.net/',
                'Origin': 'https://embed.megogo.net'
            }
        });

        const contentType = response.headers.get('content-type') || '';

        // Jeśli to plik manifestu .m3u8, przepisujemy linki wewnątrz
        if (contentType.includes('mpegurl') || contentType.includes('text') || targetUrl.includes('.m3u8')) {
            let text = await response.text();
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const host = req.get('host');
            const protocol = req.protocol;

            text = text.replace(/^(?!#)(.+)$/gm, (match) => {
                let absoluteUrl = match.startsWith('http') ? match : baseUrl + match;
                return `${protocol}://${host}/?url=${encodeURIComponent(absoluteUrl)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(text);
        }

        // Dla zwykłych segmentów .ts / .m4s przekazujemy strumień binarny
        res.setHeader('Access-Control-Allow-Origin', '*');
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send("Błąd proxy: " + err.message);
    }
});

app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
});