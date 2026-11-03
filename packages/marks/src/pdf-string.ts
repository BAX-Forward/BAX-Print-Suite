/**
 * PDF string syntax (ISO 32000-2 §7.3.4). Printable ASCII becomes a literal
 * string with `\`, `(`, `)` and control characters escaped; anything else
 * becomes a UTF-16BE hex string with a byte order mark (§7.9.2.2).
 */
const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "(": "\\(",
  ")": "\\)",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

const LITERAL_SAFE = /^[\x20-\x7e\n\r\t\b\f]*$/;

export function pdfLiteralString(text: string): string {
  return `(${text.replace(/[\\()\n\r\t\b\f]/g, (c) => ESCAPES[c] ?? c)})`;
}

export function pdfHexTextString(text: string): string {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
}

/** The shortest safe encoding of `text` as a PDF text string. */
export function pdfTextString(text: string): string {
  return LITERAL_SAFE.test(text) ? pdfLiteralString(text) : pdfHexTextString(text);
}
