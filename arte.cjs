/* =====================================================================
   DESENHOS E SPAM FEITOS COM CARACTERES
   Detecta mensagens que são "desenhos" (arte em braille ⣿, blocos █▓▒, molduras ─│),
   "pixel art" de emojis (🟩🟦⬛), excesso de emojis, muitas linhas de símbolos e textos repetidos.
   A mesma lógica roda no app (antes de enviar); as regras do Firestore têm uma versão mais simples.
   ===================================================================== */
const RE_BRAILLE = /[⠀-⣿]/gu;
const RE_BLOCOS = /[─-◿]/gu;
const RE_EMOJI = /\p{Extended_Pictographic}/gu;
const RE_LETRA = /[\p{L}\p{N}]/u;

// devolve o motivo (texto curto) ou null quando está tudo bem
function motivoArte(texto, maxLinhas = 15) {
  const s = String(texto || "");
  if (!s.trim()) return null;
  const conta = (re) => (s.match(re) || []).length;
  if (conta(RE_BRAILLE) >= 6) return "desenho feito com caracteres (braille)";
  if (conta(RE_BLOCOS) >= 12) return "desenho feito com blocos ou molduras";
  const emojis = conta(RE_EMOJI);
  if (emojis > 30) return "emojis demais (desenho ou spam com emojis)";
  const linhas = s.split("\n");
  if (linhas.length > maxLinhas) return `mais de ${maxLinhas} linhas`;
  // muitas linhas iguais (spam)
  const cheias = linhas.map(l => l.trim()).filter(Boolean);
  const repet = new Map(); cheias.forEach(l => repet.set(l, (repet.get(l) || 0) + 1));
  if (cheias.length >= 5 && Math.max(...repet.values()) >= 5) return "a mesma linha repetida muitas vezes";
  // o mesmo caractere repetido sem parar
  if (/(.)\1{39,}/su.test(s.replace(/\s/g, ""))) return "o mesmo caractere repetido muitas vezes";
  // "arte ASCII": muitos símbolos e poucas letras
  const visiveis = Array.from(s.replace(/\s/g, ""));
  const letras = visiveis.filter(c => RE_LETRA.test(c)).length;
  if (visiveis.length >= 60 && (letras + emojis) / visiveis.length < 0.4) return "desenho feito com símbolos";
  if (linhas.length >= 5 && visiveis.length >= 25) {
    // várias linhas quase sem letras = desenho
    const linhasDeSimbolo = cheias.filter(l => { const v = Array.from(l.replace(/\s/g, "")); return v.length >= 4 && v.filter(c => RE_LETRA.test(c)).length / v.length < 0.35; }).length;
    if (linhasDeSimbolo >= 3 && linhasDeSimbolo * 2 >= cheias.length) return "desenho feito com símbolos";
  }
  return null;
}
module.exports = { motivoArte };
