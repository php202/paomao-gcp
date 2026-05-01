/**
 * 優化版問題集自動分配模組
 * 基於分析結果優化關鍵字權重和分配邏輯
 */

// 優化後的分配規則（加入權重）
const OPTIMIZED_ASSIGNMENT_RULES = {
  '小羅': {
    high: ['刪單', '退費', '儲值金', '請款', '匯款', '會計', '發票', '稅務', 'LINE Pay'], // 高權重
    medium: ['進貨', '庫存', '勞健保', '薪資', '財務', '銀行', '永豐'],
    low: ['貸記', '帳務']
  },
  'Yen': {
    high: ['維修', '儀器', '故障', '送修'],
    medium: ['電路', '電線', '設備', '機台', '硬體'],
    low: ['水電', '修理']
  },
  '圓圓': {
    high: ['行銷', '廣告', 'IG', 'FB', 'Facebook', 'Instagram'],
    medium: ['社群', '品牌', '巡店', '貼文', '粉專', '投放'],
    low: ['Meta', '曝光', '素材', '文案']
  },
  '慈慈': {
    high: ['教育', '訓練', '培訓', 'SOP', '課程'],
    medium: ['內容', '教材', '考試', '考核', '學習'],
    low: ['手冊', '流程']
  },
  'Miya': {
    high: ['神美', 'SayDou', '預約系統'],
    medium: ['行政', '門市', '產品', '備品', '配送'],
    low: ['溝通', '客服', '接待', '前台', '系統']
  },
  'Rick': {
    high: ['人事', '排班', '加盟', '合約'],
    medium: ['策略', '店長', '管理', '組織'],
    low: ['制度', '政策', '規劃']
  },
  '家盈': {
    high: ['盤點', '對日帳'],
    medium: ['庫存', '進銷存'],
    low: ['清點', '倉儲']
  }
};

// 權重分數
const WEIGHT_SCORES = {
  high: 5,
  medium: 3,
  low: 1
};

// 更嚴格的高難度關鍵字
const HIGH_COMPLEXITY_KEYWORDS = [
  '緊急', '嚴重', '重大', '危機', '法律', '法規', '合規',
  '投訴', '客訴', '媒體', '新聞', '爭議', '糾紛', 
  '加盟主', '股東', '董事', '高層', '決策', '策略調整',
  '系統崩潰', '資安', '外洩', '駭客', '病毒',
  '新店開設', '關店', '撤店', '重大變更', '員工離職',
  '薪資糾紛', '勞資爭議', '合約糾紛'
];

// 群組回退規則
const GROUP_FALLBACK = {
  '行銷群': '圓圓',
  '會計群': '小羅', 
  '顧問群': 'Rick',
  '直營': 'Miya',
  '店長': 'Miya',
  '泡泡貓｜總公司': '小羅',
  '總公司': '小羅'
};

/**
 * 優化版自動分配函數
 */
function optimizedAutoAssign(description, storeName = '', groupName = '') {
  const text = `${description} ${storeName} ${groupName}`.toLowerCase();
  
  // 檢查高難度關鍵字
  for (const keyword of HIGH_COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      console.log(`[optimized-assign] 高難度關鍵字: "${keyword}" - 人工分配`);
      return null;
    }
  }
  
  // 計算加權分數
  const scores = {};
  
  for (const [assignee, categories] of Object.entries(OPTIMIZED_ASSIGNMENT_RULES)) {
    let totalScore = 0;
    
    for (const [weight, keywords] of Object.entries(categories)) {
      const weightScore = WEIGHT_SCORES[weight];
      
      for (const keyword of keywords) {
        const regex = new RegExp(keyword.toLowerCase(), 'gi');
        const matches = text.match(regex);
        if (matches) {
          const score = matches.length * weightScore;
          totalScore += score;
          console.log(`[optimized-assign] ${assignee}: "${keyword}" (${weight}) = ${score} 分`);
        }
      }
    }
    
    scores[assignee] = totalScore;
  }
  
  // 找出最高分
  const sortedScores = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort(([,a], [,b]) => b - a);
  
  if (sortedScores.length > 0) {
    const [topAssignee, topScore] = sortedScores[0];
    
    // 設定信心門檻：至少要 3 分才自動分配
    if (topScore >= 3) {
      console.log(`[optimized-assign] ✅ ${topAssignee} (${topScore} 分) - 自動分配`);
      return topAssignee;
    } else {
      console.log(`[optimized-assign] ⚠️ 最高分 ${topScore} 低於門檻 (3 分) - 人工分配`);
      return null;
    }
  }
  
  // 群組回退
  for (const [groupPattern, assignee] of Object.entries(GROUP_FALLBACK)) {
    if (text.includes(groupPattern.toLowerCase()) || 
        groupName.toLowerCase().includes(groupPattern.toLowerCase()) ||
        storeName.toLowerCase().includes(groupPattern.toLowerCase())) {
      console.log(`[optimized-assign] 📋 群組回退: "${groupPattern}" → ${assignee}`);
      return assignee;
    }
  }
  
  console.log(`[optimized-assign] 🤷 無法自動分配 - 人工處理`);
  return null;
}

module.exports = {
  optimizedAutoAssign,
  OPTIMIZED_ASSIGNMENT_RULES,
  WEIGHT_SCORES,
  HIGH_COMPLEXITY_KEYWORDS,
  GROUP_FALLBACK
};