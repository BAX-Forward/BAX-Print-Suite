import { ValidationError } from '@bax-print/core';

/** A minimal XML element tree; names are local names (namespace prefixes dropped). */
export interface XmlElement {
  name: string;
  qname: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

function localName(qname: string): string {
  const colon = qname.indexOf(':');
  return colon < 0 ? qname : qname.slice(colon + 1);
}

/** Index of the `>` closing a tag that starts at `start`, skipping quoted attribute values. */
function tagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parses well-formed XML without DTDs. Entities other than the five predefined ones and
 * character references are left as written; DOCTYPE declarations are refused.
 */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', qname: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = (): XmlElement => stack[stack.length - 1]!;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new ValidationError('XML: unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new ValidationError('XML: unterminated CDATA section');
      top().text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new ValidationError('XML: unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new ValidationError('XML: DTDs are not accepted');
    const gt = tagEnd(text, lt + 1);
    if (gt < 0) throw new ValidationError('XML: unterminated tag');
    const body = text.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const qname = body.slice(1).trim();
      const open = stack.pop();
      if (!open || open === root || open.qname !== qname) throw new ValidationError(`XML: unexpected closing tag ${qname}`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const qname = /^([^\s/>]+)/.exec(inner)?.[1];
    if (!qname) throw new ValidationError('XML: tag without a name');
    const attributes: Record<string, string> = {};
    for (const attr of inner.slice(qname.length).matchAll(ATTRIBUTE)) {
      attributes[localName(attr[1]!)] = decodeEntities(attr[2] ?? attr[3] ?? '');
    }
    const element: XmlElement = { name: localName(qname), qname, attributes, children: [], text: '' };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new ValidationError(`XML: element ${top().qname} is not closed`);
  return root;
}

export function findAll(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(element);
  return found;
}

export function findFirst(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return undefined;
}

export interface CxfLabObject {
  id: string;
  L: number;
  a: number;
  b: number;
}

function labComponent(lab: XmlElement, name: string, id: string): number {
  const text = findFirst(lab, name)?.text.trim() ?? '';
  const value = Number(text);
  if (text === '' || !Number.isFinite(value)) throw new ValidationError(`CxF: object ${id} has no numeric ${name} value`);
  return value;
}

/**
 * Reads the CIELAB values of the objects of an ISO 17972 (CxF3) document. The object `Name`
 * is the patch id, falling back to `Id`. Spectral-only objects are skipped.
 */
export function readCxfLab(text: string): CxfLabObject[] {
  const root = parseXml(text);
  const document = root.children[0];
  if (!document || document.name !== 'CxF') throw new ValidationError('CxF: the root element must be CxF');
  const objects: CxfLabObject[] = [];
  for (const object of findAll(document, 'Object')) {
    const lab = findFirst(object, 'ColorCIELab');
    if (!lab) continue;
    const id = (object.attributes.Name ?? object.attributes.Id ?? '').trim();
    if (id === '') throw new ValidationError('CxF: an object with a Lab value has neither Name nor Id');
    objects.push({ id, L: labComponent(lab, 'L', id), a: labComponent(lab, 'A', id), b: labComponent(lab, 'B', id) });
  }
  if (objects.length === 0) throw new ValidationError('CxF: no objects with CIELAB values');
  return objects;
}
