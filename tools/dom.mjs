/**
 * A dependency-free mini-DOM, good enough to run the extension's *real*
 * content scripts (detector, indicators, popup) under Node.
 *
 * Supported: element/text nodes, an HTML parser for well-formed markup,
 * querySelector(All) / matches / closest with tag, .class, #id, [attr],
 * [attr="v"], `*`, descendant and `>` combinators, cloneNode, insertBefore,
 * remove, textContent, classList, dataset, addEventListener.
 *
 * Deliberately NOT supported: layout, CSSOM, pseudo-classes, namespaces
 * beyond createElementNS, events bubbling. Tests that need those run in a
 * real browser instead.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  middot: '\u00b7', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026'
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

/* ------------------------------------------------------------------ nodes */

class Node {
  constructor(owner) {
    this.ownerDocument = owner || null;
    this.parentNode = null;
    this.childNodes = [];
    this.nodeType = 0;
  }

  get nextSibling() {
    const kids = this.parentNode ? this.parentNode.childNodes : null;
    return kids ? kids[kids.indexOf(this) + 1] || null : null;
  }

  get previousSibling() {
    const kids = this.parentNode ? this.parentNode.childNodes : null;
    return kids ? kids[kids.indexOf(this) - 1] || null : null;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }

  get previousElementSibling() {
    const kids = this.parentNode ? this.parentNode.children : [];
    const i = kids.indexOf(this);
    return i > 0 ? kids[i - 1] : null;
  }

  get nextElementSibling() {
    const kids = this.parentNode ? this.parentNode.children : [];
    const i = kids.indexOf(this);
    return i >= 0 && i < kids.length - 1 ? kids[i + 1] : null;
  }

  appendChild(node) {
    if (node.nodeType === 11) { // fragment
      for (const kid of [...node.childNodes]) this.appendChild(kid);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.childNodes.splice(i, 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  contains(node) {
    for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) {
    this.childNodes.length = 0;
    if (value !== '' && value != null) this.appendChild(new Text(String(value), this.ownerDocument));
  }

  querySelectorAll(selector) {
    const group = parseGroup(selector);
    const out = [];
    walk(this, (el) => { if (el !== this || true) { for (const sel of group) if (matchChain(el, sel)) { out.push(el); return; } } });
    return out;
  }

  querySelector(selector) {
    const list = this.querySelectorAll(selector);
    return list.length ? list[0] : null;
  }

  matches(selector) {
    return parseGroup(selector).some((sel) => matchChain(this, sel, true));
  }

  closest(selector) {
    const group = parseGroup(selector);
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
      if (group.some((sel) => matchChain(el, sel, true))) return el;
    }
    return null;
  }

  addEventListener(type, fn) {
    (this._listeners || (this._listeners = new Map())).set(type, (this._listeners.get(type) || []).concat(fn));
  }

  /* Layout is out of scope, but enough nodes exist for code that measures. */
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get offsetParent() { return this.nodeType === 1 && this.parentNode ? this.parentNode : null; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get isConnected() {
    for (let cur = this; cur; cur = cur.parentNode) if (cur.nodeType === 9) return true;
    return false;
  }

  focus() {
    const doc = this.ownerDocument;
    if (doc && 'activeElement' in doc) doc.activeElement = this;
  }

  blur() {
    const doc = this.ownerDocument;
    if (doc && 'activeElement' in doc) doc.activeElement = doc.body;
  }

  scrollIntoView() {}
  get style() {
    /* Minimal CSSStyleDeclaration: enough for code that sets inline geometry. */
    if (!this._style) {
      const self = this;
      this._style = {
        setProperty(name, value) { self.setAttribute('style', `${self.getAttribute('style') || ''}${name}:${value};`); },
        removeProperty(name) { self.removeAttribute('style'); }
      };
      for (const prop of ['left', 'top', 'right', 'bottom', 'maxHeight', 'transform', 'width']) {
        Object.defineProperty(this._style, prop, {
          get() { return self.getAttribute(`style-${prop}`) || ''; },
          set(v) { self.setAttribute(`style-${prop}`, v); },
          enumerable: true
        });
      }
    }
    return this._style;
  }

  removeEventListener(type, fn) {
    if (!this._listeners) return;
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((f) => f !== fn));
  }

  dispatchEvent(event) {
    const list = (this._listeners && this._listeners.get(event.type)) || [];
    event.currentTarget = this;
    event.target = event.target || this;
    for (const fn of list) fn.call(this, event);
    return true;
  }
}

class Text extends Node {
  constructor(data, owner) {
    super(owner);
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new Text(this.data, this.ownerDocument); }
}

class ClassList {
  constructor(el) { this.el = el; }
  get _set() {
    return (this.el._cls || (this.el._cls = new Set(
      String(this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
    )));
  }
  _flush() {
    const cls = [...this._set].join(' ');
    if (cls) this.el.setAttribute('class', cls);
    else this.el.removeAttribute('class');
  }
  add(...names) { for (const n of names) if (n) this._set.add(n); this._flush(); }
  remove(...names) { for (const n of names) this._set.delete(n); this._flush(); }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    if (on) this._set.add(name); else this._set.delete(name);
    this._flush();
    return on;
  }
  contains(name) { return this._set.has(name); }
  get value() { return [...this._set].join(' '); }
}

class Element extends Node {
  constructor(tag, owner, ns) {
    super(owner);
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this._attrs = new Map();
    Object.defineProperty(this, 'tagName', { get: () => this.localName.toUpperCase() });
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this._cls = null; this.setAttribute('class', String(v)); this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get classList() { return new ClassList(this); }

  getAttribute(name) {
    const v = this._attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  setAttribute(name, value) { this._attrs.set(String(name).toLowerCase(), String(value)); }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }

  get dataset() {
    const el = this;
    return new Proxy({}, {
      get(_t, key) {
        if (typeof key !== 'string') return undefined;
        const v = el.getAttribute('data-' + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
        return v === null ? undefined : v;
      },
      set(_t, key, value) {
        el.setAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), value);
        return true;
      },
      deleteProperty(_t, key) {
        el.removeAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
        return true;
      },
      has(_t, key) {
        return el.hasAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
      }
    });
  }

  cloneNode(deep) {
    const copy = new Element(this.localName, this.ownerDocument, this.namespaceURI);
    for (const [k, v] of this._attrs) copy._attrs.set(k, v);
    copy._cls = this._cls ? new Set(this._cls) : null;
    if (deep) for (const kid of this.childNodes) copy.appendChild(kid.cloneNode(true));
    return copy;
  }

  get outerHTML() {
    const attrs = [...this._attrs].map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    return `<${this.localName}${attrs}>${this.childNodes.map(childHTML).join('')}</${this.localName}>`;
  }
}

function childHTML(node) {
  return node.nodeType === 3 ? node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;') : node.outerHTML;
}

class DocumentFragment extends Node {
  constructor(owner) { super(owner); this.nodeType = 11; }
  cloneNode() { return new DocumentFragment(this.ownerDocument); }
}

/* --------------------------------------------------------------- parser */

const SELF_CLOSING_OK = VOID;

function parseHTML(html, doc) {
  const root = new DocumentFragment(doc);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\w[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [whole, closeTag, openTag, rawAttrs, selfClose, text] = m;
    if (whole.startsWith('<!') || whole.startsWith('</!')) continue;
    const top = stack[stack.length - 1];
    if (closeTag) {
      const name = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].localName === name) { stack.length = i; break; }
      }
      continue;
    }
    if (openTag) {
      const el = new Element(openTag, doc);
      if (rawAttrs) {
        const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
        let a;
        while ((a = attrRe.exec(rawAttrs))) {
          if (!a[1]) continue;
          el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
        }
      }
      top.appendChild(el);
      const voidEl = SELF_CLOSING_OK.has(openTag.toLowerCase()) || selfClose === '/';
      if (!voidEl) stack.push(el);
      continue;
    }
    if (text) {
      const decoded = decodeEntities(text);
      if (top.nodeType === 1 && (top.localName === 'pre' || top.localName === 'code')) {
        top.appendChild(new Text(decoded, doc));
      } else if (/\S/.test(decoded)) {
        top.appendChild(new Text(decoded.replace(/\s+/g, ' '), doc));
      }
    }
  }
  return root;
}

/* ------------------------------------------------------------ selectors */

const groupCache = new Map();

function parseGroup(selector) {
  const key = String(selector).replace(/\s+/g, ' ').trim();
  const cached = groupCache.get(key);
  if (cached) return cached;
  const group = key.split(',').map((part) => parseComplex(part.trim())).filter((s) => s && s.length);
  if (groupCache.size < 500) groupCache.set(key, group);
  return group;
}

/** "main .content > a[href]" -> [{compound, combinator}] rightmost last */
function parseComplex(src) {
  const tokens = [];
  let buf = '';
  let combinator = ' ';
  const flush = () => {
    if (!buf.trim()) return;
    tokens.push({ combinator, compound: parseCompound(buf.trim()) });
    buf = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') { let j = i; while (j < src.length && src[j] !== ']') j++; buf += src.slice(i, j + 1); i = j; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1; while (j < src.length && src[j] !== ch) j++; buf += src.slice(i, j + 1); i = j; continue; }
    if (ch === '>' || ch === ' ') {
      flush();
      if (ch === '>') combinator = '>';
      continue;
    }
    buf += ch;
  }
  flush();
  return tokens;
}

const ATTR_RE = /^\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/;

function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [], not: [] };
  let i = 0;
  const bad = () => new Error(`dom.mjs: unsupported selector "${text}"`);
  const tagM = /^(\*|[a-zA-Z][\w:-]*)/.exec(text);
  if (tagM) {
    if (tagM[1] !== '*') out.tag = tagM[1].toLowerCase();
    i = tagM[1].length;
  }
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = /^\.([\w-]+)/.exec(rest))) { out.classes.push(m[1]); i += m[0].length; continue; }
    if ((m = /^#([\w-]+)/.exec(rest))) { out.id = m[1]; i += m[0].length; continue; }
    if (rest[0] === '[') {
      m = ATTR_RE.exec(rest);
      if (!m) throw bad();
      out.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] });
      i += m[0].length;
      continue;
    }
    if ((m = /^:not\(([^)]*)\)/.exec(rest))) { out.not.push(parseCompound(m[1].trim())); i += m[0].length; continue; }
    if (rest[0] === ' ') { i++; continue; }
    throw bad();
  }
  return out;
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  const set = el.classList._set;
  for (const cls of c.classes) if (!set.has(cls)) return false;
  for (const attr of c.attrs) {
    const v = el.getAttribute(attr.name);
    if (v === null) return false;
    if (attr.op && v !== attr.value) return false;
  }
  for (const neg of c.not) if (matchCompound(el, neg)) return false;
  return true;
}

/** Does `el` satisfy the rightmost compound (and its ancestors the rest)? */
function matchChain(el, chain, rightmostOnly) {
  let i = chain.length - 1;
  if (!matchCompound(el, chain[i].compound)) return false;
  if (rightmostOnly || chain.length === 1) return true;
  let cur = el;
  i--;
  while (i >= 0) {
    const step = chain[i + 1];
    cur = cur.parentElement;
    if (!cur) return false;
    if (step.combinator === '>') {
      if (!matchCompound(cur, chain[i].compound)) return false;
      i--;
    } else {
      let found = null;
      for (let anc = cur; anc && !found; anc = anc.parentElement) {
        if (matchCompound(anc, chain[i].compound)) found = anc;
      }
      if (!found) return false;
      cur = found;
      i--;
    }
  }
  return true;
}

function walk(node, visit) {
  for (const kid of node.childNodes) {
    if (kid.nodeType === 1) { visit(kid); walk(kid, visit); }
  }
}

/* -------------------------------------------------------------- document */

class Document extends Node {
  constructor() {
    super(null);
    this.nodeType = 9;
    this.ownerDocument = this;
    this.title = '';
    this._listeners = new Map();
  }

  get documentElement() { return this.childNodes.find((n) => n.localName === 'html') || null; }
  get body() { return this.querySelector('body') || this.documentElement; }
  get head() { return this.querySelector('head'); }

  createElement(tag) { return new Element(tag, this); }
  createElementNS(ns, tag) { return new Element(tag, this, ns); }
  createTextNode(data) { return new Text(data, this); }
  createDocumentFragment() { return new DocumentFragment(this); }

  getElementById(id) { return this.querySelector('#' + id); }

  /** Test helper: replace the whole tree with parsed markup. */
  set HTML(markup) {
    this.childNodes.length = 0;
    for (const kid of [...parseHTML(markup, this).childNodes]) this.appendChild(kid);
  }
}

/** Minimal Event enough for handlers that read key/preventDefault/stopPropagation. */
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.button = init.button || 0;
    this.detail = init.detail || 1;
    this.ctrlKey = !!init.ctrlKey;
    this.metaKey = !!init.metaKey;
    this.shiftKey = !!init.shiftKey;
    this.altKey = !!init.altKey;
    this.target = init.target || null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; }
}

export { Document, Element, Text, FakeEvent, parseHTML, walk };
