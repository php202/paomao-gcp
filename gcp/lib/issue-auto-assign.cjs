/**
 * 問題集自動分配模組
 * 基於 MEMORY.md 的分配規則自動指派負責人
 */

// 分配規則（從 MEMORY.md 更新）
const ASSIGNMENT_RULES = {
  '小羅': [
    '刪單', '退費', '儲值金', '請款', '匯款', '進貨', '庫存', 
    '稅務', 'LINE Pay', 'linepay', '勞健保', '薪資', '會計',
    '發票', '貸記', '帳務', '財務', '銀行', '永豐'
  ],
  'Yen': [
    '維修', '儀器', '故障', '電路', '電線', '送修', '設備',
    '機台', '水電', '硬體', '修理'
  ],
  '圓圓': [
    '行銷', '廣告', '社群', '品牌', '巡店', 'IG', 'FB', 
    'Facebook', 'Instagram', 'Meta', '貼文', '粉專', '曝光',
    '投放', '素材', '文案'
  ],
  '慈慈': [
    '教育', '訓練', '培訓', 'SOP', '課程', '內容', '教材',
    '考試', '考核', '學習', '手冊', '流程'
  ],
  'Miya': [
    '行政', '門市', '溝通', '產品', '備品', '配送', '預約',
    '系統', '神美', 'SayDou', '客服', '接待', '前台'
  ],
  'Rick': [
    '人事', '排班', '策略', '加盟', '合約', '店長', '管理',
    '組織', '制度', '政策', '規劃'
  ],
  '家盈': [
    '對日', '盤點', '庫存', '進銷存', '清點', '倉儲'
  ]
};

// 群組回退規則
const GROUP_FALLBACK = {
  '行銷群': '圓圓',
  '會計群': '小羅', 
  '顧問群': 'Rick',
  '直營': 'Miya',
  '店長': 'Miya',
  '泡泡貓｜總公司': '小羅', // 預設總公司議題給小羅
  '總公司': '小羅'
};

// 高難度關鍵字（留空人工分配）
const HIGH_COMPLEXITY_KEYWORDS = [
  '緊急', '嚴重', '重大', '危機', '法律', '法規', '合規',
  '投訴', '客訴', '媒體', '新聞', '爭議', '糾紛', 
  '加盟主', '股東', '董事', '高層', '決策', '策略調整',
  '系統崩潰', '資安', '外洩', '駭客', '病毒',
  '新店開設', '關店', '撤店', '重大變更'
];

/**
 * 自動分配問題給負責人
 * @param {string} description - 問題描述
 * @param {string} storeName - 門市名稱
 * @param {string} groupName - 來源群組名稱
 * @returns {string|null} 分配的負責人，null 表示需要人工分配
 */
function autoAssignIssue(description, storeName = '', groupName = '') {
  const text = `${description} ${storeName} ${groupName}`.toLowerCase();
  
  // 檢查是否為高難度問題
  for (const keyword of HIGH_COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      console.log(`[auto-assign] 高難度關鍵字檢測: "${keyword}" - 留空人工分配`);
      return null;
    }
  }
  
  // 計算每個負責人的匹配分數
  const scores = {};
  
  for (const [assignee, keywords] of Object.entries(ASSIGNMENT_RULES)) {
    let score = 0;
    for (const keyword of keywords) {
      // 關鍵字匹配計分
      const regex = new RegExp(keyword.toLowerCase(), 'gi');
      const matches = text.match(regex);
      if (matches) {
        score += matches.length;
        console.log(`[auto-assign] ${assignee}: "${keyword}" 匹配 ${matches.length} 次`);
      }
    }
    scores[assignee] = score;
  }
  
  // 找出最高分的負責人
  const sortedScores = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort(([,a], [,b]) => b - a);
  
  if (sortedScores.length > 0) {
    const [topAssignee, topScore] = sortedScores[0];
    console.log(`[auto-assign] 關鍵字匹配結果: ${topAssignee} (${topScore} 分)`);
    return topAssignee;
  }
  
  // 沒有關鍵字匹配，嘗試群組回退
  for (const [groupPattern, assignee] of Object.entries(GROUP_FALLBACK)) {
    if (text.includes(groupPattern.toLowerCase()) || 
        groupName.toLowerCase().includes(groupPattern.toLowerCase()) ||
        storeName.toLowerCase().includes(groupPattern.toLowerCase())) {
      console.log(`[auto-assign] 群組回退: "${groupPattern}" → ${assignee}`);
      return assignee;
    }
  }
  
  console.log(`[auto-assign] 無法自動分配，留空人工處理`);
  return null;
}

/**
 * 獲取分配統計
 * @param {Array} issues - 問題清單
 * @returns {Object} 分配統計
 */
function getAssignmentStats(issues) {
  const stats = {
    total: issues.length,
    assigned: 0,
    unassigned: 0,
    byAssignee: {}
  };
  
  issues.forEach(issue => {
    if (issue.assignee && issue.assignee.trim()) {
      stats.assigned++;
      stats.byAssignee[issue.assignee] = (stats.byAssignee[issue.assignee] || 0) + 1;
    } else {
      stats.unassigned++;
    }
  });
  
  return stats;
}

/**
 * 批量自動分配
 * @param {Array} issues - 未分配的問題清單
 * @returns {Array} 包含分配建議的問題清單
 */
function batchAutoAssign(issues) {
  const results = [];
  
  issues.forEach(issue => {
    const suggestedAssignee = autoAssignIssue(
      issue.description || '', 
      issue.store_name || '',
      issue.source_group_name || ''
    );
    
    results.push({
      ...issue,
      suggested_assignee: suggestedAssignee,
      auto_assigned: !!suggestedAssignee
    });
  });
  
  return results;
}

module.exports = {
  autoAssignIssue,
  getAssignmentStats,
  batchAutoAssign,
  ASSIGNMENT_RULES,
  GROUP_FALLBACK,
  HIGH_COMPLEXITY_KEYWORDS
};