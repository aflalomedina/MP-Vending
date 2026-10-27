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

// ===== Layouts planeados das máquinas de snacks (Cloudflare KV, chave "layout:<matrícula>") =====
// Um plano por máquina: canal -> produto planeado. Estados: planeado -> troca_feita -> concluido (quando a Luope já bate certo).
const LAYOUT_ESTADOS = ["planeado", "troca_feita", "concluido"];
function limparCanaisLayout(lista) {
  if (!Array.isArray(lista)) return null;
  return lista.slice(0, 120).map((c) => ({
    canal: String((c && c.canal) || "").slice(0, 12),
    seletor: String((c && c.seletor) || "").slice(0, 12),
    capacidade: Math.max(0, Math.min(99, Number(c && c.capacidade) || 0)),
    produto: String((c && c.produto) || "").slice(0, 120),
    teste: !!(c && c.teste),
    nota: String((c && c.nota) || "").slice(0, 200),
  })).filter((c) => c.canal);
}
async function handleLayouts(request, env) {
  const url = new URL(request.url);
  const maquina = (url.searchParams.get("maquina") || "").trim();
  const validaMaquina = (m) => /^[0-9A-Za-z-]{1,10}$/.test(m);

  if (request.method === "GET") {
    const layouts = [];
    let cursor;
    do {
      const listed = await env.HISTORY_KV.list({ prefix: "layout:", cursor });
      for (const key of listed.keys) {
        const value = await env.HISTORY_KV.get(key.name);
        if (value) {
          try { layouts.push(JSON.parse(value)); } catch { /* ignora entradas corrompidas */ }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return jsonResponse({ layouts });
  }

  if (request.method === "PUT") {
    if (!validaMaquina(maquina)) return jsonResponse({ error: "Falta ou é inválido o parâmetro maquina" }, 400);
    let payload;
    try { payload = await request.json(); } catch { return jsonResponse({ error: "JSON inválido" }, 400); }
    const existente = await env.HISTORY_KV.get(`layout:${maquina}`);
    let atual = null;
    if (existente) { try { atual = JSON.parse(existente); } catch { atual = null; } }
    const agora = new Date().toISOString();
    if (!atual) atual = { maquina, estado: "planeado", canais: [], notas: "", visitasSemana: 2, criadoEm: agora, trocaFeitaEm: null, concluidoEm: null };
    if (payload.canais !== undefined) {
      const canais = limparCanaisLayout(payload.canais);
      if (!canais) return jsonResponse({ error: "canais tem de ser uma lista" }, 400);
      atual.canais = canais;
    }
    if (typeof payload.notas === "string") atual.notas = payload.notas.slice(0, 2000);
    if (payload.visitasSemana !== undefined) atual.visitasSemana = Math.max(0.5, Math.min(7, Number(payload.visitasSemana) || 2));
    if (LAYOUT_ESTADOS.includes(payload.estado) && payload.estado !== atual.estado) {
      atual.estado = payload.estado;
      if (payload.estado === "planeado") { atual.trocaFeitaEm = null; atual.concluidoEm = null; }
      if (payload.estado === "troca_feita") { atual.trocaFeitaEm = /^\d{4}-\d{2}-\d{2}$/.test(payload.trocaFeitaEm || "") ? payload.trocaFeitaEm : agora.slice(0, 10); atual.concluidoEm = null; }
      if (payload.estado === "concluido") { atual.concluidoEm = agora; if (!atual.trocaFeitaEm) atual.trocaFeitaEm = agora.slice(0, 10); }
    }
    atual.atualizadoEm = agora;
    await env.HISTORY_KV.put(`layout:${maquina}`, JSON.stringify(atual));
    return jsonResponse({ ok: true, layout: atual });
  }

  if (request.method === "DELETE") {
    if (!validaMaquina(maquina)) return jsonResponse({ error: "Falta ou é inválido o parâmetro maquina" }, 400);
    await env.HISTORY_KV.delete(`layout:${maquina}`);
    return jsonResponse({ ok: true });
  }

  return new Response("Método não suportado", { status: 405 });
}

// ===== Notas rápidas (post-its partilhados, Cloudflare KV, chave "nota:<id>") =====
const NOTA_CORES = ["amarelo", "rosa", "verde", "azul", "laranja"];
async function handleNotas(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const notas = [];
    let cursor;
    do {
      const listed = await env.HISTORY_KV.list({ prefix: "nota:", cursor });
      for (const key of listed.keys) {
        const value = await env.HISTORY_KV.get(key.name);
        if (value) {
          try { notas.push(JSON.parse(value)); } catch { /* ignora entradas corrompidas */ }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return jsonResponse({ notas });
  }

  if (request.method === "POST") {
    let payload;
    try { payload = await request.json(); } catch { return jsonResponse({ error: "JSON inválido" }, 400); }
    const texto = String((payload && payload.texto) || "").trim();
    if (!texto) return jsonResponse({ error: "A nota está vazia" }, 400);
    const agora = new Date().toISOString();
    const id = crypto.randomUUID();
    const registo = {
      id,
      texto: texto.slice(0, 2000),
      cor: NOTA_CORES.includes(payload.cor) ? payload.cor : "amarelo",
      autor: String(payload.autor || "").slice(0, 60),
      fixada: !!payload.fixada,
      criadaEm: agora,
      atualizadaEm: agora,
    };
    await env.HISTORY_KV.put(`nota:${id}`, JSON.stringify(registo));
    return jsonResponse({ ok: true, nota: registo });
  }

  if (request.method === "PUT") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Falta o parâmetro id" }, 400);
    const existente = await env.HISTORY_KV.get(`nota:${id}`);
    if (!existente) return jsonResponse({ error: "Nota não encontrada" }, 404);
    let atual;
    try { atual = JSON.parse(existente); } catch { return jsonResponse({ error: "Nota corrompida" }, 500); }
    let payload;
    try { payload = await request.json(); } catch { return jsonResponse({ error: "JSON inválido" }, 400); }
    if (typeof payload.texto === "string") {
      const texto = payload.texto.trim();
      if (!texto) return jsonResponse({ error: "A nota está vazia" }, 400);
      atual.texto = texto.slice(0, 2000);
    }
    if (NOTA_CORES.includes(payload.cor)) atual.cor = payload.cor;
    if (typeof payload.autor === "string") atual.autor = payload.autor.slice(0, 60);
    if (typeof payload.fixada === "boolean") atual.fixada = payload.fixada;
    atual.atualizadaEm = new Date().toISOString();
    await env.HISTORY_KV.put(`nota:${id}`, JSON.stringify(atual));
    return jsonResponse({ ok: true, nota: atual });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Falta o parâmetro id" }, 400);
    await env.HISTORY_KV.delete(`nota:${id}`);
    return jsonResponse({ ok: true });
  }

  return new Response("Método não suportado", { status: 405 });
}

// ===== Encomendas a fornecedores marcadas no admin (Cloudflare KV, chave única "encomendas") =====
// Mapa produto -> { qtd, data, autor }. Serve para a lista "Stock a comprar" não voltar a alarmar o que já foi encomendado.
async function handleEncomendas(request, env) {
  const url = new URL(request.url);
  const ler = async () => {
    const raw = await env.HISTORY_KV.get("encomendas");
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  };
  if (request.method === "GET") return jsonResponse({ encomendas: await ler() });
  if (request.method === "PUT") {
    let payload;
    try { payload = await request.json(); } catch { return jsonResponse({ error: "JSON inválido" }, 400); }
    const produto = String((payload && payload.produto) || "").trim().slice(0, 120);
    if (!produto) return jsonResponse({ error: "Falta o produto" }, 400);
    const mapa = await ler();
    mapa[produto] = {
      qtd: Math.max(0, Math.min(100000, Math.round(Number(payload.qtd) || 0))),
      data: /^\d{4}-\d{2}-\d{2}$/.test(payload.data || "") ? payload.data : new Date().toISOString().slice(0, 10),
      autor: String(payload.autor || "").slice(0, 60),
    };
    await env.HISTORY_KV.put("encomendas", JSON.stringify(mapa));
    return jsonResponse({ ok: true, encomendas: mapa });
  }
  if (request.method === "DELETE") {
    const produto = (url.searchParams.get("produto") || "").trim();
    if (!produto) return jsonResponse({ error: "Falta o parâmetro produto" }, 400);
    const mapa = await ler();
    delete mapa[produto];
    await env.HISTORY_KV.put("encomendas", JSON.stringify(mapa));
    return jsonResponse({ ok: true, encomendas: mapa });
  }
  return new Response("Método não suportado", { status: 405 });
}

// ===== Resumo diário automático (cron às 23:55 de Lisboa) =====
// O admin guarda o resumo do dia quando alguém o abre; se ninguém o abrir ao fim do dia, o dia ficava incompleto.
// Este cron calcula o mesmo resumo a partir do card "vendas-diarias" e grava-o na KV (snapshot:<data>), por cima do que lá estiver.
// porPontoVenda e porCategoria dependem das tabelas de máquinas do admin: o admin deriva-os de porMaquina quando faltam.
// Manter canonicalProduto igual ao do admin (admin/index.html).
const GRUPOS_PRODUTO_WORKER = {
  "Guarana Antartica lata 33cl": "Guaraná Brasil 33cl",
  "Agua UP 0,5L": "Agua S. Martinho 50cl",
  "Agua Rioba 50cl": "Agua S. Martinho 50cl",
  "Bebida Energetica Hell Classic 25cl": "Bebida Energetica Hell Classic 250ml",
  "Bebida Energetica Hell Zero 25cl": "Bebida Energetica Hell Classic 250ml",
  "Coca Cola Original Lata Sleek": "Coca Cola Original Lata 33 Cl",
  "Croissant Recheado com Cacau 60 Gr - Belino": "Bitee - Croissant Recheio Cacau 60g",
  "7Up 33cl": "7Up Sleek 330ml",
  "REF S/G FRESKY LAR TET 20CL": "REF S/G FRESKY F TROP TET 20CL",
};
function canonicalProdutoWorker(nome) {
  const n = String(nome || "").replace(/\s*\(sdr\)\s*$/i, "").replace(/\s*-\s*sdr\s*$/i, "").trim();
  return GRUPOS_PRODUTO_WORKER[n] || n;
}
const MAQUINAS_EXCLUIDAS_WORKER = new Set(["005"]);
function horaLisboa(instante) {
  const p = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(instante).forEach((x) => { p[x.type] = x.value; });
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), minuto: Number(p.minute) };
}
function horaDaVenda(saleAt) {
  const str = String(saleAt == null ? "" : saleAt).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m && !m[7]) return Number(m[4]); // sem fuso: já é hora de Portugal
  const d = new Date(str);
  return isNaN(d) ? null : horaLisboa(d).hora;
}
function calcularResumoDia(payload, data) {
  const cols = payload.data.cols.map((c) => c.name);
  const rows = payload.data.rows.map((row) => { const o = {}; cols.forEach((c, i) => { o[c] = row[i]; }); return o; });
  const soma = (lista, chave, valor) => { const o = {}; for (const r of lista) { const k = chave(r); o[k] = (o[k] || 0) + valor(r); } return o; };
  const receitaTotal = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const transacoes = rows.reduce((s, r) => s + (Number(r.count) || 1), 0);
  const validas = rows.filter((r) => r.MATRICULA_MAQUINA && !MAQUINAS_EXCLUIDAS_WORKER.has(r.MATRICULA_MAQUINA));
  const comProduto = rows.filter((r) => r.NOME_PRODUTO);
  const porProduto = {};
  for (const r of comProduto) {
    const p = canonicalProdutoWorker(r.NOME_PRODUTO);
    const e = (porProduto[p] = porProduto[p] || { qtd: 0, valor: 0 });
    e.qtd += Number(r.count) || 1; e.valor += Number(r.value) || 0;
  }
  const porMaquinaProduto = {}, porHoraProduto = {}, porHora = {};
  for (const r of validas) {
    if (!r.NOME_PRODUTO) continue;
    const p = canonicalProdutoWorker(r.NOME_PRODUTO);
    (porMaquinaProduto[r.MATRICULA_MAQUINA] = porMaquinaProduto[r.MATRICULA_MAQUINA] || {})[p] = ((porMaquinaProduto[r.MATRICULA_MAQUINA] || {})[p] || 0) + (Number(r.count) || 1);
  }
  for (const r of rows) {
    const h = horaDaVenda(r.sale_at);
    if (h == null) continue;
    porHora[h] = (porHora[h] || 0) + (Number(r.value) || 0);
    if (r.NOME_PRODUTO && !(r.MATRICULA_MAQUINA && MAQUINAS_EXCLUIDAS_WORKER.has(r.MATRICULA_MAQUINA))) {
      const p = canonicalProdutoWorker(r.NOME_PRODUTO);
      (porHoraProduto[p] = porHoraProduto[p] || {})[h] = ((porHoraProduto[p] || {})[h] || 0) + (Number(r.count) || 1);
    }
  }
  return {
    date: data,
    receitaTotal,
    transacoes,
    ticketMedio: transacoes ? receitaTotal / transacoes : 0,
    produtosDistintos: new Set(comProduto.map((r) => r.NOME_PRODUTO)).size,
    porMaquina: soma(validas, (r) => r.MATRICULA_MAQUINA, (r) => Number(r.value) || 0),
    porTipoPagamento: soma(rows.filter((r) => r.id !== undefined && r.id !== null && r.id !== "" && String(r.id) !== "4"), (r) => String(r.id), (r) => Number(r.value) || 0),
    porProduto,
    porMaquinaProduto,
    porHora,
    porHoraProduto,
    capturadoPor: "cron",
    capturadoEm: new Date().toISOString(),
  };
}
async function guardarResumoDiario(env, forcar) {
  const agora = horaLisboa(new Date());
  // o cron corre às 22:55 e às 23:55 UTC (cobre hora de verão e de inverno); só grava quando em Lisboa são 23h
  if (!forcar && agora.hora !== 23) return { ok: false, motivo: `em Lisboa são ${agora.hora}h` };
  const vendas = await queryCard(env, CARDS["vendas-diarias"]);
  const resumo = calcularResumoDia(vendas, agora.data);
  const anterior = await env.HISTORY_KV.get(`snapshot:${agora.data}`);
  let base = {};
  try { base = anterior ? JSON.parse(anterior) : {}; } catch { base = {}; }
  // mantém campos que só o admin calcula (porPontoVenda, porCategoria…) e substitui os números pelos do fim do dia
  const final = { ...base, ...resumo };
  delete final.porPontoVenda; delete final.porCategoria; // recalculados no admin a partir de porMaquina
  await env.HISTORY_KV.put(`snapshot:${agora.data}`, JSON.stringify(final));
  return { ok: true, date: agora.data, receitaTotal: resumo.receitaTotal, transacoes: resumo.transacoes };
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

  // cron (wrangler.jsonc → triggers.crons): grava o resumo do dia às 23:55 de Lisboa
  async scheduled(event, env, ctx) {
    ctx.waitUntil(guardarResumoDiario(env, false).catch((err) => console.error("Resumo diário falhou:", err.message)));
  },

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

    if (url.pathname === "/api/snapshot-agora" && request.method === "POST") {
      try {
        return jsonResponse(await guardarResumoDiario(env, true));
      } catch (err) {
        return jsonResponse({ error: err.message }, 502);
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

    if (url.pathname === "/api/encomendas") {
      try {
        return await handleEncomendas(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/api/notas") {
      try {
        return await handleNotas(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
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

    if (url.pathname === "/api/layouts") {
      try {
        return await handleLayouts(request, env);
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
