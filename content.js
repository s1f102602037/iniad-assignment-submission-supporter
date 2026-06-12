(() => {
  "use strict";

  const STORAGE_KEY = "iniadMoocsSubmissionHistory";
  const EXTERNAL_STORAGE_KEY = "iniadExternalAssignments";
  const PANEL_ID = "iniad-submission-checker";
  const DASHBOARD_ID = "iniad-deadline-dashboard";
  const EXTERNAL_DASHBOARD_ID = "iniad-external-dashboard";
  const DASHBOARD_LAYOUT_ID = "iniad-dashboard-layout";
  const BUTTON_MARKER = "data-iniad-submission-listener";
  const SUBMIT_TEXT_PATTERN = /^(提出|提出する|回答を提出|課題を提出|送信)$/;
  const EXTENSION_VERSION = "0.5.9";
  const ANSWER_CONTROL_SELECTOR = [
    "input:not([type='button']):not([type='submit']):not([type='reset']):not([type='hidden'])",
    "textarea",
    "select",
    "[contenteditable='true']"
  ].join(",");

  let refreshTimer;
  let extensionContextActive = true;

  function isContextInvalidatedError(error) {
    return String(error?.message || error).includes("Extension context invalidated");
  }

  function runSafely(task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        if (isContextInvalidatedError(error)) {
          extensionContextActive = false;
          return;
        }
        console.error("INIAD課題提出サポーター:", error);
      });
  }

  async function getLocalStorage(keys) {
    if (!extensionContextActive) {
      return {};
    }

    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        extensionContextActive = false;
        return {};
      }
      throw error;
    }
  }

  async function setLocalStorage(values) {
    if (!extensionContextActive) {
      return false;
    }

    try {
      await chrome.storage.local.set(values);
      return true;
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        extensionContextActive = false;
        return false;
      }
      throw error;
    }
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function getButtonText(element) {
    if (element.tagName === "INPUT") {
      return element.value || "";
    }

    return element.textContent || element.getAttribute("aria-label") || "";
  }

  function getAnswerControls() {
    const submissionForms = findSubmissionButtons()
      .map((button) => button.closest("form"))
      .filter(Boolean);
    const roots = submissionForms.length > 0
      ? [...new Set(submissionForms)]
      : [document.querySelector("main, article") || document];

    return roots.flatMap((root) => [...root.querySelectorAll(ANSWER_CONTROL_SELECTOR)])
      .filter((element, index, controls) => {
        return !element.closest(`#${PANEL_ID}`) && controls.indexOf(element) === index;
      });
  }

  function getControlValue(element) {
    const type = (element.getAttribute("type") || "").toLowerCase();

    if (type === "checkbox" || type === "radio") {
      return element.checked ? `checked:${element.value}` : "unchecked";
    }

    if (type === "file") {
      return [...element.files].map((file) => `${file.name}:${file.size}`).join("|");
    }

    if (element.tagName === "SELECT") {
      return [...element.selectedOptions].map((option) => option.value).join("|");
    }

    if (element.isContentEditable) {
      return element.textContent || "";
    }

    return element.value || "";
  }

  function hashText(text) {
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function getAnswerFingerprint() {
    const answers = getAnswerControls().map((element, index) => {
      return {
        index,
        tag: element.tagName,
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        id: element.id || "",
        value: getControlValue(element)
      };
    });

    return {
      controlCount: answers.length,
      hash: hashText(JSON.stringify(answers))
    };
  }

  function answersHaveChanged(record) {
    if (!record?.answerFingerprint) {
      return false;
    }

    const current = getAnswerFingerprint();
    if (current.controlCount === 0) {
      return false;
    }

    return current.controlCount !== record.answerFingerprint.controlCount
      || current.hash !== record.answerFingerprint.hash;
  }

  function getPageKey() {
    const url = new URL(window.location.href);
    url.hash = "";
    return `${url.origin}${url.pathname}${url.search}`;
  }

  function getPageTitle() {
    const heading = document.querySelector("h1, h2, [role='heading']");
    return normalizeText(heading?.textContent || document.title || "名称不明の課題");
  }

  function getCourseTitle() {
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "courses" || pathParts.length < 3) {
      return "";
    }

    const coursePath = `/${pathParts.slice(0, 3).join("/")}`;
    const courseCode = pathParts[2];
    const pageTitle = getPageTitle();
    const links = [...document.querySelectorAll("a[href]")];
    const exactCourseLink = links.find((link) => {
      const linkUrl = new URL(link.href, window.location.origin);
      const linkPath = linkUrl.pathname.replace(/\/$/, "");
      const text = normalizeText(link.textContent || "");
      return linkPath === coursePath
        && text
        && text !== courseCode
        && text !== pageTitle;
    });

    if (exactCourseLink) {
      return normalizeText(exactCourseLink.textContent);
    }

    const breadcrumbLinks = [...document.querySelectorAll(
      ".breadcrumb a, [class*='breadcrumb'] a, nav[aria-label*='breadcrumb' i] a"
    )];
    const ignoredTexts = new Set([
      "",
      "ホーム",
      "Home",
      "Courses",
      "コース",
      courseCode,
      pathParts[1],
      pageTitle
    ]);
    const courseCandidate = breadcrumbLinks
      .map((link) => normalizeText(link.textContent || ""))
      .find((text) => !ignoredTexts.has(text));

    return courseCandidate || "";
  }

  function getTaskDisplayTitle(task) {
    const taskTitle = task.title || "名称不明の課題";
    return task.courseTitle
      ? `${task.courseTitle}　${taskTitle}`
      : taskTitle;
  }

  function isHomePage() {
    return /^\/(?:|home|dashboard|courses(?:\/\d{4})?)\/?$/.test(window.location.pathname);
  }

  function toDateTimeLocalValue(isoDate) {
    if (!isoDate) {
      return "";
    }

    const date = new Date(isoDate);
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function getDefaultDeadline() {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 6);
    deadline.setHours(23, 59, 0, 0);
    return deadline;
  }

  function getDeadlineState(deadline, hasSubmissionRecord, isCompleted) {
    const remaining = new Date(deadline).getTime() - Date.now();

    if (remaining < 0) {
      let submissionLabel = "未提出";

      if (isCompleted) {
        submissionLabel = "提出完了";
      } else if (hasSubmissionRecord) {
        submissionLabel = "提出操作あり";
      }

      return {
        className: "iniad-deadline--expired",
        label: `${submissionLabel}・提出期限終了`
      };
    }

    if (isCompleted) {
      return {
        className: "iniad-deadline--completed",
        label: "課題完了"
      };
    }

    if (remaining <= 24 * 60 * 60 * 1000) {
      return {
        className: "iniad-deadline--urgent",
        label: hasSubmissionRecord ? "24時間以内・提出操作あり" : "24時間以内・未提出"
      };
    }

    return {
      className: "iniad-deadline--pending",
      label: hasSubmissionRecord ? "提出操作あり" : "未提出"
    };
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function isSubmissionButton(element) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      return false;
    }

    const text = normalizeText(getButtonText(element));

    return SUBMIT_TEXT_PATTERN.test(text);
  }

  function findSubmissionButtons() {
    return [...document.querySelectorAll(
      "button, input[type='submit'], input[type='button'], [role='button']"
    )].filter(isSubmissionButton);
  }

  async function getHistory() {
    const stored = await getLocalStorage(STORAGE_KEY);
    return stored[STORAGE_KEY] || {};
  }

  async function getExternalAssignments() {
    const stored = await getLocalStorage(EXTERNAL_STORAGE_KEY);
    return stored[EXTERNAL_STORAGE_KEY] || [];
  }

  async function saveExternalAssignments(assignments) {
    await setLocalStorage({ [EXTERNAL_STORAGE_KEY]: assignments });
  }

  async function recordSubmission(button) {
    const pageKey = getPageKey();
    const history = await getHistory();
    const records = history[pageKey]?.records || [];
    const buttonText = normalizeText(getButtonText(button) || "提出");

    records.push({
      clickedAt: new Date().toISOString(),
      buttonText,
      answerFingerprint: getAnswerFingerprint()
    });

    history[pageKey] = {
      ...history[pageKey],
      title: getPageTitle(),
      courseTitle: getCourseTitle() || history[pageKey]?.courseTitle || "",
      url: pageKey,
      records: records.slice(-20)
    };

    await setLocalStorage({ [STORAGE_KEY]: history });
    await renderPanel();
  }

  function attachButtonListeners() {
    for (const button of findSubmissionButtons()) {
      if (button.hasAttribute(BUTTON_MARKER)) {
        continue;
      }

      button.setAttribute(BUTTON_MARKER, "true");
      button.addEventListener("click", () => {
        runSafely(() => recordSubmission(button));
      }, { capture: true });
    }
  }

  function formatDate(isoDate) {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(isoDate));
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button class="iniad-checker__toggle" type="button" aria-expanded="true">
        提出チェック
      </button>
      <div class="iniad-checker__body">
        <p class="iniad-checker__status" aria-live="polite"></p>
        <form class="iniad-checker__deadline-form">
          <label for="iniad-checker-deadline">課題締め切り日時</label>
          <div class="iniad-checker__deadline-controls">
            <input id="iniad-checker-deadline" type="datetime-local" required>
            <button type="submit">保存</button>
          </div>
          <button class="iniad-checker__deadline-delete" type="button">期限を削除</button>
          <p class="iniad-checker__deadline-display"></p>
        </form>
        <button class="iniad-checker__complete" type="button"></button>
        <ol class="iniad-checker__history"></ol>
        <button class="iniad-checker__clear" type="button">このページの履歴を削除</button>
        <p class="iniad-checker__note">
          この記録は提出完了を保証するものではありません。MOOCs上の結果も確認してください。
          <span class="iniad-checker__version">v${EXTENSION_VERSION}</span>
        </p>
      </div>
    `;

    panel.querySelector(".iniad-checker__toggle").addEventListener("click", (event) => {
      const button = event.currentTarget;
      const isExpanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!isExpanded));
      panel.classList.toggle("iniad-checker--collapsed", isExpanded);
    });

    panel.querySelector(".iniad-checker__clear").addEventListener("click", async () => {
      const history = await getHistory();
      const page = history[getPageKey()];
      if (page) {
        history[getPageKey()] = {
          ...page,
          records: []
        };
      }
      await setLocalStorage({ [STORAGE_KEY]: history });
      await renderPanel();
    });

    panel.querySelector(".iniad-checker__deadline-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = panel.querySelector("#iniad-checker-deadline");
      const deadline = new Date(input.value);

      if (Number.isNaN(deadline.getTime())) {
        return;
      }

      const history = await getHistory();
      const pageKey = getPageKey();
      history[pageKey] = {
        ...history[pageKey],
        title: getPageTitle(),
        courseTitle: getCourseTitle() || history[pageKey]?.courseTitle || "",
        url: pageKey,
        records: history[pageKey]?.records || [],
        deadline: deadline.toISOString()
      };
      await setLocalStorage({ [STORAGE_KEY]: history });
      await renderPanel();
    });

    panel.querySelector(".iniad-checker__deadline-delete").addEventListener("click", async () => {
      const history = await getHistory();
      const pageKey = getPageKey();
      const page = history[pageKey];

      if (page) {
        delete page.deadline;
        if ((page.records || []).length === 0 && !page.completedAt) {
          delete history[pageKey];
        }
        await setLocalStorage({ [STORAGE_KEY]: history });
      }

      await renderPanel();
    });

    panel.querySelector(".iniad-checker__complete").addEventListener("click", async () => {
      const history = await getHistory();
      const pageKey = getPageKey();
      const page = history[pageKey] || {};

      history[pageKey] = {
        ...page,
        title: getPageTitle(),
        courseTitle: getCourseTitle() || page.courseTitle || "",
        url: pageKey,
        records: page.records || [],
        completedAt: page.completedAt ? null : new Date().toISOString()
      };

      await setLocalStorage({ [STORAGE_KEY]: history });
      await renderPanel();
    });

    document.body.append(panel);
    return panel;
  }

  async function renderPanel() {
    const buttons = findSubmissionButtons();
    let panel = document.getElementById(PANEL_ID);

    if (buttons.length === 0) {
      panel?.remove();
      return;
    }

    panel ||= createPanel();

    const history = await getHistory();
    const pageKey = getPageKey();
    const page = history[pageKey] || {};
    const detectedCourseTitle = getCourseTitle();
    if (detectedCourseTitle && page.courseTitle !== detectedCourseTitle) {
      page.courseTitle = detectedCourseTitle;
      history[pageKey] = page;
      await setLocalStorage({ [STORAGE_KEY]: history });
    }
    const records = page.records || [];
    const latestRecord = records.at(-1);
    const canDetectChanges = Boolean(latestRecord?.answerFingerprint);
    const hasChangedAnswers = answersHaveChanged(latestRecord);
    const status = panel.querySelector(".iniad-checker__status");
    const historyList = panel.querySelector(".iniad-checker__history");
    const clearButton = panel.querySelector(".iniad-checker__clear");
    const completeButton = panel.querySelector(".iniad-checker__complete");
    const deadlineInput = panel.querySelector("#iniad-checker-deadline");
    const deadlineDeleteButton = panel.querySelector(".iniad-checker__deadline-delete");
    const deadlineDisplay = panel.querySelector(".iniad-checker__deadline-display");
    const deadlineState = page.deadline
      ? getDeadlineState(page.deadline, records.length > 0, Boolean(page.completedAt))
      : null;

    if (document.activeElement !== deadlineInput) {
      deadlineInput.value = toDateTimeLocalValue(page.deadline || getDefaultDeadline());
    }
    deadlineDeleteButton.hidden = !page.deadline;
    deadlineDisplay.textContent = page.deadline
      ? `設定済み: ${formatDate(page.deadline)}（${deadlineState.label}）`
      : "初期値は6日後の23:59です。保存した課題だけがホーム画面に表示されます。";
    completeButton.textContent = page.completedAt
      ? "課題完了を取り消す"
      : "課題完了";
    completeButton.classList.toggle(
      "iniad-checker__complete--active",
      Boolean(page.completedAt)
    );

    panel.classList.toggle(
      "iniad-checker--warning",
      !page.completedAt && (records.length === 0 || hasChangedAnswers)
    );

    if (page.completedAt) {
      status.textContent = `課題完了: ${formatDate(page.completedAt)}`;
    } else if (records.length === 0) {
      status.textContent = "注意: このページでは、まだ提出ボタンを押した記録がありません。";
    } else if (hasChangedAnswers) {
      status.textContent = "注意: 提出後に回答が変更されています。変更後は未提出です。";
    } else if (!canDetectChanges) {
      status.textContent = `提出記録: ${records.length}回（次回提出から回答変更を監視）`;
    } else {
      status.textContent = `提出記録: ${records.length}回・提出後の変更なし`;
    }

    historyList.replaceChildren();
    for (const record of [...records].reverse()) {
      const item = document.createElement("li");
      item.textContent = formatDate(record.clickedAt);
      historyList.append(item);
    }

    historyList.hidden = records.length === 0;
    clearButton.hidden = records.length === 0;
  }

  function createDashboard() {
    let layout = document.getElementById(DASHBOARD_LAYOUT_ID);
    if (!layout) {
      layout = document.createElement("div");
      layout.id = DASHBOARD_LAYOUT_ID;
      const host = document.querySelector("main") || document.body;
      host.prepend(layout);
    }

    const dashboard = document.createElement("aside");
    dashboard.id = DASHBOARD_ID;
    dashboard.className = "iniad-task-dashboard";
    dashboard.innerHTML = `
      <div class="iniad-dashboard__header">
        <h2>登録済み課題の締め切り</h2>
        <span>v${EXTENSION_VERSION}</span>
      </div>
      <div class="iniad-dashboard__body">
        <p class="iniad-dashboard__empty"></p>
        <ol class="iniad-dashboard__list"></ol>
      </div>
    `;
    layout.append(dashboard);
    return dashboard;
  }

  function createExternalDashboard() {
    let layout = document.getElementById(DASHBOARD_LAYOUT_ID);
    if (!layout) {
      createDashboard();
      layout = document.getElementById(DASHBOARD_LAYOUT_ID);
    }

    const dashboard = document.createElement("aside");
    dashboard.id = EXTERNAL_DASHBOARD_ID;
    dashboard.className = "iniad-task-dashboard";
    dashboard.innerHTML = `
      <div class="iniad-dashboard__header">
        <h2>外部課題</h2>
        <button class="iniad-external__add-toggle" type="button" aria-expanded="false">
          外部課題追加
        </button>
      </div>
      <div class="iniad-dashboard__body">
        <form class="iniad-external__form" hidden>
          <label>
            課題内容
            <input name="title" type="text" required maxlength="200">
          </label>
          <label>
            締め切り日時
            <input name="deadline" type="datetime-local" required>
          </label>
          <label>
            課題のリンク先（任意）
            <input name="url" type="url" placeholder="https://example.com/">
          </label>
          <p class="iniad-external__form-error" aria-live="polite"></p>
          <div class="iniad-external__form-actions">
            <button class="iniad-external__save" type="submit">追加</button>
            <button class="iniad-external__cancel" type="button">キャンセル</button>
          </div>
        </form>
        <p class="iniad-dashboard__empty"></p>
        <ol class="iniad-dashboard__list"></ol>
      </div>
    `;

    const toggleButton = dashboard.querySelector(".iniad-external__add-toggle");
    const form = dashboard.querySelector(".iniad-external__form");
    const deadlineInput = form.elements.deadline;
    const saveButton = form.querySelector(".iniad-external__save");

    function setFormOpen(isOpen, assignment = null) {
      form.hidden = !isOpen;
      toggleButton.setAttribute("aria-expanded", String(isOpen));
      toggleButton.textContent = isOpen ? "入力を閉じる" : "外部課題追加";

      if (isOpen) {
        form.dataset.editingId = assignment?.id || "";
        form.elements.title.value = assignment?.title || "";
        deadlineInput.value = toDateTimeLocalValue(
          assignment?.deadline || getDefaultDeadline()
        );
        form.elements.url.value = assignment?.url || "";
        saveButton.textContent = assignment ? "更新" : "追加";
        form.elements.title.focus();
      } else {
        delete form.dataset.editingId;
        form.reset();
        saveButton.textContent = "追加";
        form.querySelector(".iniad-external__form-error").textContent = "";
      }
    }

    toggleButton.addEventListener("click", () => {
      setFormOpen(form.hidden);
    });

    form.querySelector(".iniad-external__cancel").addEventListener("click", () => {
      setFormOpen(false);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const title = normalizeText(String(formData.get("title") || ""));
      const deadline = new Date(String(formData.get("deadline") || ""));
      const error = form.querySelector(".iniad-external__form-error");
      const urlInput = normalizeText(String(formData.get("url") || ""));
      let url = "";

      if (urlInput) {
        try {
          const parsedUrl = new URL(urlInput);
          if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            throw new Error("Unsupported protocol");
          }
          url = parsedUrl.href;
        } catch {
          error.textContent = "リンク先には http または https のURLを入力してください。";
          return;
        }
      }

      if (!title || Number.isNaN(deadline.getTime())) {
        error.textContent = "課題内容と締め切り日時を確認してください。";
        return;
      }

      if (!url && !window.confirm("リンク先が入力されていません。このまま保存しますか？")) {
        return;
      }

      const assignments = await getExternalAssignments();
      const editingId = form.dataset.editingId;
      const existingAssignment = assignments.find((item) => item.id === editingId);

      if (existingAssignment) {
        existingAssignment.title = title;
        existingAssignment.deadline = deadline.toISOString();
        existingAssignment.url = url;
      } else {
        assignments.push({
          id: crypto.randomUUID(),
          title,
          deadline: deadline.toISOString(),
          url,
          submitted: false,
          createdAt: new Date().toISOString()
        });
      }
      await saveExternalAssignments(assignments);
      setFormOpen(false);
      await renderExternalDashboard();
    });

    layout.append(dashboard);
    return dashboard;
  }

  function getExternalDeadlineState(assignment) {
    const remaining = new Date(assignment.deadline).getTime() - Date.now();

    if (remaining < 0) {
      return {
        className: "iniad-deadline--expired",
        label: `${assignment.submitted ? "提出" : "未提出"}・提出期限終了`
      };
    }

    if (assignment.submitted) {
      return {
        className: "iniad-deadline--completed",
        label: "提出"
      };
    }

    if (remaining <= 24 * 60 * 60 * 1000) {
      return {
        className: "iniad-deadline--urgent",
        label: "24時間以内・未提出"
      };
    }

    return {
      className: "iniad-deadline--pending",
      label: "未提出"
    };
  }

  async function renderDashboard() {
    let dashboard = document.getElementById(DASHBOARD_ID);

    if (!isHomePage()) {
      dashboard?.remove();
      return;
    }

    dashboard ||= createDashboard();
    const history = await getHistory();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const tasks = Object.values(history)
      .filter((page) => {
        return page.deadline
          && page.url
          && new Date(page.deadline).getTime() > oneDayAgo;
      })
      .sort((left, right) => new Date(left.deadline) - new Date(right.deadline));
    const empty = dashboard.querySelector(".iniad-dashboard__empty");
    const list = dashboard.querySelector(".iniad-dashboard__list");

    empty.hidden = tasks.length > 0;
    empty.textContent = "締め切り日時を登録した課題はありません。";
    list.hidden = tasks.length === 0;
    list.replaceChildren();

    for (const task of tasks) {
      const records = task.records || [];
      const state = getDeadlineState(
        task.deadline,
        records.length > 0,
        Boolean(task.completedAt)
      );
      const item = document.createElement("li");
      item.className = state.className;

      const link = document.createElement("a");
      link.href = task.url;
      link.textContent = getTaskDisplayTitle(task);

      const deadline = document.createElement("time");
      deadline.dateTime = task.deadline;
      deadline.textContent = formatDate(task.deadline);

      const status = document.createElement("span");
      status.textContent = state.label;

      item.append(link, deadline, status);
      list.append(item);
    }
  }

  async function renderExternalDashboard() {
    let dashboard = document.getElementById(EXTERNAL_DASHBOARD_ID);

    if (!isHomePage()) {
      dashboard?.remove();
      if (!document.getElementById(DASHBOARD_ID)) {
        document.getElementById(DASHBOARD_LAYOUT_ID)?.remove();
      }
      return;
    }

    dashboard ||= createExternalDashboard();
    const assignments = await getExternalAssignments();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const visibleAssignments = assignments
      .filter((assignment) => {
        return assignment.deadline
          && new Date(assignment.deadline).getTime() > oneDayAgo;
      })
      .sort((left, right) => new Date(left.deadline) - new Date(right.deadline));
    const empty = dashboard.querySelector(".iniad-dashboard__empty");
    const list = dashboard.querySelector(".iniad-dashboard__list");

    empty.hidden = visibleAssignments.length > 0;
    empty.textContent = "登録した外部課題はありません。";
    list.hidden = visibleAssignments.length === 0;
    list.replaceChildren();

    for (const assignment of visibleAssignments) {
      const state = getExternalDeadlineState(assignment);
      const item = document.createElement("li");
      item.className = state.className;

      const title = document.createElement(assignment.url ? "a" : "strong");
      title.className = "iniad-external__title";
      title.textContent = assignment.title;
      if (assignment.url) {
        title.href = assignment.url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }

      const deadline = document.createElement("time");
      deadline.dateTime = assignment.deadline;
      deadline.textContent = formatDate(assignment.deadline);

      const status = document.createElement("span");
      status.textContent = state.label;

      const actions = document.createElement("div");
      actions.className = "iniad-external__item-actions";

      const submitButton = document.createElement("button");
      submitButton.type = "button";
      submitButton.textContent = assignment.submitted ? "未提出に戻す" : "提出済みにする";
      submitButton.addEventListener("click", async () => {
        const currentAssignments = await getExternalAssignments();
        const target = currentAssignments.find((item) => item.id === assignment.id);
        if (target) {
          target.submitted = !target.submitted;
          await saveExternalAssignments(currentAssignments);
        }
      });

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "iniad-external__edit";
      editButton.textContent = "再編集";
      editButton.addEventListener("click", () => {
        const form = dashboard.querySelector(".iniad-external__form");
        if (form.hidden) {
          dashboard.querySelector(".iniad-external__add-toggle").click();
        }
        form.dataset.editingId = assignment.id;
        form.elements.title.value = assignment.title;
        form.elements.deadline.value = toDateTimeLocalValue(assignment.deadline);
        form.elements.url.value = assignment.url || "";
        form.querySelector(".iniad-external__save").textContent = "更新";
        form.elements.title.focus();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "iniad-external__delete";
      deleteButton.textContent = "削除";
      deleteButton.addEventListener("click", async () => {
        const currentAssignments = await getExternalAssignments();
        await saveExternalAssignments(
          currentAssignments.filter((item) => item.id !== assignment.id)
        );
      });

      actions.append(submitButton, editButton, deleteButton);
      item.append(title, deadline, status, actions);
      list.append(item);
    }
  }

  function scheduleRefresh() {
    if (!extensionContextActive) {
      return;
    }

    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      if (!extensionContextActive) {
        return;
      }
      attachButtonListeners();
      runSafely(renderPanel);
      runSafely(renderDashboard);
      runSafely(renderExternalDashboard);
    }, 150);
  }

  function initialize() {
    window.addEventListener("unhandledrejection", (event) => {
      if (isContextInvalidatedError(event.reason)) {
        extensionContextActive = false;
        event.preventDefault();
      }
    });

    attachButtonListeners();
    runSafely(renderPanel);
    runSafely(renderDashboard);
    runSafely(renderExternalDashboard);

    document.addEventListener("input", (event) => {
      if (!event.target.closest?.(
        `#${PANEL_ID}, #${DASHBOARD_ID}, #${EXTERNAL_DASHBOARD_ID}`
      )) {
        scheduleRefresh();
      }
    }, true);
    document.addEventListener("change", (event) => {
      if (!event.target.closest?.(
        `#${PANEL_ID}, #${DASHBOARD_ID}, #${EXTERNAL_DASHBOARD_ID}`
      )) {
        scheduleRefresh();
      }
    }, true);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        runSafely(renderPanel);
        runSafely(renderDashboard);
      }
      if (areaName === "local" && changes[EXTERNAL_STORAGE_KEY]) {
        runSafely(renderExternalDashboard);
      }
    });

    window.setInterval(() => {
      if (!extensionContextActive) {
        return;
      }
      runSafely(renderDashboard);
      runSafely(renderExternalDashboard);
    }, 60_000);

    const observer = new MutationObserver((mutations) => {
      const hasPageMutation = mutations.some(({ target }) => {
        const changedElement = target instanceof Element ? target : target.parentElement;
        return !changedElement?.closest(
          `#${PANEL_ID}, #${DASHBOARD_ID}, #${EXTERNAL_DASHBOARD_ID}`
        );
      });

      if (hasPageMutation) {
        scheduleRefresh();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  initialize();
})();
