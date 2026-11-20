// ===== Dashboard de demonstração (mpvending.pt/demo) =====
// Acessos temporários para potenciais clientes, geridos no admin (separador "Acessos Demo").
// Tudo fica na mesma KV (HISTORY_KV), com expiração automática:
//   demo:user:<utilizador>   → { nome, hash, salt, criadoEm, expiraEm, ultimoAcesso, nAcessos }
//   demo:sessao:<token>      → { utilizador, expiraEm }
//   demo:falhas:<ip>         → nº de tentativas falhadas (bloqueia ao fim de 10, durante 15 min)
// Os dados mostrados na demo são 100% fictícios e gerados no browser — a demo nunca toca nos dados reais.

const COOKIE = "mpv_demo";
const SESSAO_MAX_S = 60 * 60 * 12; // uma sessão dura no máximo 12h (ou até o acesso expirar)
const PBKDF2_ITER = 100000;
const MAX_FALHAS = 10;

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

function igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function lerCookie(request, nome) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]+)"));
  return m ? m[1] : null;
}

const normUser = (u) => String(u || "").trim().toLowerCase();
const USER_VALIDO = /^[a-z0-9._-]{3,40}$/;

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
}

function redirect(location, extra = {}) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

// serve um ficheiro estático da pasta demo/ sem passar pelo controlo de acesso
async function servirAsset(request, env, caminho) {
  const url = new URL(request.url);
  let res = await env.ASSETS.fetch(new Request(url.origin + caminho, { headers: request.headers }));
  if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
    res = await env.ASSETS.fetch(new Request(new URL(res.headers.get("Location"), url.origin), { headers: request.headers }));
  }
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(res.body, { status: res.status, headers: h });
}

async function sessaoValida(request, env) {
  const token = lerCookie(request, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const raw = await env.HISTORY_KV.get(`demo:sessao:${token}`);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.expiraEm) return null;
  // se o acesso foi apagado ou expirou no admin, a sessão deixa de valer logo
  const userRaw = await env.HISTORY_KV.get(`demo:user:${s.utilizador}`);
  if (!userRaw) return null;
  const u = JSON.parse(userRaw);
  if (Date.now() > u.expiraEm) return null;
  return { token, utilizador: s.utilizador, nome: u.nome || s.utilizador, acessoExpiraEm: u.expiraEm };
}

async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const chaveFalhas = `demo:falhas:${ip}`;
  const falhas = parseInt((await env.HISTORY_KV.get(chaveFalhas)) || "0", 10);
  if (falhas >= MAX_FALHAS) return redirect("/demo/?erro=bloqueado");

  let utilizador = "", password = "";
  const tipo = request.headers.get("Content-Type") || "";
  if (tipo.includes("application/json")) {
    const b = await request.json().catch(() => ({}));
    utilizador = b.utilizador; password = b.password;
  } else {
    const f = await request.formData();
    utilizador = f.get("utilizador"); password = f.get("password");
  }
  utilizador = normUser(utilizador);
  password = String(password || "");

  const falhou = async (motivo) => {
    await env.HISTORY_KV.put(chaveFalhas, String(falhas + 1), { expirationTtl: 900 });
    return redirect(`/demo/?erro=${motivo}`);
  };

  if (!USER_VALIDO.test(utilizador) || !password) return falhou("credenciais");
  const raw = await env.HISTORY_KV.get(`demo:user:${utilizador}`);
  if (!raw) return falhou("credenciais");
  const u = JSON.parse(raw);
  if (Date.now() > u.expiraEm) return redirect("/demo/?erro=expirado");
  const { hash } = await hashPassword(password, u.salt);
  if (!igualSeguro(hash, u.hash)) return falhou("credenciais");

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const restanteS = Math.floor((u.expiraEm - Date.now()) / 1000);
  const duracao = Math.max(60, Math.min(SESSAO_MAX_S, restanteS));
  await env.HISTORY_KV.put(`demo:sessao:${token}`, JSON.stringify({ utilizador, expiraEm: Date.now() + duracao * 1000 }), { expirationTtl: duracao });

  // regista o acesso (útil para saber se o cliente abriu a demo)
  if (restanteS > 120) {
    u.ultimoAcesso = new Date().toISOString();
    u.nAcessos = (u.nAcessos || 0) + 1;
    await env.HISTORY_KV.put(`demo:user:${utilizador}`, JSON.stringify(u), { expiration: Math.floor(u.expiraEm / 1000) });
  }
  if (falhas) await env.HISTORY_KV.delete(chaveFalhas);

  return redirect("/demo/", {
    "Set-Cookie": `${COOKIE}=${token}; Path=/demo; Max-Age=${duracao}; HttpOnly; Secure; SameSite=Lax`,
  });
}

// Rotas públicas /demo/* — devolve uma Response, ou null se o caminho não for da demo
export async function handleDemo(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  if (p !== "/demo" && !p.startsWith("/demo/")) return null;

  // o cookie da sessão só vale para /demo em minúsculas (ex: quem escreve /Demo é encaminhado)
  if (p === "/demo" || (url.pathname !== p && request.method === "GET")) return redirect(p === "/demo" ? "/demo/" : p + url.search);

  if (p === "/demo/entrar" && request.method === "POST") return handleLogin(request, env);

  if (p === "/demo/sair") {
    const token = lerCookie(request, COOKIE);
    if (token && /^[a-f0-9]{64}$/.test(token)) await env.HISTORY_KV.delete(`demo:sessao:${token}`);
    return redirect("/demo/", { "Set-Cookie": `${COOKIE}=; Path=/demo; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  const sessao = await sessaoValida(request, env);

  if (p === "/demo/sessao") {
    if (!sessao) return json({ error: "sem sessão" }, 401);
    return json({ nome: sessao.nome, utilizador: sessao.utilizador, acessoExpiraEm: sessao.acessoExpiraEm });
  }

  if (!sessao) return servirAsset(request, env, "/demo/entrar.html");
  if (p === "/demo/" || p === "/demo/index.html") return servirAsset(request, env, "/demo/index.html");
  if (p === "/demo/entrar.html") return redirect("/demo/");
  return servirAsset(request, env, url.pathname);
}

// API do admin (já protegida pela password do admin): /api/demo-acessos
export async function handleDemoAcessos(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const lista = [];
    let cursor;
    do {
      const listed = await env.HISTORY_KV.list({ prefix: "demo:user:", cursor });
      for (const key of listed.keys) {
        const raw = await env.HISTORY_KV.get(key.name);
        if (!raw) continue;
        const u = JSON.parse(raw);
        lista.push({ utilizador: key.name.slice("demo:user:".length), nome: u.nome, criadoEm: u.criadoEm, expiraEm: u.expiraEm, ultimoAcesso: u.ultimoAcesso || null, nAcessos: u.nAcessos || 0 });
      }
      cursor = listed.list_complete ? null : listed.cursor;
    } while (cursor);
    lista.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
    return json({ acessos: lista });
  }

  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const utilizador = normUser(b.utilizador);
    const password = String(b.password || "");
    const dias = Number(b.dias);
    const nome = String(b.nome || "").trim().slice(0, 80);
    if (!USER_VALIDO.test(utilizador)) return json({ error: "Utilizador inválido: 3 a 40 caracteres, só letras, números, ponto, hífen ou _." }, 400);
    if (password.length < 6) return json({ error: "A password tem de ter pelo menos 6 caracteres." }, 400);
    if (!(dias >= 1 && dias <= 90)) return json({ error: "A validade tem de ser entre 1 e 90 dias." }, 400);
    if (await env.HISTORY_KV.get(`demo:user:${utilizador}`) && !b.substituir) return json({ error: "Já existe um acesso com esse utilizador." }, 409);
    const { hash, salt } = await hashPassword(password);
    const expiraEm = Date.now() + dias * 86400000;
    const registo = { nome: nome || utilizador, hash, salt, criadoEm: new Date().toISOString(), expiraEm, nAcessos: 0 };
    await env.HISTORY_KV.put(`demo:user:${utilizador}`, JSON.stringify(registo), { expirationTtl: dias * 86400 });
    return json({ ok: true, utilizador, expiraEm });
  }

  if (request.method === "PATCH") {
    // prolongar: { utilizador, dias } → nova validade a contar de agora
    const b = await request.json().catch(() => ({}));
    const utilizador = normUser(b.utilizador);
    const dias = Number(b.dias);
    if (!(dias >= 1 && dias <= 90)) return json({ error: "A validade tem de ser entre 1 e 90 dias." }, 400);
    const raw = await env.HISTORY_KV.get(`demo:user:${utilizador}`);
    if (!raw) return json({ error: "Acesso não encontrado (pode já ter expirado)." }, 404);
    const u = JSON.parse(raw);
    u.expiraEm = Date.now() + dias * 86400000;
    await env.HISTORY_KV.put(`demo:user:${utilizador}`, JSON.stringify(u), { expirationTtl: dias * 86400 });
    return json({ ok: true, expiraEm: u.expiraEm });
  }

  if (request.method === "DELETE") {
    const utilizador = normUser(url.searchParams.get("utilizador"));
    await env.HISTORY_KV.delete(`demo:user:${utilizador}`);
    return json({ ok: true });
  }

  return new Response("Método não suportado", { status: 405 });
}
