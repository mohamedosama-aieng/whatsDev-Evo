/* eslint-disable @typescript-eslint/no-explicit-any */
import { zodResolver } from "@hookform/resolvers/zod";
import { Separator } from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { z } from "zod";

import { Button } from "@evoapi/design-system/button";
import { Form, FormControl, FormField, FormInput, FormItem, FormLabel, FormSwitch } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@evoapi/design-system/switch";

import { useInstance } from "@/contexts/InstanceContext";

import { getProvider } from "@/lib/queries/token";
import { useFetchWebhook } from "@/lib/queries/webhook/fetchWebhook";
import { useManageWebhook } from "@/lib/queries/webhook/manageWebhook";
import { cn } from "@/lib/utils";

import { Webhook as WebhookType } from "@/types/evolution.types";

const FormSchema = z.object({
  enabled: z.boolean(),
  url: z.string().url("Invalid URL format"),
  events: z.array(z.string()),
  base64: z.boolean(),
  byEvents: z.boolean(),
  groupMessages: z.boolean(),
  fromMeMessages: z.boolean(),
});

type FormSchemaType = z.infer<typeof FormSchema>;

const GO_EVENTS = ["ALL", "MESSAGE", "SEND_MESSAGE", "READ_RECEIPT", "PRESENCE", "HISTORY_SYNC", "CHAT_PRESENCE", "CALL", "CONNECTION", "QRCODE", "LABEL", "CONTACT", "GROUP", "NEWSLETTER"];

const API_EVENTS = [
  "APPLICATION_STARTUP",
  "QRCODE_UPDATED",
  "MESSAGES_SET",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "CONTACTS_SET",
  "CONTACTS_UPSERT",
  "CONTACTS_UPDATE",
  "PRESENCE_UPDATE",
  "CHATS_SET",
  "CHATS_UPSERT",
  "CHATS_UPDATE",
  "CHATS_DELETE",
  "GROUPS_UPSERT",
  "GROUP_UPDATE",
  "GROUP_PARTICIPANTS_UPDATE",
  "CONNECTION_UPDATE",
  "REMOVE_INSTANCE",
  "LOGOUT_INSTANCE",
  "LABELS_EDIT",
  "LABELS_ASSOCIATION",
  "CALL",
  "TYPEBOT_START",
  "TYPEBOT_CHANGE_STATUS",
];

function Webhook() {
  const { t } = useTranslation();
  const { instance } = useInstance();
  const [loading, setLoading] = useState(false);
  const isGo = getProvider() === "go";

  const { createWebhook } = useManageWebhook();
  const { data: webhook } = useFetchWebhook({
    instanceName: instance?.name,
    token: instance?.token,
  });

  const form = useForm<FormSchemaType>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      enabled: false,
      url: "",
      events: [],
      base64: false,
      byEvents: false,
      // Both default on: match the Backend defaults, so opening this page and
      // saving without touching either switch does not start dropping groups or
      // own messages.
      groupMessages: true,
      fromMeMessages: true,
    },
  });

  useEffect(() => {
    if (webhook) {
      form.reset({
        enabled: webhook.enabled,
        url: webhook.url,
        events: webhook.events,
        base64: webhook.webhookBase64,
        byEvents: webhook.webhookByEvents,
        // `?? true` and not `|| false`: the Evolution fallback response has no
        // groupMessages or fromMeMessages fields at all, and absent must read as
        // on for both.
        groupMessages: webhook.groupMessages ?? true,
        fromMeMessages: webhook.fromMeMessages ?? true,
      });
    }
  }, [webhook]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (data: FormSchemaType) => {
    if (!instance) return;
    setLoading(true);
    try {
      const webhookData: WebhookType = {
        enabled: data.enabled,
        url: data.url,
        events: data.events,
        base64: data.base64,
        byEvents: data.byEvents,
        groupMessages: data.groupMessages,
        fromMeMessages: data.fromMeMessages,
      };

      await createWebhook({
        instanceName: instance.name,
        token: instance.token,
        data: webhookData,
      });
      toast.success(t("webhook.toast.success"));
    } catch (error: any) {
      console.error(t("webhook.toast.error"), error);
      toast.error(`Error: ${error?.response?.data?.response?.message}`);
    } finally {
      setLoading(false);
    }
  };

  const events = isGo ? GO_EVENTS : API_EVENTS;

  const handleSelectAll = () => {
    form.setValue("events", events);
  };

  const handleDeselectAll = () => {
    form.setValue("events", []);
  };

  return (
    <>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="w-full space-y-6">
          <div>
            <h3 className="mb-1 text-lg font-medium">{t("webhook.title")}</h3>
            <Separator className="my-4" />
            <div className="mx-4 space-y-2 divide-y [&>*]:p-4">
              {!isGo && <FormSwitch name="enabled" label={t("webhook.form.enabled.label")} className="w-full justify-between" helper={t("webhook.form.enabled.description")} />}
              <FormInput name="url" label="URL">
                <Input />
              </FormInput>
              {!isGo && <FormSwitch name="byEvents" label={t("webhook.form.byEvents.label")} className="w-full justify-between" helper={t("webhook.form.byEvents.description")} />}
              {!isGo && <FormSwitch name="base64" label={t("webhook.form.base64.label")} className="w-full justify-between" helper={t("webhook.form.base64.description")} />}
              {!isGo && <FormSwitch name="groupMessages" label={t("webhook.form.groupMessages.label")} className="w-full justify-between" helper={t("webhook.form.groupMessages.description")} />}
              {!isGo && <FormSwitch name="fromMeMessages" label={t("webhook.form.fromMeMessages.label")} className="w-full justify-between" helper={t("webhook.form.fromMeMessages.description")} />}
              <div className="mb-4 flex justify-between">
                <Button variant="outline" type="button" onClick={handleSelectAll}>
                  {t("button.markAll")}
                </Button>
                <Button variant="outline" type="button" onClick={handleDeselectAll}>
                  {t("button.unMarkAll")}
                </Button>
              </div>
              <FormField
                control={form.control}
                name="events"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel className="my-2 text-lg">{t("webhook.form.events.label")}</FormLabel>
                    <FormControl>
                      <div className="flex flex-col gap-2 space-y-1 divide-y">
                        {/* Spread before sort: `events` is one of the two
                            module-level constants above, and sort mutates in
                            place - the original arrays were being permanently
                            reordered on first render. */}
                        {[...events]
                          .sort((a, b) => a.localeCompare(b))
                          .map((event) => (
                            <div key={event} className="flex items-center justify-between gap-3 pt-3">
                              <FormLabel className={cn("break-all", field.value.includes(event) ? "text-foreground" : "text-muted-foreground")}>{event}</FormLabel>
                              <Switch
                                checked={field.value.includes(event)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    field.onChange([...field.value, event]);
                                  } else {
                                    field.onChange(field.value.filter((e) => e !== event));
                                  }
                                }}
                              />
                            </div>
                          ))}
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="mx-4 flex justify-end pt-6">
              <Button type="submit" disabled={loading}>
                {loading ? t("webhook.button.saving") : t("webhook.button.save")}
              </Button>
            </div>
          </div>
        </form>
      </Form>
    </>
  );
}

export { Webhook };
