const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.set('trust proxy', true); // Render stoi za proxy – bez tego req.protocol = http

const PORT = process.env.PORT || 3000;

// ───── KONFIGURACJA STICKY PROXY ─────
// Ustaw na Renderze zmienne środowiskowe:
//   PROXY_URL = http://user:pass@pl.smartproxy.com:10000
//   (lub inne sticky proxy rezydencjalne – Decodo, Oxylabs, Bright Data)
//
// WAŻNE: upewnij się, że proxy ma sesję "sticky" (stały IP przez 10–30 min).
// W Decodo/Smartproxy dodaje się do loginu parametr `sid` lub `session`,
// np. http://user-session-abc123:pass@pl.smartproxy.com:10000
//
const PROXY_URL = process.env.PROXY_URL;

if (!PROXY_URL) {
  console.warn('⚠️  Brak PROXY_URL – ruch pójdzie bez proxy (IP Rendera).');
}

// Jeden wspólny agent dla wszystkich żądań = ta sama sesja proxy = ten sam IP.
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

// ───── DOMYŚLNY CEL ─────
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || "https://meta.vcdn.biz/dab0e9e1db10fcadc4c1a18bd29121c4_megogo/live/hls/b/700_2490_4000/u_sid/0/o/156751011/rsid/b67e3736-66e3-449c-a855-3c618c5a250f/u_uid/0/u_vod/0/u_device/cms_html5/u_devicekey/_site/lip/5.173.149.85*asn/u_srvc/81255/u_did/web_5aaf9878498706b0b922a7f691015de9d5adfc267a1e1f3d76814e0d04cc3fe6/type.live/playlist.m3u8";

// ───── NAGŁÓWKI DO MEGAGO ─────
function buildHeaders(extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://embed.megogo.net/',
    'Origin': 'https://embed.megogo.net',
    'Accept': '*/*',
    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    ...extra
  };
}

// ───── CORS preflight ─────
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

// ───── DIAGNOSTYKA: sprawdź, jakie IP widzi świat ─────
app.get('/health', async (req, res) => {
  const info = {
    protocol: req.protocol,
    host: req.get('host'),
    proxy_configured: !!PROXY_URL,
  };
  try {
    const r = await fetch('https://ipinfo.io/json', {
      agent: proxyAgent,
      timeout: 10000
    });
    info.egress = await r.json();
  } catch (e) {
    info.egress_error = e.message;
  }
  res.json(info);
});

// ───── GŁÓWNY PROXY ─────
app.get('/', async (req, res) => {
  const targetUrl = req.query.url ? decodeURIComponent(req.query.url) : DEFAULT_TARGET;
  console.log('[PROXY]', targetUrl.substring(0, 140));

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      agent: proxyAgent,             // ⬅️ STICKY PROXY
      headers: buildHeaders()
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log('[SRC ERROR]', response.status, response.statusText);
      return res.status(response.status).send(`Source error: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isM3U8 =
      targetUrl.includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8');

    // ───── SEGMENTY BINARNE (.ts, .mp4, .key, .aac) ─────
    if (!isM3U8) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const srcCT = response.headers.get('content-type');
      if (srcCT) res.setHeader('Content-Type', srcCT);

      const range = req.headers.range;
      if (range) {
        try {
          const rr = await fetch(targetUrl, {
            redirect: 'follow',
            agent: proxyAgent,       // ⬅️ to samo proxy dla Range
            headers: buildHeaders({ 'Range': range })
          });
          if (rr.status === 206) {
            res.status(206);
            const cr = rr.headers.get('content-range');
            if (cr) res.setHeader('Content-Range', cr);
            res.setHeader('Accept-Ranges', 'bytes');
          }
          const ct2 = rr.headers.get('content-type');
          if (ct2) res.setHeader('Content-Type', ct2);
          return rr.body.pipe(res);
        } catch (e) {
          console.warn('[RANGE]', e.message);
        }
      }
      return response.body.pipe(res);
    }

    // ───── MANIFEST M3U8 ─────
    let bodyText = await response.text();
    console.log('[M3U8] len=', bodyText.length, 'start=', JSON.stringify(bodyText.substring(0, 30)));

    if (!bodyText.trim().startsWith('#EXTM3U')) {
      console.warn('[M3U8] Odpowiedź nie jest manifestem!');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(bodyText);
    }

    const baseUrl = new URL(targetUrl);
    const proxyBase = `${req.protocol}://${req.get('host')}/?url=`;

    // Przepisz każdą linię – zarówno segmenty, jak i URI="..." w tagach #EXT-X-*
    bodyText = bodyText.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (!t) return line;

      if (t.startsWith('#')) {
        return t.replace(/URI="([^"]+)"/g, (m, uri) => {
          try {
            return `URI="${proxyBase}${encodeURIComponent(new URL(uri, baseUrl).href)}"`;
          } catch { return m; }
        });
      }
      try {
        return `${proxyBase}${encodeURIComponent(new URL(t, baseUrl).href)}`;
      } catch {
        return line;
      }
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(bodyText);

  } catch (err) {
    console.error('[ERROR]', err);
    if (err.name === 'AbortError') return res.status(504).send('Timeout źródła');
    return res.status(500).send('Proxy error: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy na porcie ${PORT}`);
  console.log(`   PROXY_URL: ${PROXY_URL ? 'skonfigurowany' : 'BRAK – ruch bez proxy!'}`);
});
