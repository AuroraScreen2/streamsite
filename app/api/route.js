import { NextResponse } from 'next/server';

// --- CONFIGURATION ---
export const runtime = 'nodejs'; // Forces AWS Lambda (Changing your IP)
export const dynamic = 'force-dynamic'; // Disables static optimization

const ALLOWED_DOMAINS = [
  "https://aurorascreen.org",
  "https://aurorascreen.pages.dev",
  "http://localhost:3000" // Added for your local testing
];
const BYPASS_PASS = "NYTMWWISTTR";
const CACHE_TTL = 86400; // 24 Hours

export async function GET(request) {
  const url = new URL(request.url);
  
  // --- 1. SECURITY GATE ---
  const urlPass = url.searchParams.get("pass");
  const isAdmin = urlPass === BYPASS_PASS;

  if (!isAdmin) {
    const userAgent = request.headers.get("User-Agent") || "";
    const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";

    // Bot Check
    if (!userAgent.includes("Mozilla") || userAgent.includes("curl") || userAgent.includes("python")) {
      return NextResponse.json({ error: "Access Denied: 403" }, { status: 403 });
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
      return NextResponse.json({ error: "Access Denied: 403" }, { status: 403 });
    }
  }

  // --- ROUTER ---
  
  // A. Proxy Mode (The Iframe)
  if (url.searchParams.has("iframe")) {
      return handleIframeProxy(url.searchParams.get("iframe"));
  }

  // B. Source Resolution Mode (Get the link)
  if (url.searchParams.has("id")) {
      return handleSourceResolution(url.searchParams.get("id"), url.origin);
  }

  // C. Search Mode (List movies)
  // This is the only part we cache
  try {
      const result = await processSearch(url);
      
      const response = NextResponse.json(result, { status: 200 });
      
      // Set Vercel Cache Headers
      response.headers.set('Cache-Control', `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=59`);
      
      return response;

  } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// --- PROXY HANDLER (Node.js Runtime) ---

async function handleIframeProxy(targetUrl) {
    if (!targetUrl) return new Response("Missing URL", { status: 400 });

    try {
        // 1. Specific Headers to mimic Windows Chrome
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

        // 2. Fetch from AWS IP (Vercel)
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: headers,
            redirect: 'follow'
        });

        // 3. Handle Blocks
        if (response.status === 403) {
            return NextResponse.json({ error: "Proxy Blocked: Server detected AWS IP." }, { status: 403 });
        }

        // 4. Sanitize Headers for the Client
        const newHeaders = new Headers(response.headers);
        newHeaders.delete("x-frame-options");
        newHeaders.delete("content-security-policy");
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Content-Type", response.headers.get("content-type") || "text/html");

        // 5. Return Stream
        return new Response(response.body, {
            status: response.status,
            headers: newHeaders
        });

    } catch (e) {
        return NextResponse.json({ error: "Proxy Error: " + e.message }, { status: 500 });
    }
}

// --- LOGIC HANDLERS ---

async function processSearch(url) {
    const name = url.searchParams.get("name");
    const season = url.searchParams.get("s") || "1";
    const episode = url.searchParams.get("e") || "1";
    
    if (!name) throw new Error("Usage: /?name=show&s=1&e=1");

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0 Safari/537.36',
      'Referer': 'https://movies2watch.tv/',
      'X-Requested-With': 'XMLHttpRequest'
    };

    // A. Search
    const formData = new URLSearchParams();
    formData.append('keyword', name);
    const searchRes = await fetch('https://movies2watch.tv/ajax/search', { method: 'POST', headers, body: formData });
    const html = await searchRes.text();
    const match = html.match(/href="\/(movie|tv)\/[^"]+-(\d+)"/);
    
    if (!match) throw new Error("Not found");
    const type = match[1];
    const mediaId = match[2];
    let servers = [];

    // B. Get Servers
    if (type === 'tv') {
         const seasonRes = await fetch(`https://movies2watch.tv/ajax/season/list/${mediaId}`, { headers });
         const seasonHtml = await seasonRes.text();
         const seasonMatch = seasonHtml.match(new RegExp(`data-id="(\\d+)"[^>]*>\\s*Season\\s*0?${season}\\s*<`, "i"));
         
         if (seasonMatch) {
             const epsRes = await fetch(`https://movies2watch.tv/ajax/season/episodes/${seasonMatch[1]}`, { headers });
             const epsHtml = await epsRes.text();
             const epMatch = epsHtml.match(new RegExp(`data-id="(\\d+)"[^>]*title="Eps\\s*0?${episode}\\s*:`, "i"));
             
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

async function handleSourceResolution(id, origin) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0 Safari/537.36',
            'Referer': 'https://movies2watch.tv/',
            'X-Requested-With': 'XMLHttpRequest'
        };
        const res = await fetch(`https://movies2watch.tv/ajax/episode/sources/${id}`, { headers });
        const data = await res.json();
        
        if (!data.link) return NextResponse.json({ error: "Link not found" }, { status: 404 });

        // Generate the Proxy URL
        const proxyUrl = `${origin}/api?iframe=${encodeURIComponent(data.link)}`;

        return NextResponse.json({ 
            server_id: id, 
            stream_url: data.link, 
            iframe_url: proxyUrl 
        });
    } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
