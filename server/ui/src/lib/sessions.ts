export function groupByDate<T extends { lastModified: string; createdAt: string }>(items: T[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: { label: string; items: T[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Older", items: [] },
  ];

  for (const item of items) {
    const t = new Date(item.lastModified || item.createdAt).getTime();
    if (t >= today) groups[0].items.push(item);
    else if (t >= yesterday) groups[1].items.push(item);
    else if (t >= weekAgo) groups[2].items.push(item);
    else groups[3].items.push(item);
  }

  return groups.filter((g) => g.items.length > 0);
}
