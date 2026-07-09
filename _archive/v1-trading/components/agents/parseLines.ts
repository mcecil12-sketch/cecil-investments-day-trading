/** Parse multi-line textarea content into a trimmed string array, ignoring blank lines. */
export function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
