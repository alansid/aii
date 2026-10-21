// C-367 重現測試（W-3）：團隊缺某個角色時，AI 自己補位（PO 直接設計畫面）；規格與接入設定都沒寫缺角色怎麼辦
// 修正後：規格 2.3 與接入設定第七節都寫「專案沒有該角色不自己補位，發 [需確認]（加人／授權我暫代／先不做），回覆前不動手」
// 短版接入下載的是同一份完整接入設定（/api/setup/:key → onboardingText），所以只查這兩處
// 長度上限由 doc-rules-test 檢查（接入設定 ≤ 5,000、規格 ≤ 20,000）
import fs from 'node:fs';
import assert from 'node:assert';

const core = fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
const rule = /缺該角色也不補位|沒有的角色時，不自己補位/;
const opts = /加人[、／]授權我暫代[、／]先不做/;
try {
  const sec7 = core.slice(core.indexOf('## 七、要不要回？'), core.indexOf('## 八、'));
  assert.ok(rule.test(sec7) && opts.test(sec7) && sec7.includes('回覆前不動手'), '接入設定第七節要有缺角色先問');
  const sec2 = spec.slice(spec.indexOf('## 2. 能力與授權前提'), spec.indexOf('## 3. 端點'));
  assert.ok(rule.test(sec2) && opts.test(sec2) && sec2.includes('回覆前不動手'), '規格 2.3 要有缺角色先問');
  assert.ok(/\/api\/setup\/:key[\s\S]{0,2500}onboardingText\(/.test(core), '短版接入下載的是完整接入設定');
  console.log('c367-test：全部通過');
} catch (e) {
  console.error('c367-test 失敗：', e.message);
  process.exitCode = 1;
}
