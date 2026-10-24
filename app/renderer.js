// Desktop app window logic: send questions through window.agent (preload.cjs), show answers and sources.
// Plain JavaScript because the browser side runs it as-is (no build step).

const log = document.getElementById("log");
const input = document.getElementById("question");
const askButton = document.getElementById("ask");
let history = []; // the conversation so far, sent with every question
let info = { provider: "local" }; // where the model runs; fixed for this run by .env (see main.ts)

/** Escapes text for HTML, then highlights citations like [L1] or [C1, L4] and **bold** markdown. */
function format(text) {
  const safe = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return safe
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*)\]/g, '<span class="cite">[$1]</span>');
}

function addMessage(kind, html) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

/** The line under an answer: danger badge, flags, time, model, and the sources it was given. */
function metaHtml(turn) {
  const dangers = turn.dangers.map((d) => `<span class="danger">⚠ ${d}</span>`).join("");
  const flags = turn.flags.map((f) => `<span class="flag">${format(f)}</span>`).join("");
  const sources = turn.sources
    .map((s) => {
      const link = s.url ? ` · <a href="${s.url}" target="_blank">open page</a>` : "";
      return `<li><b>${s.id}</b>${s.pinned ? " (danger card)" : ""} ${format(s.title || "")} · ${format(s.publisher)}${link}</li>`;
    })
    .join("");
  const seconds = (turn.ms.total / 1000).toFixed(1);
  return `<div class="meta">${dangers}${flags}${seconds} s · ${turn.model}
    <details><summary>${turn.sources.length} sources</summary><ul>${sources}</ul></details></div>`;
}

async function send() {
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  addMessage("you", format(question));
  const pending = addMessage("agent", info.provider === "local" ? "Thinking… (the first local answer may also load the model, up to 30 s)" : "Thinking…");
  askButton.disabled = true;
  try {
    const turn = await window.agent.ask(question, history);
    pending.innerHTML = format(turn.answer) + metaHtml(turn);
    history.push({ role: "user", text: question }, { role: "assistant", text: turn.answer });
  } catch (err) {
    pending.className = "msg error";
    const hint = info.provider === "local" ? " Is the local model running? (playground/start.sh)" : "";
    pending.textContent = `Error: ${err.message.replace(/^Error invoking remote method 'ask': /, "")}.${hint}`;
  } finally {
    askButton.disabled = false;
    input.focus();
  }
  log.scrollTop = log.scrollHeight;
}

askButton.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById("new").addEventListener("click", () => {
  history = [];
  log.innerHTML = "";
  input.focus();
});

// Show which model this run uses and where its calls go (e.g. through mitmproxy).
window.agent.info().then((i) => {
  info = i;
  const name = info.provider === "local" ? "Local" : "OpenRouter";
  const watched = /127\.0\.0\.1:(8090|8091)/.test(info.endpoint) ? " · watched by mitmproxy" : "";
  document.getElementById("mode").textContent = `${name} · ${info.model} · ${info.endpoint}${watched}`;
  input.focus();
});
