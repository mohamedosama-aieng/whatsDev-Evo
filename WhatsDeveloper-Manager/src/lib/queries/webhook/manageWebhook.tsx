import { useQueryClient } from "@tanstack/react-query";

import { Webhook } from "@/types/evolution.types";

import { api } from "../api";
import { buildGoWebhookMutations } from "../go/webhook/manageWebhook";
import { useManageMutation } from "../mutateQuery";
import { getProvider } from "../token";

interface IParams {
  instanceName: string;
  token: string;
  data: Webhook;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:55453';

const createWebhook = async ({ instanceName, token, data }: IParams) => {
  // Smart Webhook Registration:
  // Instead of calling Evolution API directly, we call Backend's smart-register
  // which will:
  // 1. Register the n8n URL in Backend
  // 2. Configure Evolution to send to Backend (not n8n directly)
  // 3. Backend transforms payload and forwards to n8n

  try {
    console.log('[Smart Webhook] Registering webhook for instance:', instanceName);
    console.log('[Smart Webhook] n8n URL:', data.url);

    // Call Backend Smart Register endpoint
    const backendResponse = await fetch(`${BACKEND_URL}/api/webhook/smart-register/${instanceName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: data.url,
        enabled: data.enabled !== false,
        // Both filters are enforced in Backend, not Evolution, because Backend
        // is what forwards to n8n. Absent means ON, matching the defaults the
        // endpoint applies.
        groupMessages: data.groupMessages !== false,
        fromMeMessages: data.fromMeMessages !== false,
      }),
    });

    const result = await backendResponse.json();

    if (!result.success) {
      throw new Error(result.error || 'Smart registration failed');
    }

    console.log('[Smart Webhook] ✓ Registration successful!');
    console.log('[Smart Webhook] Flow:', result.flow);
    console.log('[Smart Webhook] Backend URL:', result.backendUrl);

    // Return Evolution-compatible response
    return {
      webhook: {
        ...data,
        url: result.backendUrl, // Evolution now points to Backend
      },
      message: result.flow,
    };
  } catch (error: any) {
    console.error('[Smart Webhook] Registration failed:', error);

    // Fallback: Call Evolution API directly if Backend is unavailable
    console.warn('[Smart Webhook] Falling back to direct Evolution registration...');
    const response = await api.post(`/webhook/set/${instanceName}`, { webhook: data }, { headers: { apikey: token } });
    return response.data;
  }
};

export function useManageWebhook() {
  const qc = useQueryClient();
  const provider = getProvider();
  const go = provider === "go" ? buildGoWebhookMutations(qc) : null;

  const createWebhookMutation = useManageMutation(go ? go.createWebhook : createWebhook, {
    invalidateKeys: [["webhook", "fetchWebhook"]],
  });

  return {
    createWebhook: createWebhookMutation,
  };
}
