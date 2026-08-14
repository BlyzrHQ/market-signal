const INERT_ELEMENTS = new Set(["script", "style", "template", "noscript", "textarea", "title", "iframe", "xmp"]);

function tagEnd(value: string, start: number) {
  let quote = "";
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return value.length;
}

function tagIdentity(value: string, start: number, end: number) {
  const token = value.slice(start, end);
  const match = token.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
  return match ? { closing: Boolean(match[1]), name: match[2].toLowerCase(), selfClosing: /\/\s*>$/.test(token) } : null;
}

function inertElementEnd(value: string, start: number, firstEnd: number, firstName: string) {
  const stack = [firstName];
  let cursor = firstEnd;
  while (cursor < value.length && stack.length) {
    const next = value.indexOf("<", cursor);
    if (next < 0) return value.length;
    if (value.startsWith("<!--", next)) {
      const commentEnd = value.indexOf("-->", next + 4);
      cursor = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }
    const end = tagEnd(value, next);
    const identity = tagIdentity(value, next, end);
    if (identity && INERT_ELEMENTS.has(identity.name)) {
      if (identity.closing) {
        if (stack.at(-1) === identity.name) stack.pop();
      } else if (!identity.selfClosing) stack.push(identity.name);
    }
    cursor = end;
  }
  return cursor;
}

export function stripInactiveHtmlMarkup(value: string) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const next = value.indexOf("<", cursor);
    if (next < 0) return `${output}${value.slice(cursor)}`;
    output += value.slice(cursor, next);
    if (value.startsWith("<!--", next)) {
      const commentEnd = value.indexOf("-->", next + 4);
      cursor = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }
    const end = tagEnd(value, next);
    const identity = tagIdentity(value, next, end);
    if (identity && !identity.closing && !identity.selfClosing && INERT_ELEMENTS.has(identity.name)) {
      cursor = inertElementEnd(value, next, end, identity.name);
      continue;
    }
    output += value.slice(next, end);
    cursor = end;
  }
  return output;
}
