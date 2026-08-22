// ==UserScript==
// @name         Fixed Site Name Replacer2
// @namespace    local.codex.fixed-site-replacer
// @version      0.6.1
// @description  本地替换 Microsoft 登录页、Outlook 和 Bandai Parks 页面上的显示文字。（iOS Safari Userscripts / 油猴双兼容；触发：长按 2 秒或三击顶部区域）
// @match        https://login.microsoftonline.com/*
// @match        https://outlook.live.com/*
// @match        https://parks2.bandainamco-am.co.jp/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "codex.fixedSite.nameReplacer.config.v1";
  const SUPPORTED_HOSTS = [
    "login.microsoftonline.com",
    "outlook.live.com",
    "parks2.bandainamco-am.co.jp",
  ];
  const PANEL_ID = "codex-msmail-name-panel";
  const STYLE_ID = "codex-msmail-name-style";
  const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
  const PANEL_HOLD_MS = 2000;
  const PANEL_HOLD_ZONE_PX = 100;
  const TRIPLE_CLICK_WINDOW_MS = 500;
  const TRIPLE_CLICK_MAX_SPREAD = 40;
  const FAST_SCAN_WINDOW_MS = 4000;
  const FAST_SCAN_INTERVAL_MS = 120;
  const DEFAULT_RULES = [
    { enabled: true, original: "", replacement: "", mode: "normal" },
    { enabled: true, original: "", replacement: "", mode: "normal" },
  ];

  let originalTextMap = new WeakMap();
  let originalValueMap = new WeakMap();
  const touchedTextNodes = new Set();
  const touchedElements = new Set();
  let observer = null;
  let applying = false;
  let statusUpdater = null;
  let holdTimer = null;
  let topHoldStartY = 0;
  let threeFingerHold = false;
  let tripleClickTimes = [];
  let fastScanInterval = null;
  let fastScanStopTimer = null;

  const defaultConfig = {
    enabled: false,
    fontAdjust: false,
    panelVisible: false,
    bodyCollapsed: false,
    sessionStartedAt: null,
    rules: DEFAULT_RULES,
  };

  const cloneRules = (rules) =>
    (Array.isArray(rules) ? rules : DEFAULT_RULES).map((rule) => ({
      enabled: rule.enabled !== false,
      original: String(rule.original || ""),
      replacement: String(rule.replacement || ""),
      mode: rule.mode === "regex" ? "regex" : "normal",
    }));

  const readStoredConfig = () => {
    if (typeof GM_getValue === "function") {
      return GM_getValue(STORAGE_KEY, "{}");
    }
    return localStorage.getItem(STORAGE_KEY) || "{}";
  };

  const writeStoredConfig = (value) => {
    if (typeof GM_setValue === "function") {
      GM_setValue(STORAGE_KEY, value);
      return;
    }
    localStorage.setItem(STORAGE_KEY, value);
  };

  const loadConfig = () => {
    try {
      const saved = JSON.parse(readStoredConfig());
      return {
        ...defaultConfig,
        ...saved,
        panelVisible: false,
        sessionStartedAt:
          typeof saved.sessionStartedAt === "number" && saved.sessionStartedAt > 0
            ? saved.sessionStartedAt
            : null,
        rules: cloneRules(saved.rules),
      };
    } catch {
      return {
        ...defaultConfig,
        rules: cloneRules(defaultConfig.rules),
      };
    }
  };

  let config = loadConfig();
  config.panelVisible = false;

  const saveConfig = () => {
    writeStoredConfig(
      JSON.stringify({
        ...config,
        rules: cloneRules(config.rules),
      })
    );
  };

  const normalize = (value) => value.replace(/\s+/g, " ").trim();

  const siteAuthorized = () => {
    return SUPPORTED_HOSTS.includes(location.hostname);
  };

  const isOutlookPage = () => location.hostname === "outlook.live.com";

  const shouldSkipNode = (node) => {
    const element =
      node instanceof Element ? node : node?.parentElement instanceof Element ? node.parentElement : null;

    if (!element) return false;
    if (element.closest(`#${PANEL_ID}`)) return true;
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) return true;
    return Boolean(element.closest('iframe, [contenteditable="true"]'));
  };

  const getReplacementRoots = () => {
    if (!document.body) return [];
    return [document.body];
  };

  const hasValidSession = () => typeof config.sessionStartedAt === "number" && config.sessionStartedAt > 0;

  const getSessionExpiresAt = () =>
    hasValidSession() ? config.sessionStartedAt + SESSION_DURATION_MS : 0;

  const getRemainingMs = () =>
    hasValidSession() ? Math.max(0, getSessionExpiresAt() - Date.now()) : 0;

  const formatRemaining = (ms) => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const hasExpired = () => hasValidSession() && getRemainingMs() <= 0;

  const isReplacementActive = () =>
    config.enabled && siteAuthorized() && hasValidSession() && !hasExpired();

  const replaceByRule = (input, rule) => {
    if (!rule.enabled || !rule.original || !rule.replacement) {
      return input;
    }

    if (rule.mode === "regex") {
      try {
        return input.replace(new RegExp(rule.original, "g"), rule.replacement);
      } catch {
        return input;
      }
    }

    return input.split(rule.original).join(rule.replacement);
  };

  const replaceText = (text) => {
    if (!isReplacementActive()) return text;
    return config.rules.reduce((next, rule) => replaceByRule(next, rule), text);
  };

  const rememberOriginalText = (node, value) => {
    touchedTextNodes.add(node);
    if (!originalTextMap.has(node)) {
      originalTextMap.set(node, value);
    }
  };

  const rememberOriginalValue = (element, key, value) => {
    touchedElements.add(element);
    let item = originalValueMap.get(element);
    if (!item) {
      item = {};
      originalValueMap.set(element, item);
    }
    if (!(key in item)) {
      item[key] = value;
    }
  };

  const restoreTouchedContent = () => {
    touchedTextNodes.forEach((node) => {
      if (node.isConnected) {
        restoreNode(node);
      }
    });

    touchedElements.forEach((element) => {
      if (element.isConnected) {
        restoreElement(element);
      }
    });

    touchedTextNodes.clear();
    touchedElements.clear();
    originalTextMap = new WeakMap();
    originalValueMap = new WeakMap();
  };

  const restoreNode = (node) => {
    if (!originalTextMap.has(node)) return;

    const original = originalTextMap.get(node);
    if (node.nodeValue !== original) {
      node.nodeValue = original;
    }
  };

  const restoreElement = (element) => {
    const item = originalValueMap.get(element);
    if (!item) return;

    if ("value" in item && typeof element.value === "string" && element.value !== item.value) {
      element.value = item.value;
    }

    if (
      "placeholder" in item &&
      typeof element.placeholder === "string" &&
      element.placeholder !== item.placeholder
    ) {
      element.placeholder = item.placeholder;
    }
  };

  const updateTextNode = (node) => {
    const current = node.nodeValue;
    if (!current || !normalize(current)) return;

    if (!isReplacementActive()) return;

    rememberOriginalText(node, current);
    const base = originalTextMap.get(node) || current;
    const next = replaceText(base);
    if (next !== current) {
      node.nodeValue = next;
    }
  };

  const updateElementValue = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return;
    }

    if (shouldSkipNode(element)) return;

    if (!isReplacementActive()) return;

    if (typeof element.placeholder === "string") {
      rememberOriginalValue(element, "placeholder", element.placeholder);
      const nextPlaceholder = replaceText(
        originalValueMap.get(element)?.placeholder || element.placeholder
      );
      if (nextPlaceholder !== element.placeholder) {
        element.placeholder = nextPlaceholder;
      }
    }
  };

  const walkAndReplace = (root) => {
    if (!root) return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let textNode = walker.nextNode();
    while (textNode) {
      updateTextNode(textNode);
      textNode = walker.nextNode();
    }

    if (root instanceof Element) {
      updateElementValue(root);
      root.querySelectorAll("input, textarea").forEach(updateElementValue);
    }
  };

  const applyFontAdjust = () => {
    const active = Boolean(config.fontAdjust && isReplacementActive());
    document.documentElement.classList.toggle("codex-msmail-font-adjust", active);
  };

  const updateStatusText = (message) => {
    const statusNode = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
    if (!statusNode) return;

    if (message) {
      statusNode.textContent = message;
      return;
    }

    if (!config.enabled) {
      statusNode.textContent = "替换功能已关闭，页面正常显示。";
      return;
    }

    if (!hasValidSession()) {
      statusNode.textContent = "尚未开始计时，点击保存并应用后开始 4 小时倒计时。";
      return;
    }

    if (hasExpired()) {
      statusNode.textContent = "已超过 4 小时，替换功能自动失效。";
      return;
    }

    statusNode.textContent = `替换功能开启中，剩余时间: ${formatRemaining(getRemainingMs())}`;
  };

  const syncStatusLoop = () => {
    if (statusUpdater) {
      clearInterval(statusUpdater);
    }

    statusUpdater = window.setInterval(() => {
      if (config.enabled && hasExpired()) {
        disableReplacement("已超过 4 小时，替换功能自动失效。");
        return;
      }
      updateStatusText();
    }, 1000);
  };

  const applyReplacements = (statusMessage = "") => {
    if (applying) return;
    applying = true;

    try {
      applyFontAdjust();
      if (isReplacementActive()) {
        getReplacementRoots().forEach(walkAndReplace);
      }
      updateStatusText(statusMessage);
    } finally {
      applying = false;
    }
  };

  const stopFastScanLoop = () => {
    if (fastScanInterval) {
      clearInterval(fastScanInterval);
      fastScanInterval = null;
    }
    if (fastScanStopTimer) {
      clearTimeout(fastScanStopTimer);
      fastScanStopTimer = null;
    }
  };

  const startFastScanLoop = () => {
    stopFastScanLoop();

    const tick = () => {
      if (document.body) {
        applyReplacements();
      }
    };

    tick();
    fastScanInterval = window.setInterval(tick, FAST_SCAN_INTERVAL_MS);
    fastScanStopTimer = window.setTimeout(() => {
      stopFastScanLoop();
    }, FAST_SCAN_WINDOW_MS);
  };

  const startObserver = () => {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (applying) return;

      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          updateTextNode(mutation.target);
          continue;
        }

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            updateTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            walkAndReplace(node);
          }
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .codex-msmail-font-adjust body,
      .codex-msmail-font-adjust input,
      .codex-msmail-font-adjust button,
      .codex-msmail-font-adjust textarea,
      .codex-msmail-font-adjust select {
        letter-spacing: 0.02em !important;
      }

      #${PANEL_ID} {
        position: fixed;
        top: max(12px, env(safe-area-inset-top));
        left: 12px;
        right: 12px;
        z-index: 2147483647;
        background: rgba(247, 244, 237, 0.98);
        color: #2e2a26;
        border: 1px solid rgba(60, 49, 38, 0.16);
        border-radius: 10px;
        box-shadow: 0 18px 40px rgba(27, 22, 18, 0.18);
        padding: 12px;
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        max-height: calc(100vh - max(24px, env(safe-area-inset-top)) - max(24px, env(safe-area-inset-bottom)));
        overflow: hidden;
      }

      #${PANEL_ID}[hidden] {
        display: none !important;
      }

      #${PANEL_ID}.is-collapsed .codex-body {
        display: none;
      }

      #${PANEL_ID} .codex-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      #${PANEL_ID} .codex-header-main {
        min-width: 0;
      }

      #${PANEL_ID} .codex-title {
        font-size: 18px;
        font-weight: 700;
        border: 0;
        background: transparent;
        color: #2e2a26;
        padding: 0;
        text-align: left;
      }

      #${PANEL_ID} .codex-close {
        border: 0;
        background: transparent;
        color: #4b433b;
        font-size: 14px;
        padding: 2px 4px;
      }

      #${PANEL_ID} .codex-meta {
        margin-top: 4px;
        color: #6d6256;
        display: grid;
        gap: 2px;
        word-break: break-all;
      }

      #${PANEL_ID} .codex-body {
        margin-top: 12px;
        display: grid;
        gap: 10px;
        max-height: calc(100vh - 180px);
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 2px;
        -webkit-overflow-scrolling: touch;
      }

      #${PANEL_ID} button,
      #${PANEL_ID} input,
      #${PANEL_ID} textarea,
      #${PANEL_ID} select {
        font: inherit;
      }

      #${PANEL_ID} .codex-action-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      #${PANEL_ID} .codex-btn {
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        background: #ddd4c7;
        color: #352f29;
      }

      #${PANEL_ID} .codex-btn.primary {
        background: #c6b091;
        color: #201915;
      }

      #${PANEL_ID} .codex-input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #d5c8b8;
        border-radius: 8px;
        padding: 9px 10px;
        background: rgba(255, 255, 255, 0.9);
        color: #2f2924;
      }

      #${PANEL_ID} .codex-check-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        color: #433b34;
      }

      #${PANEL_ID} .codex-check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.68);
      }

      #${PANEL_ID} .codex-table {
        display: grid;
        gap: 8px;
      }

      #${PANEL_ID} .codex-rules-scroll {
        overflow-x: auto;
        overflow-y: visible;
        -webkit-overflow-scrolling: touch;
        padding-bottom: 4px;
      }

      #${PANEL_ID} .codex-rule-guide {
        display: grid;
        gap: 6px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.62);
        color: #5c5248;
      }

      #${PANEL_ID} .codex-guide-strong {
        font-weight: 700;
        color: #2f2924;
      }

      #${PANEL_ID} .codex-table-head,
      #${PANEL_ID} .codex-rule-row {
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr) minmax(0, 1fr) 58px;
        gap: 8px;
        align-items: center;
      }

      #${PANEL_ID}.is-advanced .codex-table-head,
      #${PANEL_ID}.is-advanced .codex-rule-row {
        grid-template-columns: 40px minmax(0, 1fr) minmax(0, 1fr) 112px 58px;
      }

      #${PANEL_ID} .codex-col-mode,
      #${PANEL_ID} .codex-mode-block {
        display: none;
      }

      #${PANEL_ID}.is-advanced .codex-col-mode,
      #${PANEL_ID}.is-advanced .codex-mode-block {
        display: block;
      }

      #${PANEL_ID} .codex-table-head {
        color: #5d5348;
        font-weight: 600;
      }

      #${PANEL_ID} .codex-rule-row {
        background: rgba(255, 255, 255, 0.48);
        border-radius: 14px;
        padding: 12px;
        border: 1px solid rgba(190, 176, 157, 0.5);
      }

      #${PANEL_ID} .codex-field-block {
        display: grid;
        gap: 4px;
        min-width: 0;
      }

      #${PANEL_ID} .codex-field-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      #${PANEL_ID} .codex-field-label.original {
        color: #8a5a26;
      }

      #${PANEL_ID} .codex-field-label.replacement {
        color: #1f6b45;
      }

      #${PANEL_ID} .codex-rule-row .codex-input.original {
        border-color: #d9bf9a;
        background: rgba(255, 248, 240, 0.95);
      }

      #${PANEL_ID} .codex-rule-row .codex-input.replacement {
        border-color: #9fc7ae;
        background: rgba(244, 255, 248, 0.95);
      }

      #${PANEL_ID} .codex-small-btn {
        border: 0;
        border-radius: 8px;
        background: #e4d9cb;
        color: #443b32;
        padding: 11px 8px;
      }

      #${PANEL_ID} .codex-status {
        color: #75685a;
        font-size: 12px;
      }

      #${PANEL_ID} .codex-rule-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #${PANEL_ID} .codex-rule-toggle input {
        width: 22px;
        height: 22px;
      }

      #${PANEL_ID} .codex-mode-block {
        display: grid;
        gap: 4px;
      }

      #${PANEL_ID} .codex-mode-label {
        font-size: 11px;
        font-weight: 700;
        color: #555048;
      }

      @media (max-width: 520px) {
        #${PANEL_ID} .codex-table-head,
        #${PANEL_ID} .codex-rule-row {
          grid-template-columns: 40px minmax(0, 1fr) minmax(0, 1fr) 58px;
        }

        #${PANEL_ID}.is-advanced .codex-table-head,
        #${PANEL_ID}.is-advanced .codex-rule-row {
          grid-template-columns: 40px minmax(0, 1fr) minmax(0, 1fr) 104px 52px;
        }

        #${PANEL_ID} .codex-rule-row {
          gap: 10px;
        }
      }
    `;

    document.head.appendChild(style);
  };

  const escapeHtml = (value) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const buildMetaText = () => [
    `当前网站: ${location.hostname}`,
  ];

  // 从会员页面 HTML 中提取用户信息字段（通用解析器）
  const extractMemberInfo = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const fields = [];
    const push = (label, value) => {
      const v = String(value || "").replace(/\s+/g, " ").trim();
      if (v && v.length <= 80 && !fields.some((f) => f.value === v)) {
        fields.push({ label: String(label || "").replace(/\s+/g, " ").trim(), value: v });
      }
    };

    // 1) dl > dt + dd 结构
    doc.querySelectorAll("dl").forEach((dl) => {
      const dt = dl.querySelector("dt");
      const dd = dl.querySelector("dd");
      if (dt && dd) push(dt.textContent, dd.textContent);
    });

    // 2) table 中 th + td 结构
    doc.querySelectorAll("tr").forEach((tr) => {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      if (th && td) push(th.textContent, td.textContent);
    });

    // 3) 输入框 value（文本类）
    doc.querySelectorAll("input").forEach((inp) => {
      const t = (inp.type || "text").toLowerCase();
      if (["text", "email", "tel", "search"].includes(t) && inp.value) {
        const label = inp.getAttribute("aria-label") || inp.getAttribute("title") || inp.name || "入力値";
        push(label, inp.value);
      }
    });

    // 4) 常见日文会员字段名：找到标签元素，取其相邻值
    const knownLabels = ["会員番号", "会員No", "会員ID", "氏名", "お名前", "フリガナ", "ニックネーム", "メールアドレス", "電話番号", "生年月日", "性別", "住所"];
    const labelCandidates = doc.querySelectorAll("div, span, p, label, th, dt");
    knownLabels.forEach((lb) => {
      const el = Array.from(labelCandidates).find((e) => e.textContent.replace(/\s+/g, "").trim() === lb);
      if (!el) return;
      const sibling = el.nextElementSibling;
      if (sibling) push(lb, sibling.textContent);
    });

    // 5) 页面内嵌脚本变量 member_data（会員番号 / 生年月日 / 性別）
    const memberDataMatch = html.match(/var\s+member_data\s*=\s*(\{[\s\S]*?\})(?:\s*;)?\s*(?:<\/script>|$)/i);
    if (memberDataMatch) {
      try {
        const data = JSON.parse(memberDataMatch[1]);
        if (data.member_id) push("会員番号", data.member_id);
        if (data.birth) push("生年月日", data.birth);
        if (data.sex) push("性別", data.sex);
      } catch (e) {
        // 忽略解析失败
      }
    }

    // 6) ポイント（現在のポイント：Nポイント，值前后可能夹着标签）
    const pointMatch = html.match(/現在のポイント[：:][^0-9]*([\d,]+)[^0-9]*ポイント/);
    if (pointMatch) push("現在のポイント", pointMatch[1]);

    // 7) 页面标题 h1「XXX さんのマイページ」→ 昵称
    const titleMatch = html.match(/<h1[^>]*>([^<]*?)\s*さんのマイページ<\/h1>/);
    if (titleMatch && titleMatch[1]) push("ニックネーム(页面标题)", titleMatch[1]);

    return fields;
  };

  const createRuleRowHtml = (rule, index) => `
    <div class="codex-rule-row" data-index="${index}">
      <div class="codex-rule-toggle">
        <input type="checkbox" ${rule.enabled ? "checked" : ""} data-rule-field="enabled">
      </div>
      <div class="codex-field-block">
        <div class="codex-field-label original">网页当前显示的原文字</div>
        <input class="codex-input original" type="text" value="${escapeHtml(rule.original)}" data-rule-field="original" placeholder="例如: user@example.com / 显示名称">
      </div>
      <div class="codex-field-block">
        <div class="codex-field-label replacement">你想显示的新文字</div>
        <input class="codex-input replacement" type="text" value="${escapeHtml(rule.replacement)}" data-rule-field="replacement" placeholder="例如: alias@example.com / 新名称">
      </div>
      <div class="codex-mode-block">
        <div class="codex-mode-label">模式</div>
        <select class="codex-input" data-rule-field="mode">
          <option value="normal" ${rule.mode === "normal" ? "selected" : ""}>普通</option>
          <option value="regex" ${rule.mode === "regex" ? "selected" : ""}>正则</option>
        </select>
      </div>
      <button type="button" class="codex-small-btn" data-action="remove-rule">删除</button>
    </div>
  `;

  const getPanel = () => document.getElementById(PANEL_ID);

  const syncPanelVisibility = () => {
    const panel = getPanel();
    if (!panel) return;
    panel.hidden = !config.panelVisible;
    panel.classList.toggle("is-collapsed", Boolean(config.bodyCollapsed));
  };

  const showPanel = () => {
    config.panelVisible = true;
    saveConfig();
    syncPanelVisibility();
    updateStatusText("设置面板已打开。");
  };

  const hidePanel = () => {
    config.panelVisible = false;
    saveConfig();
    syncPanelVisibility();
  };

  const togglePanelBody = () => {
    config.bodyCollapsed = !config.bodyCollapsed;
    saveConfig();
    syncPanelVisibility();
  };

  const startSessionNow = () => {
    config.sessionStartedAt = Date.now();
  };

  const disableReplacement = (message = "替换功能已关闭，页面正常显示。") => {
    config.enabled = false;
    config.sessionStartedAt = null;
    saveConfig();
    hidePanel();
  };

  const clearHoldTimer = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    threeFingerHold = false;
  };

  const clearSelection = () => {
    const sel = window.getSelection && window.getSelection();
    if (sel && typeof sel.removeAllRanges === "function") {
      sel.removeAllRanges();
    }
  };

  const recordTripleClick = (clientY) => {
    if (config.panelVisible) return;
    if (clientY > PANEL_HOLD_ZONE_PX) return;

    const now = Date.now();
    tripleClickTimes = tripleClickTimes.filter(
      (t) => now - t.time <= TRIPLE_CLICK_WINDOW_MS
    );
    tripleClickTimes.push({ time: now, y: clientY });

    if (tripleClickTimes.length < 3) return;

    const ys = tripleClickTimes.map((t) => t.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    tripleClickTimes = [];

    if (spread <= TRIPLE_CLICK_MAX_SPREAD) {
      showPanel();
      setTimeout(clearSelection, 0);
    }
  };

  const startTopHoldDetector = () => {
    const beginHold = (clientY, isThreeFinger = false) => {
      if (config.panelVisible) return;
      if (!isThreeFinger && clientY > PANEL_HOLD_ZONE_PX) return;

      clearHoldTimer();
      topHoldStartY = clientY;
      threeFingerHold = isThreeFinger;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        threeFingerHold = false;
        showPanel();
      }, PANEL_HOLD_MS);
    };

    const moveHold = (clientY, touchesLength = 1) => {
      if (!holdTimer) return;
      if (threeFingerHold && touchesLength !== 3) {
        clearHoldTimer();
        return;
      }
      if (
        Math.abs(clientY - topHoldStartY) > 14 ||
        (!threeFingerHold && clientY > PANEL_HOLD_ZONE_PX + 20)
      ) {
        clearHoldTimer();
      }
    };

    document.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length === 1) {
          beginHold(event.touches[0].clientY, false);
          return;
        }

        if (event.touches.length === 3) {
          beginHold(event.touches[0].clientY, true);
          return;
        }

        clearHoldTimer();
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length < 1) {
          clearHoldTimer();
          return;
        }
        moveHold(event.touches[0].clientY, event.touches.length);
      },
      { passive: true }
    );

    document.addEventListener("touchend", clearHoldTimer, { passive: true });
    document.addEventListener("touchcancel", clearHoldTimer, { passive: true });

    document.addEventListener("mousedown", (event) => {
      beginHold(event.clientY);
      // 顶部区域内、且已有近期点击（正在形成三击的后续点击）→ 阻止浏览器选中文本
      const isInZone = event.clientY <= PANEL_HOLD_ZONE_PX;
      const lastTap =
        tripleClickTimes.length > 0
          ? tripleClickTimes[tripleClickTimes.length - 1]
          : null;
      const isChainTap =
        lastTap !== null &&
        Date.now() - lastTap.time <= TRIPLE_CLICK_WINDOW_MS;
      if (isInZone && isChainTap && event.defaultPrevented === false) {
        event.preventDefault();
      }
    });

    document.addEventListener("mousemove", (event) => {
      moveHold(event.clientY);
    });

    document.addEventListener("mouseup", (event) => {
      clearHoldTimer();
      recordTripleClick(event.clientY);
    });
    document.addEventListener("mouseleave", clearHoldTimer);
  };

  const buildPanel = () => {
    if (document.getElementById(PANEL_ID)) return;

    ensureStyles();

    const panel = document.createElement("section");
    panel.id = PANEL_ID;

    panel.innerHTML = `
      <div class="codex-header">
        <div class="codex-header-main">
          <button type="button" class="codex-title" data-action="toggle-body">固定网站显示替换</button>
          <div class="codex-meta">${buildMetaText()
            .map((line) => `<div>${escapeHtml(line)}</div>`)
            .join("")}</div>
        </div>
        <button type="button" class="codex-close" data-action="hide-panel">关闭</button>
      </div>
      <div class="codex-body">
        <div class="codex-check-row">
          <label class="codex-check"><input type="checkbox" data-field="enabled"> 启用替换</label>
          <label class="codex-check"><input type="checkbox" data-field="fontAdjust"> 启用字体微调</label>
        </div>
        <div class="codex-action-row">
          <button type="button" class="codex-btn" data-action="fetch-member">获取会员信息</button>
          <button type="button" class="codex-btn" data-action="add-rule">添加规则</button>
          <button type="button" class="codex-btn primary" data-action="save">保存并应用</button>
          <button type="button" class="codex-btn" data-action="disable">关闭功能</button>
          <button type="button" class="codex-btn" data-action="restart-hour">重新计时 4 小时</button>
        </div>
        <div class="codex-status" data-role="status"></div>
        <div class="codex-table">
          <div class="codex-rule-guide">
            <div class="codex-guide-strong">左边填网页当前显示的内容，右边填你想显示的新内容。</div>
            <div>规则会替换页面里匹配到的可见文字；登录框里手动输入的内容不会被修改。</div>
            <div>示例: 原文字 user@example.com -> 新文字 alias@example.com</div>
          </div>
          <button type="button" class="codex-btn codex-advanced-toggle" data-action="toggle-advanced">⚙ 高级替换（正则）</button>
          <div class="codex-rules-scroll">
            <div class="codex-table-head">
              <div>开</div>
              <div>原文字</div>
              <div>新文字</div>
              <div class="codex-col-mode">模式</div>
              <div></div>
            </div>
            <div class="codex-rules"></div>
          </div>
        </div>
      </div>
    `;

    const rulesContainer = panel.querySelector(".codex-rules");
    const advancedToggleBtn = panel.querySelector('[data-action="toggle-advanced"]');

    const syncAdvancedMode = () => {
      const hasRegex = (config.rules || []).some((r) => r.mode === "regex");
      panel.classList.toggle("is-advanced", hasRegex);
      if (advancedToggleBtn) {
        advancedToggleBtn.textContent = hasRegex ? "↩ 返回简单替换" : "⚙ 高级替换（正则）";
      }
    };

    const renderRules = () => {
      if (!rulesContainer) return;
      rulesContainer.innerHTML = config.rules.map((rule, index) => createRuleRowHtml(rule, index)).join("");
      syncAdvancedMode();
    };

    const syncFields = () => {
      panel.querySelectorAll("[data-field]").forEach((input) => {
        const field = input.getAttribute("data-field");
        if (!field) return;

        if (input instanceof HTMLInputElement && input.type === "checkbox") {
          input.checked = Boolean(config[field]);
        } else if (input instanceof HTMLInputElement) {
          input.value = String(config[field] || "");
        }
      });
    };

    const readFields = () => {
      panel.querySelectorAll("[data-field]").forEach((input) => {
        const field = input.getAttribute("data-field");
        if (!field) return;

        if (input instanceof HTMLInputElement && input.type === "checkbox") {
          config[field] = input.checked;
        } else if (input instanceof HTMLInputElement) {
          config[field] = input.value.trim();
        }
      });
    };

    const readRules = () => {
      const nextRules = [];
      panel.querySelectorAll(".codex-rule-row").forEach((row) => {
        const enabled = row.querySelector('[data-rule-field="enabled"]');
        const original = row.querySelector('[data-rule-field="original"]');
        const replacement = row.querySelector('[data-rule-field="replacement"]');
        const mode = row.querySelector('[data-rule-field="mode"]');

        nextRules.push({
          enabled: enabled instanceof HTMLInputElement ? enabled.checked : true,
          original: original instanceof HTMLInputElement ? original.value.trim() : "",
          replacement: replacement instanceof HTMLInputElement ? replacement.value.trim() : "",
          mode: mode instanceof HTMLSelectElement && mode.value === "regex" ? "regex" : "normal",
        });
      });

      config.rules = nextRules.length ? nextRules : cloneRules(DEFAULT_RULES);
    };

    const handleFetchMember = async () => {
      if (location.hostname !== "parks2.bandainamco-am.co.jp") {
        updateStatusText("⚠️ 请先在 Bandai Parks 网站（parks2.bandainamco-am.co.jp）上使用此功能。");
        return;
      }
      updateStatusText("⏳ 正在获取会员信息…");
      try {
        const resp = await fetch("https://parks2.bandainamco-am.co.jp/member_mypage.html", {
          credentials: "include",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const fields = extractMemberInfo(html);
        if (!fields.length) {
          updateStatusText("⚠️ 未获取到用户信息（可能未登录或页面结构变化）。");
          return;
        }
        readRules();
        // 清掉空行，避免和抓取到的信息混在一起
        config.rules = config.rules.filter((r) => r.original.trim() !== "");
        // 每个字段值作为一条规则的「原文字」，新文字留空由用户填写
        fields.forEach((f) => {
          config.rules.push({ enabled: true, original: f.value, replacement: "", mode: "normal" });
        });
        if (!config.rules.length) config.rules = cloneRules(DEFAULT_RULES);
        renderRules();
        updateStatusText(`✅ 已获取 ${fields.length} 项用户信息，请在「新文字」中填写要显示的内容。`);
      } catch (e) {
        updateStatusText("⚠️ 获取失败: " + (e && e.message ? e.message : "未知错误"));
      }
    };

    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const action = target.getAttribute("data-action");
      if (!action) return;

      if (action === "toggle-advanced") {
        const isAdvanced = panel.classList.toggle("is-advanced");
        target.textContent = isAdvanced ? "↩ 返回简单替换" : "⚙ 高级替换（正则）";
        updateStatusText(isAdvanced ? "已开启高级替换，支持正则匹配。" : "已关闭高级替换，仅普通匹配。");
        return;
      }

      if (action === "toggle-body") {
        togglePanelBody();
        return;
      }

      if (action === "hide-panel") {
        hidePanel();
        return;
      }

      if (action === "fetch-member") {
        handleFetchMember();
        return;
      }

      if (action === "add-rule") {
        readRules();
        config.rules.push({ enabled: true, original: "", replacement: "", mode: "normal" });
        renderRules();
        updateStatusText("已添加一条规则。");
        return;
      }

      if (action === "remove-rule") {
        const row = target.closest(".codex-rule-row");
        if (!row) return;
        const index = Number(row.getAttribute("data-index"));
        readRules();
        config.rules.splice(index, 1);
        if (!config.rules.length) {
          config.rules = cloneRules(DEFAULT_RULES);
        }
        renderRules();
        updateStatusText("规则已删除。");
        return;
      }

      if (action === "save") {
        readFields();
        readRules();
        config.enabled = true;
        startSessionNow();
        saveConfig();
        applyReplacements(
          `已应用 ${config.rules.filter((rule) => rule.enabled && rule.original && rule.replacement).length} 条规则，4 小时后自动失效。`
        );
        return;
      }

      if (action === "disable") {
        disableReplacement();
        return;
      }

      if (action === "restart-hour") {
        readFields();
        readRules();
        config.enabled = true;
        startSessionNow();
        saveConfig();
        applyReplacements("已重新开始计时，4 小时后自动失效。");
      }
    });

    syncFields();
    renderRules();
    document.body.appendChild(panel);
    syncPanelVisibility();
    updateStatusText("长按顶部 2 秒，或快速三击顶部区域可再次打开设置面板。");
  };

  const boot = () => {
    if (config.enabled && hasExpired()) {
      config.enabled = false;
      config.sessionStartedAt = null;
      saveConfig();
    }

    config.panelVisible = false;

    startObserver();
    startTopHoldDetector();
    syncStatusLoop();

    const mountUi = () => {
      if (!document.body) {
        requestAnimationFrame(mountUi);
        return;
      }
      buildPanel();
      applyReplacements();
      startFastScanLoop();
    };

    mountUi();

    document.addEventListener("readystatechange", () => {
      applyReplacements();
    });

    window.addEventListener("load", () => {
      applyReplacements();
      startFastScanLoop();
    });
  };

  boot();
})();

