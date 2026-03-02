// server/ui/src/components/WebhookList.tsx
import { useEffect } from "react";
import { useWebhookStore, type Webhook } from "@/stores/webhooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Zap, Loader2 } from "lucide-react";

function WebhookCard({
  webhook,
  onEdit,
}: {
  webhook: Webhook;
  onEdit: (wh: Webhook) => void;
}) {
  const { updateWebhook, deleteWebhook, testWebhook, testingId, testResult } =
    useWebhookStore();

  const isTesting = testingId === webhook.id;
  const result =
    testResult?.id === webhook.id ? testResult : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{webhook.name}</span>
          <Badge variant={webhook.enabled ? "default" : "secondary"}>
            {webhook.enabled ? "Active" : "Disabled"}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            updateWebhook(webhook.id, { enabled: !webhook.enabled })
          }
        >
          {webhook.enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground truncate font-mono">
        {webhook.url}
      </p>

      {webhook.events.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {webhook.events.map((e) => (
            <Badge key={e} variant="outline" className="text-xs">
              {e}
            </Badge>
          ))}
        </div>
      )}
      {webhook.events.length === 0 && (
        <Badge variant="outline" className="text-xs w-fit">
          All events
        </Badge>
      )}

      {webhook.template && (
        <Badge variant="secondary" className="text-xs w-fit">
          Custom template
        </Badge>
      )}

      <div className="flex gap-1 pt-1">
        <Button variant="ghost" size="sm" onClick={() => onEdit(webhook)}>
          <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => testWebhook(webhook.id)}
          disabled={isTesting}
        >
          {isTesting ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5 mr-1" />
          )}
          Test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            if (window.confirm(`Delete webhook "${webhook.name}"?`)) {
              deleteWebhook(webhook.id);
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
        </Button>
      </div>

      {result && (
        <p
          className={`text-xs ${result.ok ? "text-green-500" : "text-destructive"}`}
        >
          {result.ok ? "Test delivered successfully" : `Failed: ${result.error}`}
        </p>
      )}
    </div>
  );
}

export function WebhookList({ onEdit, onAdd }: { onEdit: (wh: Webhook) => void; onAdd: () => void }) {
  const { webhooks, loading, fetchWebhooks } = useWebhookStore();

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4" /> Webhooks
        </CardTitle>
        <Button size="sm" onClick={onAdd}>
          Add Webhook
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && webhooks.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {!loading && webhooks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No webhooks configured. Add one to receive notifications.
          </p>
        )}
        {webhooks.map((wh) => (
          <WebhookCard key={wh.id} webhook={wh} onEdit={onEdit} />
        ))}
      </CardContent>
    </Card>
  );
}
