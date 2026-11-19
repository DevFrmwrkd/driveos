export function groupCatalogFiles(files: any[], key: (file: any) => string): { name: string; bytes: number; count: number }[] {
  const groups = new Map<string, { name: string; bytes: number; count: number }>();
  for (const file of files) {
    const name = key(file);
    const group = groups.get(name) || { name, bytes: 0, count: 0 };
    group.bytes += file.sizeBytes || 0;
    group.count += 1;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}
