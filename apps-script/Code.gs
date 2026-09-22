/**
 * 排程項目 · 雲端後端(Google Apps Script)
 *
 * 這一個檔案包含三個功能:
 *  1. 資料儲存:所有需求存成你 Google 雲端硬碟裡的一個 JSON 檔(沒有 100KB 限制,雲端硬碟會自動保留歷史版本)
 *  2. Web App:排程項目網站、每日日報透過這裡讀寫資料(需要存取金鑰)
 *  3. Google 表格同步:每 5 分鐘把 KR / DY / LJ 三個系統各自的表格新增 / 修改的需求寫進資料
 *
 * ── 指令碼屬性(專案設定 → 指令碼屬性)──
 *       SHEET_KR、SHEET_DY、SHEET_LJ    各系統 Google 表格網址中 /d/ 與 /edit 之間那串(沒有的系統不用填)
 *       SHEET_KR_NAME …(選填)          該表格的工作表分頁名稱,不填就用第一個分頁
 *       (舊的 SHEET_ID / SHEET_NAME 會當作 KR 系統的表格繼續使用)
 *
 * ── 第一次設定 ──
 *  A. 指令碼屬性填入 JSONBIN_KEY、JSONBIN_BIN_ID(舊資料所在,只用來搬家一次,搬完可刪)與上面的表格 ID
 *  B. 執行 setup:建立雲端硬碟資料檔、從 JSONBin 搬資料、產生存取金鑰(在執行記錄裡)
 *  C. 部署 → 新增部署作業 → 類型「網頁應用程式」,執行身分「我」,存取權「任何人」→ 複製網址
 *  D. 執行 installTrigger:啟用 Google 表格自動同步
 *
 * Telegram 查詢機器人(選用):重新部署後執行 setupTelegramBot,就能在群組用「/ask 關鍵字」查需求進度。
 *
 * 忘記存取金鑰:執行 showAccessToken。懷疑金鑰外洩:執行 rotateAccessToken(之後網站與 GitHub 都要換新金鑰)。
 *
 * 這份檔案是 Apps Script 專案的備份;修改後要貼回 Apps Script 編輯器,並「管理部署作業 → 編輯 → 新版本」重新部署。
 */

const SYNC = {
  VERSION: 3,               // 同步邏輯版本;改版時會讓下一次強制重新比對
  SYSTEMS: ['KR', 'DY', 'LJ'],
  LEGACY_SYSTEM: 'KR',      // 改成多表格之前同步進來、沒有系統的需求,當作這個系統(原本的 SHEET_ID 是 KR 的表格)
  TIMEZONE: 'Asia/Taipei',
  BY: 'Google 表格',        // 修改紀錄裡顯示的操作人
  INTERVAL_MINUTES: 5,      // 可用 1 / 5 / 10 / 15 / 30
  HIST_MAX: 50,
  DATA_FILE_NAME: '排程項目資料.json',
  SKIP_DEVICE: ['LJ'],      // 這些系統的「平台」不併入表格的「裝置」欄
};

/* ========================= 第一次設定 ========================= */

/** 建立資料檔、從 JSONBin 搬資料、產生存取金鑰。可重複執行,不會覆蓋已存在的資料檔。 */
function setup() {
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('FILE_ID')) {
    let rec = { items: [], deleted: [], tg: { token: '', chat: '', time: '09:00', auto: false }, sortMode: 'auto', _rev: 0 };
    const key = (props.getProperty('JSONBIN_KEY') || '').trim(), bin = (props.getProperty('JSONBIN_BIN_ID') || '').trim();
    if (key && bin) {
      const r = UrlFetchApp.fetch('https://api.jsonbin.io/v3/b/' + bin + '/latest', { headers: { 'X-Master-Key': key }, muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) throw new Error('從 JSONBin 讀取舊資料失敗 (' + r.getResponseCode() + '):' + r.getContentText().slice(0, 200));
      rec = JSON.parse(r.getContentText()).record || rec;
      rec._rev = (rec._rev || 0) + 1;
      console.log('已從 JSONBin 讀到 ' + (rec.items || []).length + ' 筆需求');
    } else {
      console.log('沒有設定 JSONBIN_KEY / JSONBIN_BIN_ID,建立空白資料檔');
    }
    const file = DriveApp.createFile(SYNC.DATA_FILE_NAME, JSON.stringify(rec), MimeType.PLAIN_TEXT);
    props.setProperty('FILE_ID', file.getId());
    props.setProperty('REV', String(rec._rev || 0));
    props.deleteProperty('SHEET_HASH');
    console.log('已在雲端硬碟建立資料檔「' + SYNC.DATA_FILE_NAME + '」:' + file.getUrl());
  } else {
    console.log('資料檔已存在,略過建立與搬家(FILE_ID=' + props.getProperty('FILE_ID') + ')');
  }

  if (!props.getProperty('ACCESS_TOKEN')) {
    props.setProperty('ACCESS_TOKEN', newToken());
    console.log('已產生存取金鑰');
  }
  showAccessToken();
}

/** 在執行記錄顯示存取金鑰 */
function showAccessToken() {
  console.log('存取金鑰(網站「雲端同步」與 GitHub Secret GAS_TOKEN 要填這串):\n' +
    PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN'));
}

/** 換一組新的存取金鑰(舊的立即失效) */
function rotateAccessToken() {
  PropertiesService.getScriptProperties().setProperty('ACCESS_TOKEN', newToken());
  showAccessToken();
}

function newToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

/* ========================= 資料儲存(雲端硬碟) ========================= */

function dataFile() {
  const id = PropertiesService.getScriptProperties().getProperty('FILE_ID');
  if (!id) throw new Error('尚未設定,請先執行 setup');
  return DriveApp.getFileById(id);
}

function readStore() {
  const s = dataFile().getBlob().getDataAsString('UTF-8');
  return s ? JSON.parse(s) : { items: [], deleted: [], _rev: 0 };
}

/** 寫入並把版本號 +1(呼叫前要先拿到 script lock) */
function writeStore(rec, curRev) {
  rec._rev = (curRev || 0) + 1;
  rec._updated = new Date().toISOString();
  dataFile().setContent(JSON.stringify(rec));
  PropertiesService.getScriptProperties().setProperty('REV', String(rec._rev));
  return rec._rev;
}

/* ========================= Web App(網站、日報呼叫) ========================= */
// 請求一律用 POST,內容為 JSON 文字:{ k:存取金鑰, op:'rev'|'read'|'write', record?, ifRev? }

function doGet() {
  return json({ ok: true, app: '排程項目', note: '請用 POST 並附上存取金鑰' });
}

function doPost(e) {
  // Telegram 機器人的訊息(webhook 網址帶 ?tg=密語),見下方「Telegram 查詢機器人」
  if (e && e.parameter && e.parameter.tg != null) return handleTelegramUpdate(e);
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json({ ok: false, error: '請求格式錯誤', status: 400 }); }

  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('ACCESS_TOKEN');
  if (!token || req.k !== token) return json({ ok: false, error: 'unauthorized', status: 401 });

  try {
    if (req.op === 'rev') return json({ ok: true, rev: Number(props.getProperty('REV') || 0) });
    if (req.op === 'read') return json({ ok: true, record: readStore() });
    if (req.op === 'write') {
      const rec = req.record;
      if (!rec || !Array.isArray(rec.items)) return json({ ok: false, error: '資料格式錯誤', status: 400 });
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const cur = readStore(), curRev = cur._rev || 0;
        // 只有在對方讀取後沒人寫過時才寫入;否則回傳 conflict,讓網站重新讀取、合併後再送
        if (req.ifRev != null && Number(req.ifRev) !== curRev) return json({ ok: false, conflict: true, rev: curRev });
        return json({ ok: true, rev: writeStore(rec, curRev) });
      } finally { lock.releaseLock(); }
    }
    return json({ ok: false, error: '未知的操作', status: 400 });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err), status: 500 });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ========================= Google 表格同步 ========================= */

/** 各系統的表格設定(沒填 ID 的系統略過;舊的 SHEET_ID 當作 KR) */
function sheetConfigs(props) {
  return SYNC.SYSTEMS.map(sys => {
    let id = (props.getProperty('SHEET_' + sys) || '').trim();
    let name = (props.getProperty('SHEET_' + sys + '_NAME') || '').trim();
    if (!id && sys === SYNC.LEGACY_SYSTEM) {
      id = (props.getProperty('SHEET_ID') || '').trim();
      name = name || (props.getProperty('SHEET_NAME') || '').trim();
    }
    return { sys, id, name };
  }).filter(c => c.id);
}

/** 立即同步一次(排程也是呼叫這個) */
function syncNow() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FILE_ID')) throw new Error('尚未設定,請先執行 setup');
  const sheets = sheetConfigs(props);
  if (!sheets.length) throw new Error('請在「專案設定 → 指令碼屬性」填入 SHEET_KR / SHEET_DY / SHEET_LJ(表格 ID)');

  // 讀表格可能要幾十秒,先在鎖外面讀完,避免網站儲存時要排隊等;某一份讀取失敗不影響其他份
  const pending = [], errors = [];
  sheets.forEach(cfg => {
    const tag = '[' + cfg.sys + '] ';
    try {
      const t0 = Date.now();
      const ss = SpreadsheetApp.openById(cfg.id);
      const sh = cfg.name ? ss.getSheetByName(cfg.name) : ss.getSheets()[0];
      if (!sh) throw new Error('找不到工作表分頁:' + cfg.name);
      const range = sh.getDataRange();
      const parsed = readSheetRows({
        system: cfg.sys,
        values: range.getValues(),
        display: range.getDisplayValues(),
        rich: range.getRichTextValues(),
        formulas: range.getFormulas(),
        fmtDate: d => Utilities.formatDate(d, SYNC.TIMEZONE, 'yyyy-MM-dd'),
      });
      console.log(tag + '讀取表格 ' + range.getNumRows() + ' 列 × ' + range.getNumColumns() + ' 欄,花費 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
      console.log(tag + '使用的欄位:' + parsed.columns.used.join('、') +
        (parsed.columns.unused.length ? ';未使用:' + parsed.columns.unused.join('、') : '') +
        (parsed.columns.rankMode ? '(優先級是數字 → 當作「順位」)' : ''));
      parsed.warnings.forEach(w => console.warn(tag + w));

      // 這份表格內容沒變就不處理
      const hash = sha256(JSON.stringify({ v: SYNC.VERSION, file: props.getProperty('FILE_ID'), sys: cfg.sys, sheet: cfg.id, rows: parsed.rows }));
      if (hash === props.getProperty('SHEET_HASH_' + cfg.sys)) { console.log(tag + '表格沒有變動'); return; }
      pending.push({ cfg, parsed, hash });
    } catch (e) {
      console.error(tag + '讀取失敗:' + (e && e.message || e));
      errors.push(tag + (e && e.message || e));
    }
  });

  let blocked = [], tg = null, saved = false;
  if (pending.length) {
    // 只有「讀資料 → 套用 → 寫回」這一小段需要鎖
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) { console.log('網站正在寫入資料,略過這次,下次排程再同步'); return; }
    try {
      const rec = readStore(), curRev = rec._rev || 0;
      const today = Utilities.formatDate(new Date(), SYNC.TIMEZONE, 'yyyy-MM-dd');
      let changed = false;
      pending.forEach(p => {
        const res = applySheetRows(rec, p.parsed.rows, Date.now(), today, p.cfg.sys);
        res.warnings.forEach(w => console.warn('[' + p.cfg.sys + '] ' + w));
        changed = changed || res.changed;
        blocked = blocked.concat(res.blocked);
        console.log('[' + p.cfg.sys + '] 同步完成:新增 ' + res.stats.created + ' 筆、更新 ' + res.stats.updated + ' 筆、首次對應 ' + res.stats.linked +
          ' 筆、略過(網站已刪除)' + res.stats.skippedDeleted + ' 筆;表格共 ' + p.parsed.rows.length + ' 筆有編號的需求');
      });
      if (changed) { writeStore(rec, curRev); saved = true; }
      pending.forEach(p => props.setProperty('SHEET_HASH_' + p.cfg.sys, p.hash));
      props.deleteProperty('SHEET_HASH'); // 舊版單一表格用的,不再需要
      tg = rec.tg || {};
    } finally {
      lock.releaseLock();
    }
  }
  // 表格改成「阻塞」:寫入成功後推 Telegram(在鎖外面送,不耽誤網站儲存)
  if (saved && blocked.length) notifyBlockedFromSheet(blocked, tg);
  if (errors.length) throw new Error('部分表格讀取失敗:' + errors.join(' / '));
}

/** 啟用 Google 表格自動同步(每 N 分鐘),並立即同步一次 */
function installTrigger() {
  if (!PropertiesService.getScriptProperties().getProperty('FILE_ID')) throw new Error('尚未設定,請先執行 setup');
  removeTrigger();
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(SYNC.INTERVAL_MINUTES).create();
  console.log('已啟用自動同步:每 ' + SYNC.INTERVAL_MINUTES + ' 分鐘');
  syncNow();
}

/** 停用 Google 表格自動同步 */
function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncNow')
    .forEach(t => ScriptApp.deleteTrigger(t));
  console.log('已停用自動同步');
}

/** 讓下一次同步重新比對整張表 */
function resetSyncState() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SHEET_HASH');
  SYNC.SYSTEMS.forEach(sys => props.deleteProperty('SHEET_HASH_' + sys));
  console.log('已重置,下一次同步會重新比對整張表');
}

/* ========================= Telegram 阻塞通知 ========================= */
// Bot Token / Chat ID 用網站「Telegram 通知」裡設定的(會同步到資料檔);
// 網站上關掉「阻塞立即通知」時這裡也不送

function notifyBlockedFromSheet(list, tg) {
  const token = String(tg.token || '').trim(), chat = String(tg.chat || '').trim();
  if (!token || !chat) { console.log('有 ' + list.length + ' 筆改成阻塞,但網站尚未設定 Telegram,略過通知'); return; }
  if (tg.blockAlert === false) { console.log('網站關閉了「阻塞立即通知」,略過 ' + list.length + ' 筆'); return; }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  let msg = '🚧 <b>需求阻塞</b>(Google 表格同步)';
  list.forEach(t => {
    msg += '\n\n[' + tgEsc(t.ticket || '—') + '] ' + tgEsc(clip(t.title, 150)) + '\n';
    msg += '系統:' + tgEsc(t.system || '—') + (/^P[0-2]$/.test(t.priority || '') ? ' · 優先級:' + t.priority : '') + (t.pm ? ' · PM:' + tgEsc(t.pm) : '');
    if (t.note) msg += '\n卡點:' + tgLinkify(clip(String(t.note).split('\n')[0], 200));
  });
  splitTg(msg).forEach(part => {
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (r.getResponseCode() !== 200) console.error('阻塞通知傳送失敗 (' + r.getResponseCode() + '):' + r.getContentText().slice(0, 200));
  });
  console.log('已推送阻塞通知:' + list.map(t => t.ticket).join('、'));
}

// Telegram HTML 模式:使用者輸入的文字必須轉義 & < >,否則整則訊息會被拒收
function tgEsc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function safeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  return /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : '';
}
// [顯示文字](網址) 轉成 Telegram 連結,其餘文字轉義
function tgLinkify(s) {
  s = String(s == null ? '' : s);
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    const href = safeUrl(m[2]);
    out += tgEsc(s.slice(last, m.index)) + (href ? '<a href="' + href.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' + tgEsc(m[1]) + '</a>' : tgEsc(m[0]));
    last = m.index + m[0].length;
  }
  return out + tgEsc(s.slice(last));
}
// Telegram 單則上限 4096 字:依換行拆成多則
function splitTg(text, max) {
  max = max || 3900;
  const parts = [];
  let cur = '';
  String(text).split('\n').forEach(line => {
    while (line.length > max) { if (cur) { parts.push(cur); cur = ''; } parts.push(line.slice(0, max)); line = line.slice(max); }
    if (cur.length + line.length + 1 > max) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  });
  if (cur.trim()) parts.push(cur);
  return parts;
}

function sha256(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

/* ========================= 讀取表格 ========================= */

// 表頭名稱(去掉空白、斜線、括號說明、大小寫後比對),繁簡都認;三個系統的表格寫法都列在這裡
const HEADER_ALIASES = {
  ticket:   ['id/ticket', 'idticket', 'ticket', 'id', '項次', '项次'],
  priority: ['優先級', '优先级', '優先度', '优先度'],
  submit:   ['提交日期'],
  category: ['類別', '类别', '前/後台', '前/后台'],
  rawDesc:  ['問題描述/功能需求', '问题描述/功能需求', '問題描述', '问题描述', '功能需求', '修正項目', '修正项目'],
  pagePath: ['頁面位置', '页面位置'],
  doc:      ['文件', '文件連結', '文件链接', '連結', '链接', '連接', '连接'],
  unit:     ['需求單位', '需求单位', '反饋人員', '反馈人员'],
  pm:       ['負責pm', '负责pm', 'pm'],
  status:   ['目前狀態', '目前状态', '狀態', '状态'],
  due:      ['預計上線日', '预计上线日', '預計上線', '预计上线', '期望完成日', '期望完成日期', 'deadline'],
  note:     ['技術回復', '技术回复', '技術回覆', '技术回覆'],
  gmNote:   ['gm備註', 'gm备注'],
  platform: ['平台'],
  device:   ['裝置', '装置'],
};
const LINK_TEXT_FIELDS = { rawDesc: 1, note: 1, gmNote: 1 };
const DATE_FIELDS = { submit: 1, due: 1 };
const STATUS_MAP = {
  '待評估': '待評估', '待评估': '待評估', '開發中': '開發中', '开发中': '開發中',
  '待測試': '待測試', '待测试': '待測試', '阻塞': '阻塞', '已上線': '已上線', '已上线': '已上線',
  '未釐清': '未釐清', '未厘清': '未釐清', '釐清中': '釐清中', '厘清中': '釐清中',
  '暫停開發': '暫停開發', '暂停开发': '暫停開發',
};

// 括號裡的補充說明不算,例:「修正項目(請詳細說明問題及期望結果)」→「修正項目」
function normHeader(s) { return String(s || '').replace(/[（(][^）)]*[）)]/g, '').toLowerCase().replace(/[\s\/／_\-]/g, ''); }
function tkey(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }

/**
 * 解析整張表。傳入 getValues / getDisplayValues / getRichTextValues / getFormulas 的結果。
 * src.system:這份表格屬於哪個系統(KR/DY/LJ),每一列都標上這個系統。
 * 回傳 { rows:[{ticket,priority 或 rank,...}], warnings:[], columns:{used,unused,rankMode} };rows 只含表格中實際存在的欄位。
 */
function readSheetRows(src) {
  const { values, display, rich, formulas, fmtDate } = src;
  const warnings = [];
  const systemLabel = src.system ? src.system + '系統' : '';

  // 在前 10 列裡找表頭(同時有 ID/Ticket 與 優先級或問題描述 的那一列)
  let headerRow = -1, cols = {};
  for (let r = 0; r < Math.min(10, display.length); r++) {
    const map = {};
    display[r].forEach((h, c) => {
      const n = normHeader(h);
      if (!n) return;
      for (const f in HEADER_ALIASES) if (map[f] === undefined && HEADER_ALIASES[f].some(a => normHeader(a) === n)) { map[f] = c; break; }
    });
    if (map.ticket !== undefined && (map.priority !== undefined || map.rawDesc !== undefined)) { headerRow = r; cols = map; break; }
  }
  if (headerRow < 0) throw new Error('找不到表頭列:前 10 列裡需要有「ID / Ticket」或「項次」,以及「優先級」或「問題描述 / 修正項目」');

  const usedCols = {};
  Object.keys(cols).forEach(f => { usedCols[cols[f]] = 1; });
  const headerText = c => String(display[headerRow][c] || '').replace(/\s+/g, '');
  const columns = {
    used: Object.keys(cols).map(f => headerText(cols[f])),
    unused: display[headerRow].map((h, c) => usedCols[c] ? '' : headerText(c)).filter(Boolean),
    rankMode: false,
  };

  // 優先級欄填的是純數字(1、2、3…)= 排序順位;填 P0/P1/P2 = 等級。以這份表格裡多數的寫法為準
  if (cols.priority !== undefined) {
    let nums = 0, levels = 0;
    for (let r = headerRow + 1; r < display.length; r++) {
      const v = String(display[r][cols.priority] || '').trim();
      if (/^\d+$/.test(v)) nums++; else if (/^P\s*[0-3]/i.test(v)) levels++;
    }
    columns.rankMode = nums > levels;
  }

  const rows = [], seen = {};
  for (let r = headerRow + 1; r < display.length; r++) {
    const get = f => cols[f] === undefined ? undefined : readCell(f, r, cols[f]);
    const ticket = (get('ticket') || '').trim();
    const hasContent = display[r].some(v => String(v).trim());
    if (!ticket) { if (hasContent) warnings.push('第 ' + (r + 1) + ' 列沒有 ID / Ticket,已略過'); continue; }
    const key = tkey(ticket);
    if (seen[key]) { warnings.push('第 ' + (r + 1) + ' 列的 Ticket「' + ticket + '」與第 ' + seen[key] + ' 列重複,已略過'); continue; }
    seen[key] = r + 1;

    const row = { ticket };
    if (systemLabel) row.system = systemLabel;
    if (cols.priority !== undefined) {
      if (columns.rankMode) {
        const v = (get('priority') || '').trim();
        row.rank = /^\d+$/.test(v) ? String(Number(v)) : '';
        if (v && !/^\d+$/.test(v)) warnings.push('第 ' + (r + 1) + ' 列的順位「' + v + '」不是數字,先留空');
      } else {
        // 空白或認不出的優先級不同步(不會把網站上填好的清掉,也不會動到舊的「不確定」資料)
        const p = normPriority(get('priority'));
        if (p) row.priority = p;
      }
    }
    if (cols.submit !== undefined) row.submit = get('submit');
    if (cols.category !== undefined) row.category = get('category');
    if (cols.doc !== undefined) row.doc = get('doc');
    if (cols.unit !== undefined) row.unit = get('unit');
    if (cols.pm !== undefined) row.pm = get('pm');
    if (cols.due !== undefined) row.due = get('due');
    if (cols.note !== undefined) row.note = get('note');
    if (cols.gmNote !== undefined) row.gmNote = get('gmNote');
    // 狀態空白 = 這一列不同步狀態(剛加上狀態欄、還沒填完時,不會把網站上的狀態改回待評估)
    if (cols.status !== undefined) {
      const raw = (get('status') || '').trim();
      if (raw) {
        row.status = STATUS_MAP[raw] || '待評估';
        if (!STATUS_MAP[raw]) warnings.push('第 ' + (r + 1) + ' 列的狀態「' + raw + '」不在網站的狀態清單裡,先當作「待評估」');
      }
    }
    if (cols.rawDesc !== undefined) {
      const d = splitDesc(get('rawDesc') || '');
      row.title = d.title || '(未填標題)';
      // 「頁面位置」放在問題描述最前面一行
      const page = cols.pagePath !== undefined ? (get('pagePath') || '').trim() : '';
      row.desc = [page ? '頁面位置：' + page : '', d.desc].filter(Boolean).join('\n');
      if (d.platform || cols.platform === undefined) row.platform = d.platform || '';
    }
    if (cols.platform !== undefined && row.platform === undefined) row.platform = (get('platform') || '').trim();
    // 「裝置」併進平台,例:XO · PC(SKIP_DEVICE 裡的系統不併)
    if (cols.device !== undefined && SYNC.SKIP_DEVICE.indexOf(src.system) < 0) {
      const dev = (get('device') || '').trim();
      row.platform = [row.platform || '', dev].filter(Boolean).join(' · ');
    }
    Object.keys(row).forEach(k => { if (row[k] == null) row[k] = ''; });
    rows.push(row);
  }
  return { rows, warnings, columns };

  function readCell(f, r, c) {
    const v = values[r][c], disp = String(display[r][c] == null ? '' : display[r][c]);
    if (DATE_FIELDS[f]) return toYmd(v, disp, fmtDate);
    const fm = parseHyperlinkFormula(formulas && formulas[r] && formulas[r][c]);
    if (f === 'doc') {
      if (fm) return fm.url;
      const links = richLinks(rich && rich[r] && rich[r][c]);
      return (links[0] || disp).trim();
    }
    if (LINK_TEXT_FIELDS[f]) {
      if (fm) return fm.label && fm.label !== fm.url ? '[' + cleanLabel(fm.label) + '](' + fm.url + ')' : fm.url;
      const t = richToText(rich && rich[r] && rich[r][c]);
      return (t == null ? disp : t).replace(/\r\n/g, '\n').trim();
    }
    return disp.trim();
  }
}

function toYmd(v, disp, fmtDate) {
  if (v instanceof Date && !isNaN(v)) return fmtDate(v);
  const m = String(disp || '').match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
}

function parseHyperlinkFormula(f) {
  const m = String(f || '').match(/^=\s*HYPERLINK\(\s*"([^"]+)"\s*(?:[,;]\s*"([^"]*)")?/i);
  return m ? { url: m[1], label: m[2] || '' } : null;
}

function cleanLabel(s) { return String(s).replace(/[\[\]]/g, '').trim(); }

// 儲存格裡的超連結文字 → [文字](網址);相鄰且連到同一網址的片段合併
function richToText(rtv) {
  if (!rtv || typeof rtv.getRuns !== 'function') return null;
  const parts = [];
  rtv.getRuns().forEach(run => {
    const text = run.getText(), url = run.getLinkUrl();
    const last = parts[parts.length - 1];
    if (last && last.url === url) last.text += text; else parts.push({ text, url });
  });
  return parts.map(p => {
    if (!p.url || !p.text.trim()) return p.text;
    if (p.text.trim() === p.url) return p.text;
    const lead = p.text.match(/^\s*/)[0], trail = p.text.match(/\s*$/)[0];
    return lead + '[' + cleanLabel(p.text) + '](' + p.url + ')' + trail;
  }).join('');
}

function richLinks(rtv) {
  if (!rtv || typeof rtv.getRuns !== 'function') return [];
  return rtv.getRuns().map(r => r.getLinkUrl()).filter(Boolean);
}

function normPriority(s) {
  s = String(s || '');
  const m = s.match(/P\s*([0-2])/i);
  return m ? 'P' + m[1] : ''; // 優先級是選填,認不出就當未填
}

// 「問題描述」拆成 平台 / 標題 / 描述:
//   開發平台:ALL(TD要優先對接)   ← 平台
//   [第三方]電子錢包開發-988錢包   ← 標題(平台行之外的第一行)
//   其餘各行                       ← 問題描述
function splitDesc(text) {
  const lines = String(text || '').split(/\r?\n/);
  let platform = '';
  const rest = [];
  lines.forEach(l => {
    const m = !platform && l.trim().match(/^(?:開發|开发)?平[台臺]\s*[:：]\s*(.*)$/);
    if (m) platform = m[1].trim(); else rest.push(l);
  });
  while (rest.length && !rest[0].trim()) rest.shift();
  const title = (rest.shift() || '').trim();
  return { platform, title, desc: rest.join('\n').trim() };
}

/* ========================= 寫入網站資料 ========================= */

const SYNC_FIELDS = ['ticket', 'priority', 'rank', 'system', 'platform', 'title', 'desc', 'category', 'status',
  'unit', 'pm', 'submit', 'due', 'doc', 'note', 'gmNote'];
const LONG_FIELDS = { desc: 1, note: 1, gmNote: 1 };

// 網站上一筆需求屬於哪個系統:同步時記下的 _sys → 「系統」欄 → 都沒有就當作改版前的那一份(KR)
function itemSystem(t) {
  if (t._sys) return t._sys;
  const m = String(t.system || '').match(/^(KR|DY|LJ)/i);
  return m ? m[1].toUpperCase() : SYNC.LEGACY_SYSTEM;
}

/**
 * 把一份表格(sys 系統)的列套用到網站資料上,直接修改 rec。
 * 以「系統 + 編號」對應,所以不同系統的相同編號不會互相覆蓋。
 * 每筆網站需求會記住上次從表格同步的值(_sheet),只有表格裡「改過」的欄位才覆蓋網站。
 */
function applySheetRows(rec, rows, now, today, sys) {
  sys = sys || SYNC.LEGACY_SYSTEM;
  rec.items = rec.items || [];
  rec.deleted = rec.deleted || [];
  const stats = { created: 0, updated: 0, linked: 0, skippedDeleted: 0 };
  const warnings = [];
  let changed = false;
  const blocked = []; // 這次同步被表格改成「阻塞」的需求(包含新增時就是阻塞的)

  const byKey = {};
  rec.items.forEach(t => { const k = tkey(t.ticket); if (k && itemSystem(t) === sys && !byKey[k]) byKey[k] = t; });
  const deletedKeys = {};
  rec.deleted.forEach(d => {
    if (!d) return;
    if (d.item && d.item.ticket && itemSystem(d.item) === sys) deletedKeys[tkey(d.item.ticket)] = 1;
    // 網站刪除超過 60 天後只留下精簡紀錄 { id, at, sheet:{ sys, ticket } },永久保存,避免表格那一列再被加回來
    if (d.sheet && d.sheet.ticket && d.sheet.sys === sys) deletedKeys[tkey(d.sheet.ticket)] = 1;
    if (typeof d.id === 'string' && d.id.indexOf('gs-') === 0) {
      const m = d.id.match(/^gs-(KR|DY|LJ)-(.*)$/);
      const idSys = m ? m[1] : SYNC.LEGACY_SYSTEM, rest = m ? m[2] : d.id.slice(3);
      if (idSys === sys) { try { deletedKeys[decodeURIComponent(rest)] = 1; } catch (e) {} }
    }
  });

  rows.forEach(S => {
    const key = tkey(S.ticket);
    const fields = SYNC_FIELDS.filter(f => S[f] !== undefined);
    let item = byKey[key];

    // 1) 網站上還沒有 → 新增(網站上刪除過的不加回來)
    if (!item) {
      if (deletedKeys[key]) { stats.skippedDeleted++; return; }
      item = { id: 'gs-' + sys + '-' + encodeURIComponent(key), _sys: sys };
      fields.forEach(f => { item[f] = S[f]; });
      if (!item.title) item.title = '(未填標題)';
      if (!item.status) item.status = '待評估';
      item.launched = item.status === '已上線' ? today : null;
      item.updatedAt = now;
      item._ft = {};
      fields.forEach(f => { item._ft[f] = now; });
      item.history = [{ at: now, by: SYNC.BY, field: '_sheet' }];
      item._sheet = pick(S, fields);
      item._sheetAt = now;
      rec.items.push(item);
      byKey[key] = item;
      if (item.status === '阻塞') blocked.push(item);
      stats.created++; changed = true;
      return;
    }
    if (item._sys !== sys) { item._sys = sys; changed = true; }

    // 2) 網站上已有、第一次對應 → 只補上網站上空白的欄位,不覆蓋已有內容
    if (!item._sheet) {
      const changes = [];
      fields.forEach(f => {
        if (!str(item[f]) && str(S[f])) { changes.push(chg(f, '', S[f])); item[f] = S[f]; }
      });
      if (changes.length) { applyStatusSide(item, today); record(item, changes, now); }
      if (item.status === '阻塞' && changes.some(c => c.field === 'status')) blocked.push(item);
      item._sheet = pick(S, fields);
      item._sheetAt = now;
      stats.linked++; changed = true;
      return;
    }

    // 3) 已對應過 → 只把表格裡改過的欄位更新到網站
    const changes = [];
    let snapChanged = false;
    fields.forEach(f => {
      const sv = str(S[f]), last = str(item._sheet[f]);
      if (sv === last && f in item._sheet) return;
      snapChanged = true;
      if (sv === last) return; // 只是新加的欄位,值與上次相同
      if (str(item[f]) !== sv) { changes.push(chg(f, item[f], sv)); item[f] = sv; }
    });
    if (snapChanged) {
      item._sheet = Object.assign({}, item._sheet, pick(S, fields));
      item._sheetAt = now;
      changed = true;
    }
    if (changes.length) {
      if (changes.some(c => c.field === 'status')) applyStatusSide(item, today);
      record(item, changes, now);
      if (item.status === '阻塞' && changes.some(c => c.field === 'status')) blocked.push(item);
      stats.updated++;
    }
  });

  return { changed, stats, warnings, blocked };

  function str(v) { return v == null ? '' : String(v).trim(); }
  function pick(o, keys) { const r = {}; keys.forEach(k => { r[k] = str(o[k]); }); return r; }
  function chg(f, from, to) { return LONG_FIELDS[f] ? { field: f } : { field: f, from: str(from), to: str(to) }; }
  function applyStatusSide(t, day) {
    if (t.status === '已上線') { if (!t.launched) t.launched = day; } else t.launched = null;
  }
  function record(t, changes, at) {
    t._ft = t._ft || {};
    changes.forEach(c => { t._ft[c.field] = at; });
    t.history = (t.history || []).concat(changes.map(c => Object.assign({ at, by: SYNC.BY }, c))).slice(-SYNC.HIST_MAX);
    t.updatedAt = at;
  }
}

/* ========================= Telegram 查詢機器人 ========================= */
// 在日報的 Telegram 群組裡用「/ask 關鍵字」或回覆機器人的訊息來查需求進度(編號、標題關鍵字、PM、系統、狀態…)。
// 只回應網站「Telegram 通知」設定的那個對話,其他人私訊機器人不會回。
// 設定:部署新版本後執行 setupTelegramBot;停用:執行 removeTelegramBot

const BOT = {
  DETAIL_MAX: 3,    // 符合幾筆以內顯示詳細進度,超過改成清單
  LIST_MAX: 15,     // 清單最多列幾筆
};
const BOT_EMOJI = { '待評估': '🟨', '未釐清': '❔', '釐清中': '🔍', '開發中': '🟦', '待測試': '🟪', '暫停開發': '⏸', '阻塞': '🟥', '已上線': '🟩' };
const BOT_HELP = '用 /ask 加上關鍵字查詢需求進度,例如:\n' +
  '/ask 234  (編號)\n/ask 國慶休市  (標題關鍵字)\n/ask KR 逾期\n/ask 重要\n/ask 阻塞\n/ask Amy 開發中  (PM + 狀態)\n\n' +
  '多個關鍵字用空格分開,要全部符合才會列出。也可以直接回覆我的訊息再查。';

/** 第一次設定或換網址 / 換 Bot 後執行:把 Telegram 的訊息轉到這個 Web App */
function setupTelegramBot() {
  const props = PropertiesService.getScriptProperties();
  const token = String((readStore().tg || {}).token || '').trim();
  if (!token) throw new Error('網站還沒設定 Telegram Bot Token');

  // 網址用密語保護,避免別人冒充 Telegram 呼叫
  let secret = props.getProperty('TG_WEBHOOK_SECRET');
  if (!secret) { secret = newToken(); props.setProperty('TG_WEBHOOK_SECRET', secret); }
  const base = String(props.getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl() || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(base)) {
    throw new Error('取不到 Web App 網址(' + base + ')。請在指令碼屬性加 WEBAPP_URL = 部署的網址(/exec 結尾)後再執行');
  }

  const me = tgApi(token, 'getMe', {}).result;
  props.setProperty('TG_BOT_USERNAME', me.username);
  tgApi(token, 'setWebhook', { url: base + '?tg=' + secret, allowed_updates: ['message'], drop_pending_updates: true });
  tgApi(token, 'setMyCommands', { commands: [{ command: 'ask', description: '查詢需求進度,例如 /ask 234 或 /ask 國慶休市' }] });
  console.log('Telegram 查詢機器人已啟用:@' + me.username + '\nWeb App:' + base +
    '\n在群組輸入「/ask 關鍵字」,或回覆機器人的訊息再查。');
}

/** 停用查詢機器人(日報、阻塞通知不受影響) */
function removeTelegramBot() {
  const token = String((readStore().tg || {}).token || '').trim();
  if (token) tgApi(token, 'deleteWebhook', { drop_pending_updates: true });
  console.log('已停用 Telegram 查詢機器人');
}

/** 查看 Telegram 端的連線狀態(有錯誤時看 last_error_message) */
function checkTelegramBot() {
  const token = String((readStore().tg || {}).token || '').trim();
  const info = tgApi(token, 'getWebhookInfo', {}).result;
  if (info.url) info.url = info.url.replace(/tg=[^&]+/, 'tg=***');
  console.log(JSON.stringify(info, null, 2));
}

/**
 * 機器人沒反應時執行:列出 Telegram 那邊卡住的訊息來自哪個對話、會不會被當成查詢,並送一則測試訊息。
 * 先在群組傳「/ask 234」,再執行這個函式,把執行記錄貼給 Claude。
 */
function diagnoseTelegramBot() {
  const props = PropertiesService.getScriptProperties();
  const tg = readStore().tg || {};
  const token = String(tg.token || '').trim(), chat = String(tg.chat || '').trim(), botName = props.getProperty('TG_BOT_USERNAME');
  console.log('網站設定的 Chat ID:' + (chat || '(未設定)') + ' · 機器人:@' + (botName || '(未設定,請先執行 setupTelegramBot)'));

  // 暫時關掉轉接才能讀到卡住的訊息,讀完馬上恢復(不會刪掉訊息)
  const url = tgApi(token, 'getWebhookInfo', {}).result.url;
  if (url) tgApi(token, 'deleteWebhook', { drop_pending_updates: false });
  try {
    const ups = tgApi(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] }).result;
    if (!ups.length) console.log('Telegram 沒有卡住的訊息。請先在群組傳「/ask 234」,馬上再執行一次這個函式');
    ups.forEach(u => {
      const m = u.message;
      if (!m) return;
      const q = botQuestion(m, botName);
      console.log('訊息「' + String(m.text || '(非文字)').slice(0, 50) + '」來自對話 ' + m.chat.id + '(' + m.chat.type + (m.chat.title ? ':' + m.chat.title : '') + ')' +
        '\n  和網站的 Chat ID 相同:' + (String(m.chat.id) === chat ? '是' : '否') +
        ' · 會被當成查詢:' + (q === null ? '否' : '是「' + q + '」'));
    });
  } finally {
    if (url) tgApi(token, 'setWebhook', { url: url, allowed_updates: ['message'] });
  }

  try {
    tgApi(token, 'sendMessage', { chat_id: chat, text: '🔧 查詢機器人診斷:收到這則代表 Bot Token 與 Chat ID 正常' });
    console.log('已送出測試訊息到 ' + chat + ',請看是哪個對話收到');
  } catch (err) { console.log('送出測試訊息失敗:' + err.message); }
}

function tgApi(token, method, payload) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
  });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.ok) throw new Error('Telegram ' + method + ' 失敗:' + (j.description || r.getResponseCode()));
  return j;
}

function handleTelegramUpdate(e) {
  const done = HtmlService.createHtmlOutput('ok');
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('TG_WEBHOOK_SECRET');
  if (!secret || e.parameter.tg !== secret) { console.log('略過:網址密語不符'); return done; }

  let update;
  try { update = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { console.log('略過:內容不是 JSON'); return done; }
  const msg = update.message;
  if (!msg || !msg.text) return done;

  // Telegram 沒收到回應時會重送同一則,記住處理過的,避免重複回答
  const cache = CacheService.getScriptCache();
  if (cache.get('tgu_' + update.update_id)) { console.log('略過:已處理過的重送訊息 ' + update.update_id); return done; }
  cache.put('tgu_' + update.update_id, '1', 21600);

  let token = '';
  try {
    const rec = readStore(), tg = rec.tg || {};
    token = String(tg.token || '').trim();
    if (!token || String(msg.chat.id) !== String(tg.chat || '').trim()) { // 只回應日報那個對話
      console.log('略過:對話 ' + msg.chat.id + ' 不是網站設定的 Chat ID ' + (tg.chat || '(未設定)'));
      return done;
    }

    const q = botQuestion(msg, props.getProperty('TG_BOT_USERNAME'));
    if (q === null) { console.log('略過:不是查詢指令「' + String(msg.text).slice(0, 30) + '」'); return done; }
    console.log('查詢「' + q + '」');
    const today = Utilities.formatDate(new Date(), SYNC.TIMEZONE, 'yyyy-MM-dd');
    botReply(token, msg, q ? botSearch(rec.items || [], q, today) : BOT_HELP);
  } catch (err) {
    console.error('查詢機器人錯誤:' + (err && err.stack || err));
    if (token) { try { botReply(token, msg, '⚠️ 查詢失敗:' + tgEsc(String(err && err.message || err).slice(0, 300))); } catch (e2) {} }
  }
  return done;
}

/** 取出關鍵字;不是問機器人的訊息回傳 null。群組裡用 /ask、@機器人,或回覆機器人的訊息 */
function botQuestion(msg, botName) {
  const text = String(msg.text || '').trim(), name = String(botName || '').toLowerCase();
  const cmd = text.match(/^\/(ask|start|help)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (cmd) {
    if (cmd[2] && cmd[2].toLowerCase() !== name) return null;
    return cmd[1].toLowerCase() === 'ask' ? (cmd[3] || '').trim() : '';
  }
  if (name && text.toLowerCase().indexOf('@' + name) >= 0) return text.replace(new RegExp('@' + name, 'ig'), '').trim();
  const r = msg.reply_to_message;
  if (r && r.from && r.from.is_bot && String(r.from.username || '').toLowerCase() === name) return text;
  if (msg.chat.type === 'private') return text;
  return null;
}

function botReply(token, msg, html) {
  splitTg(html).forEach((part, i) => {
    const p = { chat_id: msg.chat.id, text: part, parse_mode: 'HTML', disable_web_page_preview: true };
    if (i === 0) p.reply_parameters = { message_id: msg.message_id, allow_sending_without_reply: true };
    tgApi(token, 'sendMessage', p);
  });
}

/** 關鍵字的繁體、簡體寫法(用 Google 翻譯轉換;有中文才轉,失敗就只用原字) */
function zhVariants(w) {
  if (!/[一-鿿]/.test(w)) return [];
  const out = [];
  [['zh-TW', 'zh-CN'], ['zh-CN', 'zh-TW']].forEach(p => {
    try { out.push(LanguageApp.translate(w, p[0], p[1])); } catch (err) {}
  });
  return out;
}

/**
 * 關鍵字查詢:多個關鍵字用空格分開,全部符合才列出(不分大小寫)。
 * 比對 編號、標題、系統、狀態、PM、需求單位、平台、類別、描述、技術回復、GM 備註,
 * 另外可用「重要」「逾期」「P0」等標籤。編號完全相同的排最前面,其次標題符合的,已上線的排最後。
 */
function botSearch(items, query, today, variantsOf) {
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
  const tkeyOf = s => norm(s).replace(/^#/, '');
  const terms = String(query).split(/[\s,，、]+/).map(norm).filter(Boolean);
  if (!terms.length) return BOT_HELP;
  // 表格裡有繁體也有簡體:每個關鍵字同時用繁、簡兩種寫法比對
  variantsOf = variantsOf || zhVariants;
  const alts = terms.map(w => [...new Set([w].concat(variantsOf(w).map(norm)))].filter(Boolean));
  const has = (hay, i) => alts[i].some(v => hay.indexOf(v) >= 0);

  const days = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? Math.round((new Date(d + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000) : null;
  const done = t => t.status === '已上線' || t.status === '暫停開發';
  const sysOf = t => { const m = String(t.system || '').match(/^(KR|DY|LJ)/i); return m ? m[1].toUpperCase() : ''; };
  const tags = t => {
    const d = days(t.due), a = [];
    if (t.urgent && !done(t)) a.push('重要');
    if (!done(t) && d !== null && d < 0) a.push('逾期');
    if (!done(t) && d !== null && d >= 0 && d <= 2) a.push('即將到期');
    return a.join(' ');
  };

  const hits = [];
  items.forEach(t => {
    const hay = norm([t.ticket, t.title, t.system, sysOf(t), t.status, t.pm, t.unit, t.platform, t.category,
      /^P[0-2]$/.test(t.priority || '') ? t.priority : '', t.desc, t.note, t.gmNote, tags(t)].join('\n'));
    if (!terms.every((w, i) => has(hay, i))) return;
    const exact = terms.some(w => tkeyOf(t.ticket) && tkeyOf(t.ticket) === w.replace(/^#/, ''));
    const inTitle = terms.every((w, i) => has(norm(t.title), i));
    hits.push({ t, exact, score: (exact ? 0 : inTitle ? 1 : 2) + (t.status === '已上線' ? 10 : 0) });
  });
  if (!hits.length) return '找不到符合「' + tgEsc(query) + '」的需求。\n\n' + BOT_HELP;
  // 只打一個編號時,只顯示編號完全相同的(不列出標題或描述裡剛好含這串數字的)
  if (terms.length === 1 && hits.some(h => h.exact)) hits.splice(0, hits.length, ...hits.filter(h => h.exact));

  const sysIdx = t => { const i = SYNC.SYSTEMS.indexOf(sysOf(t)); return i < 0 ? 9 : i; };
  hits.sort((a, b) => (a.score - b.score) || (sysIdx(a.t) - sysIdx(b.t)) ||
    String(a.t.due || '9999').localeCompare(String(b.t.due || '9999')));
  const list = hits.map(h => h.t);

  const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const ymd = ms => Utilities.formatDate(new Date(ms), SYNC.TIMEZONE, 'MM-dd');
  const dueTag = t => {
    if (t.status === '已上線') return t.launched ? '上線 ' + t.launched : '';
    const d = done(t) ? null : days(t.due);
    return d === null ? '' : d < 0 ? '逾期' + (-d) + '天' : d === 0 ? '今天到期' : '剩' + d + '天';
  };
  const head = t => (sysOf(t) ? sysOf(t) + ' ' : '') + '[' + tgEsc(t.ticket || '—') + '] ' + tgEsc(clip(t.title, 120));

  // 少量:顯示詳細進度
  if (list.length <= BOT.DETAIL_MAX) {
    return list.map(t => {
      let last = Number(t.updatedAt) || 0;
      (t.history || []).forEach(h => { if (h && h.at > last) last = h.at; });
      const st = (t.history || []).filter(h => h && h.field === 'status').slice(-2)
        .map(h => ymd(h.at) + ' ' + tgEsc(h.by || '') + ':' + tgEsc(h.from || '') + '→' + tgEsc(h.to || ''));
      const pri = /^P[0-2]$/.test(t.priority || '') ? t.priority : '';
      const lines = ['🔹 <b>' + head(t) + '</b>'];
      lines.push('狀態:' + (BOT_EMOJI[t.status] || '') + tgEsc(t.status || '—') +
        (t.urgent && !done(t) ? ' · 🔥重要' : '') + (pri ? ' · ' + pri : '') + (parseInt(t.rank, 10) > 0 ? ' · 順位' + parseInt(t.rank, 10) : ''));
      if (t.status === '已上線') { if (t.launched) lines.push('上線日:' + tgEsc(t.launched)); }
      else if (t.due) lines.push('預計上線:' + tgEsc(t.due) + (dueTag(t) ? '(' + dueTag(t) + ')' : ''));
      const who = [t.pm && 'PM:' + tgEsc(t.pm), t.unit && '需求單位:' + tgEsc(t.unit), t.platform && '平台:' + tgEsc(t.platform)].filter(Boolean);
      if (who.length) lines.push(who.join(' · '));
      if (last) lines.push('最後更新:' + ymd(last) + (st.length ? ' · 狀態紀錄:' + st.join(';') : ''));
      if (t.note) lines.push('技術回復:' + tgLinkify(clip(t.note, 400)));
      if (t.gmNote) lines.push('GM 備註:' + tgLinkify(clip(t.gmNote, 300)));
      return lines.join('\n');
    }).join('\n\n');
  }

  // 多筆:清單
  let out = '🔎 「' + tgEsc(query) + '」共 ' + list.length + ' 筆' + (list.length > BOT.LIST_MAX ? ',列出前 ' + BOT.LIST_MAX + ' 筆' : '') + '\n';
  list.slice(0, BOT.LIST_MAX).forEach(t => {
    const tag = dueTag(t);
    out += '• ' + head(t) + ' — ' + (BOT_EMOJI[t.status] || '') + tgEsc(t.status || '—') + (tag ? ' · ' + tag : '') + '\n';
  });
  out += '\n用編號查詢可看詳細進度,例如 /ask ' + tgEsc(String(list[0].ticket || '').replace(/^#/, '') || '編號');
  return out;
}
