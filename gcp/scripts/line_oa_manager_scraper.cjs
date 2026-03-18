#!/usr/bin/env node
/**
 * LINE OA Manager 瀏覽器抓取器
 * 
 * 透過 openclaw browser 的已登入 session 抓取：
 * 1. 圖文選單觸發次數（CSV API）
 * 2. 加入管道來源（snapshot 解析）
 * 
 * 此腳本設計為 cron agent task，由 OpenClaw agent 執行
 * 如果 session 過期，會通知 Robby 透過 TG 重新登入
 * 
 * 用法：由 cron agent 直接透過 exec 執行
 *   node scripts/line_oa_manager_scraper.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });

// 所有泡泡貓帳號（從 OA Manager 帳號一覽抓的）
const ALL_ACCOUNTS = [
  { name: "泡泡貓｜三峽大同店", id: "@137bcyxt" },
  { name: "泡泡貓｜桃園中路縣府店", id: "@436vrjco" },
  { name: "泡泡貓｜內湖東湖店", id: "@844acqtw" },
  { name: "泡泡貓 鳳山五甲店", id: "@438pcskb" },
  { name: "泡泡貓｜土城中央店", id: "@969dgtfp" },
  { name: "泡泡貓｜嘉義忠孝店", id: "@702bjahr" },
  { name: "泡泡貓｜楊梅金山店", id: "@270morra" },
  { name: "泡泡貓｜台中廣三店SOGO(4F)", id: "@200gzuop" },
  { name: "泡泡貓｜台大辛亥店", id: "@064azmsl" },
  { name: "泡泡貓｜鶯歌鳳鳴店", id: "@062huuob" },
  { name: "泡泡貓｜台南善化店", id: "@434tkgku" },
  { name: "泡泡貓｜高雄前鎮店", id: "@456zcqpl" },
  { name: "泡泡貓｜雲林斗六店", id: "@614qdvrw" },
  { name: "泡泡貓｜新店民權店", id: "@819wevdw" },
  { name: "泡泡貓｜羅東林森店", id: "@884opjzk" },
  { name: "泡泡貓｜員林中山店", id: "@094zphrr" },
  { name: "泡泡貓｜彰化中興店", id: "@202ifvhy" },
  { name: "泡泡貓｜蘆洲集賢店", id: "@960apvts" },
  { name: "泡泡貓｜宜蘭站前店", id: "@260bsdak" },
  { name: "泡泡貓｜高雄陽明店", id: "@665rafma" },
  { name: "泡泡貓｜林口文二店", id: "@180uccju" },
  { name: "泡泡貓｜頭份尚順店", id: "@151iuimo" },
  { name: "泡泡貓｜新莊中平店", id: "@794hcbdj" },
  { name: "泡泡貓｜桃園八德店", id: "@038svvwa" },
  { name: "泡泡貓｜台南安南店", id: "@794mhjgv" },
  { name: "泡泡貓｜雲林虎尾店", id: "@006qqsyr" },
  { name: "泡泡貓｜台南東寧店", id: "@592eimcl" },
  { name: "泡泡貓｜桃園南崁店", id: "@086ctkmd" },
  { name: "泡泡貓｜花蓮中華店", id: "@110lbipm" },
  { name: "泡泡貓｜左營海軍店", id: "@976rbtvs" },
  { name: "泡泡貓｜桃園小檜溪店", id: "@551wtjqx" },
  { name: "泡泡貓｜嘉義仁愛店", id: "@283zacvf" },
  { name: "泡泡貓｜桃園內壢店", id: "@204siimw" },
  { name: "泡泡貓｜北屯潭子店", id: "@480ohwox" },
  { name: "泡泡貓｜西屯青海店", id: "@687oqevv" },
  { name: "泡泡貓｜新竹公道店", id: "@038muqqg" },
  { name: "泡泡貓｜竹北光明店", id: "@097fpfkh" },
  { name: "每刻 Make Relax", id: "@eeb1461f" },
];

function getDateRange() {
  // Yesterday's date range (7 days ending yesterday)
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  return { fromDate: fmt(start), toDate: fmt(end) };
}

function parseCsv(text) {
  const lines = text.trim().split('\r\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i]);
    return obj;
  });
}

// This outputs JSON instructions for the cron agent to execute via browser
async function generateScrapePlan() {
  const { fromDate, toDate } = getDateRange();
  const fromDateSql = `${fromDate.slice(0,4)}-${fromDate.slice(4,6)}-${fromDate.slice(6,8)}`;
  const toDateSql = `${toDate.slice(0,4)}-${toDate.slice(4,6)}-${toDate.slice(6,8)}`;
  
  console.log(JSON.stringify({
    action: 'scrape_line_oa',
    accounts: ALL_ACCOUNTS,
    dateRange: { fromDate, toDate, fromDateSql, toDateSql },
    steps: [
      '1. Navigate to manager.line.biz and check if logged in',
      '2. For each account:',
      '   a. Fetch /api/bots/{id}/richmenus to get active richmenu IDs',
      '   b. Fetch /api/bots/{id}/insight/richmenu/{menuId}.csv for each menu',
      '   c. Navigate to /account/{id}/insight/friends?tab=route and parse snapshot for 加入管道',
      '3. Store results in PostgreSQL via exec',
      '4. If login redirect detected, send TG to Robby',
    ],
    csvEndpoints: {
      richmenus: '/api/bots/{id}/richmenus',
      richmenuInsight: '/api/bots/{id}/insight/richmenu/{menuId}.csv?fromDate={from}&toDate={to}',
      chats: '/api/bots/{id}/insight/chats.csv?fromDate={from}&toDate={to}',
      messages: '/api/bots/{id}/insight/messages.csv?fromDate={from}&toDate={to}',
    },
    tgAlert: {
      chatId: 7956245081,
      message: '⚠️ LINE OA Manager session 過期了，請到 Mac mini 的 openclaw 瀏覽器重新登入 manager.line.biz，然後回覆「已登入」。'
    }
  }, null, 2));
}

generateScrapePlan();
