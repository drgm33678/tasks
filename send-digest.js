// 每日排程項目摘要 → Telegram
// 由 GitHub Actions 定時執行。所有密鑰從環境變數(GitHub Secrets)讀取。
// 需要 Node 18+（GitHub runner 內建 fetch）。

const GAS_URL   = process.env.GAS_URL;   // Apps Script Web App 網址
const GAS_TOKEN = process.env.GAS_TOKEN; // 存取金鑰
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT  = process.env.TELEGRAM_CHAT_ID;
const TZ_OFFSET = 8; // 台灣 UTC+8。若在其他時區，改成你的時差。

const STATUSES = ["待評估", "開發中", "待測試", "阻塞", "已上線"];
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

  // 2) 組摘要（格式與網站內一致）
  const today = localToday();
  const counts = {};
  STATUSES.forEach(s => counts[s] = 0);
  items.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });

  let msg = `📋 <b>排程項目日報</b> (${today.slice(5)})\n`;
  msg += `🟨待評估 ${counts["待評估"]} · 🟦開發中 ${counts["開發中"]} · 🟪待測試 ${counts["待測試"]} · 🟥阻塞 ${counts["阻塞"]} · 🟩已上線 ${counts["已上線"]}\n`;

  const soon = items
    .filter(t => t.status !== "已上線" && t.due)
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

  console.log("已發送日報，共 " + items.length + " 筆需求，分 " + parts.length + " 則。");
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
