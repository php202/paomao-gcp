# 改寫歷史移除 commit 1a9f7cc 中的憑證（讓 git push 通過）

在 **gas** 目錄下依序執行（已確認目前 linebot/package.json 已是無憑證版本）：

```bash
cd /Users/yutsunghan/node_express/gas

# 1. 先備份目前「無憑證」的 package.json
cp linebot/package.json /tmp/linebot-package-ok.json

# 2. 找出含憑證的 commit 的前一個 commit
git log --oneline
# 記下 1a9f7cc 的「前一個」commit hash（例如 abc1234）

# 3. 互動式 rebase，從 1a9f7cc 的父 commit 開始（zsh 請用引號包住 1a9f7cc^）
git rebase -i '1a9f7cc^'

# 4. 在編輯器裡：把「1a9f7cc」那一行的 pick 改成 edit，存檔離開

# 5. rebase 停在那個 commit 時，用無憑證版本覆蓋並修正該 commit
cp /tmp/linebot-package-ok.json linebot/package.json
git add linebot/package.json
git commit --amend --no-edit

# 6. 繼續 rebase（後面若有衝突，依提示處理後 git add 再 git rebase --continue）
git rebase --continue

# 7. 改寫歷史後強制推送
git push --force-with-lease
```

若步驟 6 出現衝突，可選：
- 保留目前無憑證的 `linebot/package.json`，再執行 `git add linebot/package.json` 後 `git rebase --continue`。
- 若某個 commit 只改 package.json 且已無差異，可用 `git rebase --skip`（謹慎使用）。

完成後請到 **Google Cloud Console** 撤銷舊的 OAuth 憑證並建立新的（因舊憑證曾出現在歷史中）。
