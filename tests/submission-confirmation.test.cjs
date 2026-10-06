const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../content.js"), "utf8");
const KEY = "iniadMoocsSubmissionHistory";
const URL = "https://moocs.iniad.org/courses/2026/test/task";

function fixture(shared = {}) {
  const storage = shared.storage || {};
  const session = shared.session || new Map();
  const notices = [];
  let sequence = 0;
  class Element {
    constructor(text = "提出") {
      this.textContent = text;
      this.tagName = "BUTTON";
      this.visible = true;
      this.attributes = new Map();
    }
    closest() { return null; }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, callback) { this[name] = callback; }
    getBoundingClientRect() { return { width: this.visible ? 100 : 0, height: 30 }; }
    cloneNode() { return { textContent: this.textContent, querySelectorAll: () => [] }; }
  }
  const button = new Element();
  const dialogs = [];
  const events = new Map();
  const context = vm.createContext({
    console, URL: global.URL, Date, HTMLElement: Element, Event: class { constructor(type) { this.type = type; } },
    crypto: { randomUUID: () => `operation-${++sequence}` },
    sessionStorage: {
      getItem: (key) => session.get(key),
      setItem: (key, value) => session.set(key, value),
      removeItem: (key) => session.delete(key)
    },
    window: {
      location: new global.URL(URL),
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      alert(...args) { dialogs.push(args); return "native-result"; }
    },
    document: {
      addEventListener(type, fn) { events.set(type, fn); },
      dispatchEvent(event) { events.get(event.type)?.(event); },
      title: "テスト課題",
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector.includes("[role='alert']")) return notices;
        if (selector.startsWith("button,")) return [button];
        return [];
      }
    },
    chrome: { storage: { local: {
      async get(key) { return structuredClone({ [key]: storage[key] }); },
      async set(values) { Object.assign(storage, structuredClone(values)); }
    } } }
  });
  vm.runInContext(source.replace("  initialize();", `
    renderPanel = async () => {};
    document.addEventListener("iniad-moocs-answers-saved", confirmPendingSubmission);
    globalThis.api = { attachButtonListeners, checkSubmissionConfirmation,
      restorePendingSubmission, getDeadlineState, flush: () => submissionQueue };
  `), context);
  const api = context.api;
  vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../submission-alert.js"), "utf8"), context);
  api.attachButtonListeners();
  return { storage, session, notices, button, api, Element, dialogs,
    alert: (...args) => context.window.alert(...args),
    latest: () => storage[KEY]?.[URL]?.records.at(-1),
    click: async () => { button.click(); await api.flush(); },
    scan: async () => { api.checkSubmissionConfirmation(); await api.flush(); }
  };
}

test("click records an operation; a new success notice confirms only that operation", async () => {
  const f = fixture();
  await f.click();
  assert.equal(f.latest().confirmedAt, undefined);
  f.notices.push(new f.Element("提出を記録しました。"));
  await f.scan();
  assert.ok(f.latest().confirmedAt);
  const confirmedAt = f.latest().confirmedAt;
  await f.scan();
  assert.equal(f.latest().confirmedAt, confirmedAt);
  await f.click();
  await f.scan();
  assert.equal(f.latest().confirmedAt, undefined, "old notice cannot confirm resubmission");
  f.notices.length = 0;
  await f.scan();
  f.notices.push(new f.Element("回答の提出を記録しました"));
  await f.scan();
  assert.ok(f.latest().confirmedAt);
});

test("unrelated, error, hidden and pre-existing notices do not confirm", async () => {
  const f = fixture();
  f.notices.push(new f.Element("提出しました"));
  await f.click();
  f.notices.push(new f.Element("提出を記録しましたが、エラーが発生しました"));
  f.notices.push(new f.Element("設定を保存しました"));
  const hidden = new f.Element("提出を記録しました");
  hidden.visible = false;
  f.notices.push(hidden);
  await f.scan();
  assert.equal(f.latest().confirmedAt, undefined);
  hidden.visible = true;
  await f.scan();
  assert.ok(f.latest().confirmedAt);
});

test("a success notice without a click does not create submission history", async () => {
  const f = fixture();
  f.notices.push(new f.Element("提出を記録しました"));
  await f.scan();
  assert.equal(f.latest(), undefined);
});

test("a success notice arriving before the asynchronous click write is retained", async () => {
  const f = fixture();
  f.button.click();
  f.notices.push(new f.Element("提出を記録しました"));
  await f.scan();
  assert.ok(f.latest().confirmedAt);
  assert.equal(f.storage[KEY][URL].records.length, 1);
});

test("reload recovers the pending operation even if its local write was interrupted", async () => {
  const first = fixture();
  await first.click();
  const next = fixture({ session: first.session });
  next.notices.push(new next.Element("提出を記録しました"));
  next.api.restorePendingSubmission();
  await next.api.flush();
  assert.ok(next.latest().confirmedAt);
  assert.equal(next.storage[KEY][URL].records.length, 1);
  assert.equal(next.session.size, 0);
});

test("pending operations from another page or older than two minutes are ignored", async () => {
  for (const change of [
    (pending) => { pending.pageKey += "-other"; },
    (pending) => { pending.record.clickedAt = new Date(Date.now() - 121000).toISOString(); }
  ]) {
    const f = fixture();
    await f.click();
    const pending = JSON.parse(f.session.get("iniadPendingSubmission"));
    change(pending);
    f.session.set("iniadPendingSubmission", JSON.stringify(pending));
    const next = fixture(f);
    next.notices.push(new next.Element("提出を記録しました"));
    next.api.restorePendingSubmission();
    await next.api.flush();
    assert.equal(next.latest().confirmedAt, undefined);
    assert.equal(next.session.size, 0);
  }
});

test("automatic confirmation preserves manual completion and deadline priority", async () => {
  const f = fixture({ storage: { [KEY]: { [URL]: { records: [], completedAt: "2026-01-01T00:00:00Z" } } } });
  await f.click();
  f.notices.push(new f.Element("提出を記録しました"));
  await f.scan();
  assert.equal(f.storage[KEY][URL].completedAt, "2026-01-01T00:00:00Z");
  const deadline = new Date(Date.now() + 86400000 * 3).toISOString();
  assert.equal(f.api.getDeadlineState(deadline, true, true, true).label, "課題完了");
  assert.equal(f.api.getDeadlineState(deadline, true, false, true).label, "提出確認済み");
  assert.equal(f.api.getDeadlineState(deadline, true, false, false).label, "提出操作あり");
});

test("the actual bilingual native alert confirms a click and preserves the dialog", async () => {
  const f = fixture();
  f.button.click();
  const message = "すべての回答を保存しました。\nAll your answers have been saved.";
  assert.equal(f.alert(message), "native-result");
  await f.api.flush();
  assert.ok(f.latest().confirmedAt);
  assert.deepEqual(f.dialogs, [[message]]);
});

test("native error alerts and save alerts without a pending click never confirm", async () => {
  const f = fixture();
  f.alert("すべての回答を保存しました。");
  await f.api.flush();
  assert.equal(f.latest(), undefined);
  await f.click();
  f.alert("すべての回答を保存しました。しかしエラーが発生しました。");
  f.alert("保存できませんでした。");
  await f.api.flush();
  assert.equal(f.latest().confirmedAt, undefined);
  assert.equal(f.dialogs.length, 3);
  f.alert("All your answers have been saved.");
  await f.api.flush();
  assert.ok(f.latest().confirmedAt);
});

test("the manifest loads the alert bridge in MAIN before page scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "../manifest.json"), "utf8"));
  const bridge = manifest.content_scripts.find((entry) => entry.js.includes("submission-alert.js"));
  assert.equal(bridge.world, "MAIN");
  assert.equal(bridge.run_at, "document_start");
  assert.deepEqual(bridge.matches, ["https://moocs.iniad.org/*"]);
});
