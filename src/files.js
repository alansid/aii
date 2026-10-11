// 上傳文件的檢查規則（需求 v1.1）：白名單、檔頭比對、Office 巨集檢查。
// 只依賴標準 Web API，本機與 Cloudflare Workers 共用。

export const MAX_FILE_BYTES = 2 * 1024 * 1024;         // 單檔 2 MB（檔案存 D1）
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 總容量 4 GB（D1 免費額度 5 GB，留空間給訊息）

// 副檔名 → MIME 與檢查方式
export const ALLOWED = {
  pdf: { mime: 'application/pdf', check: 'pdf' },
  png: { mime: 'image/png', check: 'png' },
  jpg: { mime: 'image/jpeg', check: 'jpg' },
  jpeg: { mime: 'image/jpeg', check: 'jpg' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: 'office', folder: 'word/' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: 'office', folder: 'xl/' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: 'office', folder: 'ppt/' },
  txt: { mime: 'text/plain; charset=utf-8', check: 'text' },
  md: { mime: 'text/markdown; charset=utf-8', check: 'text' },
};
export const ALLOWED_LIST = 'pdf、docx、xlsx、pptx、md、txt、png、jpg';

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

// 讀 zip 中央目錄，回傳所有內部檔名；格式不對回傳 null
export function zipEntryNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

export class FileRejected extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// 依副檔名檢查內容；不通過丟出 FileRejected
export function inspectFile(name, bytes) {
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) throw new FileRejected(415, 'FILE_TYPE_NOT_ALLOWED', `不允許的檔案類型「.${ext || '（無副檔名）'}」，只接受：${ALLOWED_LIST}`);
  if (!bytes.length) throw new FileRejected(400, 'INVALID_REQUEST', '檔案是空的');
  if (bytes.length > MAX_FILE_BYTES) throw new FileRejected(413, 'FILE_TOO_LARGE', `檔案超過 2 MB 上限（${(bytes.length / 1048576).toFixed(1)} MB）`);

  const mismatch = () => new FileRejected(415, 'FILE_SIGNATURE_MISMATCH', `檔案內容與副檔名 .${ext} 不符（可能是改名偽裝的檔案）`);
  switch (rule.check) {
    case 'pdf': if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw mismatch(); break;
    case 'png': if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw mismatch(); break;
    case 'jpg': if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw mismatch(); break;
    case 'office': {
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw mismatch();
      const names = zipEntryNames(bytes);
      if (!names || !names.includes('[Content_Types].xml') || !names.some(n => n.startsWith(rule.folder))) throw mismatch();
      if (names.some(n => /vbaproject/i.test(n))) {
        throw new FileRejected(415, 'OFFICE_MACRO_NOT_ALLOWED', '檔案含巨集（vbaProject），不允許上傳');
      }
      break;
    }
    case 'text': {
      // 純文字沒有檔頭可比對：只擋掉明顯的二進位內容；是否含程式碼靠聲明與稽核把關
      if (bytes.includes(0)) throw mismatch();
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new FileRejected(415, 'FILE_SIGNATURE_MISMATCH', `.${ext} 檔需為 UTF-8 純文字`); }
      break;
    }
  }
  return { ext, mime: rule.mime };
}

// 檔名清理：去掉路徑與控制字元，限制長度
export function cleanFileName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!base) return '';
  const m = base.match(/^(.*?)(\.[A-Za-z0-9]+)?$/);
  return (m[1].slice(0, 100) + (m[2] || '')).trim();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
