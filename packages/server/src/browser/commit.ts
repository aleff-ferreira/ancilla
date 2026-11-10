/**
 * What counts as an action that changes something in the world, and how it is put to the person. Pure functions, so the rules
 * are tested without a browser: the name heuristic (English and Portuguese), how a request body or a form is shown (values
 * clipped, secrets masked, a file only by name), and which text the assistant may never type.
 *
 * Two things are caught, and the docs say what is not: a form the page sends as a main-page or frame navigation with a method
 * other than GET (held in the browser before it leaves), and a click or key on an element whose name says it commits.
 */

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

export interface ShownField {
  name: string;
  value: string;
}

/** What the person is asked about: the page it happens on, what is about to happen, and what will be sent. */
export interface ActionAsk {
  /** The site the page is on (origin). */
  origin: string;
  /** The title of that page. */
  page: string;
  /** The action in words: "Click “Place order”", "Send a form to https://shop.example/buy". */
  what: string;
  fields: ShownField[];
}

export const VALUE_MAX = 200;
export const FIELDS_MAX = 12;
export const MASK = "••••••••";

// ---------------------------------------------------------------- names that commit

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const COMMIT_EN = ["buy", "purchase", "order", "pay", "checkout", "check out", "confirm", "delete", "remove", "send", "post", "publish", "submit", "subscribe", "unsubscribe", "sign ?up", "register", "book", "reserve", "donate", "transfer"];
const COMMIT_PT = ["comprar", "compre", "finalizar", "pagar", "pague", "pagamento", "confirmar", "confirme", "excluir", "exclua", "apagar", "deletar", "remover", "remova", "enviar", "envie", "postar", "publicar", "publique", "assinar", "assine", "inscrever", "inscreva", "cadastrar", "cadastre", "registrar", "registre", "reservar", "doar", "doe", "transferir", "transfira", "agendar", "contratar"];
const COMMIT_WORDS = new RegExp(`(?:^|[^a-z])(?:${[...COMMIT_EN, ...COMMIT_PT].join("|")})(?:[^a-z]|$)`);
/** A link to somewhere you look at your orders is not an order. */
const LOOKING = /(?:^|[^a-z])(?:history|status|track|tracking|summary|details?|historico|rastrear|rastreio|detalhes?)(?:[^a-z]|$)/;
const COMMIT_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "PopUpButton"]);

/** Whether an element with this role and accessible name looks like it commits something (buy, send, delete, sign up...). */
export function looksLikeCommit(role: string, name: string): boolean {
  if (!COMMIT_ROLES.has(role)) return false;
  const text = plain(name).slice(0, 200);
  return COMMIT_WORDS.test(text) && !LOOKING.test(text);
}

// ---------------------------------------------------------------- secrets and card numbers

const SECRET_NAME = /pass(?:word|wd)?|\bpw\b|pwd|senha|secret|token|cvv|cvc|csrf|card|cartao|credit|iban|ssn|cpf|otp|\bpin\b|authenticity/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

/** Whether the text holds a card number: 13 to 19 digits (spaces and dashes allowed) that pass the Luhn check. */
export function containsCardNumber(text: string): boolean {
  for (const run of text.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]", "g");

/** One field as the person sees it: a password, a secret-looking name or a card number is masked, the rest clipped. */
export function shownValue(name: string, value: string, type = ""): string {
  if (type === "password" || SECRET_NAME.test(name) || containsCardNumber(value)) return value === "" ? "" : MASK;
  const text = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/** `secrets`: names of the page's password inputs (a request carries no input types, so the page says which they are). */
export function shownFields(fields: Array<{ name: string; value: string; type?: string; file?: boolean }>, secrets: readonly string[] = []): ShownField[] {
  const out: ShownField[] = [];
  for (const field of fields.slice(0, FIELDS_MAX)) {
    const name = field.name.replace(CONTROL, " ").trim().slice(0, 60);
    if (name === "") continue;
    out.push({ name, value: field.file ? (field.value === "" ? "(no file)" : `(file) ${field.value.slice(0, 80)}`) : shownValue(name, field.value, secrets.includes(field.name) ? "password" : (field.type ?? "")) });
  }
  if (fields.length > FIELDS_MAX) out.push({ name: "…", value: `${fields.length - FIELDS_MAX} more fields` });
  return out;
}

/** Why the assistant may not type this, or null when it may. The message is for the model. */
export function typingRefusal(text: string, field: { type: string; autocomplete: string; name: string } | null): string | null {
  if (containsCardNumber(text)) return "That looks like a card number. The assistant never types card numbers: call done and tell the person to enter it themselves.";
  if (field && (field.type === "password" || /password|^cc-/.test(field.autocomplete) || /^(?:pass(?:word|wd)?|pwd|senha|cvv|cvc)$/i.test(field.name))) {
    return "That is a password or payment field. The assistant never types passwords or card details: call done and tell the person to do this step themselves.";
  }
  return null;
}

// ---------------------------------------------------------------- what a request sends

/** What a form submission sends, as far as the browser lets it be read. */
export interface RequestBody {
  fields: ShownField[];
  /** Said when the fields could not be listed. */
  note: string;
}

function decodeEntries(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const bytes = (entry as { bytes?: unknown } | null)?.bytes;
    if (typeof bytes === "string") parts.push(Buffer.from(bytes, "base64"));
  }
  return parts.length === 0 ? undefined : Buffer.concat(parts).toString("utf8");
}

/** The body of a paused request: `postData`, or the entries newer browsers give instead. */
export function bodyText(request: { postData?: unknown; postDataEntries?: unknown }): string | undefined {
  return typeof request.postData === "string" ? request.postData : decodeEntries(request.postDataEntries);
}

export function describeBody(contentType: string, body: string | undefined, secrets: readonly string[] = []): RequestBody {
  if (body === undefined) return { fields: [], note: "What the form sends could not be read." };
  const type = contentType.toLowerCase();
  if (type.includes("multipart/form-data")) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
    if (!boundary) return { fields: [], note: "What the form sends could not be read." };
    const fields: Array<{ name: string; value: string; file?: boolean }> = [];
    for (const part of body.split(`--${boundary}`)) {
      const split = part.indexOf("\r\n\r\n");
      if (split < 0) continue;
      const head = part.slice(0, split);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      if (name === undefined) continue;
      const file = /filename="([^"]*)"/i.exec(head)?.[1];
      fields.push(file !== undefined ? { name, value: file, file: true } : { name, value: part.slice(split + 4).replace(/\r\n$/, "") });
    }
    return { fields: shownFields(fields, secrets), note: "" };
  }
  if (type.includes("json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { fields: shownFields(Object.entries(parsed).map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value) ?? "" })), secrets), note: "" };
      }
    } catch {
      // not JSON after all
    }
    return { fields: [], note: `A request of ${body.length} characters.` };
  }
  if (type === "" || type.includes("x-www-form-urlencoded")) {
    return { fields: shownFields([...new URLSearchParams(body).entries()].map(([name, value]) => ({ name, value })), secrets), note: "" };
  }
  return { fields: [], note: `A request of ${body.length} characters (${type.split(";")[0]}).` };
}

function address(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

/** A form (or another request) the page is about to send, as the person is asked about it. */
export function describeRequest(request: { url: string; method: string; title: string; contentType: string; body: string | undefined; secrets?: readonly string[] }): ActionAsk {
  const sent = describeBody(request.contentType, request.body, request.secrets ?? []);
  const fields = sent.fields.length > 0 || sent.note === "" ? sent.fields : [{ name: "contents", value: sent.note }];
  const verb = request.method.toUpperCase() === "POST" ? "Send a form to" : `Send a ${request.method.toUpperCase()} request to`;
  return { origin: originOf(request.url) ?? request.url.slice(0, 80), page: request.title.replace(CONTROL, " ").trim().slice(0, 120), what: `${verb} ${address(request.url)}`, fields };
}

/** An element the assistant is about to click or press, as the person is asked about it. */
export function describeClick(input: {
  origin: string;
  page: string;
  verb: string;
  label: string;
  form: { action: string; fields: Array<{ name: string; value: string; type?: string; file?: boolean }> } | null;
}): ActionAsk {
  const label = input.label.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const sends = input.form && input.form.action !== "" ? `, which sends a form to ${address(input.form.action)}` : "";
  return {
    origin: input.origin,
    page: input.page.replace(CONTROL, " ").trim().slice(0, 120),
    what: `${input.verb} “${label}”${sends}`,
    fields: input.form ? shownFields(input.form.fields.map((f) => ({ ...f, file: f.type === "file" }))) : [],
  };
}

/** The reason a task shows while it waits for this action: it says "approval", which the call treats as waiting on the person. */
export function actionReason(ask: { what: string; origin: string }): string {
  return `Waiting for your approval: ${ask.what} (on ${ask.origin}).`;
}
