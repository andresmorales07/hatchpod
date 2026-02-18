import { useState, useRef, useEffect } from "react";
import { MessageBubble } from "./MessageBubble";
import { ToolApproval } from "./ToolApproval";
import { useSession } from "../hooks/useSession";

interface Props { sessionId: string; token: string; }

export function ChatView({ sessionId, token }: Props) {
  const { messages, status, connected, pendingApproval, sendPrompt, approve, deny, interrupt } = useSession(sessionId, token);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (!input.trim()) return; sendPrompt(input.trim()); setInput(""); };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } };

  return (
    <div className="chat-view">
      <div className="chat-header">
        <span className={`status ${status}`}>{status}</span>
        {!connected && <span className="status error">disconnected</span>}
        {(status === "running" || status === "starting") && <button onClick={interrupt} className="interrupt-btn">Stop</button>}
      </div>
      <div className="messages">
        {messages.map((msg, i) => <MessageBubble key={i} message={msg} />)}
        <div ref={messagesEndRef} />
      </div>
      {pendingApproval && <ToolApproval toolName={pendingApproval.toolName} toolUseId={pendingApproval.toolUseId} input={pendingApproval.input} onApprove={approve} onDeny={deny} />}
      <form className="prompt-input" onSubmit={handleSubmit}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Send a message..." rows={1} disabled={status === "running" || status === "starting"} />
        <button type="submit" disabled={status === "running" || status === "starting"}>Send</button>
      </form>
    </div>
  );
}
