import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MessageBubble } from "./MessageBubble";
import { ToolApproval } from "./ToolApproval";
import { SlashCommandDropdown, getFilteredCommands } from "./SlashCommandDropdown";
import { useSession } from "../hooks/useSession";
import type { SlashCommand } from "../types";

interface Props { sessionId: string; token: string; }

export function ChatView({ sessionId, token }: Props) {
  const { messages, slashCommands, status, connected, pendingApproval, sendPrompt, approve, deny, interrupt } = useSession(sessionId, token);
  const [input, setInput] = useState("");
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const filtered = useMemo(
    () => slashCommands.length > 0 ? getFilteredCommands(slashCommands, input) : [],
    [slashCommands, input],
  );
  const dropdownVisible = filtered.length > 0;

  // Reset dropdown index when filter or commands change
  useEffect(() => { if (dropdownVisible) setDropdownIndex(0); }, [filtered.length, dropdownVisible]);

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
  }, []);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (!input.trim()) return; sendPrompt(input.trim()); setInput(""); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dropdownVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDropdownIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setDropdownIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (filtered[dropdownIndex]) {
          selectCommand(filtered[dropdownIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e); }
    }
  };

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
      <div className="prompt-input-wrapper">
        {dropdownVisible && (
          <SlashCommandDropdown
            commands={filtered}
            activeIndex={dropdownIndex}
            onSelect={selectCommand}
          />
        )}
        <form className="prompt-input" onSubmit={handleSubmit}>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Send a message..." rows={1} disabled={status === "running" || status === "starting"} />
          <button type="submit" disabled={status === "running" || status === "starting"}>Send</button>
        </form>
      </div>
    </div>
  );
}
