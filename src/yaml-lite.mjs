/**
 * Lightweight zero-dependency YAML subset parser for mogra.yaml and registry files.
 * Supports nested maps, scalars (bool, int, quoted/unquoted string), inline [a, b] lists, and comments.
 */

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const val = raw.trim();
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (/^-?\d+$/.test(val)) return Number(val);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => parseScalar(item)) : [];
  }
  return val;
}

/** Parse a YAML subset string into a plain JS object. */
export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const cleaned = stripInlineComment(rawLine).replace(/\s+$/, '');
    if (!cleaned.trim()) continue;

    const indent = cleaned.search(/\S/);
    const trimmed = cleaned.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith('- ')) {
      const listKey = stack[stack.length - 1].lastKey;
      if (listKey && Array.isArray(parent[listKey])) {
        parent[listKey].push(parseScalar(trimmed.slice(2)));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (!rest) {
      parent[key] = {};
      stack[stack.length - 1].lastKey = key;
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = parseScalar(rest);
      stack[stack.length - 1].lastKey = key;
    }
  }
  return root;
}
