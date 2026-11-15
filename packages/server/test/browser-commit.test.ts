import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELDS_MAX,
  MASK,
  VALUES_HIDDEN,
  VALUE_MAX,
  actionReason,
  bodyText,
  containsCardNumber,
  describeBody,
  describeClick,
  describeRequest,
  looksLikeCommit,
  shownFields,
  shownValue,
  typingRefusal,
} from "../src/browser/commit.js";

/** What counts as a commit and how it is shown to the person: pure rules, no browser. */

test("looksLikeCommit: buttons and links whose name says buy, send, delete, sign up... in English", () => {
  for (const name of ["Buy now", "Place order", "Place your order", "Pay", "Pay now", "Checkout", "Check out", "Purchase", "Confirm", "Confirm order", "Delete", "Delete account", "Remove from cart", "Send", "Send message", "Post", "Post comment", "Publish", "Submit", "Subscribe", "Sign up", "Signup", "Register", "Book now", "Reserve a table", "Donate", "Transfer", "Unsubscribe"]) {
    assert.equal(looksLikeCommit("button", name), true, name);
  }
  assert.equal(looksLikeCommit("link", "Sign up for free"), true);
  assert.equal(looksLikeCommit("menuitem", "Delete"), true);
});

test("looksLikeCommit: the same in Portuguese, with or without accents", () => {
  for (const name of ["Comprar", "Compre agora", "Finalizar compra", "Pagar", "Pagamento", "Confirmar pedido", "Excluir conta", "Apagar", "Remover do carrinho", "Enviar", "Envie sua mensagem", "Publicar", "Postar", "Assinar", "Inscreva-se", "Cadastrar", "Registrar", "Reservar", "Doar", "Transferir", "Agendar", "Contratar"]) {
    assert.equal(looksLikeCommit("button", name), true, name);
  }
  assert.equal(looksLikeCommit("button", "Confirmação"), false, "a word that merely begins with one is not a verb");
});

test("looksLikeCommit: looking at things, other roles and plain words are not commits", () => {
  for (const name of ["Search", "Next", "Read more", "Orders", "Order history", "Order status", "Track order", "Postal code", "Reservations list", "Details", "Close", "Cancel", "Menu", "Buyer guide", "Meus pedidos", "Histórico de pedidos", "Rastrear pedido", "Contato", ""]) {
    assert.equal(looksLikeCommit("button", name), false, name);
  }
  assert.equal(looksLikeCommit("textbox", "Send to"), false, "a field is not a button");
  assert.equal(looksLikeCommit("heading", "Delete"), false);
  assert.equal(looksLikeCommit("StaticText", "Buy"), false);
});

test("containsCardNumber: 13 to 19 digits that pass the Luhn check, however they are spaced", () => {
  for (const card of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "my card is 5500 0000 0000 0004 ok", "378282246310005", "6011111111111117"]) {
    assert.equal(containsCardNumber(card), true, card);
  }
  for (const other of ["4111111111111112", "1234567890123", "hello", "2026-11-10 12:30", "+55 11 91234-5678", "12345678", "000000000000"]) {
    assert.equal(containsCardNumber(other), false, other);
  }
});

test("typingRefusal: a password field and a card number are refused, with words the model can act on", () => {
  assert.match(typingRefusal("4111 1111 1111 1111", null) ?? "", /card number/);
  assert.match(typingRefusal("hunter2", { type: "password", autocomplete: "", name: "x" }) ?? "", /password or payment/);
  assert.match(typingRefusal("hunter2", { type: "text", autocomplete: "current-password", name: "x" }) ?? "", /password or payment/);
  assert.match(typingRefusal("123", { type: "text", autocomplete: "cc-csc", name: "x" }) ?? "", /password or payment/);
  assert.match(typingRefusal("x", { type: "text", autocomplete: "", name: "senha" }) ?? "", /password or payment/);
  assert.equal(typingRefusal("Ana Souza", { type: "text", autocomplete: "name", name: "customer" }), null);
  assert.equal(typingRefusal("blue widget", null), null);
});

test("shownValue: passwords, secrets and card numbers are masked, the rest is clipped and cleaned", () => {
  assert.equal(shownValue("password", "hunter2"), MASK);
  assert.equal(shownValue("pw", "hunter2"), MASK);
  assert.equal(shownValue("q", "hunter2", "password"), MASK);
  assert.equal(shownValue("csrf_token", "abc"), MASK);
  assert.equal(shownValue("card_number", "4111 1111 1111 1111"), MASK);
  assert.equal(shownValue("note", "pay with 4111 1111 1111 1111"), MASK, "a card number anywhere in a value");
  assert.equal(shownValue("password", ""), "", "an empty secret is empty");
  assert.equal(shownValue("name", "  Ana \n Souza  "), "Ana Souza");
  const long = shownValue("message", "x".repeat(500));
  assert.equal(long.length, VALUE_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(shownValue("m", "a‮b\u0007c"), "a b c", "invisible and control characters do not hide anything");
});

test("shownFields: a file is shown by name only, and a long form is cut", () => {
  assert.deepEqual(shownFields([{ name: "photo", value: "me.png", file: true }, { name: "empty", value: "", file: true }]), [
    { name: "photo", value: "(file) me.png" },
    { name: "empty", value: "(no file)" },
  ]);
  const many = shownFields(Array.from({ length: FIELDS_MAX + 5 }, (_, i) => ({ name: `f${i}`, value: String(i) })));
  assert.equal(many.length, FIELDS_MAX + 1);
  assert.deepEqual(many.at(-1), { name: "…", value: "5 more fields" });
  assert.deepEqual(shownFields([{ name: "", value: "no name" }]), []);
});

test("describeBody: a urlencoded form, a multipart form with a file, JSON, and what cannot be read", () => {
  const form = describeBody("application/x-www-form-urlencoded", "item=Blue+Widget&qty=2&password=hunter2&card=4111111111111111", []);
  assert.deepEqual(describeBody("application/x-www-form-urlencoded", "login=ana&code=letmein", ["code"]).fields, [{ name: "login", value: "ana" }, { name: "code", value: MASK }], "a field the page says is a password input is masked whatever it is called");
  assert.deepEqual(form.fields, [
    { name: "item", value: "Blue Widget" },
    { name: "qty", value: "2" },
    { name: "password", value: MASK },
    { name: "card", value: MASK },
  ]);
  const boundary = "----b123";
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="passport.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-secret-bytes\r\n--${boundary}--\r\n`;
  const parts = describeBody(`multipart/form-data; boundary=${boundary}`, multipart, []);
  assert.deepEqual(parts.fields, [
    { name: "title", value: "Hello" },
    { name: "file", value: "(file) passport.pdf" },
  ]);
  assert.ok(!JSON.stringify(parts).includes("secret-bytes"), "the bytes of a file are never shown");
  assert.deepEqual(describeBody("application/json", '{"to":"a@b.example","body":"hi","n":3}', []).fields, [
    { name: "to", value: "a@b.example" },
    { name: "body", value: "hi" },
    { name: "n", value: "3" },
  ]);
  assert.match(describeBody("application/json", "[1,2]", []).note, /request of 5 characters/);
  assert.match(describeBody("text/plain", "hello", []).note, /request of 5 characters \(text\/plain\)/);
  assert.match(describeBody("application/x-www-form-urlencoded", undefined, []).note, /could not be read/);
  assert.match(describeBody("multipart/form-data", "x", []).note, /could not be read/);
});

test("a page that did not say which inputs are passwords: every value is hidden and the card says so; one that did keeps its values", () => {
  const ask = (body: string, secrets: string[] | null, contentType = "application/x-www-form-urlencoded") => describeRequest({ url: "https://shop.example/buy", method: "POST", title: "Cart", contentType, body, secrets });
  const unknown = ask("item=Blue+Widget&zz=hunter-two&note=", null);
  assert.deepEqual(unknown.fields, [{ name: "item", value: MASK }, { name: "zz", value: MASK }, { name: "note", value: "" }], "an empty value stays empty: nothing to hide");
  assert.equal(unknown.note, VALUES_HIDDEN);
  assert.match(VALUES_HIDDEN, /did not say which fields are passwords/);
  const known = ask("item=Blue+Widget&zz=hunter-two&note=", ["zz"]);
  assert.deepEqual(known.fields, [{ name: "item", value: "Blue Widget" }, { name: "zz", value: MASK }, { name: "note", value: "" }]);
  assert.equal("note" in known, false, "no words when nothing is hidden for that reason");
  assert.equal("note" in ask("a=&b=", null), false, "nothing to hide, nothing said");
  assert.equal("note" in ask("", null), false);

  const boundary = "----b9";
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nbytes\r\n--${boundary}--\r\n`;
  const parts = ask(multipart, null, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(parts.fields, [{ name: "title", value: MASK }, { name: "file", value: "(file) a.pdf" }], "a file is still shown by its name");
  assert.equal(parts.note, VALUES_HIDDEN);
  assert.deepEqual(ask('{"to":"a@b.example"}', null, "application/json").fields, [{ name: "to", value: MASK }]);

  // A field read with its own type (a click) is judged by that type; `null` is for what a request cannot say.
  assert.deepEqual(shownFields([{ name: "x", value: "v", type: "password" }, { name: "y", value: "v" }]), [{ name: "x", value: MASK }, { name: "y", value: "v" }]);
  assert.deepEqual(shownFields([{ name: "y", value: "v" }, { name: "photo", value: "a.png", file: true }], null), [{ name: "y", value: MASK }, { name: "photo", value: "(file) a.png" }]);
});

test("bodyText: the post data, or the entries newer browsers give instead", () => {
  assert.equal(bodyText({ postData: "a=1" }), "a=1");
  assert.equal(bodyText({ postDataEntries: [{ bytes: Buffer.from("a=").toString("base64") }, { bytes: Buffer.from("1").toString("base64") }] }), "a=1");
  assert.equal(bodyText({}), undefined);
});

test("describeRequest and describeClick: the site, the page, what happens and what is sent", () => {
  const post = describeRequest({ url: "https://shop.example/buy?utm=1#x", method: "POST", title: "Checkout", contentType: "application/x-www-form-urlencoded", body: "item=Widget&cvv=123", secrets: [] });
  assert.deepEqual(post, { origin: "https://shop.example", page: "Checkout", what: "Send a form to https://shop.example/buy", fields: [{ name: "item", value: "Widget" }, { name: "cvv", value: MASK }] });
  assert.equal(describeRequest({ url: "https://a.example/x", method: "PUT", title: "", contentType: "", body: undefined, secrets: [] }).what, "Send a PUT request to https://a.example/x");
  assert.deepEqual(describeRequest({ url: "https://a.example/x", method: "POST", title: "", contentType: "text/plain", body: "hello", secrets: [] }).fields, [{ name: "contents", value: "A request of 5 characters (text/plain)." }]);

  const click = describeClick({ origin: "https://shop.example", page: "Cart", verb: "Click", label: "Place order", form: { action: "https://shop.example/order?x=1", fields: [{ name: "address", value: "Rua A, 1" }, { name: "password", value: "p", type: "password" }, { name: "id", value: "my.pdf", type: "file" }] } });
  assert.equal(click.what, "Click “Place order”, which sends a form to https://shop.example/order");
  assert.deepEqual(click.fields, [{ name: "address", value: "Rua A, 1" }, { name: "password", value: MASK }, { name: "id", value: "(file) my.pdf" }]);
  assert.deepEqual(describeClick({ origin: "https://a.example", page: "P", verb: "Click", label: "Delete", form: null }).fields, []);
  assert.match(actionReason(click), /^Waiting for your approval: Click “Place order”.* \(on https:\/\/shop\.example\)\.$/, "it says approval, which the call counts as waiting on the person");
});
