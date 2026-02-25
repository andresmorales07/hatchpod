export function CompactingIndicator() {
  return (
    <div className="flex items-center gap-2 py-2 text-[0.8125rem] self-start">
      <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-amber-400 animate-pulse" />
      <span className="text-amber-400 italic">Compacting conversation…</span>
    </div>
  );
}
