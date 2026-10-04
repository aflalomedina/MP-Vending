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
  "resumo-vendas-dia": 61,
  "maquinas-mudancas": 62,
  "valor-cofre": 60,
  "copos-maquinas": 64,
  "produtos-total": 65,
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

// ===== Tarefas pendentes (Cloudflare KV) =====
const TAREFA_URGENCIAS = ["Baixa", "Média", "Alta", "Urgente"];

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleTarefas(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const tarefas = [];
    let cursor;
    do {
      const listed = await env.HISTORY_KV.list({ prefix: "tarefa:", cursor });
      for (const key of listed.keys) {
        const value = await env.HISTORY_KV.get(key.name);
        if (value) {
          try {
            tarefas.push(JSON.parse(value));
          } catch {
            // ignora entradas corrompidas
          }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return jsonResponse({ tarefas });
  }

  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "JSON inválido" }, 400);
    }
    const titulo = ((payload && payload.titulo) || "").trim();
    if (!titulo) return jsonResponse({ error: "Falta o título da tarefa" }, 400);
    const urgencia = TAREFA_URGENCIAS.includes(payload.urgencia) ? payload.urgencia : "Média";
    const id = crypto.randomUUID();
    const registo = {
      id,
      titulo: titulo.slice(0, 200),
      categoria: String(payload.categoria || "").slice(0, 40),
      urgencia,
      dataConclusao: /^\d{4}-\d{2}-\d{2}$/.test(payload.dataConclusao || "") ? payload.dataConclusao : "",
      observacoes: String(payload.observacoes || "").slice(0, 2000),
      responsavel: String(payload.responsavel || "").slice(0, 60),
      concluida: false,
      criadaEm: new Date().toISOString(),
      concluidaEm: null,
    };
    await env.HISTORY_KV.put(`tarefa:${id}`, JSON.stringify(registo));
    return jsonResponse({ ok: true, tarefa: registo });
  }

  if (request.method === "PUT") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Falta o parâmetro id" }, 400);
    const existente = await env.HISTORY_KV.get(`tarefa:${id}`);
    if (!existente) return jsonResponse({ error: "Tarefa não encontrada" }, 404);
    let atual;
    try {
      atual = JSON.parse(existente);
    } catch {
      return jsonResponse({ error: "Tarefa corrompida" }, 500);
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "JSON inválido" }, 400);
    }
    if (typeof payload.titulo === "string" && payload.titulo.trim()) atual.titulo = payload.titulo.trim().slice(0, 200);
    if (typeof payload.categoria === "string") atual.categoria = payload.categoria.slice(0, 40);
    if (TAREFA_URGENCIAS.includes(payload.urgencia)) atual.urgencia = payload.urgencia;
    if (typeof payload.dataConclusao === "string" && (payload.dataConclusao === "" || /^\d{4}-\d{2}-\d{2}$/.test(payload.dataConclusao))) {
      atual.dataConclusao = payload.dataConclusao;
    }
    if (typeof payload.observacoes === "string") atual.observacoes = payload.observacoes.slice(0, 2000);
    if (typeof payload.responsavel === "string") atual.responsavel = payload.responsavel.slice(0, 60);
    if (typeof payload.concluida === "boolean") {
      atual.concluida = payload.concluida;
      atual.concluidaEm = payload.concluida ? new Date().toISOString() : null;
    }
    await env.HISTORY_KV.put(`tarefa:${id}`, JSON.stringify(atual));
    return jsonResponse({ ok: true, tarefa: atual });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Falta o parâmetro id" }, 400);
    await env.HISTORY_KV.delete(`tarefa:${id}`);
    return jsonResponse({ ok: true });
  }

  return new Response("Método não suportado", { status: 405 });
}

// ===== Despesas mensais (Cloudflare KV) =====
// ===== Tracking próprio (visitas + leads do formulário) via KV =====
async function handleTrack(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const evento = payload && payload.event;
  if (evento !== "pageview" && evento !== "lead" && evento !== "session_end") {
    return new Response(JSON.stringify({ error: "event inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const data = new Date().toISOString().slice(0, 10);
  const id = crypto.randomUUID();
  const registo = {
    event: evento,
    page: (payload.page || "").slice(0, 200),
    referrer: (payload.referrer || "").slice(0, 200),
    device: (payload.device || "").slice(0, 30),
    duracaoSeg: typeof payload.duracaoSeg === "number" ? Math.round(payload.duracaoSeg) : undefined,
    pais: (request.cf && request.cf.country) || "Desconhecido",
    ts: new Date().toISOString(),
  };
  await env.HISTORY_KV.put(`track:${evento}:${data}:${id}`, JSON.stringify(registo));
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleTrackStats(env) {
  const eventos = [];
  let cursor;
  do {
    const listed = await env.HISTORY_KV.list({ prefix: "track:", cursor });
    for (const key of listed.keys) {
      const value = await env.HISTORY_KV.get(key.name);
      if (value) {
        try {
          eventos.push(JSON.parse(value));
        } catch {
          // ignora entradas corrompidas
        }
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return eventos;
}

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

    // /api/track fica público (chamado por visitantes anónimos do site) — sem password
    if (url.pathname === "/api/track") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }
      try {
        return await handleTrack(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // Protege /admin e /api — ninguém vê dados sem password
    if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/")) {
      if (!checkAuth(request, env)) {
        return unauthorizedResponse();
      }
    }

    if (url.pathname === "/api/track-stats") {
      try {
        const eventos = await handleTrackStats(env);
        return new Response(JSON.stringify({ eventos }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
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

    if (url.pathname === "/api/tarefas") {
      try {
        return await handleTarefas(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
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
