/**
 * Camada de dados do GPO Obra.
 *
 * Dois drivers com a mesma interface:
 *
 *   local     SQLite embutido no Node (node:sqlite, Node 22.5+) ou, se não houver,
 *             um arquivo JSON. Serve para rodar e testar sem depender de rede.
 *
 *   supabase  PostgreSQL do Supabase, acessado pela API REST (PostgREST) com fetch.
 *             Sem biblioteca externa. Ativado quando GPO_DB=supabase.
 *
 * Toda a interface é assíncrona, então trocar de driver não muda mais nada
 * no resto do sistema.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..");
const agora = () => new Date().toISOString();

/* ============================================================ driver: SQLite */
function driverSqlite(dir) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch (e) { return null; }

  const arquivo = path.join(dir, "gpo.db");
  let bd;
  try { bd = new DatabaseSync(arquivo); } catch (e) { return null; }

  bd.exec(`
    CREATE TABLE IF NOT EXISTS catalogo (
      chave TEXT PRIMARY KEY, corpo TEXT NOT NULL, atualizado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS obra (
      id TEXT PRIMARY KEY, corpo TEXT NOT NULL, atualizado_em TEXT NOT NULL, atualizado_por TEXT);
    CREATE TABLE IF NOT EXISTS usuario (
      id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, nome TEXT NOT NULL, perfil TEXT NOT NULL,
      hash TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registro (
      id INTEGER PRIMARY KEY AUTOINCREMENT, quando TEXT NOT NULL, login TEXT, quem TEXT,
      perfil TEXT, acao TEXT NOT NULL, alvo TEXT, detalhe TEXT);
    CREATE INDEX IF NOT EXISTS idx_registro_quando ON registro (quando DESC);
  `);

  return {
    tipo: "sqlite", onde: arquivo,
    async lerCatalogos() {
      const o = {};
      for (const l of bd.prepare("SELECT chave, corpo FROM catalogo").all()) o[l.chave] = JSON.parse(l.corpo);
      return o;
    },
    async gravarCatalogo(chave, corpo) {
      bd.prepare("INSERT INTO catalogo (chave, corpo, atualizado_em) VALUES (?, ?, ?) " +
        "ON CONFLICT(chave) DO UPDATE SET corpo = excluded.corpo, atualizado_em = excluded.atualizado_em")
        .run(chave, JSON.stringify(corpo), agora());
    },
    async lerObras() {
      return bd.prepare("SELECT id, corpo FROM obra").all()
        .map((l) => Object.assign(JSON.parse(l.corpo), { _id: l.id }));
    },
    async gravarObra(obra) {
      const c = Object.assign({}, obra); delete c._id;
      bd.prepare("INSERT INTO obra (id, corpo, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET corpo = excluded.corpo, atualizado_em = excluded.atualizado_em, " +
        "atualizado_por = excluded.atualizado_por")
        .run(obra._id, JSON.stringify(c), agora(), c.atualizadoPor || null);
    },
    async excluirObra(id) { bd.prepare("DELETE FROM obra WHERE id = ?").run(id); },
    async lerUsuarios() {
      return bd.prepare("SELECT * FROM usuario ORDER BY criado_em").all().map((l) => ({
        _id: l.id, login: l.login, nome: l.nome, perfil: l.perfil,
        hash: l.hash, ativo: l.ativo === 1, criadoEm: l.criado_em }));
    },
    async gravarUsuario(u) {
      bd.prepare("INSERT INTO usuario (id, login, nome, perfil, hash, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET login = excluded.login, nome = excluded.nome, perfil = excluded.perfil, " +
        "hash = excluded.hash, ativo = excluded.ativo")
        .run(u._id, u.login, u.nome, u.perfil, u.hash, u.ativo === false ? 0 : 1, u.criadoEm || agora());
    },
    async excluirUsuario(id) { bd.prepare("DELETE FROM usuario WHERE id = ?").run(id); },
    async lerRegistro(limite) { return bd.prepare("SELECT * FROM registro ORDER BY quando DESC LIMIT ?").all(limite || 200); },
    async gravarRegistro(r) {
      bd.prepare("INSERT INTO registro (quando, login, quem, perfil, acao, alvo, detalhe) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(r.quando || agora(), r.login || null, r.quem || null, r.perfil || null, r.acao, r.alvo || null, r.detalhe || null);
    },
  };
}

/* ======================================================= driver: arquivo JSON */
function driverJson(dir) {
  const arquivo = path.join(dir, "gpo.json");
  const vazio = { catalogo: {}, obra: {}, usuario: {}, registro: [] };
  let d = vazio;
  if (fs.existsSync(arquivo)) {
    try { d = Object.assign({}, vazio, JSON.parse(fs.readFileSync(arquivo, "utf8"))); } catch (e) {}
  }
  let t = null;
  const gravar = () => { clearTimeout(t); t = setTimeout(() => fs.writeFileSync(arquivo, JSON.stringify(d)), 40); };

  return {
    tipo: "json", onde: arquivo,
    async lerCatalogos() { return d.catalogo; },
    async gravarCatalogo(chave, corpo) { d.catalogo[chave] = corpo; gravar(); },
    async lerObras() { return Object.keys(d.obra).map((id) => Object.assign({}, d.obra[id], { _id: id })); },
    async gravarObra(o) { const c = Object.assign({}, o); delete c._id; d.obra[o._id] = c; gravar(); },
    async excluirObra(id) { delete d.obra[id]; gravar(); },
    async lerUsuarios() { return Object.keys(d.usuario).map((id) => Object.assign({}, d.usuario[id], { _id: id })); },
    async gravarUsuario(u) { const c = Object.assign({}, u); delete c._id; c.criadoEm = c.criadoEm || agora(); d.usuario[u._id] = c; gravar(); },
    async excluirUsuario(id) { delete d.usuario[id]; gravar(); },
    async lerRegistro(limite) { return d.registro.slice(0, limite || 200); },
    async gravarRegistro(r) { d.registro.unshift(Object.assign({ quando: agora() }, r)); d.registro = d.registro.slice(0, 2000); gravar(); },
  };
}

/* ========================================================== driver: Supabase */
function driverSupabase() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  // Chave nova (sb_secret_...) ou a antiga service_role, que sai de circulacao no fim de 2026.
  const chave = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || "";
  if (!url || !chave) {
    throw new Error("GPO_DB=supabase exige SUPABASE_URL e SUPABASE_SECRET_KEY no .env");
  }
  const base = url + "/rest/v1/";
  const cab = {
    apikey: chave,
    Authorization: "Bearer " + chave,
    "Content-Type": "application/json",
    // A chave secreta e recusada quando a requisicao parece vir de um navegador.
    "User-Agent": "gpo-obra/1.0 (node)",
  };

  async function req(caminho, opcoes) {
    const r = await fetch(base + caminho, Object.assign({ headers: cab }, opcoes || {}));
    if (!r.ok) throw new Error("Supabase " + r.status + ": " + (await r.text()).slice(0, 300));
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }
  const upsert = (tabela, linha) =>
    req(tabela, { method: "POST", headers: Object.assign({}, cab, { Prefer: "resolution=merge-duplicates" }), body: JSON.stringify(linha) });

  return {
    tipo: "supabase", onde: url,
    async lerCatalogos() {
      const linhas = await req("catalogo?select=chave,corpo");
      const o = {};
      (linhas || []).forEach((l) => { o[l.chave] = l.corpo; });
      return o;
    },
    async gravarCatalogo(chave, corpo) { await upsert("catalogo", { chave, corpo, atualizado_em: agora() }); },
    async lerObras() {
      const linhas = await req("obra?select=id,corpo");
      return (linhas || []).map((l) => Object.assign({}, l.corpo, { _id: l.id }));
    },
    async gravarObra(obra) {
      const c = Object.assign({}, obra); delete c._id;
      await upsert("obra", { id: obra._id, corpo: c, atualizado_em: agora(), atualizado_por: c.atualizadoPor || null });
    },
    async excluirObra(id) { await req("obra?id=eq." + encodeURIComponent(id), { method: "DELETE" }); },
    async lerUsuarios() {
      const linhas = await req("usuario?select=*&order=criado_em.asc");
      return (linhas || []).map((l) => ({
        _id: l.id, login: l.login, nome: l.nome, perfil: l.perfil,
        hash: l.hash, ativo: l.ativo !== false, criadoEm: l.criado_em }));
    },
    async gravarUsuario(u) {
      await upsert("usuario", { id: u._id, login: u.login, nome: u.nome, perfil: u.perfil,
        hash: u.hash, ativo: u.ativo !== false, criado_em: u.criadoEm || agora() });
    },
    async excluirUsuario(id) { await req("usuario?id=eq." + encodeURIComponent(id), { method: "DELETE" }); },
    async lerRegistro(limite) { return (await req("registro?select=*&order=quando.desc&limit=" + (limite || 200))) || []; },
    async gravarRegistro(r) {
      await req("registro", { method: "POST", body: JSON.stringify({
        quando: r.quando || agora(), login: r.login || null, quem: r.quem || null,
        perfil: r.perfil || null, acao: r.acao, alvo: r.alvo || null, detalhe: r.detalhe || null }) });
    },
  };
}

/* ------------------------------------------------------------------ escolha */
let motor = null;
function banco() {
  if (motor) return motor;
  const escolha = (process.env.GPO_DB || "local").toLowerCase();

  if (escolha === "supabase") {
    motor = driverSupabase();
    console.log("[gpo] banco: Supabase em " + motor.onde);
    return motor;
  }

  const dir = process.env.GPO_DB_DIR || path.join(RAIZ, "banco");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  motor = driverSqlite(dir) || driverJson(dir);
  console.log("[gpo] banco: " + motor.tipo + " em " + motor.onde);
  if (motor.tipo === "json") console.log("[gpo] node:sqlite indisponível nesta versão do Node; usando arquivo JSON.");
  return motor;
}

module.exports = { banco };