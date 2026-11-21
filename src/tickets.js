// ===== Tickets de assistência técnica (clientes reportam problemas em mpvending.pt/assistencia) =====
// Cada ticket fica numa chave própria "ticket:<id>" na KV (nenhum pedido se perde por escritas em simultâneo).
// "tickets:resumo" guarda só a contagem de novos + o último ticket — é isso que o admin consulta a cada minuto
// (1 leitura barata em vez de listar a KV inteira).

export const TICKET_TIPOS = [
  "Moedas / troco",
  "Pagamento com cartão",
  "Produto encravado",
  "Falta de stock",
  "Máquina não liga / avariada",
  "Sugestão de produto",
  "Outro",
];
export const TICKET_ESTADOS = ["Novo", "Em curso", "Resolvido"];

const MAX_POR_HORA_POR_IP = 6;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function limpar(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, max);
}

async function lerResumo(env) {
  try {
    const raw = await env.HISTORY_KV.get("tickets:resumo");
    if (raw) return JSON.parse(raw);
  } catch {}
  return { novos: 0, ultimoId: null, ultimoEm: null, contador: 0 };
}

async function gravarResumo(env, r) {
  await env.HISTORY_KV.put("tickets:resumo", JSON.stringify(r));
}

async function listarTickets(env) {
  const tickets = [];
  let cursor;
  do {
    const listed = await env.HISTORY_KV.list({ prefix: "ticket:", cursor });
    const valores = await Promise.all(listed.keys.map(k => env.HISTORY_KV.get(k.name)));
    for (const v of valores) {
      if (!v) continue;
      try { tickets.push(JSON.parse(v)); } catch {}
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  tickets.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  return tickets;
}

// email opcional enviado pelo servidor (só se RESEND_API_KEY e TICKETS_EMAIL estiverem configurados no Cloudflare).
// Sem isso, a página /assistencia envia o email pelo Web3Forms (o mesmo do formulário de contacto do site).
async function enviarEmailServidor(env, t) {
  if (!env.RESEND_API_KEY || !env.TICKETS_EMAIL) return false;
  const linhas = [
    `Ticket nº ${t.numero}`,
    `Quando: ${t.ocorridoEm || t.criadoEm}`,
    `Máquina: ${t.maquina}`,
    `Problema: ${t.tipo}`,
    `Telefone: ${t.telefone}`,
    t.nome ? `Nome / empresa: ${t.nome}` : "",
    t.descricao ? `\n${t.descricao}` : "",
    `\nVer no painel: https://mpvending.pt/admin/#tickets`,
  ].filter(Boolean);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.TICKETS_EMAIL_FROM || "MP Vending <onboarding@resend.dev>",
      to: String(env.TICKETS_EMAIL).split(",").map(s => s.trim()).filter(Boolean),
      subject: `🔧 Ticket nº ${t.numero} — ${t.tipo} — ${t.maquina}`,
      text: linhas.join("\n"),
    }),
  });
  return res.ok;
}

// POST /api/tickets/novo — público (clientes sem login)
export async function handleTicketPublico(request, env, ctx) {
  if (request.method !== "POST") return new Response("Método não suportado", { status: 405 });
  let p;
  try { p = await request.json(); } catch { return json({ error: "Pedido inválido" }, 400); }

  // armadilha para robôs: campo escondido que uma pessoa nunca preenche
  if (p && p.website) return json({ ok: true, numero: 0 });

  const telefone = limpar(p.telefone, 30);
  const digitos = telefone.replace(/\D/g, "");
  const maquina = limpar(p.maquina, 120);
  const tipo = TICKET_TIPOS.includes(p.tipo) ? p.tipo : "";
  const descricao = limpar(p.descricao, 1000);
  const nome = limpar(p.nome, 80);
  const ocorridoEm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.ocorridoEm || "") ? p.ocorridoEm : "";

  if (digitos.length < 9 || digitos.length > 15) return json({ error: "Indique um número de telefone válido." }, 400);
  if (!maquina) return json({ error: "Indique qual é a máquina." }, 400);
  if (!tipo) return json({ error: "Escolha o tipo de problema." }, 400);
  if ((tipo === "Outro" || tipo === "Sugestão de produto") && !descricao) {
    return json({ error: tipo === "Outro" ? "Descreva o problema." : "Diga-nos que produto gostaria de ver na máquina." }, 400);
  }

  // limite simples por IP para evitar abusos
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const chaveLimite = `ticket-limite:${ip}`;
  const usados = Number(await env.HISTORY_KV.get(chaveLimite)) || 0;
  if (usados >= MAX_POR_HORA_POR_IP) {
    return json({ error: "Recebemos vários pedidos seguidos deste dispositivo. Tente mais tarde ou ligue-nos." }, 429);
  }
  ctx.waitUntil(env.HISTORY_KV.put(chaveLimite, String(usados + 1), { expirationTtl: 3600 }).catch(() => {}));

  const resumo = await lerResumo(env);
  const numero = (Number(resumo.contador) || 0) + 1;
  const agora = new Date().toISOString();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const ticket = {
    id, numero, criadoEm: agora, ocorridoEm, telefone, maquina, tipo, descricao, nome,
    estado: "Novo", notas: "", responsavel: "", atualizadoEm: agora, resolvidoEm: null,
  };
  await env.HISTORY_KV.put(`ticket:${id}`, JSON.stringify(ticket));
  await gravarResumo(env, { ...resumo, contador: numero, novos: (Number(resumo.novos) || 0) + 1, ultimoId: id, ultimoEm: agora });

  let emailServidor = false;
  if (env.RESEND_API_KEY && env.TICKETS_EMAIL) {
    try { emailServidor = await enviarEmailServidor(env, ticket); } catch { emailServidor = false; }
  }
  return json({ ok: true, numero, emailServidor });
}

// /api/tickets (protegido pela password do admin)
//   GET               → lista completa (e acerta a contagem de novos)
//   GET ?resumo=1     → só { novos, ultimoId, ultimoEm } — usado para os alertas a cada minuto
//   PUT ?id=…         → { estado?, notas?, responsavel? }
//   DELETE ?id=…
export async function handleTickets(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (url.searchParams.get("resumo")) {
      const r = await lerResumo(env);
      return json({ novos: Math.max(0, Number(r.novos) || 0), ultimoId: r.ultimoId, ultimoEm: r.ultimoEm });
    }
    const tickets = await listarTickets(env);
    const r = await lerResumo(env);
    const novos = tickets.filter(t => t.estado === "Novo").length;
    if (novos !== r.novos) await gravarResumo(env, { ...r, novos });
    return json({ tickets, tipos: TICKET_TIPOS, estados: TICKET_ESTADOS });
  }

  const id = url.searchParams.get("id") || "";
  if (!/^[\w-]{6,60}$/.test(id)) return json({ error: "Falta o parâmetro id" }, 400);

  if (request.method === "PUT") {
    const raw = await env.HISTORY_KV.get(`ticket:${id}`);
    if (!raw) return json({ error: "Ticket não encontrado" }, 404);
    let t, p;
    try { t = JSON.parse(raw); } catch { return json({ error: "Ticket corrompido" }, 500); }
    try { p = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const estadoAntes = t.estado;
    if (TICKET_ESTADOS.includes(p.estado)) t.estado = p.estado;
    if (typeof p.notas === "string") t.notas = p.notas.slice(0, 2000);
    if (typeof p.responsavel === "string") t.responsavel = p.responsavel.slice(0, 60);
    if (t.estado === "Resolvido" && estadoAntes !== "Resolvido") t.resolvidoEm = new Date().toISOString();
    if (t.estado !== "Resolvido") t.resolvidoEm = null;
    t.atualizadoEm = new Date().toISOString();
    await env.HISTORY_KV.put(`ticket:${id}`, JSON.stringify(t));
    if ((estadoAntes === "Novo") !== (t.estado === "Novo")) {
      const r = await lerResumo(env);
      await gravarResumo(env, { ...r, novos: Math.max(0, (Number(r.novos) || 0) + (t.estado === "Novo" ? 1 : -1)) });
    }
    return json({ ok: true, ticket: t });
  }

  if (request.method === "DELETE") {
    const raw = await env.HISTORY_KV.get(`ticket:${id}`);
    await env.HISTORY_KV.delete(`ticket:${id}`);
    try {
      if (raw && JSON.parse(raw).estado === "Novo") {
        const r = await lerResumo(env);
        await gravarResumo(env, { ...r, novos: Math.max(0, (Number(r.novos) || 0) - 1) });
      }
    } catch {}
    return json({ ok: true });
  }

  return new Response("Método não suportado", { status: 405 });
}
