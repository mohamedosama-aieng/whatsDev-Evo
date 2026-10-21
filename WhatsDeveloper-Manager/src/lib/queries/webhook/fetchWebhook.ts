import { useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { useFetchWebhookGo } from "../go/webhook/fetchWebhook";
import { getProvider } from "../token";
import { UseQueryParams } from "../types";
import { FetchWebhookResponse } from "./types";

interface IParams {
  instanceName: string | null;
  token: string;
}

const queryKey = (params: Partial<IParams>) => ["webhook", "fetchWebhook", JSON.stringify(params)];

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:55453';

export const fetchWebhook = async ({ instanceName, token }: IParams) => {
  // Try to fetch from Backend first (which has the n8n URL)
  // If Backend is unavailable, fallback to Evolution API (which has localhost URL)
  try {
    console.log('[Fetch Webhook] Fetching from Backend for instance:', instanceName);

    const backendResponse = await fetch(`${BACKEND_URL}/api/webhook/config/${encodeURIComponent(instanceName!)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (backendResponse.ok) {
      const result = await backendResponse.json();

      if (result.success && result.url) {
        console.log('[Fetch Webhook] ✓ Got n8n URL from Backend:', result.url);

        // Return in Evolution API format
        return {
          enabled: result.enabled,
          url: result.url,
          events: result.events || ['MESSAGES_UPSERT'],
          webhookBase64: result.webhookBase64 || false,
          webhookByEvents: result.webhookByEvents || false,
          // Backend-only setting; the filter runs there, on the hop to n8n.
          // `?? true` not `|| false`: absent must read as ON, so a config saved
          // before this option existed does not appear switched off in the UI
          // and then get saved back as off.
          groupMessages: result.groupMessages ?? true,
          // Same reasoning: absent means on, so a config written before this
          // field existed keeps forwarding own messages.
          fromMeMessages: result.fromMeMessages ?? true,
        };
      }
    }

    console.log('[Fetch Webhook] Backend returned no webhook, trying Evolution API...');
  } catch (error: any) {
    console.warn('[Fetch Webhook] Backend unavailable, falling back to Evolution API:', error.message);
  }

  // Fallback: Fetch from Evolution API
  const response = await api.get(`/webhook/find/${instanceName}`, {
    headers: { apiKey: token },
  });
  return response.data;
};

const useFetchWebhookApi = (props: UseQueryParams<FetchWebhookResponse> & Partial<IParams>) => {
  const { instanceName, token, enabled, ...rest } = props;
  return useQuery<FetchWebhookResponse>({
    ...rest,
    queryKey: queryKey({ instanceName, token }),
    queryFn: () => fetchWebhook({ instanceName: instanceName!, token: token! }),
    enabled: !!instanceName && (enabled ?? true),
  });
};

export const useFetchWebhook = (props: UseQueryParams<FetchWebhookResponse> & Partial<IParams>) => {
  const provider = getProvider();
  const apiQuery = useFetchWebhookApi({ ...props, enabled: (props.enabled ?? true) && provider === "api" });
  const goQuery = useFetchWebhookGo({ ...props, enabled: (props.enabled ?? true) && provider === "go" });

  return provider === "go" ? goQuery : apiQuery;
};
