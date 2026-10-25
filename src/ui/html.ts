// The little HTML helpers the click popups need. Kept out of main.ts so the
// popup code can escape and link without dragging the map class in.

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

// the OSM page for a feature id like "way/1234" (tilegen writes those ids as-is)
export function osmLink(id: string | undefined): string | null {
  if (!id || !/^(node|way|relation)\/\d+$/.test(id)) return null;
  const url = `https://www.openstreetmap.org/${id}`;
  return `${escapeHtml(id)} (<a href="${url}" target="_blank" rel="noopener">OSM</a>)`;
}
