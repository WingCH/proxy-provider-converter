import YAML from "yaml";

export type SubscriptionTarget = "clash" | "surge";

export type SubscriptionFetchPolicy = Readonly<{
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  userAgent: string;
}>;

export type SubscriptionFetchErrorCode =
  | "invalid_url"
  | "network"
  | "timeout"
  | "too_large"
  | "http_status"
  | "redirect"
  | "empty_response";

export type SubscriptionConfigErrorCode =
  | "invalid_config"
  | "no_proxies"
  | "unsupported_proxies";

export const MAX_SUBSCRIPTION_URL_LENGTH = 4096;

export const SUBSCRIPTION_FETCH_POLICY: SubscriptionFetchPolicy = Object.freeze({
  timeoutMs: 15_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxRedirects: 5,
  userAgent:
    "ClashX Pro/1.72.0.4 (com.west2online.ClashXPro; build:1.72.0.4; macOS 12.0.1) Alamofire/5.4.4",
});

export class SubscriptionFetchError extends Error {
  constructor(
    public readonly code: SubscriptionFetchErrorCode,
    public readonly upstreamStatus: number | undefined
  ) {
    super(getSubscriptionFetchErrorMessage(code));
    this.name = "SubscriptionFetchError";
  }
}

export class SubscriptionConfigError extends Error {
  constructor(public readonly code: SubscriptionConfigErrorCode) {
    super(getSubscriptionConfigErrorMessage(code));
    this.name = "SubscriptionConfigError";
  }
}

// 统一的中间格式，便于实现 Clash <-> Surge 双向转换
type ProxyCommon = {
  name: string;
  type: "ss" | "vmess" | "trojan";
  server: string;
  port: number;
};

type ShadowsocksExtras = {
  cipher: string;
  password: string;
  udp?: boolean;
  // obfs
  obfs?: "http" | "tls";
  obfsHost?: string;
};

type VmessExtras = {
  uuid: string; // username in Surge
  tls?: boolean;
  serverName?: string; // sni / servername
  skipCertVerify?: boolean;
  network?: "tcp" | "ws"; // 仅支持 ws/tcp
  wsPath?: string;
};

type TrojanExtras = {
  password: string;
  sni?: string;
  skipCertVerify?: boolean;
  network?: "tcp"; // 限制为 tcp（排除 grpc 等）
};

type Proxy =
  | (ProxyCommon & { type: "ss" } & ShadowsocksExtras)
  | (ProxyCommon & { type: "vmess" } & VmessExtras)
  | (ProxyCommon & { type: "trojan" } & TrojanExtras);

export async function convertFromSubscription(
  url: string,
  target: SubscriptionTarget,
  fetcher: typeof fetch,
  fetchPolicy: SubscriptionFetchPolicy
): Promise<string> {
  const configFile = await fetchConfig(url, fetcher, fetchPolicy);
  const source = getConfigType(configFile);

  // Clash to Clash
  if (source === "clash" && target === "clash") {
    let config = parseClashConfig(configFile);
    if (config === null) {
      throw new SubscriptionConfigError("invalid_config");
    }
    if (config.proxies === undefined || config.proxies.length === 0) {
      throw new SubscriptionConfigError("no_proxies");
    }
    return YAML.stringify({ proxies: config.proxies });
  }

  // Surge to Surge
  if (source === "surge" && target === "surge") {
    // 提取 Surge 配置中的 [Proxy] 段落内容，并输出为 External Group 可用的节点列表
    const lines = (configFile as string).split(/\r?\n/);
    let inProxySection = false;
    const proxies: string[] = [];

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (isSurgeSectionHeader(line)) {
        inProxySection = line === "[Proxy]";
        return;
      }

      if (!inProxySection) return;

      // 跳过空行与注释
      if (line.length === 0) return;
      if (line.startsWith("#") || line.startsWith(";")) return;

      // 保留原始行（去掉首尾空白），便于 Surge 直接识别
      proxies.push(line);
    });

    if (proxies.length === 0) {
      throw new SubscriptionConfigError("no_proxies");
    }
    return proxies.join("\n");
  }

  // Clash to Surge
  if (source === "clash" && target === "surge") {
    let config = parseClashConfig(configFile);
    if (config === null) {
      throw new SubscriptionConfigError("invalid_config");
    }
    if (config.proxies === undefined || config.proxies.length === 0) {
      throw new SubscriptionConfigError("no_proxies");
    }
    const intermediates: Proxy[] = config.proxies
      .map((p: any) => clashProxyToIntermediate(p))
      .filter((p: Proxy | undefined) => p !== undefined) as Proxy[];

    const surgeLines = intermediates
      .map((obj) => intermediateToSurgeLine(obj))
      .filter((s: string | undefined) => s !== undefined) as string[];
    if (surgeLines.length === 0) {
      throw new SubscriptionConfigError("unsupported_proxies");
    }
    return surgeLines.join("\n");
  }

  // Surge to Clash
  if (source === "surge" && target === "clash") {
    const lines = (configFile as string).split(/\r?\n/);
    let inProxySection = false;
    const proxyLines: string[] = [];

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (isSurgeSectionHeader(line)) {
        inProxySection = line === "[Proxy]";
        return;
      }
      if (!inProxySection) return;
      if (line.length === 0) return;
      if (line.startsWith("#") || line.startsWith(";")) return;
      proxyLines.push(line);
    });

    if (proxyLines.length === 0) {
      throw new SubscriptionConfigError("no_proxies");
    }

    const intermediates: Proxy[] = proxyLines
      .map((line) => surgeLineToIntermediate(line))
      .filter((p: Proxy | undefined) => p !== undefined) as Proxy[];

    if (intermediates.length === 0) {
      throw new SubscriptionConfigError("unsupported_proxies");
    }

    const clashProxies = intermediates
      .map((obj) => intermediateToClashProxy(obj))
      .filter((o: any | undefined) => o !== undefined);

    return YAML.stringify({ proxies: clashProxies });
  }

  throw new Error("Unsupported conversion combination");
}

async function fetchConfig(
  url: string,
  fetcher: typeof fetch,
  fetchPolicy: SubscriptionFetchPolicy
): Promise<string> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    fetchPolicy.timeoutMs
  );

  try {
    let currentUrl = validateSubscriptionUrl(url);
    let redirectCount = 0;

    while (true) {
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetcher(currentUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "text/plain, application/yaml, application/x-yaml, */*",
            "User-Agent": fetchPolicy.userAgent,
          },
          cache: "no-store",
          redirect: "manual",
          signal: abortController.signal,
        });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          throw new SubscriptionFetchError("timeout", undefined);
        }
        throw new SubscriptionFetchError("network", undefined);
      }

      if (isRedirectStatus(upstreamResponse.status)) {
        const redirectLocation = upstreamResponse.headers.get("Location");
        await cancelResponseBody(upstreamResponse);

        if (
          redirectLocation === null ||
          redirectCount >= fetchPolicy.maxRedirects
        ) {
          throw new SubscriptionFetchError(
            "redirect",
            upstreamResponse.status
          );
        }

        let redirectedUrl: URL;
        try {
          redirectedUrl = new URL(redirectLocation, currentUrl);
        } catch {
          throw new SubscriptionFetchError(
            "redirect",
            upstreamResponse.status
          );
        }

        currentUrl = validateSubscriptionUrl(redirectedUrl.toString());
        redirectCount += 1;
        continue;
      }

      if (!upstreamResponse.ok) {
        await cancelResponseBody(upstreamResponse);
        throw new SubscriptionFetchError(
          "http_status",
          upstreamResponse.status
        );
      }

      try {
        const config = await readBoundedText(
          upstreamResponse,
          fetchPolicy.maxResponseBytes,
          abortController.signal
        );
        if (config.trim().length === 0) {
          throw new SubscriptionFetchError("empty_response", undefined);
        }
        return config;
      } catch (error) {
        if (error instanceof SubscriptionFetchError) {
          throw error;
        }
        if (abortController.signal.aborted || isAbortError(error)) {
          throw new SubscriptionFetchError("timeout", undefined);
        }
        throw new SubscriptionFetchError("network", undefined);
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export function validateSubscriptionUrl(value: string): URL {
  if (value.length === 0 || value.length > MAX_SUBSCRIPTION_URL_LENGTH) {
    throw new SubscriptionFetchError("invalid_url", undefined);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SubscriptionFetchError("invalid_url", undefined);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SubscriptionFetchError("invalid_url", undefined);
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new SubscriptionFetchError("invalid_url", undefined);
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SubscriptionFetchError("invalid_url", undefined);
  }

  return url;
}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
  abortSignal: AbortSignal
): Promise<string> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      Number.isSafeInteger(declaredBytes) &&
      declaredBytes >= 0 &&
      declaredBytes > maxResponseBytes
    ) {
      await cancelResponseBody(response);
      throw new SubscriptionFetchError("too_large", undefined);
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";

  while (true) {
    if (abortSignal.aborted) {
      await reader.cancel();
      throw new SubscriptionFetchError("timeout", undefined);
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    receivedBytes += value.byteLength;
    if (receivedBytes > maxResponseBytes) {
      await reader.cancel();
      throw new SubscriptionFetchError("too_large", undefined);
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original, sanitized fetch error is more useful than a cancel error.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost")
  ) {
    return true;
  }

  const ipv4Parts = normalizedHostname.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part))
  ) {
    const octets = ipv4Parts.map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return isBlockedIpv4(octets);
    }
  }

  if (normalizedHostname.includes(":")) {
    return isBlockedIpv6(normalizedHostname);
  }

  return false;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  if (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:") ||
    hostname.startsWith("2001:db8:")
  ) {
    return true;
  }

  const firstSegment = Number.parseInt(hostname.split(":")[0], 16);
  return (
    (firstSegment & 0xfe00) === 0xfc00 ||
    (firstSegment & 0xffc0) === 0xfe80 ||
    (firstSegment & 0xff00) === 0xff00
  );
}

function getSubscriptionFetchErrorMessage(
  code: SubscriptionFetchErrorCode
): string {
  switch (code) {
    case "invalid_url":
      return "Subscription URL is not allowed";
    case "network":
      return "Unable to fetch subscription";
    case "timeout":
      return "Subscription request timed out";
    case "too_large":
      return "Subscription response is too large";
    case "http_status":
      return "Subscription server returned an error";
    case "redirect":
      return "Subscription redirect is not allowed";
    case "empty_response":
      return "Subscription response is empty";
  }
}

function getSubscriptionConfigErrorMessage(
  code: SubscriptionConfigErrorCode
): string {
  switch (code) {
    case "invalid_config":
      return "Subscription config is invalid";
    case "no_proxies":
      return "Subscription config contains no proxies";
    case "unsupported_proxies":
      return "Subscription config contains no supported proxies";
  }
}

function getConfigType(config: string): "clash" | "surge" {
  if (
    config
      .split(/\r?\n/)
      .some((line) => line.trim() === "[Proxy]")
  ) {
    return "surge";
  }
  return "clash";
}

function isSurgeSectionHeader(line: string): boolean {
  return /^\[[^\]]+\]$/.test(line);
}

function parseClashConfig(config: string): { proxies?: any[] } | null {
  try {
    const parsed: unknown = YAML.parse(config);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const proxies = (parsed as { proxies?: unknown }).proxies;
    if (proxies === undefined) {
      return {};
    }
    if (!Array.isArray(proxies)) {
      return null;
    }
    return { proxies };
  } catch {
    return null;
  }
}

// 将 Clash 的 proxy 对象转换为中间格式
function clashProxyToIntermediate(proxy: any): Proxy | undefined {
  if (!proxy || !proxy.type || !proxy.name || !proxy.server || !proxy.port) {
    return undefined;
  }
  if (!["ss", "vmess", "trojan"].includes(proxy.type)) {
    return undefined;
  }

  if (proxy.type === "ss") {
    // 不支持 v2ray-plugin 的 SS
    if (proxy.plugin === "v2ray-plugin") return undefined;
    const base: ProxyCommon = {
      name: proxy.name,
      type: "ss",
      server: String(proxy.server),
      port: Number(proxy.port),
    } as const;
    const extras: ShadowsocksExtras = {
      cipher: proxy.cipher,
      password: proxy.password,
      udp: proxy.udp,
    };
    if (proxy.plugin === "obfs") {
      const mode = proxy?.["plugin-opts"]?.mode;
      const host = proxy?.["plugin-opts"]?.host;
      if (mode === "http" || mode === "tls") {
        extras.obfs = mode;
      }
      if (typeof host === "string" && host.length > 0) {
        extras.obfsHost = host;
      }
    }
    return { ...base, ...extras } as Proxy;
  }

  if (proxy.type === "vmess") {
    // 过滤不支持的 network
    if (["h2", "http", "grpc"].includes(proxy.network)) return undefined;
    const base: ProxyCommon = {
      name: proxy.name,
      type: "vmess",
      server: String(proxy.server),
      port: Number(proxy.port),
    } as const;
    const extras: VmessExtras = {
      uuid: proxy.uuid,
      tls: Boolean(proxy.tls),
      serverName: proxy.servername,
      skipCertVerify: Boolean(proxy["skip-cert-verify"]),
      network: proxy.network === "ws" ? "ws" : "tcp",
      wsPath: proxy["ws-path"],
    };
    return { ...base, ...extras } as Proxy;
  }

  if (proxy.type === "trojan") {
    // 过滤不支持的 network（如 grpc）
    if (proxy.network && proxy.network !== "tcp") return undefined;
    const base: ProxyCommon = {
      name: proxy.name,
      type: "trojan",
      server: String(proxy.server),
      port: Number(proxy.port),
    } as const;
    const extras: TrojanExtras = {
      password: proxy.password,
      sni: proxy.sni,
      skipCertVerify: Boolean(proxy["skip-cert-verify"]),
      network: "tcp",
    };
    return { ...base, ...extras } as Proxy;
  }

  return undefined;
}

// 中间格式 -> Surge 的单行节点定义
function intermediateToSurgeLine(obj: Proxy): string | undefined {
  const common = `${obj.name} = ${obj.type}, ${obj.server}, ${obj.port}`;

  if (obj.type === "ss") {
    let result = `${common}, encrypt-method=${obj.cipher}, password=${obj.password}`;
    if (obj.obfs) {
      result = `${result}, obfs=${obj.obfs}`;
      if (obj.obfsHost) {
        result = `${result}, obfs-host=${obj.obfsHost}`;
      }
    }
    if (typeof obj.udp === "boolean") {
      result = `${result}, udp-relay=${obj.udp}`;
    }
    return result;
  }

  if (obj.type === "vmess") {
    let result = `${common}, username=${obj.uuid}`;
    if (typeof obj.skipCertVerify === "boolean") {
      result = `${result}, skip-cert-verify=${obj.skipCertVerify}`;
    }
    if (obj.serverName) {
      result = `${result}, sni=${obj.serverName}`;
    }
    if (typeof obj.tls === "boolean") {
      result = `${result}, tls=${obj.tls}`;
    }
    if (obj.network === "ws") {
      result = `${result}, ws=true`;
    }
    if (obj.wsPath) {
      result = `${result}, ws-path=${obj.wsPath}`;
    }
    return result;
  }

  if (obj.type === "trojan") {
    let result = `${common}, password=${obj.password}`;
    if (typeof obj.skipCertVerify === "boolean") {
      result = `${result}, skip-cert-verify=${obj.skipCertVerify}`;
    }
    if (obj.sni) {
      result = `${result}, sni=${obj.sni}`;
    }
    return result;
  }

  return undefined;
}

// 解析 Surge 的单行节点为中间格式
function surgeLineToIntermediate(line: string): Proxy | undefined {
  // 形如：Name = type, server, port, k=v, k=v ...
  const eqIndex = line.indexOf("=");
  if (eqIndex === -1) return undefined;
  const name = line.slice(0, eqIndex).trim();
  const rest = line.slice(eqIndex + 1).trim();
  const parts = rest
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return undefined;
  const type = parts[0] as "ss" | "vmess" | "trojan";
  if (!["ss", "vmess", "trojan"].includes(type)) return undefined;
  const server = parts[1];
  const port = Number(parts[2]);
  if (!server || Number.isNaN(port)) return undefined;

  const kv: Record<string, string> = {};
  for (let i = 3; i < parts.length; i++) {
    const p = parts[i];
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    kv[k] = v;
  }

  if (type === "ss") {
    const cipher = kv["encrypt-method"];
    const password = kv["password"];
    if (!cipher || !password) return undefined;
    const obj: Proxy = {
      name,
      type: "ss",
      server,
      port,
      cipher,
      password,
      udp: kv["udp-relay"]
        ? kv["udp-relay"].toLowerCase() === "true"
        : undefined,
      obfs: kv["obfs"] as any,
      obfsHost: kv["obfs-host"],
    };
    return obj;
  }

  if (type === "vmess") {
    const uuid = kv["username"];
    if (!uuid) return undefined;
    const obj: Proxy = {
      name,
      type: "vmess",
      server,
      port,
      uuid,
      tls: kv["tls"] ? kv["tls"].toLowerCase() === "true" : undefined,
      serverName: kv["sni"],
      skipCertVerify: kv["skip-cert-verify"]
        ? kv["skip-cert-verify"].toLowerCase() === "true"
        : undefined,
      network: kv["ws"] && kv["ws"].toLowerCase() === "true" ? "ws" : "tcp",
      wsPath: kv["ws-path"],
    };
    return obj;
  }

  if (type === "trojan") {
    const password = kv["password"];
    if (!password) return undefined;
    const obj: Proxy = {
      name,
      type: "trojan",
      server,
      port,
      password,
      sni: kv["sni"],
      skipCertVerify: kv["skip-cert-verify"]
        ? kv["skip-cert-verify"].toLowerCase() === "true"
        : undefined,
      network: "tcp",
    };
    return obj;
  }

  return undefined;
}

// 中间格式 -> Clash proxy 对象
function intermediateToClashProxy(obj: Proxy): any | undefined {
  if (obj.type === "ss") {
    const clash: any = {
      name: obj.name,
      type: "ss",
      server: obj.server,
      port: obj.port,
      cipher: obj.cipher,
      password: obj.password,
    };
    if (typeof obj.udp === "boolean") {
      clash.udp = obj.udp;
    }
    if (obj.obfs) {
      clash.plugin = "obfs";
      clash["plugin-opts"] = {
        mode: obj.obfs,
        host: obj.obfsHost,
      };
    }
    return clash;
  }

  if (obj.type === "vmess") {
    const clash: any = {
      name: obj.name,
      type: "vmess",
      server: obj.server,
      port: obj.port,
      uuid: obj.uuid,
    };
    if (typeof obj.tls === "boolean") clash.tls = obj.tls;
    if (obj.serverName) clash.servername = obj.serverName;
    if (typeof obj.skipCertVerify === "boolean")
      clash["skip-cert-verify"] = obj.skipCertVerify;
    if (obj.network === "ws") {
      clash.network = "ws";
      if (obj.wsPath) clash["ws-path"] = obj.wsPath;
    }
    return clash;
  }

  if (obj.type === "trojan") {
    const clash: any = {
      name: obj.name,
      type: "trojan",
      server: obj.server,
      port: obj.port,
      password: obj.password,
    };
    if (obj.sni) clash.sni = obj.sni;
    if (typeof obj.skipCertVerify === "boolean")
      clash["skip-cert-verify"] = obj.skipCertVerify;
    return clash;
  }

  return undefined;
}
