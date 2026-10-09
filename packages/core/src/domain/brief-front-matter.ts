interface FrontMatterDocument {
  readonly frontMatter: string;
  /** Everything after the newline that ends the closing fence, byte-exact. */
  readonly body: string;
}

const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Split a leading `---` fenced YAML block from the markdown body; null when the document does not start with one. */
export function splitFrontMatter(text: string): FrontMatterDocument | null {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return null;
  return { frontMatter: match[1] ?? "", body: text.slice(match[0].length) };
}
