import { Webhook } from "@/types/evolution.types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FetchWebhookResponse = Omit<Webhook, "base64" | "byEvents" | "groupMessages" | "fromMeMessages"> & {
  webhookBase64: boolean;
  webhookByEvents: boolean;
  /**
   * Optional, because only one of the three sources actually supplies it:
   * the Backend /api/webhook/config response does, while the Evolution
   * fallback and the Go provider have no such field. Consumers must treat
   * absent as ON (`?? true`) to match the Backend default.
   */
  groupMessages?: boolean;
  /**
   * Optional for the same reason: Backend supplies it, Evolution and Go do not.
   * Treat absent as ON.
   */
  fromMeMessages?: boolean;
};
