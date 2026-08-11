# Proxy Provider Converter

把 Clash／Surge subscription 轉換為 Clash Proxy Provider 或 Surge External Group 的 Web 工具。

線上版本：[proxy-provider-converter.wingch.workers.dev](https://proxy-provider-converter.wingch.workers.dev)

## 功能

- 把完整 subscription 拆成可重用的 proxy node 清單。
- 合併並統一管理來自不同 subscription 的節點。
- 支援 Clash 與 Surge 之間的雙向轉換。
- 讓節點來源與規則／策略設定分離。

## 使用方式

1. 開啟已部署的網站。
2. 貼上公開可存取的 Clash 或 Surge subscription URL。
3. 選擇輸出格式。
4. 複製產生的 Proxy Provider 或 External Group 設定。

成功轉換的 API contract 為：

```text
GET /api/convert?url=<encoded-subscription-url>&target=clash|surge
Content-Type: text/plain; charset=utf-8
```

省略 `target` 時會保留既有行為，使用 `clash`。

## 本機開發

需求：

- Node.js 22.12.0 或以上
- pnpm 10.27.0

安裝與驗證：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run worker:dry-run
pnpm run worker:startup
pnpm audit --prod
```

只開啟 Vite 前端開發伺服器：

```sh
pnpm dev
```

以本機 workerd 同時預覽 Worker API 與 Vite static assets：

```sh
pnpm run worker:dev
```

## 部署至 Cloudflare Workers

此專案使用單一 Workers Static Assets deployment：

- `dist/` 由 Cloudflare Static Assets 提供。
- `/api/*` 由 TypeScript module Worker 優先處理。
- 未匹配的前端 navigation 會 fallback 至 SPA `index.html`。

首次部署前登入 Cloudflare：

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

`wrangler.jsonc` 的 `account_id` 會鎖定 deployment target。Fork 此專案自行部署時，請把它改成 `wrangler whoami` 顯示的個人 account ID；account ID 不是 secret，但必須與登入帳戶一致。

完成 typecheck、tests、build、dry-run、startup check，並以 Wrangler strict mode 部署：

```sh
pnpm run deploy
```

目前 production URL 是 <https://proxy-provider-converter.wingch.workers.dev>。`wrangler.jsonc` 是 Worker deployment configuration 的 source of truth。

部署後應以安全的公開 fixture 檢查首頁、SPA fallback、`/api` JSON routing、validation error 與真實 conversion。查看 deployment history：

```sh
pnpm exec wrangler deployments list
pnpm exec wrangler versions list
```

如線上 read-back 失敗，可立即回復指定 Worker Version：

```sh
pnpm exec wrangler rollback <VERSION_ID> --yes
```

Rollback 不會回復 KV、D1 或其他綁定資源；本專案目前只有 Static Assets binding，但 rollback 後仍須重新檢查靜態資產與 API。

## 安全與私隱

- 轉換服務必須讀取你提供的 subscription URL；自建 deployment 可避免把 URL 交給第三方站主。
- API 不會 cache conversion response，application code 亦不會寫出 `console.*` logs；persistent Workers Logs 與 traces 已停用。
- Cloudflare 會終止 HTTPS，已授權的 account owner 在 real-time `wrangler tail` event metadata 仍可能看到完整 incoming URL。由於 API contract 把 subscription 放在 query string，自行部署可避免交給第三方站主，但不能對 Cloudflare 平台隱藏該 URL。
- Upstream fetch 只接受公開 HTTP(S) URL，並設有 redirect、timeout 及 response size 上限。
- 建議不要把真實 subscription URL 放入 shell history、issue、CI logs 或公開測試資料。

## License

請參閱 [LICENSE](./LICENSE)。
