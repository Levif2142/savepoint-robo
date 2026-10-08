/* =====================================================================
   MOEDAS SAVE POINT — roda junto com o robô (a cada 30 min)
   Quem credita as moedas é sempre o robô, no servidor: o app não consegue aumentar o próprio saldo
   (as regras do Firestore só deixam o app GASTAR, e conferem o preço de cada item).

   Cada crédito tem uma chave única no extrato (ex.: "obra_ABC", "memoria_XYZ", "dia_2026-10-08"):
   a mesma ação nunca paga duas vezes, mesmo se o robô rodar de novo.

   Ganhos:
     • Boas-vindas (carteira nova) ............................ +50
     • Obra cadastrada e aprovada (até 10 por dia) ............ +20
     • Obra concluída na estante (até 10 por dia) ............. +10
     • Memória compartilhada (até 3 por dia) .................. +5
     • Entrou no app (presença do dia) ........................ +2
     • 7 dias seguidos entrando no app ........................ +20
     • Conquista nova ......................................... +15
     • Top 3 dos curadores, na virada do mês .................. +200

   Fim do período alfa: quando a administração toca em "Encerrar período alfa" (grava /sistema/alfa),
   o robô zera o XP e o nível de todos os membros que já tinham conta e entrega a Coleção Alfa
   (avatar, moldura, banner e tema da estante). Faz em partes, se houver muitos membros.
   ===================================================================== */
const admin = require("firebase-admin");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue, Timestamp, FieldPath } = admin.firestore;
const ITENS_ALFA = ["avatar_alfa", "moldura_alfa", "banner_alfa", "tema_alfa"];

const POR_RODADA = 300;
const TEMPO_MAXIMO = 4 * 60 * 1000;
const inicio = Date.now();
const noTempo = () => Date.now() - inicio < TEMPO_MAXIMO;
const UID_OK = /^[A-Za-z0-9_-]{1,128}$/;
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
// dia no horário de Brasília (o "dia" das metas e limites diários)
const diaBR = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const somarDias = (dia, n) => new Date(Date.parse(dia + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const trecho = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const cont = { creditos: 0, moedas: 0, pulados: 0, erros: 0 };

/* Credita "valor" moedas para "uid" com a chave única "chave".
   limite = { tipo:"memorias", max:3 } aplica o limite diário; extra = campos a mais na carteira. */
async function creditar(uid, chave, valor, motivo, limite = null, extra = null) {
  if (!UID_OK.test(uid || "")) return false;
  const refC = db.doc(`carteiras/${uid}`), refE = refC.collection("extrato").doc(chave);
  try {
    const ok = await db.runTransaction(async (tx) => {
      const [c, e, p] = await Promise.all([tx.get(refC), tx.get(refE), tx.get(db.doc(`perfis/${uid}`))]);
      if (e.exists || !p.exists) return false;   // conta excluída (ou sem perfil): não cria carteira
      const dados = c.exists ? c.data() : {};
      const dia = diaBR(Date.now());
      let lim = dados.limitesDia && dados.limitesDia.dia === dia ? { ...dados.limitesDia } : { dia };
      if (limite) {
        if ((lim[limite.tipo] || 0) >= limite.max) return false;
        lim[limite.tipo] = (lim[limite.tipo] || 0) + 1;
      }
      const campos = { ...(limite ? { limitesDia: lim } : {}), ...(extra || {}) };
      if (!c.exists) tx.set(refC, { saldo: valor, itens: [], criadaEm: FieldValue.serverTimestamp(), ...campos });
      else tx.update(refC, { saldo: FieldValue.increment(valor), ...campos });
      tx.set(refE, { valor, motivo: trecho(motivo, 120), criadoEm: FieldValue.serverTimestamp() });
      return true;
    });
    if (ok) { cont.creditos++; cont.moedas += valor; } else cont.pulados++;
    return ok;
  } catch (e) { cont.erros++; console.error(`Erro ao creditar ${chave}:`, e.message); return false; }
}

// busca o que mudou depois do cursor e devolve o novo cursor
async function novos(consulta, campo, cursor) {
  // datas no futuro (aparelho com relógio errado ou alguém mexendo) são ignoradas, para não "pular" o cursor
  const snap = await consulta.where(campo, ">", cursor).where(campo, "<=", Timestamp.now()).orderBy(campo).limit(POR_RODADA).get();
  const ultimo = snap.docs.length ? snap.docs[snap.docs.length - 1].get(campo) : cursor;
  return { docs: snap.docs, cursor: ultimo instanceof Timestamp ? ultimo : cursor, cheio: snap.docs.length === POR_RODADA };
}

const etapas = {
  // carteira nova: 50 moedas de boas-vindas
  async cursorCarteiras(cursor) {
    const r = await novos(db.collection("carteiras"), "criadaEm", cursor);
    for (const d of r.docs) { if (!noTempo()) break; await creditar(d.id, "boasvindas", 50, "Boas-vindas à loja de moedas"); }
    return r;
  },
  // obra aprovada (pública): +20 para quem cadastrou
  async cursorObras(cursor) {
    const r = await novos(db.collection("obras").where("visibilidade", "==", "publica"), "atualizadoEm", cursor);
    for (const d of r.docs) {
      if (!noTempo()) break;
      const o = d.data();
      await creditar(o.criadoPor, `obra_${d.id}`, 20, `Obra cadastrada e aprovada: ${o.nome || "obra"}`, { tipo: "obras", max: 10 });
    }
    return r;
  },
  // obra concluída na estante: +10
  async cursorEstante(cursor) {
    const r = await novos(db.collectionGroup("estante"), "atualizadoEm", cursor);
    const nomes = new Map();
    for (const d of r.docs) {
      if (!noTempo()) break;
      if (d.get("status") !== "concluido") continue;
      const uid = d.ref.parent.parent.id;
      if (!nomes.has(d.id)) {
        // só paga obra que existe de verdade no catálogo e já foi aprovada
        const o = /^[A-Za-z0-9]{20}$/.test(d.id) ? await db.doc(`obras/${d.id}`).get() : null;
        nomes.set(d.id, o && o.exists && o.get("visibilidade") === "publica" ? o.get("nome") || "obra" : null);
      }
      if (!nomes.get(d.id)) { cont.pulados++; continue; }
      await creditar(uid, `concluir_${d.id}`, 10, `Obra concluída: ${nomes.get(d.id)}`, { tipo: "concluidas", max: 10 });
    }
    return r;
  },
  // memória compartilhada: +5 (até 3 por dia)
  async cursorMemorias(cursor) {
    const r = await novos(db.collection("memorias"), "criadoEm", cursor);
    for (const d of r.docs) {
      if (!noTempo()) break;
      const m = d.data();
      if (m.oculta === true) continue;
      await creditar(m.uid, `memoria_${d.id}`, 5, `Memória escrita: ${m.obraNome || "obra"}`, { tipo: "memorias", max: 3 });
    }
    return r;
  },
  // conquistas novas: +15 cada
  async cursorPerfis(cursor) {
    const r = await novos(db.collection("perfis"), "atualizadoEm", cursor);
    for (const d of r.docs) {
      if (!noTempo()) break;
      const conquistas = Array.isArray(d.get("conquistas")) ? d.get("conquistas").filter(x => typeof x === "string" && x.length <= 40) : [];
      if (!conquistas.length) continue;
      const c = await db.doc(`carteiras/${d.id}`).get();
      const pagas = new Set(c.exists ? c.get("conquistasPagas") || [] : []);
      const novas = conquistas.filter(x => !pagas.has(x));
      for (const cq of novas) await creditar(d.id, `conquista_${cq}`, 15, "Conquista nova");
      if (novas.length) await db.doc(`carteiras/${d.id}`).set({ conquistasPagas: [...new Set([...pagas, ...novas])].slice(-100) }, { merge: true });
    }
    return r;
  },
  // presença do dia (+2) e 7 dias seguidos (+20)
  async cursorCheckins(cursor) {
    const r = await novos(db.collectionGroup("checkin"), "em", cursor);
    for (const d of r.docs) {
      if (!noTempo()) break;
      const uid = d.ref.parent.parent.id, dia = d.id, em = d.get("em");
      // o dia informado pelo aparelho precisa bater com a hora do servidor (fusos do Brasil)
      const ms = em && em.toMillis ? em.toMillis() : 0;
      const validos = [2, 3, 4, 5].map(h => new Date(ms - h * 3600e3).toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !validos.includes(dia)) { cont.pulados++; continue; }
      const c = await db.doc(`carteiras/${uid}`).get();
      const seq = c.exists ? c.get("sequencia") || {} : {};
      if (seq.ultimo === dia) continue;
      const dias = seq.ultimo === somarDias(dia, -1) ? (seq.dias || 0) + 1 : 1;
      const ok = await creditar(uid, `dia_${dia}`, 2, "Entrou no app", null, { sequencia: { dias, ultimo: dia } });
      if (ok && dias % 7 === 0) await creditar(uid, `sequencia_${dia}`, 20, `Sequência de ${dias} dias entrando no app`);
    }
    return r;
  }
};

// Presente dos testadores alfa para um membro (uma vez só: a linha "alfa" do extrato marca que já recebeu)
async function presentearAlfa(uid) {
  const refC = db.doc(`carteiras/${uid}`), refE = refC.collection("extrato").doc("alfa"), refP = db.doc(`perfis/${uid}`);
  return db.runTransaction(async (tx) => {
    const [c, e, p] = await Promise.all([tx.get(refC), tx.get(refE), tx.get(refP)]);
    if (e.exists || !p.exists) return false;
    const itens = [...new Set([...(c.exists ? c.get("itens") || [] : []), ...ITENS_ALFA])];
    if (c.exists) tx.update(refC, { itens, alfa: true });
    else tx.set(refC, { saldo: 0, itens, alfa: true, criadaEm: FieldValue.serverTimestamp() });
    tx.set(refE, { valor: 0, motivo: "🎁 Presente dos testadores alfa: avatar, moldura, banner e tema exclusivos", criadoEm: FieldValue.serverTimestamp() });
    // o XP que a pessoa tinha vira "desconto": o app passa a mostrar só o que for ganho daqui para frente
    const total = (Number(p.get("xp")) || 0) + (Number(p.get("xpDesconto")) || 0);
    tx.update(refP, { xp: 0, nivel: 1, xpDesconto: total });
    return true;
  });
}
async function fimDoAlfa() {
  const ref = db.doc("sistema/alfa");
  const a = (await ref.get()).data();
  if (!a || !a.encerradoEm || a.concluidoEm) return;
  const limite = a.encerradoEm.toMillis();
  let cursor = a.cursor || "", feitos = 0, acabou = false;
  while (noTempo()) {
    let q = db.collection("perfis").orderBy(FieldPath.documentId()).limit(200);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const d of snap.docs) {
      if (!noTempo()) break;
      const criado = d.get("criadoEm");
      // quem criou a conta depois do encerramento não era testador
      if (!(criado && criado.toMillis && criado.toMillis() > limite)) {
        try { if (await presentearAlfa(d.id)) feitos++; } catch (e) { cont.erros++; console.error("Erro no presente alfa:", e.message); }
      }
      cursor = d.id;
    }
    if (snap.docs.length < 200) { acabou = true; break; }
  }
  await ref.set({ cursor, presenteados: FieldValue.increment(feitos), ...(acabou ? { concluidoEm: FieldValue.serverTimestamp() } : {}) }, { merge: true });
  console.log(`Fim do alfa: ${feitos} presentes nesta rodada${acabou ? " (concluído)" : " (continua na próxima rodada)"}`);
}

(async () => {
  try { await fimDoAlfa(); } catch (e) { cont.erros++; console.error("Erro no fim do alfa:", e.message); }
  const controle = db.doc("sistema/moedasAuto");
  const estado = (await controle.get()).data() || {};
  const padrao = Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);   // primeira rodada: últimas 24 h
  const novoEstado = {};
  let pendente = false;
  for (const [campo, fn] of Object.entries(etapas)) {
    if (!noTempo()) { pendente = true; break; }
    try {
      const r = await fn(estado[campo] || padrao);
      novoEstado[campo] = r.cursor;
      if (r.cheio) pendente = true;
    } catch (e) {
      cont.erros++;
      if (e.code === 9 || /index/i.test(e.message)) console.error(`Falta um índice para "${campo}". Publique o firestore.indexes.json (firebase deploy --only firestore). Detalhe: ${e.message}`);
      else console.error(`Erro em ${campo}:`, e.message);
    }
  }
  // Top 3 dos curadores: na virada do mês, +200 para cada um
  try {
    const hoje = diaBR(Date.now()), mesAtual = hoje.slice(0, 7);
    if (estado.curadoresMes !== mesAtual) {
      const anterior = somarDias(mesAtual + "-01", -1).slice(0, 7);
      const ranking = ((await db.doc("sistema/curadores").get()).get("ranking") || []).filter(x => x && x.pos <= 3);
      for (const r of ranking) await creditar(r.uid, `curador_${anterior}`, 200, `Top 3 dos curadores de ${MESES[+anterior.slice(5) - 1]}`);
      novoEstado.curadoresMes = mesAtual;
    }
  } catch (e) { cont.erros++; console.error("Erro no prêmio dos curadores:", e.message); }
  await controle.set({ ...novoEstado, ultimaRodada: FieldValue.serverTimestamp(), ultimoResultado: { ...cont, pendente } }, { merge: true });
  // por privacidade, o registro público do GitHub mostra só os números
  console.log("Moedas:", cont, pendente ? "(continua na próxima rodada)" : "");
  process.exit(0);
})().catch(e => { console.error("Falha geral nas moedas:", e); process.exit(1); });
