import * as db from "./db.js";

const DEFAULT_OPTIONS = {
  recordEvents: true,          // log clicks, inputs, submits, key navigation, drag/drop
  captureStateChanges: true,   // also snapshot when classes/attributes/selection change (not just text/structure)
  includeShadow: true,         // walk open + closed shadow roots
  stripScripts: true,          // drop <script>, <style>, <noscript> contents
  stripSvg: true,              // replace inline <svg> bodies with a placeholder
  includeVisibleText: true,    // store document.body.innerText with each snapshot
  settleMs: 700,               // wait this long after the DOM stops changing
  maxWaitMs: 4000,             // ...but never wait longer than this on busy pages
  maxSnapshotsPerUrl: 80,      // safety cap per URL per page load
  maxElements: 4000,           // cap on summarized elements per snapshot
  maxTextLength: 160,
};

const DEFAULT_STATE = { recording: false, scope: "host", host: "", sessionId: null, options: DEFAULT_OPTIONS };

let state = null;

async function getState() {
  if (!state) {
    const { state: saved } = await chrome.storage.local.get("state");
    state = { ...DEFAULT_STATE, ...(saved || {}), options: { ...DEFAULT_OPTIONS, ...((saved || {}).options || {}) } };
  }
  return state;
}

async function setState(patch) {
  const s = await getState();
  state = { ...s, ...patch, options: { ...s.options, ...(patch.options || {}) } };
  await chrome.storage.local.set({ state });
  return state;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
  } catch {}
  return "";
}

function inScope(s, tabUrl) {
  const h = hostOf(tabUrl);
  if (!h) return false;
  if (s.scope === "all") return true;
  return h === s.host || h.endsWith("." + s.host);
}

async function updateBadge() {
  const s = await getState();
  const n = await db.count("snapshots");
  await chrome.action.setBadgeBackgroundColor({ color: s.recording ? "#dc322f" : "#586e75" });
  await chrome.action.setBadgeText({ text: s.recording ? String(n || "REC") : "" });
}

async function broadcast(type) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type }).catch(() => {})));
}

async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {} // restricted pages (chrome://, web store) can't be injected
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function start({ tabId, host, scope, options }) {
  await setState({
    recording: true,
    scope: scope || "host",
    host: host || "",
    sessionId: Date.now(),
    options: options || {},
  });
  if (tabId) await injectInto(tabId);
  await broadcast("refresh");
  await updateBadge();
}

async function stop() {
  await setState({ recording: false });
  await broadcast("refresh");
  await updateBadge();
}

async function handle(msg, sender) {
  const s = await getState();
  switch (msg.type) {
    case "hello":
      return { record: s.recording && inScope(s, sender.tab?.url || ""), options: s.options };

    case "snapshot": {
      if (!s.recording && !msg.force) return { ignored: true };
      const meta = { ...msg.meta, sessionId: s.sessionId, tabId: sender.tab?.id, frameId: sender.frameId };
      const r = await db.addSnapshot(meta, msg.html, !!msg.force);
      updateBadge();
      return r;
    }

    case "events": {
      if (!s.recording) return { ignored: true };
      await db.addEvents(
        msg.events.map((e) => ({ ...e, sessionId: s.sessionId, tabId: sender.tab?.id, frameId: sender.frameId }))
      );
      return { ok: true };
    }

    case "getState":
      return {
        state: s,
        counts: { snapshots: await db.count("snapshots"), events: await db.count("events") },
      };

    case "start":
      await start(msg);
      return { ok: true };

    case "stop":
      await stop();
      return { ok: true };

    case "setOptions":
      await setState({ options: msg.options });
      await broadcast("refresh");
      return { ok: true };

    case "snapshotNow":
      if (!(await getState()).recording) await injectInto(msg.tabId);
      await chrome.tabs.sendMessage(msg.tabId, { type: "snapshot-now" }).catch(() => {});
      return { ok: true };

    case "clear":
      await db.clearAll();
      await updateBadge();
      return { ok: true };
  }
  return { error: "unknown message" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const tab = await activeTab();
  if (!tab?.id) return;
  if (cmd === "snapshot-now") {
    await handle({ type: "snapshotNow", tabId: tab.id }, {});
  } else if (cmd === "toggle-recording") {
    const s = await getState();
    if (s.recording) await stop();
    else await start({ tabId: tab.id, host: hostOf(tab.url || ""), scope: "host", options: s.options });
  }
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
