// ===== Autenticação simples (HTTP Basic) para /admin e /api =====
function checkAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  const decoded = atob(authHeader.slice(6));
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === env.ADMIN_USER && pass === env.ADMIN_PASSWORD;
}

function unauthorizedResponse() {
  return new Response("Autenticação necessária", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="MP Vending Admin"' },
  });
}

// ===== Sessão do portal Metabase (em cache enquanto o Worker está "quente") =====
let cachedSession = null;
let cachedAt = 0;
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // reautentica no máximo a cada 6h

function extractCookies(res) {
  const cookies = {};
  for (const [key, value] of res.headers) {
    if (key.toLowerCase() === "set-cookie") {
      const match = value.match(/^([^=]+)=([^;]+)/);
      if (match) cookies[match[1]] = match[2];
    }
  }
  return cookies;
}

async function getSession(env) {
  const now = Date.now();
  if (cachedSession && now - cachedAt < SESSION_TTL_MS) {
    return cachedSession;
  }

  const loginUrl = `${env.PORTAL_URL}/app/index.php?r=user/login`;

  const getRes = await fetch(loginUrl, { redirect: "manual" });
  const initialCookies = extractCookies(getRes);
  const phpSessId = initialCookies["PHPSESSID"];

  const body = new URLSearchParams();
  body.set("UserLogin[username]", env.PORTAL_USER);
  body.set("UserLogin[password]", env.PORTAL_PASS);
  body.set("UserLogin[rememberMe]", "0");
  body.set("yt0", "LOGIN");

  const postRes = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": phpSessId ? `PHPSESSID=${phpSessId}` : "",
      "Origin": env.PORTAL_URL,
      "Referer": loginUrl,
    },
    body: body.toString(),
  });

  const finalCookies = extractCookies(postRes);
  const metabaseSession = finalCookies["metabase.SESSION_ID"];

  if (!metabaseSession) {
    throw new Error("Login falhou: não recebi cookie metabase.SESSION_ID do portal");
  }

  cachedSession = metabaseSession;
  cachedAt = now;
  return cachedSession;
}

async function queryCard(env, cardId) {
  let session = await getSession(env);

  async function doQuery(sess) {
    return fetch(`${env.METABASE_URL}/api/card/${cardId}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `metabase.SESSION_ID=${sess}`,
      },
      body: JSON.stringify({ parameters: [] }),
    });
  }

  let res = await doQuery(session);

  if (res.status === 401 || res.status === 403) {
    cachedSession = null;
    session = await getSession(env);
    res = await doQuery(session);
  }

  if (!res.ok) {
    throw new Error(`Metabase respondeu ${res.status}`);
  }
  return res.json();
}

// mapeia nomes amigáveis -> ID do card no Metabase
const CARDS = {
  "vendas-diarias": 54,
  "stock-armazens": 55,
  "layout-maquinas": 56,
};

// ===== Histórico diário (Cloudflare KV) =====
async function handleSnapshot(request, env) {
  const url = new URL(request.url);

  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "JSON inválido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const date = (payload && payload.date) || new Date().toISOString().slice(0, 10);
    await env.HISTORY_KV.put(`snapshot:${date}`, JSON.stringify(payload));
    return new Response(JSON.stringify({ ok: true, date }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) {
      return new Response(JSON.stringify({ error: "Falta o parâmetro date" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const stored = await env.HISTORY_KV.get(`snapshot:${date}`);
    if (!stored) {
      return new Response(JSON.stringify({ error: "Sem dados guardados para essa data" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(stored, { headers: { "Content-Type": "application/json" } });
  }

  return new Response("Método não suportado", { status: 405 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Protege /admin e /api — ninguém vê dados sem password
    if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/")) {
      if (!checkAuth(request, env)) {
        return unauthorizedResponse();
      }
    }

    if (url.pathname === "/api/snapshot") {
      try {
        return await handleSnapshot(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const key = url.pathname.replace("/api/", "");
      const cardId = CARDS[key];

      if (!cardId) {
        return new Response(JSON.stringify({ error: "Report desconhecido" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const data = await queryCard(env, cardId);
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // tudo o resto continua a servir o site normal (index.html, /admin, imagens, etc.)
    return env.ASSETS.fetch(request);
  },
};
