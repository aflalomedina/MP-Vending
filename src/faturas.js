// ===== Pedidos de fatura (clientes pedem em mpvending.pt/assistencia, pelo QR da máquina) =====
// Cada pedido fica em "fatura:<id>" na KV; "faturas:resumo" guarda o contador e quantos estão pendentes
// (o admin consulta só isso a cada minuto). A equipa da reposição não tem acesso a estes dados (NIF).

export const FATURA_ESTADOS = ["Pendente", "Emitida", "Recusada"];
const MAX_POR_HORA_POR_IP = 6;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function limpar(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, " ").trim().slice(0, max);
}

// NIF português: 9 dígitos, com dígito de controlo (aceita "PT" à frente e espaços)
export function nifValido(nif) {
  const d = String(nif || "").toUpperCase().replace(/^PT/, "").replace(/[\s.-]/g, "");
  if (!/^[1-9]\d{8}$/.test(d)) return "";
  let soma = 0;
  for (let i = 0; i < 8; i++) soma += Number(d[i]) * (9 - i);
  let controlo = 11 - (soma % 11);
  if (controlo >= 10) controlo = 0;
  return controlo === Number(d[8]) ? d : "";
}

async function lerResumo(env) {
  try { const raw = await env.HISTORY_KV.get("faturas:resumo"); if (raw) return JSON.parse(raw); } catch {}
  return { pendentes: 0, contador: 0, ultimoId: null, ultimoEm: null };
}
const gravarResumo = (env, r) => env.HISTORY_KV.put("faturas:resumo", JSON.stringify(r));

async function listarFaturas(env) {
  const lista = [];
  let cursor;
  do {
    const listed = await env.HISTORY_KV.list({ prefix: "fatura:", cursor });
    const valores = await Promise.all(listed.keys.map((k) => env.HISTORY_KV.get(k.name)));
    for (const v of valores) { if (!v) continue; try { lista.push(JSON.parse(v)); } catch {} }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  lista.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  return lista;
}

// email pelo servidor (só com RESEND_API_KEY e TICKETS_EMAIL configurados); senão a página envia pelo Web3Forms
async function enviarEmailServidor(env, f) {
  if (!env.RESEND_API_KEY || !env.TICKETS_EMAIL) return false;
  const linhas = [
    `Pedido de fatura nº ${f.numero}`,
    `Compra: ${f.compradoEm.replace("T", " às ")}`,
    `Máquina: ${f.maquina}`,
    `Nome: ${f.nome}`,
    `NIF: ${f.nif}`,
    `Produtos: ${f.produtos}`,
    f.valor ? `Valor pago: ${f.valor}` : "",
    f.email ? `Email: ${f.email}` : "Email: (não indicado)",
    `\nVer no painel: https://mpvending.pt/admin/#faturas`,
  ].filter(Boolean);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.TICKETS_EMAIL_FROM || "MP Vending <onboarding@resend.dev>",
      to: String(env.TICKETS_EMAIL).split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: f.email || undefined,
      subject: `🧾 Pedido de fatura nº ${f.numero} — ${f.nome} — ${f.maquina}`,
      text: linhas.join("\n"),
    }),
  });
  return res.ok;
}

// POST /api/faturas/novo — público
export async function handleFaturaPublica(request, env, ctx) {
  if (request.method !== "POST") return new Response("Método não suportado", { status: 405 });
  let p;
  try { p = await request.json(); } catch { return json({ error: "Pedido inválido" }, 400); }
  if (p && p.website) return json({ ok: true, numero: 0 }); // robô

  const nome = limpar(p.nome, 120);
  const nif = nifValido(p.nif);
  const produtos = limpar(p.produtos, 600);
  const compradoEm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.compradoEm || "") ? p.compradoEm : "";
  const maquina = limpar(p.maquina, 120);
  const email = limpar(p.email, 120).toLowerCase();
  const valor = limpar(p.valor, 20);

  if (!nome) return json({ error: "Indique o nome (ou o nome da empresa)." }, 400);
  if (!nif) return json({ error: "O NIF não é válido. Confirme os 9 dígitos." }, 400);
  if (!produtos) return json({ error: "Indique os produtos que comprou." }, 400);
  if (!compradoEm) return json({ error: "Indique o dia e a hora da compra." }, 400);
  if (!maquina) return json({ error: "Indique qual é a máquina." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "O email não parece válido." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const chaveLimite = `fatura-limite:${ip}`;
  const usados = Number(await env.HISTORY_KV.get(chaveLimite)) || 0;
  if (usados >= MAX_POR_HORA_POR_IP) return json({ error: "Recebemos vários pedidos seguidos deste dispositivo. Tente mais tarde." }, 429);
  ctx.waitUntil(env.HISTORY_KV.put(chaveLimite, String(usados + 1), { expirationTtl: 3600 }).catch(() => {}));

  const resumo = await lerResumo(env);
  const numero = (Number(resumo.contador) || 0) + 1;
  const agora = new Date().toISOString();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const f = {
    id, numero, criadoEm: agora, compradoEm, nome, nif, produtos, maquina, email, valor,
    maquinaId: (/^Máquina (\d{3}(?:-S)?) \(QR\)$/.exec(maquina) || [])[1] || "",
    estado: "Pendente", numeroFatura: "", notas: "", atualizadoEm: agora, emitidaEm: null,
  };
  await env.HISTORY_KV.put(`fatura:${id}`, JSON.stringify(f));
  await gravarResumo(env, { ...resumo, contador: numero, pendentes: (Number(resumo.pendentes) || 0) + 1, ultimoId: id, ultimoEm: agora });

  let emailServidor = false;
  try { emailServidor = await enviarEmailServidor(env, f); } catch { emailServidor = false; }
  return json({ ok: true, numero, emailServidor });
}

// /api/faturas (protegido pela password do admin)
export async function handleFaturas(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (url.searchParams.get("resumo")) {
      const r = await lerResumo(env);
      return json({ pendentes: Math.max(0, Number(r.pendentes) || 0), ultimoId: r.ultimoId, ultimoEm: r.ultimoEm });
    }
    const faturas = await listarFaturas(env);
    const r = await lerResumo(env);
    const pendentes = faturas.filter((f) => f.estado === "Pendente").length;
    if (pendentes !== r.pendentes) await gravarResumo(env, { ...r, pendentes });
    return json({ faturas, estados: FATURA_ESTADOS });
  }
  const id = url.searchParams.get("id") || "";
  if (!/^[\w-]{6,60}$/.test(id)) return json({ error: "Falta o parâmetro id" }, 400);
  const raw = await env.HISTORY_KV.get(`fatura:${id}`);
  if (!raw) return json({ error: "Pedido não encontrado" }, 404);
  const f = JSON.parse(raw);
  const acertar = async (antes, depois) => {
    if ((antes === "Pendente") === (depois === "Pendente")) return;
    const r = await lerResumo(env);
    await gravarResumo(env, { ...r, pendentes: Math.max(0, (Number(r.pendentes) || 0) + (depois === "Pendente" ? 1 : -1)) });
  };
  if (request.method === "PUT") {
    let p;
    try { p = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const antes = f.estado;
    if (FATURA_ESTADOS.includes(p.estado)) f.estado = p.estado;
    if (typeof p.numeroFatura === "string") f.numeroFatura = limpar(p.numeroFatura, 60);
    if (typeof p.notas === "string") f.notas = p.notas.slice(0, 2000);
    if (typeof p.maquinaId === "string" && (p.maquinaId === "" || /^\d{3}(-S)?$/.test(p.maquinaId))) f.maquinaId = p.maquinaId;
    if (f.estado === "Emitida" && antes !== "Emitida") f.emitidaEm = new Date().toISOString();
    if (f.estado !== "Emitida") f.emitidaEm = null;
    f.atualizadoEm = new Date().toISOString();
    await env.HISTORY_KV.put(`fatura:${id}`, JSON.stringify(f));
    await acertar(antes, f.estado);
    return json({ ok: true, fatura: f });
  }
  if (request.method === "DELETE") {
    await env.HISTORY_KV.delete(`fatura:${id}`);
    await acertar(f.estado, "Apagada");
    return json({ ok: true });
  }
  return new Response("Método não suportado", { status: 405 });
}
