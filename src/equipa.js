// ===== Equipa: repositores e preparação de caixas (mpvending.pt/reposicao) =====
// Login próprio (não usa a password do admin). Tudo na mesma KV (HISTORY_KV):
//   eq:user:<utilizador>          → { nome, perfil, hash, salt, ativo, criadoEm, ultimoAcesso }
//   eq:sessao:<token>             → { utilizador, expiraEm }                       (expira sozinha)
//   eq:falhas:<ip>                → nº de tentativas falhadas (bloqueia ao fim de 10, durante 15 min)
//   eq:plano:<data>:<id>          → plano do dia enviado do admin (paragens, o que levar em cada caixa, rota)
//   eq:caixas:<data>:<id>         → { <localId>: { pronta, por, em, faltas } }      (marcado pelo preparador)
//   eq:ordem:<id>                 → tarefa / ordem / limpeza dada no admin (pode repetir-se)
//   eq:visita:<data>:<id>         → { localId, inicio, fim, ... } tempo passado em cada local (QR das máquinas)
//   eq:aberta:<utilizador>        → id da visita em curso
// O QR das etiquetas (mpvending.pt/assistencia/?m=007-S) serve aos dois: o cliente vê o formulário de avaria;
// quem tem sessão da equipa é reencaminhado para /reposicao/?qr=007-S, que regista a chegada ou a saída.

import { hashPassword, igualSeguro, lerCookie, servirAsset } from "./demo.js";
import { listarTickets, atualizarTicketPorEquipa, MAX_FOTOS } from "./tickets.js";

const COOKIE = "mpv_equipa";
const SESSAO_S = 60 * 60 * 24 * 90; // 90 dias: o telemóvel do repositor fica sempre com sessão
const MAX_FALHAS = 10;
export const PERFIS = ["repositor", "preparador", "ambos"];
const ORDEM_TIPOS = ["Ordem", "Tarefa", "Limpeza", "Manutenção"];
const URGENCIAS = ["Baixa", "Média", "Alta", "Urgente"];
// frequência das tarefas: uma vez (ad-hoc), a cada N semanas, a cada N meses, ou após N visitas ao local da máquina
const RECORRENCIAS = ["nenhuma", "semanas", "meses", "visitas"];
const RECORRENCIAS_ANTIGAS = { semanal: ["semanas", 1], quinzenal: ["semanas", 2], mensal: ["meses", 1] };
const LOG_MAX = 400;
const VISITA_MAX_MS = 3 * 60 * 60 * 1000; // visita aberta há mais de 3h = esqueceu-se de sair (não conta para as médias)
const VISITA_TTL_S = 60 * 60 * 24 * 400;
const USER_VALIDO = /^[a-z0-9._-]{3,40}$/;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLANO_ID = /^\d{4}-\d{2}-\d{2}:[a-f0-9]{8}$/;
const VISITA_ID = /^\d{4}-\d{2}-\d{2}:\d{13}-[a-f0-9]{6}$/;
const MAQ_RE = /^\d{3}(-S)?$/;
// QR do armazém (mpvending.pt/reposicao/?qr=ARMAZEM): entrada/saída de quem prepara as caixas, como numa máquina
const QR_ARMAZEM = "ARMAZEM";
const LOCAL_ARMAZEM = { id: "armazem", nome: "Armazém (preparação de caixas)", morada: "", maquinas: [] };
const QR_RE = /^(\d{3}(-S)?|ARMAZEM)$/;

const normUser = (u) => String(u || "").trim().toLowerCase();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const aleatorio = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const txt = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, " ").trim().slice(0, max);

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
}
function redirect(location, extra = {}) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}
async function lerJSON(env, chave) {
  try { const raw = await env.HISTORY_KV.get(chave); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function listarPrefixo(env, prefixo) {
  const out = [];
  let cursor;
  do {
    const listed = await env.HISTORY_KV.list({ prefix: prefixo, cursor });
    const valores = await Promise.all(listed.keys.map((k) => env.HISTORY_KV.get(k.name)));
    for (const v of valores) { if (!v) continue; try { out.push(JSON.parse(v)); } catch {} }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return out;
}

// datas em Lisboa (AAAA-MM-DD)
export function dataLisboa(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function somarDias(data, n) {
  const d = new Date(data + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function somarMeses(data, n) {
  const [a, m, d] = data.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1, 12));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0, 12)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

// ===== Registo de atividade do dia (o admin vê "ao vivo") =====
async function registarLog(env, entrada) {
  try {
    const data = dataLisboa();
    const chave = `eq:log:${data}`;
    const lista = (await lerJSON(env, chave)) || [];
    lista.push({ em: new Date().toISOString(), ...entrada });
    await env.HISTORY_KV.put(chave, JSON.stringify(lista.slice(-LOG_MAX)), { expirationTtl: 60 * 60 * 24 * 120 });
  } catch {}
}

// ===== Locais e máquinas (admin/rotas_moradas.json: os mesmos locais da rota sugerida) =====
let locaisCache = null, locaisEm = 0;
async function carregarLocais(request, env) {
  if (locaisCache && Date.now() - locaisEm < 10 * 60 * 1000) return locaisCache;
  const url = new URL(request.url);
  let dados = null;
  try {
    const r = await env.ASSETS.fetch(new Request(url.origin + "/admin/rotas_moradas.json"));
    if (r.ok) dados = await r.json();
  } catch {}
  const porId = {}, porMaquina = {};
  for (const l of (dados && dados.locais) || []) {
    const local = { id: l.id, nome: l.nome, morada: l.morada || "", lat: l.lat, lon: l.lon, maquinas: l.maquinas || [] };
    porId[l.id] = local;
    for (const m of local.maquinas) porMaquina[m] = local;
  }
  locaisCache = { porId, porMaquina };
  locaisEm = Date.now();
  return locaisCache;
}
function localDaMaquina(locais, maquina) {
  return locais.porMaquina[maquina] || { id: "maq-" + maquina.toLowerCase(), nome: "Máquina " + maquina, morada: "", maquinas: [maquina] };
}

// ===== Sessão =====
async function sessaoValida(request, env) {
  const token = lerCookie(request, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await lerJSON(env, `eq:sessao:${token}`);
  if (!s || Date.now() > s.expiraEm) return null;
  const u = await lerJSON(env, `eq:user:${s.utilizador}`);
  if (!u || u.ativo === false) return null; // apagado ou desativado no admin → perde o acesso logo
  return { token, utilizador: s.utilizador, nome: u.nome || s.utilizador, perfil: PERFIS.includes(u.perfil) ? u.perfil : "repositor" };
}

async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const chaveFalhas = `eq:falhas:${ip}`;
  const falhas = parseInt((await env.HISTORY_KV.get(chaveFalhas)) || "0", 10);
  const f = await request.formData().catch(() => null);
  const qr = f ? String(f.get("qr") || "").toUpperCase() : "";
  const extra = QR_RE.test(qr) ? `&qr=${qr}` : "";
  if (falhas >= MAX_FALHAS) return redirect(`/reposicao/?erro=bloqueado${extra}`);
  const utilizador = normUser(f && f.get("utilizador"));
  const password = String((f && f.get("password")) || "");
  const falhou = async () => {
    await env.HISTORY_KV.put(chaveFalhas, String(falhas + 1), { expirationTtl: 900 });
    return redirect(`/reposicao/?erro=credenciais${extra}`);
  };
  if (!USER_VALIDO.test(utilizador) || !password) return falhou();
  const u = await lerJSON(env, `eq:user:${utilizador}`);
  if (!u) return falhou();
  const { hash } = await hashPassword(password, u.salt);
  if (!igualSeguro(hash, u.hash)) return falhou();
  if (u.ativo === false) return redirect(`/reposicao/?erro=desativado${extra}`);
  const token = aleatorio(32);
  await env.HISTORY_KV.put(`eq:sessao:${token}`, JSON.stringify({ utilizador, expiraEm: Date.now() + SESSAO_S * 1000 }), { expirationTtl: SESSAO_S });
  u.ultimoAcesso = new Date().toISOString();
  await env.HISTORY_KV.put(`eq:user:${utilizador}`, JSON.stringify(u));
  if (falhas) await env.HISTORY_KV.delete(chaveFalhas);
  return redirect(`/reposicao/${extra ? "?" + extra.slice(1) : ""}`, {
    "Set-Cookie": `${COOKIE}=${token}; Path=/reposicao; Max-Age=${SESSAO_S}; HttpOnly; Secure; SameSite=Lax`,
  });
}

// ===== Visitas (tempo em cada local) =====
async function fecharVisita(env, v, fecho, fim) {
  v.fim = fim;
  v.fecho = fecho;
  v.duracaoMin = fim ? Math.max(0, Math.round((new Date(fim) - new Date(v.inicio)) / 60000)) : null;
  await env.HISTORY_KV.put(`eq:visita:${v.id}`, JSON.stringify(v), { expirationTtl: VISITA_TTL_S });
  await env.HISTORY_KV.delete(`eq:aberta:${v.utilizador}`);
  return v;
}
async function visitaAberta(env, utilizador) {
  const id = await env.HISTORY_KV.get(`eq:aberta:${utilizador}`);
  if (!id) return null;
  const v = await lerJSON(env, `eq:visita:${id}`);
  if (!v || v.fim) { await env.HISTORY_KV.delete(`eq:aberta:${utilizador}`); return null; }
  // esqueceu-se de sair: fica registada sem hora de saída e não entra nas médias
  if (Date.now() - new Date(v.inicio).getTime() > VISITA_MAX_MS) { await fecharVisita(env, v, "sem-saida", null); return null; }
  return v;
}

// POST { maquina } (leitura do QR) ou { localId } (botão "Cheguei") ou { acao: "sair" }
// A 1ª leitura num local regista a chegada. Ler outra máquina do mesmo local junta-a à visita.
// Ler de novo uma máquina já lida (ou carregar em "Terminar visita") regista a saída.
// Ler o QR de outro local fecha a visita anterior automaticamente (fica marcada, não entra nas médias).
async function registarVisita(request, env, s, p) {
  const locais = await carregarLocais(request, env);
  const agora = new Date();
  const aberta = await visitaAberta(env, s.utilizador);
  if (p.acao === "sair") {
    if (!aberta) return { acao: "nada" };
    const v = await fecharVisita(env, aberta, "botao", agora.toISOString());
    await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "saida", localId: v.localId, texto: `saiu de ${v.localNome} (${v.duracaoMin} min)` });
    return { acao: "saida", visita: v };
  }
  const maquina = String(p.maquina || "").toUpperCase();
  let local = null;
  if (maquina === QR_ARMAZEM) local = LOCAL_ARMAZEM;
  else if (MAQ_RE.test(maquina)) local = localDaMaquina(locais, maquina);
  else if (p.localId && locais.porId[p.localId]) local = locais.porId[p.localId];
  if (!local) return { erro: "Máquina ou local desconhecido." };

  if (aberta && aberta.localId === local.id) {
    const novaMaquina = maquina && !aberta.maquinas.includes(maquina);
    if (novaMaquina) {
      aberta.maquinas.push(maquina);
      await env.HISTORY_KV.put(`eq:visita:${aberta.id}`, JSON.stringify(aberta), { expirationTtl: VISITA_TTL_S });
      return { acao: "entrada", visita: aberta, local, juntou: maquina, ordens: await ordensDoLocal(env, s, local.id) };
    }
    // a mesma leitura repetida no primeiro minuto (página recarregada) não fecha a visita
    if (agora - new Date(aberta.inicio) < 60000 || !maquina && p.localId) return { acao: "entrada", visita: aberta, local, repetido: true, ordens: await ordensDoLocal(env, s, local.id) };
    const v = await fecharVisita(env, aberta, "qr", agora.toISOString());
    await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "saida", localId: v.localId, texto: `saiu de ${v.localNome} (${v.duracaoMin} min)` });
    return { acao: "saida", visita: v, local };
  }
  let anterior = null;
  if (aberta) {
    anterior = await fecharVisita(env, aberta, "auto-seguinte", agora.toISOString());
    await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "saida", localId: anterior.localId, texto: `visita a ${anterior.localNome} fechada ao ler o QR seguinte` });
  }
  const data = dataLisboa(agora);
  const v = {
    id: `${data}:${agora.getTime()}-${aleatorio(3)}`,
    data, utilizador: s.utilizador, nome: s.nome,
    localId: local.id, localNome: local.nome,
    maquinas: maquina ? [maquina] : [],
    inicio: agora.toISOString(), fim: null, fecho: null, duracaoMin: null,
    origem: maquina ? "qr" : "botao",
  };
  await env.HISTORY_KV.put(`eq:visita:${v.id}`, JSON.stringify(v), { expirationTtl: VISITA_TTL_S });
  await env.HISTORY_KV.put(`eq:aberta:${s.utilizador}`, v.id, { expirationTtl: VISITA_TTL_S });
  if (local !== LOCAL_ARMAZEM) await contarVisitaNasOrdens(env, local.id);
  await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "entrada", localId: local.id, texto: local === LOCAL_ARMAZEM ? "entrou no armazém (caixas)" : `chegou a ${local.nome}${maquina ? " (QR " + maquina + ")" : " (sem QR)"}` });
  return { acao: "entrada", visita: v, local, anterior, ordens: await ordensDoLocal(env, s, local.id) };
}

// ===== Ordens / tarefas =====
function ordemValida(p, locais) {
  const titulo = txt(p.titulo, 160);
  if (!titulo) return { erro: "Falta o título." };
  const maquina = MAQ_RE.test(String(p.maquina || "").toUpperCase()) ? String(p.maquina).toUpperCase() : "";
  const localId = maquina ? localDaMaquina(locais, maquina).id : (p.localId && locais.porId[p.localId] ? p.localId : "");
  return {
    titulo,
    descricao: txt(p.descricao, 2000),
    tipo: ORDEM_TIPOS.includes(p.tipo) ? p.tipo : "Tarefa",
    maquina, localId,
    data: DATA_RE.test(p.data || "") ? p.data : "",
    ...frequencia(p),
    atribuidaA: USER_VALIDO.test(normUser(p.atribuidaA)) ? normUser(p.atribuidaA) : "",
    urgencia: URGENCIAS.includes(p.urgencia) ? p.urgencia : "Média",
  };
}
// { recorrencia, intervalo } — aceita também os valores antigos (semanal, quinzenal, mensal)
function frequencia(p) {
  if (RECORRENCIAS_ANTIGAS[p.recorrencia]) { const [r, n] = RECORRENCIAS_ANTIGAS[p.recorrencia]; return { recorrencia: r, intervalo: n }; }
  const recorrencia = RECORRENCIAS.includes(p.recorrencia) ? p.recorrencia : "nenhuma";
  const intervalo = recorrencia === "nenhuma" ? 0 : Math.min(recorrencia === "semanas" ? 52 : recorrencia === "meses" ? 24 : 100, Math.max(1, Math.round(Number(p.intervalo) || 1)));
  return { recorrencia, intervalo };
}
// tarefas antigas guardadas com "semanal"/"quinzenal"/"mensal" passam a ler-se no formato novo
function normalizarOrdem(o) {
  if (o && RECORRENCIAS_ANTIGAS[o.recorrencia]) Object.assign(o, frequencia(o));
  if (o && !o.intervalo && o.recorrencia && o.recorrencia !== "nenhuma") o.intervalo = 1;
  return o;
}
// está para fazer neste dia? (por data, ou por nº de visitas ao local)
function ordemDevida(o, data) {
  if (o.estado === "Feita") return false;
  if (o.recorrencia === "visitas") return (o.visitasDesde || 0) >= (o.intervalo || 1);
  return !o.data || o.data <= data;
}
async function listarOrdens(env) {
  return (await listarPrefixo(env, "eq:ordem:")).map(normalizarOrdem);
}
// cada visita nova a um local soma 1 às tarefas "após N visitas" desse local
async function contarVisitaNasOrdens(env, localId) {
  for (const o of await listarOrdens(env)) {
    if (o.recorrencia !== "visitas" || o.estado === "Feita" || o.localId !== localId) continue;
    o.visitasDesde = (o.visitasDesde || 0) + 1;
    await env.HISTORY_KV.put(`eq:ordem:${o.id}`, JSON.stringify(o));
  }
}
// tarefas pendentes de um local (para o ecrã que abre ao ler o QR): as que estão para fazer e as próximas
async function ordensDoLocal(env, s, localId) {
  const hoje = dataLisboa();
  return (await listarOrdens(env))
    .filter((o) => o.estado !== "Feita" && o.localId === localId && ordemParaMim(o, s))
    .map((o) => ({ ...o, devida: ordemDevida(o, hoje) }))
    .sort((a, b) => (b.devida - a.devida) || (URGENCIAS.indexOf(b.urgencia) - URGENCIAS.indexOf(a.urgencia)));
}
async function concluirOrdem(env, o, quem, nota) {
  normalizarOrdem(o);
  const agora = new Date().toISOString();
  o.historico = [{ em: agora, por: quem, nota: txt(nota, 500), data: o.data, visitas: o.visitasDesde }, ...(o.historico || [])].slice(0, 30);
  o.ultimaVez = agora;
  o.ultimaPor = quem;
  if (o.recorrencia === "semanas" || o.recorrencia === "meses" || o.recorrencia === "visitas") {
    // repete: volta a ficar pendente, contado a partir de hoje (ou da próxima visita)
    const hoje = dataLisboa();
    if (o.recorrencia === "semanas") o.data = somarDias(hoje, 7 * (o.intervalo || 1));
    if (o.recorrencia === "meses") o.data = somarMeses(hoje, o.intervalo || 1);
    if (o.recorrencia === "visitas") o.visitasDesde = 0;
    o.estado = "Pendente";
  } else {
    o.estado = "Feita";
    o.feitaEm = agora;
    o.feitaPor = quem;
    o.nota = txt(nota, 500);
  }
  await env.HISTORY_KV.put(`eq:ordem:${o.id}`, JSON.stringify(o));
  return o;
}
const ordemParaMim = (o, s) => !o.atribuidaA || o.atribuidaA === s.utilizador;

// ===== Planos =====
async function planosDoDia(env, data) {
  const planos = await listarPrefixo(env, `eq:plano:${data}:`);
  await Promise.all(planos.map(async (pl) => { pl.caixas = (await lerJSON(env, `eq:caixas:${pl.id}`)) || {}; }));
  planos.sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
  return planos;
}
const planoParaMim = (pl, s) => s.perfil !== "repositor" || !pl.responsavel || pl.responsavel === s.utilizador;

function ticketResumido(t, locais) {
  const m = t.maquinaId || "";
  return {
    id: t.id, numero: t.numero, criadoEm: t.criadoEm, ocorridoEm: t.ocorridoEm, tipo: t.tipo, descricao: t.descricao,
    maquina: t.maquina, maquinaId: m, localId: m ? localDaMaquina(locais, m).id : "", estado: t.estado, fotos: t.fotos || 0, notas: t.notas || "",
  };
}

// ===== API da página /reposicao (sessão da equipa) =====
async function handleApiEquipa(request, env, s, caminho) {
  const url = new URL(request.url);
  const locais = await carregarLocais(request, env);
  const metodo = request.method;
  const corpo = async () => { try { return await request.json(); } catch { return null; } };

  if (caminho === "sessao") return json({ utilizador: s.utilizador, nome: s.nome, perfil: s.perfil });

  if (caminho === "dia" && metodo === "GET") {
    const data = DATA_RE.test(url.searchParams.get("data") || "") ? url.searchParams.get("data") : dataLisboa();
    const [planos, visitasDia, aberta, ordens, tickets] = await Promise.all([
      planosDoDia(env, data),
      listarPrefixo(env, `eq:visita:${data}:`),
      visitaAberta(env, s.utilizador),
      listarOrdens(env),
      listarTickets(env),
    ]);
    const minhas = ordens.filter((o) => o.estado !== "Feita" && ordemParaMim(o, s));
    const pendentes = minhas
      .filter((o) => ordemDevida(o, data))
      .sort((a, b) => (URGENCIAS.indexOf(b.urgencia) - URGENCIAS.indexOf(a.urgencia)) || String(a.data || "9").localeCompare(String(b.data || "9")));
    const proximas = minhas
      .filter((o) => !ordemDevida(o, data))
      .sort((a, b) => String(a.data || "9").localeCompare(String(b.data || "9")));
    const feitasHoje = ordens.filter((o) => ordemParaMim(o, s) && o.ultimaVez && dataLisboa(new Date(o.ultimaVez)) === data);
    return json({
      data, hoje: dataLisboa(), eu: { utilizador: s.utilizador, nome: s.nome, perfil: s.perfil },
      planos: planos.filter((pl) => planoParaMim(pl, s)),
      visitas: visitasDia.sort((a, b) => a.inicio.localeCompare(b.inicio)),
      aberta,
      ordens: pendentes,
      proximas,
      feitasHoje: feitasHoje.map((o) => ({ id: o.id, titulo: o.titulo, maquina: o.maquina, por: o.ultimaPor, em: o.ultimaVez })),
      tickets: tickets.filter((t) => t.estado !== "Resolvido").map((t) => ticketResumido(t, locais)),
      locais: locais.porId,
    });
  }

  if (caminho === "semana" && metodo === "GET") {
    const inicio = DATA_RE.test(url.searchParams.get("inicio") || "") ? url.searchParams.get("inicio") : dataLisboa();
    const dias = Array.from({ length: 7 }, (_, i) => somarDias(inicio, i));
    const fim = dias[6];
    const [ordens, ...porDia] = await Promise.all([
      listarOrdens(env),
      ...dias.map((d) => Promise.all([planosDoDia(env, d), listarPrefixo(env, `eq:visita:${d}:`)])),
    ]);
    const hoje = dataLisboa();
    const resultado = dias.map((d, i) => {
      const [planos, visitas] = porDia[i];
      // ordens com data neste dia (as que se repetem aparecem também nas próximas ocorrências da semana)
      const doDia = [];
      for (const o of ordens) {
        if (!ordemParaMim(o, s) || o.estado === "Feita" || !o.data || o.recorrencia === "visitas") continue;
        const n = o.intervalo || 1;
        let alvo = o.data;
        if (o.recorrencia === "semanas") { while (alvo < d) alvo = somarDias(alvo, 7 * n); }
        if (o.recorrencia === "meses") { let k = 1; const base = o.data; while (alvo < d && k < 100) alvo = somarMeses(base, n * k++); }
        if (alvo === d || (o.data < hoje && d === hoje)) doDia.push({ id: o.id, titulo: o.titulo, tipo: o.tipo, maquina: o.maquina, urgencia: o.urgencia, atrasada: o.data < hoje, prevista: alvo !== o.data });
      }
      return {
        data: d,
        planos: planos.filter((pl) => planoParaMim(pl, s)).map((pl) => ({ id: pl.id, responsavelNome: pl.responsavelNome, saida: pl.saida, paragens: pl.paragens.map((x) => x.nome) })),
        ordens: doDia,
        visitas: visitas.filter((v) => v.utilizador === s.utilizador).length,
      };
    });
    return json({ inicio, fim, dias: resultado });
  }

  if (caminho === "visita" && metodo === "POST") {
    const p = (await corpo()) || {};
    const r = await registarVisita(request, env, s, p);
    if (r.erro) return json({ error: r.erro }, 400);
    return json(r);
  }

  if (caminho === "ordem" && metodo === "PUT") {
    const id = url.searchParams.get("id") || "";
    if (!/^[a-f0-9-]{8,40}$/.test(id)) return json({ error: "Falta o id" }, 400);
    const o = await lerJSON(env, `eq:ordem:${id}`);
    if (!o || !ordemParaMim(o, s)) return json({ error: "Tarefa não encontrada" }, 404);
    const p = (await corpo()) || {};
    const feita = await concluirOrdem(env, o, s.nome, p.nota);
    await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "tarefa", localId: o.localId, texto: `fez "${o.titulo}"${o.maquina ? " na máquina " + o.maquina : ""}${p.nota ? " — " + txt(p.nota, 200) : ""}` });
    return json({ ok: true, ordem: feita });
  }

  if (caminho === "ticket" && metodo === "PUT") {
    const id = url.searchParams.get("id") || "";
    if (!/^[\w-]{6,60}$/.test(id)) return json({ error: "Falta o id" }, 400);
    const p = (await corpo()) || {};
    if (p.estado && !["Em curso", "Resolvido"].includes(p.estado)) return json({ error: "Estado inválido" }, 400);
    const t = await atualizarTicketPorEquipa(env, id, p, s.nome);
    if (!t) return json({ error: "Ticket não encontrado" }, 404);
    await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "ticket", texto: `ticket #${t.numero}${p.estado ? " → " + p.estado : ": nota"}${p.nota ? " — " + txt(p.nota, 200) : ""}` });
    return json({ ok: true, ticket: ticketResumido(t, locais) });
  }

  if (caminho === "ticket-foto" && metodo === "GET") {
    const id = url.searchParams.get("id") || "";
    const n = Number(url.searchParams.get("n"));
    if (!/^[\w-]{6,60}$/.test(id) || !Number.isInteger(n) || n < 0 || n >= MAX_FOTOS) return new Response("Foto inválida", { status: 400 });
    const bytes = await env.HISTORY_KV.get(`ticketfoto:${id}:${n}`, { type: "arrayBuffer" });
    if (!bytes) return new Response("Foto não encontrada", { status: 404 });
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  }

  if (caminho === "caixa" && metodo === "PUT") {
    const plano = url.searchParams.get("plano") || "";
    const localId = url.searchParams.get("local") || "";
    if (!PLANO_ID.test(plano) || !/^[a-z0-9-]{1,40}$/.test(localId)) return json({ error: "Pedido inválido" }, 400);
    const pl = await lerJSON(env, `eq:plano:${plano}`);
    if (!pl) return json({ error: "Plano não encontrado (pode ter sido apagado no admin)" }, 404);
    const p = (await corpo()) || {};
    const caixas = (await lerJSON(env, `eq:caixas:${plano}`)) || {};
    const atual = caixas[localId] || {};
    const paragem = pl.paragens.find((x) => x.localId === localId);
    const antes = !!atual.pronta;
    if (typeof p.pronta === "boolean") { atual.pronta = p.pronta; atual.por = s.nome; atual.em = new Date().toISOString(); }
    if (typeof p.faltas === "string") {
      atual.faltas = txt(p.faltas, 500);
      if (atual.faltas) await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "caixa", localId, texto: `caixa ${paragem ? paragem.nome : localId}: faltou ${atual.faltas}` });
    }
    // ✅ produto a produto: quando estão todos marcados, a caixa fica pronta sozinha
    if (typeof p.item === "string" && typeof p.feito === "boolean" && paragem) {
      const chave = txt(p.item, 200);
      atual.itens = atual.itens || {};
      if (p.feito) atual.itens[chave] = 1; else delete atual.itens[chave];
      const chaves = paragem.itens.filter((it) => it.aLevar > 0).map((it) => `${it.maquina}|${it.produto}`);
      const todos = chaves.length > 0 && chaves.every((k) => atual.itens[k]);
      if (todos && !atual.pronta) { atual.pronta = true; atual.por = s.nome; atual.em = new Date().toISOString(); }
      if (!todos && atual.pronta && !p.feito) atual.pronta = false;
    }
    if (antes !== !!atual.pronta) await registarLog(env, { quem: s.nome, utilizador: s.utilizador, tipo: "caixa", localId, texto: `${atual.pronta ? "caixa pronta" : "desmarcou a caixa"}: ${paragem ? paragem.nome : localId} (${pl.data === dataLisboa() ? "hoje" : pl.data.split("-").reverse().slice(0, 2).join("/")})` });
    caixas[localId] = atual;
    await env.HISTORY_KV.put(`eq:caixas:${plano}`, JSON.stringify(caixas), { expirationTtl: VISITA_TTL_S });
    return json({ ok: true, caixas });
  }

  return json({ error: "Pedido desconhecido" }, 404);
}

// Rotas públicas /reposicao/* — devolve uma Response, ou null se o caminho não for da equipa
export async function handleEquipa(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  if (p !== "/reposicao" && !p.startsWith("/reposicao/")) return null;
  if (p === "/reposicao" || (url.pathname !== p && request.method === "GET")) return redirect((p === "/reposicao" ? "/reposicao/" : p) + url.search);

  if (p === "/reposicao/entrar" && request.method === "POST") return handleLogin(request, env);
  if (p === "/reposicao/sair") {
    const token = lerCookie(request, COOKIE);
    if (token && /^[a-f0-9]{64}$/.test(token)) await env.HISTORY_KV.delete(`eq:sessao:${token}`);
    return redirect("/reposicao/", { "Set-Cookie": `${COOKIE}=; Path=/reposicao; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  const s = await sessaoValida(request, env);
  if (p.startsWith("/reposicao/api/")) {
    if (!s) return json({ error: "sem sessão" }, 401);
    try { return await handleApiEquipa(request, env, s, p.slice("/reposicao/api/".length)); }
    catch (err) { return json({ error: err.message }, 500); }
  }
  if (!s) return servirAsset(request, env, "/reposicao/entrar.html");
  if (p === "/reposicao/" || p === "/reposicao/index.html") return servirAsset(request, env, "/reposicao/index.html");
  if (p === "/reposicao/entrar.html") return redirect("/reposicao/");
  return servirAsset(request, env, url.pathname);
}

// ===== API do admin (protegida pela password do admin): /api/equipa/<recurso> =====
export async function handleEquipaAdmin(request, env) {
  const url = new URL(request.url);
  const recurso = url.pathname.slice("/api/equipa/".length);
  const metodo = request.method;
  const corpo = async () => { try { return await request.json(); } catch { return null; } };
  const locais = await carregarLocais(request, env);

  if (recurso === "utilizadores") {
    if (metodo === "GET") {
      const lista = [];
      let cursor;
      do {
        const listed = await env.HISTORY_KV.list({ prefix: "eq:user:", cursor });
        for (const k of listed.keys) {
          const u = await lerJSON(env, k.name);
          if (u) lista.push({ utilizador: k.name.slice(8), nome: u.nome, perfil: u.perfil, ativo: u.ativo !== false, criadoEm: u.criadoEm, ultimoAcesso: u.ultimoAcesso || null });
        }
        cursor = listed.list_complete ? null : listed.cursor;
      } while (cursor);
      lista.sort((a, b) => a.nome.localeCompare(b.nome));
      return json({ utilizadores: lista, perfis: PERFIS });
    }
    if (metodo === "POST") {
      const b = (await corpo()) || {};
      const utilizador = normUser(b.utilizador);
      const password = String(b.password || "");
      if (!USER_VALIDO.test(utilizador)) return json({ error: "Utilizador inválido: 3 a 40 caracteres, só letras, números, ponto, hífen ou _." }, 400);
      if (password.length < 6) return json({ error: "A password tem de ter pelo menos 6 caracteres." }, 400);
      if (await env.HISTORY_KV.get(`eq:user:${utilizador}`)) return json({ error: "Já existe esse utilizador." }, 409);
      const { hash, salt } = await hashPassword(password);
      const registo = { nome: txt(b.nome, 60) || utilizador, perfil: PERFIS.includes(b.perfil) ? b.perfil : "repositor", hash, salt, ativo: true, criadoEm: new Date().toISOString() };
      await env.HISTORY_KV.put(`eq:user:${utilizador}`, JSON.stringify(registo));
      return json({ ok: true, utilizador });
    }
    if (metodo === "PATCH") {
      const b = (await corpo()) || {};
      const utilizador = normUser(b.utilizador);
      const u = await lerJSON(env, `eq:user:${utilizador}`);
      if (!u) return json({ error: "Utilizador não encontrado." }, 404);
      if (typeof b.nome === "string" && b.nome.trim()) u.nome = txt(b.nome, 60);
      if (PERFIS.includes(b.perfil)) u.perfil = b.perfil;
      if (typeof b.ativo === "boolean") u.ativo = b.ativo;
      if (typeof b.password === "string") {
        if (b.password.length < 6) return json({ error: "A password tem de ter pelo menos 6 caracteres." }, 400);
        Object.assign(u, await hashPassword(b.password));
      }
      await env.HISTORY_KV.put(`eq:user:${utilizador}`, JSON.stringify(u));
      return json({ ok: true });
    }
    if (metodo === "DELETE") {
      await env.HISTORY_KV.delete(`eq:user:${normUser(url.searchParams.get("utilizador"))}`);
      return json({ ok: true });
    }
  }

  if (recurso === "ordens") {
    if (metodo === "GET") {
      const ordens = await listarOrdens(env);
      ordens.sort((a, b) => String(b.criadaEm).localeCompare(String(a.criadaEm)));
      return json({ ordens, tipos: ORDEM_TIPOS, urgencias: URGENCIAS, recorrencias: RECORRENCIAS });
    }
    if (metodo === "POST") {
      const b = (await corpo()) || {};
      // "maquinas": uma tarefa por máquina (ex.: limpeza semanal em todas)
      const lista = Array.isArray(b.maquinas) && b.maquinas.length ? b.maquinas.slice(0, 40).map((m) => ({ ...b, maquina: m })) : [b];
      const criadas = [];
      for (const item of lista) {
        const v = ordemValida(item, locais);
        if (v.erro) return json({ error: v.erro }, 400);
        if (v.recorrencia === "visitas" && !v.localId) return json({ error: "\"Após N visitas\" precisa de uma máquina." }, 400);
        const o = { id: crypto.randomUUID(), ...v, estado: "Pendente", criadaEm: new Date().toISOString(), historico: [] };
        await env.HISTORY_KV.put(`eq:ordem:${o.id}`, JSON.stringify(o));
        criadas.push(o);
      }
      return json({ ok: true, criadas: criadas.length });
    }
    const id = url.searchParams.get("id") || "";
    if (!/^[a-f0-9-]{8,40}$/.test(id)) return json({ error: "Falta o id" }, 400);
    if (metodo === "PUT") {
      const o = await lerJSON(env, `eq:ordem:${id}`);
      if (!o) return json({ error: "Tarefa não encontrada" }, 404);
      const b = (await corpo()) || {};
      if (b.concluir) return json({ ok: true, ordem: await concluirOrdem(env, o, "Admin", b.nota) });
      if (b.reabrir) { o.estado = "Pendente"; o.feitaEm = null; o.feitaPor = null; normalizarOrdem(o); }
      else {
        const v = ordemValida({ ...o, ...b }, locais);
        if (v.erro) return json({ error: v.erro }, 400);
        Object.assign(o, v);
      }
      await env.HISTORY_KV.put(`eq:ordem:${id}`, JSON.stringify(o));
      return json({ ok: true, ordem: o });
    }
    if (metodo === "DELETE") { await env.HISTORY_KV.delete(`eq:ordem:${id}`); return json({ ok: true }); }
  }

  if (recurso === "planos") {
    if (metodo === "GET") {
      const desde = DATA_RE.test(url.searchParams.get("desde") || "") ? url.searchParams.get("desde") : somarDias(dataLisboa(), -7);
      const dias = Math.min(60, Math.max(1, Number(url.searchParams.get("dias")) || 21));
      const datas = Array.from({ length: dias }, (_, i) => somarDias(desde, i));
      const [porDia, visitasPorDia] = await Promise.all([
        Promise.all(datas.map((d) => planosDoDia(env, d))),
        Promise.all(datas.map((d) => listarPrefixo(env, `eq:visita:${d}:`))),
      ]);
      const planos = porDia.flatMap((lista, i) => lista.map((pl) => {
        const visitadas = new Set(visitasPorDia[i].filter((v) => v.fim).map((v) => v.localId));
        return {
          id: pl.id, data: pl.data, responsavel: pl.responsavel, responsavelNome: pl.responsavelNome, criadoEm: pl.criadoEm, saida: pl.saida,
          paragens: pl.paragens.map((x) => ({ localId: x.localId, nome: x.nome, pronta: !!(pl.caixas[x.localId] && pl.caixas[x.localId].pronta), faltas: (pl.caixas[x.localId] || {}).faltas || "", visitada: visitadas.has(x.localId) })),
        };
      }));
      return json({ planos });
    }
    if (metodo === "POST") {
      const b = (await corpo()) || {};
      const data = DATA_RE.test(b.data || "") ? b.data : "";
      if (!data) return json({ error: "Falta a data do plano." }, 400);
      if (!Array.isArray(b.paragens) || !b.paragens.length) return json({ error: "O plano não tem paragens." }, 400);
      const responsavel = USER_VALIDO.test(normUser(b.responsavel)) ? normUser(b.responsavel) : "";
      let responsavelNome = "";
      if (responsavel) { const u = await lerJSON(env, `eq:user:${responsavel}`); if (!u) return json({ error: "Repositor desconhecido." }, 400); responsavelNome = u.nome; }
      // "substituir": apaga os planos desse dia para o mesmo repositor (reenviar depois de mudar a seleção)
      if (b.substituir) for (const pl of await listarPrefixo(env, `eq:plano:${data}:`)) {
        if ((pl.responsavel || "") === responsavel) { await env.HISTORY_KV.delete(`eq:plano:${pl.id}`); }
      }
      const id = `${data}:${aleatorio(4)}`;
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      const plano = {
        id, data, responsavel, responsavelNome, criadoEm: new Date().toISOString(),
        saida: txt(b.saida, 5), fim: txt(b.fim, 5), km: num(b.km), conducaoMin: num(b.conducaoMin), voltar: !!b.voltar,
        mapsLinks: (Array.isArray(b.mapsLinks) ? b.mapsLinks : []).filter((l) => /^https:\/\/www\.google\.com\/maps\//.test(l)).slice(0, 5),
        nota: txt(b.nota, 1000),
        paragens: b.paragens.slice(0, 30).map((x, i) => ({
          n: i + 1,
          localId: /^[a-z0-9-]{1,40}$/.test(x.localId || "") ? x.localId : "local-" + i,
          nome: txt(x.nome, 80), morada: txt(x.morada, 200), lat: num(x.lat), lon: num(x.lon),
          chegada: txt(x.chegada, 5), tempoPrevisto: num(x.tempoPrevisto),
          maquinas: (Array.isArray(x.maquinas) ? x.maquinas : []).filter((m) => MAQ_RE.test(m)).slice(0, 8),
          nivel: txt(x.nivel, 40),
          itens: (Array.isArray(x.itens) ? x.itens : []).slice(0, 80).map((it) => ({
            maquina: MAQ_RE.test(it.maquina || "") ? it.maquina : "", produto: txt(it.produto, 120),
            aLevar: Math.max(0, Math.round(Number(it.aLevar) || 0)), precisava: Math.max(0, Math.round(Number(it.precisava) || 0)),
            stock: Math.round(Number(it.stock) || 0), capacidade: Math.round(Number(it.capacidade) || 0),
            canais: (Array.isArray(it.canais) ? it.canais : []).map((c) => txt(c, 10)).slice(0, 12), nota: txt(it.nota, 200),
          })),
          trocas: (Array.isArray(x.trocas) ? x.trocas : []).slice(0, 4).map((t) => ({
            maquina: MAQ_RE.test(t.maquina || "") ? t.maquina : "", feita: !!t.feita,
            canais: (Array.isArray(t.canais) ? t.canais : []).slice(0, 80).map((c) => ({ canal: txt(c.canal, 10), antes: txt(c.antes, 120), depois: txt(c.depois, 120), acao: txt(c.acao, 60) })),
          })),
          retirar: (Array.isArray(x.retirar) ? x.retirar : []).slice(0, 40).map((f) => ({ maquina: MAQ_RE.test(f.maquina || "") ? f.maquina : "", canal: txt(f.canal, 10), produto: txt(f.produto, 120), qtd: Math.round(Number(f.qtd) || 0) })),
        })),
        resumo: (Array.isArray(b.resumo) ? b.resumo : []).slice(0, 200).map((r) => ({ produto: txt(r.produto, 120), total: Math.round(Number(r.total) || 0), locais: Math.round(Number(r.locais) || 0) })),
        faltas: (Array.isArray(b.faltas) ? b.faltas : []).slice(0, 100).map((f) => ({ produto: txt(f.produto, 120), falta: Math.round(Number(f.falta) || 0), arm3: Math.round(Number(f.arm3) || 0) })),
      };
      const corpoPlano = JSON.stringify(plano);
      if (corpoPlano.length > 2_000_000) return json({ error: "Plano demasiado grande." }, 400);
      await env.HISTORY_KV.put(`eq:plano:${id}`, corpoPlano, { expirationTtl: VISITA_TTL_S });
      return json({ ok: true, id });
    }
    if (metodo === "DELETE") {
      const id = url.searchParams.get("id") || "";
      if (!PLANO_ID.test(id)) return json({ error: "Falta o id" }, 400);
      await env.HISTORY_KV.delete(`eq:plano:${id}`);
      await env.HISTORY_KV.delete(`eq:caixas:${id}`);
      return json({ ok: true });
    }
  }

  // visão ao vivo: onde está cada pessoa, progresso dos planos de hoje e amanhã, e o registo do que foi feito hoje
  if (recurso === "aovivo" && metodo === "GET") {
    const hoje = dataLisboa();
    const amanha = somarDias(hoje, 1);
    const [planosHoje, planosAmanha, visitasHoje, log, ordens] = await Promise.all([
      planosDoDia(env, hoje), planosDoDia(env, amanha),
      listarPrefixo(env, `eq:visita:${hoje}:`), lerJSON(env, `eq:log:${hoje}`), listarOrdens(env),
    ]);
    const pessoas = [];
    for (const k of (await env.HISTORY_KV.list({ prefix: "eq:user:" })).keys) {
      const u = await lerJSON(env, k.name);
      if (!u || u.ativo === false) continue;
      const utilizador = k.name.slice(8);
      const minhas = visitasHoje.filter((v) => v.utilizador === utilizador).sort((a, b) => a.inicio.localeCompare(b.inicio));
      const aberta = await visitaAberta(env, utilizador);
      pessoas.push({
        utilizador, nome: u.nome, perfil: u.perfil, ultimoAcesso: u.ultimoAcesso || null,
        aberta, ultima: minhas.filter((v) => v.fim).pop() || null,
        visitas: minhas.length,
        minutos: minhas.filter((v) => v.fim && (v.fecho === "qr" || v.fecho === "botao")).reduce((s, v) => s + v.duracaoMin, 0),
      });
    }
    const resumoPlano = (pl, visitas) => {
      const feitas = new Set(visitas.filter((v) => v.fim).map((v) => v.localId));
      const agora = new Set(visitas.filter((v) => !v.fim && !v.fecho).map((v) => v.localId));
      return {
        id: pl.id, data: pl.data, responsavelNome: pl.responsavelNome, saida: pl.saida,
        paragens: pl.paragens.map((x) => {
          const c = pl.caixas[x.localId] || {};
          const itens = x.itens.filter((it) => it.aLevar > 0);
          return { localId: x.localId, nome: x.nome, chegada: x.chegada, pronta: !!c.pronta, faltas: c.faltas || "", itensFeitos: itens.filter((it) => c.itens && c.itens[`${it.maquina}|${it.produto}`]).length, itens: itens.length, visitada: feitas.has(x.localId), emCurso: agora.has(x.localId) };
        }),
      };
    };
    const pendentesHoje = ordens.filter((o) => ordemDevida(o, hoje)).length;
    return json({
      hoje, amanha, agora: new Date().toISOString(), pessoas,
      planosHoje: planosHoje.map((pl) => resumoPlano(pl, visitasHoje)),
      planosAmanha: planosAmanha.map((pl) => resumoPlano(pl, [])),
      log: (log || []).slice().reverse(),
      tarefasPendentes: pendentesHoje,
    });
  }

  if (recurso === "visitas") {
    if (metodo === "GET") {
      const dias = Math.min(180, Math.max(1, Number(url.searchParams.get("dias")) || 30));
      const hoje = dataLisboa();
      const datas = Array.from({ length: dias }, (_, i) => somarDias(hoje, -i));
      const visitas = (await Promise.all(datas.map((d) => listarPrefixo(env, `eq:visita:${d}:`)))).flat();
      visitas.sort((a, b) => b.inicio.localeCompare(a.inicio));
      return json({ visitas, locais: locais.porId });
    }
    if (metodo === "DELETE") {
      const id = url.searchParams.get("id") || "";
      if (!VISITA_ID.test(id)) return json({ error: "Falta o id" }, 400);
      const v = await lerJSON(env, `eq:visita:${id}`);
      await env.HISTORY_KV.delete(`eq:visita:${id}`);
      if (v && !v.fim) await env.HISTORY_KV.delete(`eq:aberta:${v.utilizador}`);
      return json({ ok: true });
    }
  }

  return json({ error: "Pedido desconhecido" }, 404);
}
