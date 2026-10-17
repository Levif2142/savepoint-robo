/* =====================================================================
   CAPAS PENDENTES — roda junto com o robô
   Quando o navegador não consegue baixar a capa de uma obra (o site da imagem não deixa),
   o app guarda o link em "capaPendente". Aqui no servidor não existe essa trava: o robô baixa,
   reduz para 360 × 540, converte em JPEG e grava em "capa" (o mesmo formato que o app usa).
   Só aceita links dos sites conhecidos (AniList, Open Library, TVmaze, Google Books, Wikipédia e as bases de cartas TCG).
   ===================================================================== */
const admin = require("firebase-admin");
const sharp = require("sharp");

const conta = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conta) { console.error("Falta o segredo FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const LINK_OK = /^https:\/\/(s4\.anilist\.co|covers\.openlibrary\.org|static\.tvmaze\.com|books\.google\.com|upload\.wikimedia\.org|images\.pokemontcg\.io|assets\.tcgdex\.net|cards\.scryfall\.io|images\.ygoprodeck\.com)\/[^\s"<>]{1,380}$/;
const POR_RODADA = 40;
const MAX_TENTATIVAS = 3;
const LIMITE_CAPA = 400000;   // mesmo limite das regras do Firestore (capaValida)

async function baixar(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    // a Wikimedia pede um "User-Agent" que identifique quem está baixando
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": "SavePointRobo/1.0 (https://save-point-geek.web.app; capas do catálogo)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (!LINK_OK.test(r.url) && r.url !== url) throw new Error("redirecionou para outro site");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) throw new Error("imagem muito grande");
    return buf;
  } finally { clearTimeout(t); }
}
async function paraCapa(buf) {
  for (const q of [82, 70, 55]) {
    const jpg = await sharp(buf, { failOn: "none" }).rotate()
      .resize(360, 540, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    const dataUrl = "data:image/jpeg;base64," + jpg.toString("base64");
    if (dataUrl.length <= LIMITE_CAPA) return dataUrl;
  }
  throw new Error("capa ficou grande demais");
}

(async () => {
  const cont = { gravadas: 0, falhas: 0, desistiu: 0 };
  const snap = await db.collection("obras").where("capaPendente", ">", "").limit(POR_RODADA).get();
  for (const d of snap.docs) {
    const o = d.data(), url = String(o.capaPendente || "");
    try {
      if (o.capa || !LINK_OK.test(url)) {   // já tem capa (alguém colocou à mão) ou link fora da lista
        await d.ref.update({ capaPendente: FieldValue.delete(), capaTentativas: FieldValue.delete() });
        continue;
      }
      const capa = await paraCapa(await baixar(url));
      await d.ref.update({ capa, capaPendente: FieldValue.delete(), capaTentativas: FieldValue.delete(),
        atualizadoEm: FieldValue.serverTimestamp() });
      cont.gravadas++;
    } catch (e) {
      const n = (Number(o.capaTentativas) || 0) + 1;
      if (n >= MAX_TENTATIVAS) { await d.ref.update({ capaPendente: FieldValue.delete(), capaTentativas: FieldValue.delete() }).catch(() => {}); cont.desistiu++; }
      else { await d.ref.update({ capaTentativas: n }).catch(() => {}); cont.falhas++; }
      console.error(`Capa da obra ${d.id}: ${e.message}`);
    }
  }
  console.log("Capas pendentes:", { encontradas: snap.size, ...cont });
  process.exit(0);
})().catch(e => { console.error("Falha geral nas capas:", e); process.exit(1); });
