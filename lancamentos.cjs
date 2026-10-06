/* =====================================================================
   CALENDÁRIO AUTOMÁTICO DE LANÇAMENTOS — roda junto com o robô
   No penúltimo dia de cada mês (horário de Brasília), procura os lançamentos do mês seguinte
   das obras que estão no catálogo e coloca no calendário:
     • Animes (AniList): estreia de temporada nova e episódio final da temporada
     • Séries (TMDB):    estreia de temporada nova e episódio final da temporada
     • Filmes (TMDB):    estreia nos cinemas do Brasil
   Mangás, manhwas e livros continuam com a moderação (não há fonte gratuita confiável das datas no Brasil).
   Jogos: ainda não (dá para ligar depois com uma chave do RAWG).

   Também roda quando a moderação pede pelo app ("Buscar lançamentos agora"): aí pega do dia de hoje
   até o fim do mês seguinte.

   O trabalho é dividido em rodadas de até 4 minutos (o catálogo pode ser grande); o robô continua de onde
   parou na rodada seguinte, até terminar.
   Cada lançamento tem um ID fixo: rodar de novo não duplica. Se a moderação editar um lançamento do robô,
   o robô não mexe mais nele.
   ===================================================================== */
const admin = require("firebase-admin");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const TMDB = process.env.TMDB_KEY || "";

const TEMPO_MAXIMO = 4 * 60 * 1000;
const inicioRodada = Date.now();
const noTempo = () => Date.now() - inicioRodada < TEMPO_MAXIMO;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const FUSO = -3;   // horário de Brasília (sem horário de verão desde 2019)

/* ---------- datas ---------- */
const agoraBR = () => new Date(Date.now() + FUSO * 3600000);   // campos UTC deste Date = relógio de Brasília
const inicioDoMes = (a, m) => Date.UTC(a, m, 1, -FUSO);         // 00:00 de Brasília do dia 1 (m: 0-11)
const chaveMes = (ms) => { const d = new Date(ms + FUSO * 3600000); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; };
const dataTMDB = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12 - FUSO) : null; };   // meio-dia de Brasília
const dataAni = (d) => d?.year && d?.month && d?.day ? Date.UTC(d.year, d.month - 1, d.day, 12 - FUSO) : null;

/* ---------- utilidades ---------- */
const normalizar = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, "e").replace(/[^\p{L}\p{N}]/gu, "");
const nomesDaObra = (o) => [o.nome, ...(o.outrosNomes || [])].filter(Boolean);
const bateNome = (titulos, obra) => {
  const alvo = new Set(nomesDaObra(obra).map(normalizar));
  return titulos.filter(Boolean).some(t => alvo.has(normalizar(t)));
};
const corta = (t, n) => String(t || "").slice(0, n);
async function buscarJson(url, opcoes = {}, tentativa = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { ...opcoes, signal: ctrl.signal,
      headers: { "Accept": "application/json", "User-Agent": "SavePointRobo/1.0", ...(opcoes.headers || {}) } });
    if ((r.status === 429 || r.status >= 500) && tentativa < 4) { await esperar(4000 * tentativa); return buscarJson(url, opcoes, tentativa + 1); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- AniList: estreia de temporada e episódio final ---------- */
const CAMPOS_ANI = `id format status episodes title{ romaji english native } synonyms startDate{ year month day }
  airingSchedule(notYetAired:true, perPage:50){ nodes{ episode airingAt } } externalLinks{ site type }
  relations{ edges{ relationType node{ id type format } } }`;
const FORMATOS_SERIE = ["TV", "TV_SHORT", "ONA"];
let ultimaAni = 0;
async function anilist(query, variables) {
  const falta = 2200 - (Date.now() - ultimaAni);   // o AniList limita a ~30 consultas por minuto
  if (falta > 0) await esperar(falta);
  ultimaAni = Date.now();
  const r = await buscarJson("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }) });
  return r?.data;
}
async function eventosAnime(o, faixa) {
  // 1) acha a obra no AniList pelo nome
  let atual = null;
  for (const nome of nomesDaObra(o).slice(0, 3)) {
    const d = await anilist(`query($s:String){ Page(perPage:8){ media(search:$s, type:ANIME){ ${CAMPOS_ANI} } } }`, { s: nome });
    atual = (d?.Page?.media || []).find(m => bateNome([m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms || [])], o));
    if (atual) break;
  }
  if (!atual) return { achou: false, eventos: [] };
  // 2) percorre as continuações (temporadas seguintes)
  const eventos = [], vistos = new Set();
  for (let pulo = 0; atual && pulo < 10 && noTempo(); pulo++) {
    if (vistos.has(atual.id)) break;
    vistos.add(atual.id);
    if (FORMATOS_SERIE.includes(atual.format) && atual.status !== "FINISHED" && atual.status !== "CANCELLED") {
      const agenda = atual.airingSchedule?.nodes || [];
      const onde = [...new Set((atual.externalLinks || []).filter(l => l.type === "STREAMING").map(l => l.site))].slice(0, 2).join(", ") || "Streaming";
      const nomeTemp = atual.title?.english || atual.title?.romaji || "";
      // estreia: episódio 1 (com horário) ou a data de início
      const ep1 = agenda.find(n => n.episode === 1);
      const estreia = ep1 ? ep1.airingAt * 1000 : dataAni(atual.startDate);
      if (estreia && estreia >= faixa.inicio && estreia < faixa.fim)
        eventos.push({ chave: `ani${atual.id}_estreia`, tipo: "temporada", detalhe: corta(`Nova temporada: ${nomeTemp}`, 80), data: estreia, temHora: !!ep1, onde });
      // episódio final: só quando a quantidade de episódios já foi anunciada
      const final = atual.episodes ? agenda.find(n => n.episode === atual.episodes) : null;
      if (final && final.airingAt * 1000 >= faixa.inicio && final.airingAt * 1000 < faixa.fim)
        eventos.push({ chave: `ani${atual.id}_final`, tipo: "episodio", detalhe: corta(`Episódio final (ep. ${atual.episodes})`, 80), data: final.airingAt * 1000, temHora: true, onde });
    }
    const seq = (atual.relations?.edges || []).find(e => e.relationType === "SEQUEL" && e.node?.type === "ANIME" && FORMATOS_SERIE.includes(e.node.format));
    if (!seq) break;
    const d = await anilist(`query($id:Int){ Media(id:$id){ ${CAMPOS_ANI} } }`, { id: seq.node.id });
    atual = d?.Media || null;
  }
  return { achou: true, eventos };
}

/* ---------- TMDB: séries ---------- */
async function eventosSerie(o, faixa) {
  if (!TMDB) return { achou: false, eventos: [], semChave: true };
  let tv = null;
  for (const nome of nomesDaObra(o).slice(0, 3)) {
    const r = await buscarJson(`https://api.themoviedb.org/3/search/tv?language=pt-BR&query=${encodeURIComponent(nome)}&api_key=${TMDB}`);
    tv = (r?.results || []).find(f => bateNome([f.name, f.original_name], o));
    if (tv) break;
  }
  if (!tv) return { achou: false, eventos: [] };
  const det = await buscarJson(`https://api.themoviedb.org/3/tv/${tv.id}?language=pt-BR&api_key=${TMDB}`);
  const onde = (det.networks || []).map(n => n.name).slice(0, 2).join(", ") || "Streaming";
  const eventos = [];
  const temporadas = (det.seasons || []).filter(s => s.season_number > 0);
  for (const s of temporadas) {
    const d = dataTMDB(s.air_date);
    if (d && d >= faixa.inicio && d < faixa.fim)
      eventos.push({ chave: `tmdb${tv.id}_t${s.season_number}`, tipo: "temporada", detalhe: corta(`Temporada ${s.season_number}${s.name && !/^temporada \d+$/i.test(s.name) ? ` — ${s.name}` : ""}`, 80), data: d, temHora: false, onde });
  }
  // episódio final: olha a temporada mais recente que já estreou (ou estreia na faixa)
  if (!["Ended", "Canceled"].includes(det.status)) {
    const recente = temporadas.filter(s => dataTMDB(s.air_date) && dataTMDB(s.air_date) < faixa.fim).sort((a, b) => b.season_number - a.season_number)[0];
    if (recente) {
      const temp = await buscarJson(`https://api.themoviedb.org/3/tv/${tv.id}/season/${recente.season_number}?language=pt-BR&api_key=${TMDB}`);
      const eps = (temp.episodes || []).filter(e => e.air_date);
      const ultimo = eps[eps.length - 1], d = ultimo ? dataTMDB(ultimo.air_date) : null;
      if (ultimo && eps.length > 1 && d >= faixa.inicio && d < faixa.fim)
        eventos.push({ chave: `tmdb${tv.id}_t${recente.season_number}_final`, tipo: "episodio",
          detalhe: corta(`Final da temporada ${recente.season_number} (ep. ${ultimo.episode_number})`, 80), data: d, temHora: false, onde });
    }
  }
  return { achou: true, eventos };
}

/* ---------- TMDB: filmes (estreia nos cinemas do Brasil) ---------- */
async function eventosFilme(o, faixa) {
  if (!TMDB) return { achou: false, eventos: [], semChave: true };
  let filme = null;
  for (const nome of nomesDaObra(o).slice(0, 3)) {
    const r = await buscarJson(`https://api.themoviedb.org/3/search/movie?language=pt-BR&query=${encodeURIComponent(nome)}&api_key=${TMDB}`);
    const candidatos = (r?.results || []).filter(f => bateNome([f.title, f.original_title], o));
    filme = candidatos.find(f => o.ano && String(f.release_date || "").startsWith(String(o.ano))) || candidatos[0];
    if (filme) break;
  }
  if (!filme) return { achou: false, eventos: [] };
  const rel = await buscarJson(`https://api.themoviedb.org/3/movie/${filme.id}/release_dates?api_key=${TMDB}`);
  const br = (rel.results || []).find(x => x.iso_3166_1 === "BR");
  // tipo 3 = cinemas, 2 = estreia limitada
  const datas = (br?.release_dates || []).filter(x => x.type === 3 || x.type === 2)
    .map(x => dataTMDB(String(x.release_date || "").slice(0, 10))).filter(Boolean).sort((a, b) => a - b);
  const d = datas[0];
  if (!d || d < faixa.inicio || d >= faixa.fim) return { achou: true, eventos: [] };
  return { achou: true, eventos: [{ chave: `tmdb${filme.id}_estreia`, tipo: "estreia", detalhe: "Estreia nos cinemas", data: d, temHora: false, onde: "Cinemas" }] };
}

/* ---------- grava no calendário ---------- */
async function gravar(o, ev, cont) {
  const ref = db.doc(`lancamentos/robo_${o.id}_${ev.chave}`);
  const s = await ref.get();
  const agora = Timestamp.now();
  const dados = { titulo: corta(o.nome, 150), obraId: o.id, categoria: o.categoria, tipo: ev.tipo, detalhe: ev.detalhe,
    data: Timestamp.fromMillis(ev.data), temHora: ev.temHora, onde: corta(ev.onde, 80), criadoPor: "robo", criadoEm: agora, atualizadoEm: agora };
  if (s.exists) {
    const a = s.data();
    // editado pela moderação (atualizadoEm diferente de criadoEm): o robô não mexe
    const editado = a.criadoPor !== "robo" || !a.criadoEm?.isEqual?.(a.atualizadoEm);
    if (editado || (a.data?.toMillis?.() === ev.data && a.detalhe === ev.detalhe && a.onde === dados.onde)) return;
    await ref.set(dados); cont.atualizados++;
    console.log(`• atualizado ${ref.id}`);
    return;
  }
  await ref.set(dados); cont.criados++;
  console.log(`• novo ${ref.id}`);
}

(async () => {
  const controle = db.doc("sistema/lancamentosAuto");
  const estado = (await controle.get()).data() || {};
  const hoje = agoraBR(), a = hoje.getUTCFullYear(), m = hoje.getUTCMonth(), dia = hoje.getUTCDate();
  const ultimoDia = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  const proximo = { inicio: inicioDoMes(a, m + 1), fim: inicioDoMes(a, m + 2) };
  const chaveProximo = chaveMes(proximo.inicio);

  // decide se há trabalho: faixa em andamento, pedido da moderação ou penúltimo dia do mês
  let faixa = estado.faixa && estado.faixa.fim > Date.now() ? estado.faixa : null;
  if (!faixa && estado.pedido === true) faixa = { inicio: Date.now(), fim: proximo.fim, chave: "pedido", cursor: null };
  if (!faixa && dia >= ultimoDia - 1 && estado.mesFeito !== chaveProximo) faixa = { ...proximo, chave: chaveProximo, cursor: null };
  if (!faixa) { console.log("Calendário automático: nada a fazer agora."); process.exit(0); }

  console.log(`Calendário automático: buscando de ${new Date(faixa.inicio).toISOString().slice(0, 10)} até ${new Date(faixa.fim - 1).toISOString().slice(0, 10)}`);
  const cont = { obras: 0, encontradas: 0, criados: 0, atualizados: 0, erros: 0 };
  let cursor = faixa.cursor || null, terminou = false;
  while (noTempo()) {
    let q = db.collection("obras").where("visibilidade", "==", "publica").orderBy(admin.firestore.FieldPath.documentId()).limit(60);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) { terminou = true; break; }
    for (const d of snap.docs) {
      if (!noTempo()) break;
      const o = { id: d.id, ...d.data() };
      cursor = d.id;
      const fn = o.categoria === "anime" ? eventosAnime : o.categoria === "serie" ? eventosSerie
        // filmes: só os recentes ou sem ano (os antigos já estrearam)
        : o.categoria === "filme" && (!o.ano || o.ano >= hoje.getUTCFullYear() - 1) ? eventosFilme : null;
      if (!fn) continue;
      cont.obras++;
      try {
        const r = await fn(o, faixa);
        if (r.achou) cont.encontradas++;
        for (const ev of r.eventos) await gravar(o, ev, cont);
      } catch (e) { cont.erros++; console.error(`Erro na obra ${o.id}:`, e.message); }
    }
    if (snap.size < 60 && cursor === snap.docs[snap.docs.length - 1].id) { terminou = true; break; }
  }

  const resultadoAnterior = estado.faixa?.chave === faixa.chave ? estado.ultimoResultado || {} : {};
  const soma = (k) => (resultadoAnterior[k] || 0) + cont[k];
  const resultado = { obras: soma("obras"), encontradas: soma("encontradas"), criados: soma("criados"), atualizados: soma("atualizados"), erros: soma("erros"), terminou };
  await controle.set({
    faixa: terminou ? null : { ...faixa, cursor },
    ...(terminou && faixa.chave !== "pedido" ? { mesFeito: faixa.chave } : {}),
    ...(terminou && faixa.chave === "pedido" ? { pedido: false } : {}),
    ...(faixa.chave === "pedido" && !terminou ? { pedido: false } : {}),
    ultimaRodada: FieldValue.serverTimestamp(), ultimoResultado: resultado
  }, { merge: true });
  if (!TMDB) console.log("Aviso: sem o segredo TMDB_KEY, séries e filmes ficam de fora.");
  console.log("Calendário automático:", resultado, terminou ? "(concluído)" : "(continua na próxima rodada)");
  process.exit(0);
})().catch(e => { console.error("Falha no calendário automático:", e); process.exit(1); });
