interface Props {
  toolName: string; toolUseId: string; input: unknown;
  onApprove: (toolUseId: string) => void;
  onDeny: (toolUseId: string) => void;
}

export function ToolApproval({ toolName, toolUseId, input, onApprove, onDeny }: Props) {
  return (
    <div className="tool-approval">
      <div className="tool-name">Tool: {toolName}</div>
      <div className="tool-input">{JSON.stringify(input, null, 2)}</div>
      <div className="actions">
        <button className="approve" onClick={() => onApprove(toolUseId)}>Approve</button>
        <button className="deny" onClick={() => onDeny(toolUseId)}>Deny</button>
      </div>
    </div>
  );
}
