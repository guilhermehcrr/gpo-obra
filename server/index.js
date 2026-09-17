/**
 * Servidor do GPO Obra.
 *
 * Node puro, sem dependências: serve a interface em public/ e expõe a API em /api.
 * Porta e banco vêm do ambiente (ver .env.example).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { banco } = require("./store");

const RAIZ = path.join(__dirname, "..");
const PUBLICO = path.join(RAIZ, "public");
const PORTA = Number(process.env.PORT || 3000);

/* carrega .env se existir, sem biblioteca */
(function carregarEnv() {
  const arq = path.join(RAIZ, ".env");
  if (!fs.existsSync(arq)) return;
  for (const linha of fs.readFileSync(arq, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const bd = banco();

/* ------------------------------------------------------------------- senhas */
function criarHash(senha) {
  const sal = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(senha, sal, 32).toString("hex");
  return "scrypt$" + sal + "$" + h;
}
function conferirSenha(senha, guardado) {
  if (!guardado) return false;
  const p = String(guardado).split("$");
  if (p.length !== 3 || p[0] !== "scrypt") return false;
  const calc = crypto.scryptSync(senha, p[1], 32);
  const esperado = Buffer.from(p[2], "hex");
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

/* ------------------------------------------------------------------ sessões */
const sessoes = new Map();
const VALIDADE = 12 * 60 * 60 * 1000;
function abrirSessao(u) {
  const t = crypto.randomBytes(24).toString("hex");
  sessoes.set(t, { id: u._id, login: u.login, nome: u.nome, perfil: u.perfil, expira: Date.now() + VALIDADE });
  return t;
}
function sessaoDe(req) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const s = sessoes.get(t);
  if (!s) return null;
  if (s.expira < Date.now()) { sessoes.delete(t); return null; }
  return s;
}
const PERMS = {
  admin: ["cad.ler","cad.edit","norm.ler","norm.edit","obra.ler","obra.edit","user.ler","user.edit","log.ler"],
  engenharia: ["cad.ler","cad.edit","norm.ler","norm.edit","obra.ler","log.ler"],
  projetista: ["cad.ler","norm.ler","obra.ler","obra.edit"],
  consulta: ["cad.ler","norm.ler","obra.ler"],
};
const pode = (s, p) => !!s && (PERMS[s.perfil] || []).includes(p);

/* -------------------------------------------------------------------- HTTP */
const TIPOS = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".js":"application/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".png":"image/png", ".woff2":"font/woff2" };

function json(res, codigo, corpo) {
  const b = Buffer.from(JSON.stringify(corpo));
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length });
  res.end(b);
}
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 8e6) { falha(new Error("corpo grande demais")); req.destroy(); } });
    req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { falha(e); } });
  });
}
function semHash(u) { const c = Object.assign({}, u); delete c.hash; return c; }
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const rec = p[0] || "";
  const id = p[1] ? decodeURIComponent(p[1]) : null;
  const m = req.method;
  const s = sessaoDe(req);

  if (rec === "estado" && m === "GET") {
    const usuarios = await bd.lerUsuarios();
    if (!s) {
      return json(res, 200, { catalogos: {}, obras: [], usuarios: [],
        precisaPrimeiroAcesso: usuarios.length === 0, sessao: null });
    }
    const [catalogos, obras] = await Promise.all([bd.lerCatalogos(), bd.lerObras()]);
    return json(res, 200, {
      catalogos,
      obras,
      usuarios: pode(s, "user.ler") ? usuarios.map(semHash) : [],
      totalUsuarios: usuarios.length,
      precisaPrimeiroAcesso: false,
      sessao: { id: s.id, login: s.login, nome: s.nome, perfil: s.perfil },
    });
  }

  if (rec === "primeiro-acesso" && m === "POST") {
    const us = await bd.lerUsuarios();
    if (us.length) return json(res, 409, { erro: "Já existe usuário cadastrado." });
    const b = await lerCorpo(req);
    if (!b.nome || !b.login || !b.senha || b.senha.length < 6)
      return json(res, 400, { erro: "Informe nome, usuário e senha de pelo menos 6 caracteres." });
    const u = { _id: uid(), login: String(b.login).trim().toLowerCase(), nome: String(b.nome).trim(),
      perfil: "admin", hash: criarHash(b.senha), ativo: true, criadoEm: new Date().toISOString() };
    await bd.gravarUsuario(u);
    await bd.gravarRegistro({ login: u.login, quem: u.nome, perfil: u.perfil, acao: "Criou o primeiro acesso", detalhe: u.nome });
    return json(res, 200, { token: abrirSessao(u), usuario: semHash(u) });
  }

  if (rec === "login" && m === "POST") {
    const b = await lerCorpo(req);
    const us = await bd.lerUsuarios();
    const u = us.find((x) => x.login === String(b.login || "").trim().toLowerCase());
    if (!u || u.ativo === false || !conferirSenha(b.senha || "", u.hash))
      return json(res, 401, { erro: "Usuário ou senha não conferem." });
    await bd.gravarRegistro({ login: u.login, quem: u.nome, perfil: u.perfil, acao: "Entrou no sistema" });
    return json(res, 200, { token: abrirSessao(u), usuario: semHash(u) });
  }

  if (!s) return json(res, 401, { erro: "Sessão expirada." });

  if (rec === "sair" && m === "POST") {
    const h = req.headers.authorization || "";
    sessoes.delete(h.startsWith("Bearer ") ? h.slice(7) : "");
    await bd.gravarRegistro({ login: s.login, quem: s.nome, perfil: s.perfil, acao: "Saiu do sistema" });
    return json(res, 200, { ok: true });
  }

  if (rec === "catalogo" && m === "PUT") {
    const NORMATIVAS = ["normas", "padroes", "especificacoes", "fornecedores_aprovados", "ged", "ged3738", "cintas", "cabos"];
    const perm = NORMATIVAS.includes(id) ? "norm.edit" : "cad.edit";
    if (!pode(s, perm)) return json(res, 403, { erro: "Sem permissão." });
    await bd.gravarCatalogo(id, await lerCorpo(req));
    await bd.gravarRegistro({ login: s.login, quem: s.nome, perfil: s.perfil, acao: "Alterou cadastro", alvo: id });
    return json(res, 200, { ok: true });
  }

  if (rec === "obras") {
    if (m === "PUT") {
      if (!pode(s, "obra.edit")) return json(res, 403, { erro: "Sem permissão." });
      const o = await lerCorpo(req);
      o._id = id || o._id || uid();
      o.atualizadoEm = new Date().toISOString();
      o.atualizadoPor = s.nome;
      await bd.gravarObra(o);
      return json(res, 200, o);
    }
    if (m === "DELETE") {
      if (!pode(s, "obra.edit")) return json(res, 403, { erro: "Sem permissão." });
      await bd.excluirObra(id);
      return json(res, 200, { ok: true });
    }
  }

  if (rec === "usuarios") {
    if (!pode(s, "user.edit")) return json(res, 403, { erro: "Sem permissão." });
    if (m === "PUT") {
      const b = await lerCorpo(req);
      const us = await bd.lerUsuarios();
      if (us.length >= 5 && !us.some((x) => x._id === id))
        return json(res, 409, { erro: "Limite de 5 usuários atingido." });
      const login = String(b.login || "").trim().toLowerCase();
      if (us.some((x) => x.login === login && x._id !== id))
        return json(res, 409, { erro: "Já existe um usuário com esse login." });
      const atual = us.find((x) => x._id === id);
      const u = {
        _id: id || uid(), login, nome: String(b.nome || "").trim(), perfil: b.perfil || "consulta",
        ativo: b.ativo !== false, criadoEm: (atual && atual.criadoEm) || new Date().toISOString(),
        hash: b.senha ? criarHash(b.senha) : (atual && atual.hash),
      };
      if (!u.hash) return json(res, 400, { erro: "Defina uma senha para o novo usuário." });
      await bd.gravarUsuario(u);
      await bd.gravarRegistro({ login: s.login, quem: s.nome, perfil: s.perfil,
        acao: atual ? "Alterou usuário" : "Criou usuário", alvo: u._id, detalhe: u.nome + " · " + u.perfil });
      return json(res, 200, semHash(u));
    }
    if (m === "DELETE") {
      if (id === s.id) return json(res, 409, { erro: "Não é possível excluir o próprio acesso." });
      await bd.excluirUsuario(id);
      await bd.gravarRegistro({ login: s.login, quem: s.nome, perfil: s.perfil, acao: "Excluiu usuário", alvo: id });
      return json(res, 200, { ok: true });
    }
  }

  if (rec === "registro") {
    if (m === "GET") {
      if (!pode(s, "log.ler")) return json(res, 403, { erro: "Sem permissão." });
      return json(res, 200, await bd.lerRegistro(200));
    }
    if (m === "POST") {
      const b = await lerCorpo(req);
      await bd.gravarRegistro({ login: s.login, quem: s.nome, perfil: s.perfil,
        acao: b.acao, alvo: b.alvo, detalhe: b.detalhe });
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { erro: "Rota não encontrada." });
}

function estatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const arq = path.join(PUBLICO, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!arq.startsWith(PUBLICO) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Não encontrado");
  }
  const tipo = TIPOS[path.extname(arq).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": tipo, "Cache-Control": "no-cache" });
  fs.createReadStream(arq).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  try {
    if (url.pathname.startsWith("/api")) return await api(req, res, url);
    return estatico(req, res, url);
  } catch (e) {
    console.error("[gpo]", e);
    json(res, 500, { erro: "Erro interno: " + e.message });
  }
}).listen(PORTA, () => {
  console.log("[gpo] GPO Obra em http://localhost:" + PORTA);
});
