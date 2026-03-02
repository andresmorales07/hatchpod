import { useState } from "react";
import { useWebhookStore, WEBHOOK_EVENT_TYPES, type Webhook, type WebhookEventType, type CreateWebhookInput, type WebhookTemplate } from "@/stores/webhooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  editing?: Webhook | null;
}

/** Inner form body — remounted via key when editing target changes to reset state. */
function WebhookFormBody({ editing, onClose }: { editing?: Webhook | null; onClose: () => void }) {
  const { createWebhook, updateWebhook } = useWebhookStore();

  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [secret, setSecret] = useState(editing?.secret ?? "");
  const [events, setEvents] = useState<WebhookEventType[]>(editing?.events ? [...editing.events] : []);
  const [useTemplate, setUseTemplate] = useState(!!editing?.template);
  const [templateHeaders, setTemplateHeaders] = useState(
    editing?.template?.headers
      ? JSON.stringify(editing.template.headers, null, 2)
      : ""
  );
  const [templateBody, setTemplateBody] = useState(editing?.template?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const toggleEvent = (e: WebhookEventType) => {
    setEvents((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const input: CreateWebhookInput = { name, url, events };
    if (secret) input.secret = secret;
    if (useTemplate && templateBody) {
      const template: WebhookTemplate = { body: templateBody };
      try {
        const parsed = JSON.parse(templateHeaders);
        if (typeof parsed === "object" && parsed !== null) template.headers = parsed;
      } catch { /* ignore invalid JSON for headers */ }
      input.template = template;
    }

    const result = editing
      ? await updateWebhook(editing.id, input)
      : await createWebhook(input);
    setSaving(false);
    if (result) {
      onClose();
    } else {
      setSaveError("Failed to save webhook. Please try again.");
    }
  };

  const isValidUrl = (() => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    try { new URL(trimmed); return true; } catch { return false; }
  })();
  const isValid = name.trim().length > 0 && isValidUrl;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Webhook" : "Add Webhook"}</DialogTitle>
        <DialogDescription className="sr-only">
          {editing ? "Modify webhook settings" : "Configure a new webhook endpoint"}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium" htmlFor="webhook-name">Name</label>
          <Input id="webhook-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Slack alerts" />
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="webhook-url">URL</label>
          <Input id="webhook-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
          {url.trim().length > 0 && !isValidUrl && (
            <p className="text-xs text-destructive mt-1">Please enter a valid URL</p>
          )}
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="webhook-secret">Secret (optional)</label>
          <Input
            id="webhook-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="HMAC signing key"
          />
        </div>

        <div>
          <label className="text-sm font-medium block mb-1">Events (empty = all)</label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Event type filter">
            {WEBHOOK_EVENT_TYPES.map((e) => (
              <Badge
                key={e}
                variant={events.includes(e) ? "default" : "outline"}
                className="cursor-pointer"
                role="checkbox"
                aria-checked={events.includes(e)}
                tabIndex={0}
                onClick={() => toggleEvent(e)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleEvent(e); } }}
              >
                {e}
              </Badge>
            ))}
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={useTemplate}
              onChange={(e) => setUseTemplate(e.target.checked)}
            />
            Custom payload template
          </label>
        </div>

        {useTemplate && (
          <>
            <div>
              <label className="text-sm font-medium" htmlFor="webhook-headers">
                Headers (JSON object, optional)
              </label>
              <textarea
                id="webhook-headers"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                rows={3}
                value={templateHeaders}
                onChange={(e) => setTemplateHeaders(e.target.value)}
                placeholder='{"Content-Type": "application/json"}'
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="webhook-body">Body template</label>
              <textarea
                id="webhook-body"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                rows={5}
                value={templateBody}
                onChange={(e) => setTemplateBody(e.target.value)}
                placeholder='{"message": "{{message}}"}'
              />
              <p className="text-xs text-muted-foreground mt-1">
                Variables: {"{{event}}"}, {"{{sessionId}}"}, {"{{status}}"}, {"{{message}}"}, {"{{data}}"}, {"{{error}}"}, {"{{timestamp}}"}
              </p>
            </div>
          </>
        )}

        {saveError && (
          <p className="text-xs text-destructive">{saveError}</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!isValid || saving}>
          {saving ? "Saving..." : editing ? "Update" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function WebhookForm({ open, onClose, editing }: Props) {
  const formKey = editing?.id ?? "new";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {open && <WebhookFormBody key={formKey} editing={editing} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
