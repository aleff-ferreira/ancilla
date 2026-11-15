import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guessLanguage, hasCodeSwitch, isBackchannel, isStopIntent, paceForText, readCompleteness, SpeechChunker, toSpeakable, wordsOf } from "../src/voice/text.js";

function chunk(deltas: string[], lang: "en" | "pt" | "unknown" = "en"): string[] {
  const c = new SpeechChunker(() => lang);
  const out: string[] = [];
  for (const d of deltas) out.push(...c.push(d));
  out.push(...c.flush());
  return out;
}

const chars = (text: string): string[] => [...text];

describe("language guess", () => {
  it("tells English from Portuguese by the words that are only in one of them", () => {
    assert.equal(guessLanguage("What time is the meeting tomorrow?"), "en");
    assert.equal(guessLanguage("Que horas é a reunião amanhã?"), "pt");
    assert.equal(guessLanguage("Eu preciso de ajuda com isso"), "pt");
    assert.equal(guessLanguage("ok"), "unknown");
    assert.equal(guessLanguage(""), "unknown");
  });
  it("splits words and keeps accents and apostrophes", () => {
    assert.deepEqual(wordsOf("Don't stop, não pare!"), ["don't", "stop", "não", "pare"]);
  });
  it("detects natural bilingual code-switching within a single turn", () => {
    assert.equal(hasCodeSwitch("Pode checar the deploy status na branch principal?"), true);
    assert.equal(hasCodeSwitch("What time is the meeting tomorrow?"), false);
    assert.equal(hasCodeSwitch("Que horas é a reunião amanhã?"), false);
  });
});

describe("sounds of listening and words that stop", () => {
  it("recognises backchannels in both languages and nothing longer", () => {
    for (const s of ["mm-hm", "Yeah.", "uh huh", "okay", "aham", "Tá bom", "sim, sim", "got it", "hmm"]) assert.equal(isBackchannel(s), true, s);
    for (const s of ["yeah but I disagree", "what is that", "não é isso que eu quero", "", "tell me more"]) assert.equal(isBackchannel(s), false, s);
  });
  it("hears a request to stop whatever else is said, but not a long sentence that happens to hold the word", () => {
    for (const s of ["stop", "wait a second", "hold on", "Stop. Stop talking.", "pera aí", "espera", "pare", "um segundo", "actually, no"]) assert.equal(isStopIntent(s), true, s);
    for (const s of ["I stopped by the store on the way back from the office yesterday", "tell me about the weather", "sim"]) assert.equal(isStopIntent(s), false, s);
  });
});

describe("has the person finished", () => {
  const cases: Array<[string, string, boolean?]> = [
    ["What time is it?", "complete"],
    ["Set a timer for ten minutes.", "complete"],
    ["I want to book a flight and", "incomplete"],
    ["I want to book a flight and,", "incomplete"],
    ["so I was thinking...", "incomplete"],
    ["um", "incomplete"],
    ["I need to uh", "incomplete"],
    ["I think so.", "complete"],
    ["I think so", "incomplete"],
    ["my number is 5 5 5 1 2", "incomplete"],
    ["my number is 555 1234", "unknown"],
    ["Eu queria saber se", "incomplete"],
    ["Que horas são?", "complete"],
    ["Eu acho que sim.", "complete"],
    ["é...", "incomplete"],
    ["tipo", "incomplete"],
    ["Open the calendar", "unknown"],
    ["", "unknown"],
  ];
  for (const [text, verdict] of cases) {
    it(`reads "${text}" as ${verdict}`, () => assert.equal(readCompleteness(text).verdict, verdict, readCompleteness(text).why));
  }
  it("answers a one-word command quickly", () => {
    for (const s of ["stop", "yes", "no", "sim", "não", "pause"]) assert.equal(readCompleteness(s).command, true, s);
    assert.equal(readCompleteness("yes please open it").command, false);
  });
  it("holds the turn open on mid-utterance self-correction pivots and closes unpunctuated multi-word questions", () => {
    for (const s of [
      "deploy to production wait no",
      "schedule it for three actually",
      "check the auth service i mean",
      "manda para produção quer dizer",
      "às três horas na verdade",
      "no ambiente antigo ou melhor",
    ]) {
      assert.equal(readCompleteness(s).verdict, "incomplete", `${s}: ${readCompleteness(s).why}`);
    }
    for (const s of [
      "what time is the deployment",
      "where did we put the credentials",
      "qual é o status da tarefa",
      "onde ficou salvo o arquivo",
    ]) {
      assert.equal(readCompleteness(s).verdict, "complete", `${s}: ${readCompleteness(s).why}`);
    }
  });
  it("paces crisp acknowledgements slightly faster and number-heavy clauses slightly steadier", () => {
    assert.ok(paceForText("Got it.", 1.0) > 1.0);
    assert.ok(paceForText("Port 8080 had 14 errors at 12:30.", 1.0) < 1.0);
    assert.equal(paceForText("I checked the repository configuration and everything looks clean.", 1.0), 1.0);
  });
});

describe("what is worth saying aloud", () => {
  it("drops markup and keeps the words", () => {
    assert.equal(toSpeakable("## Heading\n- one\n- two\n**bold** and *soft* and ~~gone~~").text, "Heading\none\ntwo\nbold and soft and gone");
    assert.equal(toSpeakable("see [the docs](https://example.com/very/long/path) now").text, "see the docs now");
  });
  it("leaves code, tables and links for the eyes and says so", () => {
    const r = toSpeakable("Here it is:\n```ts\nconst a = 1;\n```\nDone. Visit https://example.com/x for more.", "en");
    assert.equal(r.visual, true);
    assert.ok(!r.text.includes("const"));
    assert.ok(r.text.includes("a link"));
    assert.equal(toSpeakable("Visit https://example.com", "pt").text, "Visit um link");
    assert.equal(toSpeakable("| a | b |\n|---|---|\n| 1 | 2 |").visual, true);
  });
  it("keeps a short code word that can be said and drops a snippet that is for the eyes", () => {
    assert.deepEqual(toSpeakable("run `npm test` please"), { text: "run npm test please", visual: false });
    assert.equal(toSpeakable("use `main` please").text, "use main please");
    const snippet = toSpeakable("call `const x = (a) => a + 1;` first");
    assert.equal(snippet.visual, true);
    assert.equal(snippet.text.includes("const"), false);
  });
  it("removes emoji and arrows", () => {
    assert.equal(toSpeakable("Great \u{1F389} work -> done").text, "Great work , done");
  });
});

describe("cutting a reply that is still arriving", () => {
  it("lets the first short sentence out as soon as it is whole", () => {
    const c = new SpeechChunker(() => "en");
    assert.deepEqual(c.push("Sure"), []);
    assert.deepEqual(c.push("."), []); // the next character decides
    assert.deepEqual(c.push(" Let me"), ["Sure."]);
    assert.deepEqual(c.flush(), ["Let me"]);
  });

  it("gives the same pieces however the text is split into deltas", () => {
    const text = "Sure. Let me check that for you, one moment while I look. The answer is 3.5 percent, which is about what we expected. Anything else?";
    const whole = chunk([text]);
    const letters = chunk(chars(text));
    const words = chunk(text.split(/(?<= )/));
    assert.deepEqual(letters, whole);
    assert.deepEqual(words, whole);
    assert.equal(whole[0], "Sure.");
    assert.ok(whole.every((p) => p.trim() === p && p.length > 0));
  });

  it("does not split on a decimal, an abbreviation or an initial", () => {
    const pieces = chunk(["Dr. Smith said the rate is 3.5 percent. J. R. Tolkien wrote it. Fine."]);
    assert.equal(pieces.join(" "), "Dr. Smith said the rate is 3.5 percent. J. R. Tolkien wrote it. Fine.");
    assert.ok(!pieces.some((p) => p === "Dr."));
    assert.ok(!pieces.some((p) => p === "J." || p === "R."));
  });

  it("cuts a long first sentence at a clause so the voice can start", () => {
    const pieces = chunk(["Well, I looked at all of the options you gave me yesterday and the best one by far is the second plan because it costs less."]);
    assert.ok(pieces.length >= 2);
    assert.ok((pieces[0] as string).length <= 72, pieces[0]);
    assert.equal(pieces.join(" ").replace(/\s+/g, " "), "Well, I looked at all of the options you gave me yesterday and the best one by far is the second plan because it costs less.");
  });

  it("joins very short later sentences so the engine has a phrase", () => {
    const pieces = chunk(["Okay then. Yes. Right. That is what I will do next for you, starting now. Done."]);
    assert.equal(pieces[0], "Okay then.");
    assert.ok(pieces.slice(1).every((p, i, all) => p.length >= 20 || i === all.length - 1), JSON.stringify(pieces));
  });

  it("never speaks a code block, even one split across deltas", () => {
    const text = "Here is the fix.\n```js\nconst x = 1;\nconsole.log(x);\n```\nThat should do it.";
    const c = new SpeechChunker(() => "en");
    const out: string[] = [];
    for (const d of chars(text)) out.push(...c.push(d));
    out.push(...c.flush());
    assert.equal(out.join(" ").includes("const"), false);
    assert.ok(out.join(" ").includes("That should do it."));
    assert.equal(c.hasVisual, true);
  });

  it("drops an unfinished code block at the end", () => {
    const out = chunk(["Look:\n```py\nprint(1)"]);
    assert.equal(out.join(" ").includes("print"), false);
  });

  it("cuts at newlines, as in a list", () => {
    const out = chunk(["First, open the file.\n- second item here\n- third item here\nThen save it."]);
    assert.ok(out.length >= 2);
    assert.equal(out.join(" ").includes("-"), false);
  });

  it("handles Portuguese", () => {
    const out = chunk(["Claro. Vou verificar isso agora, só um instante. A resposta é 3,5 por cento. Mais alguma coisa?"], "pt");
    assert.equal(out[0], "Claro.");
    assert.ok(out.join(" ").includes("3,5 por cento"));
  });

  it("speaks the last words of a reply that has no mark at the end", () => {
    assert.deepEqual(chunk(["Sure. Go ahead"]).slice(-1), ["Go ahead"]);
  });

  it("makes nothing out of nothing", () => {
    assert.deepEqual(chunk([""]), []);
    assert.deepEqual(chunk(["   \n  "]), []);
  });
});
