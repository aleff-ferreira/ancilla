#!/usr/bin/env node
/**
 * A stand-in for a language model that speaks the OpenAI chat protocol, so that the voice call can be run and measured
 * end to end without a key or a download. It answers a few things by rule (the time, the date, a greeting, "remember"),
 * asks for a background task when told to research something, and says back what it was told otherwise. It streams like a
 * real one: a wait for the first word, then a few words at a time.
 *
 *   node scripts/voice/mock-llm.mjs [--port 8790] [--ttft 300] [--pace 25]
 */
import { createServer } from "node:http";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const PORT = arg("port", 8790);
const TTFT = arg("ttft", 300);
const PACE = arg("pace", 25);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PT = /\b(você|voce|oi|olá|ola|quero|pode|que horas|hora|data|lembre|pesquis|investig|obrigad|bom dia|boa tarde|boa noite|por favor|sobre|uma|não|nao)\b/i;

function answer(messages, tools) {
  const last = messages[messages.length - 1];
  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = String(user?.content ?? "").split("\n").pop() ?? "";
  const pt = PT.test(text);
  const now = new Date();
  if (last?.role === "tool") return { text: pt ? "Certo. Comecei isso em segundo plano e aviso quando terminar." : "Okay. I started that in the background, and I will tell you when it is done." };
  if (/\b(research|investigate|look into|dig into|pesquis\w*|investig\w*)\b/i.test(text) && tools.some((t) => t.function?.name === "delegate_task")) {
    return { tool: { name: "delegate_task", args: { goal: text.slice(0, 400), title: text.slice(0, 40) } } };
  }
  if (/\b(time|hora|horas)\b/i.test(text)) return { text: pt ? `São ${now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.` : `It is ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.` };
  if (/\b(date|today|day|data|hoje)\b/i.test(text)) return { text: pt ? `Hoje é ${now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}.` : `Today is ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.` };
  if (/\b(hello|hi|hey|oi|olá|ola)\b/i.test(text)) return { text: pt ? "Oi! Como posso ajudar?" : "Hello! How can I help?" };
  if (/\bremember|lembr/i.test(text)) return { text: pt ? "Anotado." : "Noted." };
  if (/\b(long|story|explain|explique|conte)\b/i.test(text)) {
    return { text: pt ? "Claro. Primeiro, você abre a página de configurações e procura a seção de voz. Depois escolhe o motor que quer usar e aperta o botão de instalar. Quando o download terminar, a chamada começa sozinha. Se algo der errado, a página explica o que aconteceu." : "Of course. First, you open the settings page and look for the section called voice. Then you pick the engine you want and press the install button. When the download finishes, the call starts by itself. If anything goes wrong, the page tells you what happened." };
  }
  return { text: pt ? `Você disse: ${text.slice(0, 120)}. Sou só um modelo de teste.` : `You said: ${text.slice(0, 120)}. I am only a stand-in model.` };
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-voice-1" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const out = answer(body.messages ?? [], body.tools ?? []);
  let closed = false;
  req.on("close", () => (closed = true));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  await sleep(TTFT);
  if (closed) return;
  if (out.tool) {
    send({ tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args) } }] });
    send({}, "tool_calls");
  } else {
    const words = out.text.split(/(?<=\s)/);
    for (let i = 0; i < words.length; i += 3) {
      if (closed) return;
      send({ content: words.slice(i, i + 3).join("") });
      await sleep(PACE);
    }
    send({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${PORT}/v1 (first word after ${TTFT} ms, ${PACE} ms per few words)`));
