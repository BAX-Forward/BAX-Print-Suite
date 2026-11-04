/**
 * Content stream tokenizer (ISO 32000-1 §7.2, §7.8.2, §8.9.7 inline images). It yields
 * operators with their operands and never throws on malformed input: stray delimiters are
 * skipped and unterminated constructs end at the end of the stream.
 */

export interface NameToken {
  readonly kind: "name";
  /** As written, with `#xx` escapes intact. `PDFName.of(raw)` resolves them. */
  readonly raw: string;
}

export interface StringToken {
  readonly kind: "string";
  readonly length: number;
}

export interface DictToken {
  readonly kind: "dict";
  readonly entries: ReadonlyMap<string, Operand>;
}

export type Operand = number | boolean | null | NameToken | StringToken | DictToken | readonly Operand[];

/** Called per operator. An inline image arrives as operator `BI` with its dictionary as the only operand. */
export type OperatorHandler = (operator: string, operands: readonly Operand[]) => void;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([..."()<>[]{}/%"].map((c) => c.charCodeAt(0)));
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const MAX_NESTING = 64;
/** Operands kept per operator; a valid operator needs far fewer. Bounds memory on garbage input. */
const MAX_OPERANDS = 64;

const SLASH = 0x2f;
const LPAREN = 0x28;
const RPAREN = 0x29;
const LT = 0x3c;
const GT = 0x3e;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const PERCENT = 0x25;
const LF = 0x0a;
const CR = 0x0d;

function keywordValue(word: string): number | boolean | null | undefined {
  if (word === "true") return true;
  if (word === "false") return false;
  if (word === "null") return null;
  return NUMBER.test(word) ? Number(word) : undefined;
}

class Lexer {
  pos = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  peek(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  skipSpace(): void {
    while (!this.eof()) {
      const c = this.peek();
      if (WHITESPACE.has(c)) {
        this.pos++;
      } else if (c === PERCENT) {
        while (!this.eof() && this.bytes[this.pos] !== LF && this.bytes[this.pos] !== CR) this.pos++;
      } else {
        return;
      }
    }
  }

  regular(): string {
    let word = "";
    while (!this.eof()) {
      const c = this.peek();
      if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
      word += String.fromCharCode(c);
      this.pos++;
    }
    return word;
  }

  /** A name, string, array or dictionary at the cursor, else `undefined` (cursor unchanged). */
  structured(depth: number): Operand | undefined {
    const c = this.peek();
    if (c === SLASH) {
      this.pos++;
      return { kind: "name", raw: this.regular() };
    }
    if (c === LPAREN) return this.literalString();
    if (c === LT) {
      if (this.peek(1) === LT) {
        this.pos += 2;
        return this.dictionary(depth);
      }
      return this.hexString();
    }
    if (c === LBRACKET) {
      this.pos++;
      return this.array(depth);
    }
    return undefined;
  }

  /** Any value inside an array or dictionary. Unknown words and stray delimiters become `null`. */
  value(depth: number): Operand {
    if (depth > MAX_NESTING) {
      this.pos = this.bytes.length;
      return null;
    }
    const structured = this.structured(depth);
    if (structured !== undefined) return structured;
    if (DELIMITERS.has(this.peek())) {
      this.pos++;
      return null;
    }
    return keywordValue(this.regular()) ?? null;
  }

  private array(depth: number): Operand[] {
    const items: Operand[] = [];
    for (;;) {
      this.skipSpace();
      if (this.eof()) return items;
      if (this.peek() === RBRACKET) {
        this.pos++;
        return items;
      }
      items.push(this.value(depth + 1));
    }
  }

  private dictionary(depth: number): DictToken {
    const entries = new Map<string, Operand>();
    for (;;) {
      this.skipSpace();
      if (this.eof()) break;
      if (this.peek() === GT && this.peek(1) === GT) {
        this.pos += 2;
        break;
      }
      if (this.peek() !== SLASH) {
        this.value(depth + 1);
        continue;
      }
      this.pos++;
      const key = this.regular();
      this.skipSpace();
      entries.set(key, this.peek() === GT && this.peek(1) === GT ? null : this.value(depth + 1));
    }
    return { kind: "dict", entries };
  }

  private literalString(): StringToken {
    this.pos++;
    let nesting = 1;
    let length = 0;
    while (!this.eof() && nesting > 0) {
      const c = this.bytes[this.pos++];
      if (c === BACKSLASH) this.pos++;
      else if (c === LPAREN) nesting++;
      else if (c === RPAREN) nesting--;
      if (nesting > 0) length++;
    }
    return { kind: "string", length };
  }

  private hexString(): StringToken {
    const start = ++this.pos;
    while (!this.eof() && this.bytes[this.pos] !== GT) this.pos++;
    const length = Math.ceil((this.pos - start) / 2);
    this.pos++;
    return { kind: "string", length };
  }

  /** Reads `BI … ID <data> EI` after the `BI` keyword. */
  inlineImage(): DictToken {
    const entries = new Map<string, Operand>();
    for (;;) {
      this.skipSpace();
      if (this.eof()) return { kind: "dict", entries };
      if (this.peek() === SLASH) {
        this.pos++;
        const key = this.regular();
        this.skipSpace();
        entries.set(key, this.value(1));
        continue;
      }
      const word = this.regular();
      if (word === "ID") break;
      if (word === "") this.value(1);
    }
    if (WHITESPACE.has(this.peek())) this.pos++;
    this.skipImageData(entries);
    return { kind: "dict", entries };
  }

  private skipImageData(entries: ReadonlyMap<string, Operand>): void {
    const start = this.pos;
    const declared = entries.get("L") ?? entries.get("Length");
    if (typeof declared === "number" && declared >= 0) {
      this.pos = Math.min(start + declared, this.bytes.length);
      this.skipSpace();
      const save = this.pos;
      if (this.regular() === "EI") return;
      this.pos = save;
    }
    // Without a length, `EI` delimited by whitespace ends the data (the usual heuristic).
    const bytes = this.bytes;
    for (let i = start; i + 1 < bytes.length; i++) {
      if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue;
      const previous = bytes[i - 1] ?? -1;
      const next = bytes[i + 2] ?? -1;
      const before = i === start || WHITESPACE.has(previous);
      const after = i + 2 >= bytes.length || WHITESPACE.has(next) || DELIMITERS.has(next);
      if (before && after) {
        this.pos = i + 2;
        return;
      }
    }
    this.pos = bytes.length;
  }
}

export function parseContentStream(bytes: Uint8Array, handler: OperatorHandler): void {
  const lexer = new Lexer(bytes);
  let operands: Operand[] = [];
  const push = (operand: Operand): void => {
    operands.push(operand);
    if (operands.length > MAX_OPERANDS) operands = operands.slice(-MAX_OPERANDS);
  };
  for (;;) {
    lexer.skipSpace();
    if (lexer.eof()) return;
    const structured = lexer.structured(0);
    if (structured !== undefined) {
      push(structured);
      continue;
    }
    if (DELIMITERS.has(lexer.peek())) {
      lexer.pos++;
      continue;
    }
    const word = lexer.regular();
    const keyword = keywordValue(word);
    if (keyword !== undefined) {
      push(keyword);
      continue;
    }
    if (word === "BI") {
      handler("BI", [lexer.inlineImage()]);
    } else {
      handler(word, operands);
    }
    operands = [];
  }
}

export function isName(operand: Operand | undefined): operand is NameToken {
  return typeof operand === "object" && operand !== null && !Array.isArray(operand) && (operand as NameToken).kind === "name";
}

export function isDict(operand: Operand | undefined): operand is DictToken {
  return typeof operand === "object" && operand !== null && !Array.isArray(operand) && (operand as DictToken).kind === "dict";
}
