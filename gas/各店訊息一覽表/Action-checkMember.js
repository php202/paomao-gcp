function checkMember(e) {
  const phone = e.parameter.phone;
  if (!phone) {
    return Core.jsonResponse({status: 'error', message: '未提供手機號碼'});
  }
  // 2. 呼叫上面的邏輯
  const member = Core.getMemApi(phone);
  if (member) {
    // 成功找到，回傳名字 (memnam 是 SayDou 常用的欄位名)
    return Core.jsonResponse({status: 'success', name: member.memnam});
  } else {
    // 找不到人
    return Core.jsonResponse({status: 'not_found', error: '查無此會員'});
  }
}