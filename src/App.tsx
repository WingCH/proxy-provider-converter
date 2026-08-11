import { useState } from "react";
import toast, { Toaster } from "react-hot-toast";

import {
  ChevronUpDownIcon,
  ClipboardDocumentIcon,
} from "@heroicons/react/24/outline";

export default function App() {
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("clash");

  const convertedUrl = `${window.location.origin}/api/convert?url=${encodeURIComponent(
    url
  )}&target=${target}`;

  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    // ignore
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已複製", { position: "bottom-center" });
    } catch {
      toast.error("複製失敗，請手動複製", { position: "bottom-center" });
    }
  };

  const clashConfig = `# Clash 配置格式

proxy-groups:
  - name: UseProvider
    type: select
    use:
      - ${hostname || "provider1"}
    proxies:
      - Proxy
      - DIRECT

proxy-providers:
  ${hostname || "provider1"}:
    type: http
    url: ${convertedUrl}
    interval: 3600
    path: ./${hostname || "provider1"}.yaml
    health-check:
      enable: true
      interval: 600
      # lazy: true
      url: http://www.gstatic.com/generate_204
`;

  const surgeConfig = `# Surge 配置格式

[Proxy Group]
${hostname || "External Group"} = select, policy-path=${convertedUrl}
`;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
      <main className="flex flex-col items-start flex-1 max-w-4xl px-4 py-8 md:py-12">
        <div className="flex flex-col items-start md:items-center md:flex-row">
          <img src="/logo.svg" alt="Logo" className="md:mr-4 h-28" />
          <div>
            <h1 className="text-2xl font-extrabold text-black md:text-5xl">
              Proxy Provider Converter
            </h1>
            <p className="mt-2 md:text-lg text-gray-600">
              一個把 Clash／Surge 訂閱轉換成 Proxy Provider 與 External
              Group（Surge）的工具
            </p>
          </div>
        </div>
        <div className="mt-12 text-gray-900">
          <h3 className="text-lg md:text-xl font-bold">
            介紹
          </h3>
          <p className="mt-2">
            本工具可以從其他訂閱自動取得及更新代理節點，支援把完整訂閱拆成可重用的節點清單、合併多個訂閱並統一管理，同時讓節點來源與規則設定分離。你可以使用他人分享的訂閱節點，並保留自己的規則策略。
          </p>
        </div>
        <div className="w-full text-gray-900 mt-14">
          <h3 className="text-lg md:text-xl font-bold">開始使用</h3>
          <div className="flex w-full gap-4 mt-4 flex-col md:flex-row">
            <input
              className="w-full h-full p-4 text-lg bg-white rounded-xl focus:outline-2 focus:outline-offset-2 focus:outline-yellow-500"
              placeholder="貼上 Clash 或 Surge 訂閱連結"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="relative">
              <select
                className="w-full md:w-max py-3 pl-4 pr-10 text-lg bg-white rounded-xl appearance-none focus:outline-2 focus:outline-offset-2 focus:outline-yellow-500"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="clash">轉換為 Clash</option>
                <option value="surge">轉換為 Surge</option>
              </select>
              <ChevronUpDownIcon className="absolute h-6 top-3.5 right-3 text-gray-300" />
            </div>
          </div>
        </div>
        {url && (
          <div className="break-all p-3 mt-4 rounded-lg text-gray-100 bg-gray-900 shadow-sm w-full">
            {convertedUrl}
            <button
              type="button"
              onClick={() => void copyText(convertedUrl)}
              className="flex items-center text-sm mt-4 text-gray-400 cursor-pointer hover:text-gray-300 transition duration-200 select-none"
            >
              <ClipboardDocumentIcon className="h-5 w-5 mr-1 inline-block" />
              點擊複製
            </button>
          </div>
        )}
        {url && (
          <div className="w-full p-4 mt-4 text-gray-100 bg-gray-900 rounded-lg hidden md:block">
            {target !== "surge" && (
              <pre className="whitespace-pre-wrap">{clashConfig}</pre>
            )}
            {target === "surge" && <pre>{surgeConfig}</pre>}
            <button
              type="button"
              onClick={() =>
                void copyText(target === "surge" ? surgeConfig : clashConfig)
              }
              className="flex items-center text-sm mt-4 text-gray-400 cursor-pointer hover:text-gray-300 transition duration-200 select-none"
            >
              <ClipboardDocumentIcon className="h-5 w-5 mr-1 inline-block" />
              點擊複製
            </button>
          </div>
        )}
        <div className="w-full text-gray-900 mt-14">
          <h3 className="text-lg md:text-xl font-bold">
            自行部署轉換工具
          </h3>
          <p className="mt-2">
            使用工具時，{window.location.origin}
            的擁有者可以讀取你的訂閱連結。如果不希望交由第三方處理，可依照以下步驟部署自己的 Cloudflare Worker。
          </p>
          <p className="mt-2">
            準備事項：你需要
            <a
              href="https://github.com"
              target="_blank"
              className="text-yellow-600 transition hover:text-yellow-500"
            >
              GitHub
            </a>
            {" "}帳戶與{" "}
            <a
              href="https://dash.cloudflare.com"
              target="_blank"
              rel="noreferrer"
              className="text-yellow-600 transition hover:text-yellow-500"
            >
              Cloudflare
            </a>
            {" "}帳戶。
          </p>
          <ul className="mt-1">
            <li>
              1. 開啟
              <a
                href="https://github.com/qier222/proxy-provider-converter"
                target="_blank"
                className="text-yellow-600 transition hover:text-yellow-500"
              >
                GitHub repository
              </a>
            </li>
            <li>2. 按右上角 Fork，把專案複製到你的 GitHub。</li>
            <li>3. Clone 專案並執行 pnpm install。</li>
            <li>4. 執行 pnpm exec wrangler login 登入 Cloudflare。</li>
            <li>5. 執行 pnpm run deploy，完成後開啟 Wrangler 回報的 workers.dev URL。</li>
          </ul>
        </div>
      </main>

      <Toaster />
    </div>
  );
}
