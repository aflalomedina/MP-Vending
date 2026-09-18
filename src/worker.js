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
  "metodos-pagamento": 52,
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
      // sem data específica: devolve TODOS os snapshots guardados, para uso no gráfico acumulado
      const all = {};
      let cursor;
      do {
        const listed = await env.HISTORY_KV.list({ prefix: "snapshot:", cursor });
        for (const key of listed.keys) {
          const value = await env.HISTORY_KV.get(key.name);
          if (value) {
            try {
              all[key.name.replace("snapshot:", "")] = JSON.parse(value);
            } catch {
              // ignora entradas corrompidas
            }
          }
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);

      return new Response(JSON.stringify(all), {
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

// ===== Web Analytics (Cloudflare RUM via GraphQL) =====
async function handleSiteAnalytics(env) {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // últimos 30 dias

  const query = `
    query($acc: String!, $site: String!, $s: Date!, $e: Date!) {
      viewer {
        accounts(filter: { accountTag: $acc }) {
          rumPageloadEventsAdaptiveGroups(
            filter: { siteTag: $site, date_geq: $s, date_leq: $e }
            limit: 10000
            orderBy: [date_ASC]
          ) {
            count
            sum { visits }
            dimensions {
              date
              requestPath
              deviceType
              refererHost
              countryName
            }
          }
        }
      }
    }
  `;

  const variables = {
    acc: env.CF_ACCOUNT_TAG,
    site: env.CF_SITE_TAG,
    s: start.toISOString().slice(0, 10),
    e: end.toISOString().slice(0, 10),
  };

  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Cloudflare GraphQL respondeu ${res.status}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  const groups = json.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
  return {
    groups,
    debug: {
      dateRange: { s: variables.s, e: variables.e },
      accountTagSet: !!env.CF_ACCOUNT_TAG,
      siteTagSet: !!env.CF_SITE_TAG,
      rawGroupCount: groups.length,
    },
  };
}

// ===== Despesas mensais (Cloudflare KV) =====
async function handleDespesas(request, env) {
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
    const { categoria, descricao, valor, data } = payload || {};
    if (!categoria || !data || typeof valor !== "number") {
      return new Response(JSON.stringify({ error: "Faltam campos (categoria, valor, data)" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const id = crypto.randomUUID();
    const registo = { id, categoria, descricao: descricao || "", valor, data, criadoEm: new Date().toISOString() };
    await env.HISTORY_KV.put(`despesa:${id}`, JSON.stringify(registo));
    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method === "GET") {
    const despesas = [];
    let cursor;
    do {
      const listed = await env.HISTORY_KV.list({ prefix: "despesa:", cursor });
      for (const key of listed.keys) {
        const value = await env.HISTORY_KV.get(key.name);
        if (value) {
          try {
            despesas.push(JSON.parse(value));
          } catch {
            // ignora entradas corrompidas
          }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    return new Response(JSON.stringify({ despesas }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "Falta o parâmetro id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    await env.HISTORY_KV.delete(`despesa:${id}`);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
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

    if (url.pathname === "/api/site-analytics") {
      try {
        const resultado = await handleSiteAnalytics(env);
        return new Response(JSON.stringify(resultado), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/api/despesas") {
      try {
        return await handleDespesas(request, env);
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
