// 每日需求追蹤摘要 → Telegram
// 由 GitHub Actions 定時執行。所有密鑰從環境變數(GitHub Secrets)讀取。
// 需要 Node 18+（GitHub runner 內建 fetch）。

const BIN   = process.env.JSONBIN_BIN_ID;
const KEY   = process.env.JSONBIN_KEY;
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT  = process.env.TELEGRAM_CHAT_ID;
const TZ_OFFSET = 8; // 台灣 UTC+8。若在其他時區，改成你的時差。

const STATUSES = ["待評估", "開發中", "待測試", "阻塞", "已上線"];

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

async function main() {
  if (!BIN || !KEY || !TOKEN || !CHAT) {
    throw new Error("缺少必要的環境變數（Secrets）。請確認 JSONBIN_BIN_ID / JSONBIN_KEY / TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 都已設定。");
  }

  // 1) 讀取雲端資料
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
    headers: { "X-Master-Key": KEY }
  });
  if (!res.ok) throw new Error("JSONBin 讀取失敗：" + res.status);
  const json = await res.json();
  const items = (json.record && Array.isArray(json.record.items)) ? json.record.items : [];

  // 2) 組摘要（格式與網站內一致）
  const today = localToday();
  const counts = {};
  STATUSES.forEach(s => counts[s] = 0);
  items.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });

  let msg = `📋 <b>需求追蹤日報</b> (${today.slice(5)})\n`;
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
      msg += `• [${t.ticket || "—"}] ${t.title} — ${tag} (${t.priority})\n`;
    });
  }

  const blocked = items.filter(t => t.status === "阻塞");
  if (blocked.length) {
    msg += "\n🚧 <b>阻塞中</b>\n";
    blocked.forEach(t => {
      const note = t.note ? " — " + String(t.note).split("\n")[0] : "";
      msg += `• [${t.ticket || "—"}] ${t.title}${note}\n`;
    });
  }

  if (!soon.length && !blocked.length) msg += "\n✅ 沒有逾期或阻塞，一切順利。";

  // 3) 發送到 Telegram
  const tg = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const tj = await tg.json();
  if (!tj.ok) throw new Error("Telegram 發送失敗：" + (tj.description || JSON.stringify(tj)));

  console.log("已發送日報，共 " + items.length + " 筆需求。");
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
