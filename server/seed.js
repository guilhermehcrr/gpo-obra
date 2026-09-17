/**
 * Carga inicial dos cadastros.
 *
 *   npm run seed
 *
 * Lê os arquivos de data/ e grava no banco configurado. Roda quantas vezes for
 * preciso: cada chave é substituída, nada é duplicado. Use --forcar para
 * sobrescrever cadastros que já tenham sido editados dentro do sistema.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { banco } = require("./store");

const RAIZ = path.join(__dirname, "..");

(function carregarEnv() {
  const arq = path.join(RAIZ, ".env");
  if (!fs.existsSync(arq)) return;
  for (const linha of fs.readFileSync(arq, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const forcar = process.argv.includes("--forcar");

(async function () {
  const bd = banco();
  const dir = path.join(RAIZ, "data");
  const existentes = await bd.lerCatalogos();
  let gravados = 0, pulados = 0, total = 0;

  for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const chave = path.basename(arq, ".json");
    const corpo = JSON.parse(fs.readFileSync(path.join(dir, arq), "utf8"));
    const qtd = Array.isArray(corpo.items) ? corpo.items.length : 0;
    total += qtd;

    if (existentes[chave] && !forcar) {
      console.log(`  · ${chave.padEnd(24)} já existe, mantido (${qtd} registros no arquivo)`);
      pulados++;
      continue;
    }
    await bd.gravarCatalogo(chave, corpo);
    console.log(`  ✓ ${chave.padEnd(24)} ${String(qtd).padStart(5)} registros`);
    gravados++;
  }

  console.log(`\n[gpo] ${gravados} cadastro(s) gravado(s), ${pulados} mantido(s). ${total} registros no total.`);
  if (pulados && !forcar) console.log("[gpo] Use 'npm run seed -- --forcar' para sobrescrever os mantidos.");
})().catch((e) => {
  console.error("[gpo] falha na carga:", e.message);
  process.exit(1);
});
