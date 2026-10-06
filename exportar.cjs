/* =====================================================================
   EXPORTAR CATÁLOGO PARA A CLOUDFLARE PAGES
   Roda logo depois do robô de verificação, no GitHub Actions.

   O que faz:
   - Gera "catalogo.json" com todas as obras públicas (sem as imagens dentro)
     e uma imagem por capa em "capas/<id>-<hash>.<ext>".
   - Publica tudo num projeto da Cloudflare Pages (arquivos estáticos: grátis e ilimitados).
   - O app baixa o catálogo de lá e só pede ao Firestore as obras alteradas depois disso.

   Para economizar leituras e publicações:
   - publica no máximo a cada INTERVALO_HORAS e só se algo mudou;
   - lê do Firestore só as obras alteradas desde a última publicação
     (as demais vêm do catálogo que já está no ar);
   - uma vez por semana refaz tudo do zero, por segurança.

   Segredos/variáveis necessários no GitHub:
   - FIREBASE_SERVICE_ACCOUNT (já existe)
   - CLOUDFLARE_API_TOKEN  (permissão "Cloudflare Pages: Edit")
   - CLOUDFLARE_ACCOUNT_ID
   - CATALOGO_PROJETO      (nome do projeto na Pages, ex.: savepoint-catalogo)
   - CATALOGO_URL          (endereço do projeto, ex.: https://savepoint-catalogo.pages.dev)
   ===================================================================== */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const INTERVALO_HORAS = Number(process.env.CATALOGO_INTERVALO_HORAS || 3);
const SEMANA = 7 * 24 * 3600e3;
const FOLGA = 10 * 60e3;   // 10 min de folga nas datas
const forcar = process.env.CATALOGO_FORCAR === "1";

const faltando = ["FIREBASE_SERVICE_ACCOUNT", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CATALOGO_PROJETO", "CATALOGO_URL"]
  .filter(k => !process.env[k]);
if (faltando.length) {
  console.log(`Exportação do catálogo desligada (faltam: ${faltando.join(", ")}).`);
  process.exit(0);
}
const BASE = process.env.CATALOGO_URL.replace(/\/+$/, "");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const ms = (t) => (t && typeof t.toMillis === "function") ? t.toMillis() : (typeof t === "number" ? t : null);
const SAIDA = path.join(__dirname, "dist-catalogo");

// Converte uma obra do Firestore para o formato do arquivo (sem a imagem dentro)
function paraArquivo(id, d, capaArq) {
  const o = {
    id, categoria: d.categoria, nome: d.nome, nomeOrdem: d.nomeOrdem, outrosNomes: d.outrosNomes || [],
    chaves: d.chaves || [], generos: d.generos || [], tipo: d.tipo || "", ano: d.ano ?? null,
    episodios: d.episodios || [], emLancamento: d.emLancamento === true,
    visibilidade: "publica", conteudoAdulto: d.conteudoAdulto === true,
    verificacao: d.verificacao ? { status: d.verificacao.status || null, origem: d.verificacao.origem || null } : null,
    criadoPor: d.criadoPor || null, criadoPorNome: d.criadoPorNome || "",
    criadoEm: ms(d.criadoEm), atualizadoEm: ms(d.atualizadoEm), capaArq: capaArq || null
  };
  if (d.capitulosVolumes) o.capitulosVolumes = d.capitulosVolumes;
  if (d.temporadas === true) o.temporadas = true;
  if (Array.isArray(d.plataformas) && d.plataformas.length) o.plataformas = d.plataformas;
  if (typeof d.trailer === "string" && /^[A-Za-z0-9_-]{11}$/.test(d.trailer)) o.trailer = d.trailer;
  return o;
}
// Capa em base64 -> arquivo de imagem com nome que muda quando a imagem muda (o navegador guarda para sempre)
function salvarCapa(id, capa) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(capa || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const nome = `capas/${id}-${crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10)}.${ext}`;
  fs.writeFileSync(path.join(SAIDA, nome), buf);
  return nome;
}
async function baixar(url) {
  const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r;
}

(async () => {
  const refEstado = db.doc("sistema/exportacao");
  const estado = (await refEstado.get()).data() || {};
  const agora = Date.now();
  if (!forcar && estado.ultima && agora - estado.ultima < INTERVALO_HORAS * 3600e3) {
    console.log(`Catálogo publicado há menos de ${INTERVALO_HORAS} h. Nada a fazer.`);
    return;
  }
  const completo = forcar || !estado.ate || !estado.ultimaCompleta || agora - estado.ultimaCompleta > SEMANA;

  // Houve mudança desde a última publicação?
  const removidosDoc = (await db.doc("sistema/catalogo").get()).data() || {};
  const removidos = new Set(removidosDoc.removidos || []);
  const removidosEm = ms(removidosDoc.atualizadoEm) || 0;
  if (!completo) {
    const mudou = await db.collection("obras").where("visibilidade", "==", "publica")
      .where("atualizadoEm", ">", admin.firestore.Timestamp.fromMillis(estado.ate)).limit(1).get();
    if (mudou.empty && removidosEm <= (estado.ultima || 0)) {
      console.log("Nenhuma obra mudou desde a última publicação.");
      await refEstado.set({ ...estado, ultima: agora }, { merge: true });   // conta como verificada
      return;
    }
  }

  fs.rmSync(SAIDA, { recursive: true, force: true });
  fs.mkdirSync(path.join(SAIDA, "capas"), { recursive: true });
  const obras = new Map();
  let maxAte = estado.ate || 0;

  if (!completo) {
    // 1) parte do catálogo que já está no ar (download grátis da própria Cloudflare)
    try {
      const atual = await (await baixar(`${BASE}/catalogo.json`)).json();
      for (const o of atual.obras || []) obras.set(o.id, o);
      // as capas também precisam ir na nova publicação
      for (const o of obras.values()) {
        if (!o.capaArq) continue;
        try { fs.writeFileSync(path.join(SAIDA, o.capaArq), Buffer.from(await (await baixar(`${BASE}/${o.capaArq}`)).arrayBuffer())); }
        catch { o.capaArq = null; }   // se falhar, a capa volta na próxima publicação completa
      }
    } catch (e) {
      console.log("Não deu para ler o catálogo no ar; vou refazer tudo:", e.message);
      return refazerTudo();
    }
    // 2) só as obras alteradas desde a última publicação
    const snap = await db.collection("obras").where("visibilidade", "==", "publica")
      .where("atualizadoEm", ">", admin.firestore.Timestamp.fromMillis(Math.max(0, estado.ate - FOLGA))).get();
    snap.forEach(doc => {
      const d = doc.data();
      const antigo = obras.get(doc.id);
      if (antigo?.capaArq) { try { fs.unlinkSync(path.join(SAIDA, antigo.capaArq)); } catch {} }
      obras.set(doc.id, paraArquivo(doc.id, d, salvarCapa(doc.id, d.capa)));
      maxAte = Math.max(maxAte, ms(d.atualizadoEm) || 0);
    });
    console.log(`Atualização parcial: ${snap.size} obra(s) alterada(s) lida(s) do Firestore.`);
  } else {
    return refazerTudo();
  }
  await publicar();

  async function refazerTudo() {
    obras.clear();
    fs.rmSync(SAIDA, { recursive: true, force: true });
    fs.mkdirSync(path.join(SAIDA, "capas"), { recursive: true });
    const snap = await db.collection("obras").where("visibilidade", "==", "publica").get();
    snap.forEach(doc => {
      const d = doc.data();
      obras.set(doc.id, paraArquivo(doc.id, d, salvarCapa(doc.id, d.capa)));
      maxAte = Math.max(maxAte, ms(d.atualizadoEm) || 0);
    });
    console.log(`Publicação completa: ${snap.size} obra(s).`);
    await publicar(true);
  }

  async function publicar(foiCompleta = false) {
    for (const id of removidos) obras.delete(id);
    const lista = [...obras.values()].sort((a, b) => (a.nomeOrdem || "").localeCompare(b.nomeOrdem || ""));
    fs.writeFileSync(path.join(SAIDA, "catalogo.json"), JSON.stringify({ versao: 1, geradoEm: maxAte, publicadoEm: agora, obras: lista }));
    // cabeçalhos: o app (outro domínio) pode ler; o JSON é sempre conferido; as capas ficam guardadas
    fs.writeFileSync(path.join(SAIDA, "_headers"), [
      "/*", "  Access-Control-Allow-Origin: *", "  X-Content-Type-Options: nosniff",
      "/catalogo.json", "  Cache-Control: no-cache",
      "/capas/*", "  Cache-Control: public, max-age=31536000, immutable", ""
    ].join("\n"));
    console.log(`Publicando ${lista.length} obra(s) na Cloudflare Pages…`);
    execFileSync("npx", ["--yes", "wrangler@3", "pages", "deploy", SAIDA,
      `--project-name=${process.env.CATALOGO_PROJETO}`, "--branch=main", "--commit-dirty=true"], { stdio: "inherit" });
    await refEstado.set({ ultima: agora, ate: maxAte, qtd: lista.length,
      ...(foiCompleta ? { ultimaCompleta: agora } : { ultimaCompleta: estado.ultimaCompleta || agora }) });
    console.log("Catálogo publicado.");
  }
})().catch(e => { console.error("Falha ao exportar o catálogo:", e); process.exit(1); });
