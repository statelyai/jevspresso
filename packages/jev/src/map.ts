import type { EventObject } from 'xstate';
import type { JevSnapshot } from './types';

/** What a state node carries that the map reads: plain fields of XState's `StateNode`. */
type Node = {
  id: string;
  key: string;
  type: string;
  description?: string;
  states: Record<string, Node>;
  parent?: Node;
  transitions: Map<string, Definition[]>;
  after: Definition[];
  always?: Definition[];
  machine: { id: string; getStateNodeById: (id: string) => Node };
};
type Definition = {
  eventType: string;
  target?: Node[];
  to?: unknown;
  guard?: unknown;
  matches?: Record<string, unknown>;
  delay?: unknown;
  context?: unknown;
  description?: string;
};
type DelaySource = number | ((args: { context: unknown; event: EventObject; stateNode: unknown }) => number);

/** A target as written, resolved from the state the transition leaves, as XState resolves it: `#id`, `.child`, or a sibling (`sibling.child`). */
function resolve(source: Node, target: string): Node | undefined {
  try {
    if (target.startsWith('#')) return source.machine.getStateNodeById(target.slice(1));
  } catch {
    return undefined;
  }
  const [from, path] = target.startsWith('.') ? [source, target.slice(1)] : [source.parent, target];
  let node = from;
  for (const key of path.split('.')) node = node?.states[key];
  return node;
}

/**
 * The targets a transition written as a function can take, read from its
 * source: every string literal in what follows a `target:` (one, a ternary's
 * two, an array's), kept when it names a real state node. A computed target
 * (a variable, a template) names none.
 */
function targetsInSource(source: Node, fn: unknown): Node[] {
  const text = String(fn);
  const found = new Set<Node>();
  for (const [, expression] of text.matchAll(/\btarget\s*:\s*(\[[^\]]*\]|[^,}\n]+)/g)) {
    for (const [, , literal] of expression.matchAll(/(['"`])([^'"`$]+)\1/g)) {
      const node = resolve(source, literal);
      if (node) found.add(node);
    }
  }
  return [...found];
}

/** A target as said from where the transition starts: a sibling by name, else its path below the machine. */
const nameOf = (source: Node, t: Node) => (t.parent === source.parent ? t.key : t.id.slice(source.machine.id.length + 1));

/**
 * Where a transition goes: its declared target; for one written as a
 * function, the targets in its source, which it may or may not take
 * (`conditional`), or `?` when none can be read.
 */
function targetName(source: Node, def: Definition): string {
  if (def.target?.length) return def.target.map((t) => nameOf(source, t)).join(', ');
  if (!def.to) return '(stays)';
  const possible = targetsInSource(source, def.to);
  if (possible.length) return `${possible.map((t) => nameOf(source, t)).join(', ')} (conditional)`;
  // No `target` in its source at all: it can only update context.
  return /\btarget\s*:/.test(String(def.to)) ? '?' : '(stays)';
}

/**
 * The keys of the object literal whose `{` is at `open` in `text`, at its top
 * level: `a`, `b` for `{ a: 1, b, ...c }`, and `…` for a spread, whose keys
 * cannot be read. Strings, templates and nested brackets are skipped over.
 */
function objectKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ',') {
      expectKey = true;
      continue;
    }
    if (expectKey && !/\s/.test(c)) {
      expectKey = false;
      if (text.startsWith('...', i)) {
        // A spread: its keys are not here; name what it spreads.
        const spread = /^\.\.\.\s*([\w$.]+)(\()?/.exec(text.slice(i));
        keys.push(`…${spread?.[1] ?? ''}${spread?.[2] ? '()' : ''}`);
        continue;
      }
      const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
      if (key) {
        keys.push(key);
        i += key.length - 1;
      }
    }
  }
  return keys;
}

/**
 * What a transition sets in context, read from how it is written: a
 * declarative `context` object's keys, a mapper's returned object, or in a
 * transition function, every `context: { … }` it may return. A context
 * computed some other way cannot be read, and shows as `…` with what it is
 * computed from: a spread (`…enqueue()`) or a call (`…initialContext()`).
 */
function contextKeys(def: Definition): string[] {
  const keys = new Set<string>();
  const read = (text: string, at: RegExp) => {
    for (const m of text.matchAll(at)) {
      const open = m.index! + m[0].length - 1;
      if (text[open] === '{') for (const k of objectKeys(text, open)) keys.add(k);
      else {
        // Not an object literal: what it is set from (`initialContext()`), when that is a name or a call.
        const from = /^[\w$.]+(\()?/.exec(text.slice(open));
        keys.add(from ? `…${from[0]}${from[1] ? ')' : ''}` : '…');
      }
    }
  };
  if (def.context && typeof def.context === 'object') for (const k of Object.keys(def.context)) keys.add(k);
  if (typeof def.context === 'function') {
    const text = String(def.context);
    read(text, /=>\s*\(\s*\{|\breturn\s*\{/g);
  }
  if (def.to) read(String(def.to), /\bcontext\s*:\s*[^\s]/g);
  return [...keys];
}

function transitionLine(source: Node, head: string, def: Definition): string {
  const match = def.matches ? ` ${JSON.stringify(def.matches)}` : '';
  const guard = def.guard ? ' (if allowed)' : '';
  const sets = contextKeys(def);
  return `${head}${match}${guard} → ${targetName(source, def)}${sets.length ? `; sets ${sets.join(', ')}` : ''}${
    def.description ? ` — ${def.description}` : ''
  }`;
}

/**
 * The machine, condensed for jev: every state (`*` marks the ones it is in
 * now) with its description, and what leaves it: each event with where it
 * goes, each delay (`after`, with how long it is right now) and each
 * eventless transition (`always`), and what each sets in context (`sets
 * cups, hands`). A transition written as a function shows the targets its
 * source names (`→ tamping (conditional)`: it may not be taken), `(stays)`
 * when its source has no target at all, or `→ ?` when its target is computed. Read from the machine's
 * own definition, so it is the same machine `can()` and `transition()` run.
 */
export function machineMap(snapshot: JevSnapshot): string {
  const root = snapshot.machine.root as unknown as Node;
  const active = new Set((snapshot.nodes as unknown as Node[]).map((n) => n.id));
  const delays = (snapshot.machine as { sources?: { delays?: Record<string, DelaySource> } }).sources?.delays ?? {};
  const ms = (node: Node, delay: unknown) => {
    const source = typeof delay === 'string' ? delays[delay] : (delay as DelaySource);
    return typeof source === 'function' ? source({ context: snapshot.context, event: { type: 'xstate.init' }, stateNode: node }) : Number(source);
  };
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    const pad = '  '.repeat(depth);
    const kind = node.type === 'parallel' ? ' (all at once)' : Object.keys(node.states).length ? ' (one at a time)' : '';
    const mark = depth > 0 && active.has(node.id) ? '* ' : '';
    lines.push(`${pad}${mark}${node.key}${kind}${node.description ? ` — ${node.description}` : ''}`);
    for (const [event, defs] of node.transitions) {
      if (event.startsWith('xstate.')) continue;
      for (const def of defs) lines.push(`${pad}    on ${transitionLine(node, event, def)}`);
    }
    for (const def of node.after) {
      const name = typeof def.delay === 'string' ? `${def.delay} ` : '';
      // An `after` matches its own timer event; that pattern is no news to Jev.
      lines.push(`${pad}    ${transitionLine(node, `after ${name}(${(ms(node, def.delay) / 1000).toFixed(1)}s)`, { ...def, matches: undefined })}`);
    }
    for (const def of node.always ?? []) lines.push(`${pad}    ${transitionLine(node, 'always', def)}`);
    for (const child of Object.values(node.states)) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}
