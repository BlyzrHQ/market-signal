const INERT_ELEMENTS = new Set(["script", "style", "template", "noscript", "textarea", "title", "iframe", "xmp"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript", "textarea", "title", "iframe", "xmp"]);

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
  if (RAW_TEXT_ELEMENTS.has(firstName)) {
    const closing = new RegExp(`<\\/\\s*${firstName}\\s*>`, "gi");
    closing.lastIndex = firstEnd;
    const match = closing.exec(value);
    return match ? match.index + match[0].length : value.length;
  }
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

export function activeScriptContents(value: string) {
  const scripts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const next = value.indexOf("<", cursor);
    if (next < 0) break;
    if (value.startsWith("<!--", next)) {
      const commentEnd = value.indexOf("-->", next + 4);
      cursor = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }
    const end = tagEnd(value, next);
    const identity = tagIdentity(value, next, end);
    if (identity && !identity.closing && !identity.selfClosing && identity.name === "script") {
      const closing = /<\/\s*script\s*>/gi;
      closing.lastIndex = end;
      const match = closing.exec(value);
      if (!match) break;
      const openingTag = value.slice(next, end);
      const typeMatch = openingTag.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const scriptType = String(typeMatch?.[1] || typeMatch?.[2] || typeMatch?.[3] || "").trim().toLowerCase();
      const executable = !scriptType
        || scriptType === "module"
        || /^(?:text|application)\/(?:java|ecma)script$/.test(scriptType);
      if (executable) scripts.push(value.slice(end, match.index));
      cursor = match.index + match[0].length;
      continue;
    }
    if (identity && !identity.closing && !identity.selfClosing && INERT_ELEMENTS.has(identity.name)) {
      cursor = inertElementEnd(value, next, end, identity.name);
      continue;
    }
    cursor = end;
  }
  return scripts;
}
