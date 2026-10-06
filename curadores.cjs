/* =====================================================================
   RANKING DE CURADORES — roda junto com o robô
   Conta, direto no Firestore, quantas obras APROVADAS (públicas) cada membro cadastrou e grava
   o resultado em /sistema/curadores. Assim todo mundo vê exatamente o mesmo ranking
   (antes, cada aparelho contava pelo catálogo guardado nele, que podia estar desatualizado).
   - Top 3 com no mínimo 5 obras aprovadas; empate divide a posição (dois "Top 1", por exemplo).
   - Também guarda quantas obras de cada membro ainda estão "Verificando…" (não contam até serem aprovadas).
   - Para economizar leituras, só recalcula quando alguma obra mudou ou uma vez por dia.
   ===================================================================== */
const admin = require("firebase-admin");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const MIN_CURADOR = 5, TOP_CURADORES = 3;

(async () => {
  const ref = db.doc("sistema/curadores");
  const estado = (await ref.get()).data() || {};
  const ultima = estado.calculadoEm;   // Timestamp
  let mudou = !ultima || Date.now() - ultima.toMillis() > 24 * 3600 * 1000 || process.env.CURADORES_FORCAR === "1";
  if (!mudou) {
    // houve obra cadastrada, editada, aprovada ou excluída desde a última contagem? (2 a 3 leituras)
    const [alterada, verificada, catalogo] = await Promise.all([
      db.collection("obras").where("atualizadoEm", ">", ultima).limit(1).get(),
      db.collection("obras").where("verificacao.verificadoEm", ">", ultima).limit(1).get(),
      db.doc("sistema/catalogo").get()
    ]);
    const removida = catalogo.exists && catalogo.data().atualizadoEm && catalogo.data().atualizadoEm.toMillis() > ultima.toMillis();
    mudou = !alterada.empty || !verificada.empty || removida;
  }
  if (!mudou) { console.log("Curadores: nada mudou desde a última contagem."); process.exit(0); }

  const snap = await db.collection("obras").select("criadoPor", "visibilidade").get();
  const aprovadas = {}, pendentes = {};
  snap.forEach(d => {
    const { criadoPor: uid, visibilidade } = d.data();
    if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;
    if (!visibilidade || visibilidade === "publica") aprovadas[uid] = (aprovadas[uid] || 0) + 1;
    else if (visibilidade === "pendente") pendentes[uid] = (pendentes[uid] || 0) + 1;
  });
  // ranking: ordena por quantidade; quem empata fica na mesma posição (1, 1, 3…)
  const ordem = Object.entries(aprovadas).filter(([, n]) => n >= MIN_CURADOR).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const posicoes = [];
  ordem.forEach(([, n], i) => posicoes.push(i > 0 && n === ordem[i - 1][1] ? posicoes[i - 1] : i + 1));
  const ranking = ordem.map(([uid, n], i) => ({ uid, n, pos: posicoes[i] })).filter(r => r.pos <= TOP_CURADORES);
  await ref.set({ ranking, aprovadas, pendentes, minimo: MIN_CURADOR, obrasContadas: snap.size,
    calculadoEm: Timestamp.now(), atualizadoEm: FieldValue.serverTimestamp() });
  // por privacidade, o registro público do GitHub mostra só os números
  console.log(`Curadores: ${snap.size} obras contadas, ${Object.keys(aprovadas).length} membros com obras aprovadas, top: ${ranking.map(r => `${r.pos}º (${r.n})`).join(", ") || "ninguém com o mínimo"}`);
  process.exit(0);
})().catch(e => { console.error("Falha ao contar curadores:", e); process.exit(1); });
