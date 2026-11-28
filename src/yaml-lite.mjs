/**
 * Lightweight zero-dependency YAML subset parser for mogra.yaml and registry files.
 * Supports nested maps, scalars (bool, int, quoted/unquoted string), inline [a, b] lists,
 * multi-line block sequences (capabilities:\n  - item), and comments.
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
  // Each frame: { indent, obj, lastKey }
  // indent = the indent of the key that opened this object
  // lastKey = the most recently assigned key in obj
  const stack = [{ indent: -1, obj: root, lastKey: null }];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const cleaned = stripInlineComment(rawLine).replace(/\s+$/, '');
    if (!cleaned.trim()) continue;

    const indent = cleaned.search(/\S/);
    const trimmed = cleaned.trim();

    if (trimmed.startsWith('- ')) {
      // Block sequence item — the array lives in the PARENT frame at the key
      // whose indent is LESS THAN current item indent.
      // Pop down until we find a frame whose indent is < item indent and lastKey is set.
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      // An empty placeholder frame opened by `key:` owns no keys yet; the sequence
      // belongs to that key in the enclosing frame, so step back to it.
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top.lastKey === null && Object.keys(top.obj).length === 0) {
        stack.pop();
      }
      const frame = stack[stack.length - 1];
      if (frame.lastKey !== null) {
        const target = frame.obj[frame.lastKey];
        if (!Array.isArray(target)) {
          // Promote empty placeholder {} to []
          frame.obj[frame.lastKey] = [];
        }
        frame.obj[frame.lastKey].push(parseScalar(trimmed.slice(2)));
      }
      continue;
    }

    // Map key: pop until we find the right parent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (!rest) {
      // Potential map or block sequence — initialise as {} placeholder
      parent[key] = {};
      stack[stack.length - 1].lastKey = key;
      stack.push({ indent, obj: parent[key], lastKey: null });
    } else {
      parent[key] = parseScalar(rest);
      stack[stack.length - 1].lastKey = key;
    }
  }
  return root;
}
