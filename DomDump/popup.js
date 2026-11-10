const $ = (id) => document.getElementById(id);
const call = (msg) => chrome.runtime.sendMessage(msg);

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
  } catch {}
  return "";
}

let tab, host, current;

function readOptions() {
  const o = {};
  document.querySelectorAll("[data-opt]").forEach((c) => (o[c.dataset.opt] = c.checked));
  return o;
}

async function render() {
  const { state, counts } = await call({ type: "getState" });
  current = state;
  $("dot").classList.toggle("on", state.recording);
  $("title").textContent = state.recording ? "Recording…" : "DOM Recorder";
  $("stats").textContent =
    `${counts.snapshots} snapshots · ${counts.events} events` +
    (state.recording ? ` · ${state.scope === "all" ? "all sites" : state.host}` : "");
  const t = $("toggle");
  t.textContent = state.recording ? "Stop recording" : "Start recording";
  t.className = state.recording ? "stop" : "primary";
  t.disabled = !state.recording && !host && $("scope").value !== "all";
  $("scope").disabled = state.recording;
  document.querySelectorAll("[data-opt]").forEach((c) => (c.checked = !!state.options[c.dataset.opt]));
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostOf(tab?.url || "");
  const sc = $("scope");
  sc.innerHTML = "";
  if (host) sc.add(new Option(`This site only (${host} + subdomains)`, "host"));
  sc.add(new Option("All sites", "all"));
  const { state } = await call({ type: "getState" });
  if (state.recording) {
    sc.value = state.scope;
    if (state.scope === "host" && ![...sc.options].some((o) => o.value === "host")) sc.add(new Option(`This site only (${state.host})`, "host"), 0);
    sc.value = state.scope;
  }
  await render();
}

$("toggle").onclick = async () => {
  if (current.recording) await call({ type: "stop" });
  else {
    const scope = $("scope").value;
    await call({ type: "start", tabId: tab?.id, host: scope === "host" ? host : "", scope, options: readOptions() });
  }
  await render();
};
$("snap").onclick = async () => {
  await call({ type: "snapshotNow", tabId: tab.id });
  setTimeout(render, 600);
};
$("view").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
$("clear").onclick = async () => {
  if (confirm("Delete all recorded snapshots and events?")) {
    await call({ type: "clear" });
    await render();
  }
};
document.querySelectorAll("[data-opt]").forEach((c) =>
  c.addEventListener("change", () => call({ type: "setOptions", options: readOptions() }))
);

init();
setInterval(render, 1500);
