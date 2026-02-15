# 給 Cloud Run Jobs 用，排程執行員工業績月報或 Token 檢查
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .
# 執行時由 Cloud Run Job 覆寫：node index.js check-token 或 node index.js employee-monthly-report
CMD ["node", "index.js", "check-token"]
