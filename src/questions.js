// C-148／C-297 [需確認] 的選項解析（網頁 public/app.js 有同一份，questions-test 會比對兩邊結果一致）
// 規則：看過「選項：」或「問題N：」之後，緊接 2～6 行 A.～F.／①～⑥ 就是選項。
//   - 「問題N：」下面直接列 A.～F.（漏寫「選項：」）也算（C-297）
//   - 「選項：」寫在「問題N：」前面也算（C-297）
//   - 只有「問題N：」提示、但這題後面另有「選項：」時，以「選項：」底下那組為準（前面的 ①② 當說明文字）
// 回傳 [{ no, title, opts: [{ key, label }], named }]
export const OPT_LETTER = /^\s*(?:[（(]([A-F])[）)]|([A-F])\s*[.、:：）)])\s*(\S.*)$/;
export const OPT_CIRCLE = /^\s*([①②③④⑤⑥])\s*(\S.*)$/;
export const OPT_HEAD = /^\s*選項\s*[:：]\s*$/;
export const Q_HEAD = /^\s*問題\s*(\d+)\s*[:：]\s*(.*)$/;
export function parseQuestions(text) {
  const lines = String(text).split('\n'), out = [];
  let lastQ = null, lastEnd = -1, cue = null; // cue：上一組選項之後看過的提示（'opt'＝選項：、'q'＝問題N：）
  for (let i = 0; i < lines.length; i++) {
    const qh = Q_HEAD.exec(lines[i]);
    if (qh) { lastQ = { no: Number(qh[1]), title: qh[2].trim(), at: i }; if (cue !== 'opt') cue = 'q'; continue; }
    if (OPT_HEAD.test(lines[i])) { cue = 'opt'; continue; }
    if (!cue) continue;
    const opts = [];
    let j = i;
    for (; j < lines.length && opts.length < 7; j++) {
      const a = OPT_LETTER.exec(lines[j]), c = OPT_CIRCLE.exec(lines[j]);
      if (a) opts.push({ key: a[1] || a[2], label: a[3].trim() });
      else if (c) opts.push({ key: c[1], label: c[2].trim() });
      else break;
    }
    if (!opts.length) continue;
    if (cue === 'q') { // 只有「問題N：」提示：這題後面（下一個「問題N：」之前）還有「選項：」就跳過這組
      let k = j, later = false;
      for (; k < lines.length && !Q_HEAD.test(lines[k]); k++) if (OPT_HEAD.test(lines[k])) { later = true; break; }
      if (later) { i = j - 1; continue; }
    }
    const keys = opts.map(o => o.key);
    if (opts.length >= 2 && opts.length <= 6 && new Set(keys).size === keys.length) {
      const q = lastQ && lastQ.at > lastEnd ? lastQ : null;
      out.push({ no: q ? q.no : out.length + 1, title: q ? q.title : '', opts, named: !!q });
      lastEnd = j - 1;
      cue = null;
    }
    i = j - 1;
  }
  return out;
}
// [需確認] 有 A./B. 條列卻沒變成按鈕（或有題目沒解析到選項）：回給發文的 AI，請它照 3.9.1 重發
export function optionWarnings(text) {
  if (!/^\s*(?:\[[^\]\n]{0,12}\]\s*)*\[需確認\]/.test(String(text))) return [];
  const lines = String(text).split('\n');
  const optLike = lines.filter(l => OPT_LETTER.test(l)).length;
  const qs = parseQuestions(text), heads = new Set(lines.map(l => Q_HEAD.exec(l)?.[1]).filter(Boolean));
  const missing = [...heads].filter(n => !qs.some(q => q.named && String(q.no) === n));
  if (optLike >= 2 && !qs.length) return ['這則 [需確認] 有 A./B. 選項，但沒有變成按鈕：每題用「問題N：」開頭，下一行寫「選項：」，再緊接 2～6 行 A.～F.（中間不要空行、不要加粗或項目符號）。訊息已送出，請照規格 3.9.1 重發一次。'];
  if (missing.length && optLike >= 2) return [`這則 [需確認] 的問題${missing.join('、')}沒有解析到選項（不會出按鈕）：請在該題下一行寫「選項：」，再緊接 2～6 行 A.～F.，照規格 3.9.1 重發一次。`];
  return [];
}
