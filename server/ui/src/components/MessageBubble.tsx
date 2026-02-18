interface Props { message: unknown; }

export function MessageBubble({ message }: Props) {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;

  if (msg.type === "assistant" && Array.isArray(msg.content)) {
    const textParts = (msg.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
    if (!textParts) return null;
    return <div className="message assistant"><pre>{textParts}</pre></div>;
  }

  if (msg.type === "assistant" && Array.isArray(msg.content) && (msg.content as Array<{ type: string }>).some((c) => c.type === "tool_use")) {
    const toolUses = (msg.content as Array<{ type: string; name?: string; input?: unknown }>).filter((c) => c.type === "tool_use");
    return <>{toolUses.map((tool, i) => <div key={i} className="message tool"><strong>{tool.name}</strong><pre>{JSON.stringify(tool.input, null, 2)}</pre></div>)}</>;
  }

  if (msg.type === "tool_result" || msg.role === "tool") {
    return <div className="message tool"><pre>{JSON.stringify(msg, null, 2).slice(0, 500)}</pre></div>;
  }

  if (msg.role === "user" || msg.type === "human") {
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? (msg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("") : JSON.stringify(msg.content);
    return <div className="message user">{text}</div>;
  }

  if (msg.type === "result") {
    return <div className="message assistant"><em>Session completed. Cost: ${(msg.total_cost_usd as number)?.toFixed(4) ?? "?"}, Turns: {(msg.num_turns as number) ?? "?"}</em></div>;
  }

  return null;
}
