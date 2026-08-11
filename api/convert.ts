import type { VercelRequest, VercelResponse } from "@vercel/node";

import { convertQuerySchema } from "../src/api/convert-query.js";
import {
  convertFromSubscription,
  SUBSCRIPTION_FETCH_POLICY,
  SubscriptionConfigError,
  SubscriptionFetchError,
} from "../src/core/convert.js";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse
) {
  const toString = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      return typeof value[0] === "string" ? value[0] : undefined;
    }
    return typeof value === "string" ? value : undefined;
  };

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED",
    });
    return;
  }

  const parsed = convertQuerySchema.safeParse({
    url: toString(request.query.url),
    target: toString(request.query.target),
  });

  if (!parsed.success) {
    response.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten(),
    });
    return;
  }

  const { url, target } = parsed.data;
  try {
    const result = await convertFromSubscription(
      url,
      target,
      fetch,
      SUBSCRIPTION_FETCH_POLICY
    );
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.status(200).send(result);
  } catch (error) {
    const status =
      error instanceof SubscriptionFetchError
        ? error.code === "timeout"
          ? 504
          : 502
        : error instanceof SubscriptionConfigError
          ? 502
        : 500;
    response.status(status).json({
      error: "Unable to convert subscription",
      code: "CONVERSION_FAILED",
    });
  }
}
