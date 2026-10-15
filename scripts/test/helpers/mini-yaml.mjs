// A reader for the small part of YAML the workflow files use, so that tests can look at their structure on every
// operating system with nothing installed: block mappings and sequences, plain and quoted scalars, flow sequences,
// and `|` or `>` block scalars. It refuses anything else (tabs, anchors, multi-line plain scalars, multiple
// documents) instead of guessing, so a workflow that needs more than this fails the test that reads it.

class YamlError extends Error {
  constructor(message, line) {
    super(`line ${line + 1}: ${message}`);
    this.name = "YamlError";
  }
}

/** The text before a ` #` comment, ignoring a # inside quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(text[i - 1])) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Splits `key: rest` at the first colon followed by a space or the end, outside quotes. Null when there is none. */
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (i === 0 && (c === '"' || c === "'")) {
      quote = c;
    } else if (c === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
      return [text.slice(0, i), text.slice(i + 1).trim()];
    } else if (c === "{" && text[i - 1] === "$") {
      // An expression: ${{ ... }} may hold colons of its own.
      const end = text.indexOf("}}", i);
      if (end !== -1) i = end + 1;
    }
  }
  return null;
}

function unquote(text, line) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new YamlError("unterminated double-quoted string", line);
    return text.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c) => ({ n: "\n", t: "\t" })[c] ?? c);
  }
  if (!text.endsWith("'") || text.length < 2) throw new YamlError("unterminated single-quoted string", line);
  return text.slice(1, -1).replace(/''/g, "'");
}

function splitFlow(inner, line) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"') current += inner[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === "[" || c === "{") {
      depth++;
      current += c;
    } else if (c === "]" || c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  if (quote || depth !== 0) throw new YamlError("unbalanced flow collection", line);
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function scalar(text, line) {
  if (text === "") return null;
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text, line);
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new YamlError("unterminated flow sequence", line);
    return splitFlow(text.slice(1, -1), line).map((part) => scalar(part, line));
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new YamlError("unterminated flow mapping", line);
    const out = {};
    for (const part of splitFlow(text.slice(1, -1), line)) {
      const pair = splitKey(part);
      if (!pair) throw new YamlError(`not a key: value pair: ${part}`, line);
      out[scalarKey(pair[0], line)] = scalar(pair[1], line);
    }
    return out;
  }
  if (/^[&*!]/.test(text)) throw new YamlError(`anchors, aliases and tags are not supported: ${text}`, line);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function scalarKey(text, line) {
  return text.startsWith('"') || text.startsWith("'") ? unquote(text, line) : text;
}

export function parseYaml(source) {
  const raw = source.replace(/^\u{FEFF}/u, "").split(/\r?\n/);
  const lines = raw.map((text, index) => {
    if (/^\s*\t/.test(text) || /^ *\t/.test(text)) throw new YamlError("tabs are not allowed for indentation", index);
    return { text, indent: text.length - text.trimStart().length, index };
  });
  if (raw.some((text) => /^---\s*$/.test(text))) throw new YamlError("multiple documents are not supported", 0);
  let at = 0;

  const meaningful = (i) => {
    const t = lines[i].text.trim();
    return t !== "" && !t.startsWith("#");
  };
  const skipBlank = () => {
    while (at < lines.length && !meaningful(at)) at++;
  };

  function blockScalar(header, parentIndent, line) {
    const style = header[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const body = [];
    let indent = null;
    while (at < lines.length) {
      const l = lines[at];
      if (l.text.trim() === "") {
        body.push("");
        at++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (indent === null) indent = l.indent;
      if (l.indent < indent) throw new YamlError("block scalar indented less than its first line", l.index);
      body.push(l.text.slice(indent));
      at++;
    }
    while (body.length && body.at(-1) === "") body.pop();
    let text = style === ">" ? body.join(" ") : body.join("\n");
    if (chomp !== "strip" && body.length) text += "\n";
    return text;
  }

  function parseBlock(minIndent) {
    skipBlank();
    if (at >= lines.length || lines[at].indent < minIndent) return null;
    const { indent, text } = lines[at];
    return /^-( |$)/.test(text.trim()) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseValue(rest, parentIndent, line) {
    if (rest === "") {
      skipBlank();
      if (at < lines.length && lines[at].indent > parentIndent) return parseBlock(parentIndent + 1);
      // `key:` followed by `- item` at the same indent is a sequence too.
      if (at < lines.length && lines[at].indent === parentIndent && /^-( |$)/.test(lines[at].text.trim())) return parseSequence(parentIndent);
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, parentIndent, line);
    return scalar(rest, line);
  }

  function parseMapping(indent) {
    const out = {};
    for (;;) {
      skipBlank();
      if (at >= lines.length || lines[at].indent !== indent) break;
      const { text, index } = lines[at];
      const trimmed = text.trim();
      if (/^-( |$)/.test(trimmed)) break;
      const pair = splitKey(stripComment(trimmed));
      if (!pair) throw new YamlError(`expected "key: value", got: ${trimmed}`, index);
      const key = scalarKey(pair[0], index);
      if (key in out) throw new YamlError(`duplicate key ${key}`, index);
      at++;
      out[key] = parseValue(pair[1], indent, index);
    }
    return out;
  }

  function parseSequence(indent) {
    const out = [];
    for (;;) {
      skipBlank();
      if (at >= lines.length || lines[at].indent !== indent || !/^-( |$)/.test(lines[at].text.trim())) break;
      const { text, index } = lines[at];
      const afterDash = text.slice(indent + 1);
      const gap = afterDash.length - afterDash.trimStart().length;
      const content = stripComment(afterDash.trim());
      if (content === "") {
        at++;
        out.push(parseValue("", indent, index));
        continue;
      }
      const column = indent + 1 + gap;
      if (!/^[[{]/.test(content) && splitKey(content) !== null) {
        // A mapping that starts on the dash's line: read it as if the dash were blank space.
        lines[at] = { text: " ".repeat(column) + text.slice(column), indent: column, index };
        out.push(parseMapping(column));
      } else {
        at++;
        out.push(scalar(content, index));
      }
    }
    return out;
  }

  skipBlank();
  const result = at >= lines.length ? null : parseBlock(0);
  skipBlank();
  if (at < lines.length) throw new YamlError(`unexpected content: ${lines[at].text.trim()}`, lines[at].index);
  return result;
}
