import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  SUBSCRIPTION_FETCH_POLICY,
  type SubscriptionFetchPolicy,
} from "../src/core/convert.js";
import { handleRequest } from "./index.js";

const CLASH_CONFIG = `proxies:
  - name: Test SS
    type: ss
    server: proxy.example.com
    port: 443
    cipher: aes-128-gcm
    password: test-password
`;

const SURGE_CONFIG = `[Proxy]
[HK] Test SS = ss, proxy.example.com, 443, encrypt-method=aes-128-gcm, password=test-password
`;

const TEST_POLICY: SubscriptionFetchPolicy = Object.freeze({
  ...SUBSCRIPTION_FETCH_POLICY,
  timeoutMs: 1_000,
  maxResponseBytes: 1024 * 1024,
});

function createAssetsFetcher(body: string): Pick<Fetcher, "fetch"> {
  return {
    async fetch(): Promise<Response> {
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}

function createTextFetcher(body: string, status: number): typeof fetch {
  return async (): Promise<Response> =>
    new Response(body, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}

function createApiRequest(
  sourceUrl: string,
  target: "clash" | "surge" | undefined,
  method: string
): Request {
  const url = new URL("https://worker.example/api/convert");
  url.searchParams.set("url", sourceUrl);
  if (target !== undefined) {
    url.searchParams.set("target", target);
  }
  return new Request(url, { method });
}

describe("Worker routing", () => {
  it("serves non-API requests from the assets binding", async () => {
    const response = await handleRequest(
      new Request("https://worker.example/dashboard"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SPA shell");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const response = await handleRequest(
      new Request("https://worker.example/api/unknown"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns JSON 404 for the API root without a trailing slash", async () => {
    const response = await handleRequest(
      new Request("https://worker.example/api"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects non-GET conversion requests", async () => {
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "POST"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});

describe("Subscription conversion", () => {
  it.each([
    {
      source: CLASH_CONFIG,
      target: "clash" as const,
      output: "clash" as const,
      expectedName: "Test SS",
    },
    {
      source: CLASH_CONFIG,
      target: "surge" as const,
      output: "surge" as const,
      expectedName: "Test SS",
    },
    {
      source: SURGE_CONFIG,
      target: "surge" as const,
      output: "surge" as const,
      expectedName: "[HK] Test SS",
    },
    {
      source: SURGE_CONFIG,
      target: "clash" as const,
      output: "clash" as const,
      expectedName: "[HK] Test SS",
    },
  ])(
    "converts $target output",
    async ({ source, target, output, expectedName }) => {
      const response = await handleRequest(
        createApiRequest("https://subscriptions.example/config", target, "GET"),
        createAssetsFetcher("SPA shell"),
        createTextFetcher(source, 200),
        TEST_POLICY
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8"
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const responseBody = await response.text();
      if (output === "surge") {
        expect(responseBody).toBe(
          `${expectedName} = ss, proxy.example.com, 443, encrypt-method=aes-128-gcm, password=test-password`
        );
      } else {
        const parsed = YAML.parse(responseBody) as { proxies?: unknown[] };
        expect(parsed.proxies).toHaveLength(1);
        expect(parsed.proxies?.[0]).toMatchObject({
          name: expectedName,
          type: "ss",
          server: "proxy.example.com",
          port: 443,
          cipher: "aes-128-gcm",
          password: "test-password",
        });
      }
    }
  );

  it("preserves the omitted target default as clash", async () => {
    const response = await handleRequest(
      createApiRequest(
        "https://subscriptions.example/config",
        undefined,
        "GET"
      ),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(200);
    const parsed = YAML.parse(await response.text()) as { proxies?: unknown[] };
    expect(parsed.proxies).toHaveLength(1);
  });

  it("maps malformed upstream config to a safe 502", async () => {
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher("proxies:\n  - [unterminated", 200),
      TEST_POLICY
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_CONFIG_INVALID",
    });
  });

  it("maps a config with only unsupported proxies to a safe 502", async () => {
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "surge", "GET"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(
        "proxies:\n  - name: Unsupported\n    type: socks5\n    server: proxy.example.com\n    port: 1080\n",
        200
      ),
      TEST_POLICY
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_CONFIG_UNSUPPORTED",
    });
  });
});

describe("Subscription fetch safety", () => {
  it("uses explicit bounded fetch options for the initial request", async () => {
    const sourceUrl = "https://subscriptions.example/config";
    const fetcher = vi.fn<typeof fetch>(
      async (input, init): Promise<Response> => {
        expect(input.toString()).toBe(sourceUrl);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("manual");
        expect(init?.cache).toBe("no-store");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const headers = new Headers(init?.headers);
        expect(headers.get("User-Agent")).toBe(TEST_POLICY.userAgent);
        expect(headers.get("Accept")).toContain("application/yaml");
        return new Response(CLASH_CONFIG, { status: 200 });
      }
    );
    const response = await handleRequest(
      createApiRequest(sourceUrl, "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      fetcher,
      TEST_POLICY
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTTP subscription URLs", async () => {
    const response = await handleRequest(
      createApiRequest("file:///etc/passwd", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher(CLASH_CONFIG, 200),
      TEST_POLICY
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("does not expose a sensitive source URL on upstream errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitiveUrl =
      "https://subscriptions.example/config?token=sentinel-secret";
    try {
      const response = await handleRequest(
        createApiRequest(sensitiveUrl, "clash", "GET"),
        createAssetsFetcher("SPA shell"),
        createTextFetcher("upstream-secret-body", 500),
        TEST_POLICY
      );
      const responseBody = await response.text();

      expect(response.status).toBe(502);
      expect(responseBody).not.toContain("sentinel-secret");
      expect(responseBody).not.toContain("upstream-secret-body");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("maps aborted upstream requests to a 504", async () => {
    const abortingFetcher: typeof fetch = async (): Promise<Response> => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      abortingFetcher,
      TEST_POLICY
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("aborts an upstream request that stalls past the total timeout", async () => {
    const timeoutPolicy: SubscriptionFetchPolicy = Object.freeze({
      ...TEST_POLICY,
      timeoutMs: 20,
    });
    const stalledFetcher: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true }
        );
      });
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      stalledFetcher,
      timeoutPolicy
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("rejects upstream bodies over the configured byte limit", async () => {
    const smallPolicy: SubscriptionFetchPolicy = Object.freeze({
      ...TEST_POLICY,
      maxResponseBytes: 10,
    });
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      createTextFetcher("12345678901", 200),
      smallPolicy
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_RESPONSE_TOO_LARGE",
    });
  });

  it("follows bounded public redirects and preserves the upstream user agent", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (input, init): Promise<Response> => {
        const requestedUrl = new URL(input.toString());
        if (requestedUrl.hostname === "subscriptions.example") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example/config" },
          });
        }

        expect(new Headers(init?.headers).get("User-Agent")).toBe(
          TEST_POLICY.userAgent
        );
        return new Response(CLASH_CONFIG, { status: 200 });
      }
    );
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      fetcher,
      TEST_POLICY
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects to private addresses", async () => {
    const fetcher: typeof fetch = async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/config" },
      });
    const response = await handleRequest(
      createApiRequest("https://subscriptions.example/config", "clash", "GET"),
      createAssetsFetcher("SPA shell"),
      fetcher,
      TEST_POLICY
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_URL_REJECTED",
    });
  });
});
