// api/index.js
import https from 'https';
import http from 'http';
import { URL } from 'url';

const ALLOWED_DOMAINS = [
  "https://aurorascreen.org",
  "https://aurorascreen.pages.dev",
  "http://localhost:3000"
];
const BYPASS_PASS = "NYTMWWISTTR";

export default async function handler(req, res) {
  // 1. Get URL and Query Params
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const currentUrl = new URL(req.url, `${protocol}://${host}`);
  const query = Object.fromEntries(currentUrl.searchParams);

  // --- 2. SECURITY GATE ---
  const urlPass = query.pass;
  const isAdmin = urlPass === BYPASS_PASS;

  if (!isAdmin) {
    const userAgent = req.headers['user-agent'] || "";
    const origin = req.headers['origin'] || req.headers['referer'] || "";

    // Bot Check
    if (!userAgent.includes("Mozilla") || userAgent.includes("curl") || userAgent.includes("python")) {
      return res.status(403).json({ error: "Access Denied: Bot detected" });
    }

    // Domain Check
    let isAllowed = false;
    for (const domain of ALLOWED_DOMAINS) {
      if (origin.startsWith(domain)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      return res.status(403).json({ error: "Access Denied: Invalid Domain" });
    }
  }

  // --- 3. ROUTER ---

  // A. Proxy Mode (The Iframe) -> /api?iframe=HTTPS_URL
  if (query.iframe) {
    return handleIframeProxy(query.iframe, res);
  }

  // B. Source Resolution Mode -> /api?id=MEDIA_ID
  if (query.id) {
    const workerOrigin = `${protocol}://${host}`;
    return handleSourceResolution(query.id, workerOrigin, res);
  }

  // C. Search Mode -> /api?name=...
  try {
    const result = await processSearch(query);
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=59');
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// --- PROXY HANDLER (Node.js Native) ---

async function handleIframeProxy(targetUrl, res) {
  if (!targetUrl) return res.status(400).send("Missing URL");

  // Headers specifically for Windows Chrome
  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'referer': 'https://movies2watch.tv/', // The Spoof
    'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'iframe',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'cross-site',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  };

  try {
    const fetch = (await import('node-fetch')).default; // Dynamic import for Vercel
    const proxyRes = await fetch(targetUrl, { 
        method: 'GET', 
        headers: headers,
        redirect: 'follow'
    });

    if (proxyRes.status === 403) {
        return res.status(403).json({ error: "Proxy Blocked: Vercel IP detected." });
    }

    // Forward Headers
    const contentType = proxyRes.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'text/html');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Stream the body
    const buffer = await proxyRes.buffer();
    return res.status(proxyRes.status).send(buffer);

  } catch (e) {
    return res.status(500).send("Proxy Error: " + e.message);
  }
}

// --- LOGIC HANDLERS ---

async function processSearch(query) {
  const { name, s = "1", e = "1" } = query;
  if (!name) throw new Error("Usage: /?name=show&s=1&e=1");

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0 Safari/537.36',
    'Referer': 'https://movies2watch.tv/',
    'X-Requested-With': 'XMLHttpRequest'
  };

  const fetch = (await import('node-fetch')).default;
  
  // 1. Search
  const formData = new URLSearchParams();
  formData.append('keyword', name);
  const searchRes = await fetch('https://movies2watch.tv/ajax/search', { method: 'POST', headers, body: formData });
  const html = await searchRes.text();
  const match = html.match(/href="\/(movie|tv)\/[^"]+-(\d+)"/);
  
  if (!match) throw new Error("Not found");
  const type = match[1];
  const mediaId = match[2];
  let servers = [];

  // 2. Get Servers (Simplified for brevity)
  if (type === 'tv') {
      const seasonRes = await fetch(`https://movies2watch.tv/ajax/season/list/${mediaId}`, { headers });
      const seasonHtml = await seasonRes.text();
      const seasonMatch = seasonHtml.match(new RegExp(`data-id="(\\d+)"[^>]*>\\s*Season\\s*0?${s}\\s*<`, "i"));
      
      if (seasonMatch) {
          const epsRes = await fetch(`https://movies2watch.tv/ajax/season/episodes/${seasonMatch[1]}`, { headers });
          const epsHtml = await epsRes.text();
          const epMatch = epsHtml.match(new RegExp(`data-id="(\\d+)"[^>]*title="Eps\\s*0?${e}\\s*:`, "i"));
          
          if (epMatch) {
              const serverRes = await fetch(`https://movies2watch.tv/ajax/episode/servers/${epMatch[1]}`, { headers });
              const serverHtml = await serverRes.text();
              const serverMatches = [...serverHtml.matchAll(/data-id="(\d+)"[^>]*title="Server\s*([^"]+)"/g)];
              serverMatches.forEach(m => servers.push({ name: m[2].trim(), id: m[1] }));
          }
      }
  } else {
      const listRes = await fetch(`https://movies2watch.tv/ajax/episode/list/${mediaId}`, { headers });
      const listHtml = await listRes.text();
      const matches = [...listHtml.matchAll(/href="[^"]+\.(\d+)"/g)];
      matches.forEach(m => servers.push({ name: `Server ${servers.length + 1}`, id: m[1] }));
  }

  return { result: "success", type, name, servers };
}

async function handleSourceResolution(id, workerOrigin, res) {
  try {
    const fetch = (await import('node-fetch')).default;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0 Safari/537.36',
        'Referer': 'https://movies2watch.tv/',
        'X-Requested-With': 'XMLHttpRequest'
    };
    const response = await fetch(`https://movies2watch.tv/ajax/episode/sources/${id}`, { headers });
    const data = await response.json();
    
    if (!data.link) return res.status(404).json({ error: "Link not found" });

    // The Magic: Return the Vercel Proxy URL
    const proxyUrl = `${workerOrigin}/api?iframe=${encodeURIComponent(data.link)}`;

    return res.status(200).json({ 
        server_id: id, 
        stream_url: data.link, 
        iframe_url: proxyUrl 
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
