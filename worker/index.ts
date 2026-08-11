import { convertQuerySchema } from "../src/api/convert-query.js";
import {
  convertFromSubscription,
  SUBSCRIPTION_FETCH_POLICY,
  SubscriptionConfigError,
  SubscriptionFetchError,
  type SubscriptionConfigErrorCode,
  type SubscriptionFetchErrorCode,
  type SubscriptionFetchPolicy,
} from "../src/core/convert.js";

type AssetsFetcher = Pick<Fetcher, "fetch">;

type PublicFetchError = Readonly<{
  status: number;
  code: string;
  message: string;
}>;

const API_PATH = "/api/convert";
const API_ROOT = "/api";
const API_PREFIX = "/api/";

const API_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

export async function handleRequest(
  request: Request,
  assets: AssetsFetcher,
  fetcher: typeof fetch,
  fetchPolicy: SubscriptionFetchPolicy
): Promise<Response> {
  const requestUrl = new URL(request.url);

  const isApiPath =
    requestUrl.pathname === API_ROOT ||
    requestUrl.pathname.startsWith(API_PREFIX);
  if (!isApiPath) {
    return assets.fetch(request);
  }

  if (requestUrl.pathname !== API_PATH) {
    return jsonResponse(
      { error: "Not found", code: "NOT_FOUND" },
      404,
      new Headers(API_HEADERS)
    );
  }

  if (request.method !== "GET") {
    const headers = new Headers(API_HEADERS);
    headers.set("Allow", "GET");
    return jsonResponse(
      { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
      405,
      headers
    );
  }

  const parsedQuery = convertQuerySchema.safeParse({
    url: requestUrl.searchParams.get("url") ?? undefined,
    target: requestUrl.searchParams.get("target") ?? undefined,
  });

  if (!parsedQuery.success) {
    return jsonResponse(
      {
        error: "Invalid query parameters",
        code: "INVALID_QUERY",
        details: parsedQuery.error.flatten(),
      },
      400,
      new Headers(API_HEADERS)
    );
  }

  const requestId = request.headers.get("CF-Ray") ?? crypto.randomUUID();

  try {
    const result = await convertFromSubscription(
      parsedQuery.data.url,
      parsedQuery.data.target,
      fetcher,
      fetchPolicy
    );
    const headers = new Headers(API_HEADERS);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(result, { status: 200, headers });
  } catch (error) {
    if (error instanceof SubscriptionFetchError) {
      const publicError = getPublicFetchError(error.code);
      return jsonResponse(
        {
          error: publicError.message,
          code: publicError.code,
          requestId,
        },
        publicError.status,
        new Headers(API_HEADERS)
      );
    }

    if (error instanceof SubscriptionConfigError) {
      const publicError = getPublicConfigError(error.code);
      return jsonResponse(
        {
          error: publicError.message,
          code: publicError.code,
          requestId,
        },
        publicError.status,
        new Headers(API_HEADERS)
      );
    }

    return jsonResponse(
      {
        error: "Unable to convert subscription",
        code: "CONVERSION_FAILED",
        requestId,
      },
      500,
      new Headers(API_HEADERS)
    );
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Headers
): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function getPublicFetchError(code: SubscriptionFetchErrorCode): PublicFetchError {
  switch (code) {
    case "invalid_url":
      return {
        status: 502,
        code: "UPSTREAM_URL_REJECTED",
        message: "Subscription URL was rejected",
      };
    case "network":
      return {
        status: 502,
        code: "UPSTREAM_UNAVAILABLE",
        message: "Subscription server is unavailable",
      };
    case "timeout":
      return {
        status: 504,
        code: "UPSTREAM_TIMEOUT",
        message: "Subscription server timed out",
      };
    case "too_large":
      return {
        status: 502,
        code: "UPSTREAM_RESPONSE_TOO_LARGE",
        message: "Subscription response is too large",
      };
    case "http_status":
      return {
        status: 502,
        code: "UPSTREAM_HTTP_ERROR",
        message: "Subscription server returned an error",
      };
    case "redirect":
      return {
        status: 502,
        code: "UPSTREAM_REDIRECT_REJECTED",
        message: "Subscription redirect was rejected",
      };
    case "empty_response":
      return {
        status: 502,
        code: "UPSTREAM_EMPTY_RESPONSE",
        message: "Subscription response is empty",
      };
  }
}

function getPublicConfigError(
  code: SubscriptionConfigErrorCode
): PublicFetchError {
  switch (code) {
    case "invalid_config":
      return {
        status: 502,
        code: "UPSTREAM_CONFIG_INVALID",
        message: "Subscription config is invalid",
      };
    case "no_proxies":
      return {
        status: 502,
        code: "UPSTREAM_CONFIG_EMPTY",
        message: "Subscription config contains no proxies",
      };
    case "unsupported_proxies":
      return {
        status: 502,
        code: "UPSTREAM_CONFIG_UNSUPPORTED",
        message: "Subscription config contains no supported proxies",
      };
  }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    void context;
    return handleRequest(
      request,
      env.ASSETS,
      fetch,
      SUBSCRIPTION_FETCH_POLICY
    );
  },
} satisfies ExportedHandler<Env>;
