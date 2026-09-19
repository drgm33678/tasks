// 排程項目 → Telegram
//   node send-digest.js          每日日報(逾期 / 阻塞)
//   node send-digest.js weekly   每週一的技術追蹤清單
// 由 GitHub Actions 定時執行。所有密鑰從環境變數(GitHub Secrets)讀取。
// 需要 Node 18+（GitHub runner 內建 fetch）。

const MODE = (process.argv[2] || process.env.DIGEST_MODE || "daily").toLowerCase();

const GAS_URL   = process.env.GAS_URL;   // Apps Script Web App 網址
const GAS_TOKEN = process.env.GAS_TOKEN; // 存取金鑰
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT  = process.env.TELEGRAM_CHAT_ID;
const TZ_OFFSET = 8; // 台灣 UTC+8。若在其他時區，改成你的時差。

const STATUSES = ["待評估", "未釐清", "釐清中", "開發中", "待測試", "暫停開發", "阻塞", "已上線"];
const S_EMOJI = { "待評估": "🟨", "未釐清": "❔", "釐清中": "🔍", "開發中": "🟦", "待測試": "🟪", "暫停開發": "⏸", "阻塞": "🟥", "已上線": "🟩" };
const NO_OVERDUE = { "已上線": 1, "暫停開發": 1 }; // 不列入即將到期 / 逾期
const PRI_LABEL = { P0: "P0", P1: "P1", P2: "P2", TBD: "不確定" };

function localToday() {
  // 把 UTC 時間平移到當地時區，取 YYYY-MM-DD
  const d = new Date(Date.now() + TZ_OFFSET * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function daysLeft(due, today) {
  if (!due) return null;
  const a = new Date(due + "T00:00:00Z");
  const b = new Date(today + "T00:00:00Z");
  return Math.round((a - b) / 86400000);
}
// Telegram HTML 模式:使用者輸入的文字必須轉義 & < >,否則整則訊息會被拒收
function tgEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
// 只允許 http/https 連結;沒寫協定的自動補 https://
function safeUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    return (x.protocol === "http:" || x.protocol === "https:") ? x.href : "";
  } catch (e) { return ""; }
}
// 技術回復裡的 [顯示文字](網址) 轉成 Telegram 連結,其餘文字轉義(直接貼的網址 Telegram 會自動變連結)
function tgLinkify(s) {
  s = String(s == null ? "" : s);
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(s))) {
    const href = safeUrl(m[2]);
    out += tgEsc(s.slice(last, m.index)) +
      (href ? `<a href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${tgEsc(m[1])}</a>` : tgEsc(m[0]));
    last = m.index + m[0].length;
  }
  return out + tgEsc(s.slice(last));
}
function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
// Telegram 單則上限 4096 字:依換行拆成多段(每行的 HTML 標籤都在同一行內開合,拆行不會弄壞格式)
function splitTg(text, max = 3900) {
  const parts = [];
  let cur = "";
  for (let line of String(text).split("\n")) {
    while (line.length > max) {
      if (cur) { parts.push(cur); cur = ""; }
      parts.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur.length + line.length + 1 > max) { parts.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function main() {
  if (!GAS_URL || !GAS_TOKEN || !TOKEN || !CHAT) {
    throw new Error("缺少必要的環境變數（Secrets）。請確認 GAS_URL / GAS_TOKEN / TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 都已設定。");
  }

  // 1) 讀取雲端資料(Google 雲端硬碟,透過 Apps Script Web App)
  const res = await fetch(GAS_URL.trim(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ k: GAS_TOKEN.trim(), op: "read" }),
    redirect: "follow"
  });
  if (!res.ok) throw new Error("雲端讀取失敗：" + res.status);
  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error("雲端回應格式不對，請確認 Web App 的存取權是「任何人」、GAS_URL 是 /exec 結尾的網址"); }
  if (!json.ok) throw new Error("雲端讀取失敗：" + (json.error === "unauthorized" ? "存取金鑰錯誤（檢查 GAS_TOKEN）" : json.error));
  const items = (json.record && Array.isArray(json.record.items)) ? json.record.items : [];

  // 2) 組訊息:每日日報,或每週一的技術追蹤清單(執行時帶參數 weekly)
  const today = localToday();
  const msg = MODE === "weekly" ? buildWeekly(items, today) : buildDaily(items, today);

  // 3) 發送到 Telegram(太長時拆成多則依序送出)
  const parts = splitTg(msg);
  for (const part of parts) {
    const tg = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT,
        text: part,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const tj = await tg.json();
    if (!tj.ok) throw new Error("Telegram 發送失敗：" + (tj.description || JSON.stringify(tj)));
  }

  console.log("已發送" + (MODE === "weekly" ? "每週追蹤清單" : "日報") + "，共 " + items.length + " 筆需求，分 " + parts.length + " 則。");
}

/* ---------- 每日日報(格式與網站內一致) ---------- */
function buildDaily(items, today) {
  const counts = {};
  STATUSES.forEach(s => counts[s] = 0);
  items.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });

  let msg = `📋 <b>排程項目日報</b> (${today.slice(5)})\n`;
  // 各狀態件數(0 件的不列,避免太長)
  msg += (STATUSES.filter(s => counts[s]).map(s => `${S_EMOJI[s]}${s} ${counts[s]}`).join(" · ") || "目前沒有需求") + "\n";

  const soon = items
    .filter(t => !NO_OVERDUE[t.status] && t.due)
    .map(t => ({ t, d: daysLeft(t.due, today) }))
    .filter(x => x.d !== null && x.d <= 2)
    .sort((a, b) => a.d - b.d);
  if (soon.length) {
    msg += "\n⚠️ <b>即將到期 / 逾期</b>\n";
    soon.forEach(({ t, d }) => {
      const tag = d < 0 ? `逾期${-d}天` : d === 0 ? "今天到期" : `剩${d}天`;
      msg += `• [${tgEsc(t.ticket || "—")}] ${tgEsc(clip(t.title, 150))} — ${tag} (${tgEsc(PRI_LABEL[t.priority] || "不確定")})\n`;
    });
  }

  const blocked = items.filter(t => t.status === "阻塞");
  if (blocked.length) {
    msg += "\n🚧 <b>阻塞中</b>\n";
    blocked.forEach(t => {
      const note = t.note ? " — " + tgLinkify(clip(String(t.note).split("\n")[0], 200)) : "";
      msg += `• [${tgEsc(t.ticket || "—")}] ${tgEsc(clip(t.title, 150))}${note}\n`;
    });
  }

  if (!soon.length && !blocked.length) msg += "\n✅ 沒有逾期或阻塞，一切順利。";
  return msg;
}

/* ---------- 每週一:需向技術追蹤的項目 ---------- */
// 列入條件:狀態在下列之中 + 有優先級 P0/P1/P2 或有順位 + N 天以上未更新
// 納入的狀態(已上線、暫停開發、阻塞不列入;阻塞每天的日報已經會列)
const WEEKLY_STATUSES = { "待評估": 1, "未釐清": 1, "釐清中": 1, "開發中": 1, "待測試": 1 };
const STALE_DAYS = 7;       // 超過幾天沒有任何修改算「久未更新」
const SYSTEM_ORDER = ["KR", "DY", "LJ"];

// 最後一次「真正的內容修改」:修改紀錄裡有人改了欄位(網站上改,或表格改了同步過來)。
// 不算更新:從表格同步建立、匯入備份、復原、自動補上系統。從沒真正改過的,以提交日期起算。
const NOT_REAL_UPDATE = { _sheet: 1, _import: 1, _restore: 1 };
function lastTouched(t) {
  let last = 0;
  (t.history || []).forEach(h => {
    if (!h || !(h.at > 0) || NOT_REAL_UPDATE[h.field]) return;
    if (h.field === "system" && h.by === "Google 表格") return;
    if (h.at > last) last = h.at;
  });
  const s = Date.parse((t.submit || "") + "T00:00:00+08:00");
  if (!isNaN(s) && s > last) last = s;
  return last > 0 ? last : null;
}

function buildWeekly(items, today) {
  const now = Date.now();
  const rows = [];
  items.forEach(t => {
    if (!WEEKLY_STATUSES[t.status]) return;
    // 只追蹤排定了重要性的:有優先級 P0/P1/P2,或有順位(優先級「不確定」又沒順位的不列)
    const hasPriority = /^P[0-2]$/.test(String(t.priority || ""));
    const hasRank = parseInt(t.rank, 10) > 0;
    if (!hasPriority && !hasRank) return;
    const reasons = [];
    const last = lastTouched(t);
    const idle = last == null ? null : Math.floor((now - last) / 86400000);
    if (idle != null && idle >= STALE_DAYS) reasons.push(idle + "天未更新");
    if (reasons.length) rows.push({ t, reasons });
  });

  let msg = `📌 <b>每週技術追蹤清單</b> (${today.slice(5)})\n`;
  if (!rows.length) return msg + "\n✅ 目前沒有需要追蹤的項目。";
  msg += `共 ${rows.length} 筆超過 ${STALE_DAYS} 天沒有更新(有優先級或順位的需求)\n`;

  // 依系統分組;組內依 順位 → 優先級 → 提交日期(舊的先)
  const sysOf = t => { const m = String(t.system || "").match(/^(KR|DY|LJ)/i); return m ? m[1].toUpperCase() : "其他"; };
  const rankOf = t => { const n = parseInt(t.rank, 10); return n > 0 ? n : Infinity; };
  const priOrder = { P0: 0, P1: 1, P2: 2, TBD: 3 };
  const groups = {};
  rows.forEach(x => { (groups[sysOf(x.t)] = groups[sysOf(x.t)] || []).push(x); });
  SYSTEM_ORDER.concat(["其他"]).forEach(sys => {
    const list = groups[sys];
    if (!list) return;
    list.sort((a, b) => {
      const ra = rankOf(a.t), rb = rankOf(b.t);
      if (ra !== rb) return ra - rb;
      const pa = priOrder[a.t.priority] ?? 3, pb = priOrder[b.t.priority] ?? 3;
      if (pa !== pb) return pa - pb;
      return String(a.t.submit || "9999").localeCompare(String(b.t.submit || "9999"));
    });
    msg += `\n<b>${sys === "其他" ? "未分系統" : sys + " 系統"}</b>(${list.length} 筆)\n`;
    list.forEach(({ t, reasons }) => {
      const tags = [t.status];
      if (rankOf(t) !== Infinity) tags.push("順位" + rankOf(t));
      else if (t.priority && t.priority !== "TBD") tags.push(t.priority);
      if (t.pm) tags.push("PM " + t.pm);
      msg += `• [${tgEsc(t.ticket || "—")}] ${tgEsc(clip(t.title, 80))}(${tgEsc(tags.join(" · "))})— ${reasons.join("、")}\n`;
    });
  });
  return msg;
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
