# 子模組 gas：commit 與 push 步驟

`gas` 是子模組，**不能**在主 repo 用 `git add gas/linebot/package.json`。請依下列順序操作。

## 1. 在 gas 目錄內 commit 並 push

```bash
cd /Users/yutsunghan/node_express/gas

git status
git add linebot/package.json linebot/README.md
git commit -m "fix: 移除 linebot package.json 中的 Google OAuth 憑證，改為環境變數"
git push
```

若 push 被擋「Push cannot contain secrets」，請照 **FIX_PUSH_SECRET.md** 改寫歷史（移除 commit 1a9f7cc 中的憑證）後再 `git push --force-with-lease`。

## 2. 回到主 repo，更新子模組指標再 push

```bash
cd /Users/yutsunghan/node_express

git add gas
git commit -m "chore: 更新 gas 子模組 (linebot 憑證改為環境變數)"
git push
```

這樣主 repo 會記錄「gas 子模組指向新的 commit」，push 才會成功。
