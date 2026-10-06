/* =====================================================================
   MODERAÇÃO AUTOMÁTICA DO SAVE POINT (camada 2) — roda junto com o robô
   A cada rodada, lê SÓ o que foi escrito desde a rodada anterior:
     • comentários nas memórias
     • mensagens das conversas com lojas
     • memórias compartilhadas (novas ou editadas)
   e procura insultos homofóbicos, racistas, transfóbicos e incitação ao ódio,
   inclusive disfarçados (v1ad0, v i a d o, viaaado).

   O que ele faz quando encontra:
     termo GRAVE    → comentário: sai do ar e fica guardado em "quarentena" até a moderação decidir
                      memória:    fica oculta, com o aviso "retirada automaticamente"
                      e, em todos os casos, abre uma denúncia "🤖 Detectado automaticamente"
     termo de ATENÇÃO → só abre a denúncia; o conteúdo continua no ar
     conversas (os dois níveis) → a conversa é marcada como denunciada, para a moderação poder ler o contexto

   O robô NUNCA suspende ninguém: quem decide é sempre a moderação, no app.
   O texto das pessoas não sai do Firebase (nada é enviado para serviços de fora)
   e os registros do GitHub mostram só IDs, nunca o texto.
   ===================================================================== */
const admin = require("firebase-admin");
const { analisar } = require("./lexico.cjs");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const POR_RODADA = 400;                   // por tipo de conteúdo; o que sobrar fica para a próxima rodada
const TEMPO_MAXIMO = 4 * 60 * 1000;       // não atrasa o resto do robô
const QUARENTENA_DIAS = 60;               // sem decisão nesse prazo, o comentário retido é apagado de vez
const inicio = Date.now();
const noTempo = () => Date.now() - inicio < TEMPO_MAXIMO;
const trecho = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function denuncia({ tipo, alvoId, alvoUid, resumo, achado, acao }) {
  return {
    autor: "robo", origem: "robo", tipo, alvoId, alvoUid: alvoUid || "",
    motivo: "odio", nivel: achado.nivel, termos: achado.termos,
    detalhe: trecho(`${achado.nivel === "grave" ? "Termo grave encontrado" : "Possível ofensa encontrada"}: ${achado.termos.join(", ")}. ${acao}`, 500),
    resumo: trecho(resumo, 200), status: "aberta", criadoEm: FieldValue.serverTimestamp()
  };
}

// Busca o que chegou depois do cursor, em ordem, e devolve o novo cursor
async function novos(consulta, campo, cursor) {
  const snap = await consulta.where(campo, ">", cursor).orderBy(campo).limit(POR_RODADA).get();
  const ultimo = snap.docs.length ? snap.docs[snap.docs.length - 1].get(campo) : cursor;
  return { docs: snap.docs, cursor: ultimo instanceof Timestamp ? ultimo : cursor, cheio: snap.docs.length === POR_RODADA };
}

async function comentarios(cursor, cont) {
  const r = await novos(db.collectionGroup("comentarios"), "criadoEm", cursor);
  for (const d of r.docs) {
    if (!noTempo()) return { ...r, cursor: d.get("criadoEm") || r.cursor, cheio: true };
    const c = d.data(), achado = analisar(c.texto);
    cont.lidos++;
    if (!achado) continue;
    const memId = d.ref.parent.parent.id, alvoId = `${memId}__${d.id}`;
    const lote = db.batch();
    if (achado.nivel === "grave") {
      lote.set(db.doc(`quarentena/${alvoId}`), { tipo: "comentario", memId, comId: d.id, dados: c, nivel: achado.nivel, termos: achado.termos, criadoEm: FieldValue.serverTimestamp() });
      lote.delete(d.ref);
    }
    lote.set(db.doc(`denuncias/robo_comentario_${alvoId}`), denuncia({
      tipo: "comentario", alvoId, alvoUid: c.uid, resumo: `Comentário de ${c.autorNome || "Membro"}: ${trecho(c.texto, 150)}`, achado,
      acao: achado.nivel === "grave" ? "O comentário foi tirado do ar e está guardado para a sua decisão." : "O comentário continua no ar."
    }));
    await lote.commit();
    cont[achado.nivel]++;
    console.log(`• comentário ${alvoId} → ${achado.nivel}${achado.nivel === "grave" ? " (retido)" : ""}`);
  }
  return r;
}

async function mensagens(cursor, cont) {
  const r = await novos(db.collectionGroup("mensagens"), "criadoEm", cursor);
  for (const d of r.docs) {
    if (!noTempo()) return { ...r, cursor: d.get("criadoEm") || r.cursor, cheio: true };
    const m = d.data(), achado = analisar(m.texto);
    cont.lidos++;
    if (!achado) continue;
    const convRef = d.ref.parent.parent;
    const conv = (await convRef.get()).data() || {};
    const lote = db.batch();
    lote.set(convRef, { denunciada: true }, { merge: true });   // a moderação só lê conversas denunciadas
    lote.set(db.doc(`denuncias/robo_conversa_${convRef.id}__${d.id}`), denuncia({
      tipo: "conversa", alvoId: convRef.id, alvoUid: m.de,
      resumo: `Mensagem ${m.papel === "loja" ? "da loja" : "de " + (conv.clienteNome || "cliente")} na conversa com ${conv.lojaNome || "loja"}: ${trecho(m.texto, 120)}`,
      achado, acao: "A conversa foi liberada para a moderação ler e conferir o contexto."
    }));
    await lote.commit();
    cont[achado.nivel]++;
    console.log(`• mensagem ${convRef.id}/${d.id} → ${achado.nivel}`);
  }
  return r;
}

async function memorias(cursor, cont) {
  const r = await novos(db.collection("memorias"), "atualizadoEm", cursor);
  for (const d of r.docs) {
    if (!noTempo()) return { ...r, cursor: d.get("atualizadoEm") || r.cursor, cheio: true };
    const m = d.data();
    cont.lidos++;
    if (m.oculta === true) continue;
    const achado = analisar(m.texto);
    if (!achado) continue;
    const lote = db.batch();
    // só os campos que a moderação já usa (as regras não aceitam outros na memória)
    if (achado.nivel === "grave") lote.update(d.ref, { oculta: true, motivoModeracao: "Retirada automaticamente por possível discurso de ódio. A moderação vai revisar.", moderadoEm: FieldValue.serverTimestamp() });
    const quando = m.atualizadoEm?.toMillis?.() || Date.now();
    lote.set(db.doc(`denuncias/robo_memoria_${d.id}_${quando}`), denuncia({
      tipo: "memoria", alvoId: d.id, alvoUid: m.uid, resumo: `${m.obraNome || "Obra"} — ${m.autorNome || "Membro"}: ${trecho(m.texto, 150)}`, achado,
      acao: achado.nivel === "grave" ? "A memória foi ocultada até a sua decisão." : "A memória continua no ar."
    }));
    await lote.commit();
    cont[achado.nivel]++;
    console.log(`• memória ${d.id} → ${achado.nivel}${achado.nivel === "grave" ? " (oculta)" : ""}`);
  }
  return r;
}

// Comentários retidos há mais de 60 dias sem decisão: apaga de vez (não guardamos texto além do necessário)
async function limparQuarentena(cont) {
  const limite = Timestamp.fromMillis(Date.now() - QUARENTENA_DIAS * 864e5);
  const snap = await db.collection("quarentena").where("criadoEm", "<", limite).limit(200).get();
  if (snap.empty) return;
  const lote = db.batch();
  snap.docs.forEach(d => lote.delete(d.ref));
  await lote.commit();
  cont.quarentenaApagada = snap.size;
}

(async () => {
  const controle = db.doc("sistema/moderacaoAuto");
  const estado = (await controle.get()).data() || {};
  // primeira rodada: olha só as últimas 24 horas
  const padrao = Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);
  const cont = { lidos: 0, grave: 0, atencao: 0, erros: 0 };
  const novoEstado = {};
  const etapas = [
    ["cursorComentarios", comentarios],
    ["cursorMensagens", mensagens],
    ["cursorMemorias", memorias]
  ];
  let pendente = false;
  for (const [campo, fn] of etapas) {
    if (!noTempo()) { pendente = true; break; }
    try {
      const r = await fn(estado[campo] || padrao, cont);
      novoEstado[campo] = r.cursor;
      if (r.cheio) pendente = true;
    } catch (e) {
      cont.erros++;
      if (e.code === 9 || /index/i.test(e.message)) {
        console.error(`Falta um índice para "${campo}". Publique o firestore.indexes.json do app (firebase deploy --only firestore). Detalhe: ${e.message}`);
      } else console.error(`Erro em ${campo}:`, e.message);
    }
  }
  try { await limparQuarentena(cont); } catch (e) { console.error("Erro ao limpar a quarentena:", e.message); }
  await controle.set({ ...novoEstado, ultimaRodada: FieldValue.serverTimestamp(), ultimoResultado: { ...cont, pendente } }, { merge: true });
  console.log("Moderação automática:", cont, pendente ? "(continua na próxima rodada)" : "");
  process.exit(0);
})().catch(e => { console.error("Falha geral na moderação automática:", e); process.exit(1); });
