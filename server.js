async function getFreshM3U8(proxyAgent, channelId = '156751011') {
    const apiUrl = 'https://api.megogo.net/v2/...';  // <-- z DevTools
    const r = await fetch(apiUrl, {
        method: 'POST',                              // lub GET
        agent: proxyAgent,
        headers: {
            'User-Agent': 'Mozilla/5.0 ...',
            'Referer': 'https://embed.megogo.net/',
            'Origin': 'https://embed.megogo.net',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ /* parametry z DevTools */ })
    });
    const data = await r.json();
    return data.src; // albo data.hls, data.url — zależnie od odpowiedzi
}
