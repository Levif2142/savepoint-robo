/* =====================================================================
   ROBÔ DO SAVE POINT — roda no GitHub Actions a cada 10 minutos
   1. Busca obras com visibilidade "pendente".
   2. Consulta AniList (animes, mangás, manhwas), TMDB (filmes, se houver chave),
      Google Books (livros), palavras-chave e analisa a capa com o NSFW.js.
   3. Marca "publica" (catálogo para todos) ou "privada" (conteúdo adulto:
      só na estante de quem cadastrou). Se não conseguir consultar nenhuma
      fonte externa 3 vezes seguidas, deixa para a moderação decidir.
   Se um moderador pedir pelo app ("verificar obras antigas"), também
   verifica as obras cadastradas antes do robô existir.
   ===================================================================== */
const admin = require("firebase-admin");
const tf = require("@tensorflow/tfjs");
const jpeg = require("jpeg-js");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const MAX_TENTATIVAS = 3;

/* ---------- utilidades ---------- */
const normalizar = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, "e").replace(/[^\p{L}\p{N}]/gu, "");
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function buscarJson(url, opcoes = {}, tentativa = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { ...opcoes, signal: ctrl.signal,
      headers: { "Accept": "application/json", "User-Agent": "SavePointRobo/1.0", ...(opcoes.headers || {}) } });
    if ((r.status === 429 || r.status >= 500) && tentativa < 3) { await esperar(2000 * tentativa); return buscarJson(url, opcoes, tentativa + 1); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
const nomesDaObra = (o) => [o.nome, ...(o.outrosNomes || [])].filter(Boolean);
const bateNome = (titulos, obra) => {
  const alvo = new Set(nomesDaObra(obra).map(normalizar));
  return titulos.filter(Boolean).some(t => alvo.has(normalizar(t)));
};

/* ---------- 1) Palavras-chave (mesma lista do app) ---------- */
const PALAVRAS = /(?:^|[^\p{L}\p{N}])(hentai|porn[oô]?|pornogr[aá]fic[oa]s?|pornografia|xxx|nsfw|r-?18|18\s*\+|\+\s*18|er[oó]tic[oa]s?|sexo expl[ií]cito)(?=$|[^\p{L}\p{N}])/iu;
function checarPalavras(o) {
  const achou = [...nomesDaObra(o), ...(o.generos || []), o.tipo || ""].join(" | ").match(PALAVRAS);
  return { fonte: "palavras-chave", externa: false, consultada: true, adulto: !!achou, detalhe: achou ? `termo "${achou[1]}"` : "nenhum termo" };
}

/* ---------- 2) AniList: animes, mangás e manhwas ---------- */
async function checarAniList(o) {
  const tipo = o.categoria === "anime" ? "ANIME" : "MANGA";
  const consulta = `query($s:String,$t:MediaType){ Page(perPage:8){ media(search:$s,type:$t){
      title{ romaji english native } synonyms isAdult genres } } }`;
  let achou = false, adulto = false, detalhe = "não encontrada";
  for (const nome of nomesDaObra(o).slice(0, 3)) {
    const r = await buscarJson("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: consulta, variables: { s: nome, t: tipo } })
    });
    for (const m of r?.data?.Page?.media || []) {
      if (!bateNome([m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms || [])], o)) continue;
      achou = true;
      if (m.isAdult || (m.genres || []).includes("Hentai")) { adulto = true; detalhe = `${m.title?.romaji}: adulto`; break; }
      detalhe = `${m.title?.romaji}: não adulto`;
    }
    if (adulto) break;
  }
  return { fonte: "AniList", externa: true, consultada: true, adulto, detalhe: achou ? detalhe : "não encontrada" };
}

/* ---------- 3) TMDB: filmes (precisa do segredo TMDB_KEY) ---------- */
async function checarTMDB(o) {
  const serie = o.categoria === "serie";
  const chave = process.env.TMDB_KEY;
  if (!chave) return { fonte: "TMDB", externa: true, consultada: false, adulto: false, detalhe: "sem chave" };
  let achou = false, adulto = false;
  for (const nome of nomesDaObra(o).slice(0, 3)) {
    const r = await buscarJson(`https://api.themoviedb.org/3/search/${serie ? "tv" : "movie"}?include_adult=true&language=pt-BR&query=${encodeURIComponent(nome)}&api_key=${chave}`);
    for (const f of r?.results || []) {
      if (!bateNome(serie ? [f.name, f.original_name] : [f.title, f.original_title], o)) continue;
      achou = true;
      if (f.adult) { adulto = true; break; }
    }
    if (adulto) break;
  }
  return { fonte: "TMDB", externa: true, consultada: true, adulto, detalhe: achou ? (adulto ? "adulto" : "não adulto") : "não encontrado" };
}

/* ---------- 4) Google Books: livros ---------- */
async function checarLivros(o) {
  let achou = false, adulto = false;
  for (const nome of nomesDaObra(o).slice(0, 2)) {
    const chave = process.env.GOOGLE_BOOKS_KEY ? `&key=${process.env.GOOGLE_BOOKS_KEY}` : "";
    const r = await buscarJson(`https://www.googleapis.com/books/v1/volumes?maxResults=8&q=${encodeURIComponent(`intitle:"${nome}"`)}${chave}`);
    for (const it of r?.items || []) {
      const v = it.volumeInfo || {};
      if (!bateNome([v.title, [v.title, v.subtitle].filter(Boolean).join(" ")], o)) continue;
      achou = true;
      if (v.maturityRating === "MATURE") { adulto = true; break; }
    }
    if (adulto) break;
  }
  return { fonte: "Google Books", externa: true, consultada: true, adulto, detalhe: achou ? (adulto ? "MATURE" : "não adulto") : "não encontrado" };
}

/* ---------- 5) Capa: NSFW.js (modelo gratuito que roda aqui mesmo) ---------- */
let modelo = null;
async function carregarModelo() {
  if (modelo) return modelo;
  await tf.setBackend("cpu");
  const nsfw = require("nsfwjs");
  modelo = await nsfw.load("MobileNetV2");
  return modelo;
}
async function checarCapa(o) {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(o.capa || "");
  if (!m) return { fonte: "capa", externa: false, consultada: false, adulto: false, detalhe: o.capa ? "formato não analisado" : "sem capa" };
  const img = jpeg.decode(Buffer.from(m[1], "base64"), { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
  const tensor = tf.tensor3d(img.data, [img.height, img.width, 3], "int32");
  try {
    const p = Object.fromEntries((await (await carregarModelo()).classify(tensor, 5)).map(c => [c.className, c.probability]));
    const explicito = (p.Porn || 0) + (p.Hentai || 0);
    const adulto = (p.Porn || 0) > 0.6 || (p.Hentai || 0) > 0.6 || explicito > 0.75;
    return { fonte: "capa (NSFW.js)", externa: false, consultada: true, adulto,
             detalhe: `porn ${(p.Porn || 0).toFixed(2)}, hentai ${(p.Hentai || 0).toFixed(2)}, sexy ${(p.Sexy || 0).toFixed(2)}` };
  } finally { tensor.dispose(); }
}

/* ---------- decisão ---------- */
async function verificar(o) {
  const tarefas = [checarPalavras(o), checarCapa(o)];
  if (["anime", "manga", "manhwa"].includes(o.categoria)) tarefas.push(checarAniList(o));
  if (o.categoria === "filme" || o.categoria === "serie") tarefas.push(checarTMDB(o));
  if (o.categoria === "livro") tarefas.push(checarLivros(o));
  const fontes = (await Promise.allSettled(tarefas)).map((r, i) => r.status === "fulfilled" ? r.value
    : { fonte: `fonte ${i + 1}`, externa: true, consultada: false, adulto: false, detalhe: `falhou: ${r.reason?.message || r.reason}` });
  const adulto = fontes.some(f => f.adulto);
  // Filmes e livros: se a base externa não responder, a capa analisada também vale como verificação.
  // Animes, mangás e manhwas precisam do AniList (as capas são desenhos, onde o modelo erra mais).
  // Jogos não têm base pública de classificação: valem capa e palavras-chave (e a moderação)
  const capaVale = ["filme", "livro", "serie", "jogo"].includes(o.categoria);
  const decisivas = fontes.filter(f => f.consultada && (f.externa || (capaVale && f.fonte.startsWith("capa"))));
  return { status: adulto ? "adulto" : decisivas.length ? "livre" : "indefinido", fontes };
}

async function aplicar(ref, obra, { status, fontes }) {
  const tentativas = (obra.verificacao?.tentativas || 0) + 1;
  const dados = {
    verificacao: { status, origem: "robo", fontes, tentativas, verificadoEm: FieldValue.serverTimestamp() },
    conteudoAdulto: status === "adulto",
    visibilidade: status === "adulto" ? "privada" : status === "livre" ? "publica" : "pendente",
    // os aparelhos baixam só as obras alteradas: a data precisa mudar quando a obra é aprovada
    atualizadoEm: FieldValue.serverTimestamp()
  };
  await ref.update(dados);
  // obra que já era pública e virou privada: avisa os aparelhos para tirarem do catálogo guardado
  if (status === "adulto" && (obra.visibilidade || "publica") === "publica") {
    await db.runTransaction(async (tx) => {
      const r = db.doc("sistema/catalogo"), s = await tx.get(r);
      const lista = [...(s.exists ? s.data().removidos || [] : []).filter(x => x !== ref.id), ref.id].slice(-500);
      tx.set(r, { removidos: lista, atualizadoEm: FieldValue.serverTimestamp() });
    });
  }
  if (status === "adulto") {
    const lote = db.batch();
    for (const c of obra.chaves || []) {
      const idx = await db.doc(`nomesCatalogados/${c}`).get();
      if (idx.exists && idx.data().obraId === ref.id) lote.delete(idx.ref);
    }
    const mems = await db.collection("memorias").where("obraId", "==", ref.id).where("oculta", "==", false).get();
    mems.forEach(d => lote.update(d.ref, { oculta: true, motivoModeracao: "Obra de conteúdo adulto", moderadoEm: FieldValue.serverTimestamp() }));
    await lote.commit();
  }
  // O repositório é público e os registros do Actions também: por privacidade, só o ID e o resultado aparecem aqui
  console.log(`• obra ${ref.id} [${obra.categoria}] → ${status}` + (status === "indefinido"
    ? ` (${fontes.filter(f => !f.consultada).map(f => `${f.fonte}: ${f.detalhe}`).join("; ")})` : ""));
  return status;
}

(async () => {
  const controle = db.doc("sistema/robo");
  const pedido = (await controle.get()).data() || {};
  const alvos = new Map();
  (await db.collection("obras").where("visibilidade", "==", "pendente").limit(100).get())
    .docs.filter(d => (d.data().verificacao?.tentativas || 0) < MAX_TENTATIVAS).forEach(d => alvos.set(d.id, d));
  if (pedido.verificarAntigas) {
    // obras cadastradas antes do robô: não têm o campo "visibilidade"
    (await db.collection("obras").get()).docs.filter(d => !d.data().visibilidade).forEach(d => alvos.set(d.id, d));
  }
  const cont = { verificadas: 0, adultas: 0, livres: 0, indefinidas: 0 };
  for (const d of alvos.values()) {
    try {
      const st = await aplicar(d.ref, d.data(), await verificar(d.data()));
      cont.verificadas++; cont[{ adulto: "adultas", livre: "livres", indefinido: "indefinidas" }[st]]++;
    } catch (e) { console.error(`Erro ao verificar ${d.id}:`, e.message); }
  }
  await controle.set({
    ultimaRodada: FieldValue.serverTimestamp(), ultimoResultado: cont,
    ...(pedido.verificarAntigas ? { verificarAntigas: false } : {})
  }, { merge: true });
  console.log("Resumo:", cont);
  process.exit(0);
})().catch(e => { console.error("Falha geral:", e); process.exit(1); });
