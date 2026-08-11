import { z } from "zod";

import {
  MAX_SUBSCRIPTION_URL_LENGTH,
  validateSubscriptionUrl,
} from "../core/convert.js";

const subscriptionUrlSchema = z
  .string()
  .min(1)
  .max(MAX_SUBSCRIPTION_URL_LENGTH)
  .url()
  .superRefine((value, context) => {
    try {
      validateSubscriptionUrl(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "URL must be an allowed public HTTP(S) subscription URL",
      });
    }
  });

export const convertQuerySchema = z.object({
  url: subscriptionUrlSchema,
  // Preserve the existing public API contract for URLs without target.
  target: z.enum(["clash", "surge"]).default("clash"),
});
