/** Claude sometimes wraps JSON in a markdown fence despite instructions not to — strip it before parsing. */
export function stripMarkdownFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
